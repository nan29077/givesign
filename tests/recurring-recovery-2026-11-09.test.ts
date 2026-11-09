import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { clearMockOutbox, readMockOutbox } from '@/server/adapters/mt';
import { resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';
import {
  createRecurringDonation,
  runRecurringDonations,
  pauseRecurringUntil,
  resumeScheduledPauses,
  sendResumeNotices,
  setRecurringStatus,
  RECURRING_MAX_ATTEMPTS,
} from '@/server/services/recurring';
import {
  actionDeadline,
  classifyChargeFailure,
  classifyRecurringFailure,
  paydayRetryDate,
  RECURRING_FAILURE_POLICY,
  RECURRING_FAILURE_CLASSES,
} from '@/server/services/recurring-failure';
import { issueRecoveryLink, resolveRecoveryLink } from '@/server/services/recurring-recovery-link';
import {
  cancelFromRecovery,
  changeFromRecovery,
  loadRecoveryView,
  pauseFromRecovery,
  recurringRecoveryInboxGroup,
  recurringRecoveryStats,
  startRecoveryRegistration,
} from '@/server/services/recurring-recovery';
import { completeRegistration, startRegistration } from '@/server/services/payer-registration';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';

/**
 * 2026-11-09 1차 과제 A1 — 정기후원 실패 원인별 복구.
 * mock 결제사: 금액 끝자리 999→M0001(잔액 부족), 991→M0002(계좌 문제), 992→M0003(추가 인증), 993→M0004(결제사 점검).
 */

let fx: Fixture;
const singleBackend = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${process.env.PGLITE_PORT ?? '5463'}/`);
const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
const addDays = (key: string, n: number) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const nextMonthDay = (day: number, base: string) => {
  const [y, m] = base.split('-').map(Number);
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
};
const dayKey = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const dueToday = (id: string) =>
  prisma.recurringDonation.update({ where: { id }, data: { nextChargeOn: new Date(`${kst()}T00:00:00Z`), cycleMonth: kst().slice(0, 7) } });
const row = (id: string) => prisma.recurringDonation.findUniqueOrThrow({ where: { id } });
const templates = () => readMockOutbox(50).map((m) => m.template ?? '');

async function makeRecurring(amount: bigint, dayOfMonth = 10) {
  const payer = await seedRegisteredPayer(fx.payerPhone);
  const made = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount, dayOfMonth });
  if (!made.ok) throw new Error(made.message);
  await dueToday(made.recurring.id);
  clearMockOutbox();
  return { payer, recurring: made.recurring };
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { maxAmount: 1_000_000n } });
  await prisma.termsVersion.create({
    data: { id: newId(), type: 'RECURRING_DEBIT', version: '1.0', title: '정기후원 동의', content: 't', required: false, effectiveFrom: new Date('2026-01-01') },
  });
  registerDefaultConsumers();
});

// ---------------------------------------------------------------------------
describe('실패 분류(순수 함수)', () => {
  it('mock 결제사 코드는 기본표로 분류하고, 결제 건 상태(한도·결제수단 없음)는 코드와 무관하게 분류한다', () => {
    expect(classifyRecurringFailure({ chargeStatus: 'PAYMENT_FAILED', resultCode: 'M0001', provider: 'mock', env: {} })).toBe('INSUFFICIENT_FUNDS');
    expect(classifyRecurringFailure({ chargeStatus: 'PAYMENT_FAILED', resultCode: 'm0002', provider: 'mock', env: {} })).toBe('ACCOUNT_PROBLEM');
    expect(classifyRecurringFailure({ chargeStatus: 'PAYMENT_FAILED', resultCode: 'M0003', provider: 'mock', env: {} })).toBe('AUTH_REQUIRED');
    expect(classifyRecurringFailure({ chargeStatus: 'PAYMENT_FAILED', resultCode: 'M0004', provider: 'mock', env: {} })).toBe('PROVIDER_TEMPORARY');
    expect(classifyRecurringFailure({ chargeStatus: 'LIMIT_BLOCKED', resultCode: null, provider: null, env: {} })).toBe('LIMIT_BLOCKED');
    expect(classifyRecurringFailure({ chargeStatus: 'UNREGISTERED', resultCode: null, provider: null, env: {} })).toBe('NO_PAYMENT_METHOD');
    expect(classifyRecurringFailure({ chargeStatus: 'PAYMENT_FAILED', resultCode: 'ZZZ', provider: 'mock', env: {} })).toBe('UNKNOWN_REASON');
    expect(classifyRecurringFailure({ chargeStatus: 'PAYMENT_FAILED', resultCode: null, provider: 'mock', env: {} })).toBe('UNKNOWN_REASON');
  });

  it('실결제사에서 코드표(환경변수)가 비어 있으면 모든 결제사 실패가 UNKNOWN_REASON — mock 코드도 쓰지 않는다(안전)', () => {
    for (const code of ['M0001', 'M0002', 'M0003', 'M0004', '0051', 'E999']) {
      expect(classifyRecurringFailure({ chargeStatus: 'PAYMENT_FAILED', resultCode: code, provider: 'HECTO', env: {} })).toBe('UNKNOWN_REASON');
    }
    expect(RECURRING_FAILURE_POLICY.UNKNOWN_REASON).toEqual({ retry: 'THREE_DAYS', counts: true, notice: 'GENERIC' });
  });

  it('환경변수 코드표(콤마·대소문자 무관)를 쓰고, 같은 코드가 여러 표에 있으면 계좌 문제가 이긴다', () => {
    const env = { RECURRING_CODES_INSUFFICIENT: ' 0051 , x1 ', RECURRING_CODES_ACCOUNT: 'X1,0014', RECURRING_CODES_AUTH: '0099', RECURRING_CODES_TEMPORARY: '9999' };
    expect(classifyRecurringFailure({ chargeStatus: 'PAYMENT_FAILED', resultCode: '0051', provider: 'HECTO', env })).toBe('INSUFFICIENT_FUNDS');
    expect(classifyRecurringFailure({ chargeStatus: 'PAYMENT_FAILED', resultCode: 'x1', provider: 'HECTO', env })).toBe('ACCOUNT_PROBLEM');
    expect(classifyRecurringFailure({ chargeStatus: 'PAYMENT_FAILED', resultCode: '0099', provider: 'HECTO', env })).toBe('AUTH_REQUIRED');
    expect(classifyRecurringFailure({ chargeStatus: 'PAYMENT_FAILED', resultCode: '9999', provider: 'HECTO', env })).toBe('PROVIDER_TEMPORARY');
  });

  it('정책표는 모든 분류를 덮는다', () => {
    for (const c of RECURRING_FAILURE_CLASSES) expect(RECURRING_FAILURE_POLICY[c]).toBeTruthy();
  });

  it('잔액 부족 재시도일: 오늘+2~+7 안의 11일·26일·다음 달 1일 중 가장 이른 날, 없으면 +3, 다음 주기를 넘기면 +3', () => {
    expect(paydayRetryDate('2026-11-08', '2026-12-10')).toBe('2026-11-11');
    expect(paydayRetryDate('2026-11-20', '2026-12-10')).toBe('2026-11-26');
    expect(paydayRetryDate('2026-11-27', '2026-12-10')).toBe('2026-12-01');
    expect(paydayRetryDate('2026-11-12', '2026-12-10')).toBe('2026-11-15');
    // 경계: 오늘+1(10일→11일)은 창 밖, 오늘+2 는 창 안
    expect(paydayRetryDate('2026-11-10', '2026-12-10')).toBe('2026-11-13');
    expect(paydayRetryDate('2026-11-09', '2026-12-10')).toBe('2026-11-11');
    // 다음 주기 출금일(11/25) 이후가 되면 예전 3일
    expect(paydayRetryDate('2026-11-20', '2026-11-25')).toBe('2026-11-23');
  });

  it('조치 필요 기한: 오늘+14 와 다음 주기 전날 중 이른 날, 최소 내일', () => {
    expect(actionDeadline('2026-11-10', '2026-12-10')).toBe('2026-11-24');
    expect(actionDeadline('2026-11-20', '2026-11-28')).toBe('2026-11-27');
    expect(actionDeadline('2026-11-27', '2026-11-28')).toBe('2026-11-28');
  });

  it('DB: 실결제사 거래의 모르는 코드는 UNKNOWN, 코드표에 넣으면 분류된다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const chargeId = newId();
    await prisma.charge.create({
      data: { id: chargeId, transactionNo: `TRD-${newId()}`, merchantId: fx.merchantId, payerId: payer.id, channel: 'RECURRING', amount: 10000n, displayName: 't', message: 'm', messageRawEnc: 'x', status: 'PAYMENT_FAILED' },
    });
    await prisma.paymentTransaction.create({ data: { id: newId(), chargeId, orderNo: `ORD-${newId()}`, provider: 'HECTO', amount: 10000n, status: 'FAILED', resultCode: 'H0014' } });
    expect(await classifyChargeFailure(chargeId)).toEqual({ failureClass: 'UNKNOWN_REASON', resultCode: 'H0014' });
    process.env.RECURRING_CODES_ACCOUNT = 'H0014';
    try {
      expect((await classifyChargeFailure(chargeId)).failureClass).toBe('ACCOUNT_PROBLEM');
    } finally {
      delete process.env.RECURRING_CODES_ACCOUNT;
    }
  });
});

// ---------------------------------------------------------------------------
describe('원인별 처리', () => {
  it('잔액 부족: 급여일 근처로 재시도, 정지 횟수 포함, 복구 링크가 든 안내 문자, 실행 기록에 원인·코드', async () => {
    const { recurring } = await makeRecurring(10999n);
    const r = await runRecurringDonations();
    expect(r.failed).toBe(1);
    const run = await prisma.recurringRun.findFirstOrThrow({ where: { recurringId: recurring.id, status: 'FAILED' } });
    expect(run.failureClass).toBe('INSUFFICIENT_FUNDS');
    expect(run.resultCode).toBe('M0001');
    const after = await row(recurring.id);
    expect(after.failCount).toBe(1);
    expect(after.recoveryState).toBe('RETRYING');
    expect(after.lastFailureClass).toBe('INSUFFICIENT_FUNDS');
    expect(after.recoveryStartedAt).not.toBeNull();
    const today = kst();
    expect(dayKey(after.nextChargeOn)).toBe(paydayRetryDate(today, nextMonthDay(10, today)));
    const msg = readMockOutbox(10).find((m) => m.template === 'RECURRING_FAILED')!;
    expect(msg.text).toContain('잔액 부족');
    expect(msg.text).toContain('/r/recover/');
    expect(await prisma.recurringRecoveryLink.count({ where: { recurringId: recurring.id, revokedAt: null } })).toBe(1);
  });

  it('결제사 일시 오류: 다음 날 재시도, 문자 없음, 연속 2회까지 정지 횟수에 넣지 않고 그다음부터 세어 정지', async () => {
    const { recurring } = await makeRecurring(10993n);
    const today = kst();
    for (let i = 1; i <= 2; i += 1) {
      await dueToday(recurring.id);
      await runRecurringDonations();
      const a = await row(recurring.id);
      expect(a.failCount).toBe(0);
      expect(a.status).toBe('ACTIVE');
      expect(dayKey(a.nextChargeOn)).toBe(addDays(today, 1));
    }
    await dueToday(recurring.id);
    await runRecurringDonations();
    expect((await row(recurring.id)).failCount).toBe(1);
    expect(templates().filter((t) => t.startsWith('RECURRING_'))).toEqual([]);
    for (let i = 0; i < RECURRING_MAX_ATTEMPTS - 1; i += 1) {
      await dueToday(recurring.id);
      await runRecurringDonations();
    }
    const end = await row(recurring.id);
    expect(end.status).toBe('SUSPENDED');
    expect(templates()).toContain('RECURRING_SUSPENDED');
    // 3번째 실패로 정지되는 경로에서도 정지 이벤트가 남는다(재개 안내 저니의 출발점)
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type: 'recurring.suspended', subjectId: recurring.id } });
    expect((ev.payload as { failureClass?: string }).failureClass).toBe('PROVIDER_TEMPORARY');
  });

  it('일시 오류 사이에 다른 실패가 끼면 연속이 끊긴다', async () => {
    const { recurring } = await makeRecurring(10993n);
    await runRecurringDonations();
    await prisma.recurringDonation.update({ where: { id: recurring.id }, data: { amount: 10999n } });
    await dueToday(recurring.id);
    await runRecurringDonations(); // 잔액 부족 → 1
    await prisma.recurringDonation.update({ where: { id: recurring.id }, data: { amount: 10993n } });
    await dueToday(recurring.id);
    await runRecurringDonations(); // 일시 오류(연속 1) → 세지 않음
    expect((await row(recurring.id)).failCount).toBe(1);
  });

  it('계좌 문제: 자동 재시도 없이 조치 필요 + 기한, 기한 전 배치는 출금하지 않는다', async () => {
    const { recurring } = await makeRecurring(10991n);
    await runRecurringDonations();
    const a = await row(recurring.id);
    const today = kst();
    const deadline = actionDeadline(today, nextMonthDay(10, today));
    expect(a.recoveryState).toBe('ACTION_REQUIRED');
    expect(a.lastFailureClass).toBe('ACCOUNT_PROBLEM');
    expect(dayKey(a.actionDeadlineOn)).toBe(deadline);
    expect(dayKey(a.nextChargeOn)).toBe(deadline);
    const msg = readMockOutbox(10).find((m) => m.template === 'RECURRING_ACCOUNT_PROBLEM')!;
    expect(msg.text).toContain('/r/recover/');

    // 누가 날짜를 당겨도 결제수단을 바꾸지 않았으면 출금하지 않고 기한으로 되돌린다.
    await prisma.recurringDonation.update({ where: { id: recurring.id }, data: { nextChargeOn: new Date(`${today}T00:00:00Z`) } });
    const r2 = await runRecurringDonations();
    expect(r2.skipped).toBe(1);
    expect(await prisma.charge.count({ where: { recurringId: recurring.id } })).toBe(1);
    expect(dayKey((await row(recurring.id)).nextChargeOn)).toBe(deadline);

    const group = await recurringRecoveryInboxGroup(fx.merchantId);
    expect(group).toMatchObject({ kind: 'RECURRING_ACTION_REQUIRED', affectedCount: 1, amount: 10991n, href: '/studio/recurring?recovery=ACTION_REQUIRED' });
    expect(group!.reason).toContain('계좌 문제');
    expect((await recurringRecoveryStats(fx.merchantId)).actionRequired).toBe(1);
  });

  it('추가 인증 필요·결제수단 없음도 조치 필요로 기다리고 원인별 문자를 보낸다', async () => {
    const { recurring } = await makeRecurring(10992n);
    await runRecurringDonations();
    expect((await row(recurring.id)).lastFailureClass).toBe('AUTH_REQUIRED');
    expect(templates()).toContain('RECURRING_AUTH_REQUIRED');

    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
    await prisma.termsVersion.create({ data: { id: newId(), type: 'RECURRING_DEBIT', version: '1.0', title: '정기후원 동의', content: 't', required: false, effectiveFrom: new Date('2026-01-01') } });
    const second = await makeRecurring(10000n);
    // 결제수단이 정기후원 정지 없이 사라진 경우(예: 외부에서 폐기)
    await prisma.paymentMethodToken.updateMany({ where: { payerId: second.payer.id }, data: { status: 'REVOKED' } });
    await runRecurringDonations();
    const b = await row(second.recurring.id);
    expect(b.lastFailureClass).toBe('NO_PAYMENT_METHOD');
    expect(b.recoveryState).toBe('ACTION_REQUIRED');
    expect(templates()).toContain('RECURRING_NO_METHOD');
  });

  it('조치 기한까지 결제수단을 바꾸지 않으면 정지(정지 문자·이벤트), 출금 시도는 하지 않는다', async () => {
    const { recurring } = await makeRecurring(10991n);
    await runRecurringDonations();
    const deadline = dayKey((await row(recurring.id)).actionDeadlineOn)!;
    clearMockOutbox();
    const r = await runRecurringDonations(new Date(`${deadline}T01:00:00Z`));
    expect(r.suspended).toBe(1);
    const a = await row(recurring.id);
    expect(a.status).toBe('SUSPENDED');
    expect(a.recoveryState).toBe('NONE');
    expect(templates()).toContain('RECURRING_SUSPENDED');
    expect(await prisma.charge.count({ where: { recurringId: recurring.id } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'recurring.suspended', subjectId: recurring.id } })).toBe(1);
  });

  it('조치 필요 → 복구 링크로 결제수단 다시 등록 → 이벤트 소비자가 오늘로 당기고 → 배치가 출금 → 복구 기록', async () => {
    const { payer, recurring } = await makeRecurring(10991n);
    await runRecurringDonations();
    const link = await issueRecoveryLink(recurring.id, payer.id);
    // 새 계좌는 정상(금액 끝자리로만 실패를 재현하므로 금액을 바꿔 둔다)
    await prisma.recurringDonation.update({ where: { id: recurring.id }, data: { amount: 10000n } });

    const href = await startRecoveryRegistration(link.token);
    expect(href).toMatch(/^\/r\/[A-Za-z0-9_-]+$/);
    const rawToken = href.slice(3);
    const consents = (['TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM'] as const).map((type) => ({ type, agreed: true }));
    const reg = await startRegistration({ token: rawToken, consents });
    await completeRegistration({ token: rawToken, registrationId: reg.registrationId, providerPayload: { tid: 'MOCK-RECOVER', bankCode: '004', bankName: 'KB국민은행', account: '11122233344455' } });
    expect(await prisma.domainEvent.count({ where: { type: 'payment_method.registered', payerId: payer.id } })).toBe(1);

    await processDomainEvents();
    expect(dayKey((await row(recurring.id)).nextChargeOn)).toBe(kst());

    const r = await runRecurringDonations();
    expect(r.succeeded).toBe(1);
    const after = await row(recurring.id);
    expect(after.recoveryState).toBe('NONE');
    expect(after.failCount).toBe(0);
    expect(after.lastFailureClass).toBeNull();
    const success = await prisma.recurringRun.findFirstOrThrow({ where: { recurringId: recurring.id, status: 'SUCCESS' } });
    expect(success.recovered).toBe(true);
    const ev = await prisma.domainEvent.findMany({ where: { type: 'recurring.recovered', subjectId: recurring.id } });
    expect(ev).toHaveLength(1);
    expect(ev[0].dedupeKey).toBe(`recurring.recovered:${recurring.id}:${success.monthKey}`);
    const stats = await recurringRecoveryStats(fx.merchantId);
    expect(stats.thisMonth.recovered).toBe(1);
    expect(stats.thisMonth.recoveredAmount).toBe(10000n);
    expect(stats.last30.failed).toBe(1);
    expect(await recurringRecoveryInboxGroup(fx.merchantId)).toBeNull();
  });

  it('잔액 부족 뒤 같은 주기에 성공하면 복구로 기록되고, 실패 없던 성공은 복구가 아니다', async () => {
    const { recurring } = await makeRecurring(10999n);
    await runRecurringDonations();
    await prisma.recurringDonation.update({ where: { id: recurring.id }, data: { amount: 10000n } });
    await dueToday(recurring.id);
    await runRecurringDonations();
    expect((await prisma.recurringRun.findFirstOrThrow({ where: { recurringId: recurring.id, status: 'SUCCESS' } })).recovered).toBe(true);

    const other = await createRecurringDonation({ payerId: (await seedRegisteredPayer('01099998888')).id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 10 });
    if (!other.ok) throw new Error(other.message);
    await dueToday(other.recurring.id);
    await runRecurringDonations();
    expect((await prisma.recurringRun.findFirstOrThrow({ where: { recurringId: other.recurring.id, status: 'SUCCESS' } })).recovered).toBe(false);
  });

  it('한도 차단: 다음 날 재시도, 정지 횟수 포함, 예전 실패 안내 문자', async () => {
    const { payer, recurring } = await makeRecurring(10000n);
    await prisma.payerProfile.update({ where: { id: payer.id }, data: { dailyLimit: 5000n } });
    await runRecurringDonations();
    const a = await row(recurring.id);
    expect(a.lastFailureClass).toBe('LIMIT_BLOCKED');
    expect(a.failCount).toBe(1);
    expect(dayKey(a.nextChargeOn)).toBe(addDays(kst(), 1));
    expect(templates()).toContain('RECURRING_FAILED');
  });

  it('재개(RESUME)하면 복구 상태가 처음으로 돌아간다', async () => {
    const { payer, recurring } = await makeRecurring(10991n);
    await runRecurringDonations();
    await setRecurringStatus(payer.id, recurring.id, 'PAUSE');
    await setRecurringStatus(payer.id, recurring.id, 'RESUME');
    const a = await row(recurring.id);
    expect(a.recoveryState).toBe('NONE');
    expect(a.actionDeadlineOn).toBeNull();
    expect(a.failCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('날짜를 정해 쉬어 가기(재개 예정일)', () => {
  it('재개 예정일 검증: 오늘·과거·180일 넘김은 거절, 해지된 약정은 거절', async () => {
    const { payer, recurring } = await makeRecurring(10000n);
    const today = kst();
    await expect(pauseRecurringUntil(payer.id, recurring.id, today)).rejects.toThrow('내일 이후');
    await expect(pauseRecurringUntil(payer.id, recurring.id, addDays(today, 181))).rejects.toThrow('180일');
    await expect(pauseRecurringUntil(payer.id, recurring.id, '2026-02-30x')).rejects.toThrow();
    await setRecurringStatus(payer.id, recurring.id, 'CANCEL');
    await expect(pauseRecurringUntil(payer.id, recurring.id, addDays(today, 3))).rejects.toThrow();
  });

  it('전날 안내 1회 → 그날 배치가 다시 시작(그날이 출금일이면 바로 출금), 같은 배치를 다시 돌려도 한 번', async () => {
    const today = kst();
    const resumeOn = addDays(today, 5);
    const day = Number(resumeOn.slice(8, 10)) > 28 ? 1 : Number(resumeOn.slice(8, 10));
    const { payer, recurring } = await makeRecurring(10000n, day);
    const res = await pauseRecurringUntil(payer.id, recurring.id, resumeOn);
    expect((await row(recurring.id)).status).toBe('PAUSED');
    expect(res.resumeOn).toBe(resumeOn);

    const dayBefore = new Date(`${addDays(resumeOn, -1)}T01:00:00Z`);
    await runRecurringDonations(dayBefore);
    await sendResumeNotices(dayBefore);
    expect(templates().filter((t) => t === 'RECURRING_RESUME_SOON')).toHaveLength(1);

    const at = new Date(`${resumeOn}T01:00:00Z`);
    const summary = await runRecurringDonations(at);
    expect(summary.resumed).toBe(1);
    const a = await row(recurring.id);
    expect(a.status).toBe('ACTIVE');
    expect(a.resumeOn).toBeNull();
    if (day === Number(resumeOn.slice(8, 10))) expect(summary.succeeded).toBe(1);
    expect(await resumeScheduledPauses(at)).toBe(0);
    expect(await prisma.domainEvent.count({ where: { type: 'recurring.resumed', subjectId: recurring.id } })).toBe(1);
  });

  it.skipIf(singleBackend)('자동 재개가 겹쳐 돌아도 한 번만 재개된다', async () => {
    const { payer, recurring } = await makeRecurring(10000n);
    const resumeOn = addDays(kst(), 2);
    await pauseRecurringUntil(payer.id, recurring.id, resumeOn);
    const at = new Date(`${resumeOn}T01:00:00Z`);
    const [a, b] = await Promise.all([resumeScheduledPauses(at), resumeScheduledPauses(at)]);
    expect(a + b).toBe(1);
  });

  it('결제수단이 없으면 자동 재개하지 않고 일시정지를 유지한다', async () => {
    const { payer, recurring } = await makeRecurring(10000n);
    const resumeOn = addDays(kst(), 2);
    await pauseRecurringUntil(payer.id, recurring.id, resumeOn);
    await prisma.paymentMethodToken.updateMany({ where: { payerId: payer.id }, data: { status: 'REVOKED' } });
    expect(await resumeScheduledPauses(new Date(`${resumeOn}T01:00:00Z`))).toBe(0);
    const a = await row(recurring.id);
    expect(a.status).toBe('PAUSED');
    expect(a.resumeOn).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('후원자 복구 링크·화면', () => {
  it('토큰은 해시만 저장, 새 링크를 만들면 이전 링크는 무효, 기간이 지나면 열리지 않는다', async () => {
    const { payer, recurring } = await makeRecurring(10000n);
    const first = await issueRecoveryLink(recurring.id, payer.id);
    expect(await prisma.recurringRecoveryLink.count({ where: { tokenHash: first.token } })).toBe(0);
    expect((await resolveRecoveryLink(first.token)).ok).toBe(true);
    const second = await issueRecoveryLink(recurring.id, payer.id);
    expect(await resolveRecoveryLink(first.token)).toEqual({ ok: false, reason: 'REVOKED' });
    expect((await resolveRecoveryLink(second.token)).ok).toBe(true);
    expect(await resolveRecoveryLink(second.token, new Date(Date.now() + 16 * 86_400_000))).toEqual({ ok: false, reason: 'EXPIRED' });
    expect((await resolveRecoveryLink('nope')).ok).toBe(false);
  });

  it('화면: 왜·무엇을·다음 출금을 쉬운 말로, 링크는 그 약정만 다룬다(다른 후원자 약정을 가리키면 열지 않음)', async () => {
    const { payer, recurring } = await makeRecurring(10991n);
    await runRecurringDonations();
    const link = await issueRecoveryLink(recurring.id, payer.id);
    const view = await loadRecoveryView(link.token);
    if (!view.ok) throw new Error(view.reason);
    expect(view.view.failureLabel).toBe('계좌 문제');
    expect(view.view.why).toContain('계좌');
    expect(view.view.nextLine).toContain('까지 결제수단을 다시 등록하지 않으면');

    const other = await seedRegisteredPayer('01077776666');
    const forged = await issueRecoveryLink(recurring.id, other.id);
    const bad = await loadRecoveryView(forged.token);
    expect(bad.ok).toBe(false);
    await expect(cancelFromRecovery(forged.token)).rejects.toThrow();
    expect((await row(recurring.id)).status).toBe('ACTIVE');
  });

  it('출금일 바꾸기·쉬어 가기·해지는 결과를 문장으로 돌려준다', async () => {
    const { payer, recurring } = await makeRecurring(10999n);
    await runRecurringDonations();
    const link = await issueRecoveryLink(recurring.id, payer.id);
    const changed = await changeFromRecovery(link.token, { dayOfMonth: 25, amount: 30000n });
    expect(changed).toMatch(/출금부터 매월 25일 30,000원이 적용됩니다/);
    await expect(changeFromRecovery(link.token, { dayOfMonth: 25, amount: 30000n })).rejects.toThrow('바꿀 내용이 없습니다');

    const paused = await pauseFromRecovery(link.token, addDays(kst(), 10));
    expect(paused).toContain('다시 시작합니다');
    expect((await row(recurring.id)).status).toBe('PAUSED');

    const canceled = await cancelFromRecovery(link.token, '경제적인 사정');
    expect(canceled).toContain('해지했습니다');
    const a = await row(recurring.id);
    expect(a.status).toBe('CANCELED');
    expect(a.cancelReason).toBe('경제적인 사정');
    expect(a.resumeOn).toBeNull();
  });
});

describe('(5차 검토) 복구 링크도 정기 해지·변경 본인인증 규칙을 탄다', () => {
  it('IDENTITY_REQUIRED_FOR_RECURRING 이 켜져 있으면 본인인증 없이 복구 링크로 바꾸거나 해지할 수 없다(꺼짐이면 예전대로)', async () => {
    const { payer, recurring } = await makeRecurring(10000n);
    const link = await issueRecoveryLink(recurring.id, payer.id);
    const prev = process.env.IDENTITY_REQUIRED_FOR_RECURRING;
    process.env.IDENTITY_REQUIRED_FOR_RECURRING = 'true';
    try {
      await expect(changeFromRecovery(link.token, { dayOfMonth: 20 })).rejects.toThrow(/본인인증/);
      await expect(cancelFromRecovery(link.token)).rejects.toThrow(/본인인증/);
      const r = await row(recurring.id);
      expect(r.status).toBe('ACTIVE');
      expect(r.dayOfMonth).toBe(10);
    } finally {
      if (prev === undefined) delete process.env.IDENTITY_REQUIRED_FOR_RECURRING;
      else process.env.IDENTITY_REQUIRED_FOR_RECURRING = prev;
    }
    await expect(cancelFromRecovery(link.token)).resolves.toMatch(/해지/);
    expect((await row(recurring.id)).status).toBe('CANCELED');
  });
});

