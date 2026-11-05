import { env } from '@/lib/env';
import { SocialPlatform as DbSocialPlatform } from '@/generated/prisma/enums';

/**
 * SNS 플랫폼 표 (2026-11-06 7단계).
 *
 * 플랫폼·형식을 **문자열**로 다룬다. DB enum(SocialPlatform·ContentKind)은 5단계가 TIKTOK·NAVER_BLOG·
 * KAKAO_CHANNEL / CARD_NEWS·IMAGE_FEED 를 더하는데, 이 파일은 enum 이 늘기 전후 모두 그대로 컴파일된다.
 * DB 에 아직 없는 플랫폼은 `dbSupportsPlatform()` 이 false 라 연결(저장)을 시작하지 않는다.
 */

export const SNS_PLATFORMS = ['YOUTUBE', 'INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'NAVER_BLOG', 'KAKAO_CHANNEL'] as const;
export type SnsPlatform = (typeof SNS_PLATFORMS)[number];

export const SNS_PLATFORM_LABEL: Record<SnsPlatform, string> = {
  YOUTUBE: '유튜브',
  INSTAGRAM: '인스타그램',
  FACEBOOK: '페이스북',
  TIKTOK: '틱톡',
  NAVER_BLOG: '네이버 블로그',
  KAKAO_CHANNEL: '카카오톡 채널',
};

/** 주소에 쓰는 이름 (/api/studio/social/<slug>/connect) */
export const SNS_PLATFORM_SLUG: Record<SnsPlatform, string> = {
  YOUTUBE: 'youtube',
  INSTAGRAM: 'instagram',
  FACEBOOK: 'facebook',
  TIKTOK: 'tiktok',
  NAVER_BLOG: 'naver-blog',
  KAKAO_CHANNEL: 'kakao-channel',
};

export function platformFromSlug(slug: string): SnsPlatform | null {
  const hit = (Object.entries(SNS_PLATFORM_SLUG) as Array<[SnsPlatform, string]>).find(([, v]) => v === slug);
  return hit ? hit[0] : null;
}

export function isSnsPlatform(v: string): v is SnsPlatform {
  return (SNS_PLATFORMS as readonly string[]).includes(v);
}

/** 플랫폼별로 실연동 게시가 가능한 형식(문자열). CARD_NEWS·IMAGE_FEED 는 5단계 형식이다. */
export const SNS_PLATFORM_KINDS: Record<SnsPlatform, string[]> = {
  YOUTUBE: ['SHORTFORM'],
  INSTAGRAM: ['SHORTFORM', 'IMAGE_SQUARE', 'IMAGE_STORY', 'CARD_NEWS', 'IMAGE_FEED'],
  FACEBOOK: ['SHORTFORM', 'IMAGE_SQUARE', 'CARD_NEWS', 'IMAGE_FEED'],
  TIKTOK: ['SHORTFORM', 'CARD_NEWS', 'IMAGE_FEED', 'IMAGE_STORY'],
  NAVER_BLOG: [],
  KAKAO_CHANNEL: [],
};

export type OAuthFamily = 'google' | 'meta' | 'tiktok';

/** 플랫폼별 OAuth 공급자. 공개 게시 API 가 확인되지 않은 플랫폼은 null(내려받아 직접 게시). */
export const SNS_OAUTH_FAMILY: Record<SnsPlatform, OAuthFamily | null> = {
  YOUTUBE: 'google',
  INSTAGRAM: 'meta',
  FACEBOOK: 'meta',
  TIKTOK: 'tiktok',
  // 네이버 블로그 글쓰기 API 는 종료되어 공개 게시 API 가 없다(2026-11 확인). 카카오톡 채널 API 는 채널 추가·관계 조회·
  // 고객파일만 제공하고 채널 소식(포스트) 게시 API 가 없다(developers.kakao.com 카카오톡 채널 문서, 2026-11 확인).
  NAVER_BLOG: null,
  KAKAO_CHANNEL: null,
};

/** 화면 안내: 필요한 계정과 검수 전 제한 */
export const SNS_PLATFORM_GUIDE: Record<SnsPlatform, { need: string; review: string }> = {
  YOUTUBE: {
    need: '기관 유튜브 채널 (쇼츠 업로드)',
    review: '구글 OAuth 앱 인증 + YouTube Data API 규정 감사. 감사 전에는 API 로 올린 영상이 비공개로 고정되어 공개 전환이 거절될 수 있습니다. 기브싸인은 항상 비공개로 올리고, 담당자가 확인한 뒤 "공개로 전환" 합니다.',
  },
  INSTAGRAM: {
    need: '인스타그램 비즈니스(또는 크리에이터) 계정 + 연결된 페이스북 페이지',
    review: '메타 앱 검수(instagram_content_publish 등). 검수 전에는 메타 앱에 역할(관리자·개발자·테스터)이 있는 계정만 연결·게시됩니다. 계정당 24시간 50건까지입니다.',
  },
  FACEBOOK: {
    need: '기관 페이스북 페이지 관리자 권한',
    review: '메타 앱 검수(pages_manage_posts 등). 검수 전에는 메타 앱에 역할이 있는 계정이 관리하는 페이지만 동작합니다.',
  },
  TIKTOK: {
    need: '기관 틱톡 계정',
    review: '틱톡 Content Posting API 감사. 감사 전에는 비공개(나만 보기, SELF_ONLY)로만 올라가며, 영상·사진 주소의 도메인 소유 확인이 필요합니다.',
  },
  NAVER_BLOG: {
    need: '기관 네이버 블로그',
    review: '네이버는 블로그 글쓰기 공개 API 를 제공하지 않습니다(종료). 승인된 콘텐츠를 내려받아 직접 게시해 주세요.',
  },
  KAKAO_CHANNEL: {
    need: '기관 카카오톡 채널',
    review: '카카오는 채널 소식(포스트) 게시 공개 API 를 제공하지 않습니다. 승인된 콘텐츠를 내려받아 카카오톡 채널 관리자센터에서 직접 게시해 주세요. (안내 메시지는 알림톡으로 따로 보냅니다)',
  },
};

/** DB(social_channel.platform enum)에 이 플랫폼 값이 있는지. 5단계 enum 반영 전에는 TIKTOK 이 false. */
export function dbSupportsPlatform(p: string): boolean {
  return (Object.values(DbSocialPlatform) as string[]).includes(p);
}

/** 플랫폼 OAuth·게시에 필요한데 비어 있는 설정 이름 */
export function platformMissingCredentials(p: SnsPlatform): string[] {
  const s = env.integrations.social;
  const fam = SNS_OAUTH_FAMILY[p];
  if (!fam) return ['공개 게시 API 없음'];
  const missing: string[] = [];
  if (fam === 'google') {
    if (!s.googleClientId) missing.push('GOOGLE_CLIENT_ID');
    if (!s.googleClientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  } else if (fam === 'meta') {
    if (!s.metaAppId) missing.push('META_APP_ID');
    if (!s.metaAppSecret) missing.push('META_APP_SECRET');
  } else {
    if (!s.tiktokClientKey) missing.push('TIKTOK_CLIENT_KEY');
    if (!s.tiktokClientSecret) missing.push('TIKTOK_CLIENT_SECRET');
  }
  if (!s.stateSecret) missing.push('SOCIAL_OAUTH_STATE_SECRET');
  return missing;
}

export function socialRedirectUri(p: SnsPlatform): string {
  return `${env.baseUrl.replace(/\/+$/, '')}/api/studio/social/${SNS_PLATFORM_SLUG[p]}/callback`;
}
