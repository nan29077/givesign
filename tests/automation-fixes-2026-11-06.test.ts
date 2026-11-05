import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import fs from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { tokenHash } from '@/lib/crypto';
import { readMockOutbox, setMockMtFailure } from '@/server/adapters/mt';
import { newObjectName, putObject, getObject, PRIVATE_DIR } from '@/server/uploads';
import { CRON_JOBS } from '@/server/cron-registry';
import {
  processDomainEvents, emitDomainEvent, registerConsumer, unregisterConsumer, EVENT_LEASE_MS, DOMAIN_EVENT_TYPES,
} from '@/server/services/events';
import { registerDefaultConsumers, handleMerchantAlert } from '@/server/services/event-consumers';
import {
  decideApproval, requestApproval, recoverStaleApprovals, runQueuedApprovals, retryFailedApproval, registerApprovalHandler,
  APPROVAL_STALE_PROCESSING_MS, APPROVAL_RUN_LEASE_MS,
} from '@/server/services/approvals';
import { upsertReceiptProfile, issueReceipt, issueReceiptsBulk } from '@/server/services/receipts';
import { runAnnualReceiptPrep, emitYearClosedForMonthly } from '@/server/services/receipt-batch';
import { inboxItems } from '@/server/services/inbox';
import { advanceRun, advanceDueJourneyRuns, saveJourneySetting, JOURNEY_WEEKLY_SEND_CAP } from '@/server/services/journeys';
import { journeySendKey, JOURNEY_LEASE_MS } from '@/server/services/journeys/engine';
import { emitShiftReminders } from '@/server/services/journeys/reminders';
import { reconcileUnknownPayment } from '@/server/services/payment-reconcile';
import { requestRefund, approveRefund } from '@/server/services/refund';
import { createRecurringDonation, updateRecurringDonation, runRecurringDonations } from '@/server/services/recurring';
import { AGREEMENT_CHANGES_PER_DAY, issueRecurringAgreement } from '@/server/services/agreements';
import { issuePurposeDocument } from '@/server/services/purpose-documents';
import { ensureDefaultPurposeTemplates } from '@/server/services/purpose-templates';
import {
  closeDocumentsForWithdrawnPayer, loadIssuedByToken, resendIssuedDocument, IssuedDocumentError,
} from '@/server/services/issued-documents';
import {
  accessProof, cancelEnvelope, declineAsSigner, expireEDocEnvelopes, readSnapshot, readSnapshotPdfBytes, reconcileClosedEnvelopes, snapshotPdfHref,
} from '@/server/services/edoc';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, setChargeAmount, type Fixture } from './helpers';

/**
 * 2026-11-06 정밀 점검(후원 자동화) 조치 회귀 테스트 — A-1~A-4, A-M1~A-M7, 자동화 낮음.
 * 특히 "동시에 일어남 / 도중에 멈춤 / 재시작" 시나리오를 고정한다(보고서 8항).
 */

