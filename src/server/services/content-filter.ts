/**
 * 문자 내용 필터.
 *
 * 처리 순서
 *  1) 제어문자/과도한 공백 정리
 *  2) 개인정보 패턴 마스킹 (전화번호, 주민등록번호, 카드/계좌, 이메일, URL)
 *  3) 금칙어 처리 (BLOCK / MASK / FLAG)
 *  4) 길이 제한
 *
 * 외부 노출은 반드시 이 함수의 결과(clean)만 사용한다.
 * 원문은 분쟁 대응을 위해 암호화 보관한다.
 */

export type FilterAction = 'ALLOW' | 'MASK' | 'BLOCK';

export interface BannedWordRule {
  word: string;
  action: 'BLOCK' | 'MASK' | 'FLAG';
}

export interface FilterResult {
  clean: string;
  action: FilterAction;
  reasons: string[];
  flagged: string[];
  containsPersonalInfo: boolean;
}

const RRN = /\b\d{6}[-\s]?[1-4]\d{6}\b/g; // 주민등록번호
const CARD = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const PHONE = /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g;
const TEL = /\b0(?:2|[3-6]\d)[-\s]?\d{3,4}[-\s]?\d{4}\b/g;
const ACCOUNT = /\b\d{2,6}[-]\d{2,6}[-]\d{2,6}\b/g;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const URL = /(https?:\/\/|www\.)[^\s]+/gi;
const CONTROL = /[\u0000-\u001F\u007F]/g;
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;

