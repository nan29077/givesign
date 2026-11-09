import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/uploads', () => ({ newObjectName: (ext: string) => `test.${ext}`, putObject: vi.fn(async (name: string) => `/uploads/${name}`) }));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, maskPhone, phoneHash, tokenHash } from '@/lib/crypto';
import { contractBootProblems } from '@/lib/env';
import { AdapterNotConfiguredError } from '@/server/adapters/types';
import { getIdentityAdapter } from '@/server/adapters/identity';
import { mockTimestampAdapter } from '@/server/adapters/timestamp';
import { setMockBankFeedFixture } from '@/server/adapters/bank-feed';
import { readMockOutbox } from '@/server/adapters/mt';
import { inboundAndPay, lastSelectAmountToken, moPayload, resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';
import { handleMoInbound, executePayment } from '@/server/services/charge-flow';
import { mockMoAdapter } from '@/server/adapters/mo';
import { confirmChargeAmount } from '@/server/services/charge-select';
import { completeCardCheckout, expireStaleCardSessions, cardOptionAvailable } from '@/server/services/card-payment';
import { calculateFees } from '@/server/services/settlement';
import { calculateCardFees } from '@/server/services/card-fees';
import { createWebCharge } from '@/server/services/web-charge';
import { approveRefund, requestRefund } from '@/server/services/refund';
import { reconcileUnknownPayment } from '@/server/services/payment-reconcile';
import { quickRepeatFor } from '@/server/services/quick-repeat';
import { loadSelectAmountContext } from '@/server/services/charge-select';
import {
  assertIdentityForRecurring,
  completeIdentityVerification,
  identityForSigner,
  IdentityRequiredError,
  receiptIdentityCheck,
  residentBirthDate,
  safeReturnPath,
  startIdentityVerification,
} from '@/server/services/identity';
import { upsertReceiptProfile } from '@/server/services/receipts';
import { accessProof, createEnvelope, signAsSigner, verifyEnvelopeChain } from '@/server/services/edoc';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { syncBankFeeds } from '@/server/services/bank-feed';
import { importBankStatement } from '@/server/services/deposits';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 2026-11-13 5차 L — 계약이 필요한 연동(어댑터 + mock): 본인인증·시점확인·카드 일시후원·계좌 자동 조회.
 * mock 이 성공을 꾸미지 않음 · 운영 부팅 점검 · 플래그 꺼짐 시 기존 흐름 무변화 · 카드 멱등·결과 미확인·환불.
 */

let fx: Fixture;
const ENV_KEYS = ['IDENTITY_PROVIDER', 'IDENTITY_REQUIRED_FOR_RECEIPT', 'IDENTITY_REQUIRED_FOR_ESIGN', 'IDENTITY_REQUIRED_FOR_RECURRING', 'TIMESTAMP_PROVIDER', 'CARD_PAYMENT_ENABLED', 'CARD_PROVIDER', 'BANK_FEED_ENABLED', 'BANK_FEED_PROVIDER', 'MO_QUICK_REPEAT_ENABLED'];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  await resetDb();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  registerDefaultConsumers();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function cardPolicy(rate = '0.033') {
  await prisma.cardFeePolicy.create({ data: { id: newId(), scope: 'GLOBAL', pgFeeRate: rate, platformFeeRate: '0.15', vatIncluded: true, effectiveFrom: new Date(Date.now() - 1000) } });
}

/** MO → 금액 선택 화면에서 카드로 후원 */
async function moCard(amount: bigint, messageId = `MO-CARD-${newId()}`) {
  const mo = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, messageId })));
  const token = lastSelectAmountToken()!;
  const r = await confirmChargeAmount({ token, customAmount: amount, method: 'CARD' });
  return { mo, token, r };
}

async function allowCustom() {
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { allowCustomAmount: true } });
}

