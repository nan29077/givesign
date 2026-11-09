import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { kstDateKey } from '@/lib/datetime';
import { kstWeekdayHour, WEEKDAY_KO } from '@/lib/weekly-plan';
import { PAID_STATUSES } from '@/components/studio/shared';
import type { ContentKind } from '@/generated/prisma/enums';

/**
 * 콘텐츠 성과 폐루프 (2026-11-11 G2).
 *
 *  - 귀속: 게시물 → `/go/게시 id` 클릭(content_publish.clicks) → `givesign_src`/cid 쿠키 → 결제 건·약정·봉사 신청의 content_item_id.
 *    원천은 각 테이블이다(결제 건 = 후원 건수·후원액, 정기 약정 = 신규 약정, 약정 90일 뒤 ACTIVE + 성공 출금 2회 이상 = 유지 약정).
 *  - 출처(콘텐츠)를 모르는 후원은 "미확인" 으로 따로 세고 어떤 콘텐츠에도 배정하지 않는다(추정 배분 없음).
 *  - 성과 상위 요소(형식·주제·요일·시각·첫 문장 길이)는 게시 10건 이상일 때만 요약해 다음 생성 프롬프트의 "잘된 것" 으로 넣는다.
 *    숫자는 모두 집계값이고 AI 가 만들지 않는다.
 */

const DAY = 86_400_000;
/** 성과를 보는 기간(일) */
export const CONTENT_OUTCOME_WINDOW_DAYS = 90;
/** "잘된 것" 을 프롬프트에 넣는 최소 게시 건수 */
export const CONTENT_WIN_MIN_PUBLISHED = 10;
/** 약정 유지 판단: 약정 뒤 일수 · 성공 출금 횟수 */
export const RETAINED_PLEDGE_DAYS = 90;
export const RETAINED_PLEDGE_MIN_SUCCESS = 2;

export type ContentTopic = 'CAMPAIGN' | 'VOLUNTEER' | 'OTHER';
export const CONTENT_TOPIC_LABEL: Record<ContentTopic, string> = { CAMPAIGN: '캠페인', VOLUNTEER: '봉사 모집', OTHER: '기타' };

export type FirstLineBucket = 'SHORT' | 'MEDIUM' | 'LONG';
export const FIRST_LINE_LABEL: Record<FirstLineBucket, string> = { SHORT: '20자 이하', MEDIUM: '21~40자', LONG: '41자 이상' };

const KIND_SHORT: Record<ContentKind, string> = { SHORTFORM: '숏폼', IMAGE_SQUARE: '정사각 이미지', IMAGE_STORY: '스토리 이미지', CARD_NEWS: '카드뉴스', IMAGE_FEED: '피드 이미지' };

