import { z } from 'zod';

/**
 * 원본 서식 편집 레이어 (PDF 위에 덧입히는 수정 기록).
 *
 * ── 왜 원본을 직접 고치지 않는가 ─────────────────────────────────────────
 * PDF 안의 글자는 글꼴 부분집합(subset)과 위치 연산으로 그려져 있어, 본문을 문자열처럼
 * 고쳐 쓸 수 없다. 그래서 원본 PDF 는 그대로 보관하고, "이 자리의 글자를 이렇게 바꾼다"
 * 는 수정 기록만 따로 둔다. 서버가 원본 위에 덮개(바탕색 사각형)와 새 글자를 그려
 * 결과 PDF 를 만든다(`server/services/pdf-form/render.ts`). 원본이 남아 있으므로
 * 언제든 수정 전으로 되돌릴 수 있고, 같은 기록으로 몇 번을 만들어도 결과가 같다.
 *
 * ── 글꼴을 맞추는 순서 ──────────────────────────────────────────────────
 *  1. 원본 글꼴(ORIGINAL)   — 원래 글자를 그린 그 글꼴 객체를 그대로 다시 쓴다.
 *                            새 글자가 모두 원본 글꼴에 들어 있을 때만 가능하다.
 *  2. 올린 글꼴(UPLOADED)    — 기관이 같은 이름의 글꼴 파일을 올려 두었으면 그것을 쓴다.
 *  3. 원본 글꼴 파일(EMBEDDED) — 원본 PDF 에 글꼴 전체가 들어 있으면 그 파일을 다시 넣는다.
 *  4. 대체 글꼴(FALLBACK)    — 위가 모두 안 되면 같은 계열(명조/고딕)·굵기의 한글 글꼴.
 * 글자 크기·색·기울기(글자 방향)는 어느 경우든 원본에서 읽은 값을 그대로 쓴다.
 *
 * 이 파일은 브라우저(편집기)와 서버가 함께 쓴다. 서버 전용 모듈을 가져오지 않는다.
 */

export const PDF_LAYOUT_VERSION = 1;

/** 한 서식의 수정 기록 상한. 화면에서 다룰 수 있는 수. */
export const MAX_PDF_EDITS = 300;
/** 원본 PDF 쪽수 상한. */
export const MAX_PDF_PAGES = 30;
/** 수정 글자 1건 길이 상한. */
export const MAX_EDIT_TEXT = 500;
/** 기관이 올릴 수 있는 글꼴 파일 개수 상한. */
export const MAX_FONT_ASSETS = 8;

const num = z.number().finite();
const rgb = z.tuple([num.min(0).max(1), num.min(0).max(1), num.min(0).max(1)]);

/**
 * 글자 1줄의 위치·방향. PDF 사용자 좌표계(왼쪽 아래 원점, pt) 기준.
 * matrix 는 pdf.js 텍스트 항목의 transform 과 같다: [a, b, c, d, e, f]
 * — (a, b) 는 글자 진행 방향 × 크기, (c, d) 는 위쪽 방향 × 크기, (e, f) 는 기준선 시작점.
 */
export const pdfMatrixSchema = z.tuple([num, num, num, num, num, num]);
export type PdfMatrix = z.infer<typeof pdfMatrixSchema>;

export const pdfFontRefSchema = z.object({
  /** PDF 의 BaseFont 이름 (부분집합 접두사 포함, 예: ABCDEF+HCRBatang). 새로 쓰는 글이면 주변 글자의 것. */
  baseFont: z.string().max(200),
  /** 대체 글꼴을 고를 때 쓰는 계열. 원본 이름에서 판정한다. */
  serif: z.boolean(),
  bold: z.boolean(),
});
export type PdfFontRef = z.infer<typeof pdfFontRefSchema>;

export const pdfEditSchema = z.object({
  id: z.string().min(1).max(40),
  page: z.number().int().min(1).max(MAX_PDF_PAGES),
  /**
   * replace : 원래 글자를 덮고 그 자리에 새 글자를 쓴다.
   * erase   : 원래 글자(또는 영역)를 덮기만 한다.
   * add     : 빈자리에 새 글자를 쓴다(덮개 없음).
   */
  kind: z.enum(['replace', 'erase', 'add']),
  /** 기준선 위치·방향·크기. 크기는 hypot(a, b) 다. */
  matrix: pdfMatrixSchema,
  /** 덮을 영역의 폭(글자 진행 방향, pt). replace·erase 에서 원래 글자 폭. */
  width: num.min(0).max(5000),
  text: z.string().max(MAX_EDIT_TEXT),
  font: pdfFontRefSchema,
  /** 글자색 0~1 */
  color: rgb,
  /** 덮개(바탕) 색 0~1. 원본 화면에서 글자 주변 바탕을 읽은 값. */
  cover: rgb,
  /** 원래 글자 (되돌리기·화면 표시용). 결과 PDF 에는 쓰지 않는다. */
  original: z.string().max(MAX_EDIT_TEXT).optional(),
});
export type PdfEdit = z.infer<typeof pdfEditSchema>;

export const pdfFontAssetSchema = z.object({
  /** 이 글꼴로 대신할 PDF 글꼴 이름(부분집합 접두사 없이). 예: HCRBatang */
  match: z.string().min(1).max(120),
  url: z.string().max(300),
  name: z.string().max(120),
});
export type PdfFontAsset = z.infer<typeof pdfFontAssetSchema>;

