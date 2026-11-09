import { prisma } from '@/server/db';
import { featureContentEnabled } from '@/lib/env';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import type { ContentKind } from '@/generated/prisma/enums';
import { campaignStats } from './fundraising';
import { ContentError, getContentSetting, monthlyUsage, requestContent } from './content';

/**
 * 콘텐츠 캘린더 — 기관이 정한 요일·시각(KST)마다 콘텐츠를 스스로 만든다.
 *
 *  - 슬롯 = (요일, 게시 시각). 앞으로 7일 안의 슬롯 중 아직 콘텐츠가 없는 가장 가까운 것 하나를 배치 1회에 만든다.
 *  - (기관, 슬롯 시각) 유니크(content_slot) — 겹쳐 도는 배치도 같은 슬롯을 두 번 만들지 않는다.
 *  - 만들지 않는 경우: 캘린더 꺼짐 · 모집등록번호 없음 · 진행 중(ACTIVE·기간 내) 캠페인 없음 · 월 한도 소진.
 *    이유는 행으로 남기지 않는다(조건이 풀리면 다음 배치가 만든다). 설정 화면이 같은 함수로 이유를 보여 준다.
 *  - 캠페인은 돌아가며 고른다: 최근 14일 캘린더 사용 횟수가 적은 것 → 진행률 낮고 마감 가까운 것.
 *  - 형식은 설정 목록을 슬롯 순서대로 돌린다(비우면 숏폼·카드뉴스).
 *  - 자동 승인은 없다(2026-11-09). 담당자가 승인하는 순간(슬롯이 아직 미래이고 자동 예약이 켜져 있을 때) 그 시각으로 예약한다.
 *    슬롯이 지난 뒤 승인하면 담당자가 다음 빈 슬롯 / 지금 / 승인만 중에서 고른다(content.ts approveContent).
 *    검토 대기 콘텐츠는 콘텐츠 화면·통합 승인 대기함이 content_item 상태에서 직접 모은다.
 */

export const KST_OFFSET_MS = 9 * 3600_000;
export const CALENDAR_LOOKAHEAD_DAYS = 7;
export const DEFAULT_CALENDAR_KINDS: ContentKind[] = ['SHORTFORM', 'CARD_NEWS'];
export const WEEKDAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];
/** 배치 1회에 만드는 최대 건수(전 기관 합) — 공급자 비용·실행 시간 상한 */
const MAX_PER_RUN = 20;

/** weeklyCount 만 있고 요일을 고르지 않았을 때 고르게 퍼뜨린 요일 */
const SPREAD: Record<number, number[]> = {
  1: [3], 2: [2, 5], 3: [1, 3, 5], 4: [1, 2, 4, 6], 5: [1, 2, 3, 4, 5], 6: [1, 2, 3, 4, 5, 6], 7: [0, 1, 2, 3, 4, 5, 6],
};

export interface CalendarRule {
  weeklyCount: number;
  days: number[];
  postHour: number;
}

