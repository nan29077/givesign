import { prisma, withAdvisoryLock } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, decrypt, maskResident, normalizeResident } from '@/lib/crypto';
import { applyRate } from '@/lib/money';
import { kstMonthKey } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import { PAID_STATUSES } from '@/components/studio/shared';
import type { LedgerEntryType } from '@/generated/prisma/enums';

/**
 * 정산 원장.
 *
 * 규칙
 *  - settlement_ledger 는 APPEND ONLY. UPDATE/DELETE 하지 않는다.
 *  - 정정이 필요하면 반대 부호 분개를 추가한다.
 *  - 결제 거래 원장 / 결제 거래 원장 / 정산 원장은 분리하되 charge_id 로 추적한다.
 *  - 정산 가능 금액 = 원장 합계 - 보류(미정산 요청 중) - 이미 지급
 */

/** 원천징수율 3.3% (사업소득 기준) — 화면 안내·미리보기 표기에만 쓰는 합계 표시율. */
export const WITHHOLDING_RATE = 0.033;

/** 사업소득 원천징수 소득세율 3% */
export const INCOME_TAX_RATE = 0.03;
/** 지방소득세율 = 소득세액의 10% */
export const LOCAL_TAX_RATE = 0.1;
/**
 * 소액부징수 기준(소득세법 제86조). 산출된 소득세가 이 금액 미만이면 징수하지 않는다.
 * 사업소득 3% 기준으로 지급액 약 33,333원 미만이 여기 해당한다.
 */
export const SMALL_AMOUNT_EXEMPTION = 1_000n;

/** 국고금관리법 제47조 — 10원 미만 단수 절사 */
function truncateTo10Won(v: bigint): bigint {
  return (v / 10n) * 10n;
}

export interface WithholdingBreakdown {
  /** 소득세 (3%, 10원 미만 절사) */
  incomeTax: bigint;
  /** 지방소득세 (소득세의 10%, 10원 미만 절사) */
  localTax: bigint;
  /** 원천징수 합계 = 소득세 + 지방소득세 */
  total: bigint;
  /** 소액부징수로 전액 미징수된 경우 true */
  exempt: boolean;
}

/**
 * 사업소득 원천징수액 계산 (국내 일반 실무 방식).
 *
 * 3.3% 를 한 번에 곱해 절사하면 국세청 지급명세서 검증에서 어긋난다.
 * 실제 신고는 소득세와 지방소득세를 **각각 따로 산출하고 각각 절사**한다.
 *
 *   1) 소득세      = 지급액 × 3%        → 10원 미만 절사
 *   2) 지방소득세  = 소득세 × 10%       → 10원 미만 절사
 *   3) 합계        = 소득세 + 지방소득세
 *   4) 소액부징수  : 소득세가 1,000원 미만이면 소득세·지방소득세 모두 미징수
 *
 * 예) 지급액 333,333원
 *     - 소득세     333,333 × 3% = 9,999.99 → 9,990원
 *     - 지방소득세 9,990 × 10%  = 999      → 990원
 *     - 합계 10,980원  (3.3% 단일 절사 시 10,999원 — 19원 차이)
 *
 * 예) 지급액 33,333원 이하
 *     - 소득세가 1,000원 미만이므로 **소액부징수**, 원천징수 0원
 *     - 즉 33,334원 미만 정산은 전액 지급된다
 *
 * 최종 세액 확정은 세무 자문을 거치는 것을 권장한다.
 */
export function calculateWithholding(amount: bigint): WithholdingBreakdown {
  if (amount <= 0n) return { incomeTax: 0n, localTax: 0n, total: 0n, exempt: false };

  const rawIncomeTax = applyRate(amount, INCOME_TAX_RATE);
  const incomeTax = truncateTo10Won(rawIncomeTax);

  // 소액부징수: 산출 소득세가 1,000원 미만이면 지방소득세까지 함께 미징수한다.
  if (incomeTax < SMALL_AMOUNT_EXEMPTION) {
    return { incomeTax: 0n, localTax: 0n, total: 0n, exempt: true };
  }

  const localTax = truncateTo10Won(applyRate(incomeTax, LOCAL_TAX_RATE));
  return { incomeTax, localTax, total: incomeTax + localTax, exempt: false };
}

/** 부가가치세율 10% */
export const VAT_RATE = 0.1;

export interface FeeBreakdown {
  gross: bigint;
  /** 결제수수료 차감액 (부가세 포함 총액) */
  pgFee: bigint;
  /** 결제수수료 공급가액 (부가세 제외) */
  pgFeeSupply: bigint;
  /** 결제수수료에 붙는 부가세 */
  pgFeeVat: bigint;
  /** 플랫폼수수료 차감액 (부가세 포함 총액) */
  platformFee: bigint;
  /** 플랫폼수수료 공급가액 (부가세 제외) */
  platformFeeSupply: bigint;
  /** 플랫폼수수료에 붙는 부가세 */
  platformFeeVat: bigint;
  /** 부가세 합계 = pgFeeVat + platformFeeVat */
  vat: bigint;
  net: bigint;
  pgFeeRate: string;
  platformFeeRate: string;
  /** 적용된 정책의 부가세 포함 여부 */
  vatIncluded: boolean;
}

