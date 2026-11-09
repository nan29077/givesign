import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { parsePdfLayout } from '@/lib/pdf-form';
import { exampleMergeValues } from '@/lib/merge-fields';
import { stressSampleValues, type PreflightResult } from '@/lib/document-preflight';
import { detectFieldCandidates, ocrLinesToPages, type DetectResult } from '@/lib/pdf-form-detect';
import { getOcrAdapter } from '@/server/adapters/ocr';
import { resolveBase, type PreviewSource } from './index';
import { pdfPageSizes } from './render';

/**
 * 서식 자동 인식 — 서버 쪽 (2026-11-12 4차 J1).
 *
 *  - 글자가 있는 PDF 는 편집기(브라우저)가 이미 읽은 글자 묶음으로 바로 후보를 만든다(`@/lib/pdf-form-detect`).
 *  - 스캔본(글자가 그림)은 여기서 OCR 어댑터로 읽어 같은 규칙에 넣는다. mock 이면 빈 결과 + mock 표시(읽은 척하지 않는다).
 *  - 무엇도 저장하지 않는다. 편집 기록은 담당자가 후보를 수락할 때 편집기에서만 바뀐다.
 *  - 수락 뒤 점검(`checkLayoutPreflight`)은 1차 발송 전 점검 규칙을 그대로 쓴다(정상 표본 + 가장 긴 표본, 저장·발송 없음).
 */

export type OcrDetectResult =
  | ({ ok: true; mock: boolean; provider: string } & DetectResult)
  | { ok: false; message: string };

export async function detectByOcr(merchantId: string, source: PreviewSource, rawLayout?: unknown): Promise<OcrDetectResult> {
  const resolved = await resolveBase(merchantId, source);
  if ('error' in resolved) return { ok: false, message: resolved.error };
  const adapter = getOcrAdapter();
  const info = adapter.info();
  try {
    const [sizes, ocr] = await Promise.all([pdfPageSizes(resolved.base), adapter.recognize(resolved.base, 'application/pdf')]);
    const pages = ocrLinesToPages(ocr.lines, sizes);
    const r = detectFieldCandidates(pages, { source: 'ocr', existing: parsePdfLayout(rawLayout) });
    return { ok: true, mock: Boolean(ocr.mock) || info.mode === 'mock', provider: info.provider, ...r };
  } catch (e) {
    // 본문은 로그에 남기지 않는다(개인정보가 든 서식일 수 있다).
    logger.warn('[pdf-form] OCR 자동 인식 실패', { provider: info.provider, message: (e as Error).message });
    return { ok: false, message: '스캔본 글자를 읽지 못했습니다. [새 글 넣기] 로 직접 자리를 넣어 주세요.' };
  }
}

export interface LayoutCheckResult {
  ok: true;
  /** 예시 값(보통 길이) */
  normal: PreflightResult;
  /** 가장 긴 값(넘침 확인) */
  stress: PreflightResult;
}

/**
 * 저장 전 편집 기록으로 발송 전 점검을 돌린다(1차 C 규칙 — 서식이 실제로 쓰는 필수 필드·글자 넘침 등).
 * purpose: 저장된 서식이면 서식의 용도, 등록 전이면 화면에서 고른 용도(없으면 용도별 필수 항목은 보지 않는다).
 */
export async function checkLayoutPreflight(
  merchantId: string,
  source: PreviewSource,
  rawLayout: unknown,
  purpose: string | null,
): Promise<LayoutCheckResult | { ok: false; message: string }> {
  const resolved = await resolveBase(merchantId, source);
  if ('error' in resolved) return { ok: false, message: resolved.error };
  const layout = parsePdfLayout(rawLayout);
  if (!layout) return { ok: false, message: '편집 내용 형식이 올바르지 않습니다.' };
  let t: { id: string; purpose: string | null; body: string | null; active: boolean; archivedAt: Date | null; basePdfUrl: string | null } = {
    id: 'draft', purpose, body: null, active: true, archivedAt: null, basePdfUrl: null,
  };
  if ('templateId' in source) {
    const row = await prisma.documentTemplate.findFirst({ where: { id: source.templateId, merchantId }, select: { id: true, purpose: true, body: true, active: true, archivedAt: true, basePdfUrl: true } });
    if (row) t = { ...row, purpose: row.purpose ?? purpose };
  }
  const { preflightDocument } = await import('../document-preflight');
  const tpl = { ...t, templateType: 'FILE' as const, pdfLayout: layout as unknown as object };
  const ctx = { recipient: { hasContact: true } };
  const [normal, stress] = await Promise.all([
    preflightDocument(tpl, { values: exampleMergeValues(), ...ctx }, { base: resolved.base }),
    preflightDocument(tpl, { values: stressSampleValues(), ...ctx }, { base: resolved.base }),
  ]);
  return { ok: true, normal, stress };
}
