import { prisma, withAdvisoryLock } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { featureContentEnabled } from '@/lib/env';
import { kstStartOfDay } from '@/lib/datetime';
import {
  CONTENT_BATCH_MAX,
  CONTENT_REJECT_REASON_LABEL,
  CONTENT_REJECT_REASONS,
  CONTENT_REVISION_MAX_LEN,
  CONTENT_REVISIONS_PER_DAY,
  type ContentRejectReason,
} from '@/lib/content-review';
import { personalInfoHit, realNameHit } from '@/server/adapters/content/llm-script';
import { PLATFORM_KINDS, PLATFORM_LABEL, PLATFORMS } from '@/server/adapters/sns';
import type { ContentItem, SocialPlatform } from '@/generated/prisma/client';
import { captionProblem, postToText } from './content-captions';
import { maskForLlm } from './ai-drafts';
import {
  approveContent,
  ContentError,
  contentDraftViolation,
  getContentSetting,
  monthlyUsage,
  renderPlatformPost,
  runContentPipeline,
  type PastSlotChoice,
  type Scene,
} from './content';
import { KST_OFFSET_MS } from './content-calendar';

/**
 * 콘텐츠 승인 편의 (2026-11-09 B2 — 대표 결정: 자동 작성 + 항상 사람 승인 후 게시).
 *
 *  - 주간 묶음 승인(/studio/content/review): 이번 주·다음 주(월~일, KST) 검토 대기를 날짜별로. 일괄 승인은 항목마다
 *    기존 단건 승인(approveContent — 조건부 갱신)을 부른다. 승인할 수 없는 항목은 건너뛰고 이유를 돌려준다.
 *  - 반려(이유 분류 + 메모)·수정 요청(한 줄 → 같은 캠페인·형식·슬롯으로 새 판, 이전 판은 보관). 이유는 content_feedback 에 쌓여
 *    다음 생성 때 LLM 프롬프트 "피해야 할 것" 에 들어간다(contentAvoidHints). 메모·요청은 가린 값만 저장하고 실명은 거절한다.
 *  - 사전 점검: 이미 있는 검사(contentDraftViolation · captionProblem · 실명/연락처 패턴)를 그대로 불러 목록으로 보여 준다.
 *  - 알림: 월요일 09시(KST) 그 주 검토 대기 건수, 게시 시각 하루 전·3시간 전 미승인(같은 슬롯·같은 시점 1회 — content_review_alert 키).
 */

// ---------------------------------------------------------------------------
// 주 (월~일, KST)
// ---------------------------------------------------------------------------

/** now 가 속한 주의 월요일 00:00(KST)을 UTC Date 로 */
export function kstWeekStart(now = new Date()): Date {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  const back = (k.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - back) - KST_OFFSET_MS);
}