function maskRun(match: string): string {
  const visible = match.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(3, match.length - 2))}`;
}

export function normalizeText(input: string): string {
  return (input || '')
    .replace(CONTROL, '')
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// 금칙어 매칭
//
// 예전에는 금칙어 글자 사이에 구분자 클래스를 끼운 정규식을 만들어 썼다.
// 그 방식은 금칙어 자체가 그 구분자 문자로 이뤄지면(예: 스팸을 막으려고 등록한 "......")
// 탐욕적 반복이 연쇄되어 역추적이 지수적으로 폭발한다. 금칙어 40자에 메시지 60자
// 조합에서 판정 한 번이 2분을 넘겼고, filterContent 는 동기 함수라 그동안
// 같은 프로세스의 모든 요청이 — 다른 사회복지기관의 결제까지 — 함께 멈춘다.
//
// 그래서 정규식을 버리고 "뼈대 비교" 로 바꿨다.
// 양쪽에서 무시할 문자를 걷어낸 뒤 단순 부분문자열 검색을 한다. 항상 선형 시간이다.
// 덤으로 한글 채움 문자나 결합 기호처럼 눈에 띄지 않는 우회도 함께 막힌다.
// ---------------------------------------------------------------------------

/**
 * 금칙어 비교에서 무시하는 문자.
 *  - 공백과 흔한 구분 기호: "바 보", "바.보", "바_보" 우회 차단
 *  - 폭 없는 문자와 방향 제어 문자
 *  - 한글 채움 문자 (U+115F, U+1160, U+3164, U+FFA0)
 *  - 결합 발음 기호: 글자 위에 얹혀 보이지 않는 우회 차단 (아래 COMBINING_MARK)
 */
const IGNORABLE = /[\s._*~=+\/\u200B-\u200F\u202A-\u202E\uFEFF\u115F\u1160\u3164\uFFA0-]/u;
const COMBINING_MARK = /\p{M}/u;

function ignorable(ch: string): boolean {
  return IGNORABLE.test(ch) || COMBINING_MARK.test(ch);
}

interface Skeleton {
  /** 무시 문자를 걷어내고 소문자로 접은 비교용 문자열 */
  text: string;
  /** 뼈대의 i 번째 글자가 원문에서 시작하는 위치 */
  start: number[];
  /** 뼈대의 i 번째 글자가 원문에서 끝나는 위치 */
  end: number[];
}

/**
 * 비교용 뼈대를 만든다.
 * 원문 위치를 함께 들고 있어야, 마스킹할 때 우회에 쓰인 기호까지 정확히 가릴 수 있다.
 */
function skeletonOf(input: string): Skeleton {
  const buf: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let pos = 0;

  for (const ch of input) {
    const next = pos + ch.length; // 서로게이트 쌍(이모지 등)도 원문 길이 그대로 센다
    if (!ignorable(ch)) {
      // NFKC 로 접어 전각·호환 문자를 같은 글자로 본다
      for (const folded of ch.normalize('NFKC').toLowerCase()) {
        if (ignorable(folded)) continue;
        buf.push(folded);
        start.push(pos);
        end.push(next);
      }
    }
    pos = next;
  }

  return { text: buf.join(''), start, end };
}

/**
 * 금칙어를 비교용 형태로 바꾼다.
 * 무시 문자만으로 이뤄진 단어는 어떤 문장과도 비교할 수 없으므로 빈 문자열을 돌려준다.
 */
export function bannedNeedle(word: string): string {
  return skeletonOf(word).text;
}

/** 문장에 금칙어가 들어 있는지 확인한다 (우회 기호·대소문자·전각 무시). */
export function containsBannedWord(text: string, word: string): boolean {
  const needle = bannedNeedle(word);
  if (!needle) return false;
  return skeletonOf(text).text.includes(needle);
}

/** 금칙어 구간을 별표로 가린다. 우회에 쓰인 기호까지 함께 가린다. */
function maskBannedWord(text: string, word: string): { text: string; hit: boolean } {
  const needle = bannedNeedle(word);
  if (!needle) return { text, hit: false };

  const sk = skeletonOf(text);
  const spans: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = sk.text.indexOf(needle, from);
    if (at < 0) break;
    spans.push([sk.start[at], sk.end[at + needle.length - 1]]);
    from = at + needle.length;
  }
  if (spans.length === 0) return { text, hit: false };

  let out = '';
  let cursor = 0;
  for (const [s, e] of spans) {
    out += text.slice(cursor, s) + '*'.repeat(e - s);
    cursor = e;
  }
  return { text: out + text.slice(cursor), hit: true };
}

// ---------------------------------------------------------------------------
// 키워드 정규화
//
// 등록(관리자 화면)과 매칭(수신 문자 파싱)이 서로 다른 규칙을 쓰면, 화면에서 보기에는
// 같은 키워드인데 실제로는 영원히 매칭되지 않는다. 예전에는
//   등록: toUpperCase() + 공백 제거
//   매칭: toUpperCase() + 하이픈 제거
// 라서 "GIV-1234" 로 등록하면 등록값은 `GIV-1234`, 수신 파싱값은 `GIV1234` 가 되어
// 그 사회복지기관의 결제가 전건 UNKNOWN_ROUTE 로 떨어졌다. 아래 한 함수로 통일한다.
// ---------------------------------------------------------------------------

/** 키워드 비교에서 무시하는 구분 문자. 등록·매칭 양쪽에서 같은 값을 쓴다. */
const KEYWORD_SEPARATOR = /[\s._\-*~/+#]/gu;

/**
 * 키워드를 비교용 표준형으로 바꾼다.
 *
 *  - NFKC 로 접어 전각(ＭＳＧ)·호환 문자를 같은 글자로 본다
 *  - 공백·하이픈·밑줄·점 등 구분 기호를 제거한다 ("GIV-1234" = "giv 1234" = "GIV1234")
 *  - 대문자로 접는다 (한글에는 영향이 없다)
 */
export function normalizeKeyword(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFKC')
    .replace(KEYWORD_SEPARATOR, '')
    .toUpperCase();
}

/**
 * 키워드로 쓸 수 있는 값인지 검사한다(정규화 후 기준).
 * 한글·영문·숫자 2~16자만 허용한다. 기호만으로 이뤄진 키워드는 매칭이 불가능하다.
 */
export function isValidKeyword(raw: string | null | undefined): boolean {
  const k = normalizeKeyword(raw);
  return /^[\p{L}\p{N}]{2,16}$/u.test(k);
}

/**
 * SHARED_PREFIX 모드에서 문자 맨 앞 키워드를 분리한다.
 *
 * 한글 키워드("후원 1만원")도 받는다. 예전 정규식은 ASCII 만 봐서, 관리자 화면에서
 * 한글 키워드를 등록할 수 있는데 수신 쪽에서는 절대 매칭되지 않았다.
 */
export function splitKeyword(text: string): { keyword: string | null; rest: string } {
  const t = normalizeText(text);
  // 첫 토큰이 글자/숫자로 시작하고, 안쪽에 구분 기호(-, _, .)를 품을 수 있다.
  const m = t.match(/^([\p{L}\p{N}][\p{L}\p{N}._-]{1,19})\s+([\s\S]*)$/u);
  if (!m) return { keyword: null, rest: t };
  const keyword = normalizeKeyword(m[1]);
  if (!isValidKeyword(keyword)) return { keyword: null, rest: t };
  return { keyword, rest: m[2] };
}

export function filterContent(
  raw: string,
  options: { bannedWords?: BannedWordRule[]; maxLength?: number } = {},
): FilterResult {
  const reasons: string[] = [];
  const flagged: string[] = [];
  let text = normalizeText(raw);
  let containsPersonalInfo = false;

  const before = text;
  text = text
    .replace(RRN, (m) => {
      containsPersonalInfo = true;
      return maskRun(m);
    })
    .replace(CARD, (m) => {
      containsPersonalInfo = true;
      return maskRun(m);
    })
    .replace(PHONE, (m) => {
      containsPersonalInfo = true;
      return maskRun(m);
    })
    .replace(TEL, (m) => {
      containsPersonalInfo = true;
      return maskRun(m);
    })
    .replace(ACCOUNT, (m) => {
      containsPersonalInfo = true;
      return maskRun(m);
    })
    .replace(EMAIL, (m) => {
      containsPersonalInfo = true;
      return maskRun(m);
    })
    .replace(URL, () => {
      containsPersonalInfo = true;
      return '[링크 차단]';
    });

  if (before !== text) reasons.push('개인정보 또는 링크 마스킹');

  let action: FilterAction = 'ALLOW';

  for (const rule of options.bannedWords ?? []) {
    const word = rule.word.trim();
    if (!word) continue;

    if (rule.action === 'MASK') {
      const masked = maskBannedWord(text, word);
      if (!masked.hit) continue;
      flagged.push(word);
      text = masked.text;
      if (action === 'ALLOW') action = 'MASK';
      reasons.push(`금칙어 마스킹: ${word}`);
      continue;
    }

    if (!containsBannedWord(text, word)) continue;
    flagged.push(word);
    if (rule.action === 'BLOCK') {
      action = 'BLOCK';
      reasons.push(`금칙어 차단: ${word}`);
    } else {
      reasons.push(`금칙어 플래그: ${word}`);
    }
  }

  const max = options.maxLength ?? 100;
  if (text.length > max) {
    text = `${text.slice(0, max - 3)}...`;
    reasons.push(`길이 제한 ${max}자 적용`);
  }

  if (!text) {
    text = '(내용 없음)';
  }

  return { clean: text, action, reasons, flagged, containsPersonalInfo };
}