/** computeFees 가 필요로 하는 수수료 정책 값. FeePolicy 행을 그대로 넘길 수 있다. */
export interface FeeRates {
  pgFeeRate: string | number;
  pgFixedFee?: bigint | null;
  platformFeeRate: string | number;
  vatIncluded: boolean;
}

/** 유효한 수수료 정책이 없을 때 쓰는 기본값. FeePolicy 스키마 기본값과 같아야 한다. */
export const FALLBACK_FEE_RATES: FeeRates = {
  pgFeeRate: '0.018',
  pgFixedFee: 0n,
  platformFeeRate: '0.15',
  vatIncluded: true,
};

/**
 * 부가세 포함 금액에서 공급가액을 역산한다.
 *
 *   공급가액 = 총액 ÷ 1.1   (원 미만 버림)
 *
 * BigInt 나눗셈은 내림이므로 x10/11 로 그대로 계산한다.
 */
function supplyOfInclusive(total: bigint): bigint {
  return (total * 10n) / 11n;
}

/**
 * 부가세 포함 차감액을 공급가액과 부가세로 나눈다.
 *
 * 1원 같은 아주 작은 차감액에서 역산하면 공급가액이 0원이 되어
 * "공급가액 0원 · 부가세 1원" 이라는 세금계산서로 쓸 수 없는 기록이 남는다.
 * 그런 경우는 전액을 공급가액으로 잡는다.
 */
function splitSupplyVat(total: bigint): [bigint, bigint] {
  if (total <= 0n) return [0n, 0n];
  const supply = supplyOfInclusive(total);
  if (supply <= 0n) return [total, 0n];
  return [supply, total - supply];
}

/**
 * 수수료 계산.
 *
 * 어느 방식이든 **차감액(= 공급가액 + 부가세)** 이 실제로 사회복지기관 정산금에서 빠지는 금액이고,
 * 공급가액과 부가세는 세금계산서 발행을 위해 항상 분리해서 기록한다.
 *
 * `vatIncluded = false` (부가세 별도 요율)
 *   공급가액 = 결제 금액 x 요율      (원 미만 버림)
 *   부가세   = 공급가액 x 10%       (원 미만 버림)
 *   차감액   = 공급가액 + 부가세
 *   예) 3,000원 결제 / 플랫폼 5% -> 공급가 150 + 부가세 15 = 165원 차감
 *
 * `vatIncluded = true` (부가세 포함 요율 — 운영 기본)
 *   차감액   = 결제 금액 x 요율      (원 미만 버림)
 *   공급가액 = 차감액 ÷ 1.1         (원 미만 버림)
 *   부가세   = 차감액 - 공급가액
 *   예) 3,000원 결제 / 플랫폼 5.5% -> 차감 165원 = 공급가 150 + 부가세 15
 *
 * 예전에는 vatIncluded=true 일 때 부가세를 0원으로 기록했다. 차감액은 맞지만
 * 세금계산서의 공급가액·세액 근거가 장부에 남지 않아 사후 신고를 뒷받침할 수 없었다.
 * 두 방식의 차감액과 정산금은 위 예처럼 동일하며, 기록만 정확해진다.
 */
export function computeFees(amount: bigint, rates: FeeRates): FeeBreakdown {
  const pgRate = String(rates.pgFeeRate);
  const platformRate = String(rates.platformFeeRate);

  const pgApplied = applyRate(amount, pgRate, rates.pgFixedFee ?? 0n);
  const platformApplied = applyRate(amount, platformRate);

  // 포함 요율이면 요율을 곱한 값이 이미 차감액이므로 공급가액을 역산한다.
  const [pgFeeSupply, pgFeeVat] = rates.vatIncluded
    ? splitSupplyVat(pgApplied)
    : [pgApplied, applyRate(pgApplied, VAT_RATE)];
  const [platformFeeSupply, platformFeeVat] = rates.vatIncluded
    ? splitSupplyVat(platformApplied)
    : [platformApplied, applyRate(platformApplied, VAT_RATE)];

  const pgFee = pgFeeSupply + pgFeeVat;
  const platformFeeRaw = platformFeeSupply + platformFeeVat;

  // 수수료 합은 절대 결제 금액을 넘지 않는다.
  //
  // 예전에는 net 만 0 으로 보정하고 pgFee·platformFee 는 보정 전 값을 그대로 원장에 넣었다.
  // 그래서 요율을 잘못 넣으면 화면에는 "정산예정금 0원" 으로 보이는데 원장 합계는 음수가 되어
  // 그 사회복지기관의 정산 가능액을 깎았다. 화면과 장부가 어긋나면 원인을 찾기 매우 어렵다.
  //
  // 결제 수수료는 실제로 PG 에 나가는 돈이므로 먼저 채우고, 남는 만큼만 플랫폼 수수료로 잡는다.
  const pgFeeCapped = pgFee > amount ? amount : pgFee;
  const room = amount - pgFeeCapped;
  const platformFee = platformFeeRaw > room ? room : platformFeeRaw;
  const net = amount - pgFeeCapped - platformFee;

  // 잘라낸 뒤에는 공급가액·부가세도 다시 나눈다.
  //
  // 이 값들은 화면용이 아니라 그대로 저장된다(Charge.feeVat, 정산 원장 분개 메모).
  // 보정 전 값을 남기면 "공급가액 + 부가세 = 차감액" 이 깨진 채 append-only 원장에 확정되어
  // 세금계산서 근거로 쓸 수 없게 된다. 원장은 정정이 불가능하므로 여기서 맞춰야 한다.
  const [pgSupplyFinal, pgVatFinal] =
    pgFeeCapped === pgFee ? [pgFeeSupply, pgFeeVat] : splitSupplyVat(pgFeeCapped);
  const [platformSupplyFinal, platformVatFinal] =
    platformFee === platformFeeRaw ? [platformFeeSupply, platformFeeVat] : splitSupplyVat(platformFee);

  return {
    gross: amount,
    pgFee: pgFeeCapped,
    pgFeeSupply: pgSupplyFinal,
    pgFeeVat: pgVatFinal,
    platformFee,
    platformFeeSupply: platformSupplyFinal,
    platformFeeVat: platformVatFinal,
    vat: pgVatFinal + platformVatFinal,
    net,
    pgFeeRate: pgRate,
    platformFeeRate: platformRate,
    vatIncluded: rates.vatIncluded,
  };
}

