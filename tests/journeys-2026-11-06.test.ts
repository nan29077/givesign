import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

// 용도별 문서 발송은 2단계 구현과 독립적으로 엔진만 검증한다(호출 인자·결과 분기).
const issued: Array<{ purpose: string; dedupeKey: string; payerId: string; context: Record<string, unknown> }> = [];
let issueMode: 'ok' | 'balance' | 'disabled' = 'ok';
vi.mock('@/server/services/purpose-documents', async (orig) => {
  const real = await orig<typeof import('@/server/services/purpose-documents')>();
  return {
    ...real,
    issuePurposeDocument: async (input: { purpose: string; dedupeKey: string; payerId: string; context: Record<string, unknown> }) => {
      if (issueMode === 'balance') return { ok: false, reason: '잔액 부족', blocked: 'EDOC_BALANCE' };
      if (issueMode === 'disabled') return { ok: false, reason: '자동 발송 꺼짐', blocked: 'DISABLED' };
      const already = issued.some((i) => i.dedupeKey === input.dedupeKey);
      if (!already) issued.push(input);
      return { ok: true, issuedId: `doc-${issued.length}`, link: 'http://localhost/l/x', already, signature: false };
    },
  };
});

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { readMockOutbox } from '@/server/adapters/mt';
import { processDomainEvents, emitDomainEvent } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { decideApproval } from '@/server/services/approvals';
import { upsertReceiptProfile } from '@/server/services/receipts';
import { runAnnualReceiptPrep } from '@/server/services/receipt-batch';
import {
  advanceDueJourneyRuns,
  advanceRun,
  isQuietHour,
  nextMorning,
  saveJourneySetting,
  journeySettings,
  JOURNEY_WEEKLY_SEND_CAP,
} from '@/server/services/journeys';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, setChargeAmount, type Fixture } from './helpers';

/**
 * 고도화 3단계: 저니 엔진(자동 안내 흐름) + 연간 영수증 준비.
 */