/** 실제로 쓰는 요일. 고른 요일이 주당 건수보다 많으면 그중 고르게 weeklyCount 개를 쓴다. */
export function effectiveDays(rule: Pick<CalendarRule, 'weeklyCount' | 'days'>): number[] {
  const count = Math.min(7, Math.max(1, Math.round(rule.weeklyCount || 1)));
  const days = [...new Set((rule.days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  if (days.length === 0) return SPREAD[count]!;
  if (days.length <= count) return days;
  const picked = new Set<number>();
  for (let i = 0; i < count; i++) picked.add(days[Math.floor((i * days.length) / count)]!);
  return [...picked].sort((a, b) => a - b);
}

/** from 이후(초과) ~ from + days 일 안의 슬롯 시각(UTC Date). 요일·시각은 KST 기준. */
export function calendarSlots(rule: CalendarRule, from: Date, days = CALENDAR_LOOKAHEAD_DAYS): Date[] {
  const allowed = new Set(effectiveDays(rule));
  const hour = Math.min(23, Math.max(0, Math.round(rule.postHour)));
  const kstNow = new Date(from.getTime() + KST_OFFSET_MS);
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();
  const end = from.getTime() + days * 86_400_000;
  const out: Date[] = [];
  for (let i = 0; i <= days; i++) {
    const kstMidnight = Date.UTC(y, m, d + i); // KST 날짜의 00:00 을 UTC 숫자로 표현
    const weekday = new Date(kstMidnight).getUTCDay();
    if (!allowed.has(weekday)) continue;
    const at = kstMidnight + hour * 3600_000 - KST_OFFSET_MS;
    if (at > from.getTime() && at <= end) out.push(new Date(at));
  }
  return out;
}

/** 슬롯 시각을 화면용 "11월 6일(목) 19:00" 으로 (KST) */
export function formatSlot(at: Date) {
  const k = new Date(at.getTime() + KST_OFFSET_MS);
  return `${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일(${WEEKDAY_LABEL[k.getUTCDay()]}) ${String(k.getUTCHours()).padStart(2, '0')}:00`;
}

function kstDateOnly(now: Date) {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()));
}

/** 진행 중 캠페인 — ACTIVE 이고 오늘(KST)이 시작일~종료일 안. */
export async function runningCampaigns(merchantId: string, now = new Date()) {
  const today = kstDateOnly(now);
  return prisma.campaign.findMany({
    where: { merchantId, status: 'ACTIVE', startsOn: { lte: today }, endsOn: { gte: today } },
    select: { id: true, title: true, goalAmount: true, endsOn: true },
  });
}

export interface CalendarBlocker {
  code: 'DISABLED' | 'FEATURE_OFF' | 'NO_REG_NO' | 'NO_CAMPAIGN' | 'LIMIT';
  message: string;
}

/** 캘린더가 지금 만들 수 없는 이유 (설정 화면 표시·배치 공용). 빈 배열이면 만들 수 있다. */
export async function calendarBlockers(merchantId: string, now = new Date()): Promise<CalendarBlocker[]> {
  const out: CalendarBlocker[] = [];
  if (!featureContentEnabled()) out.push({ code: 'FEATURE_OFF', message: '콘텐츠 자동 생성 기능이 꺼져 있습니다.' });
  const [setting, merchant, campaigns, usage] = await Promise.all([
    getContentSetting(merchantId),
    prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { fundraisingRegNo: true, status: true } }),
    runningCampaigns(merchantId, now),
    monthlyUsage(merchantId, now),
  ]);
  if (!setting.calendarEnabled) out.push({ code: 'DISABLED', message: '콘텐츠 캘린더가 꺼져 있습니다.' });
  if (!merchant?.fundraisingRegNo) {
    out.push({ code: 'NO_REG_NO', message: '기부금품 모집등록번호가 없어 캘린더가 콘텐츠를 만들지 않습니다. 기관 정보에 모집등록번호를 넣어 주세요.' });
  }
  if (campaigns.length === 0) out.push({ code: 'NO_CAMPAIGN', message: '진행 중인 캠페인(모금 중 · 기간 안)이 없어 만들 콘텐츠가 없습니다.' });
  if (usage.count >= setting.monthlyLimit) out.push({ code: 'LIMIT', message: `이번 달 생성 한도(${setting.monthlyLimit}건)를 모두 썼습니다.` });
  return out;
}

/**
 * 다음 캠페인 고르기. 최근 14일 캘린더 사용이 적은 것 먼저(돌아가며), 같으면 진행률 낮고 마감 가까운 것.
 * 점수 = 진행률(0~1) × 0.6 + min(남은 일수/30, 1) × 0.4 — 낮을수록 먼저.
 */
export async function pickCampaign(merchantId: string, now = new Date()) {
  const list = await runningCampaigns(merchantId, now);
  if (list.length === 0) return null;
  const stats = await campaignStats(list.map((c) => c.id));
  const since = new Date(now.getTime() - 14 * 86_400_000);
  const uses = await prisma.contentSlot.groupBy({ by: ['campaignId'], where: { merchantId, createdAt: { gte: since }, campaignId: { in: list.map((c) => c.id) } }, _count: { _all: true } });
  const used = new Map(uses.map((u) => [u.campaignId, u._count._all]));
  const scored = list.map((c) => {
    const raised = stats.get(c.id)?.raised ?? 0n;
    const ratio = c.goalAmount > 0n ? Math.min(1, Number((raised * 1000n) / c.goalAmount) / 1000) : 1;
    const daysLeft = Math.max(0, (c.endsOn.getTime() - kstDateOnly(now).getTime()) / 86_400_000);
    return { c, used: used.get(c.id) ?? 0, score: ratio * 0.6 + Math.min(daysLeft / 30, 1) * 0.4 };
  });
  scored.sort((a, b) => a.used - b.used || a.score - b.score || a.c.id.localeCompare(b.c.id));
  return scored[0]!.c;
}

