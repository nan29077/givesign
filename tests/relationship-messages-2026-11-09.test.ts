import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, maskPhone, phoneHash } from '@/lib/crypto';
import { kstStartOfDay } from '@/lib/datetime';
import { readMockOutbox } from '@/server/adapters/mt';
import { inboundAndPay, moPayload, resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';
import { setMarketingConsent, isMarketingConsented } from '@/server/services/marketing-consent';
import { revokeMarketingConsents } from '@/server/services/marketing-consent-revoke';
import { decideApproval } from '@/server/services/approvals';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { isPromotionalTemplate, isRelationalTemplate } from '@/server/services/outbound/classify';
import {
  isPromoQuietHour,
  monitorRelationshipOptOuts,
  optOutRelationship,
  proposeWeeklyBatch,
  relationshipCandidates,
  runRelationshipCron,
  saveRelationshipSetting,
  sendApprovedRelationshipMessages,
  setRelationshipGloballyEnabled,
} from '@/server/services/relationship-messages';

/**
 * 2026-11-13 5차 L4 — 관계 확장 안내(광고성). 꺼짐이면 0건 · 동의자만 · 승인 후 · 월 1회 · (광고) 표기 · 야간 금지 ·
 * 정보성과 같은 날 피함 · 수신 거부율 2% 초과 자동 중지 · 탈퇴 시 동의 철회.
 */

let fx: Fixture;
const DAY = 86_400_000;
/** 오늘 KST 12시(낮) */
const noon = () => new Date(kstStartOfDay(new Date()).getTime() + 12 * 3_600_000);

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  registerDefaultConsumers();
});

/** 일시후원 2회(20일 전·16일 전) 한 동의자 */
async function twiceDonor(phone = fx.payerPhone, consent = true) {
  const payer = await seedRegisteredPayer(phone);
  const a = await inboundAndPay(moPayload({ to: fx.moNumber, from: phone, messageId: `MO-R-${newId()}` }), fx.merchantId);
  const b = await inboundAndPay(moPayload({ to: fx.moNumber, from: phone, messageId: `MO-R-${newId()}` }), fx.merchantId);
  await prisma.charge.update({ where: { id: a.chargeId! }, data: { paidAt: new Date(noon().getTime() - 20 * DAY) } });
  await prisma.charge.update({ where: { id: b.chargeId! }, data: { paidAt: new Date(noon().getTime() - 16 * DAY) } });
  if (consent) await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' });
  return payer;
}

async function turnOn(kinds = ['ONE_TIME_TO_RECURRING', 'DORMANT_REENGAGE', 'UPGRADE', 'VOLUNTEER_TO_DONOR']) {
  await setRelationshipGloballyEnabled(true, 'admin');
  await saveRelationshipSetting(fx.merchantId, { enabled: true, kinds }, fx.merchantUserId);
}

async function approveBatch(approvalId: string) {
  const r = await decideApproval({ merchantId: fx.merchantId, id: approvalId, decision: 'APPROVE', userId: fx.merchantUserId });
  expect(r.ok).toBe(true);
}

describe('꺼짐(기본) — 대상 계산·발송 0건', () => {
  it('전역 스위치 꺼짐: 동의한 대상이 있어도 승인 요청·대상 행·문자가 없다', async () => {
    await twiceDonor();
    expect((await proposeWeeklyBatch(fx.merchantId, noon())).reason).toBe('DISABLED');
    expect((await runRelationshipCron(noon())).skipped).toBe('DISABLED');
    expect((await sendApprovedRelationshipMessages(noon())).skipped).toBe('DISABLED');
    expect(await prisma.approvalRequest.count({ where: { kind: 'RELATIONSHIP_MESSAGE_BATCH' } })).toBe(0);
    expect(await prisma.relationshipMessage.count()).toBe(0);
    expect(readMockOutbox(50).some((m) => m.template === 'RELATIONSHIP_MESSAGE')).toBe(false);
    // 전역이 꺼져 있으면 기관 설정도 켤 수 없다
    await expect(saveRelationshipSetting(fx.merchantId, { enabled: true, kinds: ['UPGRADE'] }, fx.merchantUserId)).rejects.toThrow(/법무 확인/);
  });

  it('전역 켜짐 + 기관 꺼짐도 0건', async () => {
    await twiceDonor();
    await setRelationshipGloballyEnabled(true, 'admin');
    expect((await proposeWeeklyBatch(fx.merchantId, noon())).reason).toBe('DISABLED');
    expect(await prisma.relationshipMessage.count()).toBe(0);
  });
});

