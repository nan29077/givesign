import { prisma } from '@/server/db';
import { resolveFeePolicy } from '@/server/services/settlement';
import {
  SETTLEMENT_BUSINESS_DAYS,
  addDaysKey,
  isBusinessDay,
  settlementDateFor,
  toDateKey,
} from '@/lib/business-day';

/**
 * 정산 주기 계산.
 *
 * 운영 규칙: **결제(결제 완료)일 다음날부터 영업일 5일째가 정산일.**
 * 영업일에서 토·일과 공휴일(법정공휴일·대체공휴일·임시공휴일·근로자의 날)을 뺀다.
 *
 * 공휴일은 public_holiday 표에서 읽는다. 임시공휴일은 매년 갑자기 지정되므로
 * 코드 상수로 두면 그때마다 배포해야 하고, 배포가 늦으면 정산일이 통째로 틀어진다.
 */

/**
 * 이 사회복지기관에 적용되는 지급일(결제일 + N영업일)을 읽는다.
 *
 * 최고관리자가 전역 정책으로 일괄 지정하고, 필요하면 사회복지기관 정책으로 개별 조정한다.
 * 정책이 없으면 코드 기본값(5영업일)을 쓴다.
 */
export async function resolveSettlementDays(merchantId: string, now: Date = new Date()): Promise<number> {
  const policy = await resolveFeePolicy(merchantId, now);
  return policy?.settlementDays ?? SETTLEMENT_BUSINESS_DAYS;
}

/** 조회 구간에 걸치는 공휴일 집합을 읽는다. */
export async function loadHolidays(fromDateKey: string, toDateKeyStr: string): Promise<Set<string>> {
  const rows = await prisma.publicHoliday.findMany({
    where: { active: true, date: { gte: fromDateKey, lte: toDateKeyStr } },
    select: { date: true },
  });
  return new Set(rows.map((r) => r.date));
}

/**
 * 정산일 계산에 필요한 여유 구간까지 포함해 공휴일을 읽는다.
 * 월 마지막 날 결제의 정산일은 다음 달로 넘어가므로 뒤쪽을 넉넉히 잡는다.
 */
export async function loadHolidaysAround(fromDateKey: string, toDateKeyStr: string): Promise<Set<string>> {
  return loadHolidays(addDaysKey(fromDateKey, -40), addDaysKey(toDateKeyStr, 40));
}

/** 공휴일이 하나도 등록되지 않은 연도를 찾아낸다(정산일 오계산 조기 경보). */
export async function findYearsMissingHolidays(years: number[]): Promise<number[]> {
  const missing: number[] = [];
  for (const y of years) {
    const count = await prisma.publicHoliday.count({
      where: { active: true, date: { gte: `${y}-01-01`, lte: `${y}-12-31` } },
    });
    if (count === 0) missing.push(y);
  }
  return missing;
}

export interface SettlementScheduleRow {
  /** 결제(결제 완료)일 YYYY-MM-DD */
  chargeDate: string;
  /** 정산 예정일 YYYY-MM-DD */
  settlementDate: string;
  count: number;
  gross: bigint;
  net: bigint;
}

/**
 * 기간 내 결제 완료 결제를 결제일별로 묶고, 각 결제일의 정산 예정일을 붙인다.
 * 화면(캘린더·안내)과 검증에서 같은 함수를 쓰도록 여기 한 곳에만 둔다.
 */
export async function buildSettlementSchedule(
  merchantId: string,
  start: Date,
  end: Date,
): Promise<SettlementScheduleRow[]> {
  const charges = await prisma.charge.findMany({
    where: {
      merchantId,
      paidAt: { gte: start, lt: end },
      status: { in: ['PAYMENT_SUCCESS', 'BROADCAST_PENDING', 'BROADCASTED', 'PARTIAL_DELIVERY_FAILED', 'SETTLEMENT_PENDING', 'SETTLED'] },
    },
    select: { paidAt: true, amount: true, netAmount: true },
  });

  const [holidays, businessDays] = await Promise.all([
    loadHolidaysAround(toDateKey(start), toDateKey(end)),
    resolveSettlementDays(merchantId),
  ]);

  const byDate = new Map<string, { count: number; gross: bigint; net: bigint }>();
  for (const d of charges) {
    if (!d.paidAt) continue;
    const key = toDateKey(d.paidAt);
    const cur = byDate.get(key) ?? { count: 0, gross: 0n, net: 0n };
    cur.count += 1;
    cur.gross += d.amount;
    cur.net += d.netAmount ?? 0n;
    byDate.set(key, cur);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([chargeDate, v]) => ({
      chargeDate,
      settlementDate: settlementDateFor(chargeDate, holidays, businessDays),
      count: v.count,
      gross: v.gross,
      net: v.net,
    }));
}

