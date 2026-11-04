import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { prisma } from '@/server/db';
import { getObject, newObjectName, putObject } from '@/server/uploads';
import { logger } from '@/lib/logger';
import {
  emptyPdfLayout, parsePdfLayout, type PdfFontInfo, type PdfLayout,
} from '@/lib/pdf-form';
import type { Prisma } from '@/generated/prisma/client';
import { toBasePdf } from './convert';
import { describeFonts, type FontEncoder } from './fonts';
import { renderPdfLayout, type RenderReportItem } from './render';

/**
 * 서식 단위의 원본 편집 기능.
 *
 *  - 업로드 직후 편집 바탕 PDF 를 만든다(`prepareBasePdf`).
 *  - 편집기가 보낸 기록으로 결과 PDF 를 만든다(미리보기 / 저장).
 *  - 저장한 결과 PDF 는 새 파일로 남긴다. 덮어쓰지 않으므로 이미 발송된 서명 요청의
 *    스냅샷(발송 당시 결과 PDF 주소·해시)은 서식을 다시 고쳐도 그대로 유효하다.
 */

export const MEDIA_PDF_RE = /^\/api\/media\/([a-f0-9]{32}\.pdf)$/;
/** 기관이 올린 글꼴은 공개 주소로 내보내지 않는다(라이선스). 저장소 이름만 기록한다. */
export const FONT_OBJECT_RE = /^[a-f0-9]{32}\.(ttf|otf)$/;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** /api/media/<이름>.pdf → 저장소에서 읽는다. 다른 주소는 읽지 않는다. */
export async function readMediaPdf(url: string | null | undefined): Promise<Uint8Array | null> {
  if (!url) return null;
  const m = MEDIA_PDF_RE.exec(url);
  if (!m) return null;
  const buf = await getObject(m[1]);
  return buf ? new Uint8Array(buf) : null;
}

async function loadFontAsset(name: string): Promise<Uint8Array | null> {
  if (!FONT_OBJECT_RE.test(name)) return null;
  const buf = await getObject(name);
  return buf ? new Uint8Array(buf) : null;
}

export interface BasePdfInfo {
  basePdfUrl: string;
  basePdfHash: string;
  pageCount: number;
  convertedFrom: 'none' | 'image' | 'office';
}

/**
 * 올린 파일로 편집 바탕 PDF 를 만든다.
 * 원본이 PDF 면 같은 파일을 쓰고(`originalUrl`), 아니면 변환본을 새로 저장한다.
 */
export async function prepareBasePdf(
  buf: Uint8Array,
  ext: string,
  originalUrl: string,
): Promise<{ ok: true; info: BasePdfInfo } | { ok: false; message: string }> {
  const res = await toBasePdf(buf, ext);
  if (!res.ok) return res;
  let url = originalUrl;
  if (res.converted !== 'none' || !MEDIA_PDF_RE.test(originalUrl)) {
    url = await putObject(newObjectName('pdf'), Buffer.from(res.pdf), 'application/octet-stream');
  }
  return {
    ok: true,
    info: { basePdfUrl: url, basePdfHash: sha256(res.pdf), pageCount: res.pageCount, convertedFrom: res.converted },
  };
}

/**
 * 폼이 보낸 바탕 PDF 주소를 서버에서 다시 확인한다(브라우저가 보낸 해시·쪽수는 믿지 않는다).
 */
export async function verifyBasePdf(url: string): Promise<{ hash: string; pageCount: number } | null> {
  const bytes = await readMediaPdf(url);
  if (!bytes) return null;
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return { hash: sha256(bytes), pageCount: doc.getPageCount() };
  } catch {
    return null;
  }
}

/** 서식에 저장된 편집 기록. 없거나 깨졌으면 빈 기록. */
export function templateLayout(raw: unknown): PdfLayout {
  return parsePdfLayout(raw) ?? emptyPdfLayout();
}

/** 후원자·서명자가 보는 PDF: 편집 결과가 있으면 그것, 없으면 바탕 PDF. */
export function effectivePdf(t: {
  renderedPdfUrl: string | null;
  renderedPdfHash: string | null;
  basePdfUrl: string | null;
  basePdfHash: string | null;
}): { url: string; hash: string | null } | null {
  if (t.renderedPdfUrl) return { url: t.renderedPdfUrl, hash: t.renderedPdfHash };
  if (t.basePdfUrl) return { url: t.basePdfUrl, hash: t.basePdfHash };
  return null;
}

/** 원본 글꼴 프로그램을 통째로 다시 넣을 수 있는지(부분집합이 아닌 TrueType 계열). */
function reusableProgram(enc: FontEncoder): boolean {
  return !!enc.program && !enc.subset;
}

/** 편집기용 글꼴 정보: 원본 글꼴마다 그대로 쓸 수 있는 글자. */
export async function fontInfoForBase(basePdf: Uint8Array, layout: PdfLayout): Promise<PdfFontInfo[]> {
  const doc = await PDFDocument.load(basePdf, { updateMetadata: false });
  return describeFonts(
    doc,
    layout.fonts.map((f) => f.match),
    reusableProgram,
  );
}

