import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { prisma } from '@/server/db';
import { getObject, newObjectName, putObject } from '@/server/uploads';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  emptyPdfLayout, parsePdfLayout, type PdfFontInfo, type PdfLayout,
} from '@/lib/pdf-form';
import type { Prisma } from '@/generated/prisma/client';
import { toBasePdf } from './convert';
import { describeFonts, type FontEncoder } from './fonts';
import { renderPdfLayout, type RenderReportItem } from './render';

/**
 * 서식 원본 편집 — 서버 쪽 진입점.
 *
 *  - 업로드 직후 편집 바탕 PDF 를 만든다(`prepareBasePdf`).
 *  - 편집기가 보낸 기록으로 결과 PDF 를 만든다(미리보기 / 저장).
 *  - 저장한 결과 PDF 는 새 파일로 남긴다. 덮어쓰지 않으므로 이미 발송된 서명 요청의
 *    스냅샷(발송 당시 결과 PDF 주소·해시)은 서식을 다시 고쳐도 그대로 유효하다.
 *
 * ── 등록 전 미리보기와 "누가 올린 파일인가" ─────────────────────────────
 * 서식 등록 화면에서는 아직 서식 행이 없는 상태로 미리보기·편집을 한다. 그때 브라우저가 보내는
 * 바탕 PDF 주소만 믿으면, 다른 기관이 올린 파일 주소를 넣어 그 내용을 미리보기로 받아 볼 수 있다.
 * 그래서 업로드 응답에 "이 기관이 이 파일을 올렸다" 는 서명 토큰(baseToken)을 함께 주고,
 * 미리보기·등록 때 그 토큰을 확인한다. 이미 저장된 서식은 서식 ID 와 기관으로 확인한다.
 */

export const MEDIA_PDF_RE = /^\/api\/media\/([a-f0-9]{32}\.pdf)$/;
/** 기관이 올린 글꼴은 공개 주소로 내보내지 않는다(라이선스). 저장소 이름만 기록한다. */
export const FONT_OBJECT_RE = /^[a-f0-9]{32}\.(ttf|otf)$/;

/** 업로드 토큰 유효시간. 등록 화면에서 오래 작업해도 끊기지 않게 넉넉히 둔다. */
const BASE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function tokenSig(merchantId: string, url: string, exp: number): string {
  return createHmac('sha256', env.crypto.sessionSecret)
    .update(`pdf-base:${merchantId}:${url}:${exp}`)
    .digest('base64url');
}

/** "이 기관이 이 바탕 PDF 를 올렸다" 는 서명 토큰. */
export function signBasePdf(merchantId: string, url: string, now = Date.now()): string {
  const exp = now + BASE_TOKEN_TTL_MS;
  return `${exp}.${tokenSig(merchantId, url, exp)}`;
}

