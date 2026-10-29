import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { maskName } from '@/lib/crypto';
import { kstStartOfMonth } from '@/lib/datetime';
import { PAID_STATUSES } from '@/components/studio/shared';
import { normalizeKeyword } from './content-filter';
import {
  campaignOpen,
  defaultDonationPage,
  normalizeCampaignCode,
  type CampaignInput,
  type DonationPageInput,
} from '@/lib/fundraising';
import type { Campaign, MerchantDonationPage } from '@/generated/prisma/client';
import type { CampaignStatus, Prisma } from '@/generated/prisma/client';

/**
 * 후원페이지·캠페인·모금 현황.
 *
 * 모금액은 어디서든 `charge.campaignId` + PAID_STATUSES 로 집계한다 (절대 규칙 10).
 * 캐시 컬럼을 두지 않으므로 환불이 반영된 값이 항상 나온다.
 */

// ---------------------------------------------------------------------------
// 후원페이지
// ---------------------------------------------------------------------------

export type DonationPage = Omit<MerchantDonationPage, 'updatedAt'>;

export async function getDonationPage(merchantId: string): Promise<DonationPage> {
  const row = await prisma.merchantDonationPage.findUnique({ where: { merchantId } });
  if (row) return row;
  return {
    merchantId,
    title: defaultDonationPage.title,
    subtitle: defaultDonationPage.subtitle,
    intro: defaultDonationPage.intro,
    heroUrl: defaultDonationPage.heroUrl,
    logoUrl: null,
    color: defaultDonationPage.color,
    thanks: defaultDonationPage.thanks,
    transparencyUrl: null,
    published: false,
    showCampaigns: true,
    showProgress: true,
    showRecentDonors: true,
  };
}

export async function saveDonationPage(merchantId: string, input: DonationPageInput) {
  const data = {
    title: input.title,
    subtitle: input.subtitle || null,
    intro: input.intro || null,
    heroUrl: input.heroUrl || null,
    logoUrl: input.logoUrl || null,
    color: input.color,
    thanks: input.thanks || null,
    transparencyUrl: input.transparencyUrl || null,
    published: input.published,
    showCampaigns: input.showCampaigns,
    showProgress: input.showProgress,
    showRecentDonors: input.showRecentDonors,
  };
  return prisma.merchantDonationPage.upsert({
    where: { merchantId },
    create: { merchantId, ...data },
    update: data,
  });
}

// ---------------------------------------------------------------------------
// 캠페인
// ---------------------------------------------------------------------------

export interface CampaignStats {
  raised: bigint;
  donorCount: number;
  chargeCount: number;
}

/** 캠페인별 모금액·후원자 수. 없는 캠페인은 0 으로 채운다. */
export async function campaignStats(campaignIds: string[]): Promise<Map<string, CampaignStats>> {
  const map = new Map<string, CampaignStats>();
  for (const id of campaignIds) map.set(id, { raised: 0n, donorCount: 0, chargeCount: 0 });
  if (campaignIds.length === 0) return map;

  const sums = await prisma.charge.groupBy({
    by: ['campaignId'],
    where: { campaignId: { in: campaignIds }, status: { in: PAID_STATUSES }, isTest: false },
    _sum: { amount: true },
    _count: { _all: true },
  });
  for (const s of sums) {
    if (!s.campaignId) continue;
    map.set(s.campaignId, {
      raised: s._sum.amount ?? 0n,
      donorCount: 0,
      chargeCount: s._count._all,
    });
  }
  // 후원자 수(중복 제거)는 groupBy 로 distinct 를 셀 수 없어 한 번 더 센다.
  const donors = await prisma.charge.groupBy({
    by: ['campaignId', 'payerId'],
    where: { campaignId: { in: campaignIds }, status: { in: PAID_STATUSES }, isTest: false, payerId: { not: null } },
  });
  for (const d of donors) {
    if (!d.campaignId) continue;
    const cur = map.get(d.campaignId)!;
    cur.donorCount += 1;
  }
  return map;
}

export type CampaignWithStats = Campaign & { stats: CampaignStats; open: boolean };

export async function listCampaigns(
  merchantId: string,
  options: { includeArchived?: boolean; publicOnly?: boolean } = {},
): Promise<CampaignWithStats[]> {
  const where: Prisma.CampaignWhereInput = { merchantId };
  if (options.publicOnly) where.status = { in: ['ACTIVE', 'CLOSED'] };
  else if (!options.includeArchived) where.status = { not: 'ARCHIVED' };

  const rows = await prisma.campaign.findMany({
    where,
    orderBy: [{ featured: 'desc' }, { status: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
  });
  const stats = await campaignStats(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, stats: stats.get(r.id)!, open: campaignOpen(r) }));
}

