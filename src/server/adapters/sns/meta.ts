import { assertCaptionFits, call, expectJson, form, SnsApiError, sleep } from './http';
import { appSecretProof, graphBase } from './oauth';
import { absoluteMediaUrl, publishSceneImages } from './media';
import type { SnsMetrics, SnsPublishRequest, SnsPublishResult } from './index';

/**
 * 메타 그래프 API 게시.
 *
 * 인스타그램 (Instagram Graph API, 페이스북 로그인 경유 비즈니스 계정)
 *   1) POST /{ig-user-id}/media  — 컨테이너 만들기
 *        이미지: image_url (JPEG 공개 주소)
 *        캐러셀: 자식마다 is_carousel_item=true + image_url → 부모 media_type=CAROUSEL, children=<id,...>
 *        릴스:   media_type=REELS, video_url
 *        스토리: media_type=STORIES, image_url
 *   2) (영상) GET /{container-id}?fields=status_code 가 FINISHED 가 될 때까지 기다린다
 *   3) POST /{ig-user-id}/media_publish  creation_id=<container-id>
 * 페이스북 페이지 (Pages API, 페이지 액세스 토큰)
 *   사진 1장: POST /{page-id}/photos  url, message
 *   여러 장:  POST /{page-id}/photos  url, published=false (장마다) → POST /{page-id}/feed  message, attached_media=[{media_fbid}]
 *   영상:     POST /{page-id}/videos  file_url, description
 * 모든 호출에 appsecret_proof 를 붙이고, 토큰은 주소가 아니라 본문으로 보낸다(POST).
 */

/** 영상 컨테이너 처리 대기 (테스트에서 줄인다) */
export const metaPolling = { intervalMs: 5_000, maxTries: 24 };

const IMAGE_KINDS = new Set(['IMAGE_SQUARE', 'IMAGE_STORY', 'CARD_NEWS', 'IMAGE_FEED']);

