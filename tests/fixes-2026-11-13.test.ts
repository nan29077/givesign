import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: () => undefined, notFound: () => undefined }));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { kstDateKey, kstMonthKey } from '@/lib/datetime';
import { clearMockOutbox, readMockOutbox } from '@/server/adapters/mt';
import { resetDb, seedBasics, seedRegisteredPayer, inboundAndPay, moPayload, type Fixture } from './helpers';
import { CRON_JOBS } from '@/server/cron-registry';
import { cronRunnerMode, isCronDue, lastScheduledAt } from '@/server/cron-runner';
import { alertLateCronJobs, lateCronJobs } from '@/server/services/cron-health';
import { runMonthlyNotices, runMonthlyReceipts, previousMonthKey, monthRange, runMerchantNotice } from '@/server/services/monthly-notice';
import { issueReceipt, upsertReceiptProfile, voidReceipt } from '@/server/services/receipts';
import { requestReissueAfterRefund } from '@/server/services/receipt-batch';
import { decideApproval } from '@/server/services/approvals';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { JOURNEYS } from '@/server/services/journeys/definitions';
import { advanceRun, journeySendKey, stopExpiredJourneyApprovals, JOURNEY_APPROVAL_TTL_DAYS } from '@/server/services/journeys/engine';
import { flushDueOutbound, relationalCapCount, sendRelational } from '@/server/services/outbound/coordinator';
import * as tpl from '@/server/services/mt-templates';
import { createRecurringDonation, runRecurringDonations } from '@/server/services/recurring';
import {
  acceptValuation, applyParticipation, approveSaleBatch, assertInboundDate, closeDonation, confirmInspection, confirmSettlement, correctInboundDate,
  createDonation, createLive, createSaleBatch, decideParticipation, endProduct, generateSettlements, isValidBusinessNo, markProductListed,
  pledgeDonation, receiptCorrectionNeeded, registerGiver, registerInbound, reissueInKindReceipt, respondMatch, runBazaarSettlementAutomation,
  saveSeller, updateProduct, voidInKindReceipt, proposeValuation,
} from '@/server/services/bazaar';
import { setLiveBazaarEnabled } from '@/server/services/bazaar-settings';
import { amountMismatch, nextMonth } from '@/lib/bazaar';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 2026-11-13 후원 자동화·라이브 바자회 점검 조치 회귀 테스트.
 * 보고서: docs/2026-11-13_후원자동화_라이브바자회_점검조치보고서.md
 */

let fx: Fixture;
const RESIDENT = '900101-1234568';

async function issuer(cycle: 'YEARLY' | 'MONTHLY' = 'YEARLY') {
  await prisma.merchantProfile.update({
    where: { id: fx.merchantId },
    data: { businessNo: '1234567890', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true, designatedDoneeVerifiedAt: new Date(), receiptCycle: cycle },
  });
}
async function makeAdmin(permission: 'SUPER_ADMIN' | 'FINANCE' = 'SUPER_ADMIN') {
  const u = await prisma.user.create({ data: { id: newId(), email: `admin-${newId()}@test.kr`, name: '관리자', role: 'ADMIN' } });
  await prisma.adminProfile.create({ data: { id: newId(), userId: u.id, permission } });
  return u.id;
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  await prisma.termsVersion.create({
    data: { id: newId(), type: 'RECEIPT_ISSUANCE', version: '1.0', title: '영수증 동의', content: '테스트', required: false, effectiveFrom: new Date('2026-01-01') },
  });
  registerDefaultConsumers();
  clearMockOutbox();
});

