import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import type { ContentItem, SocialPlatform } from '@/generated/prisma/client';
import { autoScheduleSlotItem, contentDraftViolation, getContentSetting, schedulePublish } from './content';

/**
 * 콘텐츠 2안 비교(A/B) (2026-11-11 G2-3).
 *
 *  - 기관 설정 `ab_test_enabled` 를 켜면 캘린더가 슬롯 콘텐츠(A안)를 만든 직후 같은 장면·영상에 **캡션만 다른 B안**을 만든다
 *    (A안의 첫 두 줄 순서를 바꾼 규칙 변형 — 링크·"AI 생성 콘텐츠"·모집등록번호 줄은 그대로). 공급자 호출 없음(비용 0원).
 *  - 두 안 모두 각각 담당자 승인을 거친다(자동 승인·자동 게시 없음).
 *    둘 다 승인 → A안이 예약된 플랫폼이 둘 이상이면 하나를 B안으로 나누고, 하나면 같은 플랫폼에 B안을 3시간 뒤로 예약한다.
 *    한쪽만 승인(다른 쪽 반려) → 승인된 안만 슬롯 시각으로(B안이면 슬롯을 넘겨받는다). 승인 없는 게시는 없다.
 *  - 자동 예약 조건(autoSchedule·SNS 게시 열림·연결 채널)은 기존 규칙 그대로다. 조건이 안 되면 승인만 되고 게시는 담당자가 직접 한다.
 *  - 결과(클릭·후원)는 성과 화면의 2안 비교 표(content-performance.ts variantComparisons).
 */

export const VARIANT_B_OFFSET_MS = 3 * 3600_000;

/** B안 캡션 — 첫 줄(제목)과 둘째 줄(한 줄 소개)의 순서를 바꾼다. 둘째 줄이 비면 "[소식]" 머리를 붙인다. */
export function variantCaptionB(caption: string): string {
  const lines = caption.split('\n');
  if (lines.length >= 2 && lines[1]!.trim() && lines[0]!.trim() !== lines[1]!.trim()) {
    return [lines[1]!, lines[0]!, ...lines.slice(2)].join('\n');
  }
  return `[소식] ${caption}`;
}

/**
 * 슬롯 콘텐츠(A안)의 B안을 만든다. 설정이 꺼졌거나, A안이 검토 대기가 아니거나, 이미 묶음이 있으면 아무것도 하지 않는다.
 * A안 행의 variant_group_id 를 조건부로 채우는 순간이 선점이다(겹친 실행이 B안을 두 번 만들지 않는다).
 */
export async function createVariantB(itemId: string): Promise<ContentItem | null> {
  const a = await prisma.contentItem.findUnique({ where: { id: itemId } });
  if (!a || a.status !== 'REVIEW' || a.variantGroupId || !a.caption) return null;
  const setting = await getContentSetting(a.merchantId);
  if (!setting.abTestEnabled) return null;
  const caption = variantCaptionB(a.caption);
  const scenes = (a.scenes ?? []) as Array<{ caption?: string }>;
  if (contentDraftViolation({ bannedWords: setting.bannedWords, captions: scenes.map((s) => s.caption ?? ''), caption })) return null;
  const claimed = await prisma.contentItem.updateMany({ where: { id: a.id, variantGroupId: null, status: 'REVIEW' }, data: { variantGroupId: a.id, variantLabel: 'A' } });
  if (claimed.count === 0) return null;
  try {
    return await prisma.contentItem.create({
      data: {
        id: newId(),
        merchantId: a.merchantId,
        campaignId: a.campaignId,
        postingId: a.postingId,
        kind: a.kind,
        status: 'REVIEW',
        title: a.title,
        script: a.script,
        scenes: a.scenes ?? [],
        caption,
        hashtags: a.hashtags,
        coverSvg: a.coverSvg,
        videoUrl: a.videoUrl,
        aiLabeled: a.aiLabeled,
        regNoIncluded: a.regNoIncluded,
        provider: a.provider,
        costKrw: 0,
        createdBy: a.createdBy,
        variantGroupId: a.id,
        variantLabel: 'B',
      },
    });
  } catch (e) {
    logger.warn('2안 비교 B안 생성 실패 — A안만 둡니다', { itemId, message: (e as Error).message });
    await prisma.contentItem.updateMany({ where: { id: a.id, variantLabel: 'A' }, data: { variantGroupId: null, variantLabel: null } }).catch(() => undefined);
    return null;
  }
}

const LIVE = ['APPROVED', 'SCHEDULED', 'PUBLISHED'];

