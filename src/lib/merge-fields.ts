/**
 * 서식 머지 필드 — `{{후원자명}}` 같은 자리표시를 값으로 채운다.
 *
 * 화면(서식 편집 미리보기)과 서버(용도별 자동 발송 문서·약정서·전자문서 봉투)가 함께 쓰므로 순수 함수만 둔다.
 *
 * 규칙
 *  - 값이 없는 필드는 빈칸으로 둔다(지어내지 않는다). 무엇이 비었는지는 `missing` 으로 돌려주고, 미리보기는 경고한다.
 *  - 모르는 자리표시(오타)는 그대로 두고 `unknown` 으로 알린다 — 지우면 기관이 실수를 알아챌 수 없다.
 *  - 값에 전화번호·주민등록번호 꼴이 들어오면 마스킹한다(스냅샷·화면에는 마스킹 값만, 절대 규칙 6).
 *  - HTML 로 그릴 때는 서식 본문과 값을 모두 이스케이프한 뒤 치환한다.
 */

export interface MergeFieldDef {
  /** 자리표시 이름 (`{{이름}}`) */
  key: string;
  label: string;
  /** 서식 편집 미리보기에 쓰는 예시 값 */
  example: string;
  /** 주로 쓰는 용도(안내용) */
  hint: string;
}

export const MERGE_FIELDS: MergeFieldDef[] = [
  { key: '후원자명', label: '후원자 이름', example: '김나눔', hint: '모든 문서' },
  { key: '금액', label: '이번 후원 금액', example: '30,000원', hint: '감사장·약정서' },
  { key: '누적금액', label: '누적 후원 금액', example: '360,000원', hint: '정기후원·연말 감사장' },
  { key: '횟수', label: '누적 후원 횟수', example: '12회', hint: '정기후원 감사장' },
  { key: '날짜', label: '후원일', example: '2026-11-06', hint: '감사장' },
  { key: '캠페인', label: '캠페인 이름', example: '따뜻한 겨울나기', hint: '감사장' },
  { key: '기관명', label: '기관 이름', example: '해오름 복지관', hint: '모든 문서 (자동)' },
  { key: '대표자', label: '기관 대표자', example: '이대표', hint: '모든 문서 (자동)' },
  { key: '발급일', label: '문서 발급일', example: '2026-11-06', hint: '모든 문서 (자동)' },
  { key: '출금일', label: '정기후원 출금일(매월)', example: '15', hint: '약정서·변경 신청서' },
  { key: '활동명', label: '봉사 활동 이름', example: '어르신 말벗 봉사', hint: '봉사 확인서·감사장' },
  { key: '활동일', label: '봉사 활동일', example: '2026-11-01', hint: '봉사 확인서' },
  { key: '활동시간', label: '이번 활동 시간', example: '3시간', hint: '봉사 확인서' },
  { key: '누적시간', label: '누적 봉사 시간', example: '24시간', hint: '봉사 감사장' },
  { key: '귀속연도', label: '영수증 귀속연도', example: '2026', hint: '연말 감사장' },
  { key: '영수증번호', label: '기부금영수증 번호', example: 'GIV-8K2M-2026-000123', hint: '연말 감사장' },
  { key: '배정', label: '봉사 배정 내용', example: '토요일 오전 · 배식 지원', hint: '봉사 신청서·확인서' },
  // 2026-11-09 3차 H — 정보성 안내(결과 보고·연 1회 통보)
  { key: '보고제목', label: '사업 진행 기록 제목', example: '겨울나기 연탄 나눔 결과', hint: '사업 결과 보고' },
  { key: '보고내용', label: '사업 결과(캠페인 전체)', example: '모인 후원금으로 연탄 3,000장을 전달했습니다.', hint: '사업 결과 보고' },
  { key: '참여내역', label: '본인 참여 합계', example: '후원 3회 · 합계 90,000원', hint: '사업 결과 보고·연 1회 통보' },
  { key: '사용요약', label: '기관 전체 후원금 사용 요약', example: '수입 12,000,000원 · 사용 10,500,000원', hint: '연 1회 통보' },
];

