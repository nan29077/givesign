import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay } from './helpers';
import { computeFees } from '@/server/services/settlement';
import { currentTermsDoc, currentTermsList } from '@/server/services/terms';
import { loadSelectAmountContext, confirmChargeAmount } from '@/server/services/charge-select';
import { requestRefund, approveRefund, reopenRefund } from '@/server/services/refund';
import { checkLimits } from '@/server/services/limits';
import { periodStart, ORDER_CHARGE_STATUSES, PAID_STATUSES } from '@/components/studio/shared';
import { kstStartOfDay } from '@/lib/datetime';
import { lastSelectAmountToken } from './helpers';

/**
 * 2026-09-02 전수 검수에서 고친 결함들의 회귀 테스트.
 * 각 테스트는 "고치기 전에는 어떻게 틀렸는지" 를 주석으로 남긴다.
 */

describe('수수료: 상한이 걸려도 공급가액 + 부가세 = 차감액', () => {
  it('요율 합이 100% 를 넘어 잘려도 장부 불변식이 깨지지 않는다', () => {
    // 예전에는 잘라낸 뒤에도 공급가액·부가세를 보정 전 값으로 돌려줘,
    // append-only 원장에 "공급가액 + 부가세 != 차감액" 인 기록이 확정됐다.
    const cases: Array<[bigint, string, string, boolean, bigint]> = [
      [3000n, '0.018', '0.15', true, 0n],
      [1000n, '0.499', '0.499', false, 0n],
      [100n, '0.018', '0.15', true, 500n],
      [10n, '0.018', '0.15', true, 0n],
      [1n, '0.018', '0.15', true, 0n],
    ];
    for (const [amount, pg, platform, vatIncluded, fixed] of cases) {
      const f = computeFees(amount, {
        pgFeeRate: pg,
        platformFeeRate: platform,
        vatIncluded,
        pgFixedFee: fixed,
      });
      expect(f.pgFeeSupply + f.pgFeeVat).toBe(f.pgFee);
      expect(f.platformFeeSupply + f.platformFeeVat).toBe(f.platformFee);
      expect(f.vat).toBe(f.pgFeeVat + f.platformFeeVat);
      expect(f.pgFee + f.platformFee + f.net).toBe(f.gross);
      expect(f.net >= 0n).toBe(true);
      // 차감액이 있는데 공급가액이 0원이면 세금계산서 근거가 되지 않는다.
      if (f.pgFee > 0n) expect(f.pgFeeSupply > 0n).toBe(true);
      if (f.platformFee > 0n) expect(f.platformFeeSupply > 0n).toBe(true);
    }
  });
});

describe('약관: 시행 예정 개정안이 현행 약관을 지우지 않는다', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('미래 시행일 버전을 등록해도 공개 화면은 현행 버전을 계속 보여 준다', async () => {
    await prisma.termsVersion.create({
      data: {
        id: newId(), type: 'TERMS_SERVICE', version: '1.0', title: '현행', content: '현행 약관 본문',
        required: true, effectiveFrom: new Date('2026-01-01'), active: true,
      },
    });
    // 개정안을 미리 등록한다(시행일은 미래).
    await prisma.termsVersion.create({
      data: {
        id: newId(), type: 'TERMS_SERVICE', version: '2.0', title: '개정안', content: '개정 약관 본문',
        required: true, effectiveFrom: new Date(Date.now() + 30 * 86_400_000), active: true,
      },
    });

    const doc = await currentTermsDoc('TERMS_SERVICE');
    // 예전에는 등록 순간 기존 버전이 active=false 로 내려가 여기서 null 이 됐다.
    expect(doc?.version).toBe('1.0');

    const list = await currentTermsList();
    const serviceRows = list.filter((t) => t.type === 'TERMS_SERVICE');
    expect(serviceRows).toHaveLength(1);
    expect(serviceRows[0].version).toBe('1.0');
  });

  it('시행일이 지나면 새 버전이 자동으로 현행이 된다', async () => {
    await prisma.termsVersion.create({
      data: {
        id: newId(), type: 'E_FINANCE', version: '1.0', title: '구', content: '구 본문',
        required: true, effectiveFrom: new Date('2026-01-01'), active: true,
      },
    });
    await prisma.termsVersion.create({
      data: {
        id: newId(), type: 'E_FINANCE', version: '2.0', title: '신', content: '신 본문',
        required: true, effectiveFrom: new Date('2026-02-01'), active: true,
      },
    });
    const doc = await currentTermsDoc('E_FINANCE');
    expect(doc?.version).toBe('2.0');
  });
});

describe('직접 입력 범위·단위가 결제에 실제로 적용된다', () => {
  let fx: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
    await seedRegisteredPayer(fx.payerPhone);
  });

  async function openSelectLink() {
    const { handleMoInbound } = await import('@/server/services/charge-flow');
    const { mockMoAdapter } = await import('@/server/adapters/mo');
    await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '충전' })));
    const token = lastSelectAmountToken();
    expect(token).toBeTruthy();
    return token!;
  }

  it('사회복지기관이 좁혀 둔 범위를 벗어난 금액은 거절된다', async () => {
    await prisma.merchantProfile.update({
      where: { id: fx.merchantId },
      data: { allowCustomAmount: true, customMinAmount: 5000n, customMaxAmount: 20000n },
    });
    const token = await openSelectLink();
    const ctx = await loadSelectAmountContext(token);
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      expect(ctx.ctx.customMin).toBe(5000n);
      expect(ctx.ctx.customMax).toBe(20000n);
    }
    // 예전에는 이 값이 저장만 되고 결제에는 쓰이지 않아 그대로 통과했다.
    const res = await confirmChargeAmount({ token, customAmount: 30000n });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('직접 입력 금액');
  });

  it('단위(step)를 벗어난 금액은 거절된다', async () => {
    await prisma.merchantProfile.update({
      where: { id: fx.merchantId },
      data: { allowCustomAmount: true, customAmountStep: 1000 },
    });
    const token = await openSelectLink();
    const res = await confirmChargeAmount({ token, customAmount: 3333n });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('단위');
  });

  it('범위·단위를 지킨 금액은 통과한다', async () => {
    await prisma.merchantProfile.update({
      where: { id: fx.merchantId },
      data: { allowCustomAmount: true, customMinAmount: 5000n, customMaxAmount: 20000n, customAmountStep: 1000 },
    });
    const token = await openSelectLink();
    const res = await confirmChargeAmount({ token, customAmount: 10000n });
    expect(res.ok).toBe(true);
  });
});

