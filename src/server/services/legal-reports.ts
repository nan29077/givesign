import { prisma } from '@/server/db';
import { kstDateKey } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { maskName } from '@/lib/crypto';
import { PAID_STATUSES } from '@/components/studio/shared';
import type { InboxExceptionGroup } from './inbox-groups';

/**
 * 사회복지기관 법정 서류 자동 작성 — 2026-11-09 3차 H2.
 *
 * 근거(작업자가 확인한 요약, 확정 전 — **법령 서식과 대조 필요**, 법무·세무 확인 필요):
 *  「사회복지법인 및 사회복지시설 재무·회계 규칙」 제41조의4(영수증·발급 대장) · 제41조의5(연 1회 이상 후원자 통보)
 *  · 제41조의6(별지 제19호서식 후원금 수입 및 사용결과 보고서, 3개월 공개, 후원자 성명 비공개) · 제41조의7(지정 용도 외 사용 금지).
 *
 *  - 수입 명세 = 기브싸인 결제(PAID_STATUSES, 환불 제외 — 절대 규칙 9 와 같은 기준, 결제일 기준)
 *    + 계좌이체 확정분(offline_donation CONFIRMED — 영수증 합산 설정과 무관하게 포함, 출처 열로 구분)
 *    + 현물(발급된 현물 기부금영수증 ISSUED, 기부일 기준 — 바자회 스위치가 꺼져도 포함, 바자회 예외 규칙과 같음).
 *  - 공개용 판은 후원자 이름을 넣지 않는다. 내부용 판은 마스킹 이름만(원문·연락처·주민번호 없음).
 *  - 사용 명세는 fund_expense(사업 진행 기록 집행 내역과 같은 표)다.
 *  - 이 모듈은 숫자를 모을 뿐 제출·게시를 대신하지 않는다(제출 완료를 꾸며 내지 않음).
 */

export const LEGAL_NOTICE = '법령 서식과 대조 필요 — 이 자료는 서식 항목을 채운 작성 보조 자료이며 법정 서식 원본이 아닙니다. 제출 전 법무·세무 확인을 받으세요.';

export function yearRange(year: number) {
  return { gte: new Date(`${year}-01-01T00:00:00+09:00`), lt: new Date(`${year + 1}-01-01T00:00:00+09:00`) };
}

export type IncomeSource = 'CHARGE' | 'OFFLINE' | 'IN_KIND';
export const INCOME_SOURCE_LABEL: Record<IncomeSource, string> = {
  CHARGE: '기브싸인 결제',
  OFFLINE: '계좌이체(기관 통장)',
  IN_KIND: '현물',
};
export type DonorKind = '개인' | '법인' | '단체';

export interface IncomeRow {
  date: string;
  source: IncomeSource;
  donorKind: DonorKind;
  /** 지정 용도(캠페인 이름) 또는 '비지정' */
  designation: string;
  campaignId: string | null;
  amount: bigint;
  /** 내부용 판에만(마스킹) */
  maskedName?: string;
}

export interface IncomeStatement {
  year: number;
  rows: IncomeRow[];
  total: bigint;
  bySource: Record<IncomeSource, { count: number; amount: bigint }>;
  designated: bigint;
  undesignated: bigint;
}

function kstKey(d: Date) {
  return kstDateKey(d);
}

async function campaignTitles(merchantId: string) {
  const list = await prisma.campaign.findMany({ where: { merchantId }, select: { id: true, title: true } });
  return new Map(list.map((c) => [c.id, c.title]));
}

/**
 * 후원금 수입 명세.
 * @param variant public = 이름 없음(공개·제출용), internal = 마스킹 이름 포함
 */
