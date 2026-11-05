import type { SocialPlatform } from '@/generated/prisma/enums';

/**
 * 플랫폼별 캡션 규칙 (순수 함수 — DB·네트워크 없음).
 *
 * 공통: 후원 링크({링크})와 "AI 생성 콘텐츠" 표시(모집등록번호 포함)는 어떤 플랫폼에서도 잘리지 않는다.
 * 길이를 넘으면 본문만 줄인다. 해시태그는 플랫폼 상한까지만.
 *
 *  - 유튜브      : 제목 100자 이내(꺾쇠 제거) + 설명(5,000자 이내)
 *  - 인스타그램  : 2,200자, 해시태그 30개 이하, 캡션 링크는 눌리지 않으므로 "프로필 링크" 안내 + 링크
 *  - 페이스북    : 링크를 맨 위에
 *  - 틱톡        : 2,200자, 해시태그 5개 이하
 *  - 네이버 블로그: 제목 + 문단 본문
 *  - 카카오 채널 : 짧은 소식 + 링크 (해시태그 없음)
 */

export const LINK_TOKEN = '{링크}';

export interface CaptionRule {
  maxChars: number;
  maxTags: number;
  titleMax: number | null;
}

export const PLATFORM_CAPTION_RULES: Record<SocialPlatform, CaptionRule> = {
  YOUTUBE: { maxChars: 5000, maxTags: 15, titleMax: 100 },
  INSTAGRAM: { maxChars: 2200, maxTags: 30, titleMax: null },
  FACEBOOK: { maxChars: 5000, maxTags: 10, titleMax: null },
  TIKTOK: { maxChars: 2200, maxTags: 5, titleMax: null },
  NAVER_BLOG: { maxChars: 10000, maxTags: 30, titleMax: 60 },
  KAKAO_CHANNEL: { maxChars: 600, maxTags: 0, titleMax: null },
};

export interface CaptionParts {
  /** 제목(유튜브·블로그) — 없으면 본문 첫 줄 */
  title?: string | null;
  /** 본문 (문자 후원 안내 줄 포함 가능) */
  body: string;
  tags: string[];
  /** "AI 생성 콘텐츠 · 기부금품 모집등록 …" */
  footer: string;
}

export interface PlatformPost {
  title: string | null;
  text: string;
}

function cut(s: string, max: number) {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function tagLine(tags: string[], max: number) {
  return [...new Set(tags.map((t) => t.replace(/^#/, '').trim()).filter((t) => /^[\p{L}\p{N}_]{1,30}$/u.test(t)))]
    .slice(0, max)
    .map((t) => `#${t}`)
    .join(' ');
}

/** 본문을 줄여 전체 길이를 맞춘다(링크·표시는 고정). */
function fit(fixedBefore: string[], body: string, fixedAfter: string[], max: number) {
  const join = (b: string) => [...fixedBefore, b, ...fixedAfter].filter((l) => l !== '').join('\n\n');
  const full = join(body);
  if (full.length <= max) return full;
  const room = max - join('').length - 2;
  return join(cut(body, Math.max(0, room)));
}

export function composePlatformCaption(platform: SocialPlatform, parts: CaptionParts): PlatformPost {
  const rule = PLATFORM_CAPTION_RULES[platform];
  const body = parts.body.trim();
  const firstLine = body.split('\n')[0] ?? '';
  const titleSrc = (parts.title ?? firstLine).replace(/[<>]/g, '').trim();
  const title = rule.titleMax ? cut(titleSrc, rule.titleMax) : null;
  const tags = tagLine(parts.tags, rule.maxTags);
  const link = `후원하기: ${LINK_TOKEN}`;
  switch (platform) {
    case 'INSTAGRAM':
      return { title: null, text: fit([], body, ['프로필 링크에서도 후원할 수 있습니다.\n' + link, tags, parts.footer], rule.maxChars) };
    case 'FACEBOOK':
      return { title: null, text: fit([link], body, [tags, parts.footer], rule.maxChars) };
    case 'KAKAO_CHANNEL':
      return { title: null, text: fit([], cut(body, 300), [link, parts.footer], rule.maxChars) };
    case 'YOUTUBE':
    case 'NAVER_BLOG':
    case 'TIKTOK':
    default:
      return { title, text: fit([], body, [link, tags, parts.footer], rule.maxChars) };
  }
}

/**
 * 기본 캡션(한 장)을 플랫폼 규칙으로 바꾼다 — mock 공급자이거나 담당자가 캡션을 고친 경우.
 * 해시태그 줄·링크 줄·AI 표시 줄을 찾아 떼어 낸 뒤 composePlatformCaption 으로 다시 묶는다.
 */
export function adaptCaption(base: string, platform: SocialPlatform, fallbackFooter = 'AI 생성 콘텐츠'): PlatformPost {
  const lines = base.split('\n');
  const tags: string[] = [];
  let footer = '';
  const bodyLines: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line && line.split(/\s+/).every((w) => w.startsWith('#'))) {
      tags.push(...line.split(/\s+/));
      continue;
    }
    if (line.includes('AI 생성 콘텐츠')) {
      footer = line;
      continue;
    }
    if (line.includes(LINK_TOKEN)) {
      const rest = line.replace(/후원하기:\s*/, '').replace(LINK_TOKEN, '').trim();
      if (rest) bodyLines.push(rest);
      continue;
    }
    bodyLines.push(raw);
  }
  const body = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const [first, ...rest] = body.split('\n');
  const usesTitle = PLATFORM_CAPTION_RULES[platform].titleMax !== null;
  return composePlatformCaption(platform, {
    title: first ?? '',
    body: usesTitle ? rest.join('\n').trim() || body : body,
    tags,
    footer: footer || fallbackFooter,
  });
}

/** 플랫폼별로 저장된 LLM 변형 + 공통 안내(문자 후원 줄) → 게시 캡션 */
export function composeFromVariant(
  platform: SocialPlatform,
  variant: { title?: string; body: string },
  common: { moLines: string[]; tags: string[]; footer: string },
): PlatformPost {
  const body = [variant.body.trim(), common.moLines.join('\n')].filter(Boolean).join('\n\n');
  return composePlatformCaption(platform, { title: variant.title ?? null, body, tags: common.tags, footer: common.footer });
}

export function postToText(post: PlatformPost) {
  return post.title ? `${post.title}\n\n${post.text}` : post.text;
}
