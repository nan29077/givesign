import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, phoneHash, maskPhone, maskSecret } from '@/lib/crypto';
import { resetMockPaymentState } from '@/server/adapters/payment';
import { resetMockPayoutState } from '@/server/adapters/payout';
import { clearMockOutbox, readMockOutbox, setMockMtFailure } from '@/server/adapters/mt';
import { clearMtTemplateOverrideCache } from '@/server/services/mt-templates';
import { clearMemoryKv } from '@/server/redis';

/** 테스트마다 DB 를 비운다. 순서는 FK 역순. */
export async function resetDb() {
  const tables = [
    'admin_audit_log', 'webhook_log', 'consent_record', 'notification', 'report',
    'settlement_ledger', 'settlement_request', 'settlement_account', 'fee_policy',
    'payment_attempt', 'payment_transaction', 'refund',
    'charge_status_log', 'secure_link', 'mt_outbound_message', 'charge',
    'mo_inbound_message', 'charge_counter', 'risk_detection', 'blocked_payer',
    'payer_merchant_link', 'payment_method_token', 'payment_registration', 'payer_profile',
    'merchant_mo_number', 'merchant_code', 'banned_word', 'charge_limit_policy', 'merchant_profile',
    'admin_profile', 'user_session', 'app_user', 'terms_version', 'idempotency_key',
    'content_post', 'banner', 'system_setting',
    // FK 가 없어 CASCADE 로 지워지지 않는 테이블들. 빠뜨리면 테스트 간에 살아남아
    // 실행 순서에 따라 결과가 달라진다. (public_holiday 는 마이그레이션이 넣는 기준 데이터라 제외)
    'mt_message_template', 'support_message', 'support_inquiry',
  ];
  // 정산 원장은 append-only 트리거로 DELETE 가 막혀 있으므로 트리거를 잠시 끈다.
  // 중간에 실패해도 트리거는 반드시 다시 켠다. 꺼진 채로 남으면 이후 테스트에서
  // 원장 보호가 사라진 상태로 돌아 append-only 검증이 무의미해진다.
  await prisma.$executeRawUnsafe('ALTER TABLE settlement_ledger DISABLE TRIGGER settlement_ledger_append_only');
  try {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE settlement_ledger ENABLE TRIGGER settlement_ledger_append_only');
  }

  testChargeAmount = null;
  resetMockPaymentState();
  resetMockPayoutState();
  clearMockOutbox();
  setMockMtFailure(null);
  // mt_message_template 을 비웠으므로 프로세스 캐시도 함께 버린다.
  // 남겨 두면 앞 테스트가 저장한 커스텀 본문이 TTL 동안 계속 적용된다.
  clearMtTemplateOverrideCache();
  // 속도 제한 카운터(MO 결제 요청 제한 등)도 프로세스 전역이라 테스트 간에 살아남는다.
  clearMemoryKv();
}

export interface Fixture {
  merchantId: string;
  merchantUserId: string;
  moNumber: string;
  payerPhone: string;
  payerId?: string;
}

export async function seedBasics(options: { paymentMode?: 'CONFIRM_LINK' | 'DIRECT_TRIGGER' } = {}) {
  await prisma.chargeLimitPolicy.create({ data: { id: newId(), scope: 'GLOBAL' } });
  await prisma.feePolicy.create({
    data: { id: newId(), scope: 'GLOBAL', pgFeeRate: '0.018', platformFeeRate: '0.15' },
  });

  for (const t of ['TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM'] as const) {
    await prisma.termsVersion.create({
      data: {
        id: newId(), type: t, version: '1.0', title: `${t} 약관`, content: '테스트 약관',
        required: true, effectiveFrom: new Date('2026-01-01'),
      },
    });
  }

  const user = await prisma.user.create({
    data: { id: newId(), email: `merchant-${newId()}@test.kr`, name: '테스트사회복지기관', role: 'MERCHANT' },
  });
  const merchant = await prisma.merchantProfile.create({
    data: {
      id: newId(), userId: user.id, code: `GIV-${newId().slice(-4)}`, displayName: '테스트사회복지기관',
      status: 'APPROVED',
      paymentMode: options.paymentMode ?? 'DIRECT_TRIGGER',
    },
  });

  const moNumber = '15881001';
  await prisma.merchantMoNumber.create({
    data: {
      id: newId(), phoneNumber: moNumber, mode: 'DEDICATED', status: 'ASSIGNED',
      merchantId: merchant.id, providerId: 'mock', assignedAt: new Date(),
    },
  });

  await prisma.settlementAccount.create({
    data: {
      id: newId(), merchantId: merchant.id, bankCode: '004', bankName: 'KB국민은행',
      accountEnc: encrypt('11122233344455'), accountTail4: '4455',
      holderNameEnc: encrypt('테스트'), holderMasked: '테*트', verified: true, verifiedAt: new Date(),
    },
  });

  // 문자 결제는 금액을 고르는 단계를 거치므로 기본 후원 항목을 함께 만든다.
  await seedChargeProducts(merchant.id);

  return { merchantId: merchant.id, merchantUserId: user.id, moNumber, payerPhone: '01012345678' } as Fixture;
}