async function kindForNextSlot(merchantId: string, kinds: ContentKind[]) {
  const list = kinds.length ? kinds : DEFAULT_CALENDAR_KINDS;
  const made = await prisma.contentSlot.count({ where: { merchantId } });
  return list[made % list.length]!;
}

export interface CalendarRunResult {
  merchants: number;
  created: number;
  autoScheduled: number;
  skipped: number;
  failed: number;
}

/** 한 기관의 다음 빈 슬롯 하나를 만든다. 만들었으면 슬롯 행, 아니면 null. */
export async function fillNextSlot(merchantId: string, now = new Date()) {
  const setting = await getContentSetting(merchantId);
  if (!setting.calendarEnabled) return { slot: null, reason: 'DISABLED' as const };
  const blockers = (await calendarBlockers(merchantId, now)).filter((b) => b.code !== 'DISABLED');
  if (blockers.length) return { slot: null, reason: blockers[0]!.code };
  const slots = calendarSlots(setting, now);
  if (slots.length === 0) return { slot: null, reason: 'NO_SLOT' as const };
  const taken = new Set(
    (await prisma.contentSlot.findMany({ where: { merchantId, slotAt: { in: slots } }, select: { slotAt: true } })).map((r) => r.slotAt.getTime()),
  );
  const next = slots.find((s) => !taken.has(s.getTime()));
  if (!next) return { slot: null, reason: 'FULL' as const };
  const campaign = await pickCampaign(merchantId, now);
  if (!campaign) return { slot: null, reason: 'NO_CAMPAIGN' as const };
  const kind = await kindForNextSlot(merchantId, setting.kinds);

  // 슬롯 선점 — (기관, 슬롯 시각) 유니크. 다른 실행이 먼저 잡았으면 물러난다.
  const claim = await prisma.contentSlot.createMany({
    data: [{ id: newId(), merchantId, slotAt: next, kind, campaignId: campaign.id, status: 'GENERATING' }],
    skipDuplicates: true,
  });
  if (claim.count === 0) return { slot: null, reason: 'BUSY' as const };
  const slot = await prisma.contentSlot.findUniqueOrThrow({ where: { merchantId_slotAt: { merchantId, slotAt: next } } });
  try {
    const item = await requestContent({ merchantId, campaignId: campaign.id, kind, userId: 'CALENDAR' });
    const status = item.status === 'APPROVED' ? 'APPROVED' : item.status === 'REVIEW' ? 'REVIEW' : item.status === 'FAILED' ? 'FAILED' : item.status;
    await prisma.contentSlot.update({
      where: { id: slot.id },
      data: { itemId: item.id, status, note: item.status === 'FAILED' ? (item.error ?? '생성 실패').slice(0, 300) : item.status === 'REVIEW' ? '검토 대기 — 승인하면 슬롯 시각으로 예약합니다(자동 예약 켬일 때).' : null },
    });
    // 2안 비교(A/B)를 켠 기관이면 같은 슬롯에 캡션만 다른 B안을 만든다(공급자 호출 없음 · 각각 승인 필요 — 2026-11-11 G).
    if (item.status === 'REVIEW') await (await import('./content-variants')).createVariantB(item.id).catch((e) => logger.warn('2안 비교 B안 생성 실패', { merchantId, message: (e as Error).message }));
    return { slot: await prisma.contentSlot.findUniqueOrThrow({ where: { id: slot.id } }), reason: null };
  } catch (e) {
    const message = e instanceof ContentError ? e.message : '생성 중 오류가 발생했습니다.';
    logger.warn('콘텐츠 캘린더 생성 실패', { merchantId, message: (e as Error).message });
    await prisma.contentSlot.update({ where: { id: slot.id }, data: { status: 'FAILED', note: message.slice(0, 300) } });
    return { slot: await prisma.contentSlot.findUniqueOrThrow({ where: { id: slot.id } }), reason: null };
  }
}

