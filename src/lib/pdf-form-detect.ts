import { MAX_PDF_EDITS, type PdfEdit, type PdfLayout, type PdfMatrix } from '@/lib/pdf-form';
import type { PdfTextRun } from '@/lib/pdf-form-runs';

/**
 * 서식 자동 인식 — 라벨을 찾아 머지 필드 자리를 **제안**한다(2026-11-12 4차 J1).
 *
 *  - 입력은 글자 묶음(`pdf-form-runs.ts` groupTextRuns 결과, 스캔본은 OCR 줄을 같은 모양으로 바꾼 것)과 가로선.
 *  - 결과는 후보 목록뿐이다. 편집 기록(pdfLayout)은 담당자가 수락할 때 `acceptCandidates` 로만 바뀐다(자동 확정 없음).
 *  - 주소·생년월일·주민등록번호 같은 민감 항목은 제안하지 않는다(skipped 에 이유와 함께).
 *  - 값 자리 추정(좌표 규칙)
 *      ① 라벨 오른쪽 같은 줄에 이미 적힌 예시 값(숫자·이름·번호) → 그 글자를 바꾼다(낮음)
 *      ② 라벨 오른쪽 빈칸(다음 글자 또는 쪽 오른쪽 여백까지 3글자 이상) → 그 자리에 넣는다(넓으면 높음)
 *      ③ 라벨 아래 밑줄(가로선 또는 ____) → 선 위에 넣는다(높음)
 *    "라벨: 값" 이 한 묶음이면 콜론 뒤 글자 자리를 글자 수 비율로 잡는다(낮음).
 *
 * 브라우저 편집기·서버(OCR)·테스트가 함께 쓰는 순수 함수다.
 */

export type DetectField = '후원자명' | '금액' | '출금일' | '연락처' | '발급일' | '서명';

export interface FieldRule {
  field: DetectField;
  /** 넣을 글자 */
  text: string;
  label: string;
  patterns: RegExp[];
}

/** 라벨 규칙. 라벨 전체(앞뒤 기호·콜론 뗀 것)가 맞아야 한다 — 문장 속 낱말은 라벨이 아니다. */
export const FIELD_RULES: FieldRule[] = [
  { field: '후원자명', text: '{{후원자명}}', label: '후원자 이름', patterns: [/^(성명|후원자명|후원자성명|후원자|신청인|신청인성명|신청자|신청자성명|약정인|약정자|봉사자성명|이름|성함|성명\(.*\))$/] },
  { field: '금액', text: '{{금액}}', label: '후원 금액', patterns: [/^(금액|약정금액|후원금액|월후원금액|월약정금액|후원금|약정금|후원금액\(.*\)|금액\(.*\))$/] },
  { field: '출금일', text: '{{출금일}}', label: '출금일', patterns: [/^(출금일|이체일|출금희망일|이체희망일|매월출금일|출금일자|이체일자)$/] },
  { field: '연락처', text: '{{연락처}}', label: '연락처(가린 값)', patterns: [/^(연락처|휴대폰|휴대전화|핸드폰|전화번호|휴대폰번호|휴대전화번호|연락처\(.*\))$/] },
  { field: '발급일', text: '{{발급일}}', label: '작성일(발급일)', patterns: [/^(날짜|작성일|작성일자|신청일|신청일자|약정일|일자)$/, /^(20\d{0,2})?년월일$/] },
  // 서명 자리: 서명 이미지를 PDF 에 찍는 기능은 없다 — 서명자 이름을 그 자리에 둔다(서명 기록은 전자문서 감사기록).
  { field: '서명', text: '{{후원자명}}', label: '서명 자리(서명자 이름)', patterns: [/^(서명|서명란|\(인\)|\(서명\)|\(서명또는인\)|서명\(인\)|\(인또는서명\)|인)$/] },
];

/** 제안하지 않는 민감 항목 */
export const SENSITIVE_LABELS = /^(주소|자택주소|주민등록번호|주민번호|생년월일|생일|계좌번호|카드번호|외국인등록번호)/;

export type DetectConfidence = 'high' | 'low';

