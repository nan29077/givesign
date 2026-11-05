import { logger } from '@/lib/logger';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';
import { SnsApiError } from './http';
import { isSnsPlatform, platformMissingCredentials, SNS_PLATFORMS, SNS_PLATFORM_KINDS, SNS_PLATFORM_LABEL, type SnsPlatform } from './platforms';
import { publishYoutube, youtubeMetrics } from './youtube';
import { facebookMetrics, instagramMetrics, publishFacebook, publishInstagram } from './meta';
import { publishTiktok } from './tiktok';
import type { SnsAdapter, SnsAuth, SnsMetrics, SnsPublishRequest, SnsPublishResult } from './index';

/**
 * SNS 실연동 어댑터. 플랫폼마다 키(platformMissingCredentials)가 있어야 호출한다.
 * 키가 없거나 공개 게시 API 가 없는 플랫폼(네이버 블로그·카카오톡 채널)은 fetch 없이 실패를 돌려준다.
 * 공급자 오류는 성공으로 덮지 않고 code·message 로 돌려준다(호출부가 재시도·실패 처리).
 */

/** 토큰 만료로 실패했음을 호출부(서비스)에 알리는 코드 */
export const SNS_AUTH_EXPIRED = 'AUTH_EXPIRED';

function allMissing(): string[] {
  const set = new Set<string>();
  for (const p of SNS_PLATFORMS) for (const m of platformMissingCredentials(p)) if (m !== '공개 게시 API 없음') set.add(m);
  return [...set];
}

export const liveSnsAdapter: SnsAdapter = {
  info(): AdapterInfo {
    // 어느 한 플랫폼이라도 키가 다 있으면 비어 있다. 플랫폼별 상태는 platformMissingCredentials 로 본다.
    const ready = SNS_PLATFORMS.some((p) => platformMissingCredentials(p).length === 0);
    return { provider: 'live', mode: 'live', missingCredentials: ready ? [] : allMissing() };
  },

  async publish(req: SnsPublishRequest): Promise<ProviderResult<SnsPublishResult>> {
    const started = Date.now();
    if (!isSnsPlatform(req.platform)) return { ok: false, code: 'UNKNOWN_PLATFORM', message: `알 수 없는 플랫폼입니다: ${req.platform}` };
    const p: SnsPlatform = req.platform;
    const missing = platformMissingCredentials(p);
    if (missing.length) {
      const err = new AdapterNotConfiguredError(`sns:${p.toLowerCase()}`, missing);
      return { ok: false, code: 'NOT_CONFIGURED', message: missing.includes('공개 게시 API 없음') ? `${SNS_PLATFORM_LABEL[p]}는 공개 게시 API 가 없어 자동 게시하지 않습니다. 내려받아 직접 게시해 주세요.` : err.message };
    }
    if (!SNS_PLATFORM_KINDS[p].includes(req.kind)) return { ok: false, code: 'KIND', message: `${SNS_PLATFORM_LABEL[p]}에는 이 형식(${req.kind})을 올릴 수 없습니다.` };
    try {
      const data =
        p === 'YOUTUBE' ? await publishYoutube(req)
        : p === 'INSTAGRAM' ? await publishInstagram(req)
        : p === 'FACEBOOK' ? await publishFacebook(req)
        : await publishTiktok(req);
      return { ok: true, data, latencyMs: Date.now() - started };
    } catch (e) {
      const err = e as SnsApiError;
      logger.warn('SNS 게시 실패', { platform: p, code: err.code ?? null, status: err.status ?? null, message: err.message });
      return {
        ok: false,
        code: err instanceof SnsApiError && err.authExpired ? SNS_AUTH_EXPIRED : (err.code ?? 'PUBLISH_FAILED'),
        message: err.message,
        latencyMs: Date.now() - started,
      };
    }
  },

  async metrics(platform: string, externalPostId: string | null, auth?: SnsAuth): Promise<SnsMetrics | null> {
    if (!externalPostId || !auth?.accessToken || !isSnsPlatform(platform)) return null;
    if (platformMissingCredentials(platform).length) return null;
    try {
      if (platform === 'YOUTUBE') return await youtubeMetrics(auth.accessToken, externalPostId);
      if (platform === 'INSTAGRAM') return await instagramMetrics(auth.accessToken, externalPostId);
      if (platform === 'FACEBOOK') return await facebookMetrics(auth.accessToken, externalPostId);
      // 틱톡은 publish_id 만 있고 게시물 ID 는 비동기 처리 뒤에 나온다. 지표는 video.list 권한·게시물 ID 확인 후(미구현).
      return null;
    } catch (e) {
      logger.warn('SNS 지표 조회 실패', { platform, message: (e as Error).message });
      return null;
    }
  },
};
