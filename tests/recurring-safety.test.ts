import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { clearMockOutbox, readMockOutbox } from '@/server/adapters/mt';
import { resetMockPaymentState } from '@/server/adapters/payment';
import { resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';
import {
  createRecurringDonation,
  runRecurringDonations,
  updateRecurringDonation,
  RECURRING_MAX_ATTEMPTS,
} from '@/server/services/recurring';
import { revokePaymentMethod } from '@/server/services/payer-registration';

/**
 * 정기후원 돈 안전 회귀 테스트 (2026-10-29 전체 점검 H-1, H-2, H-5, M-1~M-5).
 * 점검 때 재현한 시나리오를 "올바른 동작"으로 고정한다.
 */

let fx: Fixture;
const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
const dueToday = (id: string) =>
  prisma.recurringDonation.update({ where: { id }, data: { nextChargeOn: new Date(`${kst()}T00:00:00Z`), cycleMonth: kst().slice(0, 7) } });

async function makeRecurring(amount: bigint, extra: { message?: string } = {}) {
  const payer = await seedRegisteredPayer(fx.payerPhone);
  const made = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount, dayOfMonth: 10, ...extra });
  if (!made.ok) throw new Error(made.message);
  return { payer, recurring: made.recurring };
}

beforeEach(async () => {
  await resetDb();
  clearMockOutbox();
  resetMockPaymentState();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  // 정기후원 한도 검사가 기관 최대 금액(기본 5만원)을 쓰므로 테스트 금액이 들어가게 넓혀 둔다.
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { maxAmount: 1_000_000n } });
  await prisma.termsVersion.create({
    data: { id: newId(), type: 'RECURRING_DEBIT', version: '1.0', title: '정기후원 동의', content: 't', required: false, effectiveFrom: new Date('2026-01-01') },
  });
});

