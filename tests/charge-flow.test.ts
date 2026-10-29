import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { readMockOutbox } from '@/server/adapters/mt';
import { startRegistration, completeRegistration } from '@/server/services/payer-registration';
import { requestRefund, approveRefund } from '@/server/services/refund';
import {
  getSettlementSummary,
  createSettlementRequest,
  markSettlementPaid,
  assertPayable,
} from '@/server/services/settlement';
import { issueSecureLink } from '@/server/services/secure-link';
import { setChargeAmount, inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import { newId } from '@/lib/id';
import { generateToken, tokenHash, phoneHash } from '@/lib/crypto';

let fx: Fixture;

async function inbound(payload: Record<string, unknown>) {
  return inboundAndPay(payload, fx.merchantId);
}

describe('MO 수신 → 결제 → 충전 반영 흐름', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('[1] 미등록 번호의 최초 MO 는 결제되지 않고 계좌 등록 안내만 발송한다', async () => {
    const res = await inbound(moPayload({ to: fx.moNumber, text: '첫 결제입니다' }));

    expect(res.result).toBe('UNREGISTERED_DONOR');
    expect(await prisma.charge.count()).toBe(0);
    expect(await prisma.paymentTransaction.count()).toBe(0);

    const mt = readMockOutbox(1)[0];
    expect(mt.text).toContain('아직 후원되지 않았습니다');

    const link = await prisma.secureLink.findFirst({ where: { purpose: 'REGISTER_ACCOUNT' } });
    expect(link).not.toBeNull();
  });

  it('[2] 만료된 등록 링크는 사용할 수 없다', async () => {
    await inbound(moPayload({ to: fx.moNumber }));
    const link = await prisma.secureLink.findFirstOrThrow({ where: { purpose: 'REGISTER_ACCOUNT' } });
    await prisma.secureLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    // 실제 토큰 원문은 알 수 없으므로 새 토큰으로 만료 링크를 재현한다
    const raw = generateToken(16);
    await prisma.secureLink.update({ where: { id: link.id }, data: { tokenHash: tokenHash(raw) } });

    await expect(startRegistration({ token: raw, consents: [] })).rejects.toThrow(/만료/);
  });

  it('[3] 계좌 등록: 필수 동의 누락은 실패하고, 동의 후에는 빌키가 저장된다', async () => {
    await inbound(moPayload({ to: fx.moNumber }));
    const payer = await prisma.payerProfile.findFirstOrThrow();

    const raw = generateToken(16);
    const link = await prisma.secureLink.findFirstOrThrow({ where: { purpose: 'REGISTER_ACCOUNT' } });
    await prisma.secureLink.update({ where: { id: link.id }, data: { tokenHash: tokenHash(raw) } });

    await expect(startRegistration({ token: raw, consents: [] })).rejects.toThrow(/필수 동의/);

    const consents = (['TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM'] as const).map(
      (type) => ({ type, agreed: true }),
    );
    const started = await startRegistration({ token: raw, consents });
    expect(started.redirectUrl).toContain('/mock/pg/register');

    const done = await completeRegistration({
      token: raw,
      registrationId: started.registrationId,
      providerPayload: { tid: 'MOCKREG1', bankCode: '004', bankName: 'KB국민은행', account: '11122233344455' },
    });
    expect(done.accountTail4).toBe('4455');

    const token = await prisma.paymentMethodToken.findFirstOrThrow({ where: { payerId: payer.id } });
    expect(token.status).toBe('ACTIVE');
    // 계좌 원문은 저장하지 않는다
    expect(JSON.stringify(token)).not.toContain('11122233344455');

    // 1회용 링크는 재사용 불가
    await expect(
      completeRegistration({ token: raw, registrationId: started.registrationId, providerPayload: {} }),
    ).rejects.toThrow();
  });

  it('[4] 등록 사용자의 MO 는 결제 거래를 생성하고 결제 후 충전으로 반영된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const res = await inbound(moPayload({ to: fx.moNumber, text: '캐시 충전합니다!' }));

    expect(res.result).toBe('ROUTED');
    const charge = await prisma.charge.findFirstOrThrow({ where: { id: res.chargeId } });
    expect(charge.amount).toBe(3000n);
    // 방송 단계가 사라져 결제 성공 건은 곧바로 정산 대기로 넘어간다.
    expect(['SETTLEMENT_PENDING', 'PAYMENT_SUCCESS']).toContain(charge.status);
    expect(charge.paidAt).not.toBeNull();

    // 수수료와 정산 원장
    expect(charge.pgFee).toBe(54n); // 3000 * 1.8%
    expect(charge.platformFee).toBe(450n); // 3000 * 15%
    const summary = await getSettlementSummary(fx.merchantId);
    expect(summary.totalGross).toBe(3000n);
    expect(summary.balance).toBe(2496n);

    const success = readMockOutbox(10).find((m) => m.text.includes('후원이 완료되었습니다'));
    expect(success).toBeDefined();
  });

  it('[4-1] 본문에 "N원" 표기가 있어도 사회복지기관 고정 금액으로만 결제된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const res = await inbound(moPayload({ to: fx.moNumber, text: '10000원 화이팅' }));

    expect(res.result).toBe('ROUTED');
    const charge = await prisma.charge.findFirstOrThrow({ where: { id: res.chargeId } });
    // 파싱된 10000원이 아니라 사회복지기관이 설정한 3000원이 청구된다.
    expect(charge.amount).toBe(3000n);
    // 금액 표기를 잘라내지 않고 본문 전체를 결제 메시지로 사용한다.
    expect(charge.message).toBe('10000원 화이팅');
    expect(charge.paidAt).not.toBeNull();

    const tx = await prisma.paymentTransaction.findFirstOrThrow({ where: { chargeId: charge.id } });
    expect(tx.amount).toBe(3000n);
  });

  it('[4-2] 금액 표기가 없는 일반 문자도 같은 고정 금액으로 결제된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const res = await inbound(moPayload({ to: fx.moNumber, text: '오늘도 응원합니다' }));

    const charge = await prisma.charge.findFirstOrThrow({ where: { id: res.chargeId } });
    expect(charge.amount).toBe(3000n);
    expect(charge.message).toBe('오늘도 응원합니다');
  });

  it('[4-3] 사회복지기관이 고정 금액을 바꾸면 바뀐 금액으로 결제된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    setChargeAmount(5000n);

    const res = await inbound(moPayload({ to: fx.moNumber, text: '1,000원 응원' }));
    const charge = await prisma.charge.findFirstOrThrow({ where: { id: res.chargeId } });
    expect(charge.amount).toBe(5000n);
  });

  it('[5] 동일 MO Webhook 이 재전송되어도 결제가 중복되지 않는다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const payload = moPayload({ to: fx.moNumber, messageId: 'MO-DUP-001' });

    const first = await inbound(payload);
    const second = await inbound(payload);
    const third = await inbound(payload);

    expect(first.result).toBe('ROUTED');
    expect(second.result).toBe('DUPLICATE');
    expect(third.result).toBe('DUPLICATE');

    expect(await prisma.charge.count()).toBe(1);
    expect(await prisma.paymentTransaction.count({ where: { status: 'APPROVED' } })).toBe(1);
    expect(await prisma.moInboundMessage.count()).toBe(1);
  });

  it('[6] 짧은 시간 연속 결제은 속도 제한에 걸린다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await inbound(moPayload({ to: fx.moNumber, text: `연속 ${i}` })));
    }
    const blocked = results.filter((r) => r.status === 'LIMIT_BLOCKED');
    expect(blocked.length).toBeGreaterThan(0);

    const approved = await prisma.paymentTransaction.count({ where: { status: 'APPROVED' } });
    expect(approved).toBeLessThanOrEqual(3);
  });

  it('[7] 일일 한도를 초과하면 결제하지 않고 선택 화면에서 알려 준다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await prisma.payerProfile.update({ where: { id: payer.id }, data: { dailyLimit: 2000n } });

    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.status).toBe('LIMIT_BLOCKED');
    expect(await prisma.paymentTransaction.count()).toBe(0);

    // 한도는 금액을 고르는 화면에서 즉시 알려 주므로 안내 문자를 따로 보내지 않는다.
    expect(res.message).toContain('한도');
  });

  it('[8] 결제 API 타임아웃 시 거래결과조회로 최종 상태를 확정한다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    // 금액 끝 888 → 타임아웃 후 조회 시 승인 확정
    setChargeAmount(3888n);

    const res = await inbound(moPayload({ to: fx.moNumber }));
    const charge = await prisma.charge.findFirstOrThrow({ where: { id: res.chargeId } });
    expect(charge.paidAt).not.toBeNull();

    const attempts = await prisma.paymentAttempt.findMany({ where: {}, orderBy: { attemptNo: 'asc' } });
    expect(attempts.map((a) => a.operation)).toContain('INQUIRE');

    // 끝 777 → 타임아웃 후 조회 시 실패 확정
    setChargeAmount(3777n);
    const res2 = await inbound(moPayload({ to: fx.moNumber, messageId: 'MO-TIMEOUT-777' }));
    const d2 = await prisma.charge.findFirstOrThrow({ where: { id: res2.chargeId } });
    expect(d2.status).toBe('PAYMENT_FAILED');
  });

  it('[9] 결제 실패 시 충전이 반영되지 않고 실패 안내가 발송된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    setChargeAmount(2999n);

    const res = await inbound(moPayload({ to: fx.moNumber }));
    const charge = await prisma.charge.findFirstOrThrow({ where: { id: res.chargeId } });

    expect(charge.status).toBe('PAYMENT_FAILED');

    const mt = readMockOutbox(5).find((m) => m.text.includes('완료되지 않았습니다'));
    expect(mt).toBeDefined();
  });

  it('[12] 금칙어가 포함돼도 결제는 진행되고 기록만 마스킹된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    // 지난 정책의 BLOCK 규칙이 남아 있어도 결제를 막지 않는다.
    await prisma.bannedWord.create({ data: { id: newId(), word: '도박', action: 'BLOCK', scope: 'GLOBAL' } });

    const res = await inbound(moPayload({ to: fx.moNumber, text: '도박 사이트 추천' }));
    expect(res.status).not.toBe('CONTENT_BLOCKED');

    const d = await prisma.charge.findUniqueOrThrow({ where: { id: res.chargeId! } });
    expect(d.message).not.toContain('도박');
    expect(d.message).toContain('**');
  });

  it('[13] 개인정보가 포함된 문자는 마스킹되어 기록된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const res = await inbound(
      moPayload({ to: fx.moNumber, text: '연락주세요 010-9876-5432 abc@test.com' }),
    );
    const charge = await prisma.charge.findFirstOrThrow({ where: { id: res.chargeId } });
    expect(charge.message).not.toContain('010-9876-5432');
    expect(charge.message).not.toContain('abc@test.com');
    expect(charge.messageRawEnc).not.toBeNull();
  });

  it('[14] 사회복지기관이 차단한 후원자는 결제되지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await prisma.blockedPayer.create({
      data: { id: newId(), merchantId: fx.merchantId, payerId: payer.id, reason: '테스트 차단' },
    });

    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.status).toBe('LIMIT_BLOCKED');
    expect(await prisma.paymentTransaction.count()).toBe(0);
  });

  it('[15] 환불하면 정산 원장에 반대 분개가 쌓이고 잔액이 차감된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const before = await getSettlementSummary(fx.merchantId);
    expect(before.balance).toBe(2496n);

    const refund = await requestRefund({ chargeId: res.chargeId!, reason: '고객 요청' });
    await approveRefund(refund.id, 'admin-test');

    const after = await getSettlementSummary(fx.merchantId);
    // 총액 -3000, 플랫폼수수료 환입 +450 → 2496 - 3000 + 450 = -54 (PG 수수료는 환입되지 않음)
    expect(after.balance).toBe(-54n);

    const charge = await prisma.charge.findFirstOrThrow({ where: { id: res.chargeId } });
    expect(charge.status).toBe('REFUNDED');

    // 원장은 수정되지 않고 분개만 추가된다
    const entries = await prisma.settlementLedger.findMany({ where: { merchantId: fx.merchantId } });
    expect(entries.length).toBe(5);
  });

  it('[16] 정산 원장은 UPDATE/DELETE 가 불가능하다 (append-only)', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await inbound(moPayload({ to: fx.moNumber }));
    const entry = await prisma.settlementLedger.findFirstOrThrow();

    await expect(
      prisma.settlementLedger.update({ where: { id: entry.id }, data: { amount: 1n } }),
    ).rejects.toThrow();
    await expect(prisma.settlementLedger.delete({ where: { id: entry.id } })).rejects.toThrow();
  });

  it('[17] 정산 요청은 가능 금액을 초과할 수 없고, 지급 시 원장에 반영된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await inbound(moPayload({ to: fx.moNumber }));

    await expect(createSettlementRequest(fx.merchantId, 999999n)).rejects.toThrow(/초과/);

    const req = await createSettlementRequest(fx.merchantId, 2000n);
    // 소액부징수: 소득세 2,000 × 3% = 60원 < 1,000원 이므로 원천징수하지 않는다.
    expect(req.withholding).toBe(0n);
    expect(req.incomeTax).toBe(0n);
    expect(req.payoutAmount).toBe(2000n);

    const afterRequest = await getSettlementSummary(fx.merchantId);
    expect(afterRequest.pending).toBe(2000n);
    expect(afterRequest.available).toBe(496n);

    // 승인(APPROVED) 을 거치지 않은 요청은 지급할 수 없다.
    await expect(markSettlementPaid(req.id, 'admin-test')).rejects.toThrow(/APPROVED/);

    await prisma.settlementRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });

    // 계좌 인증 해제는 **이체 전** 사전검증(assertPayable)에서 걸러야 한다.
    // markSettlementPaid 는 이미 돈이 나간 뒤에 불리므로, 여기서 막으면(throw)
    // 원장에 지급 분개가 남지 않아 잔액이 그대로 남고 재신청 시 이중 지급이 된다.
    await prisma.settlementAccount.update({ where: { merchantId: fx.merchantId }, data: { verified: false } });
    const notPayable = await assertPayable(req.id);
    expect(notPayable.ok).toBe(false);
    await prisma.settlementAccount.update({ where: { merchantId: fx.merchantId }, data: { verified: true } });
    expect((await assertPayable(req.id)).ok).toBe(true);

    await markSettlementPaid(req.id, 'admin-test');
    const afterPaid = await getSettlementSummary(fx.merchantId);
    expect(afterPaid.balance).toBe(496n);
  });

  it('[18] 알 수 없는 수신번호는 결제하지 않고 안내한다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const res = await inbound(moPayload({ to: '15889999' }));
    expect(res.result).toBe('UNKNOWN_ROUTE');
    expect(await prisma.charge.count()).toBe(0);
    const mt = readMockOutbox(3).find((m) => m.text.includes('찾을 수 없습니다'));
    expect(mt).toBeDefined();
  });

  it('[19] 결제 실패가 반복되면 후원자가 잠긴다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    setChargeAmount(2999n);
    await prisma.chargeLimitPolicy.updateMany({ data: { velocityMaxCount: 100, cooldownAfterCount: 100 } });

    for (let i = 0; i < 3; i += 1) {
      await inbound(moPayload({ to: fx.moNumber, text: `실패 ${i}` }));
    }
    const payer = await prisma.payerProfile.findFirstOrThrow();
    expect(payer.failCount).toBeGreaterThanOrEqual(3);
    expect(payer.lockedUntil).not.toBeNull();

    const res = await inbound(moPayload({ to: fx.moNumber, text: '잠금 확인' }));
    expect(res.status).toBe('LIMIT_BLOCKED');
  });

});