describe('운영 부팅 점검 · 실연동 자리', () => {
  it('기본(모두 꺼짐·mock)은 문제 없음, 켰는데 mock 이거나 구현 안 된 공급자면 부팅 거부 사유', () => {
    expect(contractBootProblems()).toEqual([]);
    process.env.IDENTITY_REQUIRED_FOR_ESIGN = 'true';
    process.env.CARD_PAYMENT_ENABLED = 'true';
    process.env.BANK_FEED_ENABLED = 'true';
    const p = contractBootProblems();
    expect(p.some((x) => x.includes('IDENTITY_PROVIDER 가 mock'))).toBe(true);
    expect(p.some((x) => x.includes('CARD_PROVIDER 가 mock'))).toBe(true);
    expect(p.some((x) => x.includes('BANK_FEED_PROVIDER 가 mock'))).toBe(true);
    process.env.IDENTITY_PROVIDER = 'pass';
    process.env.CARD_PROVIDER = 'tosspay';
    process.env.TIMESTAMP_PROVIDER = 'kisa';
    const q = contractBootProblems();
    expect(q.some((x) => x.includes('IDENTITY_PROVIDER=pass') && x.includes('규격 수령 후'))).toBe(true);
    expect(q.some((x) => x.includes('CARD_PROVIDER=tosspay'))).toBe(true);
    expect(q.some((x) => x.includes('TIMESTAMP_PROVIDER=kisa'))).toBe(true);
  });

  it('실연동 자리는 지어낸 API 를 부르지 않고 설정 오류로 막는다', async () => {
    process.env.IDENTITY_PROVIDER = 'nice';
    await expect(getIdentityAdapter().start({ requestToken: 'x', returnUrl: '/' })).rejects.toBeInstanceOf(AdapterNotConfiguredError);
  });

  it('시점확인 mock 은 토큰을 만들지 않고 "시점확인 미연동"', async () => {
    const r = await mockTimestampAdapter.stamp('a'.repeat(64));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_CONNECTED');
    expect(r.data).toBeUndefined();
  });
});

describe('카드 일시후원 — 꺼짐이면 기존 흐름 무변화', () => {
  it('꺼짐: 카드 선택 거절(링크는 쓰지 않아 계좌 결제로 이어 갈 수 있음), 계좌 결제는 예전과 같은 원장·공급자', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await allowCustom();
    expect(await cardOptionAvailable(fx.merchantId)).toBe(false);
    const { mo, token, r } = await moCard(5000n);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('카드로 후원할 수 없습니다');
    // 같은 링크로 계좌(PIN) 결제가 그대로 된다
    const ok = await confirmChargeAmount({ token, customAmount: 5000n });
    expect(ok.ok).toBe(true);
    const c = await prisma.charge.findUniqueOrThrow({ where: { id: mo.chargeId! } });
    expect(c.paymentMethod).toBeNull();
    expect(c.status).toBe('PENDING_PIN');
    expect(await prisma.cardCheckoutSession.count()).toBe(0);
  });

  it('회귀: 꺼짐에서 MO 계좌 결제 한 건의 결과(상태·거래 공급자·수수료·원장)가 예전 계산과 같다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const paid = await inboundAndPay(moPayload({ to: fx.moNumber, messageId: 'MO-L-REG-1' }), fx.merchantId);
    expect(paid.status).toBe('SETTLEMENT_PENDING');
    const c = await prisma.charge.findUniqueOrThrow({ where: { id: paid.chargeId! } });
    const fees = await calculateFees(fx.merchantId, c.amount);
    expect(c.paymentMethod).toBeNull();
    expect(c.pgFee).toBe(fees.pgFee);
    expect(c.platformFee).toBe(fees.platformFee);
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { chargeId: c.id } });
    expect(txn.provider).toBe('mock');
    const ledger = await prisma.settlementLedger.findMany({ where: { chargeId: c.id } });
    expect(ledger.reduce((a, l) => a + l.amount, 0n)).toBe(fees.net);
  });
});