describe('환불: 처리가 멈춰도 관리자 화면에서 되살릴 수 있다', () => {
  let fx: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
    await seedRegisteredPayer(fx.payerPhone);
  });

  it('승인 거래가 없으면 상태를 바꾸지 않고 거절한다', async () => {
    const res = await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '충전' }), fx.merchantId);
    expect(res.chargeId).toBeTruthy();
    const chargeId = res.chargeId!;

    const refund = await requestRefund({ chargeId, reason: '테스트', requestedBy: 'payer' });
    // 승인 거래를 지워 "승인된 결제 거래가 없습니다" 경로를 만든다.
    await prisma.paymentTransaction.updateMany({ where: { chargeId }, data: { status: 'FAILED' } });

    await expect(approveRefund(refund.id)).rejects.toThrow();

    // 예전에는 선점(APPROVED) 뒤에 실패해 환불이 APPROVED 로 고착됐다.
    const after = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(after.status).toBe('REQUESTED');
  });

  it('실패로 남은 환불을 요청 상태로 되돌려 다시 처리할 수 있다', async () => {
    const res = await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '충전' }), fx.merchantId);
    const chargeId = res.chargeId!;
    const refund = await requestRefund({ chargeId, reason: '테스트', requestedBy: 'payer' });

    // PG 취소 실패로 FAILED 가 된 상태를 만든다.
    await prisma.refund.update({ where: { id: refund.id }, data: { status: 'FAILED', resultMessage: 'PG 오류' } });

    const reopened = await reopenRefund(refund.id, 'admin-1', 'PG 미취소 확인');
    expect(reopened?.status).toBe('REQUESTED');
    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge.status).toBe('REFUND_REQUESTED');

    // 되돌린 뒤에는 정상 승인 흐름을 이어갈 수 있다.
    const done = await approveRefund(refund.id, 'admin-1');
    expect(done?.status).toBe('DONE');
  });
});

describe('한도: 개인 한도가 전역 정책 하향을 무력화하지 않는다', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('정책보다 높게 저장돼 있어도 정책 한도로 잘린다', async () => {
    await prisma.chargeLimitPolicy.create({
      data: {
        id: newId(),
        scope: 'GLOBAL',
        // 1회 금액 범위에 먼저 걸리지 않도록 넉넉히 둔다(여기서 보려는 것은 일일 한도다).
        minAmount: 1_000n,
        maxAmount: 1_000_000n,
        payerDailyLimit: 50_000n,
        payerMonthlyLimit: 200_000n,
      },
    });
    const payer = await seedRegisteredPayer('01099998888');
    await prisma.payerProfile.update({
      where: { id: payer.id },
      data: { dailyLimit: 1_000_000n, monthlyLimit: 5_000_000n },
    });

    const row = await prisma.payerProfile.findUniqueOrThrow({ where: { id: payer.id } });
    const merchantUser = await prisma.user.create({
      data: { id: newId(), email: `m-${newId()}@test.kr`, role: 'MERCHANT' },
    });
    const merchant = await prisma.merchantProfile.create({
      data: {
        id: newId(),
        userId: merchantUser.id,
        code: `GIV-${newId().slice(-4)}`,
        displayName: 'T',
        status: 'APPROVED',
        minAmount: 1_000n,
        maxAmount: 1_000_000n,
      },
    });

    // 정책 한도(5만원)를 넘는 금액은 개인 한도가 100만원이어도 막혀야 한다.
    const res = await checkLimits({ payer: row, merchantId: merchant.id, amount: 60_000n });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('PAYER_DAILY');
  });
});

describe('기간 필터는 화면과 CSV 가 같은 함수를 쓴다', () => {
  it("'오늘' 은 서버 로컬 자정이 아니라 KST 자정 기준이다", () => {
    const now = new Date();
    expect(periodStart('today', now)?.getTime()).toBe(kstStartOfDay(now).getTime());
    expect(periodStart('all', now)).toBeNull();
    expect(periodStart('알수없는값', now)).toBeNull();
  });
});

describe('주문 목록은 환불 요청 건을 숨기지 않는다', () => {
  it('주문 화면용 상태 집합에 환불 요청·환불 완료가 포함된다', () => {
    expect(ORDER_CHARGE_STATUSES).toContain('REFUND_REQUESTED');
    expect(ORDER_CHARGE_STATUSES).toContain('REFUNDED');
    // 정산 집계용 집합과는 분리되어 있어야 한다.
    expect(PAID_STATUSES).not.toContain('REFUND_REQUESTED');
    expect(PAID_STATUSES).not.toContain('REFUNDED');
  });
});
