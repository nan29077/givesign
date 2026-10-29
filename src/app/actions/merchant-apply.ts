'use server';

import { z } from 'zod';
import { prisma } from '@/server/db';
import { newId, newMerchantCode } from '@/lib/id';
import { createSession, getSessionUser, hashPassword } from '@/server/auth';
import { consumeIpRateLimit } from '@/server/rate-limit';

/**
 * 사회복지기관 가입 신청.
 * - 로그인 상태면 해당 계정에 사회복지기관 프로필을 붙인다.
 * - 비로그인 상태면 이메일/비밀번호로 계정을 만들고 로그인 처리한다.
 * - 프로필은 PENDING 으로 생성되며 MO 번호는 관리자 승인 후 배정된다.
 */

export interface MerchantApplyState {
  ok: boolean;
  message?: string;
  /** 신청 완료 시 발급된 사회복지기관 코드 */
  code?: string;
  displayName?: string;
  /** 이미 신청 이력이 있는 경우 현재 상태 */
  alreadyStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  values?: Record<string, string>;
}

const base = {
  displayName: z.string().trim().min(1, '표시명을 입력해 주세요.').max(30, '표시명은 30자 이내로 입력해 주세요.'),
  channelName: z.string().trim().max(60, '채널명은 60자 이내로 입력해 주세요.').optional(),
  channelUrl: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === '' || /^https?:\/\/[^\s]+$/.test(v), '채널 주소는 http 또는 https 로 시작하는 주소여야 합니다.'),
  contactEmail: z.string().trim().toLowerCase().email('연락 이메일 형식이 올바르지 않습니다.'),
  description: z.string().trim().max(300, '소개는 300자 이내로 입력해 주세요.').optional(),
  isBusiness: z.string().optional(),
  businessNo: z.string().trim().max(20).optional(),
  agree: z.string().optional(),
};

const schema = z
  .object({
    ...base,
    password: z.string().optional(),
    passwordConfirm: z.string().optional(),
  })
  .refine((v) => v.agree === 'on', {
    message: '사회복지기관 이용 조건과 개인정보 수집·이용에 동의해 주세요.',
    path: ['agree'],
  })
  .refine((v) => v.isBusiness !== 'on' || (v.businessNo ?? '').replace(/\D/g, '').length === 10, {
    message: '사업자등록번호 10자리를 입력해 주세요.',
    path: ['businessNo'],
  });

/** 중복되지 않는 사회복지기관 코드를 확보한다. */
async function reserveMerchantCode(): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const candidate = newMerchantCode();
    const [profileDup, codeDup] = await Promise.all([
      prisma.merchantProfile.findUnique({ where: { code: candidate }, select: { id: true } }),
      prisma.merchantCode.findUnique({ where: { code: candidate }, select: { id: true } }),
    ]);
    if (!profileDup && !codeDup) return candidate;
  }
  throw new Error('사회복지기관 코드를 발급하지 못했습니다. 잠시 후 다시 시도해 주세요.');
}