/** FeePolicy 행(또는 null)을 computeFees 입력으로 바꾼다. */
export function feeRatesOf(policy: FeeRates | null | undefined): FeeRates {
  if (!policy) return FALLBACK_FEE_RATES;
  return {
    pgFeeRate: policy.pgFeeRate,
    pgFixedFee: policy.pgFixedFee ?? 0n,
    platformFeeRate: policy.platformFeeRate,
    vatIncluded: policy.vatIncluded,
  };
}

export async function resolveFeePolicy(merchantId: string, now: Date = new Date()) {
  const rows = await prisma.feePolicy.findMany({
    // 시행일 전/종료 후 정책은 적용하지 않는다. (예약 수수료가 즉시 반영돼 정산액이 틀어지는 것을 막는다)
    where: {
      active: true,
      effectiveFrom: { lte: now },
      OR: [{ scope: 'GLOBAL' }, { scope: 'MERCHANT', merchantId }],
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  return rows.find((r) => r.scope === 'MERCHANT') ?? rows.find((r) => r.scope === 'GLOBAL') ?? null;
}

export async function calculateFees(merchantId: string, amount: bigint): Promise<FeeBreakdown> {
  const policy = await resolveFeePolicy(merchantId);
  return computeFees(
    amount,
    feeRatesOf(
      policy
        ? {
            pgFeeRate: policy.pgFeeRate.toString(),
            pgFixedFee: policy.pgFixedFee,
            platformFeeRate: policy.platformFeeRate.toString(),
            vatIncluded: policy.vatIncluded,
          }
        : null,
    ),
  );
}

export interface LedgerInput {
  merchantId: string;
  entryType: LedgerEntryType;
  amount: bigint;
  chargeId?: string | null;
  refundId?: string | null;
  requestId?: string | null;
  memo?: string;
  occurredAt?: Date;
}

/** appendLedger 가 받는 클라이언트 (전역 prisma 또는 트랜잭션 tx) */
type LedgerClient = Pick<typeof prisma, 'settlementLedger'> | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function appendLedger(entries: LedgerInput[], client: LedgerClient = prisma) {
  if (entries.length === 0) return;
  await client.settlementLedger.createMany({
    data: entries.map((e) => {
      const at = e.occurredAt ?? new Date();
      return {
        id: newId(),
        merchantId: e.merchantId,
        entryType: e.entryType,
        amount: e.amount,
        chargeId: e.chargeId ?? null,
        refundId: e.refundId ?? null,
        requestId: e.requestId ?? null,
        memo: e.memo ?? null,
        occurredAt: at,
        settlementKey: kstMonthKey(at),
      };
    }),
  });
}

/**
 * 수수료 분개 메모.
 * 부가세는 별도 분개를 만들지 않고 해당 수수료 분개에 포함해 차감하되(원장 잔액 = 실제 정산금),
 * 얼마가 부가세인지 메모로 남겨 사후 대사가 가능하게 한다.
 */
function feeMemo(label: string, rate: string, vat: bigint): string {
  return vat > 0n ? `${label} ${rate} (부가세 ${vat.toString()}원 포함)` : `${label} ${rate}`;
}

/**
 * 결제 결제 성공 시 3분개 (총액 / PG수수료 / 플랫폼수수료).
 *
 * 반드시 결제 승인 기록과 **같은 트랜잭션**에서 호출한다(client 로 tx 전달).
 * 분리되면 "결제는 성공인데 원장에는 없는" 상태가 생기고, 조기 return 가드 때문에
 * 재시도로도 복구되지 않아 사회복지기관이 그 금액을 영영 받지 못한다.
 * 재시도·중복 호출에도 분개가 두 번 쌓이지 않도록 이미 기록된 결제는 건너뛴다.
 */
export async function postChargeSettlement(
  input: {
    merchantId: string;
    chargeId: string;
    amount: bigint;
    fees: FeeBreakdown;
    occurredAt?: Date;
  },
  client: LedgerClient = prisma,
) {
  const already = await client.settlementLedger.findFirst({
    where: { chargeId: input.chargeId, entryType: 'CHARGE_GROSS' },
    select: { id: true },
  });
  if (already) return;

  await appendLedger(
    [
      {
        merchantId: input.merchantId, entryType: 'CHARGE_GROSS', amount: input.fees.gross,
        chargeId: input.chargeId, occurredAt: input.occurredAt, memo: '문자후원 결제 승인',
      },
      {
        merchantId: input.merchantId, entryType: 'PG_FEE', amount: -input.fees.pgFee,
        chargeId: input.chargeId, occurredAt: input.occurredAt,
        memo: feeMemo('결제수수료', input.fees.pgFeeRate, input.fees.pgFeeVat),
      },
      {
        merchantId: input.merchantId, entryType: 'PLATFORM_FEE', amount: -input.fees.platformFee,
        chargeId: input.chargeId, occurredAt: input.occurredAt,
        memo: feeMemo('플랫폼수수료', input.fees.platformFeeRate, input.fees.platformFeeVat),
      },
    ],
    client,
  );
}

/**
 * 환불 시 환입할 수수료를 "원 거래에 실제로 기록된 분개"에서 계산한다.
 *
 * 환불 시점의 수수료율로 다시 계산하면(calculateFees(refundAmount)) 두 가지 오차가 난다.
 *  1) 원 결제 이후 수수료 정책이 바뀌면 환입액이 원 차감액과 달라져 원장이 영구히 틀어진다.
 *  2) 부분 환불에서 정액 수수료(pgFixedFee)가 통째로 다시 계산돼 과다 환입된다.
 * 따라서 원 거래의 PLATFORM_FEE 분개를 환불 비율만큼만 되돌리고,
 * 이미 환입한 금액을 빼서 여러 번 부분 환불해도 총 환입액이 원 차감액을 넘지 않게 한다.
 */
export async function resolveRefundFeeReturn(
  chargeId: string,
  refundAmount: bigint,
  client: LedgerClient = prisma,
): Promise<{ platformFeeReturn: bigint; grossPosted: bigint; platformFeePosted: bigint }> {
  const rows = await client.settlementLedger.findMany({
    where: { chargeId },
    select: { entryType: true, amount: true },
  });

  const sumOf = (t: LedgerEntryType) =>
    rows.filter((r) => r.entryType === t).reduce((acc, r) => acc + r.amount, 0n);

  const grossPosted = sumOf('CHARGE_GROSS');
  // 수수료는 음수로 기록되므로 부호를 뒤집어 "차감된 금액"으로 만든다.
  const platformFeePosted = -sumOf('PLATFORM_FEE');
  const alreadyReturned = sumOf('REFUND_FEE_RETURN');
  const alreadyRefunded = -sumOf('REFUND');

  if (grossPosted <= 0n || platformFeePosted <= 0n) {
    return { platformFeeReturn: 0n, grossPosted, platformFeePosted };
  }

  // 이번 환불까지 포함한 누적 환불 비율에 해당하는 환입액에서, 이미 환입한 금액을 뺀다.
  const cumulativeRefund = alreadyRefunded + refundAmount;
  const capped = cumulativeRefund > grossPosted ? grossPosted : cumulativeRefund;
  const targetReturn = (platformFeePosted * capped) / grossPosted;
  const platformFeeReturn = targetReturn - alreadyReturned;

  return {
    platformFeeReturn: platformFeeReturn < 0n ? 0n : platformFeeReturn,
    grossPosted,
    platformFeePosted,
  };
}

/**
 * 환불 시 반대 분개 (수수료 환입 정책 포함).
 *
 * 환불 확정 기록과 **같은 트랜잭션**에서 호출한다(client 로 tx 전달).
 * 분리되면 커밋 사이에 프로세스가 죽었을 때 원장에 환불 분개가 누락된다.
 */
export async function postRefundSettlement(
  input: {
    merchantId: string;
    chargeId: string;
    refundId: string;
    amount: bigint;
    fees: FeeBreakdown;
    returnPlatformFee?: boolean;
    occurredAt?: Date;
  },
  client: LedgerClient = prisma,
) {
  const entries: LedgerInput[] = [
    {
      merchantId: input.merchantId, entryType: 'REFUND', amount: -input.amount,
      chargeId: input.chargeId, refundId: input.refundId, occurredAt: input.occurredAt, memo: '결제 환불',
    },
  ];
  if (input.returnPlatformFee !== false) {
    // 원 거래 분개에서 환입액을 산출한다. (환불 시점 요율로 재계산하면 원장이 틀어진다)
    const { platformFeeReturn } = await resolveRefundFeeReturn(input.chargeId, input.amount, client);
    if (platformFeeReturn > 0n) {
      entries.push({
        merchantId: input.merchantId, entryType: 'REFUND_FEE_RETURN', amount: platformFeeReturn,
        chargeId: input.chargeId, refundId: input.refundId, occurredAt: input.occurredAt,
        memo: '환불에 따른 플랫폼수수료 환입',
      });
    }
  }
  await appendLedger(entries, client);
}

export interface SettlementSummary {
  totalGross: bigint;
  totalPgFee: bigint;
  totalPlatformFee: bigint;
  totalRefund: bigint;
  totalAdjustment: bigint;
  totalPaid: bigint;
  /** 원장 순합계 */
  balance: bigint;
  /** 정산 요청 중이라 보류된 금액 */
  pending: bigint;
  /** 지금 정산 요청 가능한 금액 */
  available: bigint;
}

/** 요약 집계에 쓰는 클라이언트 (전역 prisma 또는 트랜잭션 tx) */
type SummaryClient = Pick<typeof prisma, 'settlementLedger' | 'settlementRequest'>
  | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * 사회복지기관 정산 요약.
 *
 * 잠금 안에서 잔액을 검증할 때는 반드시 `client` 로 tx 를 넘겨야 한다.
 * 전역 prisma 로 읽으면 트랜잭션 밖 스냅샷을 보게 되어, 락을 잡은 의미가 사라진다.
 */
export async function getSettlementSummary(
  merchantId: string,
  client: SummaryClient = prisma,
): Promise<SettlementSummary> {
  const grouped = await client.settlementLedger.groupBy({
    by: ['entryType'],
    where: { merchantId },
    _sum: { amount: true },
  });

  const sum = (t: LedgerEntryType) => grouped.find((g) => g.entryType === t)?._sum.amount ?? 0n;

  const totalGross = sum('CHARGE_GROSS');
  const totalPgFee = -sum('PG_FEE');
  const totalPlatformFee = -sum('PLATFORM_FEE');
  const totalRefund = -(sum('REFUND') + sum('REFUND_FEE_RETURN'));
  const totalAdjustment = sum('ADJUSTMENT');
  const totalPaid = -(sum('PAYOUT') + sum('PAYOUT_WITHHOLDING'));

  const balance = grouped.reduce((acc, g) => acc + (g._sum.amount ?? 0n), 0n);

  const pendingAgg = await client.settlementRequest.aggregate({
    // PAYOUT_FAILED 도 보류로 센다. 재시도로 되살아날 수 있는 회차라 그 금액을
    // 가용 잔액으로 되돌리면 같은 돈이 다른 회차로 또 나간다.
    where: { merchantId, status: { in: ['REQUESTED', 'REVIEWING', 'APPROVED', 'PAYOUT_FAILED'] } },
    _sum: { amount: true },
  });
  const pending = pendingAgg._sum.amount ?? 0n;
  const available = balance - pending;

  return {
    totalGross, totalPgFee, totalPlatformFee, totalRefund, totalAdjustment, totalPaid,
    balance,
    pending,
    available: available < 0n ? 0n : available,
  };
}

/**
 * 정산 요청 생성. 가능 금액 초과 요청을 막는다.
 * 사회복지기관 단위 advisory lock 으로 동시 요청을 직렬화한다.
 * (잠금 없이는 두 요청이 같은 가용 금액을 읽고 둘 다 통과해 잔액 초과 이중 요청이 생긴다)
 */
export interface CreateSettlementInput {
  memo?: string;
  /** 원천징수 신고용 주민등록번호(정규화된 13자리). 신고 후 파기된다. */
  resident?: string | null;
}

export async function createSettlementRequest(
  merchantId: string,
  amount: bigint,
  input: CreateSettlementInput = {},
) {
  if (amount <= 0n) throw new Error('정산 요청 금액이 올바르지 않습니다.');

  // 개인(사업소득 3.3% 원천징수) 사회복지기관은 신고용 주민등록번호가 반드시 필요하다.
  const resident = input.resident ? normalizeResident(input.resident) : null;
  if (input.resident && !resident) throw new Error('주민등록번호 형식이 올바르지 않습니다.');

  return prisma.$transaction(async (tx) =>
    withAdvisoryLock(tx, `settlement:merchant:${merchantId}`, async () => {
      // 잠금 획득 후 트랜잭션 안에서 읽어야 앞선 요청의 커밋 결과가 반영된 값을 본다
      const summary = await getSettlementSummary(merchantId, tx);
      if (amount > summary.available) throw new Error('정산 가능 금액을 초과했습니다.');

      const account = await tx.settlementAccount.findUnique({ where: { merchantId } });
      if (!account || !account.verified) throw new Error('정산 계좌 인증이 완료되지 않았습니다.');

      // 사업자등록번호가 있는 사회복지기관은 세금계산서 대상이라 원천징수하지 않는다.
      // 개인(사업소득) 사회복지기관만 3.3% 를 뗀다.
      const merchant = await tx.merchantProfile.findUnique({
        where: { id: merchantId },
        select: { businessNo: true },
      });
      const isBusiness = Boolean(merchant?.businessNo);

      // 사업소득 원천징수: 소득세 3%(10원절사) + 지방소득세 10%(10원절사), 소액부징수 적용.
      const wh = isBusiness
        ? { incomeTax: 0n, localTax: 0n, total: 0n, exempt: true }
        : calculateWithholding(amount);

      // 자동 정산은 사회복지기관이 요청하는 단계가 없다. 계좌에 미리 등록해 둔 신고용 번호를 회차로 복사한다.
      const effectiveResident =
        resident ?? (!isBusiness && account.residentEnc ? decrypt(account.residentEnc) : null);

      return tx.settlementRequest.create({
        data: {
          id: newId(),
          merchantId,
          amount,
          withholding: wh.total,
          incomeTax: wh.incomeTax,
          localTax: wh.localTax,
          payoutAmount: amount - wh.total,
          memo: input.memo ?? null,
          // 주민등록번호는 암호화 저장하고 화면에는 마스킹만 노출한다.
          residentEnc: effectiveResident ? encrypt(effectiveResident) : null,
          residentMasked: effectiveResident ? maskResident(effectiveResident) : null,
        },
      });
    }),
  );
}

/**
 * 지급 실행 **전** 사전 검증.
 *
 * 계좌 인증·잔액 확인은 반드시 돈이 나가기 전에 해야 한다.
 * 이체가 끝난 뒤(markSettlementPaid) 검증해서 throw 하면 이미 나간 돈이
 * 원장에 남지 않아 잔액이 줄지 않고, 사회복지기관이 다시 신청해 **이중 지급**이 된다.
 * 이체파일을 만들 때 이 함수로 걸러낸다.
 */
export async function assertPayable(requestId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const req = await prisma.settlementRequest.findUnique({ where: { id: requestId } });
  if (!req) return { ok: false, reason: '정산 요청을 찾을 수 없습니다.' };
  if (req.status !== 'APPROVED') return { ok: false, reason: '승인(APPROVED) 상태가 아닙니다.' };

  const account = await prisma.settlementAccount.findUnique({ where: { merchantId: req.merchantId } });
  if (!account || !account.verified) return { ok: false, reason: '정산 계좌 인증이 완료되지 않았습니다.' };

  const summary = await getSettlementSummary(req.merchantId);
  if (req.amount > summary.balance) {
    return {
      ok: false,
      reason: `정산 가능 잔액 부족 (요청 ${req.amount.toString()}원 / 잔액 ${summary.balance.toString()}원)`,
    };
  }
  return { ok: true };
}

/**
 * 지급 완료 처리 시 원장에 PAYOUT 분개를 추가한다.
 *
 * ── 이 함수가 불리는 시점 ────────────────────────────────────────────────
 * **이미 지급대행(쿠콘)이 이체를 실행한 뒤**, 그 결과를 반영하는 단계다.
 * 따라서 여기서 검증 실패로 throw 하면 "돈은 나갔는데 원장에는 없는" 상태가 되어
 * 잔액이 줄지 않고 재신청 시 이중 지급된다. 사전 검증은 assertPayable() 에서
 * 이체 전에 끝내고, 여기서는 **어떤 경우에도 분개를 남긴다.**
 * 문제가 있는 건은 막는 대신 경고 메모를 붙여 사람이 확인하도록 한다.
 *
 * advisory lock 키는 요청ID가 아니라 **사회복지기관**다.
 * 실제로 보호해야 하는 자원은 그 사회복지기관의 잔액이므로, 요청ID로 잠그면
 * 같은 사회복지기관의 서로 다른 요청 2건이 서로 다른 락을 잡고 동시에 통과한다.
 */
export async function markSettlementPaid(requestId: string, adminId?: string, payoutRef?: string) {
  return prisma.$transaction(async (tx) =>
    withAdvisoryLock(tx, `settlement:merchant:${await merchantIdOf(tx, requestId)}`, async () => {
      const req = await tx.settlementRequest.findUnique({ where: { id: requestId } });
      if (!req) throw new Error('정산 요청을 찾을 수 없습니다.');
      if (req.status === 'PAID') return req;

      // 이미 지급 실패로 되돌린 건을 다시 지급 완료로 올리는 것은 사람이 판단해야 한다.
      if (req.status !== 'APPROVED' && req.status !== 'PAYOUT_FAILED') {
        throw new Error('승인(APPROVED) 또는 지급실패(PAYOUT_FAILED) 상태만 지급 완료 처리할 수 있습니다.');
      }

      // 이체는 이미 끝난 뒤다. 이상이 있어도 분개는 반드시 남기고, 메모로 경고만 남긴다.
      const warnings: string[] = [];
      const account = await tx.settlementAccount.findUnique({ where: { merchantId: req.merchantId } });
      if (!account || !account.verified) warnings.push('계좌 인증 해제 상태에서 지급됨');

      const summary = await getSettlementSummary(req.merchantId, tx);
      if (req.amount > summary.balance) {
        warnings.push(
          `잔액 초과 지급 (요청 ${req.amount.toString()}원 / 잔액 ${summary.balance.toString()}원)`,
        );
      }

      const now = new Date();
      await appendLedger(
        [
          {
            merchantId: req.merchantId, entryType: 'PAYOUT', amount: -req.payoutAmount,
            requestId: req.id, occurredAt: now, memo: '정산 지급',
          },
          {
            merchantId: req.merchantId, entryType: 'PAYOUT_WITHHOLDING', amount: -req.withholding,
            requestId: req.id, occurredAt: now, memo: '원천징수',
          },
        ],
        tx,
      );

      if (warnings.length > 0) {
        logger.error('정산 지급 완료 처리 중 이상 감지 — 확인 필요', {
          requestId, merchantId: req.merchantId, warnings,
        });
      }

      // 이 회차에 묶인 결제 건을 정산 완료로 확정한다.
      //
      // 지급 분개와 같은 트랜잭션 안에서 한다. 호출부(자동 배치 · 재시도 · 관리자 화면)마다
      // 따로 하면 어느 한 곳이 빠져도 티가 나지 않는다 — 실제로 관리자 화면에서 수동으로
      // 지급 완료한 회차는 결제 건이 영원히 "정산 대기" 로 남아 있었다.
      //
      // 이미 환불된 건(REFUNDED · REFUND_REQUESTED)은 건드리지 않는다. 지급 실패와 재시도
      // 사이에 환불이 승인되면 그 건이 "정산 완료" 로 되살아나 목록·통계가 어긋난다.
      await tx.charge.updateMany({
        where: {
          settlementRequestId: requestId,
          settledAt: null,
          status: { in: PAID_STATUSES },
        },
        data: { settledAt: now, status: 'SETTLED' },
      });

      return tx.settlementRequest.update({
        where: { id: requestId },
        data: {
          status: 'PAID',
          paidAt: now,
          adminId: adminId ?? null,
          payoutRef: payoutRef ?? null,
          payoutFailReason: null,
          adminMemo: warnings.length > 0 ? `[주의] ${warnings.join(' / ')}` : req.adminMemo,
        },
      });
    }),
  );
}

/** 락 키로 쓸 사회복지기관 ID를 먼저 조회한다. */
async function merchantIdOf(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  requestId: string,
): Promise<string> {
  const row = await tx.settlementRequest.findUnique({
    where: { id: requestId },
    select: { merchantId: true },
  });
  if (!row) throw new Error('정산 요청을 찾을 수 없습니다.');
  return row.merchantId;
}

/**
 * 지급대행 이체파일 발급 이력 기록.
 *
 * 같은 승인 건으로 파일을 두 번 받아 두 번 업로드하면 이중이체가 된다.
 * 최초 발급 시각·배치번호를 남기고, 이미 발급된 건이 섞여 있으면 재발급 목록으로 돌려준다.
 */
export async function markPayoutFileIssued(
  requestIds: string[],
  adminId?: string,
): Promise<{ batchNo: string; reissued: string[] }> {
  const batchNo = `B${newId().slice(-10).toUpperCase()}`;
  if (requestIds.length === 0) return { batchNo, reissued: [] };

  const existing = await prisma.settlementRequest.findMany({
    where: { id: { in: requestIds }, payoutIssuedAt: { not: null } },
    select: { id: true },
  });
  const reissued = existing.map((r) => r.id);

  await prisma.settlementRequest.updateMany({
    where: { id: { in: requestIds }, payoutIssuedAt: null },
    data: { payoutIssuedAt: new Date(), payoutBatchNo: batchNo },
  });
  // 재발급 건은 최초 발급 시각을 보존하고 최신 배치번호만 갱신한다.
  if (reissued.length > 0) {
    await prisma.settlementRequest.updateMany({
      where: { id: { in: reissued } },
      data: { payoutBatchNo: batchNo },
    });
    logger.warn('지급대행 이체파일 재발급', { batchNo, reissued, adminId: adminId ?? null });
  }
  return { batchNo, reissued };
}

/**
 * 지급 실패 처리.
 * 지급대행(쿠콘) 결과가 실패로 회신된 건을 처리한다.
 * 이미 PAID 로 원장에 기록됐다면 지급/원천징수 분개를 반대 부호로 환입해
 * 잔액이 되살아나게 하고, 재요청할 수 있도록 상태만 PAYOUT_FAILED 로 둔다.
 */
export async function markSettlementPayoutFailed(requestId: string, reason: string, adminId?: string) {
  return prisma.$transaction(async (tx) =>
    // 지급 완료 처리와 같은 락(사회복지기관 단위)을 잡아야 서로 경합하지 않는다.
    withAdvisoryLock(tx, `settlement:merchant:${await merchantIdOf(tx, requestId)}`, async () => {
      const req = await tx.settlementRequest.findUnique({ where: { id: requestId } });
      if (!req) throw new Error('정산 요청을 찾을 수 없습니다.');
      if (req.status === 'PAYOUT_FAILED') return req;
      if (req.status !== 'PAID' && req.status !== 'APPROVED') {
        throw new Error('지급 완료 또는 승인 상태의 요청만 지급 실패로 처리할 수 있습니다.');
      }

      const now = new Date();
      // 이미 지급 분개가 기록된 경우에만 환입한다.
      if (req.status === 'PAID') {
        await appendLedger(
          [
            {
              merchantId: req.merchantId, entryType: 'PAYOUT', amount: req.payoutAmount,
              requestId: req.id, occurredAt: now, memo: `지급 실패 환입: ${reason}`.slice(0, 200),
            },
            {
              merchantId: req.merchantId, entryType: 'PAYOUT_WITHHOLDING', amount: req.withholding,
              requestId: req.id, occurredAt: now, memo: '지급 실패 원천징수 환입',
            },
          ],
          tx,
        );
      }

      return tx.settlementRequest.update({
        where: { id: requestId },
        data: {
          status: 'PAYOUT_FAILED',
          payoutFailReason: reason.slice(0, 300),
          adminId: adminId ?? null,
        },
      });
    }),
  );
}

/**
 * 원천징수 지급명세서 신고 완료 처리 + 주민등록번호 파기.
 *
 * 지급명세서에 담긴 금액·원천징수·지급일 등 회계 기록은 세법상 보존 의무가 있어 그대로 남기고,
 * **주민등록번호 원문만** 즉시 삭제한다. 출금 신청 화면에서 안내한 "신고 후 파기" 를 실제로 이행한다.
 */
export async function fileWithholdingAndPurgeResident(requestId: string, adminId?: string) {
  const now = new Date();
  const req = await prisma.settlementRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, residentEnc: true, residentPurgedAt: true },
  });
  if (!req) throw new Error('정산 요청을 찾을 수 없습니다.');
  if (req.status !== 'PAID') throw new Error('지급 완료된 요청만 원천징수 신고 처리할 수 있습니다.');

  await prisma.settlementRequest.update({
    where: { id: requestId },
    data: {
      withholdingFiledAt: now,
      // 주민등록번호 원문만 파기한다. 마스킹·금액·원천징수 기록은 유지.
      residentEnc: null,
      residentPurgedAt: req.residentEnc ? now : req.residentPurgedAt ?? now,
      adminId: adminId ?? null,
    },
  });
  return { purged: Boolean(req.residentEnc) };
}