describe('켜짐 — 동의자만·기관 승인 후·문자만', () => {
  it('동의자만 대상(미동의·철회·열린 문의·환불·탈퇴 제외), 승인 전에는 보내지 않는다', async () => {
    const yes = await twiceDonor('01011110001');
    await twiceDonor('01011110002', false); // 미동의
    const withdrawn = await twiceDonor('01011110003');
    await setMarketingConsent({ payerId: withdrawn.id, merchantId: fx.merchantId, agree: false, source: 'MY' });
    const inquiry = await twiceDonor('01011110004');
    await prisma.supportInquiry.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: inquiry.id, handledBy: 'MERCHANT', status: 'OPEN' } });
    const gone = await twiceDonor('01011110005');
    await prisma.payerProfile.update({ where: { id: gone.id }, data: { onboardingStatus: 'WITHDRAWN' } });
    await turnOn();
    const cands = await relationshipCandidates(fx.merchantId, ['ONE_TIME_TO_RECURRING'], noon());
    expect(cands.map((c) => c.payerId)).toEqual([yes.id]);

    const r = await proposeWeeklyBatch(fx.merchantId, noon());
    expect(r.created).toBe(true);
    expect(r.total).toBe(1);
    // 같은 주에 다시 돌려도 한 번
    expect((await proposeWeeklyBatch(fx.merchantId, noon())).created).toBe(false);
    const a = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: r.approvalId! } });
    expect(a.status).toBe('PENDING');
    const p = a.payload as Record<string, unknown>;
    expect(String((p.texts as Record<string, string>).ONE_TIME_TO_RECURRING).startsWith('(광고)')).toBe(true);
    expect(p.samples).toHaveLength(1);
    // 승인 전 발송 0건
    expect((await sendApprovedRelationshipMessages(noon())).sent).toBe(0);
    await approveBatch(r.approvalId!);
    const out = await sendApprovedRelationshipMessages(noon());
    expect(out.sent).toBe(1);
    const sms = readMockOutbox(50).filter((m) => m.template === 'RELATIONSHIP_MESSAGE');
    expect(sms).toHaveLength(1);
    expect(sms[0]!.text.startsWith('(광고)')).toBe(true);
    expect(sms[0]!.text).toContain('무료 수신거부');
    expect(sms[0]!.text).toContain('/u/');
    const mt = await prisma.mtOutboundMessage.findFirstOrThrow({ where: { templateCode: 'RELATIONSHIP_MESSAGE' } });
    expect(mt.channel).toBe('SMS');
    // 1회만: 다음 주에도 같은 종류는 다시 대상이 아니다
    expect((await proposeWeeklyBatch(fx.merchantId, new Date(noon().getTime() + 7 * DAY))).reason).toBe('NO_TARGET');
  });

  it('반려하면 보내지 않는다', async () => {
    await twiceDonor();
    await turnOn();
    const r = await proposeWeeklyBatch(fx.merchantId, noon());
    await decideApproval({ merchantId: fx.merchantId, id: r.approvalId!, decision: 'REJECT', userId: fx.merchantUserId });
    expect((await sendApprovedRelationshipMessages(noon())).sent).toBe(0);
    expect((await prisma.relationshipMessage.findFirstOrThrow()).status).toBe('REJECTED');
  });

  it('야간(21~8시 KST)에는 보내지 않는다', async () => {
    const night = new Date(kstStartOfDay(new Date()).getTime() + 22 * 3_600_000);
    const early = new Date(kstStartOfDay(new Date()).getTime() + 7 * 3_600_000 + 59 * 60_000);
    expect(isPromoQuietHour(night)).toBe(true);
    expect(isPromoQuietHour(early)).toBe(true);
    expect(isPromoQuietHour(noon())).toBe(false);
    await twiceDonor();
    await turnOn();
    const r = await proposeWeeklyBatch(fx.merchantId, noon());
    await approveBatch(r.approvalId!);
    expect((await sendApprovedRelationshipMessages(night)).skipped).toBe('QUIET_HOURS');
    expect((await prisma.relationshipMessage.findFirstOrThrow()).status).toBe('APPROVED');
  });

  it('정보성 안내와 같은 날이면 다음 날로, 후원자당 월 1회(기관 무관)', async () => {
    const payer = await twiceDonor();
    await turnOn();
    const r = await proposeWeeklyBatch(fx.merchantId, noon());
    await approveBatch(r.approvalId!);
    await prisma.mtOutboundMessage.create({
      data: { id: newId(), phoneHash: payer.phoneHash, phoneEnc: encrypt(fx.payerPhone), phoneMasked: maskPhone(fx.payerPhone), fromNumber: '15880000', messageType: 'SMS', templateCode: 'MONTHLY_NOTICE', bodyMasked: '월간', merchantId: fx.merchantId, createdAt: noon() },
    });
    const d = await sendApprovedRelationshipMessages(noon());
    expect(d.deferred).toBe(1);
    expect(d.sent).toBe(0);
    const row = await prisma.relationshipMessage.findFirstOrThrow();
    expect(row.notBefore!.getTime()).toBeGreaterThan(noon().getTime());
    // 다음 날 낮에는 나간다
    const tomorrow = new Date(noon().getTime() + DAY);
    expect((await sendApprovedRelationshipMessages(tomorrow)).sent).toBe(1);
    // 같은 달 다른 안내(다른 기관 승인분처럼 행을 하나 더 만듦)는 월 1회로 건너뛴다
    await prisma.relationshipMessage.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: payer.id, kind: 'DORMANT_REENGAGE', periodKey: '2099', dedupeKey: `t:${newId()}`, status: 'APPROVED' } });
    const m = await sendApprovedRelationshipMessages(new Date(tomorrow.getTime() + 3_600_000));
    if (new Date(tomorrow.getTime() + 9 * 3_600_000).getUTCMonth() === new Date(tomorrow.getTime() + 3_600_000 + 9 * 3_600_000).getUTCMonth()) {
      expect(m.dropped).toBe(1);
      expect(m.sent).toBe(0);
    }
  });

  it('보내기 직전 동의를 철회했으면 보내지 않는다', async () => {
    const payer = await twiceDonor();
    await turnOn();
    const r = await proposeWeeklyBatch(fx.merchantId, noon());
    await approveBatch(r.approvalId!);
    await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: false, source: 'MY' });
    const out = await sendApprovedRelationshipMessages(noon());
    expect(out.sent).toBe(0);
    expect(out.dropped).toBe(1);
  });

  it('무료 수신 거부 → 동의 철회, 7일 수신 거부율 2% 초과면 기관 관계 안내 자동 중지 + 알림, 중지되면 묶음을 만들지 않는다', async () => {
    const payer = await twiceDonor();
    await turnOn();
    const r = await proposeWeeklyBatch(fx.merchantId, noon());
    await approveBatch(r.approvalId!);
    await sendApprovedRelationshipMessages(noon());
    const sms = readMockOutbox(50).find((m) => m.template === 'RELATIONSHIP_MESSAGE')!;
    const token = sms.text.match(/\/u\/([A-Za-z0-9_-]+)/)![1]!;
    const o1 = await optOutRelationship(token);
    expect(o1.ok).toBe(true);
    expect((await optOutRelationship(token)).ok).toBe(true); // 두 번 눌러도 이력 한 번
    const link = await prisma.payerMerchantLink.findUniqueOrThrow({ where: { payerId_merchantId: { payerId: payer.id, merchantId: fx.merchantId } } });
    expect(isMarketingConsented(link)).toBe(false);
    expect(await prisma.marketingConsentLog.count({ where: { payerId: payer.id, source: 'OPT_OUT' } })).toBe(1);
    const mon = await monitorRelationshipOptOuts(new Date(noon().getTime() + DAY));
    expect(mon.paused).toEqual([fx.merchantId]);
    const s = await prisma.relationshipMessageSetting.findUniqueOrThrow({ where: { merchantId: fx.merchantId } });
    expect(s.pausedAt).not.toBeNull();
    expect(s.pauseReason).toContain('수신 거부율');
    expect(await prisma.notification.count({ where: { title: '관계 안내가 자동 중지되었습니다' } })).toBe(1);
    expect((await proposeWeeklyBatch(fx.merchantId, new Date(noon().getTime() + 7 * DAY))).reason).toBe('DISABLED');
    // 한 번 더 감시해도 알림은 한 번
    await monitorRelationshipOptOuts(new Date(noon().getTime() + 2 * DAY));
    expect(await prisma.notification.count({ where: { title: '관계 안내가 자동 중지되었습니다' } })).toBe(1);
  });

  it('동시 발송 배치 두 개가 겹쳐도 한 번만 나간다', async () => {
    await twiceDonor();
    await turnOn();
    const r = await proposeWeeklyBatch(fx.merchantId, noon());
    await approveBatch(r.approvalId!);
    const [a, b] = await Promise.all([sendApprovedRelationshipMessages(noon()), sendApprovedRelationshipMessages(noon())]);
    expect(a.sent + b.sent).toBe(1);
    expect(readMockOutbox(50).filter((m) => m.template === 'RELATIONSHIP_MESSAGE')).toHaveLength(1);
  });
});

