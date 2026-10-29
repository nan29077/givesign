import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt } from '@/lib/crypto';
import {
  inboundAndPay,
  moPayload,
  resetDb,
  seedBasics,
  seedRegisteredPayer,
  setChargeAmount,
  lastSelectAmountToken,
  type Fixture,
} from './helpers';
import { runMerchantPayout, findDueCharges, retryPayout } from '@/server/services/auto-settlement';
import { getSettlementSummary } from '@/server/services/settlement';
import { reconcileUnknownPayment } from '@/server/services/payment-reconcile';
import { requestRefund, approveRefund } from '@/server/services/refund';
import { resetMockPayoutState } from '@/server/adapters/payout';
import { setMockMtFailure, readMockOutbox } from '@/server/adapters/mt';

/**
 * 실패 경로 테스트.
 *
 * mock 어댑터가 항상 성공하던 시절에는 아래 분기가 **한 줄도 실행되지 않았다.**
 * 하필 전부 돈이 새는 경로다:
 *   - 지급대행 결과 미확인이 조회로도 확정되지 않는 경우 (이중 이체의 출발점)
 *   - 결제 결과 미확인(UNKNOWN) 보존 (출금됐는데 정산 기록이 없는 상태)
 *   - 결제사가 환불 취소를 거절한 경우 (돈은 안 돌려줬는데 원장만 깎이는 상태)
 *   - MT 발송 실패 (안내 문자가 안 갔는데 발송한 것으로 처리되는 상태)
 *
 * mock 제어 방법
 *   지급대행: 계좌번호 끝 4자리 (0000 확정실패 / 9999 미확인→조회로 성공 / 8888 미확인→조회도 실패)
 *   결제:     금액 끝 3자리 (999 실패 / 888 타임아웃→승인확정 / 777 타임아웃→실패확정 /
 *                            666 타임아웃→조회실패(UNKNOWN) / 444 승인되지만 취소 거절)
 */

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => inboundAndPay(p, fx.merchantId);

async function account(merchantId: string, accountNo: string) {
  await prisma.settlementAccount.upsert({
    where: { merchantId },
    create: {
      id: newId(), merchantId, bankCode: '004', bankName: 'KB국민은행',
      accountEnc: encrypt(accountNo), accountTail4: accountNo.slice(-4),
      holderNameEnc: encrypt('김가맹'), holderMasked: '김*맹',
      verified: true, verifiedAt: new Date(),
    },
    update: { accountEnc: encrypt(accountNo), accountTail4: accountNo.slice(-4) },
  });
}

/** 결제 완료 건을 만들고 지급일이 지난 것처럼 결제 시각을 과거로 민다. */
async function fund(count = 2) {
  await seedRegisteredPayer(fx.payerPhone);
  for (let i = 0; i < count; i += 1) {
    await inbound(moPayload({ to: fx.moNumber, messageId: `FAIL-${i}-${Date.now()}` }));
  }
  await prisma.charge.updateMany({
    where: { merchantId: fx.merchantId, paidAt: { not: null } },
    data: { paidAt: new Date(Date.now() - 30 * 86_400_000) },
  });
}

beforeEach(async () => {
  await resetDb();
  resetMockPayoutState();
  setMockMtFailure(null);
  setChargeAmount(null);
  fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
});

afterEach(() => {
  setMockMtFailure(null);
  setChargeAmount(null);
});

// ===========================================================================
// 1. 지급대행 — 조회로도 확정되지 않는 실패
// ===========================================================================

