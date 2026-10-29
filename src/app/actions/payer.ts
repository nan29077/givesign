'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { currentTermsDoc } from '@/server/services/terms';
import { getSessionUser, destroySession } from '@/server/auth';
import { revokePaymentMethod } from '@/server/services/payer-registration';
import { requestRefund } from '@/server/services/refund';
import { resolvePolicy } from '@/server/services/limits';
import { validatePayerName } from '@/server/services/payer-name';
import { newId } from '@/lib/id';

/**
 * 후원자 마이페이지 서버 액션.
 *
 * 공통 규칙
 *  - 반드시 로그인 사용자의 PayerProfile 을 먼저 확인한다.
 *  - 모든 대상 레코드는 해당 payerId 소유인지 검증한 뒤에만 변경한다.
 */

export interface PayerActionState {
  ok: boolean;
  message?: string;
}

/** 로그인 사용자의 후원자 프로필. 없으면 null */
async function currentPayer() {
  const user = await getSessionUser();
  if (!user) return null;
  const payer = await prisma.payerProfile.findUnique({
    where: { userId: user.id },
    select: { id: true, dailyLimit: true, monthlyLimit: true },
  });
  if (!payer) return null;
  return { user, payer };
}

const NO_PAYER = '문자후원 이용 내역이 없어 처리할 수 없습니다.';
const NO_SESSION = '로그인이 필요합니다.';

// ---------------------------------------------------------------- 자동출금 해지

export async function revokeAutoWithdrawal(
  _prev: PayerActionState,
  _formData: FormData,
): Promise<PayerActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };

  try {
    const revoked = await revokePaymentMethod(ctx.payer.id);
    revalidatePath('/my/account');
    return revoked
      ? { ok: true, message: '자동출금 동의가 해지되었습니다. 등록된 결제수단이 폐기되었습니다.' }
      : { ok: false, message: '해지할 활성 결제수단이 없습니다.' };
  } catch {
    return { ok: false, message: '해지 처리 중 오류가 발생했습니다. 고객센터로 문의해 주세요.' };
  }
}

// ---------------------------------------------------------------- 한도 설정

const limitSchema = z.object({
  dailyLimit: z.string().trim(),
  monthlyLimit: z.string().trim(),
});

function parseLimit(input: string): bigint | null | 'INVALID' {
  const v = input.replace(/[,\s]/g, '');
  if (v === '') return null; // 미설정 = 전역 정책 사용
  if (!/^\d{1,12}$/.test(v)) return 'INVALID';
  const n = BigInt(v);
  if (n <= 0n) return 'INVALID';
  return n;
}

export async function updatePayerLimits(
  _prev: PayerActionState,
  formData: FormData,
): Promise<PayerActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };

  const parsed = limitSchema.safeParse({
    dailyLimit: String(formData.get('dailyLimit') ?? ''),
    monthlyLimit: String(formData.get('monthlyLimit') ?? ''),
  });
  if (!parsed.success) return { ok: false, message: '입력값을 확인해 주세요.' };

  const daily = parseLimit(parsed.data.dailyLimit);
  const monthly = parseLimit(parsed.data.monthlyLimit);
  if (daily === 'INVALID' || monthly === 'INVALID') {
    return { ok: false, message: '한도는 0보다 큰 숫자로 입력해 주세요.' };
  }

  const policy = await resolvePolicy(null, ctx.payer.id);

  // 후원자는 전역 정책보다 낮은 값만 설정할 수 있다.
  if (daily !== null && daily > policy.payerDailyLimit) {
    return { ok: false, message: '일일 한도는 기본 정책보다 높게 설정할 수 없습니다.' };
  }
  if (monthly !== null && monthly > policy.payerMonthlyLimit) {
    return { ok: false, message: '월간 한도는 기본 정책보다 높게 설정할 수 없습니다.' };
  }
  const effectiveDaily = daily ?? policy.payerDailyLimit;
  const effectiveMonthly = monthly ?? policy.payerMonthlyLimit;
  if (effectiveDaily > effectiveMonthly) {
    return { ok: false, message: '일일 한도는 월간 한도보다 클 수 없습니다.' };
  }

  await prisma.payerProfile.update({
    where: { id: ctx.payer.id },
    data: { dailyLimit: daily, monthlyLimit: monthly },
  });
  revalidatePath('/my/limits');
  return { ok: true, message: '한도가 저장되었습니다.' };
}

// ---------------------------------------------------------------- 표시 이름

/**
 * 후원 내역에 표시될 이름 변경.
 *
 * 이미 접수된 결제(Charge.displayName)은 그때의 이름을 그대로 둔다.
 * 이미 후원 내역에 남은 이름을 나중에 바꾸면 기록이 실제와 어긋나기 때문이다.
 * 이후 결제부터 새 닉네임이 적용된다.
 */