// ===========================================================================
describe('A-H1 배치 실행 보장', () => {
  it('등록부의 모든 배치에 기계용 주기가 있고, 경로마다 라우트 파일이 있다(예약 게시 5분 배치 포함)', () => {
    expect(CRON_JOBS.length).toBeGreaterThanOrEqual(22);
    for (const j of CRON_JOBS) {
      expect(j.when, j.name).toBeTruthy();
      const file = path.join(process.cwd(), 'src/app', j.path, 'route.ts');
      expect(fs.existsSync(file), file).toBe(true);
    }
    expect(CRON_JOBS.find((j) => j.name === 'content-publish')?.when).toEqual({ everySec: 300 });
    expect(CRON_JOBS.find((j) => j.name === 'recurring')?.when).toEqual({ dailyAtKst: ['10:00', '12:00', '14:00'] });
    expect(CRON_JOBS.find((j) => j.name === 'monthly-notice')?.when).toEqual({ dailyAtKst: ['10:00'], days: [1, 2, 3, 4, 5] });
  });

  it('테스트에서는 내장 실행기가 꺼진다', () => {
    expect(cronRunnerMode()).toBe('off');
  });

  it('주기 판정: N초·매시·매일(KST)·날짜 제한·따라잡기(하루 안)', () => {
    const at = (s: string) => new Date(s);
    // N초
    expect(isCronDue({ everySec: 60 }, at('2026-11-13T00:00:00Z'), null)).toBe(true);
    expect(isCronDue({ everySec: 60 }, at('2026-11-13T00:00:30Z'), at('2026-11-13T00:00:00Z'))).toBe(false);
    expect(isCronDue({ everySec: 60 }, at('2026-11-13T00:01:00Z'), at('2026-11-13T00:00:00Z'))).toBe(true);
    // 매시 10분
    expect(lastScheduledAt({ hourlyAtMin: 10 }, at('2026-11-13T03:05:00Z'))!.toISOString()).toBe('2026-11-13T02:10:00.000Z');
    expect(isCronDue({ hourlyAtMin: 10 }, at('2026-11-13T03:11:00Z'), at('2026-11-13T02:10:05Z'))).toBe(true);
    expect(isCronDue({ hourlyAtMin: 10 }, at('2026-11-13T03:20:00Z'), at('2026-11-13T03:10:05Z'))).toBe(false);
    // 매일 10:00 KST = 01:00Z
    const daily = { dailyAtKst: ['10:00', '14:00'] };
    expect(lastScheduledAt(daily, at('2026-11-13T00:30:00Z'))!.toISOString()).toBe('2026-11-12T05:00:00.000Z'); // 아직 오늘 10시 전 → 어제 14시
    expect(isCronDue(daily, at('2026-11-13T01:00:10Z'), at('2026-11-12T05:00:01Z'))).toBe(true);
    expect(isCronDue(daily, at('2026-11-13T02:00:00Z'), at('2026-11-13T01:00:10Z'))).toBe(false);
    // 서버가 10시에 꺼져 있다가 11시에 켜짐 → 따라잡기 1회
    expect(isCronDue(daily, at('2026-11-13T02:00:00Z'), at('2026-11-12T05:00:01Z'))).toBe(true);
    // 날짜 제한(1~5일): 11월 13일에는 돌지 않는다(5일 실행은 하루가 지나 따라잡지 않음)
    const monthly = { dailyAtKst: ['10:00'], days: [1, 2, 3, 4, 5] };
    expect(isCronDue(monthly, at('2026-11-13T02:00:00Z'), null)).toBe(false);
    expect(isCronDue(monthly, at('2026-11-02T02:00:00Z'), at('2026-11-01T01:00:05Z'))).toBe(true);
    expect(isCronDue(monthly, at('2026-11-01T00:30:00Z'), null)).toBe(false); // 1일 10시 전, 지난달 말일은 날짜 밖
  });

  it('지연 감지: 기록 있는 배치가 주기의 3배를 넘기면 지연, 실패면 실패 — 최고관리자 알림은 배치·날짜마다 1회', async () => {
    await makeAdmin();
    const now = new Date();
    await prisma.cronHeartbeat.create({ data: { name: 'events', lastStartedAt: new Date(now.getTime() - 10 * 60_000), lastFinishedAt: new Date(now.getTime() - 10 * 60_000), lastOk: true } });
    await prisma.cronHeartbeat.create({ data: { name: 'outbound', lastStartedAt: now, lastFinishedAt: now, lastOk: false } });
    await prisma.cronHeartbeat.create({ data: { name: 'cleanup', lastStartedAt: now, lastFinishedAt: now, lastOk: true } });
    const late = await lateCronJobs(now);
    expect(late.map((l) => `${l.name}:${l.reason}`).sort()).toEqual(['events:LATE', 'outbound:FAILED']);
    expect(await alertLateCronJobs(now)).toBe(2);
    expect(await alertLateCronJobs(now)).toBe(0);
    expect(await prisma.notification.count({ where: { title: { startsWith: '배치' } } })).toBe(2);
  });
});

