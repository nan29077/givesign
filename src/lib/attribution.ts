/**
 * 유입 경로(attribution).
 *
 * SNS 게시물·QR·문자 링크에 `?src=yt&cid=<콘텐츠ID>` 를 붙여 두면, 그 링크로 들어온 사람의
 * 후원·정기 약정·자원봉사 신청에 경로가 기록된다. "이 숏폼이 후원 몇 건을 만들었나" 의 원천이다.
 *
 * 쿠키(7일)로 들고 다니며, 마지막에 누른 링크가 이긴다(last touch).
 * 값은 아래 목록으로만 정규화한다 — 임의 문자열을 그대로 저장하지 않는다.
 */

export const SOURCES = ['YOUTUBE', 'INSTAGRAM', 'FACEBOOK', 'SMS', 'WEB', 'QR', 'IMPORT'] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABEL: Record<Source, string> = {
  YOUTUBE: '유튜브',
  INSTAGRAM: '인스타그램',
  FACEBOOK: '페이스북',
  SMS: '문자',
  WEB: '웹',
  QR: 'QR',
  IMPORT: '기관 명단',
};

const ALIASES: Record<string, Source> = {
  yt: 'YOUTUBE',
  youtube: 'YOUTUBE',
  ig: 'INSTAGRAM',
  insta: 'INSTAGRAM',
  instagram: 'INSTAGRAM',
  fb: 'FACEBOOK',
  facebook: 'FACEBOOK',
  sms: 'SMS',
  mo: 'SMS',
  web: 'WEB',
  qr: 'QR',
};

export const ATTRIBUTION_COOKIE = 'givesign_src';
export const ATTRIBUTION_MAX_AGE_SEC = 7 * 24 * 3600;

export function normalizeSource(raw: string | null | undefined): Source | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (ALIASES[key]) return ALIASES[key];
  const upper = key.toUpperCase();
  return (SOURCES as readonly string[]).includes(upper) ? (upper as Source) : null;
}

/** 콘텐츠 ID 는 ULID(26자) 형식만 받는다. */
export function normalizeContentId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v) ? v : null;
}

export interface Attribution {
  source: Source;
  contentItemId: string | null;
}

export function encodeAttribution(a: Attribution): string {
  return a.contentItemId ? `${a.source}.${a.contentItemId}` : a.source;
}

export function decodeAttribution(raw: string | null | undefined): Attribution | null {
  if (!raw) return null;
  const [s, c] = raw.split('.');
  const source = normalizeSource(s);
  if (!source) return null;
  return { source, contentItemId: normalizeContentId(c) };
}

export function sourceLabel(raw: string | null | undefined): string {
  const s = normalizeSource(raw);
  return s ? SOURCE_LABEL[s] : '알 수 없음';
}

/** 게시물 캡션에 넣는 링크에 붙일 쿼리. */
export function attributionQuery(source: Source, contentItemId?: string | null): string {
  const short = Object.entries(ALIASES).find(([, v]) => v === source)?.[0] ?? source.toLowerCase();
  return contentItemId ? `src=${short}&cid=${contentItemId}` : `src=${short}`;
}
