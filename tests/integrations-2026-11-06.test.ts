import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { decrypt, encrypt } from '@/lib/crypto';
import { env, integrationBootProblems } from '@/lib/env';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { liveSnsAdapter } from '@/server/adapters/sns/live';
import { metaPolling } from '@/server/adapters/sns/meta';
import { platformMissingCredentials } from '@/server/adapters/sns/platforms';
import { readMockOutbox } from '@/server/adapters/mt';
import { getAlimtalkAdapter } from '@/server/adapters/alimtalk';
import { solapiAuthorization, SOLAPI_SEND_URL } from '@/server/adapters/alimtalk/solapi';
import { getMailAdapter, mailIsLive, readMockMailOutbox } from '@/server/adapters/mail';
import { signRequest } from '@/server/adapters/mail/sigv4';
import {
  completeSocialConnect,
  makeYoutubePublic,
  refreshIfNeeded,
  signSocialState,
  SocialOAuthError,
  SocialTokenExpiredError,
  socialPlatformStates,
  startSocialConnect,
} from '@/server/services/social-oauth';
import { processContentQueue } from '@/server/services/content';
import { sendMtDetailed } from '@/server/services/charge-flow';
import { saveAlimtalkChannel, setAlimtalkChannelStatus } from '@/server/services/alimtalk';
import { requestPasswordReset } from '@/server/services/password-reset';
import { confirmDonorEmail, sendDonorEmailVerification, sendDocumentMail } from '@/server/services/mail';
import * as tpl from '@/server/services/mt-templates';

/**
 * 7단계 외부 연동 — 실제 네트워크 없이 globalThis.fetch 를 가짜로 바꿔 요청 형태·서명·응답 처리를 검증한다.
 */

type Call = { url: string; method: string; headers: Record<string, string>; body: string | Uint8Array | null };
type Responder = (c: Call) => Response | null;

let calls: Call[] = [];
let responders: Responder[] = [];
const realFetch = globalThis.fetch;

function headersOf(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

function installFetch() {
  calls = [];
  responders = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body == null ? null : typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : (init.body as Uint8Array);
    const c: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers: headersOf(init?.headers), body };
    calls.push(c);
    for (const r of responders) {
      const res = r(c);
      if (res) return res;
    }
    throw new Error(`예상하지 못한 요청: ${c.method} ${url}`);
  }) as typeof fetch;
}

function on(method: string, match: string | RegExp, res: () => Response) {
  responders.push((c) => (c.method === method && (typeof match === 'string' ? c.url.startsWith(match) : match.test(c.url)) ? res() : null));
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });
const formOf = (c: Call) => new URLSearchParams(typeof c.body === 'string' ? c.body : '');

// env 스냅샷(테스트마다 되돌린다)
const S = env.integrations.social as unknown as Record<string, string>;
const A = env.integrations.alimtalk as unknown as Record<string, string>;
const M = env.integrations.mail as unknown as Record<string, string>;
const AUTO = env.automation as unknown as Record<string, unknown>;
const SAFE = env.safety as unknown as Record<string, unknown>;
const snap = { S: { ...S }, A: { ...A }, M: { ...M }, AUTO: { ...AUTO }, SAFE: { ...SAFE } };

function liveSocial() {
  AUTO.socialProvider = 'live';
  Object.assign(S, {
    googleClientId: 'g-client', googleClientSecret: 'g-secret',
    metaAppId: 'meta-app', metaAppSecret: 'meta-secret', metaGraphVersion: 'v26.0',
    tiktokClientKey: 'tt-key', tiktokClientSecret: 'tt-secret',
    stateSecret: 'test-state-secret',
  });
}

let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  installFetch();
  metaPolling.intervalMs = 1;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(S, snap.S);
  Object.assign(A, snap.A);
  Object.assign(M, snap.M);
  Object.assign(AUTO, snap.AUTO);
  Object.assign(SAFE, snap.SAFE);
  vi.restoreAllMocks();
});

async function connectedChannel(platform: 'YOUTUBE' | 'INSTAGRAM' | 'FACEBOOK', extra: Partial<{ expiresAt: Date | null; refreshTokenEnc: string | null; externalId: string }> = {}) {
  return prisma.socialChannel.create({
    data: {
      id: newId(), merchantId: fx.merchantId, platform, accountName: '기관 채널', status: 'CONNECTED', mock: false, connectedBy: fx.merchantUserId,
      accessTokenEnc: encrypt('ACCESS-OLD'), externalId: extra.externalId ?? 'ACC-1',
      refreshTokenEnc: extra.refreshTokenEnc === undefined ? encrypt('REFRESH-1') : extra.refreshTokenEnc,
      expiresAt: extra.expiresAt === undefined ? new Date(Date.now() + 3600_000) : extra.expiresAt,
    },
  });
}

