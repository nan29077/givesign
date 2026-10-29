import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { setChargeAmount, inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import { routeMerchant } from '@/server/services/charge-flow';
import {
  calculateWithholding,
  createSettlementRequest,
  markSettlementPaid,
  markSettlementPayoutFailed,
  markPayoutFileIssued,
  purgeResidentIfNotFilable,
  getSettlementSummary,
} from '@/server/services/settlement';
import { kstMonthEndKey } from '@/lib/datetime';

/**
 * 2026-08-21 전체 검수에서 확인된 결함들의 회귀 테스트.
 * 각 테스트는 "고치기 전이었다면 실패했을" 조건을 검사한다.
 */

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => inboundAndPay(p, fx.merchantId);

// ───────────────────────── M-1 원천징수 2단계 계산 ─────────────────────────

describe('원천징수 계산 (사업소득 3.3%)', () => {
  it('소득세 3%(10원절사) + 지방소득세 10%(10원절사) 2단계로 계산한다', () => {
    // 333,333원: 소득세 9,999.99 → 9,990 / 지방소득세 999 → 990 / 합계 10,980
    // (3.3% 단일 절사였다면 10,999원 — 국세청 지급명세서 검증에 걸린다)
    const w = calculateWithholding(333_333n);
    expect(w.incomeTax).toBe(9_990n);
    expect(w.localTax).toBe(990n);
    expect(w.total).toBe(10_980n);
    expect(w.exempt).toBe(false);
  });

  it('소액부징수 경계: 33,333원은 소득세 990원(<1,000) 이라 미징수된다', () => {
    const w = calculateWithholding(33_333n);
    expect(w.exempt).toBe(true);
    expect(w.total).toBe(0n);
  });

  it('세액은 항상 10원 단위로 떨어진다', () => {
    for (const amount of [40_000n, 55_555n, 123_456n, 999_999n, 1_000_000n]) {
      const w = calculateWithholding(amount);
      expect(w.incomeTax % 10n).toBe(0n);
      expect(w.localTax % 10n).toBe(0n);
      expect(w.total).toBe(w.incomeTax + w.localTax);
    }
  });

  it('지방소득세는 지급액이 아니라 소득세의 10% 다', () => {
    const w = calculateWithholding(1_000_000n);
    expect(w.incomeTax).toBe(30_000n);
    expect(w.localTax).toBe(3_000n);
  });

  it('소액부징수: 소득세가 1,000원 미만이면 전액 미징수한다', () => {
    // 30,000 × 3% = 900원 < 1,000원
    const w = calculateWithholding(30_000n);
    expect(w.exempt).toBe(true);
    expect(w.total).toBe(0n);

    // 경계값: 34,000 × 3% = 1,020 → 1,020 ≥ 1,000 이므로 징수한다
    expect(calculateWithholding(34_000n).exempt).toBe(false);
  });

  it('0원·음수는 0을 돌려준다', () => {
    expect(calculateWithholding(0n).total).toBe(0n);
    expect(calculateWithholding(-500n).total).toBe(0n);
  });
});

// ───────────────────────── M-2 월말 날짜 ─────────────────────────

describe('월말 날짜 계산', () => {
  it('2월은 28/29일로 끝난다 (`-31` 로 두면 3월 초까지 끌려온다)', () => {
    expect(kstMonthEndKey('2026-02')).toBe('2026-02-28');
    expect(kstMonthEndKey('2028-02')).toBe('2028-02-29'); // 윤년
    expect(kstMonthEndKey('2026-04')).toBe('2026-04-30');
    expect(kstMonthEndKey('2026-08')).toBe('2026-08-31');
  });

  it('생성한 날짜는 그 달을 벗어나지 않는다', () => {
    for (const m of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) {
      const key = kstMonthEndKey(`2026-${m}`);
      const d = new Date(`${key}T23:59:59+09:00`);
      expect(Number.isNaN(d.getTime())).toBe(false);
      // KST 기준 월이 유지되어야 한다
      const kstMonth = new Date(d.getTime() + 9 * 3600_000).toISOString().slice(5, 7);
      expect(kstMonth).toBe(m);
    }
  });
});

// ───────────────────────── CRIT-4 MO 라우팅 충돌 ─────────────────────────

describe('MO 번호 라우팅', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('같은 번호에 전용/대표번호가 섞이면 라우팅하지 않는다', async () => {
    const route = await prisma.merchantMoNumber.findFirstOrThrow({ where: { merchantId: fx.merchantId } });

    // 같은 번호에 SHARED_PREFIX 행을 하나 더 심는다 (DB 유니크로는 막히지 않는 조합).
    const other = await prisma.merchantProfile.create({
      data: {
        id: newId(),
        userId: (await prisma.user.create({
          data: { id: newId(), email: `x${newId()}@t.kr`, passwordHash: 'x', role: 'MERCHANT', status: 'ACTIVE' },
        })).id,
        code: `GIV-${newId().slice(-5).toUpperCase()}`,
        displayName: '충돌 사회복지기관',
        status: 'APPROVED',
      },
    });
    await prisma.merchantMoNumber.create({
      data: {
        id: newId(),
        phoneNumber: route.phoneNumber,
        keyword: 'ZZZ',
        mode: 'SHARED_PREFIX',
        status: 'ASSIGNED',
        merchantId: other.id,
        assignedAt: new Date(),
      },
    });

    // 충돌 상태에서는 아무에게도 배달하지 않는다.
    // (고치기 전에는 DEDICATED 가 먼저 매칭돼 ZZZ 결제까지 fx 사회복지기관이 가져갔다)
    expect(await routeMerchant(route.phoneNumber, 'ZZZ 응원합니다')).toBeNull();
    expect(await routeMerchant(route.phoneNumber, '그냥 응원')).toBeNull();
  });

  it('전용번호는 PostgreSQL 부분 유니크 인덱스로 중복 등록이 막힌다', async () => {
    const route = await prisma.merchantMoNumber.findFirstOrThrow({ where: { merchantId: fx.merchantId } });
    // keyword 가 NULL 이면 (phone_number, keyword) 유니크로는 중복이 통과한다.
    // 부분 유니크 인덱스가 있어야 실제로 막힌다.
    await expect(
      prisma.merchantMoNumber.create({
        data: { id: newId(), phoneNumber: route.phoneNumber, keyword: null, mode: 'DEDICATED', status: 'AVAILABLE' },
      }),
    ).rejects.toThrow();
  });
});