export interface FieldCandidate {
  id: string;
  page: number;
  field: DetectField;
  fieldLabel: string;
  /** 찾은 라벨 글자 */
  labelText: string;
  /** 넣을 글자(머지 필드) */
  text: string;
  /** add: 빈자리에 넣기, replace: 적혀 있던 예시 값을 덮고 넣기 */
  kind: 'add' | 'replace';
  matrix: PdfMatrix;
  /** replace 의 덮개 폭(pt). add 는 0 */
  width: number;
  /** 덮을 원래 글자(replace) */
  original: string;
  font: { baseFont: string; serif: boolean; bold: boolean };
  confidence: DetectConfidence;
  /** 자리를 정한 근거(화면 표시) */
  reason: string;
  source: 'text' | 'ocr';
}

export interface DetectSkipped {
  page: number;
  labelText: string;
  reason: string;
}

export interface DetectResult {
  candidates: FieldCandidate[];
  skipped: DetectSkipped[];
}

/** 가로선(PDF 좌표). y 는 선의 높이. */
export interface HLine {
  page: number;
  x0: number;
  x1: number;
  y: number;
}

export interface DetectPage {
  page: number;
  width: number;
  height: number;
  runs: PdfTextRun[];
  lines?: HLine[];
  /** OCR 로 읽은 쪽이면 run id → 신뢰도(0~1) */
  ocrConfidence?: Record<string, number>;
}

const COLON = /[:：]/;
/** 라벨 비교용 정규화: 공백·앞 기호·뒤 콜론 제거 */
export function normalizeLabel(s: string): string {
  return s
    .replace(/^[\s·•\-–□■○●◇◆※*▶▷>\d.)]+/, '')
    .replace(/[\s:：]+$/, '')
    .replace(/\s+/g, '');
}

export function matchRule(labelText: string): FieldRule | null {
  const n = normalizeLabel(labelText);
  if (!n || n.length > 16) return null;
  for (const r of FIELD_RULES) if (r.patterns.some((p) => p.test(n))) return r;
  return null;
}

function isSensitive(labelText: string): boolean {
  return SENSITIVE_LABELS.test(normalizeLabel(labelText));
}

/** 글자 폭 비율 추정(한글·한자 1, 그 밖 0.55, 공백 0.3). 한 묶음 안 일부 자리를 잡을 때 쓴다. */
function units(s: string): number {
  let u = 0;
  for (const ch of Array.from(s)) u += /\s/.test(ch) ? 0.3 : /[ᄀ-ᇿ㄰-㆏가-힣一-鿿]/.test(ch) ? 1 : 0.55;
  return u;
}

function dir(run: PdfTextRun): [number, number] {
  const s = run.size || 1;
  return [run.matrix[0] / s, run.matrix[1] / s];
}

/** 가로 글자만 다룬다(세로·기운 글자는 자리 추정이 어긋나기 쉬워 제안하지 않는다). */
function horizontal(run: PdfTextRun): boolean {
  const [dx, dy] = dir(run);
  return Math.abs(dy) < 0.02 && dx > 0;
}

const startX = (r: PdfTextRun) => r.matrix[4];
const endX = (r: PdfTextRun) => r.matrix[4] + r.width;
const baseY = (r: PdfTextRun) => r.matrix[5];

function at(run: PdfTextRun, x: number, y: number, size = run.size): PdfMatrix {
  return [size, 0, 0, size, x, y];
}

/** 예시 값처럼 보이는 글자(바꿀 대상) */
function looksLikeValue(field: DetectField, text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (field === '금액') return /^[\d,]+$/.test(t) && /\d/.test(t);
  if (field === '출금일') return /^\d{1,2}$/.test(t);
  if (field === '연락처') return /^0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}$/.test(t);
  if (field === '후원자명') return /^[가-힣]{2,5}$/.test(t);
  if (field === '발급일') return /^\d{4}[-.년\s]+\d{1,2}[-.월\s]+\d{1,2}일?$/.test(t);
  return false;
}

/** 예시 값 앞에 흔히 붙는 말(건너뛰고 본다) */
const VALUE_PREFIX = /^(월|매월|매달|금|일금|₩|\/|:|：|-)$/;

/** 한 묶음 안 "라벨: 값" 쌍(구분: " / ", " | ", 두 칸 이상 공백, "·"). 라벨 규칙이나 민감 항목에 걸리는 것만. */
export interface InlinePair {
  label: string;
  /** 값 시작·끝(묶음 글자 기준 위치) */
  vStart: number;
  vEnd: number;
  value: string;
  last: boolean;
}

