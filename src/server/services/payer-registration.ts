import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { decrypt, encrypt, maskSecret } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { getPaymentAdapter } from '@/server/adapters/payment';
import { resolveSecureLink, consumeSecureLink } from './secure-link';
import { validatePayerName } from './payer-name';
import { currentTermsList } from './terms';
import { suspendRecurringForPayer } from './recurring';
import type { ConsentType, PaymentMethodKind } from '@/generated/prisma/enums';

/**
 * 후원자 계좌 등록 (헥토 내통장결제 0원 인증 후 빌키 발급 흐름).
 *
 * 저장 규칙
 *  - 계좌번호 원문과 인증정보는 기브싸인 DB 에 저장하지 않는다.
 *  - 은행명과 계좌 끝 4자리, 암호화된 빌키만 보관한다.
 */

export interface RegistrationContext {
  linkId: string;
  payerId: string;
  merchantId: string | null;
  merchantName: string | null;
  phoneMasked: string;
}

export async function loadRegistrationContext(token: string): Promise<
  { ok: true; ctx: RegistrationContext } | { ok: false; reason: string }
> {
  const res = await resolveSecureLink(token);
  if (!res.ok) {
    const reason =
      res.reason === 'EXPIRED' ? '가입 링크가 만료되었습니다. 사회복지기관 번호로 문자를 다시 보내면 새 링크가 발송됩니다.'
      : res.reason === 'USED' ? '이미 사용된 링크입니다.'
      : '유효하지 않은 링크입니다.';
    return { ok: false, reason };
  }
  const link = res.link!;
  if (link.purpose !== 'REGISTER_ACCOUNT') return { ok: false, reason: '용도가 다른 링크입니다.' };

  const payer = await prisma.payerProfile.findUnique({ where: { phoneHash: link.phoneHash } });
  if (!payer) return { ok: false, reason: '후원자 정보를 찾을 수 없습니다.' };

  const merchant = link.merchantId
    ? await prisma.merchantProfile.findUnique({ where: { id: link.merchantId } })
    : null;

  return {
    ok: true,
    ctx: {
      linkId: link.id,
      payerId: payer.id,
      merchantId: merchant?.id ?? null,
      merchantName: merchant?.displayName ?? null,
      phoneMasked: payer.phoneMasked,
    },
  };
}

export interface ConsentInput {
  type: ConsentType;
  agreed: boolean;
}

/**
 * 결제창 세션 생성. 필수 동의가 모두 있어야 진행한다.
 *
 * `method` 로 계좌(ACCOUNT) / 카드(CARD) 빌키를 구분한다.
 * 카드 빌링키는 아직 실 연동 전이라 어댑터가 실패를 돌려주며, 여기서는 구조만 준비해 둔다.
 */