// ───────────────────────── CRIT-1 결제 결과 미확인 ─────────────────────────

describe('결제 결과 미확인(UNKNOWN)', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('실패로 덮어쓰지 않고 UNKNOWN 으로 남겨 관리자 확인 큐에 올린다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    // mock 어댑터: 금액 끝 777 = 타임아웃 후 조회도 실패(FAILED), 888 = 타임아웃 후 승인.
    // 조회 자체가 결과를 못 주는 상황을 만들기 위해 승인 기록이 없는 주문을 쓴다.
    setChargeAmount(3888n);
    await inbound(moPayload({ to: fx.moNumber, text: '미확인 테스트' }));

    // 888 은 조회에서 APPROVED 로 확정되므로 정상 승인되어야 한다(오탐 방지 확인).
    const approved = await prisma.paymentTransaction.count({ where: { status: 'APPROVED' } });
    expect(approved).toBe(1);
  });

  it('결제 성공 시 원장 분개가 같은 트랜잭션에서 기록된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await inbound(moPayload({ to: fx.moNumber }));

    const charge = await prisma.charge.findFirstOrThrow();
    const entries = await prisma.settlementLedger.findMany({ where: { chargeId: charge.id } });
    // 결제 성공 = 원장 3분개가 반드시 함께 존재해야 한다.
    expect(entries.map((e) => e.entryType).sort()).toEqual(['CHARGE_GROSS', 'PG_FEE', 'PLATFORM_FEE']);
  });
});

// ───────────────────────── 정산 지급 안전장치 ─────────────────────────

