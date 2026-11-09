import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { matrixFontSize, type PdfEdit, type PdfLayout } from '@/lib/pdf-form';
import { encodeWithGroup, findGroup, fontGroups } from './fonts';

/**
 * 파일 서식 글자 폭 재기 — 발송 전 점검(document-preflight)이 쓴다. 결과 PDF 는 만들지 않는다.
 *
 * 렌더러(render.ts)와 같은 글꼴 순서를 따른다: ① 그 쪽의 원본 글꼴 사전으로 모두 쓸 수 있으면 그 사전의 글자 폭(/Widths·/W),
 * ② 아니면 같은 계열·굵기 대체 글꼴(assets/fonts)의 글자 폭. 크기는 편집 기록 행렬에서 읽는다(원본과 같음).
 * 올린 글꼴·원본 통째 글꼴은 대체 글꼴로 근사한다(폭이 다를 수 있어 결과는 "가능성" 경고로만 쓴다).
 */

const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');
const FALLBACK_FILES: Record<'sans' | 'serif', Record<'regular' | 'bold', string>> = {
  sans: { regular: 'NotoKRSans-Regular.ttf', bold: 'NotoKRSans-Bold.ttf' },
  serif: { regular: 'NotoKRSerif-Regular.ttf', bold: 'NotoKRSerif-Bold.ttf' },
};

type FkFont = { unitsPerEm: number; glyphForCodePoint(cp: number): { advanceWidth: number } };
const fkCache = new Map<string, FkFont>();

async function fallbackFk(serif: boolean, bold: boolean): Promise<FkFont> {
  const file = FALLBACK_FILES[serif ? 'serif' : 'sans'][bold ? 'bold' : 'regular'];
  const hit = fkCache.get(file);
  if (hit) return hit;
  const bytes = await fs.readFile(path.join(FONT_DIR, file));
  const f = fontkit.create(bytes) as unknown as FkFont;
  fkCache.set(file, f);
  return f;
}

/** 대체 글꼴로 잰 폭(pt). */
export async function fallbackTextWidth(text: string, size: number, font: { serif: boolean; bold: boolean }): Promise<number> {
  const fk = await fallbackFk(font.serif, font.bold);
  let units = 0;
  for (const ch of Array.from(text)) units += fk.glyphForCodePoint(ch.codePointAt(0)!).advanceWidth;
  return (units / fk.unitsPerEm) * size;
}

export interface EditMeasure {
  id: string;
  /** 머지한 글자의 폭(pt) */
  widthPt: number;
  /** 들어갈 칸 폭(pt). 고친 글자(replace)는 원래 글자 폭, 새 글자(add)는 쪽 오른쪽 여백까지. 모르면 0 */
  boxPt: number;
}

/**
 * 머지한 편집 기록의 새 글자마다 폭을 잰다.
 * @param base 바탕 PDF (없으면 원본 글꼴을 볼 수 없어 대체 글꼴로만 잰다)
 */
export async function measureLayoutTexts(base: Uint8Array | null, layout: PdfLayout, only?: (e: PdfEdit) => boolean): Promise<EditMeasure[]> {
  const doc = base ? await PDFDocument.load(base, { updateMetadata: false }).catch(() => null) : null;
  const pages = doc?.getPages() ?? [];
  const groupCache = new Map<number, ReturnType<typeof fontGroups>>();
  const out: EditMeasure[] = [];
  for (const e of layout.edits) {
    if (e.kind === 'erase' || !e.text.trim()) continue;
    if (only && !only(e)) continue;
    const size = matrixFontSize(e.matrix);
    const text = e.text.replace(/[\r\n\t]+/g, ' ');
    let width: number | null = null;
    const page = doc && e.page >= 1 && e.page <= pages.length ? pages[e.page - 1]! : null;
    if (doc && page) {
      let groups = groupCache.get(e.page);
      if (!groups) {
        groups = fontGroups(doc, page);
        groupCache.set(e.page, groups);
      }
      const group = findGroup(groups, e.font.baseFont);
      const segs = group ? encodeWithGroup(group, text) : null;
      if (segs) {
        let units = 0;
        let known = true;
        for (const s of segs) {
          for (const c of s.codes) {
            const w = s.enc.widthOf(c);
            if (w == null) known = false;
            else units += w;
          }
        }
        if (known) width = (units / 1000) * size;
      }
    }
    if (width == null) width = await fallbackTextWidth(text, size, e.font);
    let box = e.kind === 'replace' ? e.width : 0;
    if (e.kind === 'add' && page) {
      // 새 글자: 기준선 시작점에서 쪽 오른쪽 여백(18pt)까지를 칸으로 본다(가로쓰기만).
      const { width: pw } = page.getSize();
      if (Math.abs(e.matrix[1]) < 0.01 && e.matrix[0] > 0) box = Math.max(0, pw - 18 - e.matrix[4]);
    }
    out.push({ id: e.id, widthPt: width, boxPt: box });
  }
  return out;
}