// ===========================================================================
describe('A-H2 매월 영수증 발급 분리', () => {
  async function paidLastMonth() {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    expect((await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: RESIDENT, hometaxOptIn: true })).ok).toBe(true);
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원' }), fx.merchantId);
    const { start } = monthRange(previousMonthKey());
    await prisma.charge.updateMany({ where: { merchantId: fx.merchantId }, data: { paidAt: new Date(start.getTime() + 86_400_000) } });
    return payer;
  }

  it('월간 안내를 꺼도 매월 발급 기관의 영수증은 발급된다(예전: 0건)', async () => {
    await issuer('MONTHLY');
    await paidLastMonth();
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { monthlyNoticeEnabled: false } });
    const s = await runMonthlyNotices();
    expect(s.receiptsIssued).toBe(1);
    expect(await prisma.donationReceipt.count({ where: { merchantId: fx.merchantId, status: 'ISSUED' } })).toBe(1);
    // 다시 돌아도 같은 결과(1~5일 매일 실행)
    expect((await runMonthlyNotices()).receiptsIssued).toBe(0);
  });

  it('1~2월에는 지난해 미발급분도 함께 발급한다(1월 1일 실행이 빠져도 12월분이 남지 않음)', async () => {
    await issuer('MONTHLY');
    const payer = await paidLastMonth();
    const lastYear = Number(kstMonthKey().slice(0, 4)) - 1;
    await prisma.charge.updateMany({ where: { payerId: payer.id }, data: { paidAt: new Date(`${lastYear}-12-20T03:00:00Z`) } });
    const feb = new Date(`${lastYear + 1}-02-03T01:00:00Z`);
    const r = await runMonthlyReceipts(feb);
    expect(r.issued).toBe(1);
    expect((await prisma.donationReceipt.findFirstOrThrow({ where: { payerId: payer.id } })).taxYear).toBe(lastYear);
    // 3월에는 지난해를 보지 않는다
    expect((await runMonthlyReceipts(new Date(`${lastYear + 1}-03-02T01:00:00Z`))).merchants).toBe(1);
  });

  it('연 1회 기관·요건 미비 기관은 발급하지 않는다', async () => {
    await paidLastMonth();
    expect((await runMonthlyReceipts()).merchants).toBe(0); // YEARLY 기본
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { receiptCycle: 'MONTHLY' } });
    expect((await runMonthlyReceipts()).notReady).toBe(1); // 공익법인 확인 없음
  });

  it('A-L6: 월간 안내는 탈퇴·기관 차단 후원자를 발송 전에 뺀다', async () => {
    const payer = await paidLastMonth();
    await prisma.payerProfile.update({ where: { id: payer.id }, data: { onboardingStatus: 'WITHDRAWN' } });
    const run = await runMerchantNotice(fx.merchantId, previousMonthKey());
    const d = await prisma.noticeDelivery.findFirstOrThrow({ where: { noticeRunId: run!.id } });
    expect(d).toMatchObject({ status: 'SKIPPED', reason: '탈퇴한 후원자' });
  });
});

// ===========================================================================
describe('A-M2 환불로 무효가 된 영수증 재발급', () => {
  it('남은 후원이 있으면 재발급 승인 요청 + 기관 알림, 승인하면 새 번호로 발급(다시 승인해도 1장)', async () => {
    await issuer();
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: RESIDENT, hometaxOptIn: true });
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원1' }), fx.merchantId);
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원2' }), fx.merchantId);
    const year = Number(kstDateKey().slice(0, 4));
    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 't', silent: true });
    expect(receipt.chargeCount).toBe(2);
    // 한 건 환불 → 영수증 무효(환불 완료 처리와 같은 결과를 만든다)
    const charges = await prisma.charge.findMany({ where: { payerId: payer.id }, orderBy: { createdAt: 'asc' } });
    await prisma.charge.update({ where: { id: charges[0]!.id }, data: { status: 'REFUNDED' } });
    const voided = await voidReceipt(receipt.id, '후원 환불', 'admin');
    const r = await requestReissueAfterRefund(voided);
    expect(r).toEqual({ requested: true, remaining: 1 });
    expect((await requestReissueAfterRefund(voided)).requested).toBe(false); // 같은 무효 영수증은 한 번
    const ap = await prisma.approvalRequest.findFirstOrThrow({ where: { kind: 'RECEIPT_REISSUE' } });
    expect(ap.title).toContain(`${year}년`);
    expect(await prisma.notification.count({ where: { title: '환불로 기부금영수증이 무효 처리되었습니다' } })).toBe(2);

    const out = await decideApproval({ merchantId: fx.merchantId, id: ap.id, decision: 'APPROVE', userId: fx.merchantUserId });
    expect(out.ok).toBe(true);
    const fresh = await prisma.donationReceipt.findFirstOrThrow({ where: { payerId: payer.id, status: 'ISSUED' } });
    expect(fresh.totalAmount).toBe(charges[1]!.amount);
    expect(fresh.receiptNo).not.toBe(receipt.receiptNo);
    expect((await prisma.donationReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).supersededById).toBe(fresh.id);
    expect(readMockOutbox(20).some((m) => m.template === 'RECEIPT_ISSUED')).toBe(true);
  });

  it('남은 후원이 없으면 승인 요청 없이 알림만', async () => {
    await issuer();
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: RESIDENT, hometaxOptIn: true });
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원1' }), fx.merchantId);
    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: Number(kstDateKey().slice(0, 4)), issuedBy: 't', silent: true });
    await prisma.charge.updateMany({ where: { payerId: payer.id }, data: { status: 'REFUNDED' } });
    const voided = await voidReceipt(receipt.id, '후원 환불', 'admin');
    expect(await requestReissueAfterRefund(voided)).toEqual({ requested: false, remaining: 0 });
    expect(await prisma.approvalRequest.count({ where: { kind: 'RECEIPT_REISSUE' } })).toBe(0);
  });
});