export async function applyMerchant(_prev: MerchantApplyState, formData: FormData): Promise<MerchantApplyState> {
  const raw = {
    displayName: String(formData.get('displayName') ?? ''),
    channelName: String(formData.get('channelName') ?? ''),
    channelUrl: String(formData.get('channelUrl') ?? ''),
    contactEmail: String(formData.get('contactEmail') ?? ''),
    description: String(formData.get('description') ?? ''),
    isBusiness: formData.get('isBusiness') ? 'on' : undefined,
    businessNo: String(formData.get('businessNo') ?? ''),
    agree: formData.get('agree') ? 'on' : undefined,
    password: String(formData.get('password') ?? ''),
    passwordConfirm: String(formData.get('passwordConfirm') ?? ''),
  };
  const values: Record<string, string> = {
    displayName: raw.displayName.trim(),
    channelName: raw.channelName.trim(),
    channelUrl: raw.channelUrl.trim(),
    contactEmail: raw.contactEmail.trim(),
    description: raw.description.trim(),
    businessNo: raw.businessNo.trim(),
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.', values };
  }
  const data = parsed.data;

  // 자동화 도구로 신청을 대량 생성하는 것을 막는다. (같은 IP 기준 분당 5회)
  const limited = await consumeIpRateLimit('merchant-apply', 5, 60);
  if (!limited.ok) {
    return { ok: false, message: '신청 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.', values };
  }

  const session = await getSessionUser();

  // ------------------------------------------------------------ 계정 확보
  let userId: string;
  let newUser: { id: string; email: string; name: string; role: 'MERCHANT'; passwordHash: string } | null = null;
  if (session) {
    if (session.role === 'ADMIN') {
      return { ok: false, message: '관리자 계정으로는 사회복지기관을 신청할 수 없습니다.', values };
    }
    const existing = await prisma.merchantProfile.findUnique({
      where: { userId: session.id },
      select: { code: true, status: true, displayName: true },
    });
    if (existing) {
      return {
        ok: false,
        message: '이미 사회복지기관 신청 이력이 있습니다.',
        code: existing.code,
        displayName: existing.displayName,
        alreadyStatus: existing.status,
        values,
      };
    }
    userId = session.id;
  } else {
    const password = data.password ?? '';
    if (password.length < 8) {
      return { ok: false, message: '비밀번호는 8자 이상이어야 합니다.', values };
    }
    if (password !== data.passwordConfirm) {
      return { ok: false, message: '비밀번호가 서로 일치하지 않습니다.', values };
    }
    const dup = await prisma.user.findUnique({ where: { email: data.contactEmail }, select: { id: true } });
    if (dup) {
      return {
        ok: false,
        message: '이미 가입된 이메일입니다. 로그인 후 다시 신청해 주세요.',
        values,
      };
    }
    // 프로필 생성까지 한 트랜잭션으로 묶기 위해 여기서는 만들지 않고 입력만 준비한다.
    // (사용자만 만들어지고 프로필이 없으면 재신청은 "이미 가입된 이메일", 로그인은 /studio 오류가 된다)
    newUser = {
      id: newId(),
      email: data.contactEmail,
      name: data.displayName,
      role: 'MERCHANT' as const,
      passwordHash: await hashPassword(password),
    };
    userId = newUser.id;
  }

  // ------------------------------------------------------------ 프로필 생성
  let code: string;
  try {
    code = await reserveMerchantCode();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '코드 발급에 실패했습니다.', values };
  }

  const businessNo = data.isBusiness === 'on' ? (data.businessNo ?? '').replace(/\D/g, '') : null;
  // 채널 주소를 소개글에 이어 붙이면 안 된다.
  // 소개 300자 + "채널: <URL>" 304자 = 최대 604자가 되는데, 스튜디오 결제 페이지 설정은
  // 소개를 300자로 검증하므로 사회복지기관이 손대지도 않은 필드 때문에
  // 이후 모든 설정 저장이 영구히 실패한다. 반드시 별도 컬럼에 보관한다.
  const description = data.description?.trim() || null;
  const channelUrl = data.channelUrl?.trim() || null;

  try {
    const merchant = await prisma.$transaction(async (tx) => {
      if (newUser) await tx.user.create({ data: newUser });

      const profile = await tx.merchantProfile.create({
        data: {
          id: newId(),
          userId,
          code,
          displayName: data.displayName,
          channelName: data.channelName?.trim() || null,
          description,
          channelUrl,
          status: 'PENDING',
          businessNo,
        },
        select: { id: true, code: true, displayName: true },
      });

      await tx.merchantCode.create({
        data: { id: newId(), merchantId: profile.id, code: profile.code, active: true },
      });

      // 로그인 사용자의 역할을 사회복지기관으로 승격 (관리자는 위에서 차단)
      if (session && session.role !== 'MERCHANT') {
        await tx.user.update({ where: { id: userId }, data: { role: 'MERCHANT' } });
      }
      return profile;
    });

    if (!session) {
      await createSession(userId);
    }

    return { ok: true, code: merchant.code, displayName: merchant.displayName };
  } catch {
    return { ok: false, message: '신청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', values };
  }
}
