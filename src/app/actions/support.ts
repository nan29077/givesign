'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { newId } from '@/lib/id';
import { getSessionUser } from '@/server/auth';
import { SUPPORT_CATEGORY_VALUES } from '@/components/public/support-options';
import { INQUIRY_GUEST_COOKIE, claimGuestInquiry } from '@/server/services/inquiry';
import { notifySuperAdmins } from '@/server/services/notifications';
import { cookies } from 'next/headers';
import { clientIpFrom } from '@/server/rate-limit';

/**
 * 고객센터 문의 접수 (/support 폼).
 *
 * 문의 채널은 SupportInquiry 하나로 일원화한다.
 * 예전에는 이 폼이 Report 로만 저장돼 (1) 답변 필드도 조회 화면도 없어 비회원 접수가 무응답으로 끝나고,
 * (2) 우측 하단 위젯 문의와 서로 다른 테이블에 쌓여 같은 사람의 이력을 못 보는 문제가 있었다.
 * 이제 모든 접수는 SupportInquiry 스레드가 되고, 위젯에서 그대로 답변을 확인할 수 있다.
 * '부적절한 이용 신고(ABUSE)'만 추가로 Report 를 만들어 신고 처리 큐에도 올린다.
 */

export interface SupportFormState {
  ok: boolean;
  message?: string;
  /** 접수번호 (SupportInquiry ID) */
  ticketId?: string;
  /** 거래번호 연결 결과 안내 */
  linkNote?: string;
}

// 'use server' 파일은 async 함수만 export 할 수 있으므로 상수는 내부에만 둔다.
const RATE_WINDOW_SEC = 600;
const RATE_MAX = 10;

const schema = z.object({
  intent: z.enum(['SUPPORT', 'ONBOARDING']).default('SUPPORT'),
  category: z.string().refine((v) => SUPPORT_CATEGORY_VALUES.includes(v), '문의 유형을 선택해 주세요.'),
  content: z
    .string()
    .trim()
    .min(10, '문의 내용을 10자 이상 입력해 주세요.')
    .max(2000, '문의 내용은 2,000자를 넘을 수 없습니다.'),
  transactionNo: z.string().trim().max(64, '거래번호를 확인해 주세요.'),
  companyName: z.string().trim().max(80).optional().default(''),
  serviceName: z.string().trim().max(80).optional().default(''),
  contactName: z.string().trim().max(40).optional().default(''),
  contact: z.string().trim().max(100).optional().default(''),
  serviceUrl: z.string().trim().max(200).optional().default(''),
  monthlyVolume: z.string().trim().max(40).optional().default(''),
});