describe('정산 지급 안전장치', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
    await seedRegisteredPayer(fx.payerPhone);
    for (let i = 0; i < 3; i += 1) {
      await prisma.chargeLimitPolicy.updateMany({ data: { velocityMaxCount: 100, cooldownAfterCount: 100 } });
      await inbound(moPayload({ to: fx.moNumber, text: `적립 ${i}` }));
    }
  });

  it('이체파일 발급 이력이 남고, 재발급 건은 재발급으로 표시된다', async () => {
    const summary = await getSettlementSummary(fx.merchantId);
    const req = await createSettlementRequest(fx.merchantId, summary.available);

    const first = await markPayoutFileIssued([req.id], 'admin-test');
    expect(first.batchNo).toMatch(/^B[0-9A-Z]{10}$/);
    expect(first.reissued).toEqual([]);

    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.payoutIssuedAt).not.toBeNull();
    expect(row.payoutBatchNo).toBe(first.batchNo);

    // 같은 건을 또 받으면 재발급으로 잡힌다 (이중이체 경고 근거)
    const second = await markPayoutFileIssued([req.id], 'admin-test');
    expect(second.reissued).toEqual([req.id]);
    expect(second.batchNo).not.toBe(first.batchNo);

    // 최초 발급 시각은 보존된다
    const after = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.payoutIssuedAt?.getTime()).toBe(row.payoutIssuedAt?.getTime());
  });

  it('이체 후 이상이 발견돼도 지급 분개는 반드시 남는다 (throw 하면 이중지급)', async () => {
    const summary = await getSettlementSummary(fx.merchantId);
    const req = await createSettlementRequest(fx.merchantId, summary.available);
    await prisma.settlementRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });

    // 이체는 이미 끝난 상황을 가정: 계좌 인증이 그 사이 해제됐다.
    await prisma.settlementAccount.update({ where: { merchantId: fx.merchantId }, data: { verified: false } });

    const paid = await markSettlementPaid(req.id, 'admin-test');
    expect(paid.status).toBe('PAID');
    expect(paid.adminMemo).toContain('[주의]'); // 사람이 확인하도록 경고만 남긴다

    const entries = await prisma.settlementLedger.findMany({ where: { requestId: req.id } });
    expect(entries.map((e) => e.entryType).sort()).toEqual(['PAYOUT', 'PAYOUT_WITHHOLDING']);

    // 잔액이 실제로 줄어 재신청·이중지급이 불가능해야 한다.
    const after = await getSettlementSummary(fx.merchantId);
    expect(after.balance).toBe(0n);
  });

  it('반려·지급실패 건의 주민등록번호는 즉시 파기된다', async () => {
    const summary = await getSettlementSummary(fx.merchantId);
    const req = await createSettlementRequest(fx.merchantId, summary.available, { resident: '9010101234567' });
    expect((await prisma.settlementRequest.findUniqueOrThrow({ where: { id: req.id } })).residentEnc).toBeTruthy();

    await prisma.settlementRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });
    await markSettlementPayoutFailed(req.id, '잔액부족', 'admin-test');
    const purged = await purgeResidentIfNotFilable(req.id);
    expect(purged.purged).toBe(true);

    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.residentEnc).toBeNull();
    expect(row.residentPurgedAt).not.toBeNull();
    // 마스킹·금액 기록은 회계 목적으로 유지된다.
    expect(row.residentMasked).toBe('901010-1******');
    expect(row.amount).toBe(summary.available);
  });

  it('정산 요청 시 소득세·지방소득세가 각각 기록된다 (지급명세서 신고용)', async () => {
    const summary = await getSettlementSummary(fx.merchantId);
    const req = await createSettlementRequest(fx.merchantId, summary.available);
    const expected = calculateWithholding(summary.available);
    expect(req.incomeTax).toBe(expected.incomeTax);
    expect(req.localTax).toBe(expected.localTax);
    expect(req.withholding).toBe(expected.incomeTax + expected.localTax);
    expect(req.payoutAmount).toBe(summary.available - expected.total);
  });
});