export function verifyBasePdfToken(merchantId: string, url: string, token: string, now = Date.now()): boolean {
  const m = /^(\d{10,15})\.([A-Za-z0-9_-]{20,100})$/.exec(token ?? '');
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > now)) return false;
  const want = Buffer.from(tokenSig(merchantId, url, exp));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
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
): Promise<{ ok: true; info: BasePdfInfo; pdf: Uint8Array } | { ok: false; message: string }> {
  const res = await toBasePdf(buf, ext);
  if (!res.ok) return res;
  let url = originalUrl;
  if (res.converted !== 'none' || !MEDIA_PDF_RE.test(originalUrl)) {
    url = await putObject(newObjectName('pdf'), Buffer.from(res.pdf), 'application/octet-stream');
  }
  return {
    ok: true,
    pdf: res.pdf,
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

/** 편집 기록의 형식 검사(쪽 범위·올린 글꼴 이름). 통과하면 null. */
export function layoutProblem(layout: PdfLayout, pageCount: number | null): string | null {
  for (const f of layout.fonts) {
    if (!FONT_OBJECT_RE.test(f.url)) return '올린 글꼴 정보가 올바르지 않습니다. 글꼴을 다시 올려 주세요.';
  }
  if (pageCount && layout.edits.some((e) => e.page > pageCount)) {
    return '원본에 없는 쪽의 수정이 있습니다. 화면을 새로 고친 뒤 다시 저장해 주세요.';
  }
  return null;
}

export interface RenderedFile {
  url: string;
  hash: string;
  report: RenderReportItem[];
  stripped: number;
  coverOnlyPages: number[];
}

/**
 * 바탕 PDF + 편집 기록으로 결과 PDF 를 만들어 **새 파일로** 저장한다.
 * 수정이 하나도 없으면 null(바탕 PDF 를 그대로 쓴다).
 */
export async function renderAndStore(
  basePdfUrl: string,
  layout: PdfLayout,
): Promise<{ ok: true; file: RenderedFile | null } | { ok: false; message: string }> {
  if (layout.edits.length === 0) return { ok: true, file: null };
  const base = await readMediaPdf(basePdfUrl);
  if (!base) return { ok: false, message: '원본 PDF 를 찾을 수 없습니다. 서식 파일을 다시 올려 주세요.' };
  let rendered;
  try {
    rendered = await renderPdfLayout(base, layout, { loadAsset: loadFontAsset });
  } catch (err) {
    logger.warn('[pdf-form] 결과 PDF 생성 실패', { err: err instanceof Error ? err.message : String(err) });
    return { ok: false, message: '고친 내용을 PDF 로 만들지 못했습니다. 마지막 수정을 되돌린 뒤 다시 저장해 주세요.' };
  }
  // 이전 결과 파일은 지우지 않는다(발송된 서명 요청이 가리킬 수 있다).
  const url = await putObject(newObjectName('pdf'), Buffer.from(rendered.bytes), 'application/octet-stream');
  return {
    ok: true,
    file: {
      url,
      hash: rendered.sha256,
      report: rendered.report,
      stripped: rendered.strippedGlyphs,
      coverOnlyPages: rendered.coverOnlyPages,
    },
  };
}

/** 편집기가 무엇을 바탕으로 미리보기를 요청하는지 */
export type PreviewSource = { templateId: string } | { basePdfUrl: string; token: string };

/** 미리보기 바탕 PDF 를 찾는다. 기관 소유가 확인되지 않으면 null. */
async function resolveBase(
  merchantId: string,
  source: PreviewSource,
): Promise<{ base: Uint8Array; pageCount: number | null } | { error: string }> {
  if ('templateId' in source) {
    const t = await prisma.documentTemplate.findFirst({
      where: { id: source.templateId, merchantId, archivedAt: null, templateType: 'FILE' },
      select: { basePdfUrl: true, pdfPageCount: true },
    });
    if (!t?.basePdfUrl) return { error: '원본을 고칠 수 있는 서식이 아닙니다.' };
    const base = await readMediaPdf(t.basePdfUrl);
    if (!base) return { error: '원본 PDF 를 찾을 수 없습니다. 서식 파일을 다시 올려 주세요.' };
    return { base, pageCount: t.pdfPageCount };
  }
  if (!MEDIA_PDF_RE.test(source.basePdfUrl) || !verifyBasePdfToken(merchantId, source.basePdfUrl, source.token)) {
    return { error: '업로드 확인이 끝났습니다. 서식 파일을 다시 올려 주세요.' };
  }
  const base = await readMediaPdf(source.basePdfUrl);
  if (!base) return { error: '원본 PDF 를 찾을 수 없습니다. 서식 파일을 다시 올려 주세요.' };
  return { base, pageCount: null };
}

/** 저장하지 않고 결과 PDF 만 만든다(편집기의 "실제 결과" 미리보기). */
export async function previewLayout(
  merchantId: string,
  source: PreviewSource,
  rawLayout: unknown,
): Promise<
  | { ok: true; bytes: Uint8Array; report: RenderReportItem[]; stripped: number; coverOnlyPages: number[] }
  | { ok: false; message: string }
> {
  const resolved = await resolveBase(merchantId, source);
  if ('error' in resolved) return { ok: false, message: resolved.error };
  const layout = parsePdfLayout(rawLayout);
  if (!layout) return { ok: false, message: '편집 내용 형식이 올바르지 않습니다.' };
  const problem = layoutProblem(layout, resolved.pageCount);
  if (problem) return { ok: false, message: problem };
  const r = await renderPdfLayout(resolved.base, layout, { loadAsset: loadFontAsset });
  return { ok: true, bytes: r.bytes, report: r.report, stripped: r.strippedGlyphs, coverOnlyPages: r.coverOnlyPages };
}

/** 이전 이름 호환(서식 ID 로 미리보기). */
export function previewTemplateLayout(merchantId: string, templateId: string, rawLayout: unknown) {
  return previewLayout(merchantId, { templateId }, rawLayout);
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
 * 저장된 서식의 편집 기록만 저장한다(넓은 화면 편집기).
 * 수정이 하나도 없으면 결과 PDF 를 비워 바탕 PDF 를 그대로 쓰게 한다(원본으로 되돌리기).
 */
export async function saveTemplateLayout(
  merchantId: string,
  templateId: string,
  rawLayout: unknown,
): Promise<SaveLayoutResult | { ok: false; message: string }> {
  const t = await prisma.documentTemplate.findFirst({
    where: { id: templateId, merchantId, archivedAt: null, templateType: 'FILE' },
    select: { id: true, basePdfUrl: true, pdfPageCount: true },
  });
  if (!t?.basePdfUrl) return { ok: false, message: '원본을 고칠 수 있는 서식이 아닙니다.' };
  const layout = parsePdfLayout(rawLayout);
  if (!layout) return { ok: false, message: '편집 내용 형식이 올바르지 않습니다.' };
  const problem = layoutProblem(layout, t.pdfPageCount);
  if (problem) return { ok: false, message: problem };

  const res = await renderAndStore(t.basePdfUrl, layout);
  if (!res.ok) return res;
  await prisma.documentTemplate.update({
    where: { id: t.id },
    data: {
      pdfLayout: layout as unknown as Prisma.InputJsonValue,
      renderedPdfUrl: res.file?.url ?? null,
      renderedPdfHash: res.file?.hash ?? null,
      pdfEditedAt: new Date(),
    },
  });
  return {
    ok: true,
    report: res.file?.report ?? [],
    renderedPdfUrl: res.file?.url ?? null,
    edits: layout.edits.length,
    stripped: res.file?.stripped ?? 0,
    coverOnlyPages: res.file?.coverOnlyPages ?? [],
  };
}