describe('카드 일시후원 — 켜짐(mock)', () => {
  beforeEach(async () => {
    process.env.CARD_PAYMENT_ENABLED = 'true';
    await seedRegisteredPayer(fx.payerPhone);
    await allowCustom();
  });

  it('카드 수수료 정책이 없으면 선택지가 없다', async () => {
    expect(await cardOptionAvailable(fx.merchantId)).toBe(false);
    await cardPolicy();
    expect(await cardOptionAvailable(fx.merchantId)).toBe(true);
  });

  it('MO 확인 화면에서 카드 → 모의 결제창 → 승인: 카드 수수료·정산 원장·charge.paid·단계 PAID, 거래 공급자 card:mock', async () => {
    await cardPolicy('0.033');
    const { mo, r } = await moCard(10000n);
    expect(r.ok).toBe(true);
    expect(r.mock).toBe(true);
    expect(r.pinUrl).toContain('/mock/pg/card?session=');
    const c0 = await prisma.charge.findUniqueOrThrow({ where: { id: mo.chargeId! } });
    expect(c0.paymentMethod).toBe('CARD');
    expect(c0.status).toBe('PENDING_PIN');
    const session = await prisma.cardCheckoutSession.findUniqueOrThrow({ where: { chargeId: c0.id } });
    const done = await completeCardCheckout({ sessionId: session.sessionId });
    expect(done.ok).toBe(true);
    const c = await prisma.charge.findUniqueOrThrow({ where: { id: c0.id } });
    expect(c.status).toBe('SETTLEMENT_PENDING');
    const cardFees = await calculateCardFees(fx.merchantId, 10000n);
    const acctFees = await calculateFees(fx.merchantId, 10000n);
    expect(c.pgFee).toBe(cardFees.pgFee);
    expect(c.pgFee).not.toBe(acctFees.pgFee);
    const txns = await prisma.paymentTransaction.findMany({ where: { chargeId: c.id } });
    expect(txns).toHaveLength(1);
    expect(txns[0]!.provider).toBe('card:mock');
    const ledger = await prisma.settlementLedger.findMany({ where: { chargeId: c.id } });
    expect(ledger.reduce((a, l) => a + l.amount, 0n)).toBe(cardFees.net);
    expect(await prisma.domainEvent.count({ where: { type: 'charge.paid', subjectId: c.id } })).toBe(1);
    expect(await prisma.funnelStep.count({ where: { step: 'PAID', chargeId: c.id } })).toBe(1);
  });

  it('멱등: 같은 결제창 완료가 동시에·여러 번 와도 승인·원장은 한 번', async () => {
    await cardPolicy();
    const { mo } = await moCard(7000n);
    const s = await prisma.cardCheckoutSession.findUniqueOrThrow({ where: { chargeId: mo.chargeId! } });
    const rs = await Promise.all([completeCardCheckout({ sessionId: s.sessionId }), completeCardCheckout({ sessionId: s.sessionId }), completeCardCheckout({ sessionId: s.sessionId })]);
    expect(rs.filter((x) => x.code === 'OK')).toHaveLength(1);
    expect(await prisma.paymentTransaction.count({ where: { chargeId: mo.chargeId! } })).toBe(1);
    expect(await prisma.settlementLedger.count({ where: { chargeId: mo.chargeId!, entryType: 'CHARGE_GROSS' } })).toBe(1);
    expect((await completeCardCheckout({ sessionId: s.sessionId })).code).toBe('DUPLICATE');
    // 같은 결제 건으로 결제창을 두 번 열 수 없다(세션 1건)
    expect(await prisma.cardCheckoutSession.count({ where: { chargeId: mo.chargeId! } })).toBe(1);
  });

  it('카드 결제 건은 계좌 빌키 경로(executePayment 단독 호출)로 승인되지 않는다', async () => {
    await cardPolicy();
    const { mo } = await moCard(6000n);
    const r = await executePayment(mo.chargeId!);
    expect(r.ok).toBe(false);
    expect(await prisma.paymentTransaction.count({ where: { chargeId: mo.chargeId! } })).toBe(0);
  });

  it('거절(999)은 출금 없는 실패, 지연 후 승인(888)은 조회로 승인', async () => {
    await cardPolicy();
    const a = await moCard(5999n);
    const sa = await prisma.cardCheckoutSession.findUniqueOrThrow({ where: { chargeId: a.mo.chargeId! } });
    expect((await completeCardCheckout({ sessionId: sa.sessionId })).ok).toBe(false);
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: a.mo.chargeId! } })).status).toBe('PAYMENT_FAILED');
    expect(await prisma.settlementLedger.count({ where: { chargeId: a.mo.chargeId! } })).toBe(0);

    const b = await moCard(5888n);
    const sb = await prisma.cardCheckoutSession.findUniqueOrThrow({ where: { chargeId: b.mo.chargeId! } });
    expect((await completeCardCheckout({ sessionId: sb.sessionId })).ok).toBe(true);
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: b.mo.chargeId! } })).status).toBe('SETTLEMENT_PENDING');
  });

  it('결과 미확인(666)은 실패로 닫지 않고 UNKNOWN 대사 큐 → 관리자 확정은 카드 수수료로 원장', async () => {
    await cardPolicy('0.03');
    const { mo } = await moCard(5666n);
    const s = await prisma.cardCheckoutSession.findUniqueOrThrow({ where: { chargeId: mo.chargeId! } });
    const r = await completeCardCheckout({ sessionId: s.sessionId });
    expect(r.ok).toBe(false);
    const c = await prisma.charge.findUniqueOrThrow({ where: { id: mo.chargeId! } });
    expect(c.status).toBe('PENDING_PAYMENT');
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { chargeId: c.id } });
    expect(txn.status).toBe('UNKNOWN');
    expect(await prisma.riskDetection.count({ where: { chargeId: c.id, type: 'PAYMENT_UNKNOWN' } })).toBe(1);
    // 다시 완료를 눌러도 승인을 또 부르지 않는다
    expect((await completeCardCheckout({ sessionId: s.sessionId })).code).toBe('DUPLICATE');
    await reconcileUnknownPayment(txn.id, 'APPROVE', '카드사 원장 확인');
    const after = await prisma.charge.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.pgFee).toBe((await calculateCardFees(fx.merchantId, 5666n)).pgFee);
  });

  it('환불(카드 취소)은 카드 어댑터로 — 원장은 반대분개, 취소 거절(444)은 FAILED 로 남고 원장 그대로', async () => {
    await cardPolicy();
    const { mo } = await moCard(8000n);
    const s = await prisma.cardCheckoutSession.findUniqueOrThrow({ where: { chargeId: mo.chargeId! } });
    await completeCardCheckout({ sessionId: s.sessionId });
    const ref = await requestRefund({ chargeId: mo.chargeId!, reason: '테스트' });
    await approveRefund(ref.id, 'admin');
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: mo.chargeId! } })).status).toBe('REFUNDED');
    expect(await prisma.settlementLedger.count({ where: { chargeId: mo.chargeId!, entryType: 'REFUND' } })).toBe(1);

    const b = await moCard(8444n);
    const sb = await prisma.cardCheckoutSession.findUniqueOrThrow({ where: { chargeId: b.mo.chargeId! } });
    await completeCardCheckout({ sessionId: sb.sessionId });
    const rb = await requestRefund({ chargeId: b.mo.chargeId!, reason: '테스트' });
    await expect(approveRefund(rb.id, 'admin')).rejects.toThrow();
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: rb.id } })).status).toBe('FAILED');
    expect(await prisma.settlementLedger.count({ where: { chargeId: b.mo.chargeId!, entryType: 'REFUND' } })).toBe(0);
  });

  it('결제창 취소·시간 초과는 출금 없는 실패', async () => {
    await cardPolicy();
    const a = await moCard(4000n);
    const sa = await prisma.cardCheckoutSession.findUniqueOrThrow({ where: { chargeId: a.mo.chargeId! } });
    expect((await completeCardCheckout({ sessionId: sa.sessionId, cancel: true })).code).toBe('CANCELED');
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: a.mo.chargeId! } })).status).toBe('PAYMENT_FAILED');

    const b = await moCard(4500n);
    await prisma.cardCheckoutSession.updateMany({ where: { chargeId: b.mo.chargeId! }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await expireStaleCardSessions()).toBe(1);
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: b.mo.chargeId! } })).status).toBe('PAYMENT_FAILED');
    expect(await prisma.paymentTransaction.count({ where: { chargeId: b.mo.chargeId! } })).toBe(0);
  });

  it('웹 후원 카드: 내통장결제 등록이 없어도 그 번호로 카드 결제 링크 문자(번호 주인만 결제)', async () => {
    await cardPolicy();
    const phone = '01077778888';
    await prisma.payerProfile.create({ data: { id: newId(), phoneHash: phoneHash(phone), phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone) } });
    const r = await createWebCharge({ phoneHash: phoneHash(phone), merchantId: fx.merchantId, amount: 9000n, message: '응원', requestId: 'req-web-card-1', paymentMethod: 'CARD' });
    expect(r.ok).toBe(true);
    expect(r.pinMock).toBe(true);
    const sms = readMockOutbox(5).find((m) => m.template === 'CARD_PAYMENT_LINK');
    expect(sms?.text).toContain('카드 결제 링크');
    // 계좌 경로는 그대로 등록을 요구한다
    const acct = await createWebCharge({ phoneHash: phoneHash(phone), merchantId: fx.merchantId, amount: 9000n, message: '응원', requestId: 'req-web-acct-1' });
    expect(acct.ok).toBe(false);
  });
});