describe('지급 실패가 이중 이체로 번지지 않는다', () => {
  it('조회로도 확정되지 않으면 회차만 실패로 남고 결제 건은 그 회차에 묶인 채 유지된다', async () => {
    await fund(2);
    await account(fx.merchantId, '11122233348888'); // 미확인 → 조회도 실패

    const first = await runMerchantPayout(fx.merchantId);
    expect(first.status).toBe('FAILED');
    expect(first.requestId).toBeTruthy();

    const req = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: first.requestId! } });
    expect(req.status).toBe('PAYOUT_FAILED');
    // 이체를 시도했다는 사실이 남아야 한다. 남지 않으면 다음 배치가 같은 돈을 다시 보낸다.
    expect(req.payoutIssuedAt).not.toBeNull();

    // 지급 분개는 없다(실제로 나간 돈이 확인되지 않았다).
    expect(await prisma.settlementLedger.count({ where: { entryType: 'PAYOUT' } })).toBe(0);

    // 결제 건은 이 회차에 묶여 있고, 정산 완료로 찍히지 않았다.
    const charges = await prisma.charge.findMany({ where: { merchantId: fx.merchantId } });
    expect(charges.every((c) => c.settlementRequestId === first.requestId)).toBe(true);
    expect(charges.every((c) => c.settledAt === null)).toBe(true);
  });

  it('실패한 회차의 결제 건은 다음 배치가 새 회차로 다시 잡지 않는다', async () => {
    await fund(2);
    await account(fx.merchantId, '11122233348888');

    const first = await runMerchantPayout(fx.merchantId);
    expect(first.status).toBe('FAILED');

    // 지급 대상 조회에서 빠져야 한다.
    const due = await findDueCharges(fx.merchantId);
    expect(due.charges).toHaveLength(0);

    // 같은 날 재실행: 멱등키가 남아 있어 새 회차를 만들지 않는다.
    const second = await runMerchantPayout(fx.merchantId);
    expect(second.status).not.toBe('PAID');
    expect(await prisma.settlementRequest.count()).toBe(1);

    // 다음 날 재실행도 마찬가지다(결제 건이 회차에 묶여 있으므로 대상이 없다).
    const nextDay = new Date(Date.now() + 86_400_000);
    const third = await runMerchantPayout(fx.merchantId, nextDay);
    expect(third.status).toBe('SKIPPED');
    expect(await prisma.settlementRequest.count()).toBe(1);
  });

  it('실패 회차 금액은 가용 잔액에서 계속 빠져 있다', async () => {
    await fund(2);
    await account(fx.merchantId, '11122233348888');
    const before = await getSettlementSummary(fx.merchantId);

    const run = await runMerchantPayout(fx.merchantId);
    expect(run.status).toBe('FAILED');

    const after = await getSettlementSummary(fx.merchantId);
    // 잔액(balance)은 그대로지만 보류(pending)로 잡혀 available 이 줄어야 한다.
    // 되돌려 주면 같은 돈이 다른 경로로 또 나간다.
    expect(after.balance).toBe(before.balance);
    expect(after.pending).toBeGreaterThan(0n);
    expect(after.available).toBeLessThan(before.available);
  });

  it('재시도가 성공하면 그 회차에 묶인 건만 정산 완료가 된다', async () => {
    await fund(2);
    await account(fx.merchantId, '11122233348888');
    const failed = await runMerchantPayout(fx.merchantId);
    expect(failed.status).toBe('FAILED');

    // 계좌를 정상으로 고치고 재시도한다.
    await account(fx.merchantId, '11122233344455');
    resetMockPayoutState(); // 대행사에 이전 이체 기록이 없는 상태(= 실제로 안 나갔음)
    const retry = await retryPayout(failed.requestId!);
    expect(retry.ok).toBe(true);

    const charges = await prisma.charge.findMany({ where: { merchantId: fx.merchantId } });
    expect(charges.every((c) => c.status === 'SETTLED')).toBe(true);
    expect(charges.every((c) => c.settledAt !== null)).toBe(true);
    expect(await prisma.settlementLedger.count({ where: { entryType: 'PAYOUT' } })).toBe(1);
  });
});

// ===========================================================================
// 2. 결제 결과 미확인(UNKNOWN)
// ===========================================================================