// ---------------------------------------------------------------------------
describe('[1] SNS OAuth 연결', () => {
  it('키가 없으면 연결을 시작하지 않고 공급자를 부르지 않는다', () => {
    AUTO.socialProvider = 'live';
    Object.assign(S, { googleClientId: '', googleClientSecret: '', stateSecret: 'x' });
    expect(platformMissingCredentials('YOUTUBE')).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(() => startSocialConnect({ merchantId: fx.merchantId, userId: fx.merchantUserId, platform: 'YOUTUBE' })).toThrow(SocialOAuthError);
    // 네이버 블로그·카카오 채널은 공개 게시 API 가 없어 연결하지 않는다
    liveSocial();
    expect(() => startSocialConnect({ merchantId: fx.merchantId, userId: fx.merchantUserId, platform: 'NAVER_BLOG' })).toThrow(/공개 게시 API/);
    expect(calls).toHaveLength(0);
  });

  it('유튜브는 PKCE(S256) + offline + consent 로 동의 화면을 연다. 메타는 PKCE 없이 연다', () => {
    liveSocial();
    const s = startSocialConnect({ merchantId: fx.merchantId, userId: fx.merchantUserId, platform: 'YOUTUBE' });
    const u = new URL(s.authorizeUrl);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly');
    expect(u.searchParams.get('redirect_uri')).toBe(`${env.baseUrl}/api/studio/social/youtube/callback`);
    const [nonce, verifier] = s.cookieValue.split('.');
    expect(nonce).toBeTruthy();
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier!).digest('base64url'));
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');

    const m = new URL(startSocialConnect({ merchantId: fx.merchantId, userId: fx.merchantUserId, platform: 'INSTAGRAM' }).authorizeUrl);
    expect(m.hostname).toBe('www.facebook.com');
    expect(m.pathname).toBe('/v26.0/dialog/oauth');
    expect(m.searchParams.get('scope')).toContain('instagram_content_publish');
    expect(m.searchParams.get('code_challenge')).toBeNull();
  });

  it('state 위조·만료·다른 기관·다른 브라우저는 거절하고 코드를 교환하지 않는다', async () => {
    liveSocial();
    const s = startSocialConnect({ merchantId: fx.merchantId, userId: fx.merchantUserId, platform: 'YOUTUBE' });
    const state = new URL(s.authorizeUrl).searchParams.get('state')!;
    const base = { sessionMerchantId: fx.merchantId, sessionUserId: fx.merchantUserId, platform: 'YOUTUBE' as const, code: 'CODE', cookieValue: s.cookieValue };

    // 위조: 내용을 바꾸면 서명이 맞지 않는다
    const [body] = state.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), m: 'other-merchant' })).toString('base64url');
    await expect(completeSocialConnect({ ...base, state: `${forgedBody}.${state.split('.')[1]}` })).rejects.toMatchObject({ code: 'state_invalid' });
    // 다른 비밀로 서명한 state
    const prev = S.stateSecret;
    S.stateSecret = 'attacker';
    const attacker = signSocialState({ m: fx.merchantId, p: 'YOUTUBE', u: 'x', n: s.cookieValue.split('.')[0]!, e: Date.now() + 60_000 });
    S.stateSecret = prev;
    await expect(completeSocialConnect({ ...base, state: attacker })).rejects.toMatchObject({ code: 'state_invalid' });
    // 만료 (10분 뒤)
    await expect(completeSocialConnect({ ...base, state, now: Date.now() + 11 * 60_000 })).rejects.toMatchObject({ code: 'state_expired' });
    // 다른 기관 세션
    await expect(completeSocialConnect({ ...base, state, sessionMerchantId: 'another-merchant' })).rejects.toMatchObject({ code: 'merchant_mismatch' });
    // 다른 브라우저(쿠키 nonce 불일치)
    await expect(completeSocialConnect({ ...base, state, cookieValue: 'wrong.nonce' })).rejects.toMatchObject({ code: 'state_invalid' });
    // 다른 플랫폼 콜백에 붙여 넣기
    await expect(completeSocialConnect({ ...base, state, platform: 'FACEBOOK' })).rejects.toMatchObject({ code: 'state_invalid' });
    expect(calls).toHaveLength(0);
    expect(await prisma.socialChannel.count()).toBe(0);
  });

  it('구글 코드 교환 요청 형태 → 채널 조회 → 토큰은 암호화로만 저장 + 감사로그', async () => {
    liveSocial();
    on('POST', 'https://oauth2.googleapis.com/token', () => json({ access_token: 'ya29.ACCESS-SECRET', refresh_token: '1//REFRESH-SECRET', expires_in: 3599, scope: 'youtube.upload youtube.readonly', token_type: 'Bearer' }));
    on('GET', 'https://www.googleapis.com/youtube/v3/channels', () => json({ items: [{ id: 'UC123', snippet: { title: '햇살복지관 채널' } }] }));
    const s = startSocialConnect({ merchantId: fx.merchantId, userId: fx.merchantUserId, platform: 'YOUTUBE' });
    const state = new URL(s.authorizeUrl).searchParams.get('state')!;
    const ch = await completeSocialConnect({ sessionMerchantId: fx.merchantId, sessionUserId: fx.merchantUserId, platform: 'YOUTUBE', code: 'AUTH-CODE', state, cookieValue: s.cookieValue });

    const tokenCall = calls[0]!;
    expect(tokenCall.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const f = formOf(tokenCall);
    expect(f.get('grant_type')).toBe('authorization_code');
    expect(f.get('code')).toBe('AUTH-CODE');
    expect(f.get('code_verifier')).toBe(s.cookieValue.split('.')[1]);
    expect(f.get('redirect_uri')).toBe(`${env.baseUrl}/api/studio/social/youtube/callback`);
    expect(f.get('client_id')).toBe('g-client');
    expect(f.get('client_secret')).toBe('g-secret');
    expect(calls[1]!.headers.authorization).toBe('Bearer ya29.ACCESS-SECRET');

    expect(ch).toMatchObject({ status: 'CONNECTED', mock: false, externalId: 'UC123', accountName: '햇살복지관 채널' });
    expect(ch.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3000_000);
    const raw = await prisma.$queryRawUnsafe<Array<{ j: string }>>(`SELECT row_to_json(s)::text AS j FROM social_channel s WHERE id = $1`, ch.id);
    expect(raw[0]!.j).not.toContain('ACCESS-SECRET');
    expect(raw[0]!.j).not.toContain('REFRESH-SECRET');
    expect(decrypt(ch.accessTokenEnc!)).toBe('ya29.ACCESS-SECRET');
    expect(decrypt(ch.refreshTokenEnc!)).toBe('1//REFRESH-SECRET');
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'SOCIAL_CHANNEL_OAUTH_CONNECT', targetId: fx.merchantId } });
    expect(JSON.stringify(audit)).not.toContain('SECRET');

    const states = await socialPlatformStates(fx.merchantId);
    expect(states.find((x) => x.platform === 'YOUTUBE')!.state).toBe('CONNECTED');
    expect(states.find((x) => x.platform === 'FACEBOOK')!.state).toBe('CONNECTABLE');
    expect(states.find((x) => x.platform === 'KAKAO_CHANNEL')!.state).toBe('NO_API');
  });

  it('메타 연결: 단기 → 장기 토큰 → 페이지 토큰, 인스타는 페이지의 비즈니스 계정', async () => {
    liveSocial();
    on('GET', 'https://graph.facebook.com/v26.0/oauth/access_token', () => json({ access_token: 'USER-TOKEN' }));
    on('GET', 'https://graph.facebook.com/v26.0/me/accounts', () => json({ data: [{ id: 'PAGE1', name: '햇살 페이지', access_token: 'PAGE-TOKEN', instagram_business_account: { id: 'IG1', username: 'sunshine' } }] }));
    const s = startSocialConnect({ merchantId: fx.merchantId, userId: fx.merchantUserId, platform: 'INSTAGRAM' });
    const ch = await completeSocialConnect({ sessionMerchantId: fx.merchantId, sessionUserId: fx.merchantUserId, platform: 'INSTAGRAM', code: 'C', state: new URL(s.authorizeUrl).searchParams.get('state'), cookieValue: s.cookieValue });
    expect(ch).toMatchObject({ externalId: 'IG1', accountName: '@sunshine', expiresAt: null, refreshTokenEnc: null });
    expect(decrypt(ch.accessTokenEnc!)).toBe('PAGE-TOKEN');
    const accounts = new URL(calls[2]!.url);
    expect(accounts.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', 'meta-secret').update('USER-TOKEN').digest('hex'));
    expect(new URL(calls[1]!.url).searchParams.get('grant_type')).toBe('fb_exchange_token');
  });
});