export const pdfLayoutSchema = z.object({
  v: z.literal(PDF_LAYOUT_VERSION),
  edits: z.array(pdfEditSchema).max(MAX_PDF_EDITS),
  fonts: z.array(pdfFontAssetSchema).max(MAX_FONT_ASSETS).default([]),
});
export type PdfLayout = z.infer<typeof pdfLayoutSchema>;

export function emptyPdfLayout(): PdfLayout {
  return { v: PDF_LAYOUT_VERSION, edits: [], fonts: [] };
}

/** DB·요청 JSON 을 읽는다. 모양이 깨졌으면 null. */
export function parsePdfLayout(raw: unknown): PdfLayout | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = pdfLayoutSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** 결과 PDF 에 쓰인 글꼴 종류. */
export type PdfFontTier = 'ORIGINAL' | 'UPLOADED' | 'EMBEDDED' | 'STANDARD' | 'FALLBACK';

export const pdfFontTierLabel: Record<PdfFontTier, { text: string; hint: string }> = {
  ORIGINAL: { text: '원본 글꼴', hint: '원래 글자를 그린 글꼴을 그대로 썼습니다.' },
  UPLOADED: { text: '올린 글꼴', hint: '기관이 올린 같은 이름의 글꼴 파일을 썼습니다.' },
  EMBEDDED: { text: '원본 글꼴', hint: '원본 파일에 들어 있던 글꼴 전체를 다시 넣었습니다.' },
  STANDARD: { text: '원본 글꼴', hint: 'PDF 표준 글꼴(같은 이름)을 썼습니다.' },
  FALLBACK: {
    text: '대체 글꼴',
    hint: '원본 글꼴에 없는 글자가 있어 같은 계열·굵기의 한글 글꼴로 썼습니다. 크기·색은 원본과 같습니다.',
  },
};

/** 부분집합 접두사(ABCDEF+)를 뗀 글꼴 이름. */
export function stripSubsetTag(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '');
}

/**
 * 글꼴 이름으로 계열과 굵기를 판정한다(대체 글꼴 선택·화면 표시용).
 * 한국 서식에 흔한 이름을 함께 본다: 바탕·명조·함초롬바탕(HCR Batang)·휴먼명조 → 명조 계열.
 */
export function classifyFontName(name: string): { serif: boolean; bold: boolean } {
  const n = stripSubsetTag(name);
  const serif =
    /(batang|myeong|myung|mincho|serif|times|roman|song|ming|garamond|georgia|termes|명조|바탕|궁서|gungsuh|jo$|hymjre|hysmyeongjo)/i.test(
      n,
    ) && !/sans/i.test(n);
  const bold = /(bold|black|heavy|extrabold|semibold|demibold|headline|헤드라인|견고딕|굵은|[-_ ]b$|[-_]eb$|,bold)/i.test(n);
  return { serif, bold };
}

/** 사람이 읽는 글꼴 이름(접두사·숫자 꼬리 제거). */
export function displayFontName(name: string): string {
  return stripSubsetTag(name).replace(/-\d+$/, '').replace(/[,_]/g, ' ').trim() || '이름 없는 글꼴';
}

/** 행렬에서 글자 크기(pt). */
export function matrixFontSize(m: PdfMatrix): number {
  return Math.hypot(m[0], m[1]);
}

/** 서버가 편집기에 돌려주는 글꼴별 정보. */
export interface PdfFontInfo {
  baseFont: string;
  display: string;
  serif: boolean;
  bold: boolean;
  /** 원본 글꼴로 바로 쓸 수 있는 글자. null 이면 제한 없음(비내장 유니코드 글꼴). */
  chars: string | null;
  /** 원본 파일에 글꼴 전체가 들어 있어 다시 넣을 수 있는지 */
  reusableProgram: boolean;
  /** 기관이 올린 글꼴로 대신하는지 */
  uploaded: boolean;
}

/**
 * 새 글자가 어떤 글꼴로 그려질지 미리 판정한다(편집기의 실시간 안내용).
 * 서버 렌더러도 같은 순서로 고른다. 공백은 어느 글꼴에서나 통과시킨다
 * (공백은 덮개만 있으면 되고 글리프가 없어도 보이는 결과가 같다).
 */
export function predictFontTier(
  text: string,
  info: PdfFontInfo | undefined,
): { tier: PdfFontTier; missing: string[] } {
  if (!info) return { tier: 'FALLBACK', missing: [] };
  if (info.uploaded) return { tier: 'UPLOADED', missing: [] };
  const missing = info.chars === null ? [] : missingChars(text, info.chars);
  if (missing.length === 0) return { tier: 'ORIGINAL', missing };
  if (info.reusableProgram) return { tier: 'EMBEDDED', missing };
  return { tier: 'FALLBACK', missing };
}

export function missingChars(text: string, available: string): string[] {
  const have = new Set(Array.from(available));
  const out: string[] = [];
  for (const ch of Array.from(text)) {
    if (/\s/.test(ch)) continue;
    if (!have.has(ch) && !out.includes(ch)) out.push(ch);
  }
  return out;
}
