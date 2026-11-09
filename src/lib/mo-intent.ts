/**
 * 알아듣지 못한 문자의 보완 해석 (2026-11-12 4차 K2) — 규칙 + 편집거리. LLM 을 쓰지 않는다.
 *
 * 이 결과는 **선택 화면에 미리 골라 두는 값**으로만 쓴다. 결제 건을 만들거나 금액을 확정하지 않는다
 * (DIRECT_TRIGGER 여부와 무관). 기존 키워드·예약어 해석 순서를 바꾸지 않고, 그 뒤에만 부른다.
 *
 * 순수 함수만 둔다(DB 없음). 서버 쪽 연결은 src/server/services/mo-commands.ts.
 */

/** 비교용으로 접는다: NFKC, 공백·기호 제거, 대문자 */
export function compactText(raw: string): string {
  return (raw ?? '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toUpperCase();
}

/** 코드 포인트 단위 편집거리 */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= y.length; j += 1) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/** 키 길이에 따른 오타 허용치: 2자 이하 0, 3~5자 1, 6자 이상 2 */
export function typoAllowance(key: string): number {
  const n = [...key].length;
  if (n <= 2) return 0;
  if (n <= 5) return 1;
  return 2;
}

const HANGUL_DIGIT: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const HANGUL_SMALL_UNIT: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };

/** "삼만오천", "십만", "만" 같은 한글 수사 → 숫자. 읽을 수 없으면 null */
export function parseHangulNumber(s: string): number | null {
  if (!s || !/^[일이삼사오육칠팔구십백천만]+$/u.test(s)) return null;
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  for (const ch of s) {
    if (ch in HANGUL_DIGIT) {
      if (digit !== null) return null; // "삼삼" 같은 연속 숫자는 읽지 않는다
      digit = HANGUL_DIGIT[ch]!;
    } else if (ch in HANGUL_SMALL_UNIT) {
      section += (digit ?? 1) * HANGUL_SMALL_UNIT[ch]!;
      digit = null;
    } else if (ch === '만') {
      section += digit ?? 0;
      total += (section || 1) * 10000;
      section = 0;
      digit = null;
    }
  }
  section += digit ?? 0;
  return total + section;
}

const AMOUNT_MIN = 1000;
const AMOUNT_MAX = 100_000_000;

export interface AmountHit {
  amount: number;
  /** 금액 표현을 뺀 나머지 */
  rest: string;
}

/**
 * 문자 안의 금액 표현을 하나 찾는다: "30000", "30,000원", "3만", "3만원", "1만5천", "5천원", "삼만원", "만원".
 * 1천 원 미만·1억 원 초과·단위 없는 한글 수사(예: "이")는 금액으로 보지 않는다.
 */
export function extractAmount(text: string): AmountHit | null {
  const t = (text ?? '').normalize('NFKC');
  const patterns: Array<{ re: RegExp; read: (m: RegExpMatchArray) => number | null }> = [
    // 숫자 + 만 (+ 숫자 천) — "3만", "1만 5천원", "3.5만"
    {
      re: /(\d{1,4}(?:\.\d)?)\s*만\s*(?:(\d)\s*천)?\s*원?/u,
      read: (m) => Math.round(Number(m[1]) * 10000) + (m[2] ? Number(m[2]) * 1000 : 0),
    },
    // 숫자 + 천 — "5천원"
    { re: /(\d{1,2})\s*천\s*원?/u, read: (m) => Number(m[1]) * 1000 },
    // 숫자(쉼표 가능) — "30,000원", "30000"
    { re: /(\d{1,3}(?:,\d{3})+|\d{4,9})\s*원?/u, read: (m) => Number(m[1]!.replace(/,/g, '')) },
    // 한글 수사 — 만·천이 들어가거나 "원" 으로 끝나야 금액으로 본다
    {
      re: /([일이삼사오육칠팔구십백천만]*[만천][일이삼사오육칠팔구십백천만]*)\s*원?|([일이삼사오육칠팔구십백]+)\s*원/u,
      read: (m) => parseHangulNumber(m[1] ?? m[2] ?? ''),
    },
  ];
  for (const p of patterns) {
    const m = t.match(p.re);
    if (!m || m.index === undefined) continue;
    const amount = p.read(m);
    if (amount === null || !Number.isFinite(amount) || amount < AMOUNT_MIN || amount > AMOUNT_MAX) continue;
    const rest = `${t.slice(0, m.index)} ${t.slice(m.index + m[0].length)}`.replace(/\s+/g, ' ').trim();
    return { amount, rest };
  }
  return null;
}