// ===========================================================================
describe('A-M3 계좌이체 후원자의 첫 후원 판정', () => {
  it('확정된 계좌이체가 여러 건이면 첫 후원이 아니다(예전: 결제 건 0 → 매번 첫 후원)', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const step = JOURNEYS.find((j) => j.key === 'donation-thanks')!.steps[0]!;
    const env = () => ({
      run: { id: 'r', merchantId: fx.merchantId, payerId: payer.id, journeyKey: 'donation-thanks', triggerKey: 't', startedAt: new Date(), context: { amount: '10000' }, subjectType: 'offline_donation' },
      params: { minAmount: 50000, receiptInfoDelayDays: 1, includeOffline: true },
      merchant: { id: fx.merchantId, displayName: '기관' },
      now: new Date(),
    });
    const add = () => prisma.offlineDonation.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: payer.id, source: 'MANUAL', amount: 10000n, donatedAt: new Date(), createdBy: 't' } });
    await add();
    expect(await step.when!(env())).toBe(true); // 진짜 첫 후원
    await add();
    expect(await step.when!(env())).toMatch(/첫 후원이 아님/);
  });
});

// ===========================================================================
describe('A-M4 정기 출금 순서', () => {
  it('출금일이 빠른 약정부터 처리한다(예전: 생성 순)', async () => {
    await prisma.termsVersion.create({ data: { id: newId(), type: 'RECURRING_DEBIT', version: '1.0', title: '정기', content: 't', required: false, effectiveFrom: new Date('2026-01-01') } });
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { maxAmount: 1_000_000n } });
    const today = kstDateKey();
    const ids: string[] = [];
    for (const [phone, back] of [['01011110001', 0], ['01011110002', 2]] as const) {
      const p = await seedRegisteredPayer(phone);
      const made = await createRecurringDonation({ payerId: p.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 10 });
      if (!made.ok) throw new Error(made.message);
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - back);
      await prisma.recurringDonation.update({ where: { id: made.recurring.id }, data: { nextChargeOn: d, cycleMonth: today.slice(0, 7) } });
      ids.push(made.recurring.id);
    }
    const s = await runRecurringDonations();
    expect(s.details.map((d) => d.id)).toEqual([ids[1], ids[0]]); // 나중에 만들었지만 출금일이 이틀 빠른 약정이 먼저
    // 같은 날 다시 돌아도 다시 출금하지 않는다(하루 세 번 실행)
    const again = await runRecurringDonations();
    expect(again.succeeded).toBe(0);
    expect(await prisma.charge.count({ where: { channel: 'RECURRING' } })).toBe(2);
  });
});