export const MERGE_FIELD_KEYS = MERGE_FIELDS.map((f) => f.key);
const KNOWN = new Set(MERGE_FIELD_KEYS);

/** 머지 값. null/빈 문자열은 "값 없음" 이다. */
export type MergeValues = Partial<Record<string, string | null | undefined>>;

const PLACEHOLDER = /\{\{\s*([^{}\s][^{}]{0,19}?)\s*\}\}/g;

/** 본문에 쓰인 자리표시 이름(중복 제거, 나온 순서). */
export function mergeKeysIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const k = m[1]!.trim();
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export function hasMergeFields(text: string | null | undefined): boolean {
  return mergeKeysIn(text).length > 0;
}

/** 값 안의 전화번호·주민등록번호 꼴을 가린다(표시 이름에 번호를 적어 둔 후원자가 있다). */
export function maskSensitive(value: string): string {
  return value
    // 주민등록번호(앞 6 + 뒤 7). 뒷자리는 첫 자리만 남긴다.
    .replace(/(\d{6})[-\s]?([1-8])\d{6}/g, '$1-$2******')
    // 휴대폰·일반 전화. 가운데를 가린다.
    .replace(/(01[016789])[-\s.]?(\d{3,4})[-\s.]?(\d{4})/g, (_m, a: string, _b: string, c: string) => `${a}-****-${c}`)
    .replace(/(0[2-6]\d?)[-\s.](\d{3,4})[-\s.](\d{4})/g, (_m, a: string, _b: string, c: string) => `${a}-****-${c}`);
}

export interface MergeResult {
  text: string;
  /** 서식에 썼는데 값이 없어 빈칸으로 둔 필드 */
  missing: string[];
  /** 지원하지 않는 자리표시(그대로 남김) */
  unknown: string[];
  /** 서식에 쓰인 필드 */
  used: string[];
}

function cleanValue(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? maskSensitive(s) : null;
}

/** 일반 글자 치환(스냅샷 본문·PDF 글자·문자). */
export function renderMergeText(text: string | null | undefined, values: MergeValues): MergeResult {
  const missing: string[] = [];
  const unknown: string[] = [];
  const used: string[] = [];
  const out = (text ?? '').replace(PLACEHOLDER, (whole, raw: string) => {
    const key = raw.trim();
    if (!KNOWN.has(key)) {
      if (!unknown.includes(key)) unknown.push(key);
      return whole;
    }
    if (!used.includes(key)) used.push(key);
    const v = cleanValue(values[key]);
    if (v == null) {
      if (!missing.includes(key)) missing.push(key);
      return '';
    }
    return v;
  });
  return { text: out, missing, unknown, used };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML 로 그린다(미리보기·열람 화면). 본문과 값을 모두 이스케이프하고 줄바꿈은 <br> 로 바꾼다.
 * `highlight` 이면 빈칸을 표시해 미리보기에서 눈에 띄게 한다.
 */
export function renderMergeHtml(
  text: string | null | undefined,
  values: MergeValues,
  opts: { highlight?: boolean } = {},
): MergeResult & { html: string } {
  const base = renderMergeText(text, values);
  const html = escapeHtml(text ?? '')
    .replace(PLACEHOLDER, (whole, raw: string) => {
      const key = raw.trim();
      if (!KNOWN.has(key)) return opts.highlight ? `<mark data-merge="unknown">${whole}</mark>` : whole;
      const v = cleanValue(values[key]);
      if (v == null) return opts.highlight ? `<mark data-merge="missing">[${escapeHtml(key)} 없음]</mark>` : '';
      return opts.highlight ? `<mark data-merge="value">${escapeHtml(v)}</mark>` : escapeHtml(v);
    })
    .replace(/\r?\n/g, '<br>');
  return { ...base, html };
}

/** 서식 편집 미리보기용 예시 값 */
export function exampleMergeValues(): Record<string, string> {
  return Object.fromEntries(MERGE_FIELDS.map((f) => [f.key, f.example]));
}