export function inlinePairs(text: string): InlinePair[] {
  const chunks: Array<{ start: number; end: number }> = [];
  const sep = /\s[/|]\s|\s{2,}|\s·\s/g;
  let pos = 0;
  for (const m of text.matchAll(sep)) {
    chunks.push({ start: pos, end: m.index! });
    pos = m.index! + m[0].length;
  }
  chunks.push({ start: pos, end: text.length });
  const out: InlinePair[] = [];
  chunks.forEach((c, i) => {
    const chunk = text.slice(c.start, c.end);
    const ci = chunk.search(COLON);
    if (ci < 0) return;
    const label = chunk.slice(0, ci);
    if (!matchRule(label) && !isSensitive(label)) return;
    const raw = chunk.slice(ci + 1);
    const lead = raw.length - raw.trimStart().length;
    const value = raw.trim();
    const vStart = c.start + ci + 1 + lead;
    out.push({ label: label.trim(), vStart, vEnd: vStart + value.length, value, last: i === chunks.length - 1 });
  });
  return out;
}

/** 값 칸에서 바꿀 핵심 글자(예시 값) 위치. 못 찾으면 값 전체. */
function valueCore(field: DetectField, value: string): { start: number; end: number } {
  const re =
    field === '금액' ? /\d[\d,]*(\s*원)?/ :
    field === '출금일' ? /\d{1,2}/ :
    field === '연락처' ? /0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/ :
    field === '후원자명' ? /[가-힣]{2,5}/ :
    field === '발급일' ? /\d{4}[-.년\s]+\d{1,2}[-.월\s]+\d{1,2}일?/ : null;
  const m = re ? value.match(re) : null;
  if (m && m.index !== undefined) return { start: m.index, end: m.index + m[0].length };
  return { start: 0, end: value.length };
}

/**
 * pdf.js 텍스트 항목 중 넓은 빈칸(글자 크기의 factor 배 넘는 공백 항목)을 뺀다.
 * pdf.js 는 같은 줄의 떨어진 글자 사이에 넓은 공백 항목을 넣는데, 그대로 묶으면 "서명 ______ (인)" 이 한 묶음이 되어
 * 빈칸 자리를 알 수 없다. 자동 인식용 묶음(groupTextRuns)을 만들기 전에만 쓴다(편집기 글자 묶음은 그대로).
 */
export function dropWideSpaces<T extends { str: string; transform: number[]; width: number }>(items: T[], factor = 2.5): T[] {
  return items.filter((it) => {
    if (!it || typeof it.str !== 'string' || it.str.trim()) return true;
    const size = Array.isArray(it.transform) ? Math.hypot(it.transform[0] ?? 0, it.transform[1] ?? 0) : 0;
    return !(size > 0 && it.width > size * factor);
  });
}