const singleBackend = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${process.env.PGLITE_PORT ?? '5463'}/`);
const DAY = 86_400_000;
const kstYear = () => Number(new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 4));

let fx: Fixture;
let payerId: string;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  registerDefaultConsumers();
  payerId = (await seedRegisteredPayer(fx.payerPhone)).id;
  for (const t of ['RECEIPT_ISSUANCE', 'RECURRING_DEBIT', 'VOLUNTEER_PRIVACY'] as const) {
    await prisma.termsVersion.create({
      data: { id: newId(), type: t, version: '1.0', title: `${t} 동의`, content: `${t} 본문`, required: false, effectiveFrom: new Date('2026-01-01') },
    });
  }
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { maxAmount: 1_000_000n, representativeName: '김대표' } });
});

async function pay(amount: bigint) {
  setChargeAmount(amount);
  const r = await inboundAndPay(moPayload({ from: fx.payerPhone, to: fx.moNumber, text: '후원' }), fx.merchantId);
  setChargeAmount(null);
  return r;
}

async function makeIssuer(cycle: 'YEARLY' | 'MONTHLY' = 'YEARLY') {
  await prisma.merchantProfile.update({
    where: { id: fx.merchantId },
    data: {
      businessNo: '123-82-00001', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true,
      designatedDoneeVerifiedAt: new Date(), orgType: 'WELFARE_CORPORATION', receiptCycle: cycle,
    },
  });
}

/** 지난해 결제된 것으로 옮긴다(영수증 귀속 연도) */
async function moveChargesToLastYear() {
  const last = kstYear() - 1;
  await prisma.charge.updateMany({ where: { merchantId: fx.merchantId }, data: { paidAt: new Date(`${last}-06-15T03:00:00Z`) } });
  return last;
}

// ---------------------------------------------------------------------------
describe('A-1 승인 처리 정체 복구 · 영수증 일괄 발급은 배치가 나눠 실행', () => {
  it('PROCESSING 이 15분 넘게 남으면(서버 액션 중단) 승인 대기로 되돌리고 대기함에 다시 보인다', async () => {
    const { request } = await requestApproval({ merchantId: fx.merchantId, kind: 'JOURNEY_STEP', title: '멈춘 요청', dedupeKey: 'stuck:1' });
    // 승인 처리 도중 프로세스가 죽은 상태
    await prisma.approvalRequest.update({ where: { id: request.id }, data: { status: 'PROCESSING' } });
    let box = await inboxItems(fx.merchantId);
    expect(box.actions.some((a) => a.approvalId === request.id)).toBe(false);
    expect(box.waiting.some((w) => w.key === `approval-run:${request.id}`)).toBe(true);

    expect(await recoverStaleApprovals(new Date())).toBe(0); // 아직 15분 전
    expect(await recoverStaleApprovals(new Date(Date.now() + APPROVAL_STALE_PROCESSING_MS + 60_000))).toBe(1);
    const back = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(back.status).toBe('PENDING');
    expect(back.error).toContain('중단');
    box = await inboxItems(fx.merchantId);
    expect(box.actions.some((a) => a.approvalId === request.id)).toBe(true);
  });

  it('연간 준비 → 승인은 QUEUED 로만 기록 → 배치가 시간 상한마다 나눠 발급, 재시작해도 이어서 한 번씩', async () => {
    await makeIssuer('YEARLY');
    // 후원자 3명, 각자 영수증 정보 등록
    const payers = [payerId];
    for (const phone of ['01022223333', '01044445555']) payers.push((await seedRegisteredPayer(phone)).id);
    for (const [i, p] of payers.entries()) {
      const saved = await upsertReceiptProfile(p, { legalName: `홍길동${i}`, residentNo: ['900101-1234568', '850505-1012344', '770707-1456785'][i]!, hometaxOptIn: true });
      expect(saved.ok).toBe(true);
      await prisma.charge.create({
        data: {
          id: newId(), transactionNo: `TRD-T${i}${newId().slice(-6)}`, merchantId: fx.merchantId, payerId: p, amount: 10000n, displayName: '후원자', message: '',
          status: 'SETTLED', paidAt: new Date(`${kstYear() - 1}-05-0${i + 1}T03:00:00Z`), channel: 'WEB',
        },
      });
    }
    const jan = new Date(`${kstYear()}-01-10T01:00:00Z`);
    const prep = await runAnnualReceiptPrep(jan);
    expect(prep.requested).toBe(1);
    const req = await prisma.approvalRequest.findFirstOrThrow({ where: { kind: 'RECEIPT_BATCH' } });
    const out = await decideApproval({ merchantId: fx.merchantId, id: req.id, decision: 'APPROVE', userId: fx.merchantUserId });
    expect(out.ok).toBe(true);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('QUEUED');
    expect(await prisma.donationReceipt.count()).toBe(0);
    // 대기 중이면 연간 준비가 새 요청을 쌓지 않는다(QUEUED 포함)
    expect((await runAnnualReceiptPrep(new Date(jan.getTime() + 8 * DAY))).requested).toBe(0);

    // 1회차: 시계가 한 명 발급하고 나면 상한을 넘긴다(시간 초과로 중간에 멈춤)
    // 시계: 첫 사람을 발급한 뒤(발급 루프의 두 번째 확인부터) 상한을 넘긴다
    let ticks = 0;
    const slow = () => new Date(Date.now() + (ticks++ >= 5 ? 10 * 60_000 : 0));
    let r = await runQueuedApprovals({ now: slow, budgetMs: 60_000 });
    expect(r.partial).toBe(1);
    const afterFirst = await prisma.donationReceipt.count();
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    expect(afterFirst).toBeLessThan(3);
    let row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('QUEUED');
    expect(row.lockedBy).toBeNull();
    expect(row.result).toContain('발급 중');
    expect(await inboxItems(fx.merchantId).then((b) => b.waiting.some((w) => w.key === `approval-run:${req.id}` && w.kindLabel.includes('승인됨')))).toBe(true);

    // 2회차(다음 배치): 남은 사람만 이어서 발급하고 끝낸다
    r = await runQueuedApprovals();
    expect(r.done).toBe(1);
    expect(await prisma.donationReceipt.count()).toBe(3);
    row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('APPROVED');
    expect(row.result).toContain('3건 발급');
    // 다시 돌려도 더 발급하지 않는다
    await runQueuedApprovals();
    expect(await prisma.donationReceipt.count()).toBe(3);
    expect(await prisma.charge.count({ where: { receiptId: null } })).toBe(0);
  });

  it('실행 중 선점(임대)이 살아 있으면 다른 배치가 잡지 않고, 만료되면(재시작) 이어서 잡는다', async () => {
    const calls: string[] = [];
    registerApprovalHandler('DOCUMENT_SEND', {
      async onApprove() { return 'x'; },
      async execute(_req, ctx) {
        calls.push(String(ctx.state.n ?? 0));
        return { done: true, message: '끝', state: { n: 1 } };
      },
    });
    const { request } = await requestApproval({ merchantId: fx.merchantId, kind: 'DOCUMENT_SEND', title: '문서 일괄', dedupeKey: 'ds:1' });
    await decideApproval({ merchantId: fx.merchantId, id: request.id, decision: 'APPROVE', userId: fx.merchantUserId });
    // 앞선 배치가 방금 잡고 죽은 상태
    await prisma.approvalRequest.update({ where: { id: request.id }, data: { lockedAt: new Date(), lockedBy: 'dead' } });
    expect((await runQueuedApprovals()).picked).toBe(0);
    await prisma.approvalRequest.update({ where: { id: request.id }, data: { lockedAt: new Date(Date.now() - APPROVAL_RUN_LEASE_MS - 1000) } });
    expect((await runQueuedApprovals()).done).toBe(1);
    expect(calls).toEqual(['0']);
  });

  it('실행이 계속 실패하면 FAILED 로 막힌 일에 보이고, 다시 실행할 수 있다', async () => {
    let fail = true;
    registerApprovalHandler('VOLUNTEER_CERTIFICATE', {
      async onApprove() { return 'x'; },
      async execute() {
        if (fail) throw new Error('일시 오류');
        return { done: true, message: '완료', state: {} };
      },
    });
    const { request } = await requestApproval({ merchantId: fx.merchantId, kind: 'VOLUNTEER_CERTIFICATE', title: '확인서', dedupeKey: 'vc:1' });
    await decideApproval({ merchantId: fx.merchantId, id: request.id, decision: 'APPROVE', userId: fx.merchantUserId });
    for (let i = 0; i < 5; i++) await runQueuedApprovals();
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('FAILED');
    const box = await inboxItems(fx.merchantId);
    expect(box.blocked.find((b) => b.retryApprovalId === request.id)?.error).toContain('일시 오류');
    fail = false;
    await retryFailedApproval(fx.merchantId, request.id);
    await runQueuedApprovals();
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('APPROVED');
  });

  it('[낮음] 처리기는 끝났는데 결과 기록만 실패해도 PENDING 으로 되돌리지 않는다(다시 눌러 영구 대기 방지)', async () => {
    let n = 0;
    registerApprovalHandler('SUPPORTER_MERGE', {
      async onApprove() {
        n += 1;
        // 처리기가 끝난 직후 다른 경로가 행을 바꿔 결과 기록이 조건부로 빗나간 상황
        await prisma.approvalRequest.updateMany({ where: { dedupeKey: 'sm:1' }, data: { status: 'APPROVED' } });
        return '병합했습니다';
      },
    });
    const { request } = await requestApproval({ merchantId: fx.merchantId, kind: 'SUPPORTER_MERGE', title: '병합', dedupeKey: 'sm:1' });
    const out = await decideApproval({ merchantId: fx.merchantId, id: request.id, decision: 'APPROVE', userId: fx.merchantUserId });
    expect(out).toMatchObject({ ok: true, message: '병합했습니다' });
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('APPROVED');
    expect(n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('A-2 · A-M5 관리자 수동 확정에도 charge.paid, payload 에 이름 없음', () => {
  it('결과 미확인 → 관리자 승인 확정: 같은 트랜잭션에 charge.paid 1건, 기관 알림·저니가 돈다', async () => {
    await pay(10000n);
    const charge = await prisma.charge.findFirstOrThrow();
    // 정상 경로가 남긴 이벤트를 지우고(결과 미확인으로 승인 기록이 없었던 상황) 결과 미확인으로 되돌린다.
    await prisma.domainEvent.deleteMany({});
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { chargeId: charge.id } });
    await prisma.paymentTransaction.update({ where: { id: txn.id }, data: { status: 'UNKNOWN' } });
    await prisma.charge.update({ where: { id: charge.id }, data: { status: 'PENDING_PAYMENT' } });

    const r = await reconcileUnknownPayment(txn.id, 'APPROVE', '결제사 원장 확인');
    expect(r.ok).toBe(true);
    const evs = await prisma.domainEvent.findMany({ where: { type: 'charge.paid', subjectId: charge.id } });
    expect(evs).toHaveLength(1);
    const payload = evs[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ amount: '10000', channel: charge.channel, reconciled: true, recurring: false });
    expect(payload).not.toHaveProperty('payerLabel');
    expect(JSON.stringify(payload)).not.toContain(charge.displayName);

    await processDomainEvents();
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: fx.merchantUserId, title: { startsWith: '새 후원' } } });
    expect(note.body).toContain(`${charge.displayName}님`);
    expect(await prisma.journeyRun.count({ where: { journeyKey: 'donation-thanks', subjectId: charge.id } })).toBe(1);
  });

  it('정상 결제 경로의 payload 에도 이름이 없고, 익명 후원은 기관 알림에 "익명의 후원자"', async () => {
    await pay(10000n);
    const charge = await prisma.charge.findFirstOrThrow();
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type: 'charge.paid' } });
    expect(ev.payload as Record<string, unknown>).not.toHaveProperty('payerLabel');
    await prisma.charge.update({ where: { id: charge.id }, data: { anonymous: true } });
    await handleMerchantAlert({ ...ev, payload: ev.payload as Record<string, unknown> });
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: fx.merchantUserId } });
    expect(note.body).toContain('익명의 후원자');
    expect(note.body).not.toContain(charge.displayName);
  });
});

// ---------------------------------------------------------------------------
describe('A-3 선점 시각 = 잡는 순간, 배치 시간 상한, 문자 단계 발송 중복 키', () => {
  it('events 배치 잠금 TTL 은 이벤트·저니 선점 유지 시간 이상이다', () => {
    const ev = CRON_JOBS.find((j) => j.name === 'events')!;
    expect(ev.lockTtlSec * 1000).toBeGreaterThanOrEqual(EVENT_LEASE_MS);
    expect(ev.lockTtlSec * 1000).toBeGreaterThanOrEqual(JOURNEY_LEASE_MS);
  });

  it('오래 걸린 배치가 늦게 잡은 이벤트도 선점 시각은 잡는 순간 — 다음 배치가 가로채지 않는다', async () => {
    const handled: string[] = [];
    registerConsumer({
      name: 'test-slow',
      types: ['volunteer.approved'],
      async handle(ev) {
        handled.push(ev.subjectId);
      },
    });
    try {
      for (const id of ['S1', 'S2']) await emitDomainEvent({ merchantId: fx.merchantId, type: 'volunteer.approved', subjectType: 'x', subjectId: id });
      await prisma.domainEvent.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 10 * 60_000) } });
      // 배치 A 가 6분 전에 시작했다고 보고(시작 시각 now = 6분 전) 두 번째 이벤트를 잡는 순간까지 진행
      const started = new Date(Date.now() - 6 * 60_000);
      const a = await processDomainEvents({ now: started, limit: 1 });
      expect(a.claimed).toBe(1);
      // 남은 이벤트를 A 가 "지금" 잡았다고 가정: 선점 시각이 now(6분 전) 였다면 B 에게 만료로 보인다.
      const second = await prisma.domainEvent.findFirstOrThrow({ where: { subjectId: 'S2' } });
      await prisma.domainEvent.update({ where: { id: second.id }, data: { lockedAt: new Date(), lockedBy: 'batch-A' } });
      const b = await processDomainEvents();
      expect(b.claimed).toBe(0);
      expect(handled).toEqual(['S1']);
      // 잡힌 행의 선점 시각은 배치 시작(6분 전)이 아니라 잡은 순간이다
      const first = await prisma.domainEventDelivery.findFirst({ where: { consumer: 'test-slow' } });
      expect(first).not.toBeNull();
    } finally {
      unregisterConsumer('test-slow');
    }
  });

  it('processDomainEvents 는 시작 시각을 넘겨받아도 잡는 순간의 시각으로 선점한다', async () => {
    let seen: Date | null = null;
    registerConsumer({
      name: 'test-lease',
      types: ['volunteer.rejected'],
      async handle(ev) {
        seen = (await prisma.domainEvent.findUniqueOrThrow({ where: { id: ev.id } })).lockedAt;
      },
    });
    try {
      await emitDomainEvent({ merchantId: fx.merchantId, type: 'volunteer.rejected', subjectType: 'x', subjectId: 'L1' });
      await prisma.domainEvent.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 10 * 60_000) } });
      const start = new Date(Date.now() - 4 * 60_000);
      await new Promise((r) => setTimeout(r, 30));
      await processDomainEvents({ now: start });
      expect(seen).not.toBeNull();
      // 4분 전 시작 시각 + 실제 흐른 시간 → 시작 시각보다 늦다
      expect(seen!.getTime()).toBeGreaterThan(start.getTime());
    } finally {
      unregisterConsumer('test-lease');
    }
  });

  it('시간 상한을 넘기면 새 이벤트를 더 잡지 않는다(남은 것은 다음 배치)', async () => {
    for (const id of ['B1', 'B2', 'B3']) await emitDomainEvent({ merchantId: fx.merchantId, type: 'volunteer.approved', subjectType: 'x', subjectId: id });
    const r = await processDomainEvents({ budgetMs: 0 });
    expect(r.claimed).toBe(0);
    expect((await processDomainEvents()).claimed).toBe(3);
  });

  it('같은 실행이 겹치거나(만료된 선점 재획득) 재시작돼도 문자 단계는 한 번만 나간다', async () => {
    const shiftAt = new Date(Date.now() + 2 * DAY);
    const posting = await prisma.volunteerPosting.create({
      data: {
        id: newId(), merchantId: fx.merchantId, title: '봉사', interest: '돌봄', description: 'd', place: '복지관',
        recruitFrom: new Date(Date.now() - DAY), recruitTo: new Date(Date.now() + 5 * DAY), status: 'OPEN', createdBy: fx.merchantUserId,
      },
    });
    const shift = await prisma.volunteerShift.create({
      data: { id: newId(), postingId: posting.id, merchantId: fx.merchantId, shiftDate: shiftAt, startTime: '10:00', endTime: '12:00', startsAt: shiftAt, endsAt: new Date(shiftAt.getTime() + 7_200_000), capacity: 5, appliedCount: 1 },
    });
    const app = await prisma.volunteerApplication.create({ data: { id: newId(), merchantId: fx.merchantId, payerId, status: 'APPROVED', postingId: posting.id, shiftId: shift.id } });
    await emitDomainEvent({
      merchantId: fx.merchantId, type: 'volunteer.shift_reminder_due', subjectType: 'volunteer_application', subjectId: app.id, payerId,
      payload: { shiftId: shift.id, schedule: '내일 10:00 복지관', startsAt: shiftAt.toISOString() },
    });
    // 첫 실행이 발송 직후 죽었다: 예약 행(SENDING)만 남고 실행은 RUNNING(선점 만료)
    setMockMtFailure(null);
    await processDomainEvents();
    const run = await prisma.journeyRun.findFirstOrThrow({ where: { journeyKey: 'volunteer-reminder' } });
    expect(run.status).toBe('DONE');
    expect(await prisma.journeyStepLog.count({ where: { dedupeKey: journeySendKey(run.id, 'reminder') } })).toBe(1);
    // 같은 실행을 "멈춘 실행" 으로 되살려 다시 진행(재시작·가로채기)
    await prisma.journeyRun.update({ where: { id: run.id }, data: { status: 'RUNNING', stepIndex: 0, lockedAt: new Date(Date.now() - JOURNEY_LEASE_MS - 1000), lockedBy: 'dead' } });
    await advanceRun(run.id);
    expect(readMockOutbox(20).filter((m) => m.template === 'VOLUNTEER_REMINDER')).toHaveLength(1);
    const logs = await prisma.journeyStepLog.findMany({ where: { runId: run.id, stepKey: 'reminder' } });
    expect(logs.filter((l) => l.sent)).toHaveLength(1);
    expect(logs.some((l) => l.detail === '이미 보낸 단계')).toBe(true);
  });

  it.skipIf(singleBackend)('[낮음] 7일 3건 상한은 동시에 도는 실행끼리도 넘지 않는다(후원자 단위 잠금)', async () => {
    // 이미 2건 보낸 상태
    for (let i = 0; i < JOURNEY_WEEKLY_SEND_CAP - 1; i++) {
      const r = await prisma.journeyRun.create({ data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'recurring-resume', triggerKey: `old:${i}`, payerId, status: 'DONE' } });
      await prisma.journeyStepLog.create({ data: { id: newId(), runId: r.id, stepIndex: 0, stepKey: 'resume-guide', outcome: 'DONE', sent: true, merchantId: fx.merchantId, payerId } });
    }
    await prisma.recurringDonation.create({
      data: { id: newId(), merchantId: fx.merchantId, payerId, amount: 10000n, dayOfMonth: 10, status: 'SUSPENDED', nextChargeOn: new Date(), cycleMonth: '2026-11' },
    });
    const runs = await Promise.all(
      ['C1', 'C2', 'C3'].map((k) =>
        prisma.journeyRun.create({ data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'recurring-resume', triggerKey: `cap:${k}`, payerId, stepIndex: 1, status: 'WAITING', context: {} } }),
      ),
    );
    await Promise.all(runs.map((r) => advanceRun(r.id)));
    const sent = await prisma.journeyStepLog.count({ where: { merchantId: fx.merchantId, payerId, sent: true } });
    expect(sent).toBe(JOURNEY_WEEKLY_SEND_CAP);
    expect(readMockOutbox(20).filter((m) => m.template === 'RECURRING_RESUME_GUIDE')).toHaveLength(1);
  });

  it('[낮음] 단계를 넘어가면 보류 횟수를 0 으로 되돌린다', async () => {
    await makeIssuer();
    const run = await prisma.journeyRun.create({
      data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'donation-thanks', triggerKey: 'def:1', payerId, stepIndex: 1, status: 'WAITING', context: { amount: '1000', deferrals: 9 } },
    });
    await advanceRun(run.id);
    const after = await prisma.journeyRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.stepIndex).toBe(2);
    expect((after.context as { deferrals?: number }).deferrals ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('A-4 연말 감사장 — 연 1회 발급 기관만 영수증 발급 때, 매월 발급 기관은 한 해 마감 때 한 번', () => {
  it('연 1회 기관: 지난해 영수증 발급 → 감사장에 영수증 번호가 채워진다', async () => {
    await makeIssuer('YEARLY');
    await pay(30000n);
    const last = await moveChargesToLastYear();
    await upsertReceiptProfile(payerId, { legalName: '홍길동', residentNo: '900101-1234568', hometaxOptIn: true });
    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId, taxYear: last, issuedBy: 'SYSTEM', silent: true });
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type: 'receipt.issued' } });
    expect(ev.payload).toMatchObject({ receiptNo: receipt.receiptNo, receiptCycle: 'YEARLY' });
    await processDomainEvents();
    const doc = await prisma.issuedDocument.findFirstOrThrow({ where: { purpose: 'YEAR_END_THANKS' } });
    const { readIssuedSnapshot } = await import('@/server/services/issued-documents');
    const snap = readIssuedSnapshot(doc).snapshot!;
    expect(snap.body).toContain(`기부금영수증(${receipt.receiptNo})`);
    expect(snap.missing).not.toContain('영수증번호');
  });

  it('매월 발급 기관: 월별 영수증으로는 시작하지 않고, 지난해 결제가 모두 발급된 뒤 한 해 합계로 한 번', async () => {
    await makeIssuer('MONTHLY');
    await pay(10000n);
    await pay(20000n);
    const last = await moveChargesToLastYear();
    // 12월분이 남아 있는 상태로 한 장만 발급(월별) — 두 번째 결제는 아직 미발급
    const charges = await prisma.charge.findMany({ orderBy: { createdAt: 'asc' } });
    await prisma.charge.update({ where: { id: charges[1]!.id }, data: { paidAt: new Date(`${last}-12-20T03:00:00Z`) } });
    await upsertReceiptProfile(payerId, { legalName: '홍길동', residentNo: '900101-1234568', hometaxOptIn: true });
    // 6월분만 먼저(12월분은 receiptId 묶기를 피하려고 잠시 상태를 바꿨다 되돌린다)
    await prisma.charge.update({ where: { id: charges[1]!.id }, data: { status: 'REFUND_REQUESTED' } });
    const first = await issueReceipt({ merchantId: fx.merchantId, payerId, taxYear: last, issuedBy: 'SYSTEM', silent: true });
    await prisma.charge.update({ where: { id: charges[1]!.id }, data: { status: 'SETTLED' } });
    await processDomainEvents();
    expect(await prisma.issuedDocument.count({ where: { purpose: 'YEAR_END_THANKS' } })).toBe(0);
    // 아직 마감 안 됨(12월분 미발급) → 이벤트 없음
    expect(await emitYearClosedForMonthly(last)).toBe(0);

    const second = await issueReceipt({ merchantId: fx.merchantId, payerId, taxYear: last, issuedBy: 'SYSTEM', silent: true });
    await processDomainEvents();
    expect(await prisma.issuedDocument.count({ where: { purpose: 'YEAR_END_THANKS' } })).toBe(0);
    const jan = new Date(`${kstYear()}-01-05T01:00:00Z`);
    const prep = await runAnnualReceiptPrep(jan);
    expect(prep.yearClosed).toBe(1);
    await runAnnualReceiptPrep(jan); // 다시 불러도 이벤트는 한 건
    expect(await prisma.domainEvent.count({ where: { type: 'receipt.year_closed' } })).toBe(1);
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type: 'receipt.year_closed' } });
    expect(ev.payload).toMatchObject({ totalAmount: '30000', chargeCount: 2, receiptNo: `${second.receipt.receiptNo} 외 1건` });
    expect(first.receipt.receiptNo).not.toBe(second.receipt.receiptNo);
    await processDomainEvents();
    expect(await prisma.issuedDocument.count({ where: { purpose: 'YEAR_END_THANKS' } })).toBe(1);
  });

  it('끝나지 않은 해(올해 귀속)의 영수증으로는 연말 감사장을 보내지 않는다', async () => {
    await makeIssuer('YEARLY');
    await pay(10000n);
    await upsertReceiptProfile(payerId, { legalName: '홍길동', residentNo: '900101-1234568', hometaxOptIn: true });
    await issueReceipt({ merchantId: fx.merchantId, payerId, taxYear: kstYear(), issuedBy: 'SYSTEM', silent: true });
    await processDomainEvents();
    expect(await prisma.issuedDocument.count({ where: { purpose: 'YEAR_END_THANKS' } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('A-M3 환불된 후원에는 감사장·안내를 보내지 않는다', () => {
  it('승인 대기 중 환불 → charge.refunded 소비자가 실행·승인 요청을 취소', async () => {
    await saveJourneySetting(fx.merchantId, 'donation-thanks', { enabled: true, approvals: { 'thanks-letter': true }, params: {} }, fx.merchantUserId);
    await pay(10000n);
    await processDomainEvents();
    const run = await prisma.journeyRun.findFirstOrThrow({ where: { journeyKey: 'donation-thanks' } });
    expect(run.status).toBe('AWAITING_APPROVAL');
    expect(run.context).toMatchObject({ chargeId: run.subjectId });
    const charge = await prisma.charge.findFirstOrThrow();
    const refund = await requestRefund({ chargeId: charge.id, reason: '오입금' });
    await approveRefund(refund.id, 'admin');
    await processDomainEvents();
    expect((await prisma.journeyRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('CANCELED');
    expect((await prisma.approvalRequest.findFirstOrThrow({ where: { kind: 'JOURNEY_STEP' } })).status).toBe('CANCELED');
    expect(await prisma.issuedDocument.count()).toBe(0);
  });

  it('보류 중 환불(소비자보다 먼저 실행이 깨어남) → 발송 직전 재확인으로 멈춘다', async () => {
    await pay(10000n);
    const charge = await prisma.charge.findFirstOrThrow();
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type: 'charge.paid' } });
    // 이벤트 처리 전에 결제가 환불 상태가 됨(소비자 순서와 무관하게)
    await prisma.charge.update({ where: { id: charge.id }, data: { status: 'REFUNDED' } });
    await processDomainEvents();
    const run = await prisma.journeyRun.findFirstOrThrow({ where: { eventId: ev.id } });
    expect(run.status).toBe('STOPPED');
    const log = await prisma.journeyStepLog.findFirstOrThrow({ where: { runId: run.id, outcome: 'STOPPED' } });
    expect(log.detail).toContain('환불');
    expect(await prisma.issuedDocument.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('A-M4 정기후원 누적 감사 — 기관이 적은 횟수에 보낸다', () => {
  it('출금 성공마다 milestone 이벤트, 설정한 3회에만 실행이 생긴다(고정 목록 밖 값도 동작)', async () => {
    await saveJourneySetting(fx.merchantId, 'recurring-milestone', { enabled: true, approvals: {}, params: { milestones: '2,3' } }, fx.merchantUserId);
    const made = await createRecurringDonation({ payerId, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 10 });
    if (!made.ok) throw new Error(made.message);
    const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    for (let i = 0; i < 3; i++) {
      // 매달 출금일 — 약정 주기(cycleMonth)에 맞춘 날짜로 배치를 돌린다
      const r = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: made.recurring.id } });
      const at = new Date(`${r.cycleMonth}-10T03:00:00Z`);
      const runAt = at.getTime() < Date.now() ? new Date() : at;
      await prisma.recurringDonation.update({ where: { id: r.id }, data: { nextChargeOn: new Date(`${kst(runAt)}T00:00:00Z`) } });
      await runRecurringDonations(runAt);
    }
    const evs = await prisma.domainEvent.findMany({ where: { type: 'recurring.milestone' }, orderBy: { occurredAt: 'asc' } });
    expect(evs.map((e) => (e.payload as { count: number }).count)).toEqual([1, 2, 3]);
    await processDomainEvents();
    const runs = await prisma.journeyRun.findMany({ where: { journeyKey: 'recurring-milestone' } });
    expect(runs.map((r) => (r.context as { count: number }).count).sort()).toEqual([2, 3]);
    expect(await prisma.issuedDocument.count({ where: { purpose: 'RECURRING_THANKS' } })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('A-M6 봉사 전날 안내 — 발송 직전 재확인, 21시 이후 생성 안 함', () => {
  async function shiftWithApp(startsAt: Date) {
    const posting = await prisma.volunteerPosting.create({
      data: {
        id: newId(), merchantId: fx.merchantId, title: '봉사', interest: '돌봄', description: 'd', place: '복지관',
        recruitFrom: new Date(Date.now() - 3 * DAY), recruitTo: new Date(Date.now() + 5 * DAY), status: 'OPEN', createdBy: fx.merchantUserId,
      },
    });
    const shift = await prisma.volunteerShift.create({
      data: { id: newId(), postingId: posting.id, merchantId: fx.merchantId, shiftDate: startsAt, startTime: '08:00', endTime: '10:00', startsAt, endsAt: new Date(startsAt.getTime() + 7_200_000), capacity: 5, appliedCount: 1 },
    });
    const app = await prisma.volunteerApplication.create({ data: { id: newId(), merchantId: fx.merchantId, payerId, status: 'APPROVED', postingId: posting.id, shiftId: shift.id } });
    return { shift, app };
  }
  const due = (appId: string, shiftId: string, startsAt: Date) =>
    emitDomainEvent({
      merchantId: fx.merchantId, type: 'volunteer.shift_reminder_due', subjectType: 'volunteer_application', subjectId: appId, payerId,
      payload: { shiftId, schedule: '내일 08:00 복지관', startsAt: startsAt.toISOString() },
    });

  it('철회된 신청에는 보내지 않는다', async () => {
    const at = new Date(Date.now() + DAY);
    const { shift, app } = await shiftWithApp(at);
    await due(app.id, shift.id, at);
    await prisma.volunteerApplication.update({ where: { id: app.id }, data: { status: 'WITHDRAWN' } });
    await processDomainEvents();
    expect(readMockOutbox(10).some((m) => m.template === 'VOLUNTEER_REMINDER')).toBe(false);
    const log = await prisma.journeyStepLog.findFirstOrThrow({ where: { stepKey: 'reminder' } });
    expect(log.outcome).toBe('SKIPPED');
  });

  it('야간 보류 뒤 깨어났는데 회차가 이미 시작했으면 보내지 않는다', async () => {
    const at = new Date(Date.now() + 10 * 60_000); // 10분 뒤 시작(30분 미만)
    const { shift, app } = await shiftWithApp(at);
    await due(app.id, shift.id, at);
    await processDomainEvents();
    expect(readMockOutbox(10).some((m) => m.template === 'VOLUNTEER_REMINDER')).toBe(false);
    expect((await prisma.journeyStepLog.findFirstOrThrow({ where: { stepKey: 'reminder' } })).detail).toContain('시작');
  });

  it('21시(KST) 이후에는 전날 안내 이벤트를 만들지 않는다', async () => {
    const kstDay = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const late = new Date(`${kstDay}T12:30:00Z`); // 21:30 KST
    expect(await emitShiftReminders(late)).toMatchObject({ emitted: 0, skipped: 'after-21' });
  });
});

// ---------------------------------------------------------------------------
describe('A-M1 약정 변경 — 이전 판 봉투 취소(환원), 하루 변경 횟수 제한', () => {
  const original = env.automation.esignProvider;
  afterEach(() => {
    (env.automation as { esignProvider: string }).esignProvider = original;
  });

  it('새 판이 생기면 이전 판 서명 봉투를 취소하고 열기 전이면 이용요금을 되돌린다', async () => {
    (env.automation as { esignProvider: string }).esignProvider = 'internal';
    await ensureDefaultPurposeTemplates(fx.merchantId, ['SUPPORT_AGREEMENT']);
    const made = await createRecurringDonation({ payerId, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 5 });
    if (!made.ok) throw new Error(made.message);
    const v1 = await prisma.agreementDocument.findFirstOrThrow({ where: { subjectId: made.recurring.id, version: 1 } });
    expect(v1.esignStatus).toBe('REQUESTED');
    await updateRecurringDonation(payerId, made.recurring.id, { amount: 20000n });
    const v1After = await prisma.agreementDocument.findUniqueOrThrow({ where: { id: v1.id } });
    expect(v1After.esignStatus).toBe('EXPIRED');
    const env1 = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: v1.esignRequestId! } });
    expect(env1.status).toBe('CANCELLED');
    expect(await prisma.eDocLedger.count({ where: { envelopeId: env1.id, kind: 'REFUND' } })).toBe(1);
    const v2 = await prisma.agreementDocument.findFirstOrThrow({ where: { subjectId: made.recurring.id, version: 2 } });
    expect(v2.esignStatus).toBe('REQUESTED');
    expect(await prisma.eDocEnvelope.count({ where: { status: { in: ['SENT', 'IN_PROGRESS'] } } })).toBe(1);
    // [낮음] 서명 화면 본문 = 약정서 스냅샷 본문
    const env2 = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: v2.esignRequestId! } });
    expect(readSnapshot(env2.snapshotEnc).body).toContain('매월 5일 20,000원');
  });

  it(`하루 ${AGREEMENT_CHANGES_PER_DAY}번 넘게 조건을 바꾸면 바꾸기 전에 막는다(약정은 그대로)`, async () => {
    const made = await createRecurringDonation({ payerId, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 5 });
    if (!made.ok) throw new Error(made.message);
    for (let i = 1; i <= AGREEMENT_CHANGES_PER_DAY; i++) await updateRecurringDonation(payerId, made.recurring.id, { amount: BigInt(10000 + i * 1000) });
    await expect(updateRecurringDonation(payerId, made.recurring.id, { amount: 15000n })).rejects.toThrow(/하루 3번/);
    const r = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: made.recurring.id } });
    expect(r.amount).toBe(BigInt(10000 + AGREEMENT_CHANGES_PER_DAY * 1000));
    // 메시지만 바꾸는 것은 새 판이 아니므로 막지 않는다
    await updateRecurringDonation(payerId, made.recurring.id, { message: '응원합니다' });
    expect(await prisma.agreementDocument.count({ where: { subjectId: made.recurring.id } })).toBe(AGREEMENT_CHANGES_PER_DAY + 1);
  });

  it('[낮음] 잔액 부족으로 서명 요청을 못 보내면 기관에 알린다(하루 한 번)', async () => {
    (env.automation as { esignProvider: string }).esignProvider = 'internal';
    await prisma.eDocWallet.create({ data: { merchantId: fx.merchantId, balance: 0, trialRemaining: 0, totalUsed: 0 } });
    const made = await createRecurringDonation({ payerId, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 5 });
    if (!made.ok) throw new Error(made.message);
    await issueRecurringAgreement(made.recurring.id, {}, { notify: false });
    const notes = await prisma.notification.findMany({ where: { userId: fx.merchantUserId, title: '전자서명 요청을 보내지 못했습니다' } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain('잔액 부족');
  });
});

// ---------------------------------------------------------------------------
describe('A-M2 서명용 머지 PDF — 비공개 저장, 렌더 전 잔액 확인, 실패 시 정리', () => {
  async function fileTemplate() {
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]);
    const baseUrl = await putObject(newObjectName('pdf'), Buffer.from(await doc.save()), 'application/octet-stream');
    const layout = {
      v: 1,
      edits: [{ id: 'e1', page: 1, kind: 'add', matrix: [12, 0, 0, 12, 20, 100], width: 0, text: '{{후원자명}} 약정', font: { baseFont: 'Helvetica', serif: false, bold: false }, color: [0, 0, 0], cover: [1, 1, 1] }],
      fonts: [],
    };
    await prisma.documentTemplate.create({
      data: {
        id: newId(), merchantId: fx.merchantId, name: '파일 약정서', templateType: 'FILE', fileUrl: baseUrl, fileName: 'a.pdf',
        basePdfUrl: baseUrl, basePdfHash: 'x', pdfLayout: layout, purpose: 'SUPPORT_AGREEMENT', requireSignature: true,
      },
    });
  }
  const pledge = (key = 'pledge:F1') =>
    issuePurposeDocument({ merchantId: fx.merchantId, purpose: 'SUPPORT_AGREEMENT', payerId, context: { donorName: '김나눔', amount: 20000n }, dedupeKey: key });
  const privateFiles = async () => (await fs.readdir(PRIVATE_DIR).catch(() => [] as string[])).length;

  it('서명 봉투 PDF 는 공개 주소가 없고 권한 경로로만 읽는다', async () => {
    await fileTemplate();
    const r = await pledge();
    if (!r.ok) throw new Error(r.reason);
    const row = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.issuedId } });
    const e = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: row.envelopeId! } });
    const snap = readSnapshot(e.snapshotEnc);
    expect(snap.pdfUrl).toBeNull();
    expect(snap.pdfObject).toMatch(/^[a-f0-9]{32}\.pdf$/);
    expect(await getObject(snap.pdfObject!)).toBeNull(); // 공개 저장소에 없음
    expect(snapshotPdfHref(snap, { signerToken: 'TOKEN' })).toBe('/sign/TOKEN/pdf');
    expect(snapshotPdfHref(snap, { envelopeId: e.id })).toBe(`/studio/e-documents/${e.id}/pdf`);
    expect(await readSnapshotPdfBytes(snap)).not.toBeNull();
  });

  it('잔액이 없으면 PDF 를 만들기 전에 막고 파일을 남기지 않는다', async () => {
    await fileTemplate();
    await prisma.eDocWallet.create({ data: { merchantId: fx.merchantId, balance: 0, trialRemaining: 0, totalUsed: 0 } });
    const before = await privateFiles();
    expect(await pledge()).toMatchObject({ ok: false, blocked: 'EDOC_BALANCE' });
    expect(await privateFiles()).toBe(before);
  });

  it('같은 발송을 다시 불러도(재시도) 새 PDF 가 남지 않는다', async () => {
    await fileTemplate();
    await pledge();
    const after1 = await privateFiles();
    expect(await pledge()).toMatchObject({ ok: true, already: true });
    expect(await privateFiles()).toBe(after1);
  });

  it('서명 화면 PDF 경로: 본인확인 없으면 403', async () => {
    await fileTemplate();
    await pledge();
    const signer = await prisma.eDocSigner.findFirstOrThrow();
    const token = 'P'.repeat(43);
    await prisma.eDocSigner.update({ where: { id: signer.id }, data: { tokenHash: tokenHash(token) } });
    const { GET } = await import('@/app/sign/[token]/pdf/route');
    const res = await GET(new Request('http://localhost/sign/x/pdf'), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(403);
    expect(accessProof(signer.id, tokenHash(token), Math.floor(Date.now() / 1000) + 60)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('A-M7 봉투 거절·만료·취소 → 이벤트 + 대사', () => {
  const pledge = () =>
    issuePurposeDocument({ merchantId: fx.merchantId, purpose: 'SUPPORT_AGREEMENT', payerId, context: { amount: 20000n }, dedupeKey: `p:${newId()}` });

  it('만료·취소는 같은 트랜잭션에 document.closed 를 남기고, 소비자가 발급 문서를 맞춘다', async () => {
    const a = await pledge();
    const b = await pledge();
    if (!a.ok || !b.ok) throw new Error('발송 실패');
    const ea = (await prisma.issuedDocument.findUniqueOrThrow({ where: { id: a.issuedId } })).envelopeId!;
    const eb = (await prisma.issuedDocument.findUniqueOrThrow({ where: { id: b.issuedId } })).envelopeId!;
    await prisma.eDocEnvelope.update({ where: { id: ea }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await expireEDocEnvelopes()).toBe(1);
    await cancelEnvelope({ merchantId: fx.merchantId, envelopeId: eb, actorId: fx.merchantUserId, reason: '잘못 보냄' });
    expect(await prisma.domainEvent.count({ where: { type: 'document.closed' } })).toBe(2);
    // 바로 반영이 실패한 상황을 흉내: 발급 문서를 다시 REQUESTED 로
    await prisma.issuedDocument.updateMany({ data: { status: 'REQUESTED' } });
    await processDomainEvents();
    expect((await prisma.issuedDocument.findUniqueOrThrow({ where: { id: a.issuedId } })).status).toBe('EXPIRED');
    expect((await prisma.issuedDocument.findUniqueOrThrow({ where: { id: b.issuedId } })).status).toBe('CANCELLED');
  });

  it('거절도 이벤트를 남기고, /api/cron/edoc 대사가 남은 불일치를 맞춘다', async () => {
    const a = await pledge();
    if (!a.ok) throw new Error(a.reason);
    const envId = (await prisma.issuedDocument.findUniqueOrThrow({ where: { id: a.issuedId } })).envelopeId!;
    const signer = await prisma.eDocSigner.findFirstOrThrow({ where: { envelopeId: envId } });
    const token = 'D'.repeat(43);
    await prisma.eDocSigner.update({ where: { id: signer.id }, data: { tokenHash: tokenHash(token) } });
    const proof = accessProof(signer.id, tokenHash(token), Math.floor(Date.now() / 1000) + 600);
    await declineAsSigner({ token, proof, reason: '내용이 달라요' });
    expect(await prisma.domainEvent.count({ where: { type: 'document.closed', subjectId: envId } })).toBe(1);
    await prisma.issuedDocument.update({ where: { id: a.issuedId }, data: { status: 'REQUESTED' } });
    expect(await reconcileClosedEnvelopes()).toBe(1);
    expect((await prisma.issuedDocument.findUniqueOrThrow({ where: { id: a.issuedId } })).status).toBe('DECLINED');
  });
});

// ---------------------------------------------------------------------------
describe('자동화 낮음 — 탈퇴·기관 정지·재발송 동시 클릭·이벤트 종류 정리', () => {
  const thanks = () =>
    issuePurposeDocument({ merchantId: fx.merchantId, purpose: 'THANKS_LETTER', payerId, context: { amount: 1000n }, dedupeKey: `t:${newId()}` });

  it('탈퇴하면 열람 링크가 닫히고 진행 중 서명 봉투가 취소된다', async () => {
    const t = await thanks();
    if (!t.ok) throw new Error(t.reason);
    const token = t.link!.split('/l/')[1]!;
    const s = await issuePurposeDocument({ merchantId: fx.merchantId, purpose: 'SUPPORT_AGREEMENT', payerId, context: {}, dedupeKey: 'w:sign' });
    if (!s.ok) throw new Error(s.reason);
    await prisma.payerProfile.update({ where: { id: payerId }, data: { onboardingStatus: 'WITHDRAWN' } });
    // 링크를 닫기 전에도 열람 화면이 탈퇴자를 거른다
    expect((await loadIssuedByToken(token)).ok).toBe(false);
    const r = await closeDocumentsForWithdrawnPayer(payerId);
    expect(r).toMatchObject({ envelopesCanceled: 1 });
    expect(await prisma.issuedDocument.count({ where: { payerId, tokenHash: { not: null } } })).toBe(0);
    const envId = (await prisma.issuedDocument.findUniqueOrThrow({ where: { id: s.issuedId } })).envelopeId!;
    expect((await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: envId } })).status).toBe('CANCELLED');
  });

  it('/l/[토큰] 은 기관이 정지되면 열리지 않는다', async () => {
    const t = await thanks();
    if (!t.ok) throw new Error(t.reason);
    const token = t.link!.split('/l/')[1]!;
    expect((await loadIssuedByToken(token, { record: false })).ok).toBe(true);
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { status: 'SUSPENDED' } });
    const r = await loadIssuedByToken(token, { record: false });
    expect(r.ok).toBe(false);
  });

  it.skipIf(singleBackend)('재발송을 동시에 두 번 눌러도 문자는 한 번', async () => {
    const t = await thanks();
    if (!t.ok) throw new Error(t.reason);
    await prisma.issuedDocument.update({ where: { id: t.issuedId }, data: { sentAt: new Date(Date.now() - 3_600_000) } });
    const before = readMockOutbox(50).filter((m) => m.template === 'DOCUMENT_ISSUED').length;
    const results = await Promise.allSettled([
      resendIssuedDocument({ merchantId: fx.merchantId, id: t.issuedId }),
      resendIssuedDocument({ merchantId: fx.merchantId, id: t.issuedId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(IssuedDocumentError);
    expect(readMockOutbox(50).filter((m) => m.template === 'DOCUMENT_ISSUED').length).toBe(before + 1);
  });

  it('발생처가 없던 이벤트 종류는 정리했고, 새 종류(연말 마감·봉투 종료)는 있다', () => {
    const types = DOMAIN_EVENT_TYPES as readonly string[];
    expect(types).not.toContain('supporter.dormant');
    expect(types).not.toContain('agreement.issued');
    expect(types).toContain('receipt.year_closed');
    expect(types).toContain('document.closed');
  });

  it('승인 일괄 발급과 별개로 issueReceiptsBulk 시간 상한은 남은 수를 돌려준다', async () => {
    await makeIssuer();
    await pay(10000n);
    const last = await moveChargesToLastYear();
    await upsertReceiptProfile(payerId, { legalName: '홍길동', residentNo: '900101-1234568', hometaxOptIn: true });
    const r = await issueReceiptsBulk(fx.merchantId, last, 'SYSTEM', { deadline: new Date(Date.now() - 1) });
    expect(r).toMatchObject({ issued: 0, remaining: 1 });
    expect(await advanceDueJourneyRuns({ budgetMs: 0 })).toMatchObject({ done: 0 });
  });
});