export async function submitSupportRequest(
  _prev: SupportFormState,
  formData: FormData,
): Promise<SupportFormState> {
  const parsed = schema.safeParse({
    intent: String(formData.get('intent') ?? 'SUPPORT'),
    category: String(formData.get('category') ?? ''),
    content: String(formData.get('content') ?? ''),
    transactionNo: String(formData.get('transactionNo') ?? ''),
    companyName: String(formData.get('companyName') ?? ''),
    serviceName: String(formData.get('serviceName') ?? ''),
    contactName: String(formData.get('contactName') ?? ''),
    contact: String(formData.get('contact') ?? ''),
    serviceUrl: String(formData.get('serviceUrl') ?? ''),
    monthlyVolume: String(formData.get('monthlyVolume') ?? ''),
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.' };
  }

  const { category, content, transactionNo, intent, companyName, serviceName, contactName, contact, serviceUrl, monthlyVolume } = parsed.data;

  if (intent === 'ONBOARDING' && (!companyName || !serviceName || !contactName || !contact)) {
    return { ok: false, message: '회사·서비스·담당자·회신 연락처를 모두 입력해 주세요.' };
  }

  const inquiryContent = intent === 'ONBOARDING'
    ? [
        '[GiveSign 도입 상담]',
        `회사·사업자명: ${companyName}`,
        `서비스명: ${serviceName}`,
        `담당자명: ${contactName}`,
        `회신 연락처: ${contact}`,
        `서비스 주소: ${serviceUrl || '미입력'}`,
        `예상 월 결제 규모: ${monthlyVolume || '미정'}`,
        '',
        content,
      ].join('\n')
    : content;

  // 남용 방지: IP 단위 10분당 10건 (로그인 사용자는 계정 단위로도 함께 제한)
  const user = await getSessionUser().catch(() => null);
  const h = await headers();
  const ip = clientIpFrom((name) => h.get(name)) ?? 'unknown';
  const rateKeys = [`support:rate:ip:${ip}`];
  if (user) rateKeys.push(`support:rate:user:${user.id}`);
  for (const key of rateKeys) {
    const tries = await kv.incr(key, RATE_WINDOW_SEC);
    if (tries > RATE_MAX) {
      return { ok: false, message: '문의를 너무 자주 접수하고 있습니다. 잠시 후 다시 시도해 주세요.' };
    }
  }

  let chargeId: string | null = null;
  let merchantId: string | null = null;
  let linkNote: string | undefined;

  if (transactionNo) {
    const charge = await prisma.charge.findUnique({
      where: { transactionNo },
      select: { id: true, merchantId: true },
    });
    if (charge) {
      chargeId = charge.id;
      merchantId = charge.merchantId;
      linkNote = `거래번호 ${transactionNo} 건이 문의에 연결되었습니다.`;
    } else {
      linkNote = `거래번호 ${transactionNo} 에 해당하는 후원 내역을 찾지 못해 문의만 접수했습니다. 담당자가 직접 확인합니다.`;
    }
  }

  // 로그인 사용자는 후원자 프로필의 phoneHash 로 문의자를 식별한다 (원문은 저장하지 않음)
  let reporterHash: string | null = null;
  if (user) {
    const payer = await prisma.payerProfile.findUnique({
      where: { userId: user.id },
      select: { phoneHash: true },
    });
    reporterHash = payer?.phoneHash ?? null;
  }

  const jar = await cookies();
  const cookieToken = jar.get(INQUIRY_GUEST_COOKIE)?.value ?? null;

  try {
    // 게스트로 남긴 스레드가 있으면 먼저 계정으로 승계한다 (같은 사람 문의가 쪼개지지 않게).
    if (user && cookieToken) {
      await claimGuestInquiry(user.id, cookieToken).catch(() => null);
      jar.delete(INQUIRY_GUEST_COOKIE);
    }

    const now = new Date();
    let inquiry = user
      ? await prisma.supportInquiry.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } })
      : cookieToken
        ? await prisma.supportInquiry.findUnique({ where: { guestToken: cookieToken } })
        : null;

    let issuedGuestToken: string | null = null;

    if (inquiry) {
      await prisma.supportInquiry.update({
        where: { id: inquiry.id },
        data: {
          status: 'OPEN',
          category,
          source: 'FORM',
          lastMessageAt: now,
          ...(transactionNo ? { transactionNo } : {}),
          ...(chargeId ? { chargeId } : {}),
          ...(merchantId ? { merchantId } : {}),
        },
      });
    } else {
      const token = user ? null : newId();
      inquiry = await prisma.supportInquiry.create({
        data: {
          id: newId(),
          userId: user?.id ?? null,
          guestToken: token,
          category,
          source: 'FORM',
          status: 'OPEN',
          transactionNo: transactionNo || null,
          chargeId,
          merchantId,
          lastMessageAt: now,
        },
      });
      issuedGuestToken = token;
    }

    await prisma.supportMessage.create({
      data: { id: newId(), inquiryId: inquiry.id, sender: 'USER', body: inquiryContent },
    });

    if (issuedGuestToken) {
      // 비회원도 이 쿠키로 우측 하단 문의 창에서 답변을 확인할 수 있다.
      jar.set(INQUIRY_GUEST_COOKIE, issuedGuestToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.APP_BASE_URL?.startsWith('https') ?? false,
        maxAge: 60 * 60 * 24 * 365,
        path: '/',
      });
    }

    // 접수 즉시 통합 관리자에게 알린다. 위젯 문의만 알림이 가고 고객센터 폼은 조용히 쌓이던 문제를 막는다.
    await notifySuperAdmins({
      title: intent === 'ONBOARDING' ? '새 GiveSign 도입 상담이 접수되었습니다' : '새 고객센터 문의가 접수되었습니다',
      body: `[${category}] ${inquiryContent.slice(0, 80)}`,
      linkUrl: `/admin/inquiries/${inquiry.id}`,
    }).catch(() => undefined);

    // 신고 유형은 신고 처리 큐(Report)에도 올린다. 본문에 식별자를 섞지 않는다.
    if (category === 'ABUSE') {
      await prisma.report.create({
        data: {
          id: newId(),
          category,
          content: inquiryContent,
          status: 'OPEN',
          chargeId,
          merchantId,
          reporterHash,
          reporterUserId: user?.id ?? null,
        },
      });
    }

    return { ok: true, ticketId: inquiry.id, linkNote };
  } catch {
    return { ok: false, message: '문의 접수 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