export function detectFieldCandidates(pages: DetectPage[], opts: { source?: 'text' | 'ocr'; existing?: PdfLayout | null } = {}): DetectResult {
  const source = opts.source ?? 'text';
  const candidates: FieldCandidate[] = [];
  const skipped: DetectSkipped[] = [];
  const taken = (opts.existing?.edits ?? []).map((e) => ({ page: e.page, x: e.matrix[4], y: e.matrix[5] }));
  const SENSITIVE_REASON = '민감 정보(주소·생년월일 등)라 자동으로 제안하지 않습니다.';

  for (const pg of pages) {
    const runs = pg.runs.filter(horizontal);
    // 묶음 분류: 라벨 하나 / "라벨: 값" 쌍들
    const labels = new Map<string, { rule: FieldRule; labelText: string }>();
    const pairRuns = new Map<string, InlinePair[]>();
    for (const r of runs) {
      const pairs = inlinePairs(r.text);
      if (pairs.length) {
        pairRuns.set(r.id, pairs);
        continue;
      }
      if (isSensitive(r.text)) {
        skipped.push({ page: pg.page, labelText: r.text.trim(), reason: SENSITIVE_REASON });
        continue;
      }
      const rule = matchRule(r.text);
      if (rule) labels.set(r.id, { rule, labelText: r.text.replace(/[\s:：]+$/, '').trim() });
    }
    const isLabelRun = (x: PdfTextRun) => labels.has(x.id) || pairRuns.has(x.id);

    const sameLine = (a: PdfTextRun, b: PdfTextRun) => Math.abs(baseY(a) - baseY(b)) < Math.max(1, a.size * 0.35);
    let n = 0;
    const push = (c: Omit<FieldCandidate, 'id' | 'source' | 'page'>) => {
      // 이미 고친 자리(같은 쪽·가까운 위치)에는 다시 제안하지 않는다.
      const near = taken.some((t) => t.page === pg.page && Math.abs(t.x - c.matrix[4]) < c.matrix[0] * 1.5 && Math.abs(t.y - c.matrix[5]) < c.matrix[0] * 0.8);
      if (near) return;
      n += 1;
      candidates.push({ ...c, id: `det-p${pg.page}-${n}`, page: pg.page, source });
    };
    const confOf = (r: PdfTextRun, c: DetectConfidence): DetectConfidence => (pg.ocrConfidence && (pg.ocrConfidence[r.id] ?? 0) < 0.8 ? 'low' : c);
    const baseOf = (r: PdfTextRun, rule: FieldRule, labelText: string) => ({
      field: rule.field, fieldLabel: rule.label, labelText, text: rule.text, font: { baseFont: r.baseFont, serif: r.serif, bold: r.bold },
    });

    /** 오른쪽 빈칸(②) → 아래 밑줄(③). 넣었으면 true */
    const blankOrUnderline = (r: PdfTextRun, rule: FieldRule, labelText: string, from0: number, colon: boolean): boolean => {
      const base = baseOf(r, rule, labelText);
      const right = runs.filter((x) => x !== r && sameLine(x, r) && startX(x) >= from0 - 0.5).sort((a, b) => startX(a) - startX(b));
      const colonRun = right[0] && /^[:：]$/.test(right[0].text.trim()) && startX(right[0]) - from0 < r.size ? right[0] : null;
      const from = colonRun ? endX(colonRun) : from0;
      const blocker = right.find((x) => x !== colonRun);
      const until = blocker ? startX(blocker) : pg.width - 36;
      const gap = until - from;
      const underRight = (pg.lines ?? []).some((l) => l.page === pg.page && l.y < baseY(r) && l.y > baseY(r) - r.size * 0.9 && l.x0 < from + r.size * 2 && l.x1 > from + r.size * 2);
      if (gap >= r.size * 3) {
        const x = from + r.size * (colonRun || colon ? 0.5 : 1);
        push({ ...base, kind: 'add', matrix: at(r, x, baseY(r)), width: 0, original: '', confidence: confOf(r, gap >= r.size * 5 || underRight ? 'high' : 'low'), reason: underRight ? '라벨 오른쪽 밑줄' : '라벨 오른쪽 빈칸' });
        return true;
      }
      const below = [
        ...(pg.lines ?? []).filter((l) => l.page === pg.page),
        ...runs.filter((x) => /^_{3,}$/.test(x.text.trim())).map((x) => ({ page: pg.page, x0: startX(x), x1: endX(x), y: baseY(x) })),
      ]
        .filter((l) => l.y < baseY(r) - r.size * 0.4 && l.y > baseY(r) - r.size * 3 && l.x1 > startX(r) && l.x0 < endX(r) + r.size * 2 && l.x1 - l.x0 >= r.size * 3)
        .sort((a, b) => b.y - a.y)[0];
      if (below) {
        push({ ...base, kind: 'add', matrix: at(r, below.x0 + r.size * 0.3, below.y + r.size * 0.25), width: 0, original: '', confidence: confOf(r, 'high'), reason: '라벨 아래 밑줄' });
        return true;
      }
      return false;
    };

    for (const r of runs) {
      // ── "라벨: 값" 쌍이 든 묶음
      const pairs = pairRuns.get(r.id);
      if (pairs) {
        const total = units(r.text) || 1;
        const xAt = (i: number) => startX(r) + (r.width * units(r.text.slice(0, i))) / total;
        for (const p of pairs) {
          if (isSensitive(p.label)) {
            skipped.push({ page: pg.page, labelText: p.label, reason: SENSITIVE_REASON });
            continue;
          }
          const rule = matchRule(p.label)!;
          if (!p.value) {
            if (p.last && blankOrUnderline(r, rule, p.label, endX(r), true)) continue;
            skipped.push({ page: pg.page, labelText: p.label, reason: '값을 넣을 빈자리를 찾지 못했습니다. [새 글 넣기] 로 직접 넣어 주세요.' });
            continue;
          }
          const core = valueCore(rule.field, p.value);
          const a = p.vStart + core.start;
          const b = p.vStart + core.end;
          push({
            ...baseOf(r, rule, p.label), kind: 'replace', matrix: at(r, xAt(a), baseY(r)), width: Math.max(r.size, xAt(b) - xAt(a)),
            original: r.text.slice(a, b), confidence: 'low', reason: '라벨 뒤에 적힌 예시 값 자리(글자 수로 추정)',
          });
        }
        continue;
      }

      const hit = labels.get(r.id);
      if (!hit) continue;
      const { rule } = hit;
      const base = baseOf(r, rule, hit.labelText);

      // ── "20  년  월  일" 처럼 빈 날짜 줄 → 그 줄을 발급일로 바꾼다
      if (rule.field === '발급일' && /년월일$/.test(normalizeLabel(hit.labelText))) {
        push({ ...base, kind: 'replace', matrix: at(r, startX(r), baseY(r)), width: r.width, original: r.text, confidence: 'low', reason: '빈 날짜 줄(년 월 일)' });
        continue;
      }

      // ── 서명 "(인)": 왼쪽 빈칸에 이름
      if (rule.field === '서명' && /^\(?인\)?$/.test(normalizeLabel(hit.labelText))) {
        const left = runs.filter((x) => x !== r && sameLine(x, r) && endX(x) <= startX(r) + 0.5).sort((a, b) => endX(b) - endX(a))[0];
        const gapStart = left ? endX(left) : startX(r) - r.size * 8;
        const gap = startX(r) - gapStart;
        if (gap >= r.size * 3) {
          const nameW = r.size * 3.5;
          const x = Math.max(gapStart + r.size * 0.5, startX(r) - nameW - r.size * 0.6);
          push({ ...base, kind: 'add', matrix: at(r, x, baseY(r)), width: 0, original: '', confidence: 'low', reason: '(인) 왼쪽 빈칸' });
        } else skipped.push({ page: pg.page, labelText: hit.labelText, reason: '(인) 앞에 빈자리가 없습니다.' });
        continue;
      }

      // ── ① 같은 줄 오른쪽(다음 라벨 전까지)에 적힌 예시 값을 바꾼다
      const right = runs.filter((x) => x !== r && sameLine(x, r) && startX(x) >= endX(r) - 0.5).sort((a, b) => startX(a) - startX(b));
      const nextLabelIdx = right.findIndex(isLabelRun);
      const segment = nextLabelIdx >= 0 ? right.slice(0, nextLabelIdx) : right;
      const meaningful = segment.filter((x) => !VALUE_PREFIX.test(x.text.trim()));
      const firstVal = meaningful[0];
      if (firstVal && looksLikeValue(rule.field, firstVal.text) && startX(firstVal) - endX(r) < r.size * 8) {
        let width = firstVal.width;
        let original = firstVal.text;
        // 금액 뒤 "원" 은 머지 값에 들어 있으므로 함께 덮는다.
        if (rule.field === '금액') {
          const unit = segment[segment.indexOf(firstVal) + 1];
          if (unit && unit.text.trim() === '원' && startX(unit) - endX(firstVal) < r.size * 0.8) {
            width = endX(unit) - startX(firstVal);
            original = `${firstVal.text} ${unit.text}`;
          }
        }
        push({ ...base, kind: 'replace', matrix: at(firstVal, startX(firstVal), baseY(firstVal), firstVal.size), width, original, confidence: 'low', reason: '라벨 오른쪽에 적힌 예시 값' });
        continue;
      }

      // ── ② 오른쪽 빈칸 · ③ 아래 밑줄
      if (blankOrUnderline(r, rule, hit.labelText, endX(r), false)) continue;
      skipped.push({ page: pg.page, labelText: hit.labelText, reason: '값을 넣을 빈자리를 찾지 못했습니다. [새 글 넣기] 로 직접 넣어 주세요.' });
    }
  }
  return { candidates, skipped };
}