export async function incomeStatement(merchantId: string, year: number, variant: 'public' | 'internal' = 'public'): Promise<IncomeStatement> {
  const range = yearRange(year);
  const [charges, offline, inKind, titles] = await Promise.all([
    prisma.charge.findMany({
      where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, paidAt: range },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      select: { paidAt: true, amount: true, campaignId: true, displayName: true, anonymous: true },
    }),
    prisma.offlineDonation.findMany({
      where: { merchantId, status: 'CONFIRMED', donatedAt: range },
      orderBy: [{ donatedAt: 'asc' }, { id: 'asc' }],
      select: { donatedAt: true, amount: true, campaignId: true, payer: { select: { displayName: true } } },
    }),
    prisma.inKindReceipt.findMany({
      where: { merchantId, status: 'ISSUED', donatedAt: range },
      orderBy: [{ donatedAt: 'asc' }, { id: 'asc' }],
      select: { donatedAt: true, totalAmount: true, donorType: true, donorSnapshot: true },
    }),
    campaignTitles(merchantId),
  ]);
  const internal = variant === 'internal';
  const designation = (id: string | null) => (id ? (titles.get(id) ?? '지정(캠페인)') : '비지정');
  const rows: IncomeRow[] = [];
  for (const c of charges) {
    rows.push({
      date: kstKey(c.paidAt!), source: 'CHARGE', donorKind: '개인', designation: designation(c.campaignId), campaignId: c.campaignId, amount: c.amount,
      ...(internal ? { maskedName: c.anonymous ? '익명' : maskName(c.displayName || '후원자') } : {}),
    });
  }
  for (const o of offline) {
    rows.push({
      date: kstKey(o.donatedAt), source: 'OFFLINE', donorKind: '개인', designation: designation(o.campaignId), campaignId: o.campaignId, amount: o.amount,
      ...(internal ? { maskedName: maskName(o.payer.displayName || '후원자') } : {}),
    });
  }
  for (const k of inKind) {
    const snap = (k.donorSnapshot ?? {}) as { name?: string; legalName?: string; displayName?: string };
    rows.push({
      date: kstKey(k.donatedAt), source: 'IN_KIND', donorKind: k.donorType === 'CORPORATE' ? '법인' : '개인', designation: '비지정', campaignId: null, amount: k.totalAmount,
      ...(internal ? { maskedName: maskName(snap.name || snap.legalName || snap.displayName || '기부자') } : {}),
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const bySource: IncomeStatement['bySource'] = { CHARGE: { count: 0, amount: 0n }, OFFLINE: { count: 0, amount: 0n }, IN_KIND: { count: 0, amount: 0n } };
  let designated = 0n;
  let undesignated = 0n;
  for (const r of rows) {
    bySource[r.source].count += 1;
    bySource[r.source].amount += r.amount;
    if (r.campaignId) designated += r.amount;
    else undesignated += r.amount;
  }
  return { year, rows, total: designated + undesignated, bySource, designated, undesignated };
}

export interface UsageRow {
  id: string;
  date: string;
  description: string;
  amount: bigint;
  designation: string;
  campaignId: string | null;
  impactUpdateId: string | null;
}

export async function usageStatement(merchantId: string, year: number) {
  const [rows, titles] = await Promise.all([
    prisma.fundExpense.findMany({
      where: { merchantId, archivedAt: null, usedOn: { gte: new Date(`${year}-01-01T00:00:00Z`), lt: new Date(`${year + 1}-01-01T00:00:00Z`) } },
      orderBy: [{ usedOn: 'asc' }, { createdAt: 'asc' }],
    }),
    campaignTitles(merchantId),
  ]);
  const out: UsageRow[] = rows.map((r) => ({
    id: r.id,
    date: r.usedOn.toISOString().slice(0, 10),
    description: r.description,
    amount: r.amount,
    designation: r.campaignId ? (titles.get(r.campaignId) ?? '지정(캠페인)') : '비지정',
    campaignId: r.campaignId,
    impactUpdateId: r.impactUpdateId,
  }));
  const total = out.reduce((a, r) => a + r.amount, 0n);
  const designated = out.filter((r) => r.campaignId).reduce((a, r) => a + r.amount, 0n);
  return { year, rows: out, total, designated, undesignated: total - designated };
}

// ---------------------------------------------------------------------------
// 지정 용도 외 사용 경고 (제41조의7)
// ---------------------------------------------------------------------------

export type DesignationWarningKind = 'OVERSPENT' | 'MISMATCH' | 'GENERAL_OVERSPENT';

export interface DesignationWarning {
  kind: DesignationWarningKind;
  campaignId: string | null;
  title: string;
  message: string;
  income?: bigint;
  usage?: bigint;
}

/**
 * 경고(판정만 — 막지 않는다):
 *  - OVERSPENT: 캠페인 지정 수입(그해 말까지 누적, 결제 + 계좌이체 확정분)보다 그 캠페인 사용(누적)이 많다.
 *  - MISMATCH: 진행 기록의 캠페인과 집행 내역의 지정 용도가 다르다(다른 용도로 쓴 것으로 보임).
 *  - GENERAL_OVERSPENT: 비지정 사용이 비지정 현금 수입보다 많다 — 지정 후원금이 다른 용도에 쓰였을 수 있다.
 * 현물은 현금 사용과 비교하지 않는다.
 */
export async function designationWarnings(merchantId: string, year: number): Promise<DesignationWarning[]> {
  const until = yearRange(year).lt;
  const untilDate = new Date(`${year + 1}-01-01T00:00:00Z`);
  const [chargeBy, offlineBy, usageBy, titles, linked] = await Promise.all([
    prisma.charge.groupBy({ by: ['campaignId'], where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, paidAt: { lt: until } }, _sum: { amount: true } }),
    prisma.offlineDonation.groupBy({ by: ['campaignId'], where: { merchantId, status: 'CONFIRMED', donatedAt: { lt: until } }, _sum: { amount: true } }),
    prisma.fundExpense.groupBy({ by: ['campaignId'], where: { merchantId, archivedAt: null, usedOn: { lt: untilDate } }, _sum: { amount: true } }),
    campaignTitles(merchantId),
    prisma.fundExpense.findMany({
      where: { merchantId, archivedAt: null, impactUpdateId: { not: null }, usedOn: { gte: new Date(`${year}-01-01T00:00:00Z`), lt: untilDate } },
      select: { id: true, campaignId: true, description: true, impactUpdate: { select: { campaignId: true, title: true } } },
    }),
  ]);
  const income = new Map<string, bigint>();
  const key = (id: string | null) => id ?? '__general__';
  for (const g of [...chargeBy, ...offlineBy]) income.set(key(g.campaignId), (income.get(key(g.campaignId)) ?? 0n) + (g._sum.amount ?? 0n));
  const out: DesignationWarning[] = [];
  for (const u of usageBy) {
    const used = u._sum.amount ?? 0n;
    const inc = income.get(key(u.campaignId)) ?? 0n;
    if (used <= inc) continue;
    if (u.campaignId) {
      const title = titles.get(u.campaignId) ?? '캠페인';
      out.push({
        kind: 'OVERSPENT', campaignId: u.campaignId, title,
        message: `「${title}」 사용(${formatWon(used)})이 지정 후원 수입(${formatWon(inc)})보다 많습니다. 다른 재원에서 쓴 부분이 있는지 확인하세요.`,
        income: inc, usage: used,
      });
    } else {
      out.push({
        kind: 'GENERAL_OVERSPENT', campaignId: null, title: '비지정',
        message: `비지정 사용(${formatWon(used)})이 비지정 현금 수입(${formatWon(inc)})보다 많습니다. 지정 후원금이 다른 용도로 쓰이지 않았는지 확인하세요.`,
        income: inc, usage: used,
      });
    }
  }
  for (const e of linked) {
    const upd = e.impactUpdate;
    if (!upd || upd.campaignId === e.campaignId) continue;
    out.push({
      kind: 'MISMATCH', campaignId: e.campaignId, title: upd.title,
      message: `진행 기록 「${upd.title}」 의 집행 내역 「${e.description}」 지정 용도가 기록의 캠페인과 다릅니다.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 요약 · 연 1회 통보 대상 · 사용 요약 문장
// ---------------------------------------------------------------------------

export async function legalSummary(merchantId: string, year: number) {
  const [income, usage, warnings, noticeSent, setting] = await Promise.all([
    incomeStatement(merchantId, year, 'public'),
    usageStatement(merchantId, year),
    designationWarnings(merchantId, year),
    prisma.legalNoticeDelivery.count({ where: { merchantId, taxYear: year, status: 'SENT' } }),
    getLegalSetting(merchantId),
  ]);
  return { income, usage, warnings, noticeSent, setting };
}

/** 연 1회 통보 본문의 기관 전체 사용 요약({{사용요약}}). 이름 없음. */
export function usageSummaryText(income: Pick<IncomeStatement, 'total' | 'bySource' | 'designated' | 'undesignated'>, usage: { total: bigint; rows: UsageRow[] }): string {
  const lines = [
    `후원금 수입 ${formatWon(income.total)} (기브싸인 결제 ${formatWon(income.bySource.CHARGE.amount)} · 계좌이체 ${formatWon(income.bySource.OFFLINE.amount)} · 현물 ${formatWon(income.bySource.IN_KIND.amount)})`,
    `지정 후원 ${formatWon(income.designated)} · 비지정 후원 ${formatWon(income.undesignated)}`,
    `후원금 사용 ${formatWon(usage.total)} (${formatNumber(usage.rows.length)}건)`,
  ];
  const byDesignation = new Map<string, bigint>();
  for (const r of usage.rows) byDesignation.set(r.designation, (byDesignation.get(r.designation) ?? 0n) + r.amount);
  const top = [...byDesignation.entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).slice(0, 8);
  for (const [k, v] of top) lines.push(`- ${k}: ${formatWon(v)}`);
  return lines.join('\n');
}

export interface AnnualNoticeTarget {
  payerId: string;
  count: number;
  amount: bigint;
}

/** 그해 수입(결제 + 계좌이체 확정분)이 있는 후원자(제외 전). 현물 기부자는 후원자 계정이 없어 대상이 아니다. */
export async function annualNoticeParticipants(merchantId: string, year: number): Promise<AnnualNoticeTarget[]> {
  const range = yearRange(year);
  const [c, o] = await Promise.all([
    prisma.charge.groupBy({ by: ['payerId'], where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, paidAt: range, payerId: { not: null } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.offlineDonation.groupBy({ by: ['payerId'], where: { merchantId, status: 'CONFIRMED', donatedAt: range }, _sum: { amount: true }, _count: { _all: true } }),
  ]);
  const map = new Map<string, AnnualNoticeTarget>();
  for (const g of c) if (g.payerId) map.set(g.payerId, { payerId: g.payerId, count: g._count._all, amount: g._sum.amount ?? 0n });
  for (const g of o) {
    const cur = map.get(g.payerId) ?? { payerId: g.payerId, count: 0, amount: 0n };
    cur.count += g._count._all;
    cur.amount += g._sum.amount ?? 0n;
    map.set(g.payerId, cur);
  }
  return [...map.values()].sort((a, b) => (a.payerId < b.payerId ? -1 : a.payerId > b.payerId ? 1 : 0));
}

export function annualParticipationText(year: number, t: Pick<AnnualNoticeTarget, 'count' | 'amount'>): string {
  return `${year}년 보내 주신 후원 ${formatNumber(t.count)}회 · 합계 ${formatWon(t.amount)}`;
}

// ---------------------------------------------------------------------------
// 설정 · 결산 시기 알림(승인 대기함 예외 묶음)
// ---------------------------------------------------------------------------

export async function getLegalSetting(merchantId: string) {
  const s = await prisma.legalReportSetting.findUnique({ where: { merchantId } });
  return { seasonStartMonth: s?.seasonStartMonth ?? 2, seasonEndMonth: s?.seasonEndMonth ?? 3, preparedYear: s?.preparedYear ?? null, preparedAt: s?.preparedAt ?? null };
}

export class LegalReportError extends Error {}

export async function saveLegalSetting(merchantId: string, userId: string, start: number, end: number) {
  if (![start, end].every((m) => Number.isInteger(m) && m >= 1 && m <= 12)) throw new LegalReportError('결산 시기는 1~12월로 골라 주세요.');
  await prisma.legalReportSetting.upsert({
    where: { merchantId },
    create: { merchantId, seasonStartMonth: start, seasonEndMonth: end, updatedBy: userId },
    update: { seasonStartMonth: start, seasonEndMonth: end, updatedBy: userId },
  });
}

/** 결과 보고서를 내려받으면 그해 준비를 마친 것으로 본다(알림을 닫는다). 더 이른 해로 되돌리지 않는다. */
export async function markLegalPrepared(merchantId: string, year: number) {
  const cur = await prisma.legalReportSetting.findUnique({ where: { merchantId }, select: { preparedYear: true } });
  if (cur?.preparedYear != null && cur.preparedYear >= year) return;
  await prisma.legalReportSetting.upsert({
    where: { merchantId },
    create: { merchantId, preparedYear: year, preparedAt: new Date() },
    update: { preparedYear: year, preparedAt: new Date() },
  });
}

export function inSeason(month: number, start: number, end: number) {
  return start <= end ? month >= start && month <= end : month >= start || month <= end;
}

/**
 * 승인 대기함 "법정 서류 준비" 묶음(1차 형식 InboxExceptionGroup). 결산 시기(기본 2~3월, 기관 설정)이고
 * 지난해 결과 보고서를 아직 내려받지 않았으면 보인다. 원천에서 그때그때 센다.
 */
export async function legalDocsInboxGroup(merchantId: string, now = new Date()): Promise<InboxExceptionGroup | null> {
  const key = kstDateKey(now);
  const month = Number(key.slice(5, 7));
  const s = await getLegalSetting(merchantId);
  if (!inSeason(month, s.seasonStartMonth, s.seasonEndMonth)) return null;
  // 결산 시기가 시작된 해의 지난해가 결산 대상이다(기본 2~3월 → 지난해). 해를 넘는 시기(예: 12~1월)는 시작한 해 기준.
  const nowYear = Number(key.slice(0, 4));
  const startYear = s.seasonStartMonth <= s.seasonEndMonth || month >= s.seasonStartMonth ? nowYear : nowYear - 1;
  const year = startYear - 1;
  if (s.preparedYear != null && s.preparedYear >= year) return null;
  const warnings = await designationWarnings(merchantId, year);
  const oldest = new Date(`${startYear}-${String(s.seasonStartMonth).padStart(2, '0')}-01T00:00:00+09:00`);
  return {
    kind: 'LEGAL_DOCS_PREP',
    title: `${year}년 법정 서류 준비`,
    reason: `결산 시기입니다(${s.seasonStartMonth}월~${s.seasonEndMonth}월). 후원금 수입 및 사용결과 보고서 제출·3개월 공개와 후원자 연 1회 통보를 준비하세요${warnings.length ? ` · 용도 확인 필요 ${warnings.length}건` : ''}. 법령 서식과 대조 필요.`,
    affectedCount: 1 + warnings.length,
    oldestAt: oldest,
    href: `/studio/reports/legal?year=${year}`,
    recommendedAction: '법정 서류 화면에서 수입·사용 명세를 확인하고 결과 보고서를 내려받으세요. 내려받으면 이 알림이 닫힙니다.',
    actions: [],
    severity: warnings.length ? 'high' : 'normal',
  };
}
