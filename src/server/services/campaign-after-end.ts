import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { normalizeKeyword, normalizeText } from './content-filter';

/**
 * 캠페인 종료 후 후원 처리·캠페인 감사 문구 (2026-11-12 4차 I). 결제 흐름(charge-flow·payment-reconcile)이 부르는 작은 모듈 —
 * 무거운 의존(콘텐츠·승인)을 결제 흐름에 끌어들이지 않으려고 campaign-setup 과 나눴다.
 */

const kstToday = (now: Date) => new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

/** 캠페인이 끝났는가 — 종료 상태이거나 종료일(KST)이 지남 */
export function campaignEnded(c: { status: string; endsOn: Date }, now = new Date()) {
  return c.status === 'CLOSED' || c.status === 'ARCHIVED' || kstToday(now) > c.endsOn.toISOString().slice(0, 10);
}

/**
 * 문자 맨 앞 토큰이 "끝났고 종료 후 받지 않기(REJECT)" 인 캠페인 키워드인가. 모금 중 캠페인 키워드가 먼저다(호출부가 matchCampaignKeyword 를 먼저 본다).
 * GENERAL(기본) 캠페인은 null — 예전처럼 기관 일반 후원으로 처리된다.
 */
export async function endedCampaignRejecting(merchantId: string, body: string, now = new Date()) {
  const t = normalizeText(body ?? '');
  const m = t.match(/^([\p{L}\p{N}][\p{L}\p{N}._-]{1,19})(?:\s+[\s\S]*)?$/u);
  if (!m) return null;
  const token = normalizeKeyword(m[1]);
  if (!token) return null;
  const rows = await prisma.campaign.findMany({ where: { merchantId, afterEndPolicy: 'REJECT', status: { in: ['ACTIVE', 'CLOSED'] } }, select: { id: true, code: true, title: true, status: true, endsOn: true } });
  return rows.find((c) => normalizeKeyword(c.code) === token && campaignEnded(c, now)) ?? null;
}

/** 결제 흐름용 안전 래퍼 — 판단에 실패하면 예전 동작(일반 후원)으로 둔다. */
export async function endedCampaignRejectingSafe(merchantId: string, body: string) {
  try {
    return await endedCampaignRejecting(merchantId, body);
  } catch (e) {
    logger.warn('종료 캠페인 방침 확인 실패(일반 후원으로 처리)', { merchantId, message: (e as Error).message });
    return null;
  }
}

/** 이 캠페인 감사 문자(없으면 null — 기관 기본 감사 문구). 실패해도 결제 사후 처리를 막지 않는다. */
export async function campaignThanksText(campaignId: string | null | undefined): Promise<string | null> {
  if (!campaignId) return null;
  try {
    const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { thanksMessage: true } });
    return c?.thanksMessage?.trim() ? c.thanksMessage : null;
  } catch {
    return null;
  }
}
