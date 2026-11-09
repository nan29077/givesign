import { MERGE_FIELD_KEYS, mergeKeysIn } from '@/lib/merge-fields';

/**
 * 문서 발송 전 점검 — 순수 판정(화면·서버·테스트 공용, DB·파일을 읽지 않는다).
 *
 * 결과 `{ level, issues }`:
 *  - block: 보내면 안 되는 문서(필수 머지 필드 빈칸, 받는 사람 문제, 서식 중지·보관, 금액·연도 이상).
 *  - warn : 보내되 확인이 필요한 점(긴 이름이 칸을 넘을 수 있음, 모르는 머지 필드, 묶음 안에서 크게 다른 값).
 *
 * 필수 목록은 **그 서식이 실제로 쓰는 필드만** 본다. 서식에 {{금액}} 이 없으면 금액이 비어도 막지 않는다
 * (기존에 정상 발송되던 서식이 이 점검 때문에 막히지 않게 — 2026-11-09 과제 C2).
 */

export type PreflightLevel = 'ok' | 'warn' | 'block';

export type PreflightCode =
  | 'REQUIRED_FIELD_EMPTY'
  | 'RECIPIENT_NO_CONTACT'
  | 'RECIPIENT_WITHDRAWN'
  | 'RECIPIENT_BLOCKED'
  | 'TEMPLATE_INACTIVE'
  | 'TEMPLATE_ARCHIVED'
  | 'AMOUNT_INVALID'
  | 'YEAR_IN_FUTURE'
  | 'TEXT_OVERFLOW'
  | 'UNKNOWN_FIELD'
  | 'OUTLIER_VALUE'
  | 'TABLE_OVERFLOW';

export interface PreflightIssue {
  code: PreflightCode;
  message: string;
  field?: string;
  severity: 'block' | 'warn';
}

export interface PreflightResult {
  level: PreflightLevel;
  issues: PreflightIssue[];
}

/**
 * 용도별 필수 머지 필드. 서식이 그 필드를 쓰는데 값이 비면 막는다(쓰지 않으면 보지 않는다).
 * 감사장은 후원자명·기관명, 약정서는 금액·출금일, 활동 확인서는 활동 시간이 빠지면 문서 의미가 없다.
 */
export const PURPOSE_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  SUPPORT_AGREEMENT: ['후원자명', '기관명', '금액'],
  VOLUNTEER_APPLICATION: ['후원자명', '기관명'],
  THANKS_LETTER: ['후원자명', '기관명'],
  RECURRING_THANKS: ['후원자명', '기관명'],
  YEAR_END_THANKS: ['후원자명', '기관명', '귀속연도'],
  VOLUNTEER_CONFIRMATION: ['후원자명', '기관명', '활동시간'],
  VOLUNTEER_THANKS: ['후원자명', '기관명'],
  RECURRING_CHANGE: ['후원자명', '기관명'],
};

/**
 * 용도별 권장 머지 필드 — 비면 막지 않고 경고만 한다.
 * 약정서 출금일은 정기 약정 흐름(agreements.ts)에서는 항상 채워지지만, 기존 직접 발송 경로·테스트가 출금일 없이 보내던 것을
 * 막지 않기 위해 경고로 둔다(2026-11-09 결정 — 보고서 '결정 필요').
 */
export const PURPOSE_RECOMMENDED_FIELDS: Record<string, readonly string[]> = {
  SUPPORT_AGREEMENT: ['출금일'],
};

/** 본문 서식의 한 줄 기준 글자 수(이보다 긴 값은 줄이 넘어갈 수 있다). 파일 서식은 실제 폭으로 잰다. */
export const BODY_FIELD_CHAR_LIMIT: Record<string, number> = {
  후원자명: 20,
  캠페인: 30,
  활동명: 30,
  배정: 40,
  기관명: 30,
};
export const BODY_FIELD_CHAR_DEFAULT = 40;

/** 묶음 안에서 중앙값의 이 배수를 넘으면 경고 */
export const OUTLIER_FACTOR = 10;

const AMOUNT_FIELDS = ['금액', '누적금액'] as const;

