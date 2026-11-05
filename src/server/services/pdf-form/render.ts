import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  PDFDocument, PDFName, PDFOperator, PDFOperatorNames, PDFRef, StandardFonts,
  beginText, closePath, endText, fill, lineTo, moveTo, popGraphicsState, pushGraphicsState,
  setFillingRgbColor, setFontAndSize, setTextMatrix, showText,
  type PDFFont, type PDFPage, type PDFHexString,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  stripSubsetTag, type PdfEdit, type PdfFontTier, type PdfLayout,
} from '@/lib/pdf-form';
import { codesToHex, encodeWithGroup, findGroup, fontGroups, type FontEncoder } from './fonts';
import { stripCoveredText } from './strip';
import { coverPolygon } from '@/lib/pdf-form-runs';

/**
 * 원본 PDF + 수정 기록 → 결과 PDF.
 *
 * 원본의 내용 스트림은 건드리지 않는다. 기존 내용을 q…Q 로 감싼 뒤(pdf-lib 가 처리)
 * 쪽 맨 위에 ① 덮개 사각형 ② 새 글자를 덧그린다. 덮개를 먼저 모두 그리고 글자를 나중에
 * 그려, 바로 옆 수정의 덮개가 다른 새 글자를 가리지 않게 한다.
 *
 * 글자는 원본과 같은 행렬(위치·방향·크기)로 쓰고, 글꼴은 `@/lib/pdf-form` 의 순서대로 고른다.
 */

export interface RenderReportItem {
  id: string;
  tier: PdfFontTier | null;
  /** 원본 글꼴에 없어 대체 글꼴로 바꾼 원인 글자 */
  missing: string[];
}

export interface RenderResult {
  bytes: Uint8Array;
  sha256: string;
  pageCount: number;
  report: RenderReportItem[];
  /** 덮은 자리에서 실제로 지운 원래 글자 수 */
  strippedGlyphs: number;
  /**
   * 원래 글자를 모두 지웠다고 말할 수 없는 쪽: 내용을 해석하지 못해 덮기만 했거나, 폭을 모르는
   * 글꼴·양식 XObject 안의 글자가 덮개에 걸칠 수 있어 일부를 지우지 못했을 수 있는 쪽.
   */
  coverOnlyPages: number[];
}

export interface RenderOptions {
  /** 기관이 올린 글꼴 파일을 읽는다(서식의 fonts[].url). */
  loadAsset?: (url: string) => Promise<Uint8Array | null>;
}

const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');
const FALLBACK_FILES: Record<'sans' | 'serif', Record<'regular' | 'bold', string>> = {
  sans: { regular: 'NotoKRSans-Regular.ttf', bold: 'NotoKRSans-Bold.ttf' },
  serif: { regular: 'NotoKRSerif-Regular.ttf', bold: 'NotoKRSerif-Bold.ttf' },
};

/** 대체 글꼴 파일은 크다. 한 번 읽으면 프로세스 안에서 재사용한다. */
const fallbackCache = new Map<string, Uint8Array>();
async function readFallback(file: string): Promise<Uint8Array> {
  const hit = fallbackCache.get(file);
  if (hit) return hit;
  const buf = new Uint8Array(await fs.readFile(path.join(FONT_DIR, file)));
  fallbackCache.set(file, buf);
  return buf;
}

/** PDF 표준 14 글꼴 이름 → pdf-lib 표준 글꼴. 비내장 표준 글꼴은 같은 이름으로 다시 쓴다. */
const STANDARD_MAP: Record<string, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  'Helvetica-Oblique': StandardFonts.HelveticaOblique,
  'Helvetica-BoldOblique': StandardFonts.HelveticaBoldOblique,
  'Times-Roman': StandardFonts.TimesRoman,
  'Times-Bold': StandardFonts.TimesRomanBold,
  'Times-Italic': StandardFonts.TimesRomanItalic,
  'Times-BoldItalic': StandardFonts.TimesRomanBoldItalic,
  Courier: StandardFonts.Courier,
  'Courier-Bold': StandardFonts.CourierBold,
  'Courier-Oblique': StandardFonts.CourierOblique,
  'Courier-BoldOblique': StandardFonts.CourierBoldOblique,
  Arial: StandardFonts.Helvetica,
  'Arial,Bold': StandardFonts.HelveticaBold,
  TimesNewRoman: StandardFonts.TimesRoman,
  'TimesNewRoman,Bold': StandardFonts.TimesRomanBold,
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export { coverPolygon };

