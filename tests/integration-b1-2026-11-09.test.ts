import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';
import { createRecurringDonation, runRecurringDonations } from '@/server/services/recurring';
import { loadInboxGroups, resetInboxGroupProviders } from '@/server/services/inbox-groups';
import { registerDefaultConsumers } from '@/server/services/event-consumers';

/**
 * 2026-11-09 1차 통합 — A(정기후원 복구) 묶음이 C(승인 대기함 예외 묶음)에 들어오는지,
 * B(단계 측정)가 정기후원 결제를 세지 않는지.
 */

let fx: Fixture;
const kst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

beforeEach(async () => {
  await resetDb();
  resetInboxGroupProviders();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { maxAmount: 1_000_000n } });
  await prisma.termsVersion.create({
    data: { id: newId(), type: 'RECURRING_DEBIT', version: '1.0', title: '정기후원 동의', content: 't', required: false, effectiveFrom: new Date('2026-01-01') },
  });
  registerDefaultConsumers();
});

async function failingRecurring(amount: bigint) {
  const payer = await seedRegisteredPayer(fx.payerPhone);
  const made = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount, dayOfMonth: 10 });
  if (!made.ok) throw new Error(made.message);
  await prisma.recurringDonation.update({
    where: { id: made.recurring.id },
    data: { nextChargeOn: new Date(`${kst()}T00:00:00Z`), cycleMonth: kst().slice(0, 7) },
  });
  await runRecurringDonations();
  return made.recurring;
}

describe('1차 통합', () => {
  it('정기후원 조치 필요 약정이 승인 대기함 예외 묶음(high)으로 나온다', async () => {
    await failingRecurring(10991n); // mock 계좌 문제
    const groups = await loadInboxGroups(fx.merchantId);
    const g = groups.find((x) => x.group?.kind === 'RECURRING_ACTION_REQUIRED');
    expect(g).toBeTruthy();
    expect(g!.group).toMatchObject({ affectedCount: 1, severity: 'high', href: '/studio/recurring?recovery=ACTION_REQUIRED' });
  });

  it('조치 필요 약정이 없으면 정기후원 복구 묶음이 없다', async () => {
    const groups = await loadInboxGroups(fx.merchantId);
    expect(groups.some((x) => x.group?.kind === 'RECURRING_ACTION_REQUIRED')).toBe(false);
  });

  it('정기후원 출금 결제는 문자 후원 단계 측정에 들어가지 않는다', async () => {
    await failingRecurring(10000n);
    expect(await prisma.charge.count({ where: { channel: 'RECURRING' } })).toBe(1);
    expect(await prisma.funnelStep.count()).toBe(0);
  });
});
