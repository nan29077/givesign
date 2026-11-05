import { assertCaptionFits, call, expectJson, SnsApiError } from './http';
import { loadVideoBytes } from './media';
import type { SnsMetrics, SnsPublishRequest, SnsPublishResult } from './index';

/**
 * YouTube Data API v3 — resumable upload.
 *  1) POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status
 *     (본문: 영상 메타데이터, X-Upload-Content-Type/Length) → 응답 Location 헤더 = 업로드 세션 주소
 *  2) PUT <Location> 영상 바이트 → 영상 리소스(id, status)
 * 항상 privacyStatus=private 로 올린다(감사 전 API 업로드는 비공개로 고정되고, 기관이 확인한 뒤 공개 전환한다).
 * AI 생성 콘텐츠이므로 status.containsSyntheticMedia=true 로 알린다.
 */

export const YT_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
export const YT_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

function hashtags(caption: string) {
  return [...new Set((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.slice(1)))].slice(0, 15);
}

export async function publishYoutube(req: SnsPublishRequest): Promise<SnsPublishResult> {
  if (!req.accessToken) throw new SnsApiError('유튜브 토큰이 없습니다. 채널을 다시 연결해 주세요.', 0, 'NO_TOKEN', true);
  if (!req.videoUrl) throw new SnsApiError('올릴 영상 파일이 없습니다. (영상 조립 공급자 연동 전에는 숏폼 영상이 만들어지지 않습니다)', 0, 'NO_VIDEO');
  // 설명은 UTF-8 5,000바이트(글자 아님)이고 꺾쇠(< >)를 받지 않는다. 자르지 않고 넘치면 실패(2026-11-06 점검 A-M10·낮음).
  const description = assertCaptionFits(req.caption.replace(/[<>]/g, ''), { bytes: 5000 }, '유튜브 설명');
  const video = await loadVideoBytes(req.videoUrl);
  const meta = {
    snippet: { title: Array.from(req.title.replace(/[<>]/g, '')).slice(0, 100).join(''), description, tags: hashtags(req.caption), categoryId: '29' },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  };
  const init = await call(YT_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': video.contentType,
      'X-Upload-Content-Length': String(video.bytes.length),
    },
    body: JSON.stringify(meta),
  });
  if (!init.ok) await expectJson(init, '유튜브 업로드 시작');
  const location = init.headers.get('location');
  if (!location) throw new SnsApiError('유튜브 업로드 세션 주소(Location)를 받지 못했습니다.', init.status);
  const put = await call(location, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${req.accessToken}`, 'Content-Type': video.contentType, 'Content-Length': String(video.bytes.length) },
    body: new Uint8Array(video.bytes),
    timeoutMs: 600_000,
  });
  const v = await expectJson(put, '유튜브 영상 업로드');
  const id = typeof v.id === 'string' ? v.id : null;
  if (!id) throw new SnsApiError('유튜브가 영상 ID 를 돌려주지 않았습니다.', put.status);
  return { status: 'PRIVATE_UPLOADED', externalPostId: id, url: `https://www.youtube.com/watch?v=${id}`, mock: false };
}

/** videos.update — status.privacyStatus 를 public 으로. 감사 전 앱이면 유튜브가 거절할 수 있다. */
export async function youtubeSetPublic(accessToken: string, videoId: string) {
  const res = await call(`${YT_VIDEOS_URL}?part=status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ id: videoId, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true } }),
  });
  const b = await expectJson(res, '유튜브 공개 전환');
  const privacy = (b.status as { privacyStatus?: string } | undefined)?.privacyStatus;
  if (privacy !== 'public') throw new SnsApiError(`유튜브가 공개 전환을 반영하지 않았습니다 (현재 ${privacy ?? '알 수 없음'}). 앱 감사 전에는 비공개로 고정됩니다.`, res.status, 'STILL_PRIVATE');
}

export async function youtubeMetrics(accessToken: string, videoId: string): Promise<SnsMetrics | null> {
  const res = await call(`${YT_VIDEOS_URL}?part=statistics&id=${encodeURIComponent(videoId)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const b = await expectJson(res, '유튜브 지표 조회');
  const st = (b.items as Array<{ statistics?: { viewCount?: string; likeCount?: string } }> | undefined)?.[0]?.statistics;
  if (!st) return null;
  return { views: Number(st.viewCount ?? 0) || 0, likes: Number(st.likeCount ?? 0) || 0 };
}