/** 키워드 뒤에 흔히 붙는 말("후원", "기부합니다" …) */
const COMMON_SUFFIX = /(캠페인|후원금|후원|기부금|기부|참여|합니다|할게요|해요|하기|신청|응원)+$/u;

export function stripCommonSuffix(compact: string): string {
  const s = compact.replace(COMMON_SUFFIX, '');
  return s.length >= 2 ? s : compact;
}

export type IntentVia = 'SPACING' | 'SUFFIX' | 'ALIAS' | 'TYPO';

export interface IntentEntry<T> {
  /** 비교할 키(캠페인 키워드·별칭·홍보물 키워드 등). 정규화 전 값도 된다. */
  key: string;
  /** 별칭이면 true(결과 표시용) */
  alias?: boolean;
  ref: T;
}

export interface IntentMatch<T> {
  ref: T;
  key: string;
  via: IntentVia;
  /** 0 = 띄어쓰기·접미사·별칭 정확 일치, 1~2 = 오타 거리 */
  distance: number;
}

/**
 * 문자 본문을 등록된 키 목록과 비교한다. 결과는 거리순(같은 ref 는 가장 가까운 것 하나).
 *  - 띄어쓰기 무시("김 장" → 김장), 맨 앞 낱말·전체 본문 모두 본다.
 *  - 흔한 접미사("김장후원") 제거, 앞부분 일치("김장후원합니다")
 *  - 오타는 맨 앞 낱말(접미사 뗀 값)과 키의 편집거리가 허용치 이하일 때만
 */
export function matchIntent<T>(body: string, entries: Array<IntentEntry<T>>): Array<IntentMatch<T>> {
  const text = (body ?? '').normalize('NFKC').trim();
  if (!text) return [];
  const tokens = text.split(/\s+/u).filter(Boolean);
  const whole = compactText(text);
  const first = compactText(tokens[0] ?? '');
  const firstTwo = compactText(tokens.slice(0, 2).join(''));
  const variants = [...new Set([whole, first, firstTwo, stripCommonSuffix(whole), stripCommonSuffix(first), stripCommonSuffix(firstTwo)].filter((v) => v.length >= 2))];
  const typoBase = [...new Set([stripCommonSuffix(first), stripCommonSuffix(firstTwo)].filter((v) => v.length >= 2))];

  const best = new Map<T, IntentMatch<T>>();
  const consider = (m: IntentMatch<T>) => {
    const cur = best.get(m.ref);
    if (!cur || m.distance < cur.distance) best.set(m.ref, m);
  };
  for (const e of entries) {
    const key = compactText(e.key);
    if (key.length < 2) continue;
    if (variants.includes(key)) {
      consider({ ref: e.ref, key: e.key, via: e.alias ? 'ALIAS' : whole === key || first === key ? 'SPACING' : 'SUFFIX', distance: 0 });
      continue;
    }
    if (variants.some((v) => v.startsWith(key))) {
      consider({ ref: e.ref, key: e.key, via: e.alias ? 'ALIAS' : 'SUFFIX', distance: 0 });
      continue;
    }
    const allow = typoAllowance(key);
    if (allow === 0) continue;
    let d = Infinity;
    for (const v of typoBase) d = Math.min(d, editDistance(v, key));
    if (d <= allow) consider({ ref: e.ref, key: e.key, via: 'TYPO', distance: d });
  }
  return [...best.values()].sort((a, b) => a.distance - b.distance);
}

/** 가장 가까운 것이 하나뿐이면 그것, 같은 거리가 둘 이상이면 null(고르게 한다) */
export function uniqueBest<T>(matches: Array<IntentMatch<T>>): IntentMatch<T> | null {
  if (matches.length === 0) return null;
  if (matches.length > 1 && matches[1]!.distance === matches[0]!.distance) return null;
  return matches[0]!;
}

/** 금액 표시(문자 본문 미리 채우기용): 30000 → "3만원", 15000 → "15000원" */
export function amountShortText(amount: number): string {
  if (amount % 10000 === 0) return `${amount / 10000}만원`;
  return `${amount}원`;
}
