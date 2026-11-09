import { prisma } from '@/server/db';
import { PAID_STATUSES } from '@/components/studio/shared';

/**
 * 후원자 화면 후원 내역 (2026-11-09 2차 F) — 연도별 합계 + 건별 내역(출처 표시).
 *
 * 원천은 각 테이블이다(복사하지 않음). 지금 출처는 결제(charge, PAID_STATUSES) 하나이고,
 * 계좌이체 확정분(2차 E)처럼 다른 출처는 `registerDonationHistorySource(name, fn)` 로 붙인다 —
 * 이 파일을 고치지 않고 E 쪽에서 등록하면 기관 회원 화면·통합 화면이 함께 보여 준다.
 * 출처 함수가 실패하면 그 출처만 빠지고(`failedSources`) 나머지는 보인다.
 */

export interface DonationHistoryEntry {
  /** 출처 안에서 유일한 id */
  id: string;
  /** 출처 키 (CHARGE · 등록한 이름) */
  source: string;
  /** 화면 표시용 출처 이름 (문자 후원 · 웹 후원 · 정기후원 · 계좌이체 …) */
  sourceLabel: string;
  merchantId: string;
  amount: bigint;
  /** 후원이 확정된 시각 */
  at: Date;
  title: string;
  detail?: string | null;
  reference?: string | null;
}

export type DonationHistorySource = (q: { payerId: string; merchantId?: string; from: Date; to: Date }) => Promise<DonationHistoryEntry[]>;

const g = globalThis as unknown as { donationHistorySources?: Map<string, { label: string; fn: DonationHistorySource }> };
const sources = g.donationHistorySources ?? new Map<string, { label: string; fn: DonationHistorySource }>();
g.donationHistorySources = sources;

/** 다른 출처 붙이기(예: 2차 E 계좌이체 확정분). 같은 이름이면 덮어쓴다. */
export function registerDonationHistorySource(name: string, fn: DonationHistorySource, label = name) {
  if (name === 'CHARGE') throw new Error('CHARGE 는 기본 출처입니다.');
  sources.set(name, { label, fn });
}

export function registeredDonationHistorySources(): string[] {
  return ['CHARGE', ...sources.keys()];
}

const CHANNEL_LABEL: Record<string, string> = { MO: '문자 후원', WEB: '웹 후원', RECURRING: '정기후원' };

/** 기본 출처: 결제 성공 건 */
const chargeSource: DonationHistorySource = async ({ payerId, merchantId, from, to }) => {
  const rows = await prisma.charge.findMany({
    where: { payerId, ...(merchantId ? { merchantId } : {}), isTest: false, status: { in: PAID_STATUSES }, paidAt: { gte: from, lt: to } },
    orderBy: { paidAt: 'desc' },
    take: 500,
    select: { id: true, merchantId: true, amount: true, paidAt: true, channel: true, transactionNo: true, anonymous: true, message: true, campaign: { select: { title: true } } },
  });
  return rows.map((c) => ({
    id: c.id,
    source: 'CHARGE',
    sourceLabel: CHANNEL_LABEL[c.channel] ?? '후원',
    merchantId: c.merchantId,
    amount: c.amount,
    at: c.paidAt ?? new Date(0),
    title: c.campaign?.title ?? CHANNEL_LABEL[c.channel] ?? '후원',
    detail: [c.message && c.message !== '정기후원' ? c.message : null, c.anonymous ? '익명' : null].filter(Boolean).join(' · ') || null,
    reference: c.transactionNo,
  }));
};

function kstYearRange(year: number) {
  return { from: new Date(Date.UTC(year, 0, 1) - 9 * 3_600_000), to: new Date(Date.UTC(year + 1, 0, 1) - 9 * 3_600_000) };
}

function kstYear(d: Date) {
  return new Date(d.getTime() + 9 * 3_600_000).getUTCFullYear();
}

export interface DonationHistory {
  year: number;
  /** 고를 수 있는 연도(후원이 있는 해, 최신 순) */
  years: number[];
  /** 연도별 합계 */
  totals: Array<{ year: number; amount: bigint; count: number }>;
  entries: DonationHistoryEntry[];
  yearTotal: bigint;
  failedSources: string[];
}

/** 연도별 합계 + 그 해 건별 내역. merchantId 를 주면 그 기관만(기관 후원 회원 화면). */
export async function donorDonationHistory(payerId: string, opts: { merchantId?: string; year?: number; now?: Date } = {}): Promise<DonationHistory> {
  const now = opts.now ?? new Date();
  const thisYear = kstYear(now);
  // 연도별 합계는 최근 6년까지(결제 + 등록 출처)
  const span = { from: kstYearRange(thisYear - 5).from, to: kstYearRange(thisYear).to };
  const all: Array<{ name: string; label: string; fn: DonationHistorySource }> = [{ name: 'CHARGE', label: '결제', fn: chargeSource }, ...[...sources.entries()].map(([name, v]) => ({ name, ...v }))];
  const failedSources: string[] = [];
  const lists = await Promise.all(
    all.map((s) =>
      s.fn({ payerId, merchantId: opts.merchantId, ...span }).catch(() => {
        failedSources.push(s.label);
        return [] as DonationHistoryEntry[];
      }),
    ),
  );
  const entriesAll = lists.flat().filter((e) => !opts.merchantId || e.merchantId === opts.merchantId);
  const byYear = new Map<number, { amount: bigint; count: number }>();
  for (const e of entriesAll) {
    const y = kstYear(e.at);
    const cur = byYear.get(y) ?? { amount: 0n, count: 0 };
    byYear.set(y, { amount: cur.amount + e.amount, count: cur.count + 1 });
  }
  const totals = [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([year, v]) => ({ year, ...v }));
  const years = totals.map((t) => t.year);
  const year = opts.year && years.includes(opts.year) ? opts.year : years[0] ?? thisYear;
  const entries = entriesAll.filter((e) => kstYear(e.at) === year).sort((a, b) => b.at.getTime() - a.at.getTime());
  return { year, years: years.length ? years : [thisYear], totals, entries, yearTotal: byYear.get(year)?.amount ?? 0n, failedSources };
}
