import { createHmac } from 'node:crypto';
import { env } from '@/lib/env';
import { decrypt, encrypt, generateToken, safeEqual } from '@/lib/crypto';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { prisma } from '@/server/db';
import { notifyUser } from './notifications';
import type { SocialPlatform } from '@/generated/prisma/enums';
import {
  dbSupportsPlatform,
  isSnsPlatform,
  platformMissingCredentials,
  SNS_OAUTH_FAMILY,
  SNS_PLATFORMS,
  SNS_PLATFORM_LABEL,
  SNS_PLATFORM_SLUG,
  type SnsPlatform,
} from '@/server/adapters/sns/platforms';
import { buildAuthorizeUrl, exchangeCode, newPkceVerifier, pkceChallenge, refreshTokens, usesPkce } from '@/server/adapters/sns/oauth';
import { SnsApiError } from '@/server/adapters/sns/http';
import { youtubeSetPublic } from '@/server/adapters/sns/youtube';
import { getSnsAdapter, type SnsMetrics } from '@/server/adapters/sns';

/**
 * SNS 계정 연결(OAuth) · 토큰 갱신 · 게시 인증 (2026-11-06 7단계).
 *
 * 흐름
 *   GET /api/studio/social/<platform>/connect   기관 담당자 세션 → state(기관·플랫폼·nonce·만료 10분, HMAC 서명)
 *                                               + PKCE(구글) verifier 는 httpOnly 쿠키 → 공급자 동의 화면
 *   GET /api/studio/social/<platform>/callback  state 서명·만료·플랫폼·세션 기관 일치 + 쿠키 nonce 일치
 *                                               → 코드 교환 → 계정 조회 → social_channel CONNECTED·mock=false
 *                                               (토큰은 암호화 저장) → 감사로그 → /studio/channels?connected=<platform>
 * 지키는 것
 *   - 토큰 원문을 DB·로그·화면에 남기지 않는다(access_token_enc / refresh_token_enc 만).
 *   - 키가 없는 플랫폼은 동의 화면으로 보내지 않는다. mock 공급자에서는 OAuth 를 쓰지 않는다(계정 이름 등록만).
 *   - 갱신 실패 → 채널 EXPIRED + 기관 인앱 알림. 게시 배치는 그 채널로 올리지 않는다.
 */

export class SocialOAuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SocialOAuthError';
  }
}

export class SocialTokenExpiredError extends Error {}

export const SOCIAL_STATE_TTL_MS = 10 * 60_000;
/** 만료 이 시간 전부터 미리 갱신한다 */
export const SOCIAL_REFRESH_MARGIN_MS = 5 * 60_000;

export function socialOAuthCookieName(p: SnsPlatform) {
  return `givesign_social_oauth_${SNS_PLATFORM_SLUG[p].replace(/-/g, '_')}`;
}

// ---------------------------------------------------------------------------
// state 서명
// ---------------------------------------------------------------------------

interface StatePayload {
  m: string; // merchantId
  p: string; // platform
  u: string; // userId
  n: string; // nonce
  e: number; // 만료 (ms)
}

function stateSecret() {
  const s = env.integrations.social.stateSecret;
  if (!s) throw new SocialOAuthError('not_configured', 'SOCIAL_OAUTH_STATE_SECRET 이 없어 계정 연결을 시작할 수 없습니다.');
  return s;
}

function stateMac(body: string) {
  return createHmac('sha256', stateSecret()).update(`givesign-social-state:${body}`).digest('base64url');
}

export function signSocialState(p: StatePayload): string {
  const body = Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
  return `${body}.${stateMac(body)}`;
}

export function verifySocialState(state: string, now = Date.now()): StatePayload {
  const [body, mac, extra] = (state ?? '').split('.');
  if (!body || !mac || extra !== undefined || !safeEqual(mac, stateMac(body))) throw new SocialOAuthError('state_invalid', '연결 요청을 확인할 수 없습니다. 다시 시도해 주세요.');
  let p: StatePayload;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    throw new SocialOAuthError('state_invalid', '연결 요청을 확인할 수 없습니다. 다시 시도해 주세요.');
  }
  if (typeof p.e !== 'number' || p.e < now) throw new SocialOAuthError('state_expired', '연결 요청 시간이 지났습니다(10분). 다시 시도해 주세요.');
  return p;
}