describe('지난번 방법으로 후원(M5) — 화면 단계만', () => {
  it('꺼짐이면 없음, 켜면 지난 후원 금액을 미리 고른다(PIN 은 그대로)', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, messageId: 'MO-QR-1' }), fx.merchantId);
    await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, messageId: 'MO-QR-2' })));
    const ctx = await loadSelectAmountContext(lastSelectAmountToken()!);
    if (!ctx.ok) throw new Error(ctx.reason);
    expect(await quickRepeatFor(ctx.ctx)).toBeNull();
    process.env.MO_QUICK_REPEAT_ENABLED = 'true';
    const q = await quickRepeatFor(ctx.ctx);
    expect(q).not.toBeNull();
    expect(q!.amount).toBe('3000');
    const r = await confirmChargeAmount({ token: lastSelectAmountToken()!, productId: q!.productId, customAmount: q!.productId ? null : BigInt(q!.amount) });
    expect(r.ok).toBe(true);
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: ctx.ctx.chargeId } })).status).toBe('PENDING_PIN');
  });
});

describe('본인인증', () => {
  const name = '홍길동';
  const resident = '9001011234568';

  async function verify(purpose: 'RECEIPT' | 'ESIGN' | 'RECURRING', who: { name: string; birthDate: string; phone: string }) {
    const s = await startIdentityVerification({ purpose, returnPath: '/my/receipts' });
    const req = new URL(s.redirectUrl, 'http://x').searchParams.get('req')!;
    return completeIdentityVerification({ requestToken: req, payload: who });
  }

  it('보조: 생년월일·돌아갈 경로', () => {
    expect(residentBirthDate('9001011234567')).toBe('19900101');
    expect(residentBirthDate('0503034234567')).toBe('20050303');
    expect(residentBirthDate('123')).toBeNull();
    expect(safeReturnPath('//evil.com')).toBe('/');
    expect(safeReturnPath('https://evil.com')).toBe('/');
    expect(safeReturnPath('/my/receipts')).toBe('/my/receipts');
  });

  it('꺼짐: 영수증 정보 등록·정기 해지·서명자 확인이 예전 그대로(DB 조회 없음)', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    expect(await receiptIdentityCheck(payer.phoneHash, name, resident)).toEqual({ ok: true });
    await expect(assertIdentityForRecurring(payer.id)).resolves.toBeUndefined();
    expect(await identityForSigner({ phoneHash: payer.phoneHash, name })).toBeNull();
    await prisma.termsVersion.create({ data: { id: newId(), type: 'RECEIPT_ISSUANCE', version: '1.0', title: '영수증', content: 'x', required: true, effectiveFrom: new Date('2026-01-01') } });
    expect((await upsertReceiptProfile(payer.id, { legalName: name, residentNo: resident, hometaxOptIn: true })).ok).toBe(true);
  });

  it('영수증 켜짐: 인증 없으면 거절, 인증한 이름·생년월일이 다르면 거절, 같으면 저장 — 원문 저장 안 함', async () => {
    process.env.IDENTITY_REQUIRED_FOR_RECEIPT = 'true';
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await prisma.termsVersion.create({ data: { id: newId(), type: 'RECEIPT_ISSUANCE', version: '1.0', title: '영수증', content: 'x', required: true, effectiveFrom: new Date('2026-01-01') } });
    const r0 = await upsertReceiptProfile(payer.id, { legalName: name, residentNo: resident, hometaxOptIn: true });
    expect(r0.ok).toBe(false);
    expect((await verify('RECEIPT', { name: '김철수', birthDate: '19900101', phone: fx.payerPhone })).ok).toBe(true);
    const r1 = await upsertReceiptProfile(payer.id, { legalName: name, residentNo: resident, hometaxOptIn: true });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.message).toContain('이름');
    await verify('RECEIPT', { name, birthDate: '19910101', phone: fx.payerPhone });
    const r2 = await upsertReceiptProfile(payer.id, { legalName: name, residentNo: resident, hometaxOptIn: true });
    expect(r2.ok).toBe(false);
    await verify('RECEIPT', { name, birthDate: '19900101', phone: fx.payerPhone });
    expect((await upsertReceiptProfile(payer.id, { legalName: name, residentNo: resident, hometaxOptIn: true })).ok).toBe(true);
    // 다른 번호로 한 인증은 쓰이지 않는다
    const rows = await prisma.identityVerification.findMany();
    expect(rows.every((x) => x.mock)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(name);
    expect(JSON.stringify(rows)).not.toContain('19900101');
    expect(JSON.stringify(rows)).not.toContain(fx.payerPhone);
  });

  it('정기후원 해지·변경 켜짐: 그 번호 인증이 10분 안에 있어야 한다', async () => {
    process.env.IDENTITY_REQUIRED_FOR_RECURRING = 'true';
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await expect(assertIdentityForRecurring(payer.id)).rejects.toBeInstanceOf(IdentityRequiredError);
    await verify('RECURRING', { name, birthDate: '19900101', phone: '01099990000' });
    await expect(assertIdentityForRecurring(payer.id)).rejects.toBeInstanceOf(IdentityRequiredError);
    await verify('RECURRING', { name, birthDate: '19900101', phone: fx.payerPhone });
    await expect(assertIdentityForRecurring(payer.id)).resolves.toBeUndefined();
    await expect(assertIdentityForRecurring(payer.id, new Date(Date.now() + 11 * 60_000))).rejects.toBeInstanceOf(IdentityRequiredError);
  });

  it('같은 요청으로 두 번 완료해도 한 번만 반영, 취소·잘못된 값은 실패', async () => {
    const s = await startIdentityVerification({ purpose: 'ESIGN', returnPath: '/sign/x' });
    const req = new URL(s.redirectUrl, 'http://x').searchParams.get('req')!;
    expect((await completeIdentityVerification({ requestToken: req, payload: { name, birthDate: '1990', phone: fx.payerPhone } })).ok).toBe(false);
    const s2 = await startIdentityVerification({ purpose: 'ESIGN', returnPath: '/sign/x' });
    const req2 = new URL(s2.redirectUrl, 'http://x').searchParams.get('req')!;
    const [a, b] = await Promise.all([
      completeIdentityVerification({ requestToken: req2, payload: { name, birthDate: '19900101', phone: fx.payerPhone } }),
      completeIdentityVerification({ requestToken: req2, payload: { name: '다른이름', birthDate: '19900101', phone: fx.payerPhone } }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(await prisma.identityVerification.count({ where: { status: 'VERIFIED' } })).toBe(1);
  });

  it('전자서명 켜짐: 인증 없이는 서명 거절, 인증 뒤 서명 → 해시 체인 IDENTITY_VERIFIED 사건, 완료 문서는 "시점확인 미연동" 만', async () => {
    process.env.IDENTITY_REQUIRED_FOR_ESIGN = 'true';
    const t = await prisma.documentTemplate.create({ data: { id: newId(), merchantId: fx.merchantId, name: '약정서', templateType: 'EDITOR', body: '본문', requireSignature: true, fields: [] } });
    const r = await createEnvelope({ merchantId: fx.merchantId, actorId: fx.merchantUserId, nonce: newId(), templateId: t.id, signingOrder: 'PARALLEL', signers: [{ name, phone: '010-1111-2222', role: 'DONOR' }] });
    const signer = await prisma.eDocSigner.findFirstOrThrow({ where: { envelopeId: r.envelopeId } });
    const token = `test-token-${signer.id}-abcdefgh`;
    await prisma.eDocSigner.update({ where: { id: signer.id }, data: { tokenHash: tokenHash(token) } });
    const proof = accessProof(signer.id, tokenHash(token), Math.floor(Date.now() / 1000) + 600);
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await expect(signAsSigner({ token, proof, values: {}, signature: PNG, agreed: true })).rejects.toThrow(/본인인증/);
    await verify('ESIGN', { name, birthDate: '19900101', phone: '01011112222' });
    const out = await signAsSigner({ token, proof, values: {}, signature: PNG, agreed: true });
    expect(out.completed).toBe(true);
    const ev = await prisma.eDocEvent.findFirstOrThrow({ where: { envelopeId: r.envelopeId, type: 'IDENTITY_VERIFIED' } });
    const d = ev.detail as Record<string, unknown>;
    expect(d.mock).toBe(true);
    expect(d.nameMatch).toBe(true);
    expect(String(d.ciHashPrefix)).toHaveLength(8);
    expect(JSON.stringify(d)).not.toContain('MOCKCI');
    expect((await verifyEnvelopeChain(r.envelopeId)).ok).toBe(true);
    await processDomainEvents();
    const ts = await prisma.documentTimestamp.findUniqueOrThrow({ where: { envelopeId: r.envelopeId } });
    expect(ts.status).toBe('NOT_CONNECTED');
    expect(ts.tokenEnc).toBeNull();
    expect(ts.stampedAt).toBeNull();
  });
});

describe('계좌 거래내역 자동 조회', () => {
  const woori = () => new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'bank-woori-2026-11-09.csv')));

  it('꺼짐: 아무것도 읽지 않는다 · 켜짐 + mock: "연동 안 됨" 만 남기고 입금을 지어내지 않는다', async () => {
    await prisma.bankFeedLink.create({ data: { merchantId: fx.merchantId, provider: 'mock', enabled: true } });
    expect((await syncBankFeeds()).skipped).toBe('DISABLED');
    expect((await prisma.bankFeedLink.findUniqueOrThrow({ where: { merchantId: fx.merchantId } })).lastResult).toBeNull();
    process.env.BANK_FEED_ENABLED = 'true';
    const r = await syncBankFeeds();
    expect(r.notConnected).toBe(1);
    expect(await prisma.bankDeposit.count()).toBe(0);
    expect((await prisma.bankFeedLink.findUniqueOrThrow({ where: { merchantId: fx.merchantId } })).lastResult).toBe('NOT_CONNECTED');
  });

  it('고정 데이터 주입: 파일과 같은 정규화·중복 해시 — 파일로 넣은 입금은 다시 넣지 않고, 다시 조회해도 한 번', async () => {
    process.env.BANK_FEED_ENABLED = 'true';
    await prisma.bankFeedLink.create({ data: { merchantId: fx.merchantId, provider: 'mock', enabled: true } });
    const file = await importBankStatement({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: 'woori.csv', bytes: woori() });
    expect(file.status).toBe('DONE');
    const before = await prisma.bankDeposit.count();
    setMockBankFeedFixture(fx.merchantId, [
      { occurredAt: '2026.10.05 09:12', deposit: 30000n, withdrawal: 0n, name: '홍길동', memo: '타행', balance: 1030000n },
      { occurredAt: '2026.10.05 09:12', deposit: 30000n, withdrawal: 0n, name: '홍길동', memo: '타행', balance: 1060000n },
      { occurredAt: '2026.11.10 10:00:00', deposit: 12000n, withdrawal: 0n, name: '(주)새입금', memo: null, balance: 2000000n },
      { occurredAt: '2026.11.10 11:00:00', deposit: 0n, withdrawal: 5000n, name: '출금', memo: null, balance: 1995000n },
    ]);
    const r1 = await syncBankFeeds(new Date('2026-11-11T00:00:00Z'));
    expect(r1.ok).toBe(1);
    expect(r1.newDeposits).toBe(1);
    expect(await prisma.bankDeposit.count()).toBe(before + 1);
    const r2 = await syncBankFeeds(new Date('2026-11-12T00:00:00Z'));
    expect(r2.newDeposits).toBe(0);
    expect(await prisma.bankDeposit.count()).toBe(before + 1);
    // 기브싸인 결제와 섞이지 않는다
    expect(await prisma.charge.count({ where: { merchantId: fx.merchantId, status: 'SETTLEMENT_PENDING' } })).toBe(0);
  });
});
