/**
 * 정보성 안내 문구 검사 (2026-11-09 3차 H) — 순수 함수(화면·서버·테스트 공용).
 *
 *  - 후원금 사용 결과 보고(IMPACT_REPORT)·연 1회 후원금 통보(ANNUAL_DONATION_NOTICE)는 **정보성** 안내다.
 *    후원 권유 문구("더 후원해 주세요")·후원 링크를 넣지 않는다(절대 규칙 11 — 광고성 발송 금지).
 *  - 개인별 사용처("당신의 3만 원이 ○○에 쓰였습니다")를 만들지 않는다. 보고는 캠페인 전체 결과다.
 *  - AI 초안은 숫자를 만들지 않는다 — 초안 속 숫자는 기관이 입력한 숫자·원천 숫자 집합 안에 있어야 한다.
 */

/** 후원 권유로 읽히는 표현. 감사 표현("함께해 주셔서")은 넣지 않는다. */
const SOLICITATION_PATTERNS: RegExp[] = [
  /더\s*후원/,
  /추가\s*후원/,
  /후원\s*해\s*주세요/,
  /후원을?\s*부탁/,
  /후원\s*(?:참여|동참)/,
  /정기\s*후원\s*(?:신청|가입|전환|으로\s*전환)/,
  /증액/,
  /지금\s*후원/,
  /후원\s*하기/,
  /(?:참여|동참)\s*해\s*주세요/,
  /(?:참여|동참)을?\s*부탁/,
  /나눔에\s*함께해\s*주세요/,
  /https?:\/\//i,
  /www\./i,
  /\/donate\//,
];

/** 권유 문구가 있으면 그 부분(최대 20자)을, 없으면 null. */
export function solicitationHit(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const re of SOLICITATION_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0].slice(0, 20);
  }
  return null;
}

/**
 * 개인별 사용처 표현 — "당신의/후원자님의/님께서 보내 주신 3만 원(후원금)이 … 쓰였다·사용되었다·전달되었다".
 * 캠페인 전체 결과("모인 후원금 1,200,000원으로 …")는 걸리지 않는다.
 */
const PERSONAL_ALLOCATION_PATTERNS: RegExp[] = [
  /(?:당신|귀하|후원자님|회원님|님)(?:의|께서|이|가)?\s*(?:보내\s*주신\s*|주신\s*|내신\s*)?(?:소중한\s*)?(?:[\d,]+\s*(?:만\s*)?원|후원금|후원|기부금)[이가은는]?\s*.{0,30}?(?:쓰였|쓰이|사용되|사용됐|전달되|전달됐|들어갔|마련되)/,
  /(?:보내\s*주신|주신)\s*[\d,]+\s*(?:만\s*)?원[이가은는]?\s*.{0,30}?(?:쓰였|쓰이|사용되|사용됐|전달되|전달됐|들어갔|마련되)/,
];

export function personalAllocationHit(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const re of PERSONAL_ALLOCATION_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0].slice(0, 30);
  }
  return null;
}

/** 글 속 숫자(쉼표 제거, 앞의 0 제거). "1,200,000원" → "1200000", "2026-03-05" → 2026·3·5. */
export function extractNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, '').replace(/\.$/, '');
    const norm = raw.includes('.') ? String(Number(raw)) : raw.replace(/^0+(?=\d)/, '');
    if (norm) out.push(norm);
  }
  return out;
}

/** 허용 숫자 집합(기관 입력·원천 숫자). 날짜는 연·월·일 조각까지 넣는다. */
export function allowedNumberSet(sources: Array<string | number | bigint | null | undefined>): Set<string> {
  const set = new Set<string>();
  for (const s of sources) {
    if (s == null) continue;
    if (typeof s === 'bigint' || typeof s === 'number') {
      set.add(String(s));
      continue;
    }
    for (const n of extractNumbers(s)) set.add(n);
  }
  return set;
}

/** 초안 속 숫자 중 허용 집합에 없는 것(중복 제거). 비면 통과. */
export function numbersOutside(text: string, allowed: Set<string>): string[] {
  const bad: string[] = [];
  for (const n of extractNumbers(text)) if (!allowed.has(n) && !bad.includes(n)) bad.push(n);
  return bad;
}
