import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';
import { donorDonationHistory } from '@/server/services/donor-history';
import { setPreferredChannel, getPreferredChannel } from '@/server/services/donor-preferences';
import { prefersSmsOnly } from '@/server/services/outbound/preferred-channel';

/**
 * 2026-11-09 2차 통합 — E(계좌이체 확정분)가 F(후원자 후원 내역)에 출처 표시로 나오고,
 * F(연락 선호 화면)가 저장한 값을 D(발송 경로)가 그대로 읽는지.
 */

let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
});

describe('2차 통합', () => {
  it('계좌이체 확정분은 후원 내역에 "계좌이체" 로 나오고, 되돌린 건은 빠진다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const at = new Date();
    await prisma.offlineDonation.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: payer.id, source: 'MANUAL', amount: 30000n, donatedAt: at, createdBy: 'test' } });
    await prisma.offlineDonation.create({
      data: { id: newId(), merchantId: fx.merchantId, payerId: payer.id, source: 'MANUAL', amount: 50000n, donatedAt: at, createdBy: 'test', status: 'REVERTED', revertedAt: at, revertReason: 'x' },
    });
    const h = await donorDonationHistory(payer.id, { merchantId: fx.merchantId });
    const offline = h.entries.filter((e) => e.source === 'OFFLINE');
    expect(offline).toHaveLength(1);
    expect(offline[0]).toMatchObject({ sourceLabel: '계좌이체', amount: 30000n });
    expect(h.yearTotal).toBe(30000n);
    expect(h.failedSources).toEqual([]);
  });

  it('후원자가 고른 연락 선호(문자만)를 발송 경로가 그대로 읽는다 — 값 이름이 하나로 통일됨', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    expect(await getPreferredChannel(payer.id)).toBe('ALIMTALK');
    expect(await prefersSmsOnly(fx.payerPhone)).toBe(false);
    await setPreferredChannel(payer.id, 'SMS');
    expect(await prefersSmsOnly(fx.payerPhone)).toBe(true);
  });
});