describe('결제 결과를 확인하지 못하면 실패로 덮지 않는다', () => {
  it('조회까지 실패하면 UNKNOWN 으로 남기고 관리자 확인 큐에 올린다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    setChargeAmount(3_666n); // 타임아웃 + 조회 실패

    const res = await inbound(moPayload({ to: fx.moNumber }));
    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: res.chargeId! } });

    // 출금 여부를 모르므로 결제 실패로 닫지 않는다.
    expect(charge.status).toBe('PENDING_PAYMENT');

    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { chargeId: charge.id } });
    expect(txn.status).toBe('UNKNOWN');

    // 관리자 대사 큐(UNKNOWN·TIMEOUT)에 올라와야 사람이 회수할 수 있다.
    const risk = await prisma.riskDetection.findFirst({
      where: { chargeId: charge.id, type: 'PAYMENT_UNKNOWN', resolved: false },
    });
    expect(risk).not.toBeNull();
    expect(risk!.level).toBe('CRITICAL');

    // 한도 예약은 되돌리지 않는다(출금됐을 수 있다).
    const counter = await prisma.chargeCounter.findFirst({
      where: { payerId: charge.payerId!, periodType: 'DAY', merchantId: 'ALL' },
    });
    expect(counter?.amount).toBe(charge.amount);

    // 결제 실패 문자를 보내면 안 된다(실제로는 출금됐을 수 있다).
    expect(readMockOutbox(20).some((m) => m.template === 'CHARGE_FAILED')).toBe(false);
  });

  it('관리자가 승인으로 확정하면 원장 분개가 생기고 정산 대기로 넘어간다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    setChargeAmount(3_666n);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { chargeId: res.chargeId! } });

    const out = await reconcileUnknownPayment(txn.id, 'APPROVE', 'PG 원장 대조 결과 출금 확인');
    expect(out.ok).toBe(true);

    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: res.chargeId! } });
    expect(charge.status).toBe('SETTLEMENT_PENDING');
    expect(charge.paidAt).not.toBeNull();

    // 승인 확정에는 반드시 원장 분개가 따라와야 한다(없으면 사회복지기관이 영영 못 받는다).
    const gross = await prisma.settlementLedger.count({
      where: { chargeId: charge.id, entryType: 'CHARGE_GROSS' },
    });
    expect(gross).toBe(1);

    const after = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(after.status).toBe('APPROVED');

    // 같은 건을 두 번 확정할 수 없다.
    await expect(reconcileUnknownPayment(txn.id, 'APPROVE', '중복 확정')).rejects.toThrow();
  });

  it('관리자가 취소로 확정하면 한도와 재고를 함께 되돌린다', async () => {
    const { handleMoInbound } = await import('@/server/services/charge-flow');
    const { mockMoAdapter } = await import('@/server/adapters/mo');
    const { confirmChargeAmount } = await import('@/server/services/charge-select');
    const { completePinAuthorization } = await import('@/server/services/pin-authorization');

    await seedRegisteredPayer(fx.payerPhone);
    // 실물 상품(재고 있음)으로 UNKNOWN 을 만든다. 배송지가 필요하므로 직접 호출한다.
    const product = await prisma.chargeProduct.create({
      data: {
        id: newId(), merchantId: fx.merchantId, name: '굿즈', amount: 3_666n,
        kind: 'PHYSICAL', stock: 5, shippingFee: 0n, sortOrder: 9,
      },
    });

    const mo = await handleMoInbound(
      mockMoAdapter.parse(moPayload({ to: fx.moNumber, messageId: `UNK-STOCK-${Date.now()}` })),
    );
    expect(mo.status).toBe('PENDING_AMOUNT');
    const token = lastSelectAmountToken();
    expect(token).toBeTruthy();

    const sel = await confirmChargeAmount({
      token: token!,
      productId: product.id,
      quantity: 1,
      address: {
        receiver: '홍길동', phone: '01012345678', zipCode: '06236',
        address1: '서울시 강남구 테헤란로 1', address2: '101호',
      },
    });
    expect(sel.ok).toBe(true);

    const session = await prisma.paymentPinSession.findUniqueOrThrow({ where: { chargeId: mo.chargeId! } });
    await completePinAuthorization({ sessionId: session.sessionId });

    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { chargeId: mo.chargeId! } });
    expect(txn.status).toBe('UNKNOWN');

    // 재고는 결제 판정 트랜잭션에서 선점된다(승인 요청 전).
    const held = await prisma.chargeProduct.findUniqueOrThrow({ where: { id: product.id } });
    expect(held.stock).toBe(4);

    const out = await reconcileUnknownPayment(txn.id, 'CANCEL', '출금 없음 확인');
    expect(out.ok).toBe(true);

    const restored = await prisma.chargeProduct.findUniqueOrThrow({ where: { id: product.id } });
    expect(restored.stock).toBe(5); // 취소 확정이면 재고도 돌아와야 한다

    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: mo.chargeId! } });
    const counter = await prisma.chargeCounter.findFirst({
      where: { payerId: charge.payerId!, periodType: 'DAY', merchantId: 'ALL' },
    });
    expect(counter?.amount).toBe(0n);
  });
});

