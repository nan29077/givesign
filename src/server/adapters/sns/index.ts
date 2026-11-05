import { env } from '@/lib/env';
import type { Source } from '@/lib/attribution';
import type { AdapterInfo, ProviderResult } from '../types';
import { liveSnsAdapter } from './live';
import type { ContentKind, SocialPlatform } from '@/generated/prisma/enums';

/**
 * SNS 게시 어댑터 (유튜브 · 인스타그램 · 페이스북 · 틱톡 · 네이버 블로그 · 카카오 채널).
 *
 * 실연동 조건
 *  - 유튜브: YouTube Data API 규정 감사 + OAuth 앱 인증. 감사 전 API 업로드는 비공개로 묶인다
 *    → 실연동 어댑터는 그 경우 PRIVATE_UPLOADED 를 돌려주고 기관이 직접 공개 전환한다.
 *  - 인스타그램·페이스북: 메타 앱 검수(content_publish·pages_manage_posts). 인스타는 비즈니스 계정 + 페이지 연결, 24시간 50건 제한.
 *  - 틱톡: Content Posting API 앱 심사. 심사 전에는 비공개(SELF_ONLY)로만 올라간다.
 *  - 네이버 블로그·카카오 채널: 공식 공개 게시 API 가 없어(블로그 글쓰기 API 종료, 채널 API 는 관계·고객파일만)
 *    내려받아 직접 게시한다. 실연동 어댑터는 NOT_CONFIGURED 로 돌려준다.
 *
 * 실연동 구현은 sns/live.ts — youtube.ts · meta.ts · tiktok.ts, 계정 연결은 oauth.ts(services/social-oauth.ts).
 *
 * mock 은 아무 데도 올리지 않는다. 결과에 mock 표시를 남기고 게시물 주소·지표를 만들어 내지 않는다(절대 규칙 2).
 */

export interface SnsPublishRequest {
  /** 플랫폼 이름(문자열로도 받는다) */
  platform: SocialPlatform | string;
  accessToken: string | null;
  /** 연결 계정 ID (유튜브 채널 · 인스타그램 사용자 · 페이스북 페이지 · 틱톡 open_id) */
  accountId?: string | null;
  caption: string;
  title: string;
  /** 게시할 자산 (SVG 장면·표지). 실연동에서는 렌더된 이미지/영상 파일로 바꿔 올린다. */
  assets: string[];
  kind: ContentKind | string;
  /** 조립된 영상(mp4) 주소 — 숏폼이고 FFMPEG_PATH 로 만들었을 때만. 없으면 영상 게시는 실패 사유로 돌려준다. */
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
  TIKTOK: '틱톡',
  NAVER_BLOG: '네이버 블로그',
  KAKAO_CHANNEL: '카카오 채널',
};

/** 화면 표시 순서 */
export const PLATFORMS: SocialPlatform[] = ['YOUTUBE', 'INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'NAVER_BLOG', 'KAKAO_CHANNEL'];

/**
 * 플랫폼별 게시 가능 형식.
 *  숏폼(9:16)은 영상 플랫폼, 카드뉴스·피드(4:5)는 이미지 피드 플랫폼, 블로그·카카오 채널은 이미지 글.
 */
export const PLATFORM_KINDS: Record<SocialPlatform, ContentKind[]> = {
  YOUTUBE: ['SHORTFORM'],
  INSTAGRAM: ['SHORTFORM', 'IMAGE_SQUARE', 'IMAGE_STORY', 'CARD_NEWS', 'IMAGE_FEED'],
  FACEBOOK: ['SHORTFORM', 'IMAGE_SQUARE', 'CARD_NEWS', 'IMAGE_FEED'],
  TIKTOK: ['SHORTFORM', 'CARD_NEWS'],
  NAVER_BLOG: ['CARD_NEWS', 'IMAGE_FEED', 'IMAGE_SQUARE'],
  KAKAO_CHANNEL: ['CARD_NEWS', 'IMAGE_FEED', 'IMAGE_SQUARE'],
};

/** 채널 연결 화면의 요건 안내 */
export const PLATFORM_GUIDE: Record<SocialPlatform, { need: string; review: string }> = {
  YOUTUBE: { need: '기관 유튜브 채널 (쇼츠 업로드)', review: '기브싸인 앱의 YouTube Data API 규정 감사. 감사 전에는 API 로 올린 영상이 비공개로 묶여 기관이 직접 공개로 바꿔야 합니다.' },
  INSTAGRAM: { need: '인스타그램 비즈니스(또는 크리에이터) 계정 + 연결된 페이스북 페이지', review: '메타 앱 검수(콘텐츠 게시 권한). 계정당 24시간 50건까지 게시됩니다. 캡션 링크는 눌리지 않아 프로필 링크 안내가 함께 들어갑니다.' },
  FACEBOOK: { need: '기관 페이스북 페이지 관리자 권한', review: '메타 앱 검수(페이지 게시 권한).' },
  TIKTOK: { need: '기관 틱톡 계정 (비즈니스 계정 권장)', review: '틱톡 Content Posting API 앱 심사. 심사 전에는 본인만 보기(비공개)로 올라갑니다. 해시태그는 5개까지 넣습니다.' },
  NAVER_BLOG: { need: '기관 네이버 블로그', review: '네이버 블로그 글쓰기 연동 방식 확정 전입니다. 제목·문단 본문·카드 이미지를 내려받아 직접 올릴 수 있습니다.' },
  KAKAO_CHANNEL: { need: '기관 카카오톡 채널 (관리자 권한)', review: '카카오 채널 소식 게시 연동 방식 확정 전입니다. 짧은 소식 문구와 이미지를 내려받아 직접 올릴 수 있습니다. 광고성 메시지 발송 기능은 만들지 않습니다.' },
};

export const PLATFORM_SRC: Record<SocialPlatform, Source> = {
  YOUTUBE: 'YOUTUBE',
  INSTAGRAM: 'INSTAGRAM',
  FACEBOOK: 'FACEBOOK',
  TIKTOK: 'TIKTOK',
  NAVER_BLOG: 'NAVER_BLOG',
  KAKAO_CHANNEL: 'KAKAO_CHANNEL',
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