describe('대표번호 + 키워드 라우팅', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
    await prisma.merchantMoNumber.create({
      data: {
        id: newId(), phoneNumber: '15889000', keyword: 'MSG3QP7', mode: 'SHARED_PREFIX',
        status: 'ASSIGNED', merchantId: fx.merchantId, providerId: 'mock', assignedAt: new Date(),
      },
    });
  });

  it('키워드로 사회복지기관을 식별하고 키워드는 메시지에서 제거된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const res = await inbound(moPayload({ to: '15889000', text: 'MSG3QP7 응원합니다' }));

    expect(res.result).toBe('ROUTED');
    const charge = await prisma.charge.findFirstOrThrow({ where: { id: res.chargeId } });
    expect(charge.message).toBe('응원합니다');
    expect(charge.merchantId).toBe(fx.merchantId);
  });

  it('키워드가 없으면 라우팅되지 않는다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const res = await inbound(moPayload({ to: '15889000', text: '응원합니다' }));
    expect(res.result).toBe('UNKNOWN_ROUTE');
  });
});

describe('보안 링크', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  it('토큰 원문은 저장되지 않고 해시로만 조회된다', async () => {
    const issued = await issueSecureLink({
      purpose: 'REGISTER_ACCOUNT',
      phoneHash: phoneHash('01012345678'),
      merchantId: fx.merchantId,
    });
    const row = await prisma.secureLink.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.tokenHash).not.toBe(issued.token);
    expect(row.tokenHash).toBe(tokenHash(issued.token));
  });
});
