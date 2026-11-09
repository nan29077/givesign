import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { phoneHash, maskPhone, encrypt } from '@/lib/crypto';
import { inboundAndPay, moPayload, resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';
import {
  MARKETING_WORDING_VERSION,
  applyMarketingIntentForCharge,
  donorMemberMarketingState,
  isMarketingConsented,
  marketingChecked,
  marketingConsentPayerIds,
  marketingConsentsForPayer,
  marketingConsentWording,
  recordMarketingConsentIfChecked,
  recordMarketingIntent,
  setDonorMemberMarketing,
  setMarketingConsent,
  syncDonorMemberMarketing,
} from '@/server/services/marketing-consent';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';

/** 2026-11-09 1차 과제 A2 — (선택) 기관 소식·후원 안내 수신 동의. 저장·철회·표시만(발송 없음). */

let fx: Fixture;
const singleBackend = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${process.env.PGLITE_PORT ?? '5463'}/`);
const link = (payerId: string, merchantId: string) =>
  prisma.payerMerchantLink.findUnique({ where: { payerId_merchantId: { payerId, merchantId } } });

async function secondMerchant(name = '두번째기관') {
  const user = await prisma.user.create({ data: { id: newId(), email: `m2-${newId()}@test.kr`, name, role: 'MERCHANT' } });
  const m = await prisma.merchantProfile.create({
    data: { id: newId(), userId: user.id, code: `GIV-${newId().slice(-4)}`, displayName: name, status: 'APPROVED', paymentMode: 'CONFIRM_LINK' },
  });
  return m.id;
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  registerDefaultConsumers();
});

describe('(선택) 소식 수신 동의 — 저장', () => {
  it('기본은 미동의: 후원해도 동의가 생기지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, messageId: 'MO-MKT-1' }), fx.merchantId);
    await processDomainEvents();
    const l = await link(payer.id, fx.merchantId);
    expect(l).not.toBeNull();
    expect(isMarketingConsented(l)).toBe(false);
    expect((await marketingConsentPayerIds(fx.merchantId)).size).toBe(0);
    expect(marketingChecked(null)).toBe(false);
    expect(marketingChecked('1')).toBe(true);
  });

  it('동의를 저장하면 시각·받은 곳과 이력(문구·판)이 남고, 다시 동의해도 이력은 한 번', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const r1 = await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'VOLUNTEER', wordingTail: '신청할 수 있습니다', ip: '1.2.3.4' });
    expect(r1).toEqual({ changed: true, agreed: true });
    const r2 = await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' });
    expect(r2.changed).toBe(false);
    const l = await link(payer.id, fx.merchantId);
    expect(l!.marketingConsentAt).not.toBeNull();
    expect(l!.marketingConsentSource).toBe('VOLUNTEER');
    const logs = await prisma.marketingConsentLog.findMany({ where: { payerId: payer.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ agreed: true, source: 'VOLUNTEER', wordingVersion: MARKETING_WORDING_VERSION, ip: '1.2.3.4' });
    expect(logs[0].wording).toBe(marketingConsentWording('테스트사회복지기관', '신청할 수 있습니다'));
    expect(logs[0].wording).toContain('동의하지 않아도 신청할 수 있습니다');
    expect([...(await marketingConsentPayerIds(fx.merchantId))]).toEqual([payer.id]);
  });

  it('후원 화면 체크 → 결제 성공(charge.paid) 때 동의로 반영, 결제 전·실패에는 반영하지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const paid = await inboundAndPay(moPayload({ to: fx.moNumber, messageId: 'MO-MKT-2' }), fx.merchantId);
    await recordMarketingIntent(true, { chargeId: paid.chargeId!, source: 'DONATE' });
    await recordMarketingIntent(true, { chargeId: paid.chargeId!, source: 'DONATE' });
    expect(await prisma.marketingConsentIntent.count()).toBe(1);

    // 결제 건이 성공하지 않았으면(이벤트 없음) 동의가 아니다
    const unpaidId = newId();
    await prisma.charge.create({
      data: { id: unpaidId, transactionNo: `TRD-${newId()}`, merchantId: fx.merchantId, payerId: payer.id, channel: 'WEB', amount: 1000n, displayName: 't', message: 'm', messageRawEnc: 'x', status: 'PENDING_PIN' },
    });
    await recordMarketingIntent(true, { chargeId: unpaidId });

    await processDomainEvents();
    const l = await link(payer.id, fx.merchantId);
    expect(isMarketingConsented(l)).toBe(true);
    expect(l!.marketingConsentSource).toBe('DONATE');
    expect((await prisma.marketingConsentIntent.findUniqueOrThrow({ where: { chargeId: paid.chargeId! } })).appliedAt).not.toBeNull();
    expect((await prisma.marketingConsentIntent.findUniqueOrThrow({ where: { chargeId: unpaidId } })).appliedAt).toBeNull();
    // 같은 이벤트를 소비자가 다시 받아도 이력은 그대로
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type: 'charge.paid', subjectId: paid.chargeId! } });
    expect(await applyMarketingIntentForCharge({ ...ev, payload: {} })).toBe('SKIPPED');
    expect(await prisma.marketingConsentLog.count()).toBe(1);
  });

  it('체크하지 않으면 아무것도 하지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await recordMarketingConsentIfChecked(false, { payerId: payer.id, merchantId: fx.merchantId, source: 'DONATE' });
    const paid = await inboundAndPay(moPayload({ to: fx.moNumber, messageId: 'MO-MKT-3' }), fx.merchantId);
    await recordMarketingIntent(false, { chargeId: paid.chargeId! });
    await processDomainEvents();
    expect(await prisma.marketingConsentIntent.count()).toBe(0);
    expect(await prisma.marketingConsentLog.count()).toBe(0);
    expect(isMarketingConsented(await link(payer.id, fx.merchantId))).toBe(false);
  });
});

describe('(선택) 소식 수신 동의 — 유지·철회·분리', () => {
  it('재후원 때 체크하지 않아도 기존 동의는 그대로다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' });
    const paid = await inboundAndPay(moPayload({ to: fx.moNumber, messageId: 'MO-MKT-4' }), fx.merchantId);
    await recordMarketingIntent(false, { chargeId: paid.chargeId! });
    await recordMarketingConsentIfChecked(false, { payerId: payer.id, merchantId: fx.merchantId, source: 'DONATE' });
    await processDomainEvents();
    expect(isMarketingConsented(await link(payer.id, fx.merchantId))).toBe(true);
  });

  it('철회하면 명단에서 빠지고 이력이 남으며, 다시 후원해도(체크 안 함) 되살아나지 않는다. 월간 안내 수신 거부와는 별개', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' });
    await prisma.payerMerchantLink.update({ where: { payerId_merchantId: { payerId: payer.id, merchantId: fx.merchantId } }, data: { noticeOptOutAt: null } });
    const off = await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: false, source: 'MY' });
    expect(off).toEqual({ changed: true, agreed: false });
    const l = await link(payer.id, fx.merchantId);
    expect(l!.marketingConsentWithdrawnAt).not.toBeNull();
    expect(l!.noticeOptOutAt).toBeNull();
    expect((await marketingConsentPayerIds(fx.merchantId)).size).toBe(0);
    const logs = await prisma.marketingConsentLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(logs.map((x) => x.agreed)).toEqual([true, false]);

    await inboundAndPay(moPayload({ to: fx.moNumber, messageId: 'MO-MKT-5' }), fx.merchantId);
    await processDomainEvents();
    expect(isMarketingConsented(await link(payer.id, fx.merchantId))).toBe(false);

    // 월간 안내 수신 거부를 켜도 소식 수신 동의는 바뀌지 않는다
    await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'MY' });
    await prisma.payerMerchantLink.update({ where: { payerId_merchantId: { payerId: payer.id, merchantId: fx.merchantId } }, data: { noticeOptOutAt: new Date() } });
    expect(isMarketingConsented(await link(payer.id, fx.merchantId))).toBe(true);
  });

  it('기관마다 따로다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const other = await secondMerchant();
    await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' });
    await setMarketingConsent({ payerId: payer.id, merchantId: other, agree: false, source: 'MY' });
    expect((await marketingConsentPayerIds(fx.merchantId)).has(payer.id)).toBe(true);
    expect((await marketingConsentPayerIds(other)).size).toBe(0);
    const list = await marketingConsentsForPayer(payer.id);
    expect(list.find((x) => x.merchantId === fx.merchantId)?.agreed).toBe(true);
    // 동의한 적 없는 기관에 철회를 보내면 바뀐 것이 없다(이력 없음)
    expect(await prisma.marketingConsentLog.count({ where: { merchantId: other } })).toBe(0);
  });

  it.skipIf(singleBackend)('동시에 두 번 동의해도 이력은 한 번', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const rs = await Promise.all([
      setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' }),
      setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' }),
    ]);
    expect(rs.filter((r) => r.changed)).toHaveLength(1);
    expect(await prisma.marketingConsentLog.count()).toBe(1);
    expect(await prisma.payerMerchantLink.count({ where: { payerId: payer.id } })).toBe(1);
  });
});

describe('(선택) 소식 수신 동의 — 기관 후원 회원', () => {
  async function member(marketingAgreed: boolean, phone: string | null) {
    return prisma.donorMember.create({
      data: {
        id: newId(), merchantId: fx.merchantId, email: `d-${newId()}@test.kr`, passwordHash: 'x', name: '회원', marketingAgreed, termsAgreedAt: new Date(),
        ...(phone ? { phoneHash: phoneHash(phone), phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone), phoneVerifiedAt: new Date() } : {}),
      },
    });
  }

  it('가입 때 체크 → 휴대폰 인증으로 후원자와 이어지면 그 기관 동의(SIGNUP)로 옮긴다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const m = await member(true, fx.payerPhone);
    await syncDonorMemberMarketing(m.id);
    const l = await link(payer.id, fx.merchantId);
    expect(isMarketingConsented(l)).toBe(true);
    expect(l!.marketingConsentSource).toBe('SIGNUP');
    expect(await donorMemberMarketingState(m.id)).toEqual({ agreed: true, linkedPayerId: payer.id });
  });

  it('체크하지 않았거나, 번호가 이어지지 않았거나, 이미 철회한 경우에는 옮기지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await syncDonorMemberMarketing((await member(false, fx.payerPhone)).id);
    expect(isMarketingConsented(await link(payer.id, fx.merchantId))).toBe(false);

    const noPhone = await member(true, null);
    await syncDonorMemberMarketing(noPhone.id);
    expect(await donorMemberMarketingState(noPhone.id)).toEqual({ agreed: true, linkedPayerId: null });

    await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' });
    await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: false, source: 'MY' });
    await prisma.donorMember.deleteMany({});
    await syncDonorMemberMarketing((await member(true, fx.payerPhone)).id);
    expect(isMarketingConsented(await link(payer.id, fx.merchantId))).toBe(false);
  });

  it('회원 화면에서 끄면 회원 값과 이어진 후원자 동의가 함께 꺼진다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const m = await member(true, fx.payerPhone);
    await syncDonorMemberMarketing(m.id);
    await setDonorMemberMarketing(m.id, false);
    expect((await prisma.donorMember.findUniqueOrThrow({ where: { id: m.id } })).marketingAgreed).toBe(false);
    expect(isMarketingConsented(await link(payer.id, fx.merchantId))).toBe(false);
    expect((await prisma.marketingConsentLog.findFirstOrThrow({ where: { agreed: false } })).source).toBe('MY');
  });
});