/**
 * 슬롯 시각이 지난 콘텐츠를 늦게 승인할 때 "다음 빈 슬롯" 으로 옮긴다(2026-11-09). 캘린더 설정(요일·시각) 기준 앞으로 4주 안에서
 * 아직 콘텐츠가 없는 가장 가까운 슬롯. (기관, 슬롯 시각) 유니크라 동시에 옮겨도 한 슬롯에 둘이 들어가지 않는다(충돌하면 다음 후보).
 * 옮긴 슬롯은 캘린더가 새로 만들지 않는다. 옮긴 시각을 돌려준다(없으면 null).
 */
export async function moveSlotToNextFree(slotId: string, now = new Date()): Promise<Date | null> {
  const slot = await prisma.contentSlot.findUnique({ where: { id: slotId } });
  if (!slot) return null;
  const setting = await getContentSetting(slot.merchantId);
  const candidates = calendarSlots(setting, now, CALENDAR_LOOKAHEAD_DAYS * 4);
  if (candidates.length === 0) return null;
  const taken = new Set(
    (await prisma.contentSlot.findMany({ where: { merchantId: slot.merchantId, slotAt: { in: candidates } }, select: { slotAt: true } })).map((r) => r.slotAt.getTime()),
  );
  for (const at of candidates) {
    if (taken.has(at.getTime())) continue;
    try {
      const r = await prisma.contentSlot.updateMany({ where: { id: slot.id, slotAt: slot.slotAt }, data: { slotAt: at, note: `게시 시각이 지나 ${formatSlot(at)} 슬롯으로 옮겼습니다.` } });
      return r.count === 1 ? at : null;
    } catch (e) {
      if ((e as { code?: string })?.code !== 'P2002') throw e;
    }
  }
  return null;
}

/** 배치(/api/cron/content): 캘린더를 켠 기관마다 다음 빈 슬롯 하나씩. */
export async function runContentCalendar(now = new Date()): Promise<CalendarRunResult> {
  const result: CalendarRunResult = { merchants: 0, created: 0, autoScheduled: 0, skipped: 0, failed: 0 };
  if (!featureContentEnabled()) return result;
  const settings = await prisma.merchantContentSetting.findMany({
    where: { calendarEnabled: true, merchant: { status: 'APPROVED' } },
    select: { merchantId: true },
    orderBy: { updatedAt: 'asc' },
  });
  for (const s of settings) {
    if (result.created + result.failed >= MAX_PER_RUN) break;
    result.merchants += 1;
    const r = await fillNextSlot(s.merchantId, now).catch((e) => {
      logger.error('콘텐츠 캘린더 처리 오류', { merchantId: s.merchantId, message: (e as Error).message });
      return { slot: null, reason: 'ERROR' as const };
    });
    if (!r.slot) result.skipped += 1;
    else if (r.slot.status === 'FAILED') result.failed += 1;
    else {
      result.created += 1;
      if (r.slot.status === 'SCHEDULED') result.autoScheduled += 1;
    }
  }
  return result;
}

/** 설정 화면: 다음 4주 슬롯과 그 슬롯의 콘텐츠 상태 */
export async function calendarPreview(merchantId: string, now = new Date(), weeks = 4) {
  const setting = await getContentSetting(merchantId);
  const slots = calendarSlots(setting, now, weeks * 7);
  const rows = slots.length
    ? await prisma.contentSlot.findMany({ where: { merchantId, slotAt: { in: slots } } })
    : [];
  const by = new Map(rows.map((r) => [r.slotAt.getTime(), r]));
  const kinds = setting.kinds.length ? setting.kinds : DEFAULT_CALENDAR_KINDS;
  const made = await prisma.contentSlot.count({ where: { merchantId } });
  let future = 0;
  return slots.map((at) => {
    const row = by.get(at.getTime()) ?? null;
    const kind = row?.kind ?? kinds[(made + future++) % kinds.length]!;
    return { at, label: formatSlot(at), kind, slot: row, withinLookahead: at.getTime() - now.getTime() <= CALENDAR_LOOKAHEAD_DAYS * 86_400_000 };
  });
}
