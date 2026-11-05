import { env } from '@/lib/env';
import { hmac } from '@/lib/crypto';
import { attributionQuery, normalizeSource } from '@/lib/attribution';
import { logger } from '@/lib/logger';
import { prisma } from '@/server/db';
import { kv } from '@/server/redis';

/**
 * 콘텐츠 링크 클릭 집계 (`/go/[publishId]` → content_publish.clicks).
 *
 * 규칙
 *  - 이동할 주소는 **게시 행에서 서버가 만든다.** 쿼리·경로로 대상 주소를 받지 않는다(오픈 리다이렉트 금지).
 *  - 봇·미리보기 수집기(User-Agent)는 세지 않는다. 이동은 똑같이 시킨다.
 *  - 같은 IP·같은 게시는 10분에 한 번만 센다(kv setnx). IP 는 HMAC 해시로만 키에 쓰고 저장하지 않는다.
 *    kv 를 확인할 수 없으면 세지 않는다(부풀리기보다 누락이 낫다).
 *  - 증가는 원자적 increment 한 번이다. 집계 실패가 이동을 막지 않는다.
 */

export const CLICK_DEDUPE_SEC = 10 * 60;

const BOT_UA =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|facebot|meta-externalagent|kakaotalk-scrap|scrap|yeti|daum(oa)?|twitterbot|whatsapp|telegrambot|discordbot|slackbot|embedly|bingpreview|headless|lighthouse|curl|wget|python-requests|httpclient|axios|node-fetch|go-http-client/i;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua || !ua.trim()) return true;
  return BOT_UA.test(ua);
}

/** ULID(26자)만 받는다. */
function normalizePublishId(raw: string): string | null {
  const v = raw.trim().toUpperCase();
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v) ? v : null;
}

/** 캡션에 넣는 짧은 링크. renderCaption 에서 게시 행이 있으면 이 주소를 쓴다(5단계와 합칠 때 연결). */
export function goLink(publishId: string): string {
  return `${env.baseUrl}/go/${publishId}`;
}

/** 게시 행 → 그 콘텐츠의 기관 후원페이지(캠페인·봉사 공고) 주소 + 유입 경로(?src=&cid=) */
export function clickTargetPath(p: { platform: string; item: { id: string; campaignId: string | null; postingId: string | null; merchant: { code: string } } }): string {
  const code = p.item.merchant.code;
  const path = p.item.campaignId
    ? `/donate/${code}/campaigns/${p.item.campaignId}`
    : p.item.postingId
      ? `/donate/${code}/volunteer/${p.item.postingId}`
      : `/donate/${code}`;
  return `${path}?${attributionQuery(normalizeSource(p.platform) ?? 'WEB', p.item.id)}`;
}

export type ClickResult = { found: false } | { found: true; target: string; counted: boolean; reason?: 'bot' | 'duplicate' | 'error' };

export async function recordContentClick(input: { publishId: string; ip: string | null; userAgent: string | null }): Promise<ClickResult> {
  const id = normalizePublishId(input.publishId);
  if (!id) return { found: false };
  const pub = await prisma.contentPublish.findUnique({
    where: { id },
    select: {
      id: true,
      platform: true,
      item: { select: { id: true, campaignId: true, postingId: true, merchant: { select: { code: true } } } },
    },
  });
  if (!pub) return { found: false };
  const target = `${env.baseUrl}${clickTargetPath(pub)}`;
  if (isBotUserAgent(input.userAgent)) return { found: true, target, counted: false, reason: 'bot' };

  const ipKey = hmac(`click:${input.ip?.trim() || 'unknown'}`);
  const fresh = await kv.setnx(`click:${pub.id}:${ipKey}`, '1', CLICK_DEDUPE_SEC).catch(() => null);
  if (fresh === null) return { found: true, target, counted: false, reason: 'error' };
  if (!fresh) return { found: true, target, counted: false, reason: 'duplicate' };
  try {
    await prisma.contentPublish.update({ where: { id: pub.id }, data: { clicks: { increment: 1 } } });
  } catch (e) {
    logger.warn('콘텐츠 클릭 집계 실패', { publishId: pub.id, message: (e as Error).message });
    return { found: true, target, counted: false, reason: 'error' };
  }
  return { found: true, target, counted: true };
}