/**
 * 신고 대상이 아닌 건의 주민등록번호 즉시 파기.
 *
 * 반려(REJECTED)·지급실패(PAYOUT_FAILED) 건은 애초에 원천징수 신고 대상이 아니므로
 * 주민등록번호를 보관할 근거가 없다. 지급 완료 건에만 파기 기능이 있으면
 * 이 사본들이 영구히 남아 "신고 후 즉시 파기" 안내와 어긋난다.
 * 상태 전이 시점에 자동으로 호출한다.
 */
export async function purgeResidentIfNotFilable(requestId: string) {
  const req = await prisma.settlementRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, residentEnc: true },
  });
  if (!req || !req.residentEnc) return { purged: false };
  if (req.status !== 'REJECTED' && req.status !== 'PAYOUT_FAILED') {
    return { purged: false };
  }
  await prisma.settlementRequest.update({
    where: { id: requestId },
    data: { residentEnc: null, residentPurgedAt: new Date() },
  });
  logger.info('신고 대상 아님 — 주민등록번호 파기', { requestId, status: req.status });
  return { purged: true };
}

/** 지급대행 이체 파일 한 줄에 담기는 값. */
export interface PayoutRow {
  requestId: string;
  merchantName: string;
  merchantCode: string;
  bankCode: string;
  bankName: string;
  account: string;
  holder: string;
  amount: bigint;
  note: string;
}