describe('정기후원 — 결과 미확인 (H-1)', () => {
  it('결과 미확인이면 확인 대기로 남기고, 다음 실행에서도 새 결제를 만들지 않는다', async () => {
    // mock 결제사: 금액 끝자리 666 = 타임아웃 + 거래결과조회도 실패
    const { recurring } = await makeRecurring(10666n);
    await dueToday(recurring.id);
    const first = await runRecurringDonations();
    expect(first.pending).toBe(1);
    expect(first.failed).toBe(0);
    const run = await prisma.recurringRun.findFirstOrThrow({ where: { recurringId: recurring.id } });
    expect(run.status).toBe('PENDING');

    // 실패 안내 문자를 보내지 않는다(이중청구 오해 방지).
    expect(readMockOutbox(10).some((m) => m.template === 'RECURRING_FAILED')).toBe(false);

    await dueToday(recurring.id);
    const second = await runRecurringDonations();
    expect(second.pending).toBe(1);
    expect(await prisma.charge.count({ where: { recurringId: recurring.id } })).toBe(1);
  });

  it('관리자 대사로 성공이 확정되면 그 주기를 성공으로 넘기고 다시 출금하지 않는다', async () => {
    const { recurring } = await makeRecurring(10666n);
    await dueToday(recurring.id);
    await runRecurringDonations();
    const charge = await prisma.charge.findFirstOrThrow({ where: { recurringId: recurring.id } });
    // 대사 결과: 실제로는 출금됐다
    await prisma.paymentTransaction.updateMany({ where: { chargeId: charge.id }, data: { status: 'APPROVED' } });
    await prisma.charge.update({ where: { id: charge.id }, data: { status: 'PAYMENT_SUCCESS', paidAt: new Date() } });

    await dueToday(recurring.id);
    const r = await runRecurringDonations();
    expect(r.succeeded).toBe(1);
    expect(await prisma.charge.count({ where: { recurringId: recurring.id } })).toBe(1);
    const row = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: recurring.id } });
    expect(row.cycleMonth > kst().slice(0, 7)).toBe(true);
    expect(row.successCount).toBe(1);
  });

  it('관리자 대사로 실패가 확정되면 같은 주기에 한 번 더 시도한다', async () => {
    const { recurring } = await makeRecurring(10666n);
    await dueToday(recurring.id);
    await runRecurringDonations();
    const charge = await prisma.charge.findFirstOrThrow({ where: { recurringId: recurring.id } });
    await prisma.paymentTransaction.updateMany({ where: { chargeId: charge.id }, data: { status: 'FAILED' } });
    await prisma.charge.update({ where: { id: charge.id }, data: { status: 'PAYMENT_FAILED' } });
    // 다음 시도는 정상 금액으로(약정 금액을 바꿔 mock 이 승인하게 한다)
    await prisma.recurringDonation.update({ where: { id: recurring.id }, data: { amount: 10000n } });

    await dueToday(recurring.id);
    const r = await runRecurringDonations();
    expect(r.succeeded).toBe(1);
    expect(await prisma.charge.count({ where: { recurringId: recurring.id } })).toBe(2);
    const runs = await prisma.recurringRun.findMany({ where: { recurringId: recurring.id }, orderBy: { ranAt: 'asc' } });
    expect(runs.map((x) => x.status)).toEqual(['FAILED', 'SUCCESS']);
  });

  it('결제 요청 전에 멈춘 건(거래 기록 없음)은 실패로 확정하고 다시 시도한다', async () => {
    const { recurring, payer } = await makeRecurring(10000n);
    await dueToday(recurring.id);
    const cycle = kst().slice(0, 7);
    // 결제 건은 만들었지만 결제사 요청 전에 프로세스가 죽은 상태를 흉내 낸다.
    const stuck = await prisma.charge.create({
      data: {
        id: newId(), transactionNo: `TRD-T-${newId().slice(-6)}`, merchantId: fx.merchantId, payerId: payer.id, channel: 'RECURRING',
        amount: 10000n, displayName: 'x', message: '정기후원', status: 'PENDING_PAYMENT', paymentMode: 'RECURRING', recurringId: recurring.id,
      },
    });
    await prisma.idempotencyKey.create({
      data: { id: newId(), scope: 'charge', key: `recurring:${recurring.id}:${cycle}`, status: 'DONE', resourceId: stuck.id, expiresAt: new Date(Date.now() + 86400000) },
    });
    await prisma.recurringRun.create({ data: { id: newId(), recurringId: recurring.id, monthKey: cycle, attempt: 1, status: 'PENDING', chargeId: stuck.id } });

    const r = await runRecurringDonations();
    expect(r.succeeded).toBe(1);
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe('PAYMENT_FAILED');
  });
});

describe('정기후원 — 약정 (H-2, H-5, M-4)', () => {
  it('같은 기관 약정을 동시에 두 번 요청해도 한 건만 생긴다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const req = () => createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 10 });
    const rs = await Promise.all([req(), req(), req()]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.recurringDonation.count({ where: { payerId: payer.id, merchantId: fx.merchantId } })).toBe(1);
  });

  it('메시지는 MO·웹과 같은 필터를 거쳐 전화번호가 가려지고 80자로 잘린다', async () => {
    const { recurring } = await makeRecurring(10000n, { message: `010-9876-5432 로 연락주세요 ${'가'.repeat(120)}` });
    expect(recurring.message).not.toContain('9876');
    expect(recurring.message.length).toBeLessThanOrEqual(80);
    await dueToday(recurring.id);
    await runRecurringDonations();
    const c = await prisma.charge.findFirstOrThrow({ where: { recurringId: recurring.id } });
    expect(c.message).not.toContain('9876');
    expect(c.paymentMode).toBe('RECURRING');
    expect(c.pointStatus).toBe('SKIPPED');
  });

  it('기관 최대 금액·이용 한도를 넘는 약정은 만들지 않는다', async () => {
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { maxAmount: 50000n } });
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const r = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 60000n, dayOfMonth: 10 });
    expect(r.ok).toBe(false);
    const ok = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 50000n, dayOfMonth: 10 });
    expect(ok.ok).toBe(true);
    await expect(updateRecurringDonation(payer.id, (ok as { recurring: { id: string } }).recurring.id, { amount: 70000n })).rejects.toThrow();
  });

  it('출금일에 숫자가 아닌 값·소수는 거절한다', async () => {
    const { payer, recurring } = await makeRecurring(10000n);
    await expect(updateRecurringDonation(payer.id, recurring.id, { dayOfMonth: Number('abc') })).rejects.toThrow();
    await expect(updateRecurringDonation(payer.id, recurring.id, { dayOfMonth: 10.5 })).rejects.toThrow();
  });
});

