import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt } from '@/lib/crypto';
import { inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import {
  findDueCharges,
  runMerchantPayout,
  runScheduledPayouts,
  retryPayout,
  buildPayoutDashboard,
} from '@/server/services/auto-settlement';
import { getSettlementSummary } from '@/server/services/settlement';
import { resolveSettlementDays, buildUpcomingPayouts } from '@/server/services/settlement-schedule';
import { resetMockPayoutState } from '@/server/adapters/payout';
import { toDateKey } from '@/lib/business-day';

/**
 * 자동 정산 (지정 지급일 자동 지급).
 *
 * 돈이 나가는 경로라서 확인해야 하는 것
 *  - 지급일 전에는 지급되지 않는다
 *  - 같은 건이 두 번 지급되지 않는다
 *  - 계좌 미인증이면 지급되지 않고 다음 회차로 이월된다
 *  - 최소 지급 금액 미만이면 이월된다
 *  - 대행사 응답을 못 받으면 재이체하지 않고 조회로 확정한다
 *  - 지급 실패 재시도는 조회로 먼저 확인한다
 */

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => inboundAndPay(p, fx.merchantId);

/** 계좌 등록. accountNo 끝자리로 mock 어댑터의 결과를 조종한다. */
async function account(merchantId: string, accountNo = '11122233344455', verified = true) {
  await prisma.settlementAccount.upsert({
    where: { merchantId },
    create: {
      id: newId(), merchantId, bankCode: '004', bankName: 'KB국민은행',
      accountEnc: encrypt(accountNo), accountTail4: accountNo.slice(-4),
      holderNameEnc: encrypt('김가맹'), holderMasked: '김*맹',
      verified, verifiedAt: verified ? new Date() : null,
    },
    update: {
      accountEnc: encrypt(accountNo), accountTail4: accountNo.slice(-4),
      verified, verifiedAt: verified ? new Date() : null,
    },
  });
}

/** 결제 완료 건을 만들고, 지급일이 지난 것처럼 결제 시각을 과거로 밀어둔다. */
async function fund(count = 5, daysAgo = 30) {
  await seedRegisteredPayer(fx.payerPhone);
  for (let i = 0; i < count; i += 1) {
    await inbound(moPayload({ to: fx.moNumber, messageId: `AUTO-${i}-${Date.now()}`, text: `충전 ${i}` }));
  }
  if (daysAgo > 0) {
    const past = new Date(Date.now() - daysAgo * 86_400_000);
    await prisma.charge.updateMany({
      where: { merchantId: fx.merchantId, paidAt: { not: null } },
      data: { paidAt: past },
    });
    // 정산 원장은 append-only(트리거로 UPDATE 차단)라 손대지 않는다.
    // 지급 대상 판정은 charge.paidAt 으로만 하므로 결제 시각만 밀면 충분하다.
  }
  // 한도 정책 때문에 요청한 건수가 모두 결제되지는 않는다. 실제로 결제된 건수를 돌려준다.
  const paid = await prisma.charge.count({
    where: { merchantId: fx.merchantId, paidAt: { not: null }, settledAt: null },
  });
  return { available: (await getSettlementSummary(fx.merchantId)).available, paid };
}

beforeEach(async () => {
  await resetDb();
  resetMockPayoutState();
  fx = await seedBasics();
});

describe('지급일 정책 (일괄 지정 + 사회복지기관별 조정)', () => {
  it('[1] 전역 정책의 지급일이 기본으로 적용된다', async () => {
    await prisma.feePolicy.updateMany({ where: { scope: 'GLOBAL' }, data: { settlementDays: 7 } });
    expect(await resolveSettlementDays(fx.merchantId)).toBe(7);
  });

  it('[2] 사회복지기관 정책이 있으면 전역 정책을 덮어쓴다', async () => {
    await prisma.feePolicy.updateMany({ where: { scope: 'GLOBAL' }, data: { settlementDays: 7 } });
    await prisma.feePolicy.create({
      data: {
        id: newId(), scope: 'MERCHANT', merchantId: fx.merchantId,
        pgFeeRate: '0.018', platformFeeRate: '0.15', settlementDays: 2,
      },
    });
    expect(await resolveSettlementDays(fx.merchantId)).toBe(2);
  });

  it('[3] 정책이 없으면 코드 기본값 5영업일', async () => {
    await prisma.feePolicy.deleteMany({});
    expect(await resolveSettlementDays(fx.merchantId)).toBe(5);
  });
});

describe('지급 대상 산정', () => {
  it('[4] 지급일이 지나지 않은 결제는 대상이 아니다', async () => {
    await fund(3, 0); // 오늘 결제
    const { charges } = await findDueCharges(fx.merchantId);
    expect(charges).toHaveLength(0);
  });

  it('[5] 지급일이 지난 결제만 대상이 된다', async () => {
    const { paid } = await fund(3, 30);
    expect(paid).toBeGreaterThan(0);
    const { charges } = await findDueCharges(fx.merchantId);
    expect(charges).toHaveLength(paid);
  });

  it('[6] 지급 예정 집계는 미정산 건을 지급일별로 묶는다', async () => {
    await fund(3, 30);
    const upcoming = await buildUpcomingPayouts(fx.merchantId);
    expect(upcoming.rows.length).toBeGreaterThan(0);
    expect(upcoming.rows.every((r) => r.due)).toBe(true);
    expect(upcoming.total).toBeGreaterThan(0n);
  });
});

describe('자동 지급 실행', () => {
  it('[7] 지급일이 지나면 자동으로 지급되고 결제 건이 정산 완료로 바뀐다', async () => {
    await account(fx.merchantId);
    const { available, paid } = await fund(5, 30);

    const result = await runMerchantPayout(fx.merchantId);
    expect(result.status).toBe('PAID');
    expect(result.amount).toBe(available);

    const req = await prisma.settlementRequest.findFirst({ where: { merchantId: fx.merchantId } });
    expect(req?.status).toBe('PAID');
    expect(req?.auto).toBe(true);

    const settled = await prisma.charge.count({ where: { merchantId: fx.merchantId, settledAt: { not: null } } });
    expect(settled).toBe(paid);
  });

  it('[8] 같은 날 두 번 돌아도 두 번 지급하지 않는다', async () => {
    await account(fx.merchantId);
    await fund(5, 30);

    const first = await runMerchantPayout(fx.merchantId);
    expect(first.status).toBe('PAID');

    const second = await runMerchantPayout(fx.merchantId);
    expect(second.status).toBe('SKIPPED');

    const count = await prisma.settlementRequest.count({ where: { merchantId: fx.merchantId } });
    expect(count).toBe(1);
  });

  it('[9] 지급된 건은 다음 회차 대상에서 빠진다', async () => {
    await account(fx.merchantId);
    await fund(5, 30);
    await runMerchantPayout(fx.merchantId);

    const { charges } = await findDueCharges(fx.merchantId);
    expect(charges).toHaveLength(0);
  });

  it('[10] 계좌가 인증되지 않으면 지급하지 않고 이월한다', async () => {
    await account(fx.merchantId, '11122233344455', false);
    const { paid } = await fund(5, 30);

    const result = await runMerchantPayout(fx.merchantId);
    expect(result.status).toBe('SKIPPED');
    expect(result.reason).toMatch(/인증/);

    // 금액은 사라지지 않고 여전히 지급 대상으로 남아 있어야 한다.
    const { charges } = await findDueCharges(fx.merchantId);
    expect(charges.length).toBe(paid);
  });

  it('[11] 계좌 오류로 이체가 실패하면 회차가 PAYOUT_FAILED 로 남고 결제 건은 미정산으로 유지된다', async () => {
    await account(fx.merchantId, '11122233340000'); // mock: ACCOUNT_INVALID
    await fund(5, 30);

    const result = await runMerchantPayout(fx.merchantId);
    expect(result.status).toBe('FAILED');

    const req = await prisma.settlementRequest.findFirst({ where: { merchantId: fx.merchantId } });
    expect(req?.status).toBe('PAYOUT_FAILED');
    expect(req?.payoutFailReason).toContain('ACCOUNT_INVALID');

    const settled = await prisma.charge.count({ where: { merchantId: fx.merchantId, settledAt: { not: null } } });
    expect(settled).toBe(0);
  });

  it('[12] 응답을 못 받으면 재이체하지 않고 조회로 확정한다', async () => {
    await account(fx.merchantId, '11122233349999'); // mock: TIMEOUT → inquire 시 성공
    await fund(5, 30);

    const result = await runMerchantPayout(fx.merchantId);
    expect(result.status).toBe('PAID');

    const count = await prisma.settlementRequest.count({ where: { merchantId: fx.merchantId } });
    expect(count).toBe(1);
  });

  it('[13] 지급 가능 잔액이 없으면 지급하지 않는다', async () => {
    await account(fx.merchantId);
    const result = await runMerchantPayout(fx.merchantId);
    expect(result.status).toBe('SKIPPED');
    // 사유까지 확인한다. status 만 보면 "사회복지기관을 찾을 수 없음"·"계좌 미인증" 으로
    // 스킵돼도 통과해서 정작 확인하려던 조건을 검증하지 못한다.
    expect(result.reason).toContain('지급일이 도래한 결제 없음');
  });
});

describe('지급 실패 재시도', () => {
  it('[14] 계좌를 고친 뒤 재시도하면 지급이 완료된다', async () => {
    await account(fx.merchantId, '11122233340000');
    const { paid } = await fund(5, 30);
    await runMerchantPayout(fx.merchantId);

    const req = await prisma.settlementRequest.findFirstOrThrow({ where: { merchantId: fx.merchantId } });
    expect(req.status).toBe('PAYOUT_FAILED');

    // 계좌 정정 + 대행사 상태 초기화
    await account(fx.merchantId, '11122233344455');
    resetMockPayoutState();

    const retry = await retryPayout(req.id);
    expect(retry.ok).toBe(true);

    const after = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe('PAID');

    // 재시도로 지급이 끝났으면 회차에 묶였던 결제가 남김없이 정산 완료여야 한다.
    // (한 건이라도 남으면 다음 회차에 다시 잡혀 이중 지급이 된다)
    const settled = await prisma.charge.count({ where: { merchantId: fx.merchantId, settledAt: { not: null } } });
    expect(settled).toBe(paid);
  });

  it('[15] 이미 지급된 회차는 재시도할 수 없다', async () => {
    await account(fx.merchantId);
    await fund(5, 30);
    await runMerchantPayout(fx.merchantId);
    const req = await prisma.settlementRequest.findFirstOrThrow({ where: { merchantId: fx.merchantId } });

    const retry = await retryPayout(req.id);
    expect(retry.ok).toBe(false);
    expect(retry.message).toMatch(/이미 지급/);
  });
});

describe('배치와 모니터링', () => {
  it('[16] 배치는 계좌 인증된 사회복지기관만 훑고 결과를 집계한다', async () => {
    await account(fx.merchantId);
    await fund(5, 30);

    const result = await runScheduledPayouts();
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.paid).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.totalPaid).toBeGreaterThan(0n);
    expect(result.dateKey).toBe(toDateKey(new Date()));
  });

  it('[17] 모니터링 지표는 예정 금액과 보류 사회복지기관을 구분한다', async () => {
    await account(fx.merchantId, '11122233344455', false); // 미인증
    await fund(5, 30);

    const dash = await buildPayoutDashboard();
    expect(dash.scheduled.merchants).toBe(0);
    expect(dash.blocked).toHaveLength(1);
    expect(dash.blocked[0]!.reason).toMatch(/인증/);
    expect(dash.blocked[0]!.amount).toBeGreaterThan(0n);
  });

  it('[18] 지급이 끝나면 모니터링에 오늘 지급 완료로 잡힌다', async () => {
    await account(fx.merchantId);
    await fund(5, 30);
    await runMerchantPayout(fx.merchantId);

    const dash = await buildPayoutDashboard();
    expect(dash.paidToday.count).toBe(1);
    expect(dash.paidToday.amount).toBeGreaterThan(0n);
    expect(dash.failed).toHaveLength(0);
  });
});