export async function updatePayerNickname(
  _prev: PayerActionState,
  formData: FormData,
): Promise<PayerActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };

  const raw = String(formData.get('nickname') ?? '');
  const checked = await validatePayerName(raw);
  if (!checked.ok) return { ok: false, message: checked.message ?? '닉네임을 다시 입력해 주세요.' };

  await prisma.payerProfile.update({
    where: { id: ctx.payer.id },
    // 빈 값으로 저장하면 기본 이름(후원자5678)으로 되돌아간다.
    data: { displayName: checked.value.length > 0 ? checked.value : null },
  });
  revalidatePath('/my/account');
  return {
    ok: true,
    message:
      checked.value.length > 0
        ? '닉네임이 저장되었습니다. 다음 결제부터 적용됩니다.'
        : '닉네임을 지웠습니다. 기본 이름으로 표시됩니다.',
  };
}

// ---------------------------------------------------------------- 사회복지기관 차단

export async function toggleMerchantBlock(
  _prev: PayerActionState,
  formData: FormData,
): Promise<PayerActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };

  const linkId = String(formData.get('linkId') ?? '').trim();
  const next = String(formData.get('next') ?? '');
  if (!linkId) return { ok: false, message: '대상을 찾을 수 없습니다.' };

  // 소유권 검증: 반드시 로그인 후원자의 링크여야 한다.
  const link = await prisma.payerMerchantLink.findUnique({
    where: { id: linkId },
    select: { id: true, payerId: true, payerBlockedAt: true, merchant: { select: { displayName: true } } },
  });
  if (!link || link.payerId !== ctx.payer.id) {
    return { ok: false, message: '대상을 찾을 수 없습니다.' };
  }

  const shouldBlock = next === 'BLOCK';
  await prisma.payerMerchantLink.update({
    where: { id: link.id },
    // 후원자 방향 차단만 건드린다. 사회복지기관이 건 차단(blocked_payer)은 그대로 유지된다.
    data: { payerBlockedAt: shouldBlock ? new Date() : null },
  });
  revalidatePath('/my/blocks');
  return {
    ok: true,
    message: shouldBlock
      ? `${link.merchant.displayName} 사회복지기관의 결제를 차단했습니다.`
      : `${link.merchant.displayName} 사회복지기관의 결제 차단을 해제했습니다.`,
  };
}

// ---------------------------------------------------------------- 환불 요청

export async function requestChargeRefund(
  _prev: PayerActionState,
  formData: FormData,
): Promise<PayerActionState> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: NO_SESSION };
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };

  const chargeId = String(formData.get('chargeId') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  if (!chargeId) return { ok: false, message: '대상 거래를 찾을 수 없습니다.' };
  if (reason.length < 2) return { ok: false, message: '환불 사유를 2자 이상 입력해 주세요.' };
  if (reason.length > 300) return { ok: false, message: '환불 사유는 300자 이내로 입력해 주세요.' };

  // 소유권 검증: 반드시 로그인 후원자의 거래여야 한다.
  const charge = await prisma.charge.findUnique({
    where: { id: chargeId },
    select: { id: true, payerId: true },
  });
  if (!charge || charge.payerId !== ctx.payer.id) {
    return { ok: false, message: '대상 거래를 찾을 수 없습니다.' };
  }

  try {
    await requestRefund({ chargeId: charge.id, reason, requestedBy: user.id });
    revalidatePath('/my');
    return { ok: true, message: '환불 요청이 접수되었습니다. 검토 후 결과를 안내드립니다.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '환불 요청에 실패했습니다.' };
  }
}

// ---------------------------------------------------------------- 마케팅 수신 동의/철회

/**
 * 마케팅 수신 동의는 선택 동의이므로 마이페이지에서 직접 동의/철회할 수 있다.
 * ConsentRecord 는 이력형(append-only 성격)이므로 새 레코드를 추가하는 방식으로 기록한다.
 */
export async function setMarketingConsent(
  _prev: PayerActionState,
  formData: FormData,
): Promise<PayerActionState> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: NO_SESSION };

  const agree = String(formData.get('agree') ?? '') === 'on';

  const terms = await currentTermsDoc('MARKETING');
  if (!terms) return { ok: false, message: '마케팅 동의 약관을 찾을 수 없습니다. 고객센터로 문의해 주세요.' };

  const payer = await prisma.payerProfile.findUnique({
    where: { userId: user.id },
    select: { phoneHash: true },
  });

  await prisma.consentRecord.create({
    data: {
      id: newId(),
      userId: user.id,
      phoneHash: payer?.phoneHash ?? null,
      termsId: terms.id,
      type: 'MARKETING',
      agreed: agree,
    },
  });

  revalidatePath('/my/consents');
  return {
    ok: true,
    message: agree
      ? '마케팅 정보 수신에 동의했습니다.'
      : '마케팅 정보 수신 동의를 철회했습니다. 처리에 최대 1영업일이 걸릴 수 있습니다.',
  };
}