// ---------------------------------------------------------------------------
// 연결 시작 · 콜백
// ---------------------------------------------------------------------------

export function socialOAuthAvailability(p: SnsPlatform): { ok: true } | { ok: false; code: string; message: string } {
  if (env.automation.socialProvider === 'mock') return { ok: false, code: 'mock', message: 'SNS 연동이 mock 입니다. 계정 이름만 등록합니다.' };
  if (!SNS_OAUTH_FAMILY[p]) return { ok: false, code: 'no_api', message: `${SNS_PLATFORM_LABEL[p]}는 공개 게시 API 가 없어 계정을 연결하지 않습니다. 내려받아 직접 게시해 주세요.` };
  const missing = platformMissingCredentials(p);
  if (missing.length) return { ok: false, code: 'not_configured', message: `${SNS_PLATFORM_LABEL[p]} 연결 키가 없습니다: ${missing.join(', ')}` };
  if (!dbSupportsPlatform(p)) return { ok: false, code: 'db_pending', message: `${SNS_PLATFORM_LABEL[p]} 채널 저장 구조가 아직 반영되지 않았습니다(플랫폼 목록 확장 후 연결).` };
  return { ok: true };
}

export interface ConnectStart {
  authorizeUrl: string;
  cookieName: string;
  cookieValue: string;
  maxAgeSec: number;
}

export function startSocialConnect(input: { merchantId: string; userId: string; platform: SnsPlatform; now?: number }): ConnectStart {
  const avail = socialOAuthAvailability(input.platform);
  if (!avail.ok) throw new SocialOAuthError(avail.code, avail.message);
  const nonce = generateToken(16);
  const now = input.now ?? Date.now();
  const state = signSocialState({ m: input.merchantId, p: input.platform, u: input.userId, n: nonce, e: now + SOCIAL_STATE_TTL_MS });
  const verifier = usesPkce(input.platform) ? newPkceVerifier() : '';
  return {
    authorizeUrl: buildAuthorizeUrl(input.platform, state, verifier ? pkceChallenge(verifier) : null),
    cookieName: socialOAuthCookieName(input.platform),
    // nonce 로 이 브라우저에서 시작한 요청인지 확인하고, verifier 는 코드 교환에만 쓴다(httpOnly, 10분).
    cookieValue: `${nonce}.${verifier}`,
    maxAgeSec: SOCIAL_STATE_TTL_MS / 1000,
  };
}

export interface ConnectCallbackInput {
  /** 세션의 기관(콜백을 연 담당자) */
  sessionMerchantId: string;
  sessionUserId: string;
  platform: SnsPlatform;
  code: string | null;
  state: string | null;
  /** 공급자가 돌려준 오류(동의 거부 등) */
  providerError?: string | null;
  cookieValue: string | null;
  ip?: string | null;
  userAgent?: string | null;
  now?: number;
}