describe('분류·탈퇴', () => {
  it('광고성 분류는 정보성(관계·정보형) 상한과 따로다', () => {
    expect(isPromotionalTemplate('RELATIONSHIP_MESSAGE')).toBe(true);
    expect(isRelationalTemplate('RELATIONSHIP_MESSAGE')).toBe(false);
    expect(isPromotionalTemplate('MONTHLY_NOTICE')).toBe(false);
  });

  it('탈퇴 처리용 일괄 철회: 모든 기관 동의를 철회하고 이력을 남긴다(이미 철회한 곳은 그대로)', async () => {
    const phone = '01055556666';
    const payer = await prisma.payerProfile.create({ data: { id: newId(), phoneHash: phoneHash(phone), phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone) } });
    await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' });
    const n = await prisma.$transaction((tx) => revokeMarketingConsents(tx, { payerId: payer.id, source: 'WITHDRAW' }));
    expect(n).toBe(1);
    expect(await prisma.$transaction((tx) => revokeMarketingConsents(tx, { payerId: payer.id, source: 'WITHDRAW' }))).toBe(0);
    const link = await prisma.payerMerchantLink.findUniqueOrThrow({ where: { payerId_merchantId: { payerId: payer.id, merchantId: fx.merchantId } } });
    expect(isMarketingConsented(link)).toBe(false);
    expect(await prisma.marketingConsentLog.count({ where: { payerId: payer.id, source: 'WITHDRAW', agreed: false } })).toBe(1);
  });
});
