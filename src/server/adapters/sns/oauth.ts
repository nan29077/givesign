import { createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from '@/lib/env';
import { call, expectJson, form, SnsApiError } from './http';
import { SNS_OAUTH_FAMILY, socialRedirectUri, type SnsPlatform } from './platforms';

/**
 * SNS 계정 연결 OAuth (공급자 통신만. DB·쿠키는 services/social-oauth.ts 가 맡는다).
 *
 * - 구글(유튜브): OAuth 2.0 웹 서버 흐름 + PKCE(S256). access_type=offline · prompt=consent 로 리프레시 토큰을 받는다.
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 * - 메타(인스타그램·페이스북): 페이스북 로그인 → 단기 사용자 토큰 → 장기 사용자 토큰(fb_exchange_token)
 *   → /me/accounts 의 **페이지 액세스 토큰**(장기 사용자 토큰에서 받은 페이지 토큰은 만료 시각이 없다).
 *   인스타그램은 페이지에 연결된 instagram_business_account 를 쓴다. 리프레시 토큰이 없으므로 다시 연결해야 갱신된다.
 * - 틱톡: Login Kit v2 (https://www.tiktok.com/v2/auth/authorize/ → https://open.tiktokapis.com/v2/oauth/token/).
 *   웹 앱은 PKCE 를 쓰지 않는다(틱톡 PKCE 는 데스크톱·모바일용이며 code_challenge 형식이 표준과 다르다).
 */

export interface OAuthAccount {
  externalId: string;
  name: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
  scope: string | null;
}

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
export const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];
export const META_SCOPES: Record<'INSTAGRAM' | 'FACEBOOK', string[]> = {
  INSTAGRAM: ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement', 'business_management'],
  FACEBOOK: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'read_insights'],
};

export function graphBase() {
  return `https://graph.facebook.com/${env.integrations.social.metaGraphVersion}`;
}

/** 메타 권장: 서버 호출에 appsecret_proof = HMAC-SHA256(app secret, access token) */
export function appSecretProof(accessToken: string) {
  return createHmac('sha256', env.integrations.social.metaAppSecret).update(accessToken).digest('hex');
}

/** PKCE 를 쓰는 플랫폼 */
export function usesPkce(p: SnsPlatform) {
  return SNS_OAUTH_FAMILY[p] === 'google';
}

export function newPkceVerifier() {
  return randomBytes(48).toString('base64url');
}

export function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function secondsFromNow(v: unknown): Date | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 1000) : null;
}

export function buildAuthorizeUrl(p: SnsPlatform, state: string, codeChallenge: string | null): string {
  const s = env.integrations.social;
  const redirect = socialRedirectUri(p);
  const fam = SNS_OAUTH_FAMILY[p];
  if (fam === 'google') {
    const q = form({
      client_id: s.googleClientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: YOUTUBE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallenge ? 'S256' : null,
    });
    return `${GOOGLE_AUTH_URL}?${q}`;
  }
  if (fam === 'meta') {
    const q = form({
      client_id: s.metaAppId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: META_SCOPES[p as 'INSTAGRAM' | 'FACEBOOK'].join(','),
      state,
    });
    return `https://www.facebook.com/${s.metaGraphVersion}/dialog/oauth?${q}`;
  }
  if (fam === 'tiktok') {
    const q = form({ client_key: s.tiktokClientKey, redirect_uri: redirect, response_type: 'code', scope: TIKTOK_SCOPES.join(','), state });
    return `${TIKTOK_AUTH_URL}?${q}`;
  }
  throw new SnsApiError('이 플랫폼은 공개 게시 API 가 없어 계정을 연결하지 않습니다.', 0, 'NO_PUBLIC_API');
}

// ---------------------------------------------------------------------------
// 코드 교환 + 계정 조회
// ---------------------------------------------------------------------------

async function googleToken(params: Record<string, string>) {
  const s = env.integrations.social;
  const res = await call(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: s.googleClientId, client_secret: s.googleClientSecret, ...params }),
  });
  const b = await expectJson(res, '구글 토큰 발급');
  if (typeof b.access_token !== 'string') throw new SnsApiError('구글 토큰 응답에 access_token 이 없습니다.', res.status);
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : null,
    expiresAt: secondsFromNow(b.expires_in),
    refreshExpiresAt: secondsFromNow(b.refresh_token_expires_in),
    scope: typeof b.scope === 'string' ? b.scope : null,
  } satisfies OAuthTokens;
}