export async function completeSocialConnect(input: ConnectCallbackInput) {
  const avail = socialOAuthAvailability(input.platform);
  if (!avail.ok) throw new SocialOAuthError(avail.code, avail.message);
  if (input.providerError) throw new SocialOAuthError('denied', '계정 연결 동의가 완료되지 않았습니다.');
  if (!input.code || !input.state) throw new SocialOAuthError('state_invalid', '연결 응답이 올바르지 않습니다. 다시 시도해 주세요.');
  const st = verifySocialState(input.state, input.now);
  if (st.p !== input.platform) throw new SocialOAuthError('state_invalid', '다른 플랫폼의 연결 요청입니다.');
  if (st.m !== input.sessionMerchantId) throw new SocialOAuthError('merchant_mismatch', '연결을 시작한 기관과 지금 로그인한 기관이 다릅니다.');
  const [nonce, verifier] = (input.cookieValue ?? '').split('.');
  if (!nonce || !safeEqual(nonce, st.n)) throw new SocialOAuthError('state_invalid', '이 브라우저에서 시작한 연결 요청이 아닙니다. 다시 시도해 주세요.');
  if (usesPkce(input.platform) && !verifier) throw new SocialOAuthError('state_invalid', '연결 요청 정보(PKCE)가 없습니다. 다시 시도해 주세요.');

  let result: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    result = await exchangeCode(input.platform, input.code, usesPkce(input.platform) ? verifier! : null);
  } catch (e) {
    logger.warn('SNS 계정 연결 코드 교환 실패', { platform: input.platform, merchantId: st.m, message: (e as Error).message });
    throw new SocialOAuthError('exchange_failed', e instanceof SnsApiError ? e.message : '공급자에서 토큰을 받지 못했습니다.');
  }
  const { tokens, account } = result;
  const platform = input.platform as SocialPlatform;
  const data = {
    accountName: account.name.slice(0, 80),
    externalId: account.externalId,
    accessTokenEnc: encrypt(tokens.accessToken),
    refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    tokenScope: tokens.scope,
    lastError: null,
    status: 'CONNECTED',
    mock: false,
    connectedBy: input.sessionUserId,
  };
  const channel = await prisma.socialChannel.upsert({
    where: { merchantId_platform: { merchantId: st.m, platform } },
    create: { id: newId(), merchantId: st.m, platform, ...data },
    update: { ...data, connectedAt: new Date() },
  });
  await writeSocialAudit({
    actorUserId: input.sessionUserId,
    action: 'SOCIAL_CHANNEL_OAUTH_CONNECT',
    merchantId: st.m,
    after: { platform, accountName: data.accountName, externalId: account.externalId, scope: tokens.scope, expiresAt: tokens.expiresAt?.toISOString() ?? null },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return channel;
}

async function writeSocialAudit(input: { actorUserId: string | null; action: string; merchantId: string; before?: unknown; after?: unknown; ip?: string | null; userAgent?: string | null }) {
  const actor = input.actorUserId ? await prisma.user.findUnique({ where: { id: input.actorUserId }, select: { email: true, name: true, role: true } }) : null;
  await prisma.adminAuditLog
    .create({
      data: {
        id: newId(),
        actorUserId: input.actorUserId,
        actorLabel: actor ? (actor.email ?? actor.name ?? input.actorUserId) : null,
        actorRole: actor?.role ?? 'SYSTEM',
        action: input.action,
        targetType: 'merchant',
        targetId: input.merchantId,
        beforeValue: (input.before ?? null) as object,
        afterValue: (input.after ?? null) as object,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    })
    .catch((e) => logger.error('SNS 연결 감사로그 기록 실패', { message: (e as Error).message }));
}

// ---------------------------------------------------------------------------
// 토큰 갱신 · 게시 인증
// ---------------------------------------------------------------------------

type ChannelRow = Awaited<ReturnType<typeof prisma.socialChannel.findUniqueOrThrow>>;

async function markExpired(channel: ChannelRow, reason: string) {
  const r = await prisma.socialChannel.updateMany({
    where: { id: channel.id, status: 'CONNECTED' },
    data: { status: 'EXPIRED', lastError: reason.slice(0, 300) },
  });
  if (r.count === 0) return; // 이미 만료·해제 처리됨 — 알림을 겹쳐 보내지 않는다
  const merchant = await prisma.merchantProfile.findUnique({ where: { id: channel.merchantId }, select: { userId: true } });
  const label = isSnsPlatform(channel.platform) ? SNS_PLATFORM_LABEL[channel.platform] : channel.platform;
  if (merchant) {
    await notifyUser({
      userId: merchant.userId,
      title: `${label} 연결이 만료되었습니다`,
      body: `${label} 계정 토큰을 갱신하지 못해 예약된 게시가 올라가지 않습니다. SNS 채널에서 다시 연결해 주세요.`,
      linkUrl: '/studio/channels',
    }).catch((e) => logger.error('SNS 만료 알림 실패', { message: (e as Error).message }));
  }
  await writeSocialAudit({ actorUserId: null, action: 'SOCIAL_CHANNEL_EXPIRED', merchantId: channel.merchantId, after: { platform: channel.platform, reason: reason.slice(0, 200) } });
}

/**
 * 만료가 가까우면(5분 전) 리프레시 토큰으로 갱신한다. mock 채널·만료 시각 없는 토큰(메타 페이지 토큰)은 그대로.
 * 갱신할 수 없거나 실패하면 채널을 EXPIRED 로 바꾸고 기관에 알린 뒤 SocialTokenExpiredError 를 던진다.
 */
export async function refreshIfNeeded(channel: ChannelRow, now = new Date()): Promise<ChannelRow> {
  if (channel.mock) return channel;
  if (channel.status !== 'CONNECTED') throw new SocialTokenExpiredError('채널 연결이 끊겼습니다. SNS 채널을 다시 연결해 주세요.');
  if (!channel.expiresAt || channel.expiresAt.getTime() - now.getTime() > SOCIAL_REFRESH_MARGIN_MS) return channel;
  const p = channel.platform as string;
  const fail = async (reason: string): Promise<never> => {
    await markExpired(channel, reason);
    throw new SocialTokenExpiredError(`토큰이 만료되어 갱신하지 못했습니다: ${reason}. SNS 채널을 다시 연결해 주세요.`);
  };
  if (!channel.refreshTokenEnc || !isSnsPlatform(p)) return fail('리프레시 토큰 없음');
  if (channel.refreshExpiresAt && channel.refreshExpiresAt.getTime() <= now.getTime()) return fail('리프레시 토큰 만료');
  let t;
  try {
    t = await refreshTokens(p, decrypt(channel.refreshTokenEnc));
  } catch (e) {
    return fail((e as Error).message.slice(0, 200));
  }
  return prisma.socialChannel.update({
    where: { id: channel.id },
    data: {
      accessTokenEnc: encrypt(t.accessToken),
      refreshTokenEnc: t.refreshToken ? encrypt(t.refreshToken) : channel.refreshTokenEnc,
      expiresAt: t.expiresAt,
      refreshExpiresAt: t.refreshExpiresAt ?? channel.refreshExpiresAt,
      tokenScope: t.scope ?? channel.tokenScope,
      lastError: null,
    },
  });
}

/** 게시에 쓸 토큰·계정 ID. 실연동 채널이면 먼저 갱신을 확인한다(content.ts publishOne 이 부른다). */
export async function socialPublishAuth(channel: ChannelRow): Promise<{ accessToken: string | null; accountId: string | null }> {
  const fresh = await refreshIfNeeded(channel);
  return { accessToken: fresh.accessTokenEnc ? decrypt(fresh.accessTokenEnc) : null, accountId: fresh.externalId ?? null };
}

/** 지표 수집(content.ts 배치). 실연동 게시만, 연결이 살아 있을 때만. */
export async function collectSocialMetrics(publish: { itemId: string; platform: string; externalPostId: string | null }): Promise<SnsMetrics | null> {
  const adapter = getSnsAdapter();
  if (adapter.info().mode === 'mock') return adapter.metrics(publish.platform, publish.externalPostId);
  const item = await prisma.contentItem.findUnique({ where: { id: publish.itemId }, select: { merchantId: true } });
  if (!item || !dbSupportsPlatform(publish.platform)) return null;
  const channel = await prisma.socialChannel.findUnique({ where: { merchantId_platform: { merchantId: item.merchantId, platform: publish.platform as SocialPlatform } } });
  if (!channel || channel.mock || channel.status !== 'CONNECTED') return null;
  const auth = await socialPublishAuth(channel).catch(() => null);
  if (!auth?.accessToken) return null;
  return adapter.metrics(publish.platform, publish.externalPostId, auth);
}

/** 유튜브 비공개 업로드 → 공개 전환 (/studio/content/[id] "공개로 전환") */
export async function makeYoutubePublic(merchantId: string, publishId: string, userId: string) {
  const p = await prisma.contentPublish.findFirst({ where: { id: publishId, item: { merchantId } } });
  if (!p) throw new SocialOAuthError('not_found', '게시 기록을 찾을 수 없습니다.');
  if (p.platform !== 'YOUTUBE' || p.status !== 'PRIVATE_UPLOADED') throw new SocialOAuthError('state', '비공개로 올라간 유튜브 영상만 공개로 전환할 수 있습니다.');
  if (p.mock || !p.externalPostId) throw new SocialOAuthError('mock', 'mock 게시는 실제로 올라가지 않아 공개 전환할 수 없습니다.');
  if (platformMissingCredentials('YOUTUBE').length) throw new SocialOAuthError('not_configured', '유튜브 연결 키가 없습니다.');
  const channel = await prisma.socialChannel.findUnique({ where: { merchantId_platform: { merchantId, platform: 'YOUTUBE' } } });
  if (!channel || channel.mock) throw new SocialOAuthError('no_channel', '유튜브 채널이 연결되어 있지 않습니다.');
  let auth;
  try {
    auth = await socialPublishAuth(channel);
  } catch (e) {
    throw new SocialOAuthError('expired', (e as Error).message);
  }
  try {
    await youtubeSetPublic(auth.accessToken!, p.externalPostId);
  } catch (e) {
    throw new SocialOAuthError('provider', (e as Error).message);
  }
  const updated = await prisma.contentPublish.update({ where: { id: p.id }, data: { status: 'PUBLISHED', error: null } });
  await writeSocialAudit({ actorUserId: userId, action: 'SOCIAL_PUBLISH_MAKE_PUBLIC', merchantId, after: { publishId, platform: 'YOUTUBE', videoId: p.externalPostId } });
  return updated;
}

// ---------------------------------------------------------------------------
// 화면 상태
// ---------------------------------------------------------------------------

export type SocialPlatformState = 'MOCK' | 'NO_API' | 'NO_KEYS' | 'DB_PENDING' | 'CONNECTABLE' | 'CONNECTED' | 'EXPIRED';

export const SOCIAL_STATE_LABEL: Record<SocialPlatformState, string> = {
  MOCK: 'mock',
  NO_API: '공개 API 없음',
  NO_KEYS: '키 없음',
  DB_PENDING: '준비 중',
  CONNECTABLE: '연결 가능',
  CONNECTED: '연결됨',
  EXPIRED: '만료',
};

/** 플랫폼별 연결 상태(키 없음 / 연결 가능 / 연결됨 / 만료). merchantId 없으면 공급자 상태만(관리자 화면). */
export async function socialPlatformStates(merchantId?: string) {
  const channels = merchantId ? await prisma.socialChannel.findMany({ where: { merchantId } }) : [];
  const by = new Map<string, (typeof channels)[number]>(channels.map((c) => [c.platform as string, c]));
  const mock = env.automation.socialProvider === 'mock';
  return SNS_PLATFORMS.map((p) => {
    const c = by.get(p) ?? null;
    const missing = SNS_OAUTH_FAMILY[p] ? platformMissingCredentials(p) : [];
    let state: SocialPlatformState;
    if (!SNS_OAUTH_FAMILY[p]) state = 'NO_API';
    else if (c?.status === 'CONNECTED' && (mock ? c.mock : !c.mock)) state = 'CONNECTED';
    else if (c?.status === 'EXPIRED') state = 'EXPIRED';
    else if (mock) state = 'MOCK';
    else if (missing.length) state = 'NO_KEYS';
    else if (!dbSupportsPlatform(p)) state = 'DB_PENDING';
    else state = 'CONNECTABLE';
    return { platform: p, label: SNS_PLATFORM_LABEL[p], slug: SNS_PLATFORM_SLUG[p], state, missing, channel: c };
  });
}