/** 후보 → 편집 기록의 새 글자(머지 필드). 편집기 색 읽기 값이 있으면 그 색을 쓴다. */
export function candidateToEdit(c: FieldCandidate, colors?: { cover: [number, number, number]; color: [number, number, number] }): PdfEdit {
  return {
    id: `auto-${c.id}`,
    page: c.page,
    kind: c.kind,
    matrix: c.matrix,
    width: c.kind === 'replace' ? c.width : 0,
    text: c.text,
    font: c.font,
    color: colors?.color ?? [0, 0, 0],
    cover: colors?.cover ?? [1, 1, 1],
    original: c.kind === 'replace' ? c.original : '',
  };
}

/**
 * 담당자가 고른 후보만 편집 기록에 넣은 **새 기록**을 돌려준다(입력 기록은 바꾸지 않는다).
 * 이미 넣은 후보(같은 id)는 다시 넣지 않고, 수정 상한(MAX_PDF_EDITS)을 넘지 않는다.
 */
export function acceptCandidates(
  layout: PdfLayout,
  candidates: FieldCandidate[],
  ids: string[] | 'all',
  colorsOf?: (c: FieldCandidate) => { cover: [number, number, number]; color: [number, number, number] } | undefined,
): { layout: PdfLayout; added: number; skippedForLimit: number } {
  const pick = ids === 'all' ? candidates : candidates.filter((c) => ids.includes(c.id));
  const have = new Set(layout.edits.map((e) => e.id));
  const edits = [...layout.edits];
  let added = 0;
  let skippedForLimit = 0;
  for (const c of pick) {
    const e = candidateToEdit(c, colorsOf?.(c));
    if (have.has(e.id)) continue;
    if (edits.length >= MAX_PDF_EDITS) {
      skippedForLimit += 1;
      continue;
    }
    edits.push(e);
    have.add(e.id);
    added += 1;
  }
  return { layout: { ...layout, edits }, added, skippedForLimit };
}