/** "30,000원" → 30000n. 숫자가 아니면 null. */
export function parseWon(v: string | null | undefined): bigint | null {
  if (v == null) return null;
  const s = String(v).replace(/[,\s원]/g, '');
  if (!/^-?\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

export interface TemplateLike {
  purpose?: string | null;
  body?: string | null;
  /** 파일 서식 새 글자들(편집 기록의 text) */
  pdfTexts?: string[];
  active?: boolean;
  archivedAt?: Date | null;
}

export interface RecipientLike {
  /** 받을 연락처가 있는가(전화 암호문이 있고 풀린다) */
  hasContact: boolean;
  withdrawn?: boolean;
  /** 기관 차단·후원자 차단 */
  blocked?: boolean;
}

/** 파일 서식 글자 상자 측정 결과(서버가 실제 글꼴 폭으로 잰다) */
export interface MeasuredBox {
  field?: string;
  /** 머지한 뒤의 글자 */
  text: string;
  /** 그 글자의 폭(pt) */
  widthPt: number;
  /** 들어갈 칸 폭(pt) — 원래 글자 폭(편집 기록 width) */
  boxPt: number;
}

export interface PreflightInput {
  template: TemplateLike;
  values: Record<string, string | null | undefined>;
  recipient?: RecipientLike | null;
  /** 같은 묶음의 다른 문서 값(금액·연도 비교용). 3건 이상일 때만 비교한다. */
  batch?: { amounts?: bigint[] };
  /** 파일 서식 측정 결과 */
  measured?: MeasuredBox[];
  /** 기준 시각(미래 연도 판정) */
  now?: Date;
}

function kstYear(d: Date): number {
  return new Date(d.getTime() + 9 * 3_600_000).getUTCFullYear();
}

function median(list: bigint[]): bigint {
  const s = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2n;
}

/** 서식에 쓰인 머지 필드(본문 + 파일 서식 새 글자) */
export function templateMergeKeys(t: TemplateLike): string[] {
  const out: string[] = [];
  for (const k of [...mergeKeysIn(t.body), ...(t.pdfTexts ?? []).flatMap((x) => mergeKeysIn(x))]) if (!out.includes(k)) out.push(k);
  return out;
}

export function runPreflight(input: PreflightInput): PreflightResult {
  const issues: PreflightIssue[] = [];
  const block = (code: PreflightCode, message: string, field?: string) => issues.push({ code, message, field, severity: 'block' });
  const warn = (code: PreflightCode, message: string, field?: string) => issues.push({ code, message, field, severity: 'warn' });
  const t = input.template;
  const used = templateMergeKeys(t);
  const known = new Set(MERGE_FIELD_KEYS);
  const val = (k: string) => {
    const v = input.values[k];
    return v == null ? '' : String(v).trim();
  };

  // ── 서식 상태
  if (t.archivedAt) block('TEMPLATE_ARCHIVED', '보관한 서식입니다. 되살린 뒤 보내 주세요.');
  else if (t.active === false) block('TEMPLATE_INACTIVE', '사용을 중지한 서식입니다.');

  // ── 받는 사람
  const r = input.recipient;
  if (r) {
    if (r.withdrawn) block('RECIPIENT_WITHDRAWN', '탈퇴한 후원자입니다.');
    else if (r.blocked) block('RECIPIENT_BLOCKED', '기관과 차단 관계인 후원자입니다.');
    else if (!r.hasContact) block('RECIPIENT_NO_CONTACT', '받을 연락처가 없습니다.');
  }

  // ── 필수 머지 필드(서식이 쓰는 것만)
  const required = (t.purpose && PURPOSE_REQUIRED_FIELDS[t.purpose]) || [];
  for (const k of required) {
    if (used.includes(k) && !val(k)) block('REQUIRED_FIELD_EMPTY', `필수 항목 「${k}」 값이 비어 있습니다.`, k);
  }
  for (const k of (t.purpose && PURPOSE_RECOMMENDED_FIELDS[t.purpose]) || []) {
    if (used.includes(k) && !val(k)) warn('REQUIRED_FIELD_EMPTY', `「${k}」 값이 비어 빈칸으로 나갑니다.`, k);
  }

  // ── 금액
  for (const k of AMOUNT_FIELDS) {
    if (!used.includes(k)) continue;
    const raw = val(k);
    if (!raw) continue;
    const n = parseWon(raw);
    if (n === null) block('AMOUNT_INVALID', `「${k}」 값이 숫자가 아닙니다.`, k);
    // 금액(이번 후원)은 0 이하이면 막는다. 누적금액 0원은 첫 감사장 등에서 자연스러울 수 있어 막지 않는다.
    else if (k === '금액' && n <= 0n) block('AMOUNT_INVALID', '「금액」 이 0원 이하입니다.', k);
    else if (n < 0n) block('AMOUNT_INVALID', `「${k}」 이 0원보다 작습니다.`, k);
  }

  // ── 연도
  if (used.includes('귀속연도') && val('귀속연도')) {
    const y = Number(val('귀속연도'));
    const nowY = kstYear(input.now ?? new Date());
    if (!Number.isInteger(y) || y < 2000) block('AMOUNT_INVALID', '「귀속연도」 값이 올바르지 않습니다.', '귀속연도');
    else if (y > nowY) block('YEAR_IN_FUTURE', `「귀속연도」 ${y}년이 아직 오지 않은 해입니다.`, '귀속연도');
  }

  // ── 모르는 필드
  const unknown = used.filter((k) => !known.has(k));
  if (unknown.length) warn('UNKNOWN_FIELD', `지원하지 않는 머지 필드가 그대로 보입니다: ${unknown.map((k) => `{{${k}}}`).join(', ')}`);

  // ── 긴 값(파일 서식은 실제 폭, 본문 서식은 기준 글자 수)
  if (input.measured?.length) {
    for (const m of input.measured) {
      if (m.boxPt > 0 && m.widthPt > m.boxPt * 1.02) {
        warn('TEXT_OVERFLOW', `「${m.field ?? m.text.slice(0, 12)}」 글자가 서식 칸보다 깁니다(약 ${Math.round((m.widthPt / m.boxPt) * 100)}%).`, m.field);
      }
    }
  } else {
    for (const k of used) {
      if (!known.has(k)) continue;
      const v = val(k);
      const limit = BODY_FIELD_CHAR_LIMIT[k] ?? BODY_FIELD_CHAR_DEFAULT;
      if (v && Array.from(v).length > limit) warn('TEXT_OVERFLOW', `「${k}」 값이 ${Array.from(v).length}자로 깁니다(기준 ${limit}자). 줄이 넘어갈 수 있습니다.`, k);
    }
  }

  // ── 묶음 안 이상값
  const amounts = input.batch?.amounts?.filter((a) => a > 0n) ?? [];
  if (amounts.length >= 3 && used.includes('금액')) {
    const mine = parseWon(val('금액'));
    const med = median(amounts);
    if (mine != null && med > 0n && (mine > med * BigInt(OUTLIER_FACTOR) || mine * BigInt(OUTLIER_FACTOR) < med)) {
      warn('OUTLIER_VALUE', `「금액」 이 같은 묶음의 중앙값(${med.toLocaleString('ko-KR')}원)과 크게 다릅니다.`, '금액');
    }
  }

  const level: PreflightLevel = issues.some((i) => i.severity === 'block') ? 'block' : issues.length ? 'warn' : 'ok';
  return { level, issues };
}

/** 가상의 표본 값 — 서식 등록·수정 화면 "점검" 버튼(아주 긴 이름·큰 금액으로 칸 넘침을 미리 본다). */
export function stressSampleValues(issuedAt = new Date()): Record<string, string> {
  const ymd = new Date(issuedAt.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  return {
    후원자명: '가나다라마바사아자차카타파하 사회복지법인 나눔과 동행 후원회',
    금액: '1,000,000원',
    누적금액: '12,000,000원',
    횟수: '120회',
    날짜: ymd,
    캠페인: '2026 따뜻한 겨울나기 이웃사랑 연탄 나눔 특별 모금 캠페인',
    기관명: '사회복지법인 가나다라마바사 복지재단 부설 해오름 종합사회복지관',
    대표자: '남궁가나다라',
    발급일: ymd,
    출금일: '25',
    활동명: '어르신 말벗·도시락 배달·주거 환경 개선 봉사',
    활동일: ymd,
    활동시간: '12.5시간',
    누적시간: '1,240시간',
    귀속연도: String(new Date(issuedAt.getTime() + 9 * 3_600_000).getUTCFullYear() - 1),
    영수증번호: 'GIV-8K2M-2026-000123',
    배정: '매주 토요일 오전 9시~12시 · 무료 급식소 배식 지원 및 설거지',
  };
}

export const PREFLIGHT_LEVEL_LABEL: Record<PreflightLevel, { text: string; tone: 'success' | 'warning' | 'danger' }> = {
  ok: { text: '점검 통과', tone: 'success' },
  warn: { text: '확인 필요', tone: 'warning' },
  block: { text: '보내지 않음', tone: 'danger' },
};

// ---------------------------------------------------------------------------
// 표본 고르기 (대량 발송·일괄 발급 전 미리보기)
// ---------------------------------------------------------------------------

export type SampleKind = 'normal' | 'blank' | 'longest';

export const SAMPLE_KIND_LABEL: Record<SampleKind, string> = {
  normal: '정상 표본',
  blank: '빈칸이 있는 표본',
  longest: '이름이 가장 긴 표본',
};

export interface SampleCandidate {
  key: string;
  /** 화면에 보일 이름(마스킹 값·표시 이름) */
  label: string;
  values: Record<string, string | null | undefined>;
}

/**
 * 표본 3건: 정상 1(쓰는 필드가 모두 채워진 첫 건) · 빈칸이 있는 1 · 이름이 가장 긴 1. 같은 건이 겹치면 한 번만, 없으면 있는 것만.
 * @param usedKeys 서식이 쓰는 머지 필드(비었는지 볼 대상)
 * @param nameKey 길이를 잴 필드(기본 후원자명)
 */
export function pickSamples<T extends SampleCandidate>(cands: T[], usedKeys: string[], nameKey = '후원자명'): Array<{ kind: SampleKind; cand: T }> {
  const empty = (c: T) => usedKeys.filter((k) => {
    const v = c.values[k];
    return v == null || String(v).trim() === '';
  });
  const out: Array<{ kind: SampleKind; cand: T }> = [];
  const taken = new Set<string>();
  const add = (kind: SampleKind, c: T | undefined) => {
    if (!c || taken.has(c.key)) return;
    taken.add(c.key);
    out.push({ kind, cand: c });
  };
  add('normal', cands.find((c) => empty(c).length === 0));
  add('blank', cands.find((c) => empty(c).length > 0));
  let longest: T | undefined;
  let len = -1;
  for (const c of cands) {
    const n = Array.from(String(c.values[nameKey] ?? '')).length;
    if (n > len) {
      len = n;
      longest = c;
    }
  }
  add('longest', longest);
  return out;
}