/** 안 이름별 현재 판(보관되지 않은 가장 최근 판 — 수정 요청 판이 묶음을 이어받는다) */
async function currentVariants(groupId: string) {
  const rows = await prisma.contentItem.findMany({ where: { variantGroupId: groupId }, orderBy: { createdAt: 'desc' } });
  const pick = (label: string) => rows.find((r) => r.variantLabel === label && r.status !== 'ARCHIVED' && r.status !== 'FAILED') ?? null;
  return { a: pick('A'), b: pick('B'), rows };
}

export type VariantSettleResult = 'NONE' | 'WAIT' | 'SPLIT_PLATFORM' | 'SPLIT_TIME' | 'B_TAKES_SLOT' | 'MANUAL';

/**
 * 승인·반려 뒤 묶음 정리. 다시 불러도 같은 결과(이미 B안 게시 행이 있으면 아무것도 하지 않음).
 * 승인되지 않은 안은 절대 예약하지 않는다.
 */
export async function settleVariantGroup(itemId: string, now = new Date()): Promise<VariantSettleResult> {
  const item = await prisma.contentItem.findUnique({ where: { id: itemId }, select: { variantGroupId: true, merchantId: true } });
  if (!item?.variantGroupId) return 'NONE';
  const { a, b, rows } = await currentVariants(item.variantGroupId);
  const merchantId = item.merchantId;
  const aLive = Boolean(a && LIVE.includes(a.status));
  const bLive = Boolean(b && LIVE.includes(b.status));

  // A안이 없거나(반려·보관) B안만 승인 → B안이 슬롯을 넘겨받는다
  if (!a && bLive && b) {
    const slotOwner = rows.map((r) => r.id);
    const slot = await prisma.contentSlot.findFirst({ where: { merchantId, itemId: { in: slotOwner } } });
    if (slot && slot.itemId !== b.id) {
      const moved = await prisma.contentSlot.updateMany({ where: { id: slot.id, itemId: slot.itemId }, data: { itemId: b.id, status: 'APPROVED', note: 'A안 반려 — B안으로 진행' } });
      if (moved.count === 1) await autoScheduleSlotItem(b.id, now);
    }
    return 'B_TAKES_SLOT';
  }
  if (!aLive || !bLive || !a || !b) return 'WAIT';

  const bPubs = await prisma.contentPublish.count({ where: { itemId: b.id, status: { notIn: ['CANCELED'] } } });
  if (bPubs > 0) return 'NONE';
  const aPubs = await prisma.contentPublish.findMany({ where: { itemId: a.id, status: { notIn: ['CANCELED', 'FAILED'] } }, orderBy: { createdAt: 'asc' } });
  if (aPubs.length === 0 || !env.automation.socialPublishEnabled) return 'MANUAL';

  const scheduled = aPubs.filter((p) => p.status === 'SCHEDULED');
  try {
    if (scheduled.length >= 2) {
      // 두 플랫폼으로 나누기 — A안 마지막 예약 하나를 취소하고 같은 시각에 B안을 그 플랫폼으로
      const give = scheduled[scheduled.length - 1]!;
      const c = await prisma.contentPublish.updateMany({ where: { id: give.id, status: 'SCHEDULED' }, data: { status: 'CANCELED', error: '2안 비교 — 이 플랫폼은 B안으로 게시' } });
      if (c.count === 1) {
        await schedulePublish(merchantId, b.id, [give.platform as SocialPlatform], give.scheduledAt);
        return 'SPLIT_PLATFORM';
      }
    }
    // 같은 플랫폼에 두 시각으로 — A안 시각 + 3시간(이미 지났으면 지금부터 5분 뒤)
    const base = aPubs[0]!;
    const baseAt = (base.publishedAt ?? base.scheduledAt).getTime();
    const at = new Date(Math.max(baseAt + VARIANT_B_OFFSET_MS, now.getTime() + 5 * 60_000));
    await schedulePublish(merchantId, b.id, [base.platform as SocialPlatform], at);
    return 'SPLIT_TIME';
  } catch (e) {
    logger.warn('2안 비교 B안 예약 실패 — 승인만 유지합니다', { groupId: item.variantGroupId, message: (e as Error).message });
    return 'MANUAL';
  }
}

/** 승인·반려 직후 부르는 안전 래퍼(실패해도 승인·반려 결과를 바꾸지 않는다) */
export async function afterVariantDecision(itemId: string, now = new Date()) {
  return settleVariantGroup(itemId, now).catch((e) => {
    logger.warn('2안 비교 정리 실패', { itemId, message: (e as Error).message });
    return 'NONE' as const;
  });
}