export async function getCampaign(merchantId: string, id: string): Promise<CampaignWithStats | null> {
  const row = await prisma.campaign.findFirst({ where: { id, merchantId } });
  if (!row) return null;
  const stats = await campaignStats([row.id]);
  return { ...row, stats: stats.get(row.id)!, open: campaignOpen(row) };
}

export class CampaignCodeTakenError extends Error {
  constructor() {
    super('이미 같은 문자 키워드를 쓰는 캠페인이 있습니다.');
  }
}

export async function saveCampaign(merchantId: string, input: CampaignInput, id?: string) {
  const code = normalizeCampaignCode(input.code);
  const dup = await prisma.campaign.findFirst({
    where: { merchantId, code, ...(id ? { id: { not: id } } : {}) },
    select: { id: true },
  });
  if (dup) throw new CampaignCodeTakenError();

  const data = {
    code,
    title: input.title,
    summary: input.summary,
    story: input.story || null,
    beneficiary: input.beneficiary || null,
    usagePlan: input.usagePlan || null,
    imageUrl: input.imageUrl || null,
    goalAmount: BigInt(input.goalAmount),
    startsOn: new Date(`${input.startsOn}T00:00:00Z`),
    endsOn: new Date(`${input.endsOn}T00:00:00Z`),
    featured: input.featured,
    resultReport: input.resultReport || null,
  };
  if (id) {
    const existing = await prisma.campaign.findFirst({ where: { id, merchantId }, select: { id: true } });
    if (!existing) throw new Error('캠페인을 찾을 수 없습니다.');
    return prisma.campaign.update({ where: { id }, data });
  }
  return prisma.campaign.create({ data: { id: newId(), merchantId, status: 'DRAFT', ...data } });
}

/** 상태 전이. DRAFT→ACTIVE, ACTIVE→CLOSED/DRAFT, CLOSED→ACTIVE/ARCHIVED, ARCHIVED→DRAFT(복원) */
const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['CLOSED', 'DRAFT'],
  CLOSED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

export async function setCampaignStatus(merchantId: string, id: string, next: CampaignStatus) {
  const row = await prisma.campaign.findFirst({ where: { id, merchantId } });
  if (!row) throw new Error('캠페인을 찾을 수 없습니다.');
  if (!CAMPAIGN_TRANSITIONS[row.status].includes(next)) {
    throw new Error(`'${row.status}' 상태에서는 '${next}' 로 바꿀 수 없습니다.`);
  }
  return prisma.campaign.update({
    where: { id },
    data: {
      status: next,
      closedAt: next === 'CLOSED' ? new Date() : next === 'ACTIVE' ? null : row.closedAt,
      archivedAt: next === 'ARCHIVED' ? new Date() : null,
    },
  });
}

/**
 * 문자 본문 맨 앞 토큰이 모금 중인 캠페인 키워드와 맞으면 캠페인을 돌려주고 키워드를 떼어 낸다.
 * (SHARED_PREFIX 기관 키워드는 routeMerchant 가 먼저 떼어 낸 뒤 이 함수가 본다)
 */
export async function matchCampaignKeyword(
  merchantId: string,
  body: string,
  now = new Date(),
): Promise<{ campaign: Campaign | null; rest: string }> {
  const t = (body ?? '').trim();
  const m = t.match(/^([\p{L}\p{N}][\p{L}\p{N}._-]{1,19})(?:\s+([\s\S]*))?$/u);
  if (!m) return { campaign: null, rest: t };
  const token = normalizeKeyword(m[1]);
  if (!token) return { campaign: null, rest: t };

  const candidates = await prisma.campaign.findMany({ where: { merchantId, status: 'ACTIVE' } });
  const hit = candidates.find((c) => normalizeKeyword(c.code) === token && campaignOpen(c, now));
  if (!hit) return { campaign: null, rest: t };
  return { campaign: hit, rest: (m[2] ?? '').trim() };
}

