import { env } from '@/lib/env';
import type { AdapterInfo, ProviderResult } from '../types';
import { liveSnsAdapter } from './live';
import type { SocialPlatform } from '@/generated/prisma/enums';

/**
 * SNS 게시 어댑터 (유튜브 · 인스타그램 · 페이스북 · 틱톡).
 *
 * 실연동 구현은 sns/live.ts (2026-11-06 7단계) — youtube.ts · meta.ts · tiktok.ts, 계정 연결은 oauth.ts.
 *
 * 실연동 조건
 *  - 유튜브: YouTube Data API 규정 감사 + OAuth 앱 인증. 감사 전 API 업로드는 비공개로 묶인다
 *    → 실연동 어댑터는 그 경우 PRIVATE_UPLOADED 를 돌려주고 기관이 직접 공개 전환한다.
 *  - 인스타그램·페이스북: 메타 앱 검수(content_publish·pages_manage_posts). 인스타는 비즈니스 계정 + 페이지 연결, 24시간 50건 제한.
 *
 * mock 은 아무 데도 올리지 않는다. 결과에 mock 표시를 남기고 게시물 주소·지표를 만들어 내지 않는다(절대 규칙 2).
 */

export interface SnsPublishRequest {
  /** 플랫폼 이름(문자열). DB enum 에 없는 플랫폼(5단계 추가분)도 받는다. */
  platform: SocialPlatform | string;
  accessToken: string | null;
  /** 연결 계정 ID (유튜브 채널 · 인스타그램 사용자 · 페이스북 페이지 · 틱톡 open_id) */
  accountId?: string | null;
  caption: string;
  title: string;
  /** 게시할 자산 (SVG 장면·표지). 실연동에서는 PNG/JPEG 로 바꿔 공개 저장소에 올린 주소로 넘긴다. */
  assets: string[];
  /** 콘텐츠 형식(문자열). SHORTFORM · IMAGE_SQUARE · IMAGE_STORY (+ 5단계 CARD_NEWS · IMAGE_FEED) */
  kind: string;
  /** 숏폼 영상 주소. 영상 조립 공급자가 만들기 전에는 없다 → 영상 게시는 실패 사유로 돌려준다. */
  videoUrl?: string | null;
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

export interface SnsAuth {
  accessToken: string | null;
  accountId?: string | null;
}

export interface SnsAdapter {
  info(): AdapterInfo;
  publish(req: SnsPublishRequest): Promise<ProviderResult<SnsPublishResult>>;
  /** 지표 수집. mock 은 null(지표 없음). 실연동은 연결 토큰(auth)이 있어야 조회한다. */
  metrics(platform: SocialPlatform | string, externalPostId: string | null, auth?: SnsAuth): Promise<SnsMetrics | null>;
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
  // 실연동: 플랫폼별 키가 있는 곳만 호출한다(sns/live.ts). 키가 없으면 NOT_CONFIGURED 로 실패시키고 공급자를 부르지 않는다.
  return liveSnsAdapter;
}

export function snsIsMock() {
  return getSnsAdapter().info().mode === 'mock';
}