function kstDayKey(d: Date) {
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 콘텐츠의 게시 예정 시각 — 캘린더 슬롯이면 슬롯 시각, 아니면 없음 */
export interface ReviewEntry {
  item: ContentItem;
  slotAt: Date | null;
  /** 날짜 묶음 기준(슬롯 시각 · 없으면 만든 시각) */
  dayAt: Date;
  /** 슬롯 시각이 지났는데 아직 승인 전 */
  pastDue: boolean;
}

export async function reviewEntries(merchantId: string, now = new Date()): Promise<ReviewEntry[]> {
  const items = await prisma.contentItem.findMany({ where: { merchantId, status: 'REVIEW' }, orderBy: { createdAt: 'asc' }, take: 200 });
  if (items.length === 0) return [];
  const slots = await prisma.contentSlot.findMany({ where: { merchantId, itemId: { in: items.map((i) => i.id) } }, select: { itemId: true, slotAt: true } });
  const slotBy = new Map(slots.map((s) => [s.itemId!, s.slotAt]));
  return items
    .map((item) => {
      const slotAt = slotBy.get(item.id) ?? null;
      return { item, slotAt, dayAt: slotAt ?? item.createdAt, pastDue: Boolean(slotAt && slotAt.getTime() <= now.getTime()) };
    })
    .sort((a, b) => a.dayAt.getTime() - b.dayAt.getTime());
}

export interface ReviewWeek {
  key: 'THIS' | 'NEXT';
  start: Date;
  end: Date;
  days: Array<{ dayKey: string; entries: ReviewEntry[] }>;
  count: number;
}

/**
 * 이번 주·다음 주 묶음. 이번 주에는 지난 주 이전(게시 시각이 지났거나 오래 기다린 것)도 함께 넣는다 — 놓치는 건이 없게.
 * 다음 주 뒤의 건은 later 로 센다.
 */
export async function reviewWeeks(merchantId: string, now = new Date()): Promise<{ weeks: ReviewWeek[]; later: number; total: number }> {
  const entries = await reviewEntries(merchantId, now);
  const thisStart = kstWeekStart(now);
  const nextStart = new Date(thisStart.getTime() + 7 * 86_400_000);
  const afterNext = new Date(nextStart.getTime() + 7 * 86_400_000);
  const group = (list: ReviewEntry[]) => {
    const m = new Map<string, ReviewEntry[]>();
    for (const e of list) {
      const k = kstDayKey(e.dayAt);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return [...m.entries()].map(([dayKey, es]) => ({ dayKey, entries: es }));
  };
  const thisList = entries.filter((e) => e.dayAt < nextStart);
  const nextList = entries.filter((e) => e.dayAt >= nextStart && e.dayAt < afterNext);
  return {
    weeks: [
      { key: 'THIS', start: thisStart, end: nextStart, days: group(thisList), count: thisList.length },
      { key: 'NEXT', start: nextStart, end: afterNext, days: group(nextList), count: nextList.length },
    ],
    later: entries.length - thisList.length - nextList.length,
    total: entries.length,
  };
}

// ---------------------------------------------------------------------------
// 사전 점검 (이미 있는 검사를 그대로 부른다)
// ---------------------------------------------------------------------------

export interface PrecheckRow {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** 승인을 막는 항목인지(approveContent 가 거절한다) */
  blocking?: boolean;
}

/** 게시 대상 플랫폼: 캘린더 설정 플랫폼 중 형식 허용, 없으면 형식 허용 플랫폼 전부 */
function precheckPlatforms(kind: ContentItem['kind'], configured: SocialPlatform[]): SocialPlatform[] {
  const allowed = PLATFORMS.filter((p) => PLATFORM_KINDS[p].includes(kind));
  const pick = configured.filter((p) => allowed.includes(p));
  return pick.length ? pick : allowed;
}

export function contentPlatformsFor(kind: ContentItem['kind'], configured: SocialPlatform[]) {
  return precheckPlatforms(kind, configured);
}

export async function contentPrecheck(item: ContentItem, setting?: { bannedWords: string[]; platforms: SocialPlatform[] }): Promise<PrecheckRow[]> {
  const s = setting ?? (await getContentSetting(item.merchantId));
  const scenes = ((item.scenes as unknown as Scene[]) ?? []).filter(Boolean);
  const captions = scenes.map((x) => x.caption ?? '');
  const caption = item.caption ?? '';
  const stored = item.platformCaptions && typeof item.platformCaptions === 'object' ? Object.values(item.platformCaptions as Record<string, { text?: string; title?: string | null }>) : [];
  const platformTexts = stored.filter((p) => p && typeof p.text === 'string').map((p) => postToText({ title: p.title ?? null, text: p.text! }));
  const all = [...captions, caption, ...platformTexts].join('\n');
  const rows: PrecheckRow[] = [];

  const pi = personalInfoHit(all);
  const name = realNameHit(all);
  rows.push({
    key: 'PRIVACY',
    label: '실명·연락처',
    ok: !pi && !name,
    detail: name ? '수혜자 실명으로 보이는 표현이 있습니다(예: 성+이름+호칭). 확인해 주세요.' : pi ? `${pi}가 들어 있습니다.` : '실명·전화번호·이메일·주민번호 패턴이 없습니다.',
  });

  // 수혜자 실사진 금지: 장면 그림은 서버가 그린 그림이고, 들어가는 이미지는 기관 정보에 올린 기관 로고 하나뿐이다.
  const imageCounts = scenes.map((x) => (x.svg?.match(/<image\b/g) ?? []).length);
  const photoOk = imageCounts.every((n) => n <= 1);
  rows.push({
    key: 'PHOTO',
    label: '사진(수혜자 실사진 금지)',
    ok: photoOk,
    detail: photoOk
      ? imageCounts.some((n) => n === 1)
        ? '시스템이 그린 그림과 기관이 올린 기관 로고만 씁니다(실사진·얼굴 없음).'
        : '시스템이 그린 그림만 씁니다(실사진·얼굴 없음).'
      : '장면에 기관 로고 외의 이미지가 들어 있습니다. 수혜자 사진이 아닌지 확인해 주세요.',
  });

  rows.push({
    key: 'REG_NO',
    label: '모집등록번호',
    ok: item.regNoIncluded,
    blocking: true,
    detail: item.regNoIncluded ? '기부금품 모집등록번호가 들어 있습니다.' : '모집등록번호가 없어 승인할 수 없습니다. 기관 정보에 넣고 다시 만들어 주세요.',
  });

  const draft = contentDraftViolation({ bannedWords: s.bannedWords, captions, caption, hashtags: item.hashtags, platformCaptions: platformTexts });
  rows.push({
    key: 'DRAFT',
    label: '금지어·자막 길이·링크·AI 표시',
    ok: !draft && item.aiLabeled,
    blocking: !item.aiLabeled,
    detail: !item.aiLabeled ? 'AI 생성 표시가 없어 승인할 수 없습니다.' : draft ?? '금지어 없음 · 자막 120자 이내 · 후원 링크와 "AI 생성 콘텐츠" 표시가 있습니다.',
  });

  for (const p of precheckPlatforms(item.kind, s.platforms)) {
    let problem: string | null = null;
    try {
      problem = captionProblem(p, await renderPlatformPost(item, p));
    } catch (e) {
      problem = (e as Error).message;
    }
    rows.push({ key: `CAPTION:${p}`, label: `${PLATFORM_LABEL[p]} 캡션 길이`, ok: !problem, detail: problem ?? '플랫폼 글자 수 안에 들어갑니다(링크·AI 표시 포함).' });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 일괄 승인 · 반려 · 수정 요청
// ---------------------------------------------------------------------------

export interface BatchApproveResult {
  approved: Array<{ id: string; title: string }>;
  skipped: Array<{ id: string; title: string; reason: string }>;
}

/** 일괄 승인. 항목마다 기존 단건 승인 함수로 처리한다(조건부 갱신 — 두 사람이 눌러도 한 번). */
export async function approveContentBatch(merchantId: string, ids: string[], userId: string, opts: { whenPast?: PastSlotChoice; now?: Date } = {}): Promise<BatchApproveResult> {
  const unique = [...new Set(ids.map((i) => i.trim()).filter(Boolean))];
  if (unique.length === 0) throw new ContentError('승인할 콘텐츠를 골라 주세요.');
  if (unique.length > CONTENT_BATCH_MAX) throw new ContentError(`한 번에 ${CONTENT_BATCH_MAX}건까지 승인할 수 있습니다.`);
  const titles = new Map(
    (await prisma.contentItem.findMany({ where: { merchantId, id: { in: unique } }, select: { id: true, title: true } })).map((r) => [r.id, r.title]),
  );
  const out: BatchApproveResult = { approved: [], skipped: [] };
  for (const id of unique) {
    const title = titles.get(id) ?? '콘텐츠';
    try {
      await approveContent(merchantId, id, userId, opts);
      out.approved.push({ id, title });
    } catch (e) {
      if (!(e instanceof ContentError)) logger.error('일괄 승인 중 오류', { itemId: id, message: (e as Error).message });
      out.skipped.push({ id, title, reason: e instanceof ContentError ? e.message : '처리 중 오류가 발생했습니다.' });
    }
  }
  return out;
}

/** 메모·수정 요청 한 줄 검사 + 가리기. 실명 패턴은 거절한다(가려서 넘기지 않는다). */
export function cleanReviewNote(raw: string | null | undefined, opts: { required?: boolean; max?: number } = {}): string | null {
  const max = opts.max ?? 200;
  const v = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!v) {
    if (opts.required) throw new ContentError('내용을 적어 주세요.');
    return null;
  }
  if (v.length > max) throw new ContentError(`${max}자 이내로 적어 주세요.`);
  if (realNameHit(v)) throw new ContentError('수혜자 실명으로 보이는 표현은 적을 수 없습니다. "김OO 어르신" 처럼 가려서 적어 주세요.');
  const pi = personalInfoHit(v);
  if (pi) throw new ContentError(`${pi}는 적을 수 없습니다.`);
  return maskForLlm(v);
}

export async function rejectContent(merchantId: string, id: string, userId: string, input: { reasonCode: string; note?: string | null }) {
  if (!CONTENT_REJECT_REASONS.includes(input.reasonCode as ContentRejectReason)) throw new ContentError('반려 이유를 골라 주세요.');
  const code = input.reasonCode as ContentRejectReason;
  const note = cleanReviewNote(input.note, { max: 200 });
  const item = await prisma.contentItem.findFirst({ where: { id, merchantId }, select: { id: true } });
  if (!item) throw new ContentError('콘텐츠를 찾을 수 없습니다.');
  const label = CONTENT_REJECT_REASON_LABEL[code];
  await prisma.$transaction(async (tx) => {
    // 검토 대기일 때만 — 동시에 승인·반려가 겹치면 먼저 잡은 쪽만 반영된다.
    const r = await tx.contentItem.updateMany({
      where: { id, merchantId, status: 'REVIEW' },
      data: { status: 'ARCHIVED', error: `반려: ${label}${note ? ` — ${note}` : ''}`.slice(0, 300) },
    });
    if (r.count === 0) throw new ContentError('검토 대기 중인 콘텐츠만 반려할 수 있습니다(이미 처리됨).');
    await tx.contentSlot.updateMany({ where: { merchantId, itemId: id }, data: { status: 'ARCHIVED', note: `반려됨 — ${label}` } });
    await tx.contentFeedback.create({ data: { id: newId(), merchantId, itemId: id, kind: 'REJECT', reasonCode: code, note, createdBy: userId } });
  });
  // 2안 비교에서 한쪽을 반려하면 승인된 다른 안만 진행한다(2026-11-11 G). 실패해도 반려 결과는 그대로.
  await (await import('./content-variants')).afterVariantDecision(id);
}

/** 콘텐츠(수정 요청 판 묶음)의 오늘(KST) 수정 요청 횟수 */
export async function revisionsToday(rootId: string, now = new Date()) {
  return prisma.contentItem.count({ where: { revisionRootId: rootId, createdAt: { gte: kstStartOfDay(now) } } });
}

/**
 * 수정 요청 한 줄 → 같은 캠페인·형식·슬롯으로 새 판을 만들고 다시 검토 대기로. 이전 판은 보관(ARCHIVED)으로 남는다.
 * LLM 공급자면 요청이 프롬프트에 들어가고, mock 이면 요청은 메모(revision_request)로만 남는다(화면에 "AI 공급자 연결 후 문장 반영").
 * 콘텐츠당 하루 CONTENT_REVISIONS_PER_DAY 회. 판 묶음 단위 advisory lock 으로 동시 요청도 한 번만 통과한다.
 */
export async function requestContentRevision(merchantId: string, id: string, userId: string, line: string, now = new Date()) {
  if (!featureContentEnabled()) throw new ContentError('콘텐츠 자동 생성을 사용하지 않는 중입니다.');
  const request = cleanReviewNote(line, { required: true, max: CONTENT_REVISION_MAX_LEN })!;
  if (request.length < 2) throw new ContentError('수정 요청을 조금 더 구체적으로 적어 주세요.');
  const old = await prisma.contentItem.findFirst({ where: { id, merchantId } });
  if (!old) throw new ContentError('콘텐츠를 찾을 수 없습니다.');
  if (!['REVIEW', 'APPROVED'].includes(old.status)) throw new ContentError('검토 대기·승인 상태(게시 예약 전)의 콘텐츠만 수정 요청할 수 있습니다.');
  if (!old.campaignId) throw new ContentError('캠페인이 없는 콘텐츠입니다.');
  const setting = await getContentSetting(merchantId);
  const usage = await monthlyUsage(merchantId, now);
  if (usage.count >= setting.monthlyLimit) throw new ContentError(`이번 달 생성 한도(${setting.monthlyLimit}건)를 모두 썼습니다.`);
  const rootId = old.revisionRootId ?? old.id;
  const freshId = newId();

  await prisma.$transaction(async (tx) => {
    await withAdvisoryLock(tx, `content-revision:${rootId}`, async () => {
      const today = await tx.contentItem.count({ where: { revisionRootId: rootId, createdAt: { gte: kstStartOfDay(now) } } });
      if (today >= CONTENT_REVISIONS_PER_DAY) throw new ContentError(`수정 요청은 콘텐츠당 하루 ${CONTENT_REVISIONS_PER_DAY}회까지입니다. 내일 다시 요청하거나 직접 고쳐 주세요.`);
      const archived = await tx.contentItem.updateMany({ where: { id: old.id, merchantId, status: { in: ['REVIEW', 'APPROVED'] } }, data: { status: 'ARCHIVED', error: `수정 요청으로 새 판을 만들었습니다: ${request}`.slice(0, 300) } });
      if (archived.count === 0) throw new ContentError('이미 다른 담당자가 처리한 콘텐츠입니다.');
      await tx.contentItem.create({
        data: {
          id: freshId,
          merchantId,
          campaignId: old.campaignId,
          postingId: old.postingId,
          kind: old.kind,
          status: 'GENERATING',
          title: old.title,
          provider: old.provider,
          createdBy: userId,
          revisionOf: old.id,
          revisionRootId: rootId,
          revisionRequest: request,
          // 2안 비교 묶음은 새 판이 이어받는다(2026-11-11 G)
          variantGroupId: old.variantGroupId,
          variantLabel: old.variantLabel,
        },
      });
      await tx.contentSlot.updateMany({ where: { merchantId, itemId: old.id }, data: { itemId: freshId, status: 'GENERATING', note: '수정 요청으로 다시 만드는 중' } });
      await tx.contentFeedback.create({ data: { id: newId(), merchantId, itemId: old.id, kind: 'REVISE', reasonCode: null, note: request, createdBy: userId } });
    });
  });

  await runContentPipeline(freshId);
  const fresh = await prisma.contentItem.findUniqueOrThrow({ where: { id: freshId } });
  await prisma.contentSlot
    .updateMany({
      where: { merchantId, itemId: freshId },
      data: { status: fresh.status === 'REVIEW' ? 'REVIEW' : fresh.status === 'FAILED' ? 'FAILED' : fresh.status, note: fresh.status === 'FAILED' ? (fresh.error ?? '생성 실패').slice(0, 300) : '수정 요청 판 — 검토 대기' },
    })
    .catch(() => undefined);
  return fresh;
}

// ---------------------------------------------------------------------------
// 알림 (배치 content-review, 15분)
// ---------------------------------------------------------------------------

export const REVIEW_DUE_WINDOWS = [
  { kind: 'DUE_3H' as const, prefix: 'due3', ms: 3 * 3600_000, label: '3시간' },
  { kind: 'DUE_24H' as const, prefix: 'due24', ms: 24 * 3600_000, label: '하루' },
];

async function notifyOnce(input: { dedupeKey: string; merchantId: string; kind: string; itemId?: string | null; userId: string; title: string; body: string; linkUrl: string }) {
  try {
    await prisma.$transaction([
      prisma.contentReviewAlert.create({ data: { dedupeKey: input.dedupeKey, merchantId: input.merchantId, kind: input.kind, itemId: input.itemId ?? null } }),
      prisma.notification.create({ data: { id: newId(), userId: input.userId, channel: 'IN_APP', title: input.title.slice(0, 120), body: input.body.slice(0, 500), linkUrl: input.linkUrl } }),
    ]);
    return true;
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') return false;
    throw e;
  }
}

/**
 * 콘텐츠 승인 알림. 기관 담당자에게 콘솔 알림만 보낸다(기관 담당자 문자·알림톡 정보성 경로가 아직 없다).
 *  - 월요일(KST) 09시 이후 첫 실행: 그 주(지난 대기 포함) 검토 대기 N건 — 기관·주 1회.
 *  - 슬롯 게시 시각 3시간 안 / 하루 안의 미승인 — (콘텐츠, 슬롯 시각, 시점) 1회. 3시간 안이면 3시간 알림만.
 */
export async function runContentReviewAlerts(now = new Date()) {
  const result = { weekly: 0, due24: 0, due3: 0 };
  if (!featureContentEnabled()) return result;
  const userOf = new Map<string, string | null>();
  const merchantUser = async (merchantId: string) => {
    if (!userOf.has(merchantId)) {
      const m = await prisma.merchantProfile.findFirst({ where: { id: merchantId, status: 'APPROVED' }, select: { userId: true } });
      userOf.set(merchantId, m?.userId ?? null);
    }
    return userOf.get(merchantId) ?? null;
  };

  const k = new Date(now.getTime() + KST_OFFSET_MS);
  if (k.getUTCDay() === 1 && k.getUTCHours() >= 9) {
    const weekStart = kstWeekStart(now);
    const weekKey = kstDayKey(weekStart);
    const merchants = await prisma.contentItem.groupBy({ by: ['merchantId'], where: { status: 'REVIEW' }, _count: { _all: true } });
    for (const m of merchants) {
      const userId = await merchantUser(m.merchantId);
      if (!userId) continue;
      const { weeks } = await reviewWeeks(m.merchantId, now);
      const n = weeks[0]!.count;
      if (n === 0) continue;
      const sent = await notifyOnce({
        dedupeKey: `weekly:${m.merchantId}:${weekKey}`, merchantId: m.merchantId, kind: 'WEEKLY', userId,
        title: `이번 주 콘텐츠 ${n}건 승인을 기다립니다`,
        body: '콘텐츠는 담당자가 승인해야 게시됩니다. 주간 승인 화면에서 한 번에 확인해 주세요.',
        linkUrl: '/studio/content/review',
      });
      if (sent) result.weekly += 1;
    }
  }

  const horizon = new Date(now.getTime() + 24 * 3600_000);
  const slots = await prisma.contentSlot.findMany({ where: { slotAt: { gt: now, lte: horizon }, itemId: { not: null } }, select: { merchantId: true, slotAt: true, itemId: true }, take: 500 });
  if (slots.length) {
    const pending = new Map(
      (await prisma.contentItem.findMany({ where: { id: { in: slots.map((s) => s.itemId!) }, status: 'REVIEW' }, select: { id: true, title: true } })).map((i) => [i.id, i.title]),
    );
    for (const s of slots) {
      const title = pending.get(s.itemId!);
      if (title === undefined) continue;
      const userId = await merchantUser(s.merchantId);
      if (!userId) continue;
      const left = s.slotAt.getTime() - now.getTime();
      const w = REVIEW_DUE_WINDOWS.find((x) => left <= x.ms)!;
      const sent = await notifyOnce({
        dedupeKey: `${w.prefix}:${s.itemId}:${s.slotAt.getTime()}`, merchantId: s.merchantId, kind: w.kind, itemId: s.itemId, userId,
        title: `게시 ${w.label} 전 — 아직 승인되지 않은 콘텐츠`,
        body: `${title} 콘텐츠가 승인 전입니다. 승인하지 않으면 게시되지 않습니다.`,
        linkUrl: `/studio/content/${s.itemId}`,
      });
      if (sent) result[w.kind === 'DUE_3H' ? 'due3' : 'due24'] += 1;
    }
  }
  return result;
}