// ===========================================================================
// 3. 환불 — 결제사가 취소를 거절한 경우
// ===========================================================================

describe('결제사가 취소를 거절하면 환불을 확정하지 않는다', () => {
  it('원장에 반대분개를 남기지 않고 환불 요청 상태로 되돌린다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    setChargeAmount(3_444n); // 승인은 되지만 취소가 거절되는 금액
    const res = await inbound(moPayload({ to: fx.moNumber }));

    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: res.chargeId! } });
    expect(charge.status).toBe('SETTLEMENT_PENDING');

    const ledgerBefore = await prisma.settlementLedger.count();
    const refund = await requestRefund({ chargeId: charge.id, reason: '테스트 환불' });

    await expect(approveRefund(refund.id)).rejects.toThrow();

    // 돈을 돌려주지 못했으므로 장부를 깎으면 안 된다.
    expect(await prisma.settlementLedger.count()).toBe(ledgerBefore);
    expect(await prisma.settlementLedger.count({ where: { entryType: 'REFUND' } })).toBe(0);

    const after = await prisma.charge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(after.status).not.toBe('REFUNDED');
    expect(after.refundedAt).toBeNull();

    const refundAfter = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(refundAfter.status).not.toBe('DONE');
  });
});

// ===========================================================================
// 4. MT 발송 실패
// ===========================================================================

describe('안내 문자가 실패하면 보낸 것으로 처리하지 않는다', () => {
  it('최초 가입 안내 발송이 실패하면 발송권을 반납해 다음 문자에서 다시 시도한다', async () => {
    setMockMtFailure('[MOCK] 문자 사업자 장애');

    const first = await inbound(moPayload({ to: fx.moNumber, messageId: `MTFAIL-1-${Date.now()}` }));
    expect(first.result).toBe('UNREGISTERED_DONOR');

    const payer = await prisma.payerProfile.findFirstOrThrow();
    // 발송에 실패했으므로 LINK_SENT 로 잠기면 안 된다. 잠기면 이후 모든 문자가
    // "이미 안내함" 으로 끝나 후원자는 영원히 가입 링크를 받지 못한다.
    expect(payer.onboardingStatus).toBe('UNREGISTERED');
    expect(payer.registrationLinkSentAt).toBeNull();

    // 문자 사업자가 복구되면 다음 문자에서 정상 발송된다.
    setMockMtFailure(null);
    await inbound(moPayload({ to: fx.moNumber, messageId: `MTFAIL-2-${Date.now()}` }));
    const again = await prisma.payerProfile.findFirstOrThrow();
    expect(again.onboardingStatus).toBe('LINK_SENT');
    // 발송에 성공한 안내는 정확히 1건이어야 한다(실패 시도도 이력에는 남는다).
    expect(
      await prisma.mtOutboundMessage.count({ where: { templateCode: 'REGISTER_GUIDE', status: 'SENT' } }),
    ).toBe(1);
  });
});