// ---------------------------------------------------------------------------
// 입력 만들기 — pdf.js 연산 목록의 가로선 · OCR 줄
// ---------------------------------------------------------------------------

type M6 = [number, number, number, number, number, number];
const mul = (m: M6, n: M6): M6 => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: M6, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * pdf.js `getOperatorList()` 결과에서 가로선(얇은 선·얇은 사각형)을 뽑는다(PDF 사용자 좌표).
 * save/restore/transform 으로 좌표계를 따라가고, constructPath 의 경계 상자(minMax)를 쓴다.
 * 형식이 다르면(다른 pdf.js 판) 빈 목록 — 자동 인식은 빈칸·밑줄 글자만으로도 동작한다.
 */
export function extractHorizontalLines(
  page: number,
  ops: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> },
  OPS: { save: number; restore: number; transform: number; constructPath: number },
): HLine[] {
  const out: HLine[] = [];
  try {
    let ctm: M6 = [1, 0, 0, 1, 0, 0];
    const stack: M6[] = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] as unknown[] | null;
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform && Array.isArray(args) && args.length === 6) ctm = mul(ctm, args.map(Number) as M6);
      else if (fn === OPS.constructPath && Array.isArray(args)) {
        const mm = args[2] as ArrayLike<number> | null | undefined;
        if (!mm || mm.length < 4) continue;
        const pts = [apply(ctm, mm[0], mm[1]), apply(ctm, mm[2], mm[3]), apply(ctm, mm[0], mm[3]), apply(ctm, mm[2], mm[1])];
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        if (Number.isFinite(w) && w >= 10 && h <= 2) out.push({ page, x0: Math.min(...xs), x1: Math.max(...xs), y: (Math.max(...ys) + Math.min(...ys)) / 2 });
      }
    }
  } catch {
    return [];
  }
  return out;
}

/** OCR 줄(쪽 왼쪽 위 기준 비율 상자) → 글자 묶음 모양. 스캔본 자동 인식 입력. */
export function ocrLinesToPages(
  lines: Array<{ text: string; box: { page: number; x: number; y: number; w: number; h: number }; confidence: number }>,
  sizes: Array<{ w: number; h: number }>,
): DetectPage[] {
  const pages: DetectPage[] = sizes.map((s, i) => ({ page: i + 1, width: s.w, height: s.h, runs: [], ocrConfidence: {} }));
  lines.forEach((l, i) => {
    const pg = pages[l.box.page - 1];
    if (!pg || !l.text.trim()) return;
    const hPt = Math.max(1, l.box.h * pg.height);
    const size = Math.max(4, hPt * 0.8);
    const x = l.box.x * pg.width;
    const yBottom = pg.height - (l.box.y + l.box.h) * pg.height;
    const id = `ocr-p${pg.page}-${i + 1}`;
    pg.runs.push({
      id, page: pg.page, text: l.text.trim(), matrix: [size, 0, 0, size, x, yBottom + hPt * 0.2], width: l.box.w * pg.width,
      baseFont: '', size, serif: false, bold: false,
    });
    pg.ocrConfidence![id] = l.confidence;
  });
  return pages;
}