const singleBackend = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${process.env.PGLITE_PORT ?? '5463'}/`);
let fx: Fixture;
const DAY = 86_400_000;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  registerDefaultConsumers();
  issued.length = 0;
  issueMode = 'ok';
  payerId = null;
  await prisma.termsVersion.create({
    data: { id: newId(), type: 'RECEIPT_ISSUANCE', version: '1.0', title: '영수증 동의', content: '테스트', required: false, effectiveFrom: new Date('2026-01-01') },
  });
});

let payerId: string | null = null;
async function ensurePayer() {
  if (!payerId) payerId = (await seedRegisteredPayer(fx.payerPhone)).id;
  return { id: payerId };
}

async function pay(amount: bigint, text = '후원') {
  await ensurePayer();
  setChargeAmount(amount);
  const r = await inboundAndPay(moPayload({ from: fx.payerPhone, to: fx.moNumber, text }), fx.merchantId);
  setChargeAmount(null);
  return r;
}

async function makeIssuer() {
  await prisma.merchantProfile.update({
    where: { id: fx.merchantId },
    data: { businessNo: '123-82-00001', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true, designatedDoneeVerifiedAt: new Date(), orgType: 'WELFARE_CORPORATION' },
  });
}

const runOf = (key: string) => prisma.journeyRun.findFirstOrThrow({ where: { journeyKey: key }, include: { logs: { orderBy: { at: 'asc' } } } });

describe('[1] 후원 감사 저니', () => {
  it('첫 후원 → 감사장 발송 → 하루 대기 → 영수증 정보 안내(기관이 발급 가능할 때만)', async () => {
    await makeIssuer();
    await pay(10000n);
    await processDomainEvents();
    expect(issued).toHaveLength(1);
    expect(issued[0]!.purpose).toBe('THANKS_LETTER');
    expect(String(issued[0]!.context.amount)).toBe('10000');
    let run = await runOf('donation-thanks');
    expect(run.status).toBe('WAITING');
    expect(run.dueAt.getTime()).toBeGreaterThan(Date.now() + DAY - 60_000);

    // 하루 뒤
    await advanceDueJourneyRuns({ now: new Date(Date.now() + DAY + 60_000) });
    run = await runOf('donation-thanks');
    expect(run.status).toBe('DONE');
    expect(readMockOutbox(20).some((m) => m.template === 'RECEIPT_INFO_REQUEST')).toBe(true);
    const sent = run.logs.filter((l) => l.sent).map((l) => l.stepKey);
    expect(sent).toEqual(['thanks-letter', 'receipt-info']);
  });

  it('두 번째 소액 후원은 감사장을 건너뛰고, 영수증 정보는 올해 이미 안내했으면 다시 보내지 않는다', async () => {
    await makeIssuer();
    await pay(10000n);
    await processDomainEvents();
    await advanceDueJourneyRuns({ now: new Date(Date.now() + DAY + 60_000) });
    await pay(10000n);
    await processDomainEvents();
    await advanceDueJourneyRuns({ now: new Date(Date.now() + DAY + 120_000) });
    expect(issued).toHaveLength(1);
    const runs = await prisma.journeyRun.findMany({ where: { journeyKey: 'donation-thanks' }, include: { logs: true }, orderBy: { startedAt: 'asc' } });
    expect(runs).toHaveLength(2);
    const second = runs[1]!.logs;
    expect(second.find((l) => l.stepKey === 'thanks-letter')?.outcome).toBe('SKIPPED');
    expect(second.find((l) => l.stepKey === 'receipt-info')?.outcome).toBe('SKIPPED');
    expect(readMockOutbox(50).filter((m) => m.template === 'RECEIPT_INFO_REQUEST')).toHaveLength(1);
  });

  it('영수증 정보를 이미 등록했거나 기관이 발급할 수 없으면 안내하지 않는다', async () => {
    const payer = await ensurePayer();
    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: '900101-1234568', hometaxOptIn: true });
    await pay(10000n);
    await processDomainEvents();
    await advanceDueJourneyRuns({ now: new Date(Date.now() + DAY + 60_000) });
    const run = await runOf('donation-thanks');
    expect(run.logs.find((l) => l.stepKey === 'receipt-info')?.detail).toMatch(/영수증을 발급할 수 없음|이미 영수증 정보/);
    expect(readMockOutbox(20).some((m) => m.template === 'RECEIPT_INFO_REQUEST')).toBe(false);
  });

  it('기관이 끄면 실행을 만들지 않고, 진행 중 실행은 다음 진행에서 멈춘다', async () => {
    await pay(10000n);
    await processDomainEvents();
    const run = await runOf('donation-thanks');
    expect(run.status).toBe('WAITING');
    const s = (await journeySettings(fx.merchantId)).find((x) => x.def.key === 'donation-thanks')!;
    await saveJourneySetting(fx.merchantId, 'donation-thanks', { enabled: false, approvals: s.approvals, params: s.params }, fx.merchantUserId);
    await advanceDueJourneyRuns({ now: new Date(Date.now() + DAY + 60_000) });
    expect((await runOf('donation-thanks')).status).toBe('STOPPED');
    await pay(10000n);
    await processDomainEvents();
    expect(await prisma.journeyRun.count({ where: { journeyKey: 'donation-thanks' } })).toBe(1);
  });
});

describe('[2] 승인·보호 장치', () => {
  it('승인 후 보내기: 승인 대기함에 올리고, 승인하면 보내고, 반려하면 건너뛴다', async () => {
    const s = (await journeySettings(fx.merchantId)).find((x) => x.def.key === 'donation-thanks')!;
    await saveJourneySetting(fx.merchantId, 'donation-thanks', { enabled: true, approvals: { 'thanks-letter': true }, params: { ...s.params, minAmount: 0 } }, fx.merchantUserId);
    await pay(10000n);
    await processDomainEvents();
    let run = await runOf('donation-thanks');
    expect(run.status).toBe('AWAITING_APPROVAL');
    expect(issued).toHaveLength(0);
    const req = await prisma.approvalRequest.findFirstOrThrow({ where: { kind: 'JOURNEY_STEP' } });
    expect(req.title).toContain('후원 감사장');

    // 다른 기관은 결정할 수 없다
    await expect(decideApproval({ merchantId: 'other', id: req.id, decision: 'APPROVE', userId: 'x' })).rejects.toThrow();
    const r = await decideApproval({ merchantId: fx.merchantId, id: req.id, decision: 'APPROVE', userId: fx.merchantUserId });
    expect(r.ok).toBe(true);
    expect(issued).toHaveLength(1);
    run = await runOf('donation-thanks');
    expect(run.status).toBe('WAITING');
    // 두 번 승인할 수 없다
    await expect(decideApproval({ merchantId: fx.merchantId, id: req.id, decision: 'APPROVE', userId: fx.merchantUserId })).rejects.toThrow(/이미 처리/);

    // 두 번째 후원 → 반려
    await prisma.journeyRun.deleteMany();
    await pay(20000n);
    await processDomainEvents();
    const req2 = await prisma.approvalRequest.findFirstOrThrow({ where: { kind: 'JOURNEY_STEP', status: 'PENDING' } });
    await decideApproval({ merchantId: fx.merchantId, id: req2.id, decision: 'REJECT', userId: fx.merchantUserId });
    const run2 = await runOf('donation-thanks');
    expect(run2.logs.find((l) => l.stepKey === 'thanks-letter' && l.outcome === 'SKIPPED')?.detail).toContain('반려');
    expect(issued).toHaveLength(1);
  });

  it('후원자가 그 기관 안내 수신을 껐으면 발송 단계에서 멈춘다', async () => {
    const payer = await ensurePayer();
    await pay(10000n);
    await prisma.payerMerchantLink.updateMany({ where: { payerId: payer.id, merchantId: fx.merchantId }, data: { noticeOptOutAt: new Date() } });
    await processDomainEvents();
    const run = await runOf('donation-thanks');
    expect(run.status).toBe('STOPPED');
    expect(issued).toHaveLength(0);
  });

  it(`후원자당 7일 ${JOURNEY_WEEKLY_SEND_CAP}건 상한을 넘으면 하루 보류한다`, async () => {
    const payer = await ensurePayer();
    const dummy = await prisma.journeyRun.create({ data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'x', triggerKey: 'x:1', payerId: payer.id, status: 'DONE' } });
    for (let i = 0; i < JOURNEY_WEEKLY_SEND_CAP; i += 1) {
      await prisma.journeyStepLog.create({ data: { id: newId(), runId: dummy.id, stepIndex: 0, stepKey: 'x', outcome: 'DONE', sent: true, merchantId: fx.merchantId, payerId: payer.id } });
    }
    await pay(10000n);
    await processDomainEvents();
    const run = await runOf('donation-thanks');
    expect(run.status).toBe('WAITING');
    expect(run.logs.at(-1)?.outcome).toBe('BLOCKED');
    expect(run.dueAt.getTime()).toBeGreaterThan(Date.now() + DAY - 60_000);
    expect(issued).toHaveLength(0);
  });

  it('야간(21시~9시 KST)은 다음 날 9시로 보류한다', () => {
    // 2026-11-06 22:00 KST = 13:00Z
    const night = new Date('2026-11-06T13:00:00Z');
    expect(isQuietHour(night, true)).toBe(true);
    expect(nextMorning(night).toISOString()).toBe('2026-11-07T00:00:00.000Z');
    const dawn = new Date('2026-11-06T20:30:00Z'); // 11-07 05:30 KST
    expect(nextMorning(dawn).toISOString()).toBe('2026-11-07T00:00:00.000Z');
    expect(isQuietHour(new Date('2026-11-06T03:00:00Z'), true)).toBe(false); // 12:00 KST
  });

  it('전자문서 잔액 부족이면 같은 단계를 하루 뒤 다시 시도한다', async () => {
    issueMode = 'balance';
    await pay(10000n);
    await processDomainEvents();
    const run = await runOf('donation-thanks');
    expect(run.status).toBe('WAITING');
    expect(run.stepIndex).toBe(0);
    expect(run.logs.at(-1)?.detail).toContain('잔액');
    issueMode = 'ok';
    await advanceDueJourneyRuns({ now: new Date(Date.now() + DAY + 60_000) });
    expect(issued).toHaveLength(1);
  });

  it.skipIf(singleBackend)('같은 실행을 동시에 진행해도 한 번만 돈다', async () => {
    await saveJourneySetting(fx.merchantId, 'donation-thanks', { enabled: false, approvals: {}, params: {} }, fx.merchantUserId);
    await pay(10000n);
    await processDomainEvents();
    await saveJourneySetting(fx.merchantId, 'donation-thanks', { enabled: true, approvals: {}, params: { minAmount: 0, receiptInfoDelayDays: 1 } }, fx.merchantUserId);
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type: 'charge.paid' } });
    const { startJourneysForEvent } = await import('@/server/services/journeys');
    const [id] = await startJourneysForEvent({ ...ev, payload: ev.payload as Record<string, unknown> });
    const results = await Promise.all([advanceRun(id!), advanceRun(id!), advanceRun(id!)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(issued).toHaveLength(1);
  });
});

describe('[3] 정기후원·봉사·연말 저니', () => {
  it('정지 3일 뒤에도 정지 상태면 재개 방법을 안내한다(이미 재개했으면 생략)', async () => {
    const payer = await ensurePayer();
    const rd = await prisma.recurringDonation.create({
      data: { id: newId(), merchantId: fx.merchantId, payerId: payer.id, amount: 10000n, dayOfMonth: 5, status: 'SUSPENDED', nextChargeOn: new Date('2026-12-05'), cycleMonth: '2026-12', suspendedAt: new Date() },
    });
    await emitDomainEvent({ merchantId: fx.merchantId, type: 'recurring.suspended', subjectType: 'recurring', subjectId: rd.id, payerId: payer.id, payload: { reason: 'PAYMENT_FAILED' } });
    await processDomainEvents();
    expect((await runOf('recurring-resume')).status).toBe('WAITING');
    await advanceDueJourneyRuns({ now: new Date(Date.now() + 3 * DAY + 60_000) });
    expect((await runOf('recurring-resume')).status).toBe('DONE');
    expect(readMockOutbox(10).some((m) => m.template === 'RECURRING_RESUME_GUIDE')).toBe(true);
  });

  it('누적 이정표: 설정한 횟수일 때만 정기후원 감사장', async () => {
    const payer = await ensurePayer();
    await emitDomainEvent({ merchantId: fx.merchantId, type: 'recurring.milestone', subjectType: 'recurring', subjectId: 'R1', payerId: payer.id, dedupeKey: 'm6', payload: { count: 6, totalAmount: 60000n } });
    await emitDomainEvent({ merchantId: fx.merchantId, type: 'recurring.milestone', subjectType: 'recurring', subjectId: 'R1', payerId: payer.id, dedupeKey: 'm12', payload: { count: 12, totalAmount: 120000n } });
    await processDomainEvents();
    expect(issued.map((i) => i.purpose)).toEqual(['RECURRING_THANKS']);
    expect(issued[0]!.context.count).toBe(12);
  });

  it('봉사 활동 → 감사 문자 + 확인서(기본 승인 필요)', async () => {
    const payer = await ensurePayer();
    await emitDomainEvent({
      merchantId: fx.merchantId, type: 'volunteer.activity_recorded', subjectType: 'volunteer_activity', subjectId: 'A1', payerId: payer.id,
      payload: { minutes: 120, totalMinutes: 300, title: '말벗', activityDate: '2026-11-05' },
    });
    await processDomainEvents();
    expect(readMockOutbox(10).some((m) => m.template === 'VOLUNTEER_THANKS')).toBe(true);
    const run = await runOf('volunteer-thanks');
    expect(run.status).toBe('AWAITING_APPROVAL');
    const req = await prisma.approvalRequest.findFirstOrThrow({ where: { kind: 'JOURNEY_STEP' } });
    await decideApproval({ merchantId: fx.merchantId, id: req.id, decision: 'APPROVE', userId: fx.merchantUserId });
    expect(issued[0]!.purpose).toBe('VOLUNTEER_CONFIRMATION');
    expect(issued[0]!.context.activityHours).toBe(2);
  });

  it('영수증 발급 → 연말 감사장은 한 사람에게 한 해 한 번', async () => {
    const payer = await ensurePayer();
    for (const id of ['RC1', 'RC2']) {
      await emitDomainEvent({ merchantId: fx.merchantId, type: 'receipt.issued', subjectType: 'donation_receipt', subjectId: id, payerId: payer.id, payload: { taxYear: 2026, totalAmount: 50000n, chargeCount: 2 } });
    }
    await processDomainEvents();
    expect(issued.filter((i) => i.purpose === 'YEAR_END_THANKS')).toHaveLength(1);
  });
});

describe('[4] 연간 영수증 준비(승인 후 발급)', () => {
  it('1월: 발급 가능자는 승인 요청, 미등록자는 등록 안내 이벤트 → 승인하면 발급', async () => {
    await makeIssuer();
    const payer = await ensurePayer();
    await pay(30000n);
    const year = Number(new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 4));
    const jan = new Date(`${year + 1}-01-10T01:00:00Z`);

    // 정보 미등록 → 안내 이벤트만
    let r = await runAnnualReceiptPrep(jan);
    expect(r.infoNeeded).toBe(1);
    expect(r.requested).toBe(0);
    expect(await prisma.domainEvent.count({ where: { type: 'receipt.info_needed' } })).toBe(1);

    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: '900101-1234568', hometaxOptIn: true });
    r = await runAnnualReceiptPrep(jan);
    expect(r.requested).toBe(1);
    // 같은 주에 다시 돌려도 쌓이지 않는다
    r = await runAnnualReceiptPrep(jan);
    expect(r.requested).toBe(0);
    const req = await prisma.approvalRequest.findFirstOrThrow({ where: { kind: 'RECEIPT_BATCH' } });
    expect(req.title).toContain(`${year}년 기부금영수증 1건`);
    const out = await decideApproval({ merchantId: fx.merchantId, id: req.id, decision: 'APPROVE', userId: fx.merchantUserId });
    expect(out.ok && out.message).toContain('1건 발급');
    expect(await prisma.donationReceipt.count({ where: { merchantId: fx.merchantId, taxYear: year } })).toBe(1);
  });

  it('1~2월이 아니면 아무것도 하지 않는다', async () => {
    const r = await runAnnualReceiptPrep(new Date('2026-06-10T01:00:00Z'));
    expect(r.season).toBe(false);
  });
});