// ---------------------------------------------------------------------------
describe('[2] 토큰 갱신', () => {
  it('만료가 가까우면 리프레시 토큰으로 갱신해 다시 암호화 저장한다', async () => {
    liveSocial();
    const ch = await connectedChannel('YOUTUBE', { expiresAt: new Date(Date.now() + 60_000) });
    on('POST', 'https://oauth2.googleapis.com/token', () => json({ access_token: 'ACCESS-NEW', expires_in: 3600 }));
    const fresh = await refreshIfNeeded(ch);
    expect(formOf(calls[0]!).get('grant_type')).toBe('refresh_token');
    expect(formOf(calls[0]!).get('refresh_token')).toBe('REFRESH-1');
    expect(decrypt(fresh.accessTokenEnc!)).toBe('ACCESS-NEW');
    expect(decrypt(fresh.refreshTokenEnc!)).toBe('REFRESH-1'); // 구글이 새 리프레시 토큰을 주지 않으면 기존 것을 유지
  });

  it('갱신 실패 → 채널 EXPIRED + 기관 인앱 알림, 알림은 한 번만', async () => {
    liveSocial();
    const ch = await connectedChannel('YOUTUBE', { expiresAt: new Date(Date.now() - 1000) });
    on('POST', 'https://oauth2.googleapis.com/token', () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    await expect(refreshIfNeeded(ch)).rejects.toThrow(SocialTokenExpiredError);
    const after = await prisma.socialChannel.findUniqueOrThrow({ where: { id: ch.id } });
    expect(after.status).toBe('EXPIRED');
    expect(after.lastError).toMatch(/expired or revoked/);
    const notes = await prisma.notification.findMany({ where: { userId: fx.merchantUserId } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toMatch(/유튜브 연결이 만료/);
    await expect(refreshIfNeeded(ch)).rejects.toThrow(SocialTokenExpiredError);
    expect(await prisma.notification.count({ where: { userId: fx.merchantUserId } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('[3] SNS 게시 요청 형태', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#28634e"/></svg>';

  it('키가 없으면 게시 공급자를 부르지 않는다', async () => {
    AUTO.socialProvider = 'live';
    Object.assign(S, { googleClientId: '', googleClientSecret: '', metaAppId: '', metaAppSecret: '', tiktokClientKey: '', tiktokClientSecret: '' });
    const r = await liveSnsAdapter.publish({ platform: 'YOUTUBE', accessToken: 't', caption: 'c', title: 't', assets: [], kind: 'SHORTFORM', videoUrl: 'https://cdn.example/v.mp4' });
    expect(r).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    const k = await liveSnsAdapter.publish({ platform: 'KAKAO_CHANNEL', accessToken: 't', caption: 'c', title: 't', assets: [svg], kind: 'IMAGE_SQUARE' });
    expect(k.ok).toBe(false);
    expect(await liveSnsAdapter.metrics('YOUTUBE', 'vid', { accessToken: 't' })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('유튜브 resumable 2단계: 메타데이터 POST(비공개) → Location 으로 바이트 PUT → PRIVATE_UPLOADED', async () => {
    liveSocial();
    on('GET', 'https://cdn.example/v.mp4', () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200, headers: { 'content-type': 'video/mp4' } }));
    on('POST', 'https://www.googleapis.com/upload/youtube/v3/videos', () => new Response(null, { status: 200, headers: { Location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=SESSION1' } }));
    on('PUT', 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=SESSION1', () => json({ id: 'VID123', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } }));
    const r = await liveSnsAdapter.publish({ platform: 'YOUTUBE', accessToken: 'YT-TOKEN', caption: '캡션 #나눔 #희망', title: '겨울나기', assets: [], kind: 'SHORTFORM', videoUrl: 'https://cdn.example/v.mp4' });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ status: 'PRIVATE_UPLOADED', externalPostId: 'VID123', url: 'https://www.youtube.com/watch?v=VID123', mock: false });
    const init = calls[1]!;
    expect(init.url).toBe('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status');
    expect(init.headers.authorization).toBe('Bearer YT-TOKEN');
    expect(init.headers['x-upload-content-length']).toBe('5');
    expect(init.headers['x-upload-content-type']).toBe('video/mp4');
    const meta = JSON.parse(init.body as string);
    expect(meta.status).toMatchObject({ privacyStatus: 'private', containsSyntheticMedia: true });
    expect(meta.snippet).toMatchObject({ title: '겨울나기', tags: ['나눔', '희망'] });
    const put = calls[2]!;
    expect(put.method).toBe('PUT');
    expect(Array.from(put.body as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
  });

  it('영상 주소가 없으면 유튜브·릴스·틱톡 영상은 요청 없이 실패 사유를 돌려준다', async () => {
    liveSocial();
    for (const platform of ['YOUTUBE', 'INSTAGRAM', 'FACEBOOK'] as const) {
      const r = await liveSnsAdapter.publish({ platform, accessToken: 't', accountId: 'A', caption: 'c', title: 't', assets: [], kind: 'SHORTFORM' });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/영상 파일이 없습니다/);
    }
    expect(calls).toHaveLength(0);
  });

  it('인스타그램: SVG → JPEG 공개 주소 → 캐러셀 자식 → 부모 컨테이너 → media_publish', async () => {
    liveSocial();
    let n = 0;
    on('POST', 'https://graph.facebook.com/v26.0/IG1/media_publish', () => json({ id: 'MEDIA9' }));
    on('POST', 'https://graph.facebook.com/v26.0/IG1/media', () => json({ id: `C${++n}` }));
    on('GET', 'https://graph.facebook.com/v26.0/MEDIA9', () => json({ permalink: 'https://www.instagram.com/p/abc/' }));
    const r = await liveSnsAdapter.publish({ platform: 'INSTAGRAM', accessToken: 'PAGE-TOKEN', accountId: 'IG1', caption: '캡션 AI 생성 콘텐츠', title: 't', assets: [svg, svg], kind: 'IMAGE_SQUARE' });
    expect(r.ok, r.message).toBe(true);
    expect(r.data).toMatchObject({ status: 'PUBLISHED', externalPostId: 'MEDIA9', url: 'https://www.instagram.com/p/abc/' });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => new URL(c.url).pathname)).toEqual(['/v26.0/IG1/media', '/v26.0/IG1/media', '/v26.0/IG1/media', '/v26.0/IG1/media_publish']);
    const child = formOf(posts[0]!);
    expect(child.get('is_carousel_item')).toBe('true');
    expect(child.get('image_url')).toMatch(/^https?:\/\/.+\.jpg$/);
    expect(child.get('access_token')).toBe('PAGE-TOKEN');
    expect(child.get('appsecret_proof')).toBe(createHmac('sha256', 'meta-secret').update('PAGE-TOKEN').digest('hex'));
    expect(posts[0]!.url).not.toContain('PAGE-TOKEN'); // 토큰은 주소가 아니라 본문으로
    const parent = formOf(posts[2]!);
    expect(parent.get('media_type')).toBe('CAROUSEL');
    expect(parent.get('children')).toBe('C1,C2');
    expect(parent.get('caption')).toContain('AI 생성 콘텐츠');
    expect(formOf(posts[3]!).get('creation_id')).toBe('C3');
  });

  it('인스타그램 릴스: video_url 컨테이너 → 처리 완료 대기 → 게시', async () => {
    liveSocial();
    let polled = 0;
    on('POST', 'https://graph.facebook.com/v26.0/IG1/media_publish', () => json({ id: 'REEL1' }));
    on('POST', 'https://graph.facebook.com/v26.0/IG1/media', () => json({ id: 'RC1' }));
    on('GET', 'https://graph.facebook.com/v26.0/RC1', () => json({ status_code: ++polled < 2 ? 'IN_PROGRESS' : 'FINISHED' }));
    on('GET', 'https://graph.facebook.com/v26.0/REEL1', () => json({ permalink: 'https://www.instagram.com/reel/x/' }));
    const r = await liveSnsAdapter.publish({ platform: 'INSTAGRAM', accessToken: 'T', accountId: 'IG1', caption: 'c', title: 't', assets: [], kind: 'SHORTFORM', videoUrl: 'https://cdn.example/r.mp4' });
    expect(r.ok, r.message).toBe(true);
    const c = formOf(calls[0]!);
    expect(c.get('media_type')).toBe('REELS');
    expect(c.get('video_url')).toBe('https://cdn.example/r.mp4');
    expect(polled).toBe(2);
  });

  it('페이스북: 사진 1장은 /photos, 여러 장은 published=false 업로드 후 /feed attached_media', async () => {
    liveSocial();
    on('POST', 'https://graph.facebook.com/v26.0/PAGE1/photos', () => json({ id: 'PH1', post_id: 'PAGE1_POST1' }));
    const one = await liveSnsAdapter.publish({ platform: 'FACEBOOK', accessToken: 'PT', accountId: 'PAGE1', caption: '메시지', title: 't', assets: [svg], kind: 'IMAGE_SQUARE' });
    expect(one.data).toMatchObject({ status: 'PUBLISHED', externalPostId: 'PAGE1_POST1', url: 'https://www.facebook.com/PAGE1_POST1' });
    const f = formOf(calls[0]!);
    expect(f.get('url')).toMatch(/\.png$/);
    expect(f.get('message')).toBe('메시지');
    expect(f.get('published')).toBe('true');

    calls.length = 0;
    responders.length = 0;
    let k = 0;
    on('POST', 'https://graph.facebook.com/v26.0/PAGE1/photos', () => json({ id: `P${++k}` }));
    on('POST', 'https://graph.facebook.com/v26.0/PAGE1/feed', () => json({ id: 'PAGE1_FEED' }));
    const many = await liveSnsAdapter.publish({ platform: 'FACEBOOK', accessToken: 'PT', accountId: 'PAGE1', caption: '여러 장', title: 't', assets: [svg, svg], kind: 'IMAGE_SQUARE' });
    expect(many.data?.externalPostId).toBe('PAGE1_FEED');
    expect(formOf(calls[0]!).get('published')).toBe('false');
    expect(JSON.parse(formOf(calls[2]!).get('attached_media')!)).toEqual([{ media_fbid: 'P1' }, { media_fbid: 'P2' }]);
  });

  it('틱톡: creator_info 확인 → video/init PULL_FROM_URL · SELF_ONLY · is_aigc → PRIVATE_UPLOADED', async () => {
    liveSocial();
    on('POST', 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/', () => json({ data: { privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'] }, error: { code: 'ok' } }));
    on('POST', 'https://open.tiktokapis.com/v2/post/publish/video/init/', () => json({ data: { publish_id: 'v_pub_1' }, error: { code: 'ok', message: '' } }));
    const r = await liveSnsAdapter.publish({ platform: 'TIKTOK', accessToken: 'TT', caption: '캡션', title: 't', assets: [], kind: 'SHORTFORM', videoUrl: '/api/media/0123456789abcdef0123456789abcdef.mp4' });
    expect(r.data).toEqual({ status: 'PRIVATE_UPLOADED', externalPostId: 'v_pub_1', url: null, mock: false });
    const init = calls[1]!;
    expect(init.headers.authorization).toBe('Bearer TT');
    expect(init.headers['content-type']).toBe('application/json; charset=UTF-8');
    const b = JSON.parse(init.body as string);
    expect(b.post_info).toMatchObject({ privacy_level: 'SELF_ONLY', is_aigc: true });
    expect(b.source_info).toEqual({ source: 'PULL_FROM_URL', video_url: `${env.baseUrl}/api/media/0123456789abcdef0123456789abcdef.mp4` });
  });

  it('틱톡 오류 응답(error.code != ok)은 실패로 돌려준다', async () => {
    liveSocial();
    on('POST', 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/', () => json({ data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } }));
    on('POST', 'https://open.tiktokapis.com/v2/post/publish/video/init/', () => json({ data: {}, error: { code: 'unaudited_client_can_only_post_to_private_accounts', message: 'private only' } }, 403));
    const r = await liveSnsAdapter.publish({ platform: 'TIKTOK', accessToken: 'TT', caption: 'c', title: 't', assets: [], kind: 'SHORTFORM', videoUrl: 'https://cdn.example/v.mp4' });
    expect(r).toMatchObject({ ok: false, code: 'unaudited_client_can_only_post_to_private_accounts' });
  });

  it('유튜브 공개 전환: videos.update status.privacyStatus=public → 게시 상태 PUBLISHED', async () => {
    liveSocial();
    await connectedChannel('YOUTUBE');
    const item = await prisma.contentItem.create({ data: { id: newId(), merchantId: fx.merchantId, kind: 'SHORTFORM', status: 'PUBLISHED', title: 't', provider: 'mock', createdBy: fx.merchantUserId } });
    const pub = await prisma.contentPublish.create({ data: { id: newId(), itemId: item.id, platform: 'YOUTUBE', status: 'PRIVATE_UPLOADED', mock: false, scheduledAt: new Date(), externalPostId: 'VID9' } });
    on('PUT', 'https://www.googleapis.com/youtube/v3/videos?part=status', () => json({ id: 'VID9', status: { privacyStatus: 'public' } }));
    const r = await makeYoutubePublic(fx.merchantId, pub.id, fx.merchantUserId);
    expect(r.status).toBe('PUBLISHED');
    expect(JSON.parse(calls[0]!.body as string)).toMatchObject({ id: 'VID9', status: { privacyStatus: 'public' } });
    expect(calls[0]!.headers.authorization).toBe('Bearer ACCESS-OLD');
    // 다른 기관은 전환할 수 없다
    await expect(makeYoutubePublic('other', pub.id, fx.merchantUserId)).rejects.toThrow(SocialOAuthError);
  });

  it('배치 게시(content.ts): 실연동 페이스북 채널로 올리고 지표를 수집한다', async () => {
    liveSocial();
    await connectedChannel('FACEBOOK', { externalId: 'PAGE1', expiresAt: null, refreshTokenEnc: null });
    const item = await prisma.contentItem.create({
      data: {
        id: newId(), merchantId: fx.merchantId, kind: 'IMAGE_SQUARE', status: 'SCHEDULED', title: '캠페인', provider: 'mock', createdBy: fx.merchantUserId,
        caption: '후원하기: {링크}\nAI 생성 콘텐츠', scenes: [{ caption: 'a', durationSec: 5, svg }], aiLabeled: true, regNoIncluded: true,
      },
    });
    const pub = await prisma.contentPublish.create({ data: { id: newId(), itemId: item.id, platform: 'FACEBOOK', status: 'SCHEDULED', mock: false, scheduledAt: new Date(Date.now() - 1000) } });
    on('POST', 'https://graph.facebook.com/v26.0/PAGE1/photos', () => json({ id: 'PH1', post_id: 'PAGE1_P1' }));
    on('GET', 'https://graph.facebook.com/v26.0/PAGE1_P1/insights', () => json({ data: [{ name: 'post_media_view', values: [{ value: 42 }] }] }));
    on('GET', 'https://graph.facebook.com/v26.0/PAGE1_P1', () => json({ reactions: { summary: { total_count: 7 } } }));
    const r = await processContentQueue(new Date());
    expect(r.published).toBe(1);
    const after = await prisma.contentPublish.findUniqueOrThrow({ where: { id: pub.id } });
    expect(after).toMatchObject({ status: 'PUBLISHED', mock: false, externalPostId: 'PAGE1_P1', url: 'https://www.facebook.com/PAGE1_P1', views: 42, likes: 7 });
    const msg = formOf(calls.find((c) => c.url.endsWith('/PAGE1/photos'))!).get('message')!;
    // 실제 게시 캡션은 클릭을 세는 기브싸인 짧은 링크(/go/게시 id)를 쓴다(6단계 연결).
    expect(msg).toContain(`/go/${pub.id}`);
    expect(msg).not.toContain('{링크}');
    expect(formOf(calls[0]!).get('access_token')).toBe('ACCESS-OLD');
  });

  it('배치 게시: 영상이 없는 숏폼은 공급자를 부르지 않고 재시도 없이 실패로 닫는다(2026-11-06 점검 낮음)', async () => {
    liveSocial();
    await connectedChannel('YOUTUBE');
    const item = await prisma.contentItem.create({
      data: { id: newId(), merchantId: fx.merchantId, kind: 'SHORTFORM', status: 'SCHEDULED', title: '숏폼', provider: 'mock', createdBy: fx.merchantUserId, caption: '{링크} AI 생성 콘텐츠', scenes: [], aiLabeled: true, regNoIncluded: true },
    });
    const pub = await prisma.contentPublish.create({ data: { id: newId(), itemId: item.id, platform: 'YOUTUBE', status: 'SCHEDULED', mock: false, scheduledAt: new Date(Date.now() - 1000) } });
    const r = await processContentQueue(new Date());
    expect(r.failed).toBe(1);
    const after = await prisma.contentPublish.findUniqueOrThrow({ where: { id: pub.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toMatch(/영상 파일이 없습니다/);
    // 모든 게시가 실패로 끝나면 콘텐츠가 '게시 예약' 에 남지 않는다
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('APPROVED');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('[4] 솔라피 알림톡', () => {
  it('서명: HMAC-SHA256(secret, date+salt) hex (고정 date·salt 기대값)', () => {
    const h = solapiAuthorization('NCSKEY', 'test-solapi-secret', '2026-11-06T00:00:00.000Z', '0123456789abcdef');
    expect(h).toBe('HMAC-SHA256 apiKey=NCSKEY, date=2026-11-06T00:00:00.000Z, salt=0123456789abcdef, signature=506dd1ecb0d19a65344b9640e20a9bfe38601549653e3b5258d9014d1a87ca5b');
  });

  async function activeChannel() {
    await saveAlimtalkChannel(fx.merchantId, { channelId: '@테스트복지관', senderKey: 'KA01PF2611060000000000ab', templateCodes: { RECURRING_STARTED: 'KA01TP_REC_01' } });
    await setAlimtalkChannelStatus(fx.merchantId, 'ACTIVE', 'admin');
  }
  function liveAlimtalk(keys = true) {
    SAFE.safeMode = false;
    AUTO.alimtalkProvider = 'coolsms';
    Object.assign(A, keys ? { apiKey: 'NCSKEY', apiSecret: 'NCSSECRET' } : { apiKey: '', apiSecret: '' });
  }
  const t = () => tpl.tplRecurringStarted({ merchantName: '기관', amount: 10000n, dayOfMonth: 5, nextDate: '2026-11-05' });

  it('키가 없으면 솔라피를 부르지 않고 문자로 대체한다', async () => {
    liveAlimtalk(false);
    await activeChannel();
    expect(getAlimtalkAdapter().info().missingCredentials.length).toBeGreaterThan(0);
    const r = await sendMtDetailed({ phone: fx.payerPhone, template: t(), merchantId: fx.merchantId });
    expect(r).toMatchObject({ ok: true, channel: 'SMS', fallback: true });
    expect(calls).toHaveLength(0);
  });

  it('접수 성공 → 알림톡으로 기록. 요청은 ATA + pfId·templateId + 공급자 대체 문자 끔', async () => {
    liveAlimtalk();
    await activeChannel();
    on('POST', SOLAPI_SEND_URL, () => json({ groupInfo: { groupId: 'G1' }, failedMessageList: [], messageList: [{ messageId: 'M4V2ATA1', statusCode: '2000', statusMessage: '정상 접수' }] }));
    const r = await sendMtDetailed({ phone: fx.payerPhone, template: t(), merchantId: fx.merchantId });
    expect(r).toMatchObject({ ok: true, channel: 'ALIMTALK', fallback: false });
    const c = calls[0]!;
    expect(c.url).toBe('https://api.solapi.com/messages/v4/send-many/detail');
    expect(c.headers.authorization).toMatch(/^HMAC-SHA256 apiKey=NCSKEY, date=\S+, salt=[0-9a-f]{32}, signature=[0-9a-f]{64}$/);
    const [, date, salt, sig] = /date=(\S+), salt=(\S+), signature=(\S+)$/.exec(c.headers.authorization!)!;
    expect(sig).toBe(createHmac('sha256', 'NCSSECRET').update(date!.replace(/,$/, '') + salt!.replace(/,$/, '')).digest('hex'));
    const b = JSON.parse(c.body as string);
    expect(b.messages[0]).toMatchObject({ to: fx.payerPhone, type: 'ATA', kakaoOptions: { pfId: 'KA01PF2611060000000000ab', templateId: 'KA01TP_REC_01', disableSms: true } });
    expect(b.messages[0].text).toBe(t().text);
    const row = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ channel: 'ALIMTALK', providerMessageId: 'M4V2ATA1', providerCode: 'alimtalk:coolsms' });
  });

  it('솔라피 실패 응답(failedMessageList · HTTP 오류) → 같은 본문을 문자로 대체', async () => {
    liveAlimtalk();
    await activeChannel();
    on('POST', SOLAPI_SEND_URL, () => json({ groupInfo: { groupId: 'G2' }, failedMessageList: [{ to: fx.payerPhone, statusCode: '3104', statusMessage: '템플릿 내용이 일치하지 않습니다.' }] }));
    const r = await sendMtDetailed({ phone: fx.payerPhone, template: t(), merchantId: fx.merchantId });
    expect(r).toMatchObject({ ok: true, channel: 'SMS', fallback: true });
    expect(readMockOutbox(3).some((m) => m.template === 'RECURRING_STARTED')).toBe(true);
    const ad = getAlimtalkAdapter();
    responders.length = 0;
    on('POST', SOLAPI_SEND_URL, () => json({ errorCode: 'NotEnoughBalance', errorMessage: '잔액이 부족합니다.' }, 402));
    const fail = await ad.send({ to: fx.payerPhone, senderKey: 'KA01PF', templateCode: 'T', text: 'x' });
    expect(fail).toMatchObject({ ok: false, code: 'NotEnoughBalance' });
    expect(fail.message).toMatch(/잔액 부족/);
  });
});

// ---------------------------------------------------------------------------
describe('[5] 메일(SES v2 · SigV4)', () => {
  function liveMail() {
    Object.assign(M, { provider: 'ses', from: 'no-reply@givesign.kr', sesRegion: 'ap-northeast-2', sesAccessKeyId: 'AKIDEXAMPLE', sesSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sesSessionToken: '' });
  }

  it('SigV4 서명은 @smithy/signature-v4 와 같은 값이다', async () => {
    const { SignatureV4 } = await import('@smithy/signature-v4');
    class Sha256 {
      private h;
      constructor(secret?: string | Uint8Array) {
        this.h = secret ? createHmac('sha256', Buffer.from(secret as Uint8Array)) : createHash('sha256');
      }
      update(d: string | Uint8Array) {
        this.h.update(typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d));
      }
      async digest() {
        return new Uint8Array(this.h.digest());
      }
      reset() {}
    }
    const date = new Date('2026-11-06T01:02:03Z');
    const body = JSON.stringify({ hello: '세계' });
    const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
    const ours = signRequest({ method: 'POST', url: 'https://email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails', headers: { 'content-type': 'application/json' }, body, region: 'ap-northeast-2', service: 'ses', credentials, date });
    const signer = new SignatureV4({ service: 'ses', region: 'ap-northeast-2', credentials, sha256: Sha256 as never });
    const signed = await signer.sign(
      { method: 'POST', protocol: 'https:', hostname: 'email.ap-northeast-2.amazonaws.com', path: '/v2/email/outbound-emails', query: {}, headers: { host: 'email.ap-northeast-2.amazonaws.com', 'content-type': 'application/json', 'x-amz-content-sha256': ours['x-amz-content-sha256']! }, body } as never,
      { signingDate: date },
    );
    expect(ours.authorization).toBe((signed as unknown as { headers: Record<string, string> }).headers.authorization);
    expect(ours.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261106\/ap-northeast-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(ours['x-amz-date']).toBe('20261106T010203Z');
  });

  it('SES 발송 요청 형태(엔드포인트·서명 헤더·본문)', async () => {
    liveMail();
    expect(mailIsLive()).toBe(true);
    on('POST', 'https://email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails', () => json({ MessageId: 'ses-1' }));
    const ok = await sendDocumentMail({ to: 'donor@example.com', merchantName: '햇살복지관', documentTitle: '기부금영수증', viewUrl: 'https://app.example/r/abc' });
    expect(ok).toBe(true);
    const c = calls[0]!;
    expect(c.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-northeast-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(c.headers['x-amz-content-sha256']).toBe(createHash('sha256').update(c.body as string).digest('hex'));
    const b = JSON.parse(c.body as string);
    expect(b).toMatchObject({ FromEmailAddress: 'no-reply@givesign.kr', Destination: { ToAddresses: ['donor@example.com'] } });
    expect(b.Content.Simple.Subject.Data).toBe('[햇살복지관] 기부금영수증');
    // 거절 응답은 실패
    responders.length = 0;
    on('POST', 'https://email.ap-northeast-2.amazonaws.com/', () => json({ message: 'Email address is not verified.' }, 400, { 'x-amzn-ErrorType': 'MessageRejected:http://internal' }));
    const r = await getMailAdapter().send({ to: 'a@b.c', subject: 's', text: 't', tag: 'T' });
    expect(r).toMatchObject({ ok: false, code: 'MessageRejected' });
  });

  it('자격 증명이 없으면 실연동이 아니며 SES 를 부르지 않는다', async () => {
    Object.assign(M, { provider: 'ses', from: 'no-reply@givesign.kr', sesAccessKeyId: '', sesSecretAccessKey: '' });
    expect(mailIsLive()).toBe(false);
    const r = await getMailAdapter().send({ to: 'a@b.c', subject: 's', text: 't', tag: 'T' });
    expect(r).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    expect(await sendDocumentMail({ to: 'a@b.c', merchantName: 'x', documentTitle: 'y', viewUrl: 'z' })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('비밀번호 재설정: 메일 실연동일 때만 메일로 보내고 링크를 화면·콘솔에 남기지 않는다', async () => {
    // 재설정은 소문자로 정규화한 이메일로 찾는다(시드 이메일에는 대문자 ULID 가 들어 있다)
    const user = await prisma.user.update({ where: { id: fx.merchantUserId }, data: { email: `reset-${Date.now()}@test.kr` } });
    // mock: 지금 동작 그대로 (로컬 devLink, 메일 없음)
    const mock = await requestPasswordReset(user.email!, null);
    expect(mock.mailLive).toBe(false);
    expect(mock.devLink).toMatch(/\/reset-password\//);
    expect(readMockMailOutbox()).toHaveLength(0);
    expect(calls).toHaveLength(0);

    liveMail();
    on('POST', 'https://email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails', () => json({ MessageId: 'ses-2' }));
    const log = vi.spyOn(console, 'log');
    const live = await requestPasswordReset(user.email!, null);
    expect(live).toEqual({ accepted: true, mailLive: true });
    expect(calls).toHaveLength(1);
    const b = JSON.parse(calls[0]!.body as string);
    expect(b.Destination.ToAddresses).toEqual([user.email]);
    expect(b.Content.Simple.Body.Text.Data).toMatch(/\/reset-password\/[A-Za-z0-9_-]+/);
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/reset-password/);
    // 가입되지 않은 이메일도 같은 응답(계정 열거 방지), 메일은 보내지 않는다
    expect(await requestPasswordReset('nobody@example.com', null)).toEqual({ accepted: true, mailLive: true });
    expect(calls).toHaveLength(1);
  });

  it('후원 회원 이메일 인증: 실연동일 때만 링크를 만들어 보내고, 같은 기관 링크로만 인증한다', async () => {
    const org = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: fx.merchantId }, select: { id: true, code: true, displayName: true } });
    const member = await prisma.donorMember.create({ data: { id: newId(), merchantId: org.id, email: 'donor@example.com', passwordHash: 'x', name: '후원자', termsAgreedAt: new Date() } });
    expect(await sendDonorEmailVerification(org, member.id)).toBe(false);
    expect(await prisma.donorEmailToken.count()).toBe(0);

    liveMail();
    on('POST', 'https://email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails', () => json({ MessageId: 'ses-3' }));
    expect(await sendDonorEmailVerification(org, member.id)).toBe(true);
    const text = JSON.parse(calls[0]!.body as string).Content.Simple.Body.Text.Data as string;
    const token = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(text)![1]!;
    const row = await prisma.donorEmailToken.findFirstOrThrow();
    expect(row.tokenHash).not.toBe(token);
    expect(await confirmDonorEmail({ id: 'other-merchant' }, token)).toBe('INVALID');
    expect(await confirmDonorEmail(org, token)).toBe('VERIFIED');
    expect((await prisma.donorMember.findUniqueOrThrow({ where: { id: member.id } })).emailVerifiedAt).not.toBeNull();
    expect(await confirmDonorEmail(org, token)).toBe('INVALID'); // 1회용
  });
});

// ---------------------------------------------------------------------------
describe('[6] 부팅 점검', () => {
  it('실공급자를 켰는데 필수 키가 비어 있으면 문제 목록에 올린다', () => {
    AUTO.socialProvider = 'live';
    AUTO.socialPublishEnabled = true;
    Object.assign(S, { stateSecret: '', googleClientId: 'g', googleClientSecret: '', metaAppId: '', metaAppSecret: '', tiktokClientKey: '', tiktokClientSecret: '' });
    AUTO.alimtalkEnabled = true;
    AUTO.alimtalkProvider = 'coolsms';
    Object.assign(A, { apiKey: '', apiSecret: '' });
    Object.assign(M, { provider: 'ses', from: '', sesAccessKeyId: '', sesSecretAccessKey: '' });
    const p = integrationBootProblems().join('\n');
    expect(p).toMatch(/SOCIAL_OAUTH_STATE_SECRET/);
    expect(p).toMatch(/GOOGLE_CLIENT_SECRET/);
    expect(p).toMatch(/어떤 플랫폼 키도 없습니다/);
    expect(p).toMatch(/ALIMTALK_API_KEY/);
    expect(p).toMatch(/MAIL_FROM/);
    liveSocial();
    Object.assign(A, { apiKey: 'k', apiSecret: 's' });
    Object.assign(M, { provider: 'mock' });
    expect(integrationBootProblems()).toEqual([]);
  });
});