// ---------------------------------------------------------------- 회원 탈퇴

/**
 * 후원자 회원 탈퇴.
 *
 * 처리 원칙
 *  - 거래·정산 기록은 법정 보존 대상이므로 삭제하지 않는다. 계정과의 연결만 끊는다.
 *  - 자동출금(빌키)은 반드시 먼저 폐기한다. 남겨두면 탈퇴 후에도 출금될 수 있다.
 *  - 계정은 WITHDRAWN 상태로 바꾸고 로그인 수단(이메일·비밀번호)을 무효화한다.
 *  - 진행 중인 환불 요청이 있으면 처리 후 탈퇴하도록 막는다.
 */
export async function withdrawAccount(_prev: PayerActionState, formData: FormData): Promise<PayerActionState> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: NO_SESSION };

  // 후원자 전용 절차다. 사회복지기관은 정산·MO 번호 정리가, 관리자는 권한 이관이 선행돼야 하므로
  // 이 경로로 탈퇴하면 프로필과 배정 자원이 고아 상태로 남는다.
  if (user.role !== 'PAYER') {
    return {
      ok: false,
      message:
        user.role === 'MERCHANT'
          ? '사회복지기관 계정은 정산과 결제 수신번호 정리가 필요해 이 화면에서 탈퇴할 수 없습니다. 고객센터로 요청해 주세요.'
          : '관리자 계정은 이 화면에서 탈퇴할 수 없습니다. 다른 최고관리자에게 권한 이관 후 처리해 주세요.',
    };
  }

  if (String(formData.get('confirm') ?? '').trim() !== '탈퇴합니다') {
    return { ok: false, message: '확인 문구를 정확히 입력해 주세요. (탈퇴합니다)' };
  }

  const payer = await prisma.payerProfile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });

  if (payer) {
    const openRefund = await prisma.refund.count({
      where: { charge: { payerId: payer.id }, status: { in: ['REQUESTED', 'APPROVED'] } },
    });
    if (openRefund > 0) {
      return {
        ok: false,
        message: `처리 중인 환불 요청이 ${openRefund}건 있습니다. 환불이 완료된 뒤에 탈퇴할 수 있습니다.`,
      };
    }

    // 자동출금 수단 폐기 (탈퇴 후 출금 방지)
    try {
      await revokePaymentMethod(payer.id);
    } catch {
      return { ok: false, message: '결제수단 해지 중 오류가 발생했습니다. 고객센터로 문의해 주세요.' };
    }
  }

  try {
    // 탈퇴한 프로필이 "번호만 인증하면 누구나 이어받을 수 있는" 상태로 남지 않게 한다.
    //
    // 휴대전화 번호는 해지 후 재판매된다. phoneHash 를 그대로 두면 같은 번호를 새로 받은
    // 다른 사람이 가입 후 번호 인증만으로 이전 후원자의 후원 내역·메시지 원문·차단 목록·
    // 동의 이력을 전부 열람하게 된다(phone-link.ts 는 userId 가 null 이면 그대로 붙인다).
    //
    // 거래 이력(Charge)은 payerId 로 연결되어 그대로 보존되고, 마스킹된 번호도 남는다.
    // 다만 이 프로필은 더 이상 어떤 번호와도 매칭되지 않는다.
    const withdrawing = await prisma.payerProfile.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });

    await prisma.$transaction([
      // 후원자 프로필은 남기고 계정 연결만 끊는다 (거래 이력 보존)
      prisma.payerProfile.updateMany({
        where: { userId: user.id },
        data: {
          userId: null,
          onboardingStatus: 'WITHDRAWN',
          // 다시 매칭되지 않도록 무효화한다(unique 컬럼이라 값 자체를 바꾼다).
          ...(withdrawing ? { phoneHash: `withdrawn:${withdrawing.id}` } : {}),
          // 표시 이름은 거래 기록(Charge.displayName 스냅샷)에 이미 남아 있어 프로필에는 둘 필요가 없다.
          displayName: null,
          snsPlatform: null,
        },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: {
          status: 'WITHDRAWN',
          // 같은 이메일로 재가입할 수 있도록 로그인 수단을 비운다
          email: `withdrawn+${user.id}@invalid.local`,
          passwordHash: null,
          name: null,
          phoneHash: null,
          phoneEnc: null,
          phoneMasked: null,
          deletedAt: new Date(),
        },
      }),
      prisma.userSession.deleteMany({ where: { userId: user.id } }),
    ]);
  } catch {
    return { ok: false, message: '탈퇴 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }

  await destroySession();
  redirect('/?withdrawn=1');
}
