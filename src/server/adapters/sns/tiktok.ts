import { call, readJson, SnsApiError } from './http';
import { absoluteMediaUrl, publishSceneImages } from './media';
import type { SnsPublishRequest, SnsPublishResult } from './index';

/**
 * 틱톡 Content Posting API (Direct Post).
 *  0) POST /v2/post/publish/creator_info/query/ — 이 계정이 고를 수 있는 공개 범위(privacy_level_options)
 *  1) 영상: POST /v2/post/publish/video/init/   source_info.source=PULL_FROM_URL, video_url
 *     사진: POST /v2/post/publish/content/init/ media_type=PHOTO, post_mode=DIRECT_POST, source_info.photo_images
 * 감사 전 앱이 올린 게시물은 비공개로 묶이므로 **항상 SELF_ONLY** 로 올리고 결과를 PRIVATE_UPLOADED 로 둔다.
 * PULL_FROM_URL 은 주소의 도메인 소유 확인(틱톡 개발자 콘솔)이 끝나야 받는다. 처리는 비동기이며 publish_id 만 돌려준다.
 * AI 생성 콘텐츠이므로 is_aigc=true.
 */

export const TIKTOK_API = 'https://open.tiktokapis.com';

async function tiktokPost(path: string, token: string, body: unknown) {
  const res = await call(`${TIKTOK_API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  const b = await readJson(res);
  const err = (b.error ?? {}) as { code?: string; message?: string };
  if (!res.ok || (err.code && err.code !== 'ok')) {
    const code = err.code ?? `HTTP_${res.status}`;
    throw new SnsApiError(`틱톡 ${path} 실패: ${err.message || code}`.slice(0, 300), res.status, code, code === 'access_token_invalid' || res.status === 401);
  }
  return (b.data ?? {}) as Record<string, unknown>;
}

export async function publishTiktok(req: SnsPublishRequest): Promise<SnsPublishResult> {
  if (!req.accessToken) throw new SnsApiError('틱톡 토큰이 없습니다. 계정을 다시 연결해 주세요.', 0, 'NO_TOKEN', true);
  const token = req.accessToken;
  const info = await tiktokPost('/v2/post/publish/creator_info/query/', token, {});
  const options = (info.privacy_level_options as string[] | undefined) ?? [];
  if (!options.includes('SELF_ONLY')) throw new SnsApiError('이 틱톡 계정은 비공개(SELF_ONLY) 게시를 고를 수 없습니다.', 200, 'PRIVACY');
  const title = req.title.slice(0, 90);
  let data: Record<string, unknown>;
  if (req.kind === 'SHORTFORM') {
    if (!req.videoUrl) throw new SnsApiError('올릴 영상 파일이 없습니다. (영상 조립 공급자 연동 전에는 영상을 올릴 수 없습니다)', 0, 'NO_VIDEO');
    data = await tiktokPost('/v2/post/publish/video/init/', token, {
      post_info: { title: req.caption.slice(0, 2200), privacy_level: 'SELF_ONLY', disable_duet: false, disable_comment: false, disable_stitch: false, is_aigc: true },
      source_info: { source: 'PULL_FROM_URL', video_url: absoluteMediaUrl(req.videoUrl) },
    });
  } else {
    const urls = await publishSceneImages(req.assets.slice(0, 35), 'jpeg');
    data = await tiktokPost('/v2/post/publish/content/init/', token, {
      media_type: 'PHOTO',
      post_mode: 'DIRECT_POST',
      is_aigc: true,
      post_info: { title, description: req.caption.slice(0, 4000), privacy_level: 'SELF_ONLY', disable_comment: false, auto_add_music: true },
      source_info: { source: 'PULL_FROM_URL', photo_images: urls, photo_cover_index: 0 },
    });
  }
  const publishId = typeof data.publish_id === 'string' ? data.publish_id : null;
  if (!publishId) throw new SnsApiError('틱톡이 publish_id 를 돌려주지 않았습니다.', 200);
  return { status: 'PRIVATE_UPLOADED', externalPostId: publishId, url: null, mock: false };
}
