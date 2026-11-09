/**
 * 고유번호증·사업자등록증 글자 → 기관 정보 입력칸 후보 (2026-11-12 4차 I2, 순수 함수).
 *
 * 읽은 줄(OCR 결과)에서 이름·번호·대표자·주소 후보만 고른다. 결과는 **입력칸 채우기**에만 쓰고 저장은 담당자가 한다.
 * 주민등록번호·외국인등록번호 꼴(앞 6자리 + 뒷자리 [1-8]로 시작하는 7자리)은 고르기 전에 가린다 — 가린 값만 남긴다.
 */

export interface OrgDocLine {
  text: string;
  confidence: number;
}

export interface OrgDocCandidate {
  value: string;
  confidence: number;
}

export interface OrgDocCandidates {
  name?: OrgDocCandidate;
  businessNo?: OrgDocCandidate;
  representative?: OrgDocCandidate;
  address?: OrgDocCandidate;
}

export const RESIDENT_NO_RE = /(\d{6})[-\s]?([1-8])\d{6}/g;

/** 주민번호·외국인등록번호 꼴을 가린다(앞 6자리-뒷자리 첫 숫자 + ******). */
export function maskResidentNumbers(text: string): string {
  return text.replace(RESIDENT_NO_RE, (_m, a: string, b: string) => `${a}-${b}******`);
}

const BUSINESS_NO_RE = /(?<!\d)(\d{3})[-\s.]?(\d{2})[-\s.]?(\d{5})(?!\d)/;

const LABELS = {
  name: /^(?:상\s*호|법\s*인\s*명|단\s*체\s*명|명\s*칭|기\s*관\s*명|법인명\s*\(단체명\))\s*(?:\([^)]*\))?\s*[:：]?\s*/,
  representative: /^(?:대\s*표\s*자|성\s*명|대\s*표\s*자\s*성\s*명)\s*(?:\([^)]*\))?\s*[:：]?\s*/,
  address: /^(?:사\s*업\s*장\s*소\s*재\s*지|본\s*점\s*소\s*재\s*지|소\s*재\s*지|주\s*소)\s*(?:\([^)]*\))?\s*[:：]?\s*/,
  businessNo: /(?:등\s*록\s*번\s*호|고\s*유\s*번\s*호)/,
};

function clean(v: string, max: number): string {
  return v.replace(/\s+/g, ' ').replace(/^[\s:：·\-]+/, '').trim().slice(0, max);
}

/** 대표자 칸에 생년월일·주민번호 등이 붙어 오면 이름 부분만 남긴다. */
function nameOnly(v: string): string {
  const head = v.split(/\s*(?:생\s*년\s*월\s*일|주\s*민|\d)/)[0] ?? v;
  return clean(head, 30);
}

export function parseOrgDocument(input: OrgDocLine[]): OrgDocCandidates {
  const lines = input.map((l) => ({ text: maskResidentNumbers(l.text ?? '').trim(), confidence: Number.isFinite(l.confidence) ? l.confidence : 0.5 })).filter((l) => l.text);
  const out: OrgDocCandidates = {};
  const take = (key: keyof OrgDocCandidates, value: string, confidence: number) => {
    if (!value) return;
    const cur = out[key];
    if (!cur || confidence > cur.confidence) out[key] = { value, confidence: Math.round(confidence * 100) / 100 };
  };

  // 번호: 등록번호·고유번호 줄을 먼저(같은 줄 또는 다음 줄), 없으면 문서에서 처음 나온 000-00-00000
  lines.forEach((l, i) => {
    if (!LABELS.businessNo.test(l.text)) return;
    const m = l.text.match(BUSINESS_NO_RE) ?? lines[i + 1]?.text.match(BUSINESS_NO_RE);
    if (m) take('businessNo', `${m[1]}-${m[2]}-${m[3]}`, l.confidence);
  });
  if (!out.businessNo) {
    for (const l of lines) {
      const m = l.text.match(BUSINESS_NO_RE);
      if (m) {
        take('businessNo', `${m[1]}-${m[2]}-${m[3]}`, l.confidence * 0.8);
        break;
      }
    }
  }

  lines.forEach((l, i) => {
    for (const key of ['name', 'representative', 'address'] as const) {
      const re = LABELS[key];
      if (!re.test(l.text)) continue;
      let value = l.text.replace(re, '');
      // 칸 이름만 있고 값이 다음 줄에 있는 서식
      if (!value.trim() && lines[i + 1] && !Object.values(LABELS).some((r) => r.test(lines[i + 1]!.text))) value = lines[i + 1]!.text;
      // 한 줄에 다른 칸이 이어 붙은 경우(예: "상호 OO복지관 대표자 홍길동") 앞부분만
      value = value.split(/\s+(?=(?:대\s*표\s*자|성\s*명|개\s*업\s*연\s*월\s*일|사\s*업\s*장|소\s*재\s*지|등\s*록\s*번\s*호|고\s*유\s*번\s*호)\s*[:：]?)/)[0] ?? value;
      if (key === 'representative') take(key, nameOnly(value), l.confidence);
      else take(key, clean(value, key === 'address' ? 200 : 60), l.confidence);
    }
  });
  if (out.address) out.address.value = maskResidentNumbers(out.address.value);
  return out;
}

/** 후보가 하나라도 있는가 */
export function hasCandidates(c: OrgDocCandidates): boolean {
  return Boolean(c.name || c.businessNo || c.representative || c.address);
}