interface PdfLibFontChoice {
  kind: 'pdflib';
  font: PDFFont;
  tier: PdfFontTier;
}
interface OriginalChoice {
  kind: 'original';
  segments: Array<{ enc: FontEncoder; codes: number[] }>;
}

export async function renderPdfLayout(
  base: Uint8Array,
  layout: PdfLayout,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const doc = await PDFDocument.load(base, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const pages = doc.getPages();
  const report: RenderReportItem[] = [];
  let strippedGlyphs = 0;
  const coverOnlyPages: number[] = [];

  // ── 지연 로딩되는 pdf-lib 글꼴들 ─────────────────────────────────────
  const fallbackFonts = new Map<string, PDFFont>();
  const fallbackFont = async (serif: boolean, bold: boolean) => {
    const file = FALLBACK_FILES[serif ? 'serif' : 'sans'][bold ? 'bold' : 'regular'];
    let font = fallbackFonts.get(file);
    if (!font) {
      font = await doc.embedFont(await readFallback(file), { subset: true });
      fallbackFonts.set(file, font);
    }
    return font;
  };

  type FkFont = { hasGlyphForCodePoint(cp: number): boolean };
  const uploaded = new Map<string, { bytes: Uint8Array; fk: FkFont; font?: PDFFont } | null>();
  const uploadedFor = async (baseFont: string) => {
    const key = stripSubsetTag(baseFont).toLowerCase();
    if (uploaded.has(key)) return uploaded.get(key) ?? null;
    const asset = layout.fonts.find((f) => f.match.toLowerCase() === key);
    let value: { bytes: Uint8Array; fk: FkFont; font?: PDFFont } | null = null;
    if (asset && options.loadAsset) {
      const bytes = await options.loadAsset(asset.url).catch(() => null);
      if (bytes) {
        try {
          value = { bytes, fk: fontkit.create(Buffer.from(bytes)) as unknown as FkFont };
        } catch {
          value = null;
        }
      }
    }
    uploaded.set(key, value);
    return value;
  };

  const programFonts = new Map<FontEncoder, { fk: FkFont; font?: PDFFont } | null>();
  const programFor = (enc: FontEncoder) => {
    if (programFonts.has(enc)) return programFonts.get(enc) ?? null;
    let value: { fk: FkFont; font?: PDFFont } | null = null;
    // 부분집합 글꼴은 원본에 쓰인 글자만 들어 있다. 전체가 들어 있을 때만 다시 넣는다.
    if (enc.program && !enc.subset) {
      try {
        value = { fk: fontkit.create(Buffer.from(enc.program)) as unknown as FkFont };
      } catch {
        value = null;
      }
    }
    programFonts.set(enc, value);
    return value;
  };

  const covers = (text: string, fk: FkFont) =>
    Array.from(text).every((ch) => /\s/.test(ch) || fk.hasGlyphForCodePoint(ch.codePointAt(0)!));

  // ── 쪽별로 그린다 ───────────────────────────────────────────────────
  const byPage = new Map<number, PdfEdit[]>();
  for (const edit of layout.edits) {
    if (edit.page < 1 || edit.page > pages.length) {
      report.push({ id: edit.id, tier: null, missing: [] });
      continue;
    }
    const list = byPage.get(edit.page) ?? [];
    list.push(edit);
    byPage.set(edit.page, list);
  }

  for (const [pageNo, edits] of byPage) {
    const page = pages[pageNo - 1];
    const groups = fontGroups(doc, page);
    const origKeys = new Map<string, PDFName>();
    const pdflibKeys = new Map<PDFFont, PDFName>();

    const keyForOriginal = (enc: FontEncoder): PDFName => {
      const id = enc.ref ? enc.ref.toString() : `inline:${enc.baseFont}`;
      let k = origKeys.get(id);
      if (!k) {
        const ref = enc.ref ?? doc.context.register(enc.dict);
        // 원래 이름과 겹치지 않는 새 자원 이름으로 같은 글꼴 객체를 한 번 더 가리킨다.
        k = page.node.newFontDictionary('GsOrig', ref as PDFRef);
        origKeys.set(id, k);
      }
      return k;
    };
    const keyForPdfLib = (font: PDFFont): PDFName => {
      let k = pdflibKeys.get(font);
      if (!k) {
        k = page.node.newFontDictionary(font.name, font.ref);
        pdflibKeys.set(font, k);
      }
      return k;
    };

    // 0) 덮을 자리의 원래 글자를 내용 스트림에서 지운다(복사·검색에 옛 값이 남지 않게).
    const polys = edits.filter((e) => e.kind !== 'add').map((e) => coverPolygon(e));
    if (polys.length) {
      const stripped = stripCoveredText(doc, page, polys);
      strippedGlyphs += stripped.removed;
      if (stripped.skipped || stripped.partial) coverOnlyPages.push(pageNo);
    }

    // 1) 덮개
    for (const edit of edits) {
      if (edit.kind === 'add') continue;
      const poly = coverPolygon(edit);
      page.pushOperators(
        pushGraphicsState(),
        setFillingRgbColor(...edit.cover),
        moveTo(...poly[0]),
        lineTo(...poly[1]),
        lineTo(...poly[2]),
        lineTo(...poly[3]),
        closePath(),
        fill(),
        popGraphicsState(),
      );
    }

    // 2) 새 글자
    for (const edit of edits) {
      const text = edit.kind === 'erase' ? '' : edit.text.replace(/[\r\n\t]+/g, ' ');
      if (!text.trim()) {
        report.push({ id: edit.id, tier: edit.kind === 'erase' ? null : 'ORIGINAL', missing: [] });
        continue;
      }

      const choice = await chooseFont(edit, text);
      report.push({ id: edit.id, tier: choice.kind === 'original' ? 'ORIGINAL' : choice.tier, missing: choice.missing });

      const [a, b, c, d, e, f] = edit.matrix;
      const ops: PDFOperator[] = [pushGraphicsState(), setFillingRgbColor(...edit.color), beginText()];
      // 글자 크기는 행렬에 들어 있다(Tf 1 + Tm). 원본과 같은 크기·방향이 그대로 유지된다.
      ops.push(setTextMatrix(a, b, c, d, e, f));
      if (choice.kind === 'original') {
        for (const seg of choice.segments) {
          ops.push(setFontAndSize(keyForOriginal(seg.enc), 1));
          ops.push(showOriginal(doc, seg.enc, seg.codes));
        }
      } else {
        ops.push(setFontAndSize(keyForPdfLib(choice.font), 1));
        ops.push(showText(choice.font.encodeText(text) as PDFHexString));
      }
      ops.push(endText(), popGraphicsState());
      page.pushOperators(...ops);
    }

    async function chooseFont(
      edit: PdfEdit,
      text: string,
    ): Promise<(OriginalChoice | PdfLibFontChoice) & { missing: string[] }> {
      const group = findGroup(groups, edit.font.baseFont);

      // ① 원본 글꼴 객체 그대로
      if (group) {
        const segments = encodeWithSpaces(group, text);
        if (segments) return { kind: 'original', segments, missing: [] };
      }
      const missing = group ? missingFrom(group, text) : [];

      // ② 기관이 올린 같은 이름의 글꼴
      const up = await uploadedFor(edit.font.baseFont);
      if (up && covers(text, up.fk)) {
        if (!up.font) up.font = await doc.embedFont(up.bytes, { subset: true });
        return { kind: 'pdflib', font: up.font, tier: 'UPLOADED', missing };
      }

      // ③ 원본 파일에 들어 있던 글꼴 전체
      if (group) {
        for (const enc of group) {
          const prog = programFor(enc);
          if (prog && enc.program && covers(text, prog.fk)) {
            if (!prog.font) prog.font = await doc.embedFont(enc.program, { subset: true });
            return { kind: 'pdflib', font: prog.font, tier: 'EMBEDDED', missing };
          }
        }
      }

      // ④ PDF 표준 글꼴 (비내장 Helvetica·Times 등). 라틴 글자만 가능하다.
      const std = STANDARD_MAP[stripSubsetTag(edit.font.baseFont)];
      if (std && /^[\x20-\x7e]*$/.test(text)) {
        const font = await doc.embedFont(std);
        return { kind: 'pdflib', font, tier: 'STANDARD', missing };
      }

      // ⑤ 같은 계열·굵기의 한글 대체 글꼴
      const font = await fallbackFont(edit.font.serif, edit.font.bold);
      return { kind: 'pdflib', font, tier: 'FALLBACK', missing };
    }
  }

  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return {
    bytes,
    sha256: sha256(bytes),
    pageCount: pages.length,
    report: orderReport(layout, report),
    strippedGlyphs,
    coverOnlyPages: coverOnlyPages.sort((a, b) => a - b),
  };
}

function orderReport(layout: PdfLayout, report: RenderReportItem[]): RenderReportItem[] {
  const byId = new Map(report.map((r) => [r.id, r]));
  return layout.edits.map((e) => byId.get(e.id) ?? { id: e.id, tier: null, missing: [] });
}

/** 공백 자리 표시: 원본 글꼴에 공백 글리프가 없으면 그 폭만큼 건너뛴다. */
const SPACE_GAP = -1;

/**
 * 원본 글꼴로 나눠 쓰되, 공백이 원본 글꼴에 없으면 글리프 대신 자리만 띄운다.
 * (서식에서 띄어쓰기가 그 글꼴로 한 번도 쓰이지 않았을 수 있다.)
 */
function encodeWithSpaces(
  group: FontEncoder[],
  text: string,
): Array<{ enc: FontEncoder; codes: number[] }> | null {
  const out: Array<{ enc: FontEncoder; codes: number[] }> = [];
  for (const ch of Array.from(text)) {
    const seg = encodeWithGroup(out.length ? [out[out.length - 1].enc, ...group] : group, ch);
    if (seg) {
      const prev = out[out.length - 1];
      if (prev && prev.enc === seg[0].enc) prev.codes.push(...seg[0].codes);
      else out.push({ enc: seg[0].enc, codes: [...seg[0].codes] });
      continue;
    }
    if (/\s/.test(ch)) {
      const enc = out[out.length - 1]?.enc ?? group[0];
      const prev = out[out.length - 1];
      if (prev && prev.enc === enc) prev.codes.push(SPACE_GAP);
      else out.push({ enc, codes: [SPACE_GAP] });
      continue;
    }
    return null;
  }
  return out;
}

function missingFrom(group: FontEncoder[], text: string): string[] {
  const out: string[] = [];
  for (const ch of Array.from(text)) {
    if (/\s/.test(ch)) continue;
    if (group.every((enc) => enc.encode(ch) === null) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

/** 원본 글꼴 코드 출력. 공백 자리는 TJ 의 위치 조정값(1/1000 em)으로 띄운다. */
function showOriginal(doc: PDFDocument, enc: FontEncoder, codes: number[]): PDFOperator {
  if (!codes.includes(SPACE_GAP)) return showText(codesToHex(codes, enc.bytesPerCode));
  const parts: Array<ReturnType<typeof codesToHex> | number> = [];
  let run: number[] = [];
  for (const c of codes) {
    if (c === SPACE_GAP) {
      if (run.length) parts.push(codesToHex(run, enc.bytesPerCode));
      run = [];
      parts.push(-280);
    } else run.push(c);
  }
  if (run.length) parts.push(codesToHex(run, enc.bytesPerCode));
  return PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [doc.context.obj(parts)]);
}

/** 결과 PDF 를 다시 열 수 있는지(손상 여부) 확인한다. */
export async function assertReadablePdf(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPageCount();
}

/** 원본의 쪽 크기(회전 반영 전, pt). */
export async function pdfPageSizes(bytes: Uint8Array): Promise<Array<{ w: number; h: number; rotate: number }>> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p: PDFPage) => {
    const { width, height } = p.getSize();
    return { w: width, h: height, rotate: p.getRotation().angle };
  });
}