/** 공개 화면·금액 선택 화면에서 고를 수 있는 캠페인(모금 중만). */
export async function openCampaigns(merchantId: string) {
  const rows = await prisma.campaign.findMany({
    where: { merchantId, status: 'ACTIVE' },
    orderBy: [{ featured: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
  });
  return rows.filter((r) => campaignOpen(r));
}

// ---------------------------------------------------------------------------
// 기관 모금 현황
// ---------------------------------------------------------------------------

export interface MerchantDonationSummary {
  /** 전체 누적 후원액(결제 성공, 환불 제외) */
  totalRaised: bigint;
  totalDonors: number;
  totalCharges: number;
  /** 이달(KST) */
  monthRaised: bigint;
  monthCharges: number;
  /** 활성 정기후원 */
  recurringActive: number;
  recurringMonthly: bigint;
}

export async function merchantDonationSummary(merchantId: string, now = new Date()): Promise<MerchantDonationSummary> {
  const paid = { merchantId, status: { in: PAID_STATUSES }, isTest: false } as const;
  const [all, month, donors, recurring] = await Promise.all([
    prisma.charge.aggregate({ where: paid, _sum: { amount: true }, _count: { _all: true } }),
    prisma.charge.aggregate({
      where: { ...paid, paidAt: { gte: kstStartOfMonth(now) } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.charge.groupBy({ by: ['payerId'], where: { ...paid, payerId: { not: null } } }),
    prisma.recurringDonation.aggregate({
      where: { merchantId, status: 'ACTIVE' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);
  return {
    totalRaised: all._sum.amount ?? 0n,
    totalDonors: donors.length,
    totalCharges: all._count._all,
    monthRaised: month._sum.amount ?? 0n,
    monthCharges: month._count._all,
    recurringActive: recurring._count._all,
    recurringMonthly: recurring._sum.amount ?? 0n,
  };
}

export interface RecentDonor {
  name: string;
  amount: bigint;
  message: string;
  paidAt: Date;
  campaignTitle: string | null;
  recurring: boolean;
}

/** 공개 화면용 최근 후원. 이름은 마스킹하고 익명 요청은 '익명' 으로 바꾼다. 전화번호는 절대 포함하지 않는다. */
export async function recentDonors(merchantId: string, limit = 10): Promise<RecentDonor[]> {
  const rows = await prisma.charge.findMany({
    where: { merchantId, status: { in: PAID_STATUSES }, isTest: false, paidAt: { not: null } },
    orderBy: { paidAt: 'desc' },
    take: limit,
    select: {
      displayName: true,
      amount: true,
      message: true,
      paidAt: true,
      anonymous: true,
      recurringId: true,
      campaign: { select: { title: true } },
    },
  });
  return rows.map((r) => ({
    name: r.anonymous ? '익명' : maskName(r.displayName),
    amount: r.amount,
    message: r.anonymous ? '' : r.message,
    paidAt: r.paidAt!,
    campaignTitle: r.campaign?.title ?? null,
    recurring: Boolean(r.recurringId),
  }));
}

/** 월별 후원 추이(최근 n개월). 대시보드 막대용. */
export async function monthlyTrend(merchantId: string, months = 6, now = new Date()) {
  const start = kstStartOfMonth(new Date(now.getFullYear(), now.getMonth() - (months - 1), 1));
  const rows = await prisma.charge.findMany({
    where: { merchantId, status: { in: PAID_STATUSES }, isTest: false, paidAt: { gte: start } },
    select: { amount: true, paidAt: true, recurringId: true },
  });
  const buckets = new Map<string, { total: bigint; recurring: bigint; count: number }>();
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, { total: 0n, recurring: 0n, count: 0 });
  }
  for (const r of rows) {
    const kst = new Date(r.paidAt!.getTime() + 9 * 3600000);
    const key = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
    const b = buckets.get(key);
    if (!b) continue;
    b.total += r.amount;
    b.count += 1;
    if (r.recurringId) b.recurring += r.amount;
  }
  return [...buckets.entries()].map(([month, v]) => ({ month, ...v }));
}

// ---------------------------------------------------------------------------
// 외부 전달용 후원 메타 (파트너 API · 웹훅)
// ---------------------------------------------------------------------------

export interface DonationMeta {
  /** 후원자가 공개 화면에 이름·메시지를 숨겨 달라고 했는가. 연동사 화면에 띄울 때 반드시 지킨다. */
  anonymous: boolean;
  /** 지정 캠페인(없으면 기관 일반 후원) */
  campaign: { id: string; code: string; title: string } | null;
  /** 정기후원 자동 출금 건인가 */
  recurring: boolean;
}

export async function donationMeta(chargeId: string): Promise<DonationMeta> {
  const c = await prisma.charge.findUnique({
    where: { id: chargeId },
    select: { anonymous: true, recurringId: true, campaign: { select: { id: true, code: true, title: true } } },
  });
  return { anonymous: Boolean(c?.anonymous), campaign: c?.campaign ?? null, recurring: Boolean(c?.recurringId) };
}