/**
 * 승인 건을 지급대행(쿠콘) 이체 대상으로 변환한다.
 * 계좌번호·예금주는 암호화 저장돼 있으므로 여기서 복호화한다(파일 생성 목적).
 * 반환값은 그대로 CSV/엑셀로 만든다.
 */
export async function buildPayoutRows(requestIds: string[]): Promise<PayoutRow[]> {
  if (requestIds.length === 0) return [];
  const reqs = await prisma.settlementRequest.findMany({
    where: { id: { in: requestIds }, status: 'APPROVED' },
    select: {
      id: true, payoutAmount: true,
      merchant: {
        select: {
          displayName: true, code: true,
          settlementAccount: {
            select: { bankCode: true, bankName: true, accountEnc: true, holderNameEnc: true, verified: true },
          },
        },
      },
    },
  });

  const rows: PayoutRow[] = [];
  for (const r of reqs) {
    const acc = r.merchant.settlementAccount;
    if (!acc || !acc.verified) continue; // 미인증 계좌는 이체 대상에서 제외
    // 잔액까지 여기서 걸러낸다. 검증은 반드시 **이체 전** 에 끝나야 한다.
    // 이체가 끝난 뒤(markSettlementPaid) 막으면 이미 나간 돈이 원장에 안 남아 이중 지급이 된다.
    const payable = await assertPayable(r.id);
    if (!payable.ok) {
      logger.warn('지급대행 이체파일에서 제외', { requestId: r.id, reason: payable.reason });
      continue;
    }
    rows.push({
      requestId: r.id,
      merchantName: r.merchant.displayName,
      merchantCode: r.merchant.code,
      bankCode: acc.bankCode,
      bankName: acc.bankName,
      account: decrypt(acc.accountEnc),
      holder: decrypt(acc.holderNameEnc),
      amount: r.payoutAmount,
      note: `기브싸인 정산 ${r.merchant.code}`,
    });
  }
  return rows;
}