async function youtubeAccount(accessToken: string): Promise<OAuthAccount> {
  const res = await call('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${accessToken}` } });
  const b = await expectJson(res, '유튜브 채널 조회');
  const item = (b.items as Array<{ id?: string; snippet?: { title?: string } }> | undefined)?.[0];
  if (!item?.id) throw new SnsApiError('이 구글 계정에 유튜브 채널이 없습니다. 채널을 만든 뒤 다시 연결해 주세요.', 200, 'NO_CHANNEL');
  return { externalId: item.id, name: item.snippet?.title ?? item.id };
}

async function metaGet(path: string, params: Record<string, string>) {
  const res = await call(`${graphBase()}${path}?${form(params)}`);
  return expectJson(res, '메타 그래프 API');
}

async function metaConnect(p: 'INSTAGRAM' | 'FACEBOOK', code: string): Promise<{ tokens: OAuthTokens; account: OAuthAccount }> {
  const s = env.integrations.social;
  const short = await metaGet('/oauth/access_token', { client_id: s.metaAppId, client_secret: s.metaAppSecret, redirect_uri: socialRedirectUri(p), code });
  if (typeof short.access_token !== 'string') throw new SnsApiError('메타 토큰 응답에 access_token 이 없습니다.', 200);
  const long = await metaGet('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: s.metaAppId, client_secret: s.metaAppSecret, fb_exchange_token: short.access_token });
  const userToken = typeof long.access_token === 'string' ? long.access_token : short.access_token;
  const pages = await metaGet('/me/accounts', {
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    access_token: userToken,
    appsecret_proof: appSecretProof(userToken),
  });
  type Page = { id: string; name?: string; access_token?: string; instagram_business_account?: { id?: string; username?: string } };
  const list = ((pages.data as Page[] | undefined) ?? []).filter((x) => x.id && x.access_token);
  // 페이지가 여럿이면 첫 번째를 쓴다(인스타는 인스타 계정이 연결된 첫 페이지). 페이지 선택 화면은 아직 없다.
  const page = p === 'INSTAGRAM' ? list.find((x) => x.instagram_business_account?.id) : list[0];
  if (!page) {
    throw new SnsApiError(
      p === 'INSTAGRAM'
        ? '페이스북 페이지에 연결된 인스타그램 비즈니스 계정을 찾지 못했습니다. 계정 유형과 페이지 연결을 확인해 주세요.'
        : '관리 권한이 있는 페이스북 페이지를 찾지 못했습니다.',
      200,
      'NO_PAGE',
    );
  }
  const tokens: OAuthTokens = { accessToken: page.access_token!, refreshToken: null, expiresAt: null, refreshExpiresAt: null, scope: META_SCOPES[p].join(',') };
  const account =
    p === 'INSTAGRAM'
      ? { externalId: page.instagram_business_account!.id!, name: page.instagram_business_account!.username ? `@${page.instagram_business_account!.username}` : (page.name ?? page.id) }
      : { externalId: page.id, name: page.name ?? page.id };
  return { tokens, account };
}

async function tiktokToken(params: Record<string, string>): Promise<OAuthTokens & { openId: string | null }> {
  const s = env.integrations.social;
  const res = await call(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: form({ client_key: s.tiktokClientKey, client_secret: s.tiktokClientSecret, ...params }),
  });
  const b = await expectJson(res, '틱톡 토큰 발급');
  if (typeof b.access_token !== 'string') {
    const code = typeof b.error === 'string' ? b.error : null;
    throw new SnsApiError(`틱톡 토큰 발급 실패: ${String(b.error_description ?? b.error ?? '응답에 access_token 이 없습니다')}`, res.status, code, code === 'invalid_grant');
  }
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : null,
    expiresAt: secondsFromNow(b.expires_in),
    refreshExpiresAt: secondsFromNow(b.refresh_expires_in),
    scope: typeof b.scope === 'string' ? b.scope : null,
    openId: typeof b.open_id === 'string' ? b.open_id : null,
  };
}

async function tiktokAccount(accessToken: string, openId: string | null): Promise<OAuthAccount> {
  const res = await call('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', { headers: { Authorization: `Bearer ${accessToken}` } });
  const b = await expectJson(res, '틱톡 계정 조회');
  const u = ((b.data as { user?: { open_id?: string; display_name?: string } } | undefined)?.user) ?? {};
  const id = u.open_id ?? openId;
  if (!id) throw new SnsApiError('틱톡 계정 정보를 받지 못했습니다.', 200);
  return { externalId: id, name: u.display_name ?? id };
}

/** 콜백 코드 → 토큰 + 연결 계정 */
export async function exchangeCode(p: SnsPlatform, code: string, codeVerifier: string | null): Promise<{ tokens: OAuthTokens; account: OAuthAccount }> {
  const fam = SNS_OAUTH_FAMILY[p];
  if (fam === 'google') {
    const tokens = await googleToken({ code, grant_type: 'authorization_code', redirect_uri: socialRedirectUri(p), ...(codeVerifier ? { code_verifier: codeVerifier } : {}) });
    return { tokens, account: await youtubeAccount(tokens.accessToken) };
  }
  if (fam === 'meta') return metaConnect(p as 'INSTAGRAM' | 'FACEBOOK', code);
  if (fam === 'tiktok') {
    const { openId, ...tokens } = await tiktokToken({ code, grant_type: 'authorization_code', redirect_uri: socialRedirectUri(p) });
    return { tokens, account: await tiktokAccount(tokens.accessToken, openId) };
  }
  throw new SnsApiError('이 플랫폼은 계정을 연결하지 않습니다.', 0, 'NO_PUBLIC_API');
}

/** 리프레시 토큰으로 액세스 토큰 갱신. 메타는 리프레시 토큰이 없어 다시 연결해야 한다. */
export async function refreshTokens(p: SnsPlatform, refreshToken: string): Promise<OAuthTokens> {
  const fam = SNS_OAUTH_FAMILY[p];
  if (fam === 'google') {
    const t = await googleToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return { ...t, refreshToken: t.refreshToken ?? refreshToken };
  }
  if (fam === 'tiktok') {
    const { openId: _o, ...t } = await tiktokToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
    void _o;
    return { ...t, refreshToken: t.refreshToken ?? refreshToken };
  }
  throw new SnsApiError('이 플랫폼은 토큰 갱신을 지원하지 않습니다. 다시 연결해 주세요.', 0, 'NO_REFRESH', true);
}