// ===========================================================================
describe('A-M6·A-M7·A-L1·A-L3 발송·저니', () => {
  it('A-M6: 대기열에서 멈춘 월간 안내는 원천 기록도 결과 미확인(UNKNOWN)', async () => {
    process.env.OUTBOUND_COALESCE_MINUTES = '10';
    try {
      const payer = await seedRegisteredPayer(fx.payerPhone);
      const run = await prisma.noticeRun.create({ data: { id: newId(), merchantId: fx.merchantId, monthKey: '2026-10' } });
      const delivery = await prisma.noticeDelivery.create({ data: { id: newId(), noticeRunId: run.id, payerId: payer.id, status: 'QUEUED', amount: 1000n } });
      await sendRelational({
        merchantId: fx.merchantId, payerId: payer.id, kind: 'MONTHLY_NOTICE',
        template: tpl.tplMonthlyNotice({ merchantName: '기관', month: '2026-10', amount: 1000n, count: 1, yearTotal: 1000n, link: 'https://x' }),
        sendKey: `notice:${delivery.id}`, source: 'notice', sourceId: delivery.id, precounted: false,
      });
      await prisma.outboundQueue.updateMany({ where: { sendKey: `notice:${delivery.id}` }, data: { status: 'SENDING', lockedAt: new Date(Date.now() - 20 * 60_000), lockedBy: 'dead' } });
      expect((await flushDueOutbound()).stale).toBe(1);
      expect((await prisma.noticeDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe('UNKNOWN');
      expect((await flushDueOutbound()).stale).toBe(0);
    } finally {
      process.env.OUTBOUND_COALESCE_MINUTES = '0';
    }
  });

  it('A-M7: 보내다 예외로 끝난 문자 단계는 다음 시도에서 다시 보내지 않고 "결과 미확인" 으로 남긴다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const run = await prisma.journeyRun.create({
      data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'volunteer-thanks', triggerKey: `t:${newId()}`, payerId: payer.id, subjectType: 'volunteer_activity', subjectId: 'x', context: { totalMinutes: 120 } },
    });
    await prisma.journeyStepLog.create({
      data: { id: newId(), runId: run.id, stepIndex: 0, stepKey: 'volunteer-thanks-msg', outcome: 'FAILED', sent: true, dedupeKey: journeySendKey(run.id, 'volunteer-thanks-msg'), merchantId: fx.merchantId, payerId: payer.id },
    });
    await advanceRun(run.id);
    const logs = await prisma.journeyStepLog.findMany({ where: { runId: run.id }, orderBy: { at: 'asc' } });
    expect(logs.some((l) => l.outcome === 'UNKNOWN' && l.stepKey === 'volunteer-thanks-msg')).toBe(true);
    expect(readMockOutbox(10).filter((m) => m.template === 'VOLUNTEER_THANKS')).toHaveLength(0);
  });

  it('A-L1: 봉사 전날·재개 방법 안내는 7일 상한 계산에서 빠진다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const run = await prisma.journeyRun.create({ data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'volunteer-reminder', triggerKey: `t:${newId()}`, payerId: payer.id } });
    for (const key of ['reminder', 'resume-guide', 'reminder']) {
      await prisma.journeyStepLog.create({ data: { id: newId(), runId: run.id, stepIndex: 0, stepKey: key, outcome: 'DONE', sent: true, merchantId: fx.merchantId, payerId: payer.id } });
    }
    expect(await relationalCapCount(prisma, fx.merchantId, payer.id, new Date())).toBe(0);
    await prisma.journeyStepLog.create({ data: { id: newId(), runId: run.id, stepIndex: 0, stepKey: 'thanks-letter', outcome: 'DONE', sent: true, merchantId: fx.merchantId, payerId: payer.id } });
    expect(await relationalCapCount(prisma, fx.merchantId, payer.id, new Date())).toBe(1);
    const defs = JOURNEYS.flatMap((j) => j.steps).filter((s) => s.timely).map((s) => s.key).sort();
    expect(defs).toEqual(['reminder', 'resume-guide']);
  });

  it('A-L3: 승인 기한(14일)이 지난 저니 실행은 멈추고 승인 요청도 닫힌다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const run = await prisma.journeyRun.create({
      data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'volunteer-thanks', triggerKey: `t:${newId()}`, payerId: payer.id, status: 'AWAITING_APPROVAL', stepIndex: 1 },
    });
    await prisma.approvalRequest.create({ data: { id: newId(), merchantId: fx.merchantId, kind: 'JOURNEY_STEP', title: 't', dedupeKey: `journey:${run.id}:volunteer-confirmation`, payload: {} } });
    expect(await stopExpiredJourneyApprovals()).toBe(0);
    await prisma.$executeRaw`UPDATE journey_run SET updated_at = now() - interval '15 days' WHERE id = ${run.id}`;
    expect(await stopExpiredJourneyApprovals()).toBe(1);
    expect((await prisma.journeyRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('STOPPED');
    expect((await prisma.approvalRequest.findFirstOrThrow({ where: { dedupeKey: `journey:${run.id}:volunteer-confirmation` } })).status).toBe('CANCELED');
    expect(JOURNEY_APPROVAL_TTL_DAYS).toBe(14);
  });
});