export interface UpcomingPayoutRow {
  /** 지급 예정일 YYYY-MM-DD */
  settlementDate: string;
  count: number;
  net: bigint;
  /** 지급일이 이미 도래했는데 아직 지급되지 않은 건 (배치 대기 또는 지급 실패) */
  due: boolean;
}

/**
 * 아직 정산되지 않은 결제를 지급 예정일별로 묶는다.
 *
 * 사회복지기관은 정산을 요청하지 않는다. 지급일이 되면 배치가 자동으로 지급하므로
 * 사회복지기관 화면에는 "언제 얼마가 들어오는지" 만 보여주면 된다.
 */
export async function buildUpcomingPayouts(
  merchantId: string,
  now: Date = new Date(),
): Promise<{ rows: UpcomingPayoutRow[]; settlementDays: number; total: bigint }> {
  const [settlementDays, rows] = await Promise.all([
    resolveSettlementDays(merchantId, now),
    prisma.charge.findMany({
      where: {
        merchantId,
        settledAt: null,
        paidAt: { not: null },
        status: { in: ['PAYMENT_SUCCESS', 'BROADCAST_PENDING', 'BROADCASTED', 'PARTIAL_DELIVERY_FAILED', 'SETTLEMENT_PENDING'] },
      },
      orderBy: { paidAt: 'asc' },
      select: { paidAt: true, netAmount: true },
    }),
  ]);
  if (rows.length === 0) return { rows: [], settlementDays, total: 0n };

  const todayKey = toDateKey(now);
  const holidays = await loadHolidaysAround(toDateKey(rows[0].paidAt!), todayKey);

  const byDate = new Map<string, { count: number; net: bigint }>();
  let total = 0n;
  for (const r of rows) {
    const key = settlementDateFor(toDateKey(r.paidAt!), holidays, settlementDays);
    const cur = byDate.get(key) ?? { count: 0, net: 0n };
    cur.count += 1;
    cur.net += r.netAmount ?? 0n;
    total += r.netAmount ?? 0n;
    byDate.set(key, cur);
  }

  return {
    rows: [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([settlementDate, v]) => ({ settlementDate, count: v.count, net: v.net, due: settlementDate <= todayKey })),
    settlementDays,
    total,
  };
}

export interface ScheduleNotice {
  /** 오늘(KST) */
  today: string;
  /** 오늘 결제하면 언제 정산되는지 */
  todaySettlement: string;
  /** 이번 주 금·토·일 결제가 언제 정산되는지 (동일 정산일로 모인다) */
  weekendChargeDate: string;
  weekendSettlement: string;
  businessDays: number;
  /** 오늘이 영업일인지 */
  todayIsBusinessDay: boolean;
}

/** 정산 현황 상단 안내에 쓰는 예시값. */
export async function buildScheduleNotice(now: Date = new Date(), merchantId?: string): Promise<ScheduleNotice> {
  const today = toDateKey(now);
  const [holidays, businessDays] = await Promise.all([
    loadHolidaysAround(addDaysKey(today, -10), addDaysKey(today, 40)),
    merchantId ? resolveSettlementDays(merchantId, now) : Promise.resolve(SETTLEMENT_BUSINESS_DAYS),
  ]);

  // 이번 주 금요일(오늘 기준 가장 가까운 금요일)을 예시로 잡는다.
  let friday = today;
  for (let i = 0; i < 7; i += 1) {
    const [y, m, d] = friday.split('-').map(Number);
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 5) break;
    friday = addDaysKey(friday, 1);
  }

  return {
    today,
    todaySettlement: settlementDateFor(today, holidays, businessDays),
    weekendChargeDate: friday,
    weekendSettlement: settlementDateFor(friday, holidays, businessDays),
    businessDays,
    todayIsBusinessDay: isBusinessDay(today, holidays),
  };
}