describe('정기후원 — 실패 처리 (M-1, M-2, 낮음)', () => {
  it('건너뜀 기록은 실패 횟수에 넣지 않는다', async () => {
    const { recurring } = await makeRecurring(10999n);
    const cycle = kst().slice(0, 7);
    for (const attempt of [1, 2]) {
      await prisma.recurringRun.create({ data: { id: newId(), recurringId: recurring.id, monthKey: cycle, attempt, status: 'SKIPPED', reason: '자동 출금 미승인' } });
    }
    await dueToday(recurring.id);
    await runRecurringDonations();
    const row = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: recurring.id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.failCount).toBe(1);
  });

  it('재시도가 다음 달로 넘어가도 원래 주기로 기록하고, 다음 출금은 그다음 주기로 잡는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const made = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 27 });
    if (!made.ok) throw new Error(made.message);
    // 10월 주기(27일)의 재시도가 11월 2일로 넘어온 상태
    await prisma.recurringDonation.update({
      where: { id: made.recurring.id },
      data: { cycleMonth: '2026-10', nextChargeOn: new Date('2026-11-02T00:00:00Z'), failCount: 2 },
    });
    const r = await runRecurringDonations(new Date('2026-11-02T01:00:00Z'));
    expect(r.succeeded).toBe(1);
    const run = await prisma.recurringRun.findFirstOrThrow({ where: { recurringId: made.recurring.id, status: 'SUCCESS' } });
    expect(run.monthKey).toBe('2026-10');
    const row = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: made.recurring.id } });
    expect(row.cycleMonth).toBe('2026-11');
    expect(row.nextChargeOn.toISOString().slice(0, 10)).toBe('2026-11-27');
  });

  it('정기출금 실패는 후원자 실패 카운터에 쌓이지 않고 일반 실패 문자도 보내지 않는다', async () => {
    const { payer, recurring } = await makeRecurring(10999n);
    clearMockOutbox();
    await dueToday(recurring.id);
    await runRecurringDonations();
    const p = await prisma.payerProfile.findUniqueOrThrow({ where: { id: payer.id } });
    expect(p.failCount).toBe(0);
    const templates = readMockOutbox(10).map((m) => m.template);
    expect(templates).toContain('RECURRING_FAILED');
    expect(templates).not.toContain('CHARGE_FAILED');
  });

  it(`한 주기 실패 ${RECURRING_MAX_ATTEMPTS}회면 정지된다`, async () => {
    const { recurring } = await makeRecurring(10999n);
    for (let i = 0; i < RECURRING_MAX_ATTEMPTS; i += 1) {
      await dueToday(recurring.id);
      await runRecurringDonations();
    }
    const row = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: recurring.id } });
    expect(row.status).toBe('SUSPENDED');
  });

  it('결제수단을 해지하면 정기후원이 바로 정지된다', async () => {
    const { payer, recurring } = await makeRecurring(10000n);
    await revokePaymentMethod(payer.id);
    expect((await prisma.recurringDonation.findUniqueOrThrow({ where: { id: recurring.id } })).status).toBe('SUSPENDED');
  });
});
