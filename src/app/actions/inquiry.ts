'use server';

import { cookies, headers } from 'next/headers';
import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { getSessionUser } from '@/server/auth';
import { newId } from '@/lib/id';
import { encrypt, maskPhone } from '@/lib/crypto';
import { claimGuestInquiry } from '@/server/services/inquiry';
import { notifySuperAdmins } from '@/server/services/notifications';
import { clientIpFrom } from '@/server/rate-limit';

/**
 * 1:1 채팅 문의 (플로팅 위젯) 서버 액션.
 *
 * - 로그인 사용자는 userId 로, 비로그인 사용자는 httpOnly 쿠키의 게스트 토큰으로 식별한다.
 * - 연락처는 선택 입력이며 암호화 + 마스킹만 저장한다 (원문 노출 경로 없음).
 * - 남용 방지: 사용자/게스트 단위 10분당 10건 발송 제한, 본문 1~1000자.
 * - /support 의 접수 폼(Report)과 별개인 실시간 채팅형 문의다.
 */

// 'use server' 파일은 async 함수만 export 할 수 있으므로 상수는 내부에만 둔다.
// (API 라우트 src/app/api/inquiry/route.ts 와 동일한 값을 사용해야 한다)
const GUEST_COOKIE = 'givesign_inquiry';
const RATE_WINDOW_SEC = 600;
const RATE_MAX = 10;

export interface InquiryActionState {
  ok: boolean;
  message?: string;
}

function maskContact(raw: string): string {
  const v = raw.trim();
  if (v.includes('@')) {
    const [local, domain] = v.split('@');
    const head = local.slice(0, 2);
    return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
  }
  if (/^[0-9\-\s]+$/.test(v)) return maskPhone(v);
  if (v.length <= 2) return `${v[0] ?? ''}*`;
  return v.slice(0, 2) + '*'.repeat(Math.min(6, v.length - 2));
}

export async function sendInquiryMessage(
  _prev: InquiryActionState,
  formData: FormData,
): Promise<InquiryActionState> {
  try {
    const body = String(formData.get('body') ?? '').trim();
    const guestName = String(formData.get('guestName') ?? '').trim().slice(0, 30);
    const contact = String(formData.get('contact') ?? '').trim().slice(0, 80);

    if (!body) return { ok: false, message: '문의 내용을 입력해 주세요.' };
    if (body.length > 1000) return { ok: false, message: '문의 내용은 1,000자 이내로 입력해 주세요.' };

    const user = await getSessionUser().catch(() => null);
    const jar = await cookies();
    const cookieToken = jar.get(GUEST_COOKIE)?.value ?? null;
    const guestToken = user ? null : cookieToken;

    // 발송 제한.
    // 게스트 토큰은 클라이언트가 쿠키를 지우면 얼마든지 새로 발급받을 수 있으므로
    // 제한 키에는 항상 IP 를 포함한다 (로그인 사용자는 계정 단위로도 함께 제한).
    const h = await headers();
    const ip = clientIpFrom((name) => h.get(name)) ?? 'unknown';
    const rateKeys = [`inquiry:rate:ip:${ip}`];
    if (user) rateKeys.push(`inquiry:rate:user:${user.id}`);

    for (const key of rateKeys) {
      const tries = await kv.incr(key, RATE_WINDOW_SEC);
      if (tries > RATE_MAX) {
        return { ok: false, message: '문의를 너무 자주 보내고 있습니다. 잠시 후 다시 시도해 주세요.' };
      }
    }

    const now = new Date();

    // 게스트로 접수했던 스레드가 있으면 로그인 계정으로 승계한다 (답변 유실 방지).
    if (user && cookieToken) {
      await claimGuestInquiry(user.id, cookieToken).catch(() => null);
      jar.delete(GUEST_COOKIE);
    }

    // 기존 문의 스레드 찾기 (주체당 1개 스레드, 종결돼도 이어서 사용)
    let inquiry = user
      ? await prisma.supportInquiry.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } })
      : guestToken
        ? await prisma.supportInquiry.findUnique({ where: { guestToken } })
        : null;

    let issuedGuestToken: string | null = null;

    if (!inquiry) {
      const token = user ? null : newId();
      inquiry = await prisma.supportInquiry.create({
        data: {
          id: newId(),
          userId: user?.id ?? null,
          guestToken: token,
          guestName: user ? null : guestName || null,
          contactEnc: contact ? encrypt(contact) : null,
          contactMasked: contact ? maskContact(contact) : null,
          status: 'OPEN',
          lastMessageAt: now,
        },
      });
      issuedGuestToken = token;
    } else {
      await prisma.supportInquiry.update({
        where: { id: inquiry.id },
        data: {
          // 답변완료/종결 상태여도 새 메시지가 오면 다시 접수 상태로 되돌린다.
          status: 'OPEN',
          lastMessageAt: now,
          ...(contact ? { contactEnc: encrypt(contact), contactMasked: maskContact(contact) } : {}),
          ...(guestName && !inquiry.userId ? { guestName } : {}),
        },
      });
    }

    await prisma.supportMessage.create({
      data: { id: newId(), inquiryId: inquiry.id, sender: 'USER', body },
    });

    // 접수 즉시 통합 관리자에게 알린다. (알림이 없으면 문의가 큐에 쌓인 채 방치된다)
    await notifySuperAdmins({
      title: '새 1:1 문의가 도착했습니다',
      body: body.slice(0, 90),
      linkUrl: `/admin/inquiries/${inquiry.id}`,
    }).catch(() => undefined);

    if (issuedGuestToken) {
      jar.set(GUEST_COOKIE, issuedGuestToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.APP_BASE_URL?.startsWith('https') ?? false,
        maxAge: 60 * 60 * 24 * 365,
        path: '/',
      });
    }

    return { ok: true, message: '문의가 접수되었습니다. 답변이 등록되면 이 창에서 확인할 수 있습니다.' };
  } catch {
    return { ok: false, message: '문의 접수 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
