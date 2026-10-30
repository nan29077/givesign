import { env } from '@/lib/env';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';
import type { SocialPlatform } from '@/generated/prisma/enums';

/**
 * SNS 게시 어댑터 (유튜브 · 인스타그램 · 페이스북).
 *
 * 실연동 조건
 *  - 유튜브: YouTube Data API 규정 감사 + OAuth 앱 인증. 감사 전 API 업로드는 비공개로 묶인다
 *    → 실연동 어댑터는 그 경우 PRIVATE_UPLOADED 를 돌려주고 기관이 직접 공개 전환한다.
 *  - 인스타그램·페이스북: 메타 앱 검수(content_publish·pages_manage_posts). 인스타는 비즈니스 계정 + 페이지 연결, 24시간 50건 제한.
 *
 * mock 은 아무 데도 올리지 않는다. 결과에 mock 표시를 남기고 게시물 주소·지표를 만들어 내지 않는다(절대 규칙 2).
 */

export interface SnsPublishRequest {
  platform: SocialPlatform;
  accessToken: string | null;
  caption: string;
  title: string;
  /** 게시할 자산 (SVG 장면·표지). 실연동에서는 렌더된 이미지/영상 파일로 바꿔 올린다. */
  assets: string[];
  kind: 'SHORTFORM' | 'IMAGE_SQUARE' | 'IMAGE_STORY';
}

export interface SnsPublishResult {
  status: 'PUBLISHED' | 'PRIVATE_UPLOADED';
  externalPostId: string | null;
  url: string | null;
  mock: boolean;
}

export interface SnsMetrics {
  views: number;
  likes: number;
}

export interface SnsAdapter {
  info(): AdapterInfo;
  publish(req: SnsPublishRequest): Promise<ProviderResult<SnsPublishResult>>;
  /** 지표 수집. mock 은 null(지표 없음). */
  metrics(platform: SocialPlatform, externalPostId: string | null): Promise<SnsMetrics | null>;
}

export const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  YOUTUBE: '유튜브',
  INSTAGRAM: '인스타그램',
  FACEBOOK: '페이스북',
};

/** 플랫폼별 게시 가능 형식 */
export const PLATFORM_KINDS: Record<SocialPlatform, Array<'SHORTFORM' | 'IMAGE_SQUARE' | 'IMAGE_STORY'>> = {
  YOUTUBE: ['SHORTFORM'],
  INSTAGRAM: ['SHORTFORM', 'IMAGE_SQUARE', 'IMAGE_STORY'],
  FACEBOOK: ['SHORTFORM', 'IMAGE_SQUARE'],
};

export const PLATFORM_SRC: Record<SocialPlatform, 'YOUTUBE' | 'INSTAGRAM' | 'FACEBOOK'> = {
  YOUTUBE: 'YOUTUBE',
  INSTAGRAM: 'INSTAGRAM',
  FACEBOOK: 'FACEBOOK',
};

export const mockSnsAdapter: SnsAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async publish() {
    return { ok: true, data: { status: 'PUBLISHED', externalPostId: null, url: null, mock: true }, latencyMs: 3 };
  },
  async metrics() {
    return null;
  },
};

export function getSnsAdapter(): SnsAdapter {
  if (env.automation.socialProvider === 'mock') return mockSnsAdapter;
  const provider = env.automation.socialProvider;
  return {
    info: () => ({ provider, mode: 'live', missingCredentials: ['YOUTUBE_CLIENT_ID', 'META_APP_ID'] }),
    async publish() {
      const err = new AdapterNotConfiguredError(provider, ['YOUTUBE_CLIENT_ID', 'META_APP_ID']);
      return { ok: false, code: 'NOT_CONFIGURED', message: err.message };
    },
    async metrics() {
      return null;
    },
  };
}

export function snsIsMock() {
  return getSnsAdapter().info().mode === 'mock';
}
