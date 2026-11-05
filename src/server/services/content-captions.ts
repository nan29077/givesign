import type { SocialPlatform } from '@/generated/prisma/enums';

/**
 * 플랫폼별 캡션 규칙 (순수 함수 — DB·네트워크 없음).
 *
 * 공통: 후원 링크({링크})와 "AI 생성 콘텐츠" 표시(모집등록번호 포함)는 어떤 플랫폼에서도 잘리지 않는다.
 * 길이를 넘으면 본문만 줄인다. 해시태그는 플랫폼 상한까지만.
 * 길이는 {링크} 자리를 **실제 링크 최대 길이(linkReserve)** 로 셈한다 — 치환 뒤 길어져 어댑터가 꼬리(표시·링크)를
 * 자르는 일이 없게(2026-11-06 점검 A-M10). 어댑터는 자르지 않고, 넘으면 검증 실패로 돌려준다.
 *
 *  - 유튜브      : 제목 100자 이내(꺾쇠 제거) + 설명(UTF-8 5,000바이트 이내, 꺾쇠 제거)
 *  - 인스타그램  : 2,200자, 해시태그 30개 이하, 캡션 링크는 눌리지 않으므로 "프로필 링크" 안내 + 링크
 *  - 페이스북    : 링크를 맨 위에
 *  - 틱톡        : 2,200자, 해시태그 5개 이하
 *  - 네이버 블로그: 제목 + 문단 본문
 *  - 카카오 채널 : 짧은 소식 + 링크 (해시태그 없음)
 */

export const LINK_TOKEN = '{링크}';

/** {링크} 자리 기본 예약 길이(실제 링크가 이보다 길면 호출부가 더 큰 값을 넘긴다) */
export const DEFAULT_LINK_RESERVE = 160;

export interface CaptionRule {
  maxChars: number;
  /** 바이트 상한(UTF-8). 유튜브 설명은 글자가 아니라 5,000바이트다. */
  maxBytes?: number;
  maxTags: number;
  titleMax: number | null;
}

export const PLATFORM_CAPTION_RULES: Record<SocialPlatform, CaptionRule> = {
  YOUTUBE: { maxChars: 5000, maxBytes: 5000, maxTags: 15, titleMax: 100 },
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

/** 규칙 안에 드는지(글자 수 + 바이트). linkReserve 를 넘기면 {링크} 자리를 그 길이로 센다. */
export function fitsRule(text: string, rule: CaptionRule, linkReserve = 0): boolean {
  const t = linkReserve > 0 ? text.split(LINK_TOKEN).join('x'.repeat(linkReserve)) : text;
  if (Array.from(t).length > rule.maxChars) return false;
  if (rule.maxBytes && Buffer.byteLength(t, 'utf8') > rule.maxBytes) return false;
  return true;
}

/** 본문을 줄여 전체 길이를 맞춘다(링크·표시는 고정). 글자(코드 포인트) 경계에서만 자른다. */
function fit(fixedBefore: string[], body: string, fixedAfter: string[], rule: CaptionRule, linkReserve: number) {
  const join = (b: string) => [...fixedBefore, b, ...fixedAfter].filter((l) => l !== '').join('\n\n');
  const full = join(body);
  if (fitsRule(full, rule, linkReserve)) return full;
  const chars = Array.from(body);
  const cutAt = (n: number) => (n >= chars.length ? body : n <= 0 ? '' : `${chars.slice(0, n).join('').trimEnd()}…`);
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fitsRule(join(cutAt(mid)), rule, linkReserve)) lo = mid;
    else hi = mid - 1;
  }
  // 고정 부분만으로도 넘치면 본문 없이 돌려준다 — 게시 직전 검증(captionProblem)이 거절한다.
  return join(cutAt(lo));
}

/** 게시 직전 검증(링크 치환 뒤). 넘치면 사유, 맞으면 null. 자르지 않는다. */
export function captionProblem(platform: SocialPlatform, post: PlatformPost): string | null {
  const rule = PLATFORM_CAPTION_RULES[platform];
  if (!fitsRule(post.text, rule)) {
    return rule.maxBytes
      ? `게시 글이 ${rule.maxChars.toLocaleString()}자·${rule.maxBytes.toLocaleString()}바이트 한도를 넘습니다. 캡션 본문을 줄여 주세요.`
      : `게시 글이 ${rule.maxChars.toLocaleString()}자 한도를 넘습니다. 캡션 본문을 줄여 주세요.`;
  }
  if (rule.titleMax && post.title && Array.from(post.title).length > rule.titleMax) return `제목이 ${rule.titleMax}자를 넘습니다.`;
  return null;
}

export function composePlatformCaption(platform: SocialPlatform, parts: CaptionParts, linkReserve = DEFAULT_LINK_RESERVE): PlatformPost {
  const rule = PLATFORM_CAPTION_RULES[platform];
  // 유튜브는 제목·설명에 꺾쇠(< >)를 받지 않는다.
  const body = platform === 'YOUTUBE' ? parts.body.replace(/[<>]/g, '').trim() : parts.body.trim();
  const firstLine = body.split('\n')[0] ?? '';
  const titleSrc = (parts.title ?? firstLine).replace(/[<>]/g, '').trim();
  const title = rule.titleMax ? cut(titleSrc, rule.titleMax) : null;
  const tags = tagLine(parts.tags, rule.maxTags);
  const link = `후원하기: ${LINK_TOKEN}`;
  switch (platform) {
    case 'INSTAGRAM':
      return { title: null, text: fit([], body, ['프로필 링크에서도 후원할 수 있습니다.\n' + link, tags, parts.footer], rule, linkReserve) };
    case 'FACEBOOK':
      return { title: null, text: fit([link], body, [tags, parts.footer], rule, linkReserve) };
    case 'KAKAO_CHANNEL':
      return { title: null, text: fit([], cut(body, 300), [link, parts.footer], rule, linkReserve) };
    case 'YOUTUBE':
    case 'NAVER_BLOG':
    case 'TIKTOK':
    default:
      return { title, text: fit([], body, [link, tags, parts.footer], rule, linkReserve) };
  }
}

/**
 * 기본 캡션(한 장)을 플랫폼 규칙으로 바꾼다 — mock 공급자이거나 담당자가 캡션을 고친 경우.
 * 해시태그 줄·링크 줄·AI 표시 줄을 찾아 떼어 낸 뒤 composePlatformCaption 으로 다시 묶는다.
 */
export function adaptCaption(base: string, platform: SocialPlatform, fallbackFooter = 'AI 생성 콘텐츠', linkReserve = DEFAULT_LINK_RESERVE): PlatformPost {
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
  }, linkReserve);
}

/** 플랫폼별로 저장된 LLM 변형 + 공통 안내(문자 후원 줄) → 게시 캡션 */
export function composeFromVariant(
  platform: SocialPlatform,
  variant: { title?: string; body: string },
  common: { moLines: string[]; tags: string[]; footer: string },
  linkReserve = DEFAULT_LINK_RESERVE,
): PlatformPost {
  const body = [variant.body.trim(), common.moLines.join('\n')].filter(Boolean).join('\n\n');
  return composePlatformCaption(platform, { title: variant.title ?? null, body, tags: common.tags, footer: common.footer }, linkReserve);
}

export function postToText(post: PlatformPost) {
  return post.title ? `${post.title}\n\n${post.text}` : post.text;
}