// ===========================================================================
describe('라이브 바자회 2026-11-13 조치', () => {
  let adminA: string;
  let adminB: string;

  beforeEach(async () => {
    await setLiveBazaarEnabled(true, 'admin');
    await issuer();
    adminA = await makeAdmin();
    adminB = await makeAdmin('FINANCE');
    await applyParticipation(fx.merchantId, { consignmentName: '담당자', agree: true });
    await decideParticipation(fx.merchantId, 'APPROVED', adminA);
  });

  async function giver() {
    return registerGiver({
      donorType: 'CORPORATE', email: `corp-${newId()}@test.kr`, password: 'x', passwordHash: 'x',
      displayName: '(주)나눔상사', contactName: '홍담당', phone: '010-2222-3333', businessNo: '220-81-12341', representativeName: '나대표', address: '서울',
    });
  }
  async function toPledged(qty = 10) {
    const g = await giver();
    const donationId = await createDonation(g.donorId, g.userId, {
      matchMode: 'DESIGNATED', brandPublic: false, unsoldAction: 'RETURN', deliveryMethod: 'SEND', preferredMerchantId: fx.merchantId,
      items: [{ name: '수건 세트', category: '생활용품', quantity: qty, condition: 'NEW', declaredUnitValue: 10000 }],
    });
    const m = await prisma.inKindMatch.findFirstOrThrow({ where: { donationId } });
    await respondMatch(fx.merchantId, m.id, true, fx.merchantUserId);
    const v = await prisma.inKindValuation.findFirstOrThrow({ where: { donationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    await acceptValuation(donationId, { type: 'MERCHANT', userId: fx.merchantUserId, merchantId: fx.merchantId }, v.id);
    await pledgeDonation(g.donorId, donationId, g.userId, { name: '홍담당', agree: true });
    const item = await prisma.inKindItem.findFirstOrThrow({ where: { donationId } });
    return { g, donationId, item };
  }
  const inbound = (item: { id: string }, qty: number, extra: Partial<Parameters<typeof registerInbound>[2]> = {}) => ({
    warehouse: '센터', receivedAt: new Date(), result: 'PASS' as const, items: [{ itemId: item.id, receivedQty: qty, acceptedQty: qty }], returnCost: 0n, returnCostBearer: 'NONE' as const, ...extra,
  });

  it('B-M3: 사업자등록번호 검증 숫자', () => {
    expect(isValidBusinessNo('2208112341')).toBe(true);
    expect(isValidBusinessNo('2208112345')).toBe(false);
    expect(isValidBusinessNo('1248100998')).toBe(true);
  });

  it('B-H1: 입고일은 오늘 이후·약정일 이전 불가, 올해가 아니면 연도 확인 필요', async () => {
    const { donationId, item } = await toPledged();
    const tomorrow = new Date(Date.now() + 2 * 86_400_000);
    await expect(registerInbound(donationId, adminA, inbound(item, 10, { receivedAt: tomorrow }))).rejects.toThrow(/오늘 이후/);
    await expect(registerInbound(donationId, adminA, inbound(item, 10, { receivedAt: new Date(Date.now() - 400 * 86_400_000) }))).rejects.toThrow(/약정일/);
    expect(() => assertInboundDate(new Date('2025-06-01T03:00:00Z'), new Date('2025-01-01T00:00:00Z'), { now: new Date('2026-01-05T00:00:00Z') })).toThrow(/연도 확인/);
    expect(() => assertInboundDate(new Date('2025-06-01T03:00:00Z'), new Date('2025-01-01T00:00:00Z'), { now: new Date('2026-01-05T00:00:00Z'), yearConfirmed: true })).not.toThrow();
  });

  it('B-H1: 확정 뒤 입고일 정정 → 영수증 정정 필요(DATE) → 무효·재발급하면 새 기부일, 정정 전에는 종결 불가', async () => {
    const { donationId, item } = await toPledged();
    await registerInbound(donationId, adminA, inbound(item, 10));
    const receipt = await confirmInspection(fx.merchantId, donationId, fx.merchantUserId);
    expect(await receiptCorrectionNeeded(donationId)).toBeNull();
    const pledgedAt = (await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId } })).pledgedAt!;
    // 약정일과 같은 날로 정정(오늘과 다르게 만들 수 없으면 건너뛴다 — 오늘 약정했으므로 같은 날짜)
    await expect(correctInboundDate(donationId, adminA, new Date(), '테스트')).rejects.toThrow(/같습니다/);
    await expect(correctInboundDate(donationId, adminA, new Date(Date.now() + 3 * 86_400_000), '테스트')).rejects.toThrow(/오늘 이후/);
    // 약정일을 과거로 옮겨 놓고 과거 날짜로 정정
    await prisma.inKindDonation.update({ where: { id: donationId }, data: { pledgedAt: new Date(pledgedAt.getTime() - 10 * 86_400_000) } });
    const r = await correctInboundDate(donationId, adminA, new Date(Date.now() - 5 * 86_400_000), '입고일 오입력');
    expect(r.receiptCorrection).toBe(true);
    const fix = await receiptCorrectionNeeded(donationId);
    expect(fix?.reason).toBe('DATE');
    // 판매 종료까지 진행 후 종결 시도 → 정정 필요로 거절
    const p = await prisma.bazaarProduct.findFirstOrThrow({ where: { donationId } });
    await endProduct(p.id, adminA, 'MERCHANT_USE');
    await expect(closeDonation(donationId, adminA)).rejects.toThrow(/입고일이 정정/);
    await voidInKindReceipt(receipt.id, adminA, '입고일 정정');
    const again = await reissueInKindReceipt(donationId, adminA);
    expect(kstDateKey(again.donatedAt)).toBe(r.after);
    expect(await receiptCorrectionNeeded(donationId)).toBeNull();
    await closeDonation(donationId, adminA);
  });

  it('B-L4: 합격으로 고르고 합격 수량이 약정보다 적으면 거절, 지난 일시 편성 거절', async () => {
    const { donationId, item } = await toPledged();
    await expect(registerInbound(donationId, adminA, { ...inbound(item, 10), items: [{ itemId: item.id, receivedQty: 10, acceptedQty: 8 }] })).rejects.toThrow(/일부 합격/);
    await registerInbound(donationId, adminA, { ...inbound(item, 10), result: 'PARTIAL', items: [{ itemId: item.id, receivedQty: 10, acceptedQty: 8 }] });
    await saveSeller({ name: '셀러', sellerbricksId: 's1' });
    const seller = await prisma.bazaarSeller.findFirstOrThrow();
    await expect(createLive(adminA, { merchantId: fx.merchantId, sellerId: seller.id, title: '방송', scheduledAt: new Date(Date.now() - 3_600_000), productIds: [] })).rejects.toThrow(/지났습니다/);
    await createLive(adminA, { merchantId: fx.merchantId, sellerId: seller.id, title: '방송', scheduledAt: new Date(Date.now() + 3_600_000), productIds: [] });
    expect(await prisma.notification.count({ where: { title: '바자회 방송 편성 승인 요청' } })).toBe(1);
  });

  it('B-M2: 단계 알림 — 매칭 제안(기관)·가액 제안(기부자 문자)·약정·검수 확정 필요·영수증(기부자 문자)', async () => {
    const g = await giver();
    const donationId = await createDonation(g.donorId, g.userId, {
      matchMode: 'DESIGNATED', brandPublic: false, unsoldAction: 'RETURN', deliveryMethod: 'SEND', preferredMerchantId: fx.merchantId,
      items: [{ name: '수건 세트', category: '생활용품', quantity: 5, condition: 'NEW', declaredUnitValue: 10000 }],
    });
    expect(await prisma.notification.count({ where: { userId: fx.merchantUserId, title: '현물 기부 매칭 제안이 왔습니다' } })).toBe(1);
    const m = await prisma.inKindMatch.findFirstOrThrow({ where: { donationId } });
    await respondMatch(fx.merchantId, m.id, true, fx.merchantUserId);
    const item = await prisma.inKindItem.findFirstOrThrow({ where: { donationId } });
    await proposeValuation(donationId, { type: 'MERCHANT', userId: fx.merchantUserId, merchantId: fx.merchantId }, { [item.id]: '8000' });
    expect(readMockOutbox(20).filter((x) => x.template === 'BAZAAR_VALUATION')).toHaveLength(1);
    const v = await prisma.inKindValuation.findFirstOrThrow({ where: { donationId, kind: 'COUNTER' } });
    await acceptValuation(donationId, { type: 'DONOR', userId: g.userId, donorId: g.donorId }, v.id);
    expect(readMockOutbox(20).filter((x) => x.template === 'BAZAAR_PLEDGE_REQUEST')).toHaveLength(1);
    await pledgeDonation(g.donorId, donationId, g.userId, { name: '홍담당', agree: true });
    expect(await prisma.notification.count({ where: { title: '현물 기부 약정 — 입고 대기' } })).toBe(1); // 최고관리자(adminA)에게만
    await registerInbound(donationId, adminA, inbound(item, 5));
    expect(await prisma.notification.count({ where: { userId: fx.merchantUserId, title: '검수 확정이 필요합니다' } })).toBe(1);
    await confirmInspection(fx.merchantId, donationId, fx.merchantUserId);
    expect(readMockOutbox(30).filter((x) => x.template === 'BAZAAR_RECEIPT_ISSUED')).toHaveLength(1);
    expect(readMockOutbox(30).find((x) => x.template === 'BAZAAR_RECEIPT_ISSUED')!.text).toContain('40,000원');
  });

  it('B-M1·B-M4·B-L6·B-M5: 판매금액은 배송비 제외, 종료 상품은 판매 불가(환불만), 이번 달 확정은 사유 필요, 지난달 집계 자동', async () => {
    expect(amountMismatch(10, 80000n, 5000n, 3000n)).toBe(false); // 상품 대금 50,000 의 2배 안
    expect(amountMismatch(10, 110000n, 5000n, 3000n)).toBe(true); // 예전: (5000+3000)×10×2 = 160,000 까지 받음
    const { donationId, item } = await toPledged();
    await registerInbound(donationId, adminA, inbound(item, 10));
    await confirmInspection(fx.merchantId, donationId, fx.merchantUserId);
    const p = await prisma.bazaarProduct.findFirstOrThrow({ where: { donationId } });
    await updateProduct(p.id, { name: p.name, salePrice: 10000, shippingFee: 3000, quantity: 10, perPersonLimit: 5 });
    await markProductListed(p.id, adminA);
    const row = (soldQty: number, gross: bigint, refundQty = 0, refund = 0n) => ({ trackingCode: p.trackingCode, soldQty, grossAmount: gross, refundQty, refundAmount: refund, returnCost: 0n, returnBearer: 'NONE' as const });
    const b1 = await createSaleBatch(adminA, { title: '1회', source: 'MANUAL', rows: [row(3, 30000n)] });
    // 승인 대기 판매가 있으면 어떤 방식으로도 종료하지 않는다
    await expect(endProduct(p.id, adminA, 'MERCHANT_USE')).rejects.toThrow(/승인 대기/);
    await approveSaleBatch(b1, { userId: adminB, superAdmin: false });
    await endProduct(p.id, adminA, 'MERCHANT_USE');
    await expect(createSaleBatch(adminA, { title: '늦은 판매', source: 'MANUAL', rows: [row(1, 10000n)] })).rejects.toThrow(/판매가 종료된/);
    await createSaleBatch(adminA, { title: '환불', source: 'MANUAL', rows: [row(0, 0n, 1, 10000n)] }); // 환불만은 받는다

    const month = kstMonthKey();
    await generateSettlements(month);
    const s = await prisma.bazaarSettlement.findFirstOrThrow({ where: { month } });
    await expect(confirmSettlement(s.id, adminA)).rejects.toThrow(/끝나지 않은 달/);
    // 다음 달 1일: 지난달 집계 자동 생성(DRAFT 그대로) + 확정 필요 알림 1회, 그러면 사유 없이 확정 가능
    const firstOfNext = new Date(`${nextMonth(month)}-01T02:00:00Z`);
    const auto = await runBazaarSettlementAutomation(firstOfNext);
    expect(auto.generatedMonth).toBe(month);
    expect((await runBazaarSettlementAutomation(firstOfNext)).generatedMonth).toBe(month);
    expect(await prisma.notification.count({ where: { title: `${month} 현물 판매 정산 집계 — 확정 필요` } })).toBe(1);
    const r = await confirmSettlement(s.id, adminA, { now: firstOfNext });
    expect(r.status).toBe('CONFIRMED');
    expect(await prisma.notification.count({ where: { userId: fx.merchantUserId, title: '현물 판매 정산 안내' } })).toBe(1);
    // 지급일(다음 달 지정일)이 지나면 정산마다 1회 알림
    const late = new Date(`${nextMonth(nextMonth(month))}-01T02:00:00Z`);
    expect((await runBazaarSettlementAutomation(late)).dueAlerts).toBe(1);
    expect((await runBazaarSettlementAutomation(late)).dueAlerts).toBe(0);
  });

  it('B-L5: 참여를 정지하면 진행 중 기부 건 수를 알려 준다', async () => {
    await toPledged();
    const r = await decideParticipation(fx.merchantId, 'SUSPENDED', adminA, '점검');
    expect(r.inProgress).toBe(1);
  });
});