export async function startRegistration(input: {
  token: string;
  consents: ConsentInput[];
  method?: PaymentMethodKind;
  /** 후원 내역에 표시될 이름(선택). 빈 값이면 설정하지 않은 것으로 본다. */
  nickname?: string;
  /** SNS 플랫폼(선택). 닉네임과 세트로 저장한다. */
  snsPlatform?: string;
  ip?: string;
  userAgent?: string;
}) {
  const loaded = await loadRegistrationContext(input.token);
  if (!loaded.ok) throw new Error(loaded.reason);
  const { ctx } = loaded;

  // 시행일이 아직 오지 않은 약관은 화면의 동의 목록에도 뜨지 않는다(app/r/[token]/page.tsx).
  // 여기서만 시행일을 무시하면, 시행일이 미래인 필수 약관을 등록하는 순간
  // 화면에 뜨지도 않는 항목을 요구해 신규 가입이 통째로 막힌다.
  const currentTerms = await currentTermsList();
  const requiredTerms = currentTerms.filter((t) => t.required);
  const agreedTypes = new Set(input.consents.filter((c) => c.agreed).map((c) => c.type));
  const missing = requiredTerms.filter((t) => !agreedTypes.has(t.type));
  if (missing.length > 0) {
    throw new Error(`필수 동의 항목이 누락되었습니다: ${missing.map((m) => m.title).join(', ')}`);
  }

  const payer = await prisma.payerProfile.findUnique({ where: { id: ctx.payerId } });
  if (!payer) throw new Error('후원자 정보를 찾을 수 없습니다.');

  // 표시 이름(선택). 결제창으로 넘어가기 전에 저장해 둔다.
  // 결제창에서 이탈해도 닉네임은 남으므로 다시 등록할 때 또 입력하지 않아도 된다.
  if (input.nickname !== undefined && input.nickname.trim().length > 0) {
    const checked = await validatePayerName(input.nickname);
    if (!checked.ok) throw new Error(checked.message ?? '닉네임을 다시 입력해 주세요.');
    await prisma.payerProfile.update({
      where: { id: payer.id },
      data: {
        displayName: checked.value,
        snsPlatform: input.snsPlatform?.trim() || null,
      },
    });
  }

  // 동의 이력 저장 (약관 버전 포함)
  // 화면에 뜬 것과 같은 시행본에 동의 이력을 건다(시행 예정 버전에 걸리면 근거가 어긋난다).
  for (const c of input.consents) {
    const terms = currentTerms.find((t) => t.type === c.type);
    if (!terms) continue;
    await prisma.consentRecord.create({
      data: {
        id: newId(),
        phoneHash: payer.phoneHash,
        userId: payer.userId ?? null,
        termsId: terms.id,
        type: c.type,
        agreed: c.agreed,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  const method: PaymentMethodKind = input.method ?? 'ACCOUNT';

  const registration = await prisma.paymentRegistration.create({
    data: {
      id: newId(),
      payerId: ctx.payerId,
      merchantId: ctx.merchantId,
      provider: env.payment.provider,
      method,
    },
  });

  const adapter = getPaymentAdapter();
  const session = await adapter.createRegistrationSession({
    payerRef: registration.id,
    returnUrl: `${env.baseUrl}/r/${input.token}/complete`,
    notifyUrl: `${env.baseUrl}/api/payments/notify`,
    method,
  });
  if (!session.ok || !session.data) throw new Error(session.message ?? '결제창 생성에 실패했습니다.');

  await prisma.paymentRegistration.update({
    where: { id: registration.id },
    data: { status: 'AUTH_DONE', providerTid: session.data.providerTid },
  });

  return { registrationId: registration.id, redirectUrl: session.data.redirectUrl, ctx };
}

/** 결제창 콜백 처리 → 빌키 저장. 계좌 원문은 저장하지 않는다. */
export async function completeRegistration(input: {
  token: string;
  registrationId: string;
  providerPayload: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}) {
  const loaded = await loadRegistrationContext(input.token);
  if (!loaded.ok) throw new Error(loaded.reason);
  const { ctx } = loaded;

  // registrationId 는 클라이언트가 보낸 값이다. 링크 소유자(payerId)의 등록 건이 아니면 거절한다.
  // 사업자 호출보다 먼저 확인한다. 남의 등록번호로 빌키를 발급받아 버리고 나서 거절하면
  // 사업자 쪽에는 쓰지도 않을 빌키가 남는다.
  const owned = await prisma.paymentRegistration.findFirst({
    where: { id: input.registrationId, payerId: ctx.payerId },
    select: { id: true, status: true, method: true },
  });
  if (!owned) throw new Error('등록 요청 정보가 올바르지 않습니다. 처음부터 다시 진행해 주세요.');
  if (owned.status === 'COMPLETED') throw new Error('이미 완료된 등록 요청입니다.');

  const adapter = getPaymentAdapter();
  // 결제수단 종류는 결제창 응답이 아니라 우리가 시작할 때 기록한 값이 기준이다.
  const res = await adapter.completeRegistration({ ...input.providerPayload, method: owned.method });

  if (!res.ok || !res.data) {
    await prisma.paymentRegistration.update({
      where: { id: input.registrationId },
      data: { status: 'FAILED', resultCode: res.code ?? null, resultMessage: res.message ?? null },
    });
    throw new Error(res.message ?? '계좌 등록에 실패했습니다.');
  }

  // 기존 활성 결제수단은 폐기 (활성 1건 유지)
  await prisma.paymentMethodToken.updateMany({
    where: { payerId: ctx.payerId, status: 'ACTIVE' },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });

  // 빌키 종류는 사업자 응답을 우선하고, 없으면 등록을 시작할 때 기록해 둔 값을 쓴다.
  const method: PaymentMethodKind = res.data.method ?? owned.method ?? 'ACCOUNT';

  const token = await prisma.paymentMethodToken.create({
    data: {
      id: newId(),
      payerId: ctx.payerId,
      provider: env.payment.provider,
      method,
      billKeyEnc: encrypt(res.data.billKey),
      billKeyHint: maskSecret(res.data.billKey),
      bankCode: res.data.bankCode ?? null,
      bankName: res.data.bankName ?? null,
      accountTail4: res.data.accountTail4 ?? null,
      // 카드 원문은 저장하지 않는다. 발급사명과 끝 4자리만 보관한다.
      cardIssuer: res.data.cardIssuer ?? null,
      cardTail4: res.data.cardTail4 ?? null,
    },
  });

  await prisma.paymentRegistration.update({
    where: { id: input.registrationId },
    data: { status: 'COMPLETED', providerTid: res.data.providerTid, completedAt: new Date() },
  });

  await prisma.payerProfile.update({
    where: { id: ctx.payerId },
    data: { registeredAt: new Date(), ageVerified: true, onboardingStatus: 'REGISTERED' },
  });

  if (ctx.merchantId) {
    await prisma.payerMerchantLink.upsert({
      where: { payerId_merchantId: { payerId: ctx.payerId, merchantId: ctx.merchantId } },
      create: { id: newId(), payerId: ctx.payerId, merchantId: ctx.merchantId, consentedAt: new Date() },
      update: { consentedAt: new Date() },
    });
  }

  // 링크는 1회만 사용 가능
  await consumeSecureLink(ctx.linkId, input.ip, input.userAgent);

  return {
    tokenId: token.id,
    payerId: ctx.payerId,
    method: token.method,
    bankName: token.bankName,
    accountTail4: token.accountTail4,
    cardIssuer: token.cardIssuer,
    cardTail4: token.cardTail4,
  };
}

/** 자동출금 동의 해지 = 등록 결제수단 폐기 */
export async function revokePaymentMethod(payerId: string) {
  const active = await prisma.paymentMethodToken.findFirst({ where: { payerId, status: 'ACTIVE' } });
  if (!active) return false;
  // 사업자에는 빌키 원문을 보내야 한다(암호문을 보내면 PG 측 빌키가 살아남는다).
  // 사업자 해지 실패는 로그로 남기고, 내부 상태는 폐기로 바꿔 더 이상 출금에 쓰지 않는다.
  const adapter = getPaymentAdapter();
  const revoked = await adapter
    .revokeBillKey(decrypt(active.billKeyEnc))
    .catch((e: unknown) => ({ ok: false as const, message: (e as Error)?.message }));
  if (!revoked.ok) {
    logger.error('빌키 해지 실패 (내부 상태는 폐기 처리)', { payerId, tokenId: active.id, message: revoked.message });
  }
  await prisma.paymentMethodToken.update({
    where: { id: active.id },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  await prisma.payerProfile.update({
    where: { id: payerId },
    data: { onboardingStatus: 'SUSPENDED' },
  });
  // 결제수단이 없어졌으니 정기후원도 멈춘다. 그대로 두면 다음 출금일에 "결제수단 없음" 실패가 3번 쌓인 뒤에야 정지된다.
  await suspendRecurringForPayer(payerId, '결제수단 해지').catch((e: unknown) =>
    logger.error('결제수단 해지 후 정기후원 정지 실패', { payerId, message: (e as Error)?.message }),
  );
  return true;
}