async function graphPost(path: string, token: string, params: Record<string, string | number | boolean | null | undefined>) {
  const res = await call(`${graphBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ ...params, access_token: token, appsecret_proof: appSecretProof(token) }),
  });
  return expectJson(res, `메타 ${path}`);
}

async function graphGet(path: string, token: string, params: Record<string, string> = {}) {
  const res = await call(`${graphBase()}${path}?${form({ ...params, access_token: token, appsecret_proof: appSecretProof(token) })}`);
  return expectJson(res, `메타 ${path}`);
}

function idOf(b: Record<string, unknown>, what: string) {
  if (typeof b.id !== 'string' || !b.id) throw new SnsApiError(`${what} ID 를 받지 못했습니다.`, 200);
  return b.id;
}

function need(req: SnsPublishRequest) {
  if (!req.accessToken || !req.accountId) throw new SnsApiError('연결 토큰 또는 계정 ID 가 없습니다. 채널을 다시 연결해 주세요.', 0, 'NO_TOKEN', true);
  return { token: req.accessToken, account: req.accountId };
}

async function waitContainer(token: string, containerId: string) {
  for (let i = 0; i < metaPolling.maxTries; i++) {
    const s = await graphGet(`/${containerId}`, token, { fields: 'status_code' });
    const code = String(s.status_code ?? '');
    if (code === 'FINISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') throw new SnsApiError(`인스타그램이 영상을 처리하지 못했습니다 (${code}).`, 200, code);
    await sleep(metaPolling.intervalMs);
  }
  throw new SnsApiError('인스타그램 영상 처리가 끝나지 않았습니다. 잠시 뒤 다시 시도합니다.', 0, 'IN_PROGRESS');
}

export async function publishInstagram(req: SnsPublishRequest): Promise<SnsPublishResult> {
  const { token, account } = need(req);
  const caption = assertCaptionFits(req.caption, { chars: 2200 }, '인스타그램 캡션');
  let creationId: string;
  if (req.kind === 'SHORTFORM') {
    if (!req.videoUrl) throw new SnsApiError('올릴 영상 파일이 없습니다. (영상 조립 공급자 연동 전에는 릴스를 올릴 수 없습니다)', 0, 'NO_VIDEO');
    creationId = idOf(await graphPost(`/${account}/media`, token, { media_type: 'REELS', video_url: absoluteMediaUrl(req.videoUrl), caption, share_to_feed: true }), '릴스 컨테이너');
    await waitContainer(token, creationId);
  } else if (IMAGE_KINDS.has(req.kind)) {
    // 인스타그램 사진은 JPEG 만 받는다.
    const urls = await publishSceneImages(req.assets.slice(0, 10), 'jpeg');
    if (req.kind === 'IMAGE_STORY') {
      creationId = idOf(await graphPost(`/${account}/media`, token, { media_type: 'STORIES', image_url: urls[0] }), '스토리 컨테이너');
    } else if (urls.length === 1) {
      creationId = idOf(await graphPost(`/${account}/media`, token, { image_url: urls[0], caption }), '이미지 컨테이너');
    } else {
      const children: string[] = [];
      for (const u of urls) children.push(idOf(await graphPost(`/${account}/media`, token, { is_carousel_item: true, image_url: u }), '캐러셀 항목'));
      creationId = idOf(await graphPost(`/${account}/media`, token, { media_type: 'CAROUSEL', children: children.join(','), caption }), '캐러셀 컨테이너');
    }
  } else {
    throw new SnsApiError(`인스타그램에는 이 형식(${req.kind})을 올릴 수 없습니다.`, 0, 'KIND');
  }
  const mediaId = idOf(await graphPost(`/${account}/media_publish`, token, { creation_id: creationId }), '게시물');
  let url: string | null = null;
  try {
    const m = await graphGet(`/${mediaId}`, token, { fields: 'permalink' });
    url = typeof m.permalink === 'string' ? m.permalink : null;
  } catch {
    url = null; // 게시는 끝났다. 주소 조회 실패로 게시 결과를 바꾸지 않는다.
  }
  return { status: 'PUBLISHED', externalPostId: mediaId, url, mock: false };
}

export async function publishFacebook(req: SnsPublishRequest): Promise<SnsPublishResult> {
  const { token, account } = need(req);
  const message = assertCaptionFits(req.caption, { chars: 5000 }, '페이스북 게시 글');
  let postId: string;
  if (req.kind === 'SHORTFORM') {
    if (!req.videoUrl) throw new SnsApiError('올릴 영상 파일이 없습니다. (영상 조립 공급자 연동 전에는 영상을 올릴 수 없습니다)', 0, 'NO_VIDEO');
    postId = idOf(await graphPost(`/${account}/videos`, token, { file_url: absoluteMediaUrl(req.videoUrl), description: message, title: req.title.slice(0, 100) }), '영상');
  } else if (IMAGE_KINDS.has(req.kind)) {
    const urls = await publishSceneImages(req.assets.slice(0, 10), 'png');
    if (urls.length === 1) {
      const b = await graphPost(`/${account}/photos`, token, { url: urls[0], message, published: true });
      postId = typeof b.post_id === 'string' ? b.post_id : idOf(b, '사진');
    } else {
      const media: string[] = [];
      for (const u of urls) media.push(idOf(await graphPost(`/${account}/photos`, token, { url: u, published: false }), '사진'));
      const feed = await graphPost(`/${account}/feed`, token, { message, attached_media: JSON.stringify(media.map((id) => ({ media_fbid: id }))) });
      postId = idOf(feed, '게시물');
    }
  } else {
    throw new SnsApiError(`페이스북에는 이 형식(${req.kind})을 올릴 수 없습니다.`, 0, 'KIND');
  }
  return { status: 'PUBLISHED', externalPostId: postId, url: `https://www.facebook.com/${postId}`, mock: false };
}

/** 인스타 지표: like_count + insights views(실패하면 0) */
export async function instagramMetrics(token: string, mediaId: string): Promise<SnsMetrics | null> {
  const m = await graphGet(`/${mediaId}`, token, { fields: 'like_count' });
  let views = 0;
  try {
    const ins = await graphGet(`/${mediaId}/insights`, token, { metric: 'views' });
    const v = (ins.data as Array<{ name?: string; values?: Array<{ value?: number }> }> | undefined)?.find((d) => d.name === 'views')?.values?.[0]?.value;
    views = Number(v ?? 0) || 0;
  } catch {
    views = 0;
  }
  return { views, likes: Number(m.like_count ?? 0) || 0 };
}

/** 페이스북 게시물 지표: 반응 수 + insights post_media_view(추정 — 지원 지표가 바뀌면 0) */
export async function facebookMetrics(token: string, postId: string): Promise<SnsMetrics | null> {
  const m = await graphGet(`/${postId}`, token, { fields: 'reactions.summary(total_count).limit(0)' });
  const likes = Number((m.reactions as { summary?: { total_count?: number } } | undefined)?.summary?.total_count ?? 0) || 0;
  let views = 0;
  try {
    const ins = await graphGet(`/${postId}/insights`, token, { metric: 'post_media_view' });
    views = Number((ins.data as Array<{ values?: Array<{ value?: number }> }> | undefined)?.[0]?.values?.[0]?.value ?? 0) || 0;
  } catch {
    views = 0;
  }
  return { views, likes };
}