async function loadOwnTemplate(merchantId: string, templateId: string) {
  const t = await prisma.documentTemplate.findFirst({
    where: { id: templateId, merchantId, archivedAt: null },
    select: {
      id: true, templateType: true, basePdfUrl: true, basePdfHash: true, pdfLayout: true,
      renderedPdfUrl: true, renderedPdfHash: true, pdfPageCount: true, name: true,
    },
  });
  if (!t || t.templateType !== 'FILE' || !t.basePdfUrl) return null;
  return t;
}

/** 저장하지 않고 결과 PDF 만 만든다(편집기의 "실제 결과" 미리보기). */
export async function previewTemplateLayout(
  merchantId: string,
  templateId: string,
  rawLayout: unknown,
): Promise<{ ok: true; bytes: Uint8Array; report: RenderReportItem[]; stripped: number; coverOnlyPages: number[] } | { ok: false; message: string }> {
  const t = await loadOwnTemplate(merchantId, templateId);
  if (!t) return { ok: false, message: '원본을 고칠 수 있는 서식이 아닙니다.' };
  const layout = parsePdfLayout(rawLayout);
  if (!layout) return { ok: false, message: '편집 내용 형식이 올바르지 않습니다.' };
  const base = await readMediaPdf(t.basePdfUrl);
  if (!base) return { ok: false, message: '원본 PDF 를 찾을 수 없습니다. 서식 파일을 다시 올려 주세요.' };
  const r = await renderPdfLayout(base, layout, { loadAsset: loadFontAsset });
  return { ok: true, bytes: r.bytes, report: r.report, stripped: r.strippedGlyphs, coverOnlyPages: r.coverOnlyPages };
}

export interface SaveLayoutResult {
  ok: true;
  report: RenderReportItem[];
  renderedPdfUrl: string | null;
  edits: number;
  stripped: number;
  coverOnlyPages: number[];
}

/**
 * 편집 기록을 저장하고 결과 PDF 를 새 파일로 남긴다.
 * 수정이 하나도 없으면 결과 PDF 를 비워 바탕 PDF 를 그대로 쓰게 한다(원본으로 되돌리기).
 */
export async function saveTemplateLayout(
  merchantId: string,
  templateId: string,
  rawLayout: unknown,
): Promise<SaveLayoutResult | { ok: false; message: string }> {
  const t = await loadOwnTemplate(merchantId, templateId);
  if (!t) return { ok: false, message: '원본을 고칠 수 있는 서식이 아닙니다.' };
  const layout = parsePdfLayout(rawLayout);
  if (!layout) return { ok: false, message: '편집 내용 형식이 올바르지 않습니다.' };
  for (const f of layout.fonts) {
    if (!FONT_OBJECT_RE.test(f.url)) return { ok: false, message: '올린 글꼴 정보가 올바르지 않습니다. 글꼴을 다시 올려 주세요.' };
  }
  if (t.pdfPageCount) {
    const out = layout.edits.find((e) => e.page > t.pdfPageCount!);
    if (out) return { ok: false, message: '원본에 없는 쪽의 수정이 있습니다. 화면을 새로 고친 뒤 다시 저장해 주세요.' };
  }

  if (layout.edits.length === 0) {
    await prisma.documentTemplate.update({
      where: { id: t.id },
      data: {
        pdfLayout: layout as unknown as Prisma.InputJsonValue,
        renderedPdfUrl: null,
        renderedPdfHash: null,
        pdfEditedAt: new Date(),
      },
    });
    return { ok: true, report: [], renderedPdfUrl: null, edits: 0, stripped: 0, coverOnlyPages: [] };
  }

  const base = await readMediaPdf(t.basePdfUrl);
  if (!base) return { ok: false, message: '원본 PDF 를 찾을 수 없습니다. 서식 파일을 다시 올려 주세요.' };

  let rendered;
  try {
    rendered = await renderPdfLayout(base, layout, { loadAsset: loadFontAsset });
  } catch (err) {
    logger.warn('[pdf-form] 결과 PDF 생성 실패', { templateId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, message: '고친 내용을 PDF 로 만들지 못했습니다. 마지막 수정을 되돌린 뒤 다시 저장해 주세요.' };
  }

  // 새 파일로 남긴다. 이전 결과 파일은 지우지 않는다(발송된 서명 요청이 가리킬 수 있다).
  const url = await putObject(newObjectName('pdf'), Buffer.from(rendered.bytes), 'application/octet-stream');
  await prisma.documentTemplate.update({
    where: { id: t.id },
    data: {
      pdfLayout: layout as unknown as Prisma.InputJsonValue,
      renderedPdfUrl: url,
      renderedPdfHash: rendered.sha256,
      pdfEditedAt: new Date(),
    },
  });
  return {
    ok: true,
    report: rendered.report,
    renderedPdfUrl: url,
    edits: layout.edits.length,
    stripped: rendered.strippedGlyphs,
    coverOnlyPages: rendered.coverOnlyPages,
  };
}