export function firstLineBucket(caption: string | null | undefined): FirstLineBucket {
  const first = (caption ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const n = [...first].length;
  return n <= 20 ? 'SHORT' : n <= 40 ? 'MEDIUM' : 'LONG';
}

export function topicOf(item: { postingId: string | null; campaignId: string | null }): ContentTopic {
  if (item.postingId) return 'VOLUNTEER';
  if (item.campaignId) return 'CAMPAIGN';
  return 'OTHER';
}

export interface ContentOutcome {
  itemId: string;
  title: string;
  kind: ContentKind;
  topic: ContentTopic;
  firstLine: FirstLineBucket;
  variantGroupId: string | null;
  variantLabel: string | null;
  publishes: number;
  firstPublishedAt: Date | null;
  weekday: number | null;
  hour: number | null;
  clicks: number;
  donations: number;
  amount: bigint;
  newPledges: number;
  retainedPledges: number;
  volunteers: number;
}

export interface ContentOutcomeReport {
  since: Date;
  items: ContentOutcome[];
  /** 기간 안 결제 건 중 콘텐츠로 확인되지 않은 것(배정하지 않음) */
  unattributed: { donations: number; amount: bigint };
  /** 기간 안 결제 건 중 콘텐츠로 확인된 것 */
  attributed: { donations: number; amount: bigint };
}

/**
 * 기관의 콘텐츠별 성과. 대상 = 기간 안에 게시된(게시됨·비공개 업로드) 콘텐츠.
 * 후원 건수·금액은 일시 후원 결제 건(정기 출금 제외 — 정기는 약정으로 센다), 테스트 결제 제외.
 */
export async function contentOutcomes(merchantId: string, opts: { now?: Date; days?: number } = {}): Promise<ContentOutcomeReport> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? CONTENT_OUTCOME_WINDOW_DAYS) * DAY);
  const publishes = await prisma.contentPublish.findMany({
    where: { item: { merchantId }, status: { in: ['PUBLISHED', 'PRIVATE_UPLOADED'] }, publishedAt: { gte: since, lte: now } },
    select: { itemId: true, publishedAt: true, clicks: true },
  });
  const itemIds = [...new Set(publishes.map((p) => p.itemId))];
  const [items, allPublishes, charges, pledges, vols, unattributed, attributedSum] = await Promise.all([
    itemIds.length
      ? prisma.contentItem.findMany({ where: { id: { in: itemIds }, merchantId }, select: { id: true, title: true, kind: true, caption: true, postingId: true, campaignId: true, variantGroupId: true, variantLabel: true } })
      : Promise.resolve([]),
    // 클릭은 그 콘텐츠의 모든 게시 행 합(기간 밖에 다시 올린 게시도 같은 콘텐츠)
    itemIds.length ? prisma.contentPublish.findMany({ where: { itemId: { in: itemIds } }, select: { itemId: true, clicks: true, status: true, publishedAt: true } }) : Promise.resolve([]),
    itemIds.length
      ? prisma.charge.groupBy({
          by: ['contentItemId'],
          where: { merchantId, contentItemId: { in: itemIds }, status: { in: PAID_STATUSES }, recurringId: null, isTest: false },
          _sum: { amount: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    itemIds.length
      ? prisma.recurringDonation.findMany({ where: { merchantId, contentItemId: { in: itemIds } }, select: { id: true, contentItemId: true, status: true, createdAt: true } })
      : Promise.resolve([]),
    itemIds.length ? prisma.volunteerApplication.groupBy({ by: ['contentItemId'], where: { merchantId, contentItemId: { in: itemIds } }, _count: { _all: true } }) : Promise.resolve([]),
    prisma.charge.aggregate({
      where: { merchantId, contentItemId: null, status: { in: PAID_STATUSES }, recurringId: null, isTest: false, paidAt: { gte: since, lte: now } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.charge.aggregate({
      where: { merchantId, contentItemId: { not: null }, status: { in: PAID_STATUSES }, recurringId: null, isTest: false, paidAt: { gte: since, lte: now } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  // 유지 약정: 약정 90일이 지났고 지금 ACTIVE 이며 성공 출금(recurring_run SUCCESS)이 2회 이상
  const oldEnough = pledges.filter((p) => p.status === 'ACTIVE' && p.createdAt.getTime() <= now.getTime() - RETAINED_PLEDGE_DAYS * DAY);
  const successRuns = oldEnough.length
    ? await prisma.recurringRun.groupBy({ by: ['recurringId'], where: { recurringId: { in: oldEnough.map((p) => p.id) }, status: 'SUCCESS' }, _count: { _all: true } })
    : [];
  const successBy = new Map(successRuns.map((r) => [r.recurringId, r._count._all]));

  const out: ContentOutcome[] = items.map((it) => {
    const pubs = allPublishes.filter((p) => p.itemId === it.id);
    const live = pubs.filter((p) => p.publishedAt && ['PUBLISHED', 'PRIVATE_UPLOADED'].includes(p.status)).sort((a, b) => a.publishedAt!.getTime() - b.publishedAt!.getTime());
    const first = live[0]?.publishedAt ?? null;
    const wh = first ? kstWeekdayHour(first) : null;
    const ch = charges.find((c) => c.contentItemId === it.id);
    const mine = pledges.filter((p) => p.contentItemId === it.id);
    return {
      itemId: it.id,
      title: it.title,
      kind: it.kind,
      topic: topicOf(it),
      firstLine: firstLineBucket(it.caption),
      variantGroupId: it.variantGroupId,
      variantLabel: it.variantLabel,
      publishes: live.length,
      firstPublishedAt: first,
      weekday: wh?.weekday ?? null,
      hour: wh?.hour ?? null,
      clicks: pubs.reduce((a, p) => a + p.clicks, 0),
      donations: ch?._count._all ?? 0,
      amount: ch?._sum.amount ?? 0n,
      newPledges: mine.length,
      retainedPledges: mine.filter((p) => (successBy.get(p.id) ?? 0) >= RETAINED_PLEDGE_MIN_SUCCESS && oldEnough.some((o) => o.id === p.id)).length,
      volunteers: vols.find((v) => v.contentItemId === it.id)?._count._all ?? 0,
    };
  });
  return {
    since,
    items: out,
    unattributed: { donations: unattributed._count._all, amount: unattributed._sum.amount ?? 0n },
    attributed: { donations: attributedSum._count._all, amount: attributedSum._sum.amount ?? 0n },
  };
}

export interface OutcomeBucket {
  key: string;
  label: string;
  items: number;
  clicks: number;
  donations: number;
  amount: bigint;
  pledges: number;
  /** 평균 클릭 */
  avgClicks: number;
  /** 클릭 대비 후원 전환(%) */
  conversion: number | null;
}

function bucketize(items: ContentOutcome[], keyOf: (o: ContentOutcome) => string | null, labelOf: (k: string) => string): OutcomeBucket[] {
  const m = new Map<string, OutcomeBucket>();
  for (const o of items) {
    const k = keyOf(o);
    if (k === null) continue;
    const b = m.get(k) ?? { key: k, label: labelOf(k), items: 0, clicks: 0, donations: 0, amount: 0n, pledges: 0, avgClicks: 0, conversion: null };
    b.items += 1;
    b.clicks += o.clicks;
    b.donations += o.donations;
    b.amount += o.amount;
    b.pledges += o.newPledges;
    m.set(k, b);
  }
  for (const b of m.values()) {
    b.avgClicks = b.items ? Math.round((b.clicks / b.items) * 10) / 10 : 0;
    b.conversion = b.clicks > 0 ? Math.round(((b.donations + b.pledges) / b.clicks) * 1000) / 10 : null;
  }
  return [...m.values()].sort((a, b) => b.avgClicks - a.avgClicks || b.donations - a.donations || a.key.localeCompare(b.key));
}

export function outcomeBreakdown(items: ContentOutcome[]) {
  return {
    byKind: bucketize(items, (o) => o.kind, (k) => KIND_SHORT[k as ContentKind] ?? k),
    byWeekday: bucketize(items, (o) => (o.weekday === null ? null : String(o.weekday)), (k) => `${WEEKDAY_KO[Number(k)]}요일`),
    byHour: bucketize(items, (o) => (o.hour === null ? null : String(o.hour).padStart(2, '0')), (k) => `${k}시`),
    byTopic: bucketize(items, (o) => o.topic, (k) => CONTENT_TOPIC_LABEL[k as ContentTopic] ?? k),
    byFirstLine: bucketize(items, (o) => o.firstLine, (k) => FIRST_LINE_LABEL[k as FirstLineBucket] ?? k),
  };
}

/** 상위 콘텐츠: 후원액 → 후원·약정 건수 → 클릭 순 */
export function topOutcomes(items: ContentOutcome[], n = 5): ContentOutcome[] {
  return [...items]
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0) || b.donations + b.newPledges - (a.donations + a.newPledges) || b.clicks - a.clicks)
    .slice(0, n);
}

/** 버킷이 둘 이상이고 가장 좋은 쪽이 2건 이상일 때만 의미 있는 비교로 본다 */
export function bestBucket(list: OutcomeBucket[]): OutcomeBucket | null {
  if (list.length < 2) return null;
  const top = list[0]!;
  if (top.items < 2 || top.clicks === 0) return null;
  return top.avgClicks > list[1]!.avgClicks ? top : null;
}

/**
 * 최근 90일 성과 상위 요소 → "잘된 것" 문장(최대 5개). 게시 10건 미만이면 빈 배열(넣지 않는다).
 * 숫자는 집계값만 쓴다. 개인정보·후원자 이름 없음.
 */
export function winHintsFrom(items: ContentOutcome[]): string[] {
  if (items.length < CONTENT_WIN_MIN_PUBLISHED) return [];
  const b = outcomeBreakdown(items);
  const out: string[] = [];
  const k = bestBucket(b.byKind);
  if (k) out.push(`형식: ${k.label} 게시물의 평균 클릭이 가장 높았음(평균 ${k.avgClicks}회)`);
  const w = bestBucket(b.byWeekday);
  const h = bestBucket(b.byHour);
  if (w && h) out.push(`게시 시점: ${w.label} · ${h.label} 게시의 클릭이 가장 높았음`);
  else if (w) out.push(`게시 요일: ${w.label} 게시의 클릭이 가장 높았음`);
  const t = bestBucket(b.byTopic);
  if (t) out.push(`주제: ${t.label} 이야기의 평균 클릭이 가장 높았음`);
  const f = bestBucket(b.byFirstLine);
  if (f) out.push(`첫 문장 길이: ${f.label}인 게시물의 클릭이 가장 높았음`);
  const conv = [...b.byKind].filter((x) => x.donations + x.pledges > 0).sort((a, c) => c.donations + c.pledges - (a.donations + a.pledges))[0];
  if (conv && b.byKind.length > 1) out.push(`후원 전환: ${conv.label} 게시물에서 후원·약정이 가장 많이 들어왔음(${conv.donations + conv.pledges}건)`);
  return out.slice(0, 5);
}

/**
 * 콘텐츠 생성 때 프롬프트에 넣을 "잘된 것". 계산 결과를 ai_cache(content_wins, KST 날짜)에 남겨 화면이 보여 준다
 * (mock 이면 프롬프트에 쓰이지 않고 저장·표시만). 실패해도 생성을 막지 않는다(빈 배열).
 */
export async function contentWinHints(merchantId: string, now = new Date()): Promise<string[]> {
  try {
    const report = await contentOutcomes(merchantId, { now });
    const hints = winHintsFrom(report.items);
    await prisma.aiCache
      .createMany({ data: [{ id: newId(), merchantId, feature: 'content_wins', cacheKey: kstDateKey(now), result: { hints, published: report.items.length, at: now.toISOString() } }], skipDuplicates: true })
      .catch(() => undefined);
    return hints;
  } catch (e) {
    logger.warn('콘텐츠 성과 요약 실패 — 잘된 것 없이 만듭니다', { merchantId, message: (e as Error).message });
    return [];
  }
}

export async function latestWinHints(merchantId: string): Promise<{ hints: string[]; published: number; at: string } | null> {
  const row = await prisma.aiCache.findFirst({ where: { merchantId, feature: 'content_wins' }, orderBy: { createdAt: 'desc' } });
  return row ? (row.result as unknown as { hints: string[]; published: number; at: string }) : null;
}

export interface VariantComparison {
  groupId: string;
  title: string;
  a: ContentOutcome | null;
  b: ContentOutcome | null;
}

/** 2안 비교 결과(두 안 중 하나라도 게시된 묶음) */
export function variantComparisons(items: ContentOutcome[]): VariantComparison[] {
  const groups = new Map<string, VariantComparison>();
  for (const o of items) {
    if (!o.variantGroupId || !o.variantLabel) continue;
    const g = groups.get(o.variantGroupId) ?? { groupId: o.variantGroupId, title: o.title, a: null, b: null };
    if (o.variantLabel === 'A') g.a = o;
    else if (o.variantLabel === 'B') g.b = o;
    groups.set(o.variantGroupId, g);
  }
  return [...groups.values()];
}