/** 계좌 등록이 완료된 후원자를 만든다. */
export async function seedRegisteredPayer(phone = '01012345678') {
  const payer = await prisma.payerProfile.create({
    data: {
      id: newId(), phoneHash: phoneHash(phone), phoneEnc: encrypt(phone),
      phoneMasked: maskPhone(phone), displayName: '테스트후원자',
      ageVerified: true, registeredAt: new Date(),
      onboardingStatus: 'REGISTERED',
    },
  });
  await prisma.paymentMethodToken.create({
    data: {
      id: newId(), payerId: payer.id, provider: 'mock',
      billKeyEnc: encrypt('MOCKBILL-TEST-4455'), billKeyHint: maskSecret('MOCKBILL-TEST-4455'),
      bankCode: '004', bankName: 'KB국민은행', accountTail4: '4455',
    },
  });
  return payer;
}

let seq = 0;
export function moPayload(input: {
  to: string;
  from?: string;
  text?: string;
  messageId?: string;
  receivedAt?: Date;
}) {
  seq += 1;
  return {
    messageId: input.messageId ?? `MO-TEST-${Date.now()}-${seq}`,
    to: input.to,
    from: input.from ?? '01012345678',
    text: input.text ?? '캐시 충전합니다',
    type: 'SMS',
    receivedAt: (input.receivedAt ?? new Date()).toISOString(),
  };
}

/**
 * 시드 사회복지기관의 후원 항목. 문자 결제는 금액을 고르는 단계를 거치므로 테스트에도 상품이 필요하다.
 */
export async function seedChargeProducts(merchantId: string, amounts: number[] = [3000, 10000]) {
  for (const [i, amount] of amounts.entries()) {
    await prisma.chargeProduct.create({
      data: {
        id: newId(),
        merchantId,
        name: `${amount.toLocaleString('ko-KR')} 포인트`,
        amount,
        sortOrder: i,
      },
    });
  }
}

/**
 * MO 수신 후 발송된 후원 금액 선택 링크에서 토큰을 꺼낸다.
 * 실제 후원자가 문자 속 링크를 누르는 것과 같은 경로를 테스트에서 재현하기 위한 헬퍼다.
 */
export function lastSelectAmountToken(): string | null {
  // 본문 문구가 아니라 템플릿 코드로 찾는다.
  // (사회복지기관이 안내 문구를 바꿀 수 있게 되면서 본문 매칭은 더 이상 믿을 수 없다)
  const mt = readMockOutbox(10).find((m) => m.template === 'SELECT_AMOUNT');
  if (!mt) return null;
  const m = mt.text.match(/\/r\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * 금액 선택까지 마쳐 결제(PIN 인증)까지 진행시킨다.
 * amount 를 주면 직접 입력, 주지 않으면 첫 번째 후원 항목을 고른다.
 */
export async function selectChargeAmount(merchantId: string, amount?: bigint) {
  const { confirmChargeAmount } = await import('@/server/services/charge-select');
  const token = lastSelectAmountToken();
  if (!token) throw new Error('후원 금액 선택 링크를 찾지 못했습니다.');

  if (amount != null) return confirmChargeAmount({ token, customAmount: amount });

  const product = await prisma.chargeProduct.findFirst({
    where: { merchantId, active: true, archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { amount: 'asc' }],
  });
  if (!product) throw new Error('후원 항목이 없습니다.');
  return confirmChargeAmount({ token, productId: product.id });
}

/**
 * 문자 결제 한 건을 끝까지 진행시킨다.
 *
 * 실제 흐름과 같다: MO 수신 → (PENDING_AMOUNT) 금액 선택 링크 → 후원자가 금액 선택 → PIN 인증 시작.
 * MO 만으로 끝나는 경우(미등록·라우팅 실패·중복)는 그대로 돌려준다.
 */
export async function inboundAndSelect(payload: Record<string, unknown>, merchantId: string) {
  const { handleMoInbound } = await import('@/server/services/charge-flow');
  const { mockMoAdapter } = await import('@/server/adapters/mo');
  const mo = await handleMoInbound(mockMoAdapter.parse(payload));
  if (mo.status !== 'PENDING_AMOUNT' || !mo.chargeId) return mo;

  const sel = await selectChargeAmount(merchantId, testChargeAmount ?? undefined);
  const after = await prisma.charge.findUnique({
    where: { id: mo.chargeId },
    select: { status: true },
  });
  return { ...mo, status: after?.status ?? mo.status, message: sel.message };
}

/**
 * 문자 결제를 결제 완료까지 진행시킨다.
 *
 * inboundAndSelect 로 금액을 고른 뒤, 후원자가 결제사 화면에서 PIN 을 입력한 것과 같은
 * 콜백을 넣어 승인까지 끝낸다. 결제 결과가 필요한 테스트에서 쓴다.
 */
export async function inboundAndPay(payload: Record<string, unknown>, merchantId: string) {
  const res = await inboundAndSelect(payload, merchantId);
  if (res.status !== 'PENDING_PIN' || !res.chargeId) return res;

  const { completePinAuthorization } = await import('@/server/services/pin-authorization');
  const session = await prisma.paymentPinSession.findUnique({ where: { chargeId: res.chargeId } });
  if (!session) return res;

  const done = await completePinAuthorization({ sessionId: session.sessionId });
  const after = await prisma.charge.findUnique({
    where: { id: res.chargeId },
    select: { status: true },
  });
  return { ...res, status: after?.status ?? res.status, message: done.message };
}

/**
 * 다음 결제에서 직접 입력할 금액.
 * mock 결제 어댑터는 금액 끝자리로 동작이 갈리므로(999 거절, 888 타임아웃 후 승인 등)
 * 테스트가 금액을 지정해야 할 때 쓴다. null 이면 첫 번째 후원 항목을 고른다.
 */
let testChargeAmount: bigint | null = null;
export function setChargeAmount(v: bigint | null) {
  testChargeAmount = v;
}
