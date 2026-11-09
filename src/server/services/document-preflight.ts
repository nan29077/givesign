import { prisma } from '@/server/db';
import { decrypt } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { parsePdfLayout } from '@/lib/pdf-form';
import { hasMergeFields, renderMergeHtml, renderMergeText, type MergeValues } from '@/lib/merge-fields';
import {
  pickSamples, runPreflight, stressSampleValues, templateMergeKeys,
  type MeasuredBox, type PreflightResult, type RecipientLike, type SampleKind,
} from '@/lib/document-preflight';
import type { DocumentTemplate } from '@/generated/prisma/client';
import { PREFLIGHT_BLOCK_PREFIX } from './purpose-documents';

/**
 * 문서 발송 전 점검 — 서버 쪽 (2026-11-09 과제 C2).
 *
 *  - `preflightDocument(서식, 수신자 맥락)` → `{ level: ok|warn|block, issues }`. 판정 규칙은 `@/lib/document-preflight` 의 순수 함수다.
 *  - 파일 서식은 편집 기록의 글자 상자(원래 글자 폭)와 글꼴 크기로 **실제 글자 폭**을 잰다(pdf-form/measure.ts).
 *  - 발송 경로(issuePurposeDocumentImpl)는 block 이면 보내지 않고 `blocked: 'PREFLIGHT'`, warn 이면 보내고 발급 행에 경고를 남긴다.
 *  - 미리보기(previewSamples·previewTemplateWithStress)는 **저장·발송하지 않는다**. 결과 PDF 는 메모리에서만 만든다.
 */

type TemplateForPreflight = Pick<DocumentTemplate, 'id' | 'purpose' | 'body' | 'templateType' | 'pdfLayout' | 'basePdfUrl' | 'active' | 'archivedAt'>;

export interface PreflightContext {
  values: MergeValues;
  recipient?: RecipientLike | null;
  batch?: { amounts?: bigint[] };
  now?: Date;
}

function pdfTextsOf(t: Pick<DocumentTemplate, 'templateType' | 'pdfLayout'>): string[] {
  if (t.templateType !== 'FILE') return [];
  const layout = parsePdfLayout(t.pdfLayout);
  return layout ? layout.edits.filter((e) => e.kind !== 'erase').map((e) => e.text) : [];
}

/** 파일 서식: 머지 필드가 든 새 글자를 값으로 채운 뒤 폭을 잰다. 실패하면 측정 없이(본문 기준) 판정한다. */
async function measureFileTemplate(t: TemplateForPreflight, values: MergeValues, base?: Uint8Array | null): Promise<MeasuredBox[] | undefined> {
  if (t.templateType !== 'FILE') return undefined;
  const layout = parsePdfLayout(t.pdfLayout);
  if (!layout) return undefined;
  const target = layout.edits.filter((e) => e.kind !== 'erase' && hasMergeFields(e.text));
  if (!target.length) return [];
  try {
    const { measureLayoutTexts } = await import('./pdf-form/measure');
    let bytes = base ?? null;
    if (bytes === undefined || bytes === null) {
      const { readMediaPdf } = await import('./pdf-form');
      bytes = await readMediaPdf(t.basePdfUrl).catch(() => null);
    }
    const merged = { ...layout, edits: target.map((e) => ({ ...e, text: renderMergeText(e.text, values).text })) };
    const m = await measureLayoutTexts(bytes, merged);
    return m.map((x) => {
      const src = target.find((e) => e.id === x.id)!;
      const keys = src.text.match(/\{\{\s*([^{}]+?)\s*\}\}/g)?.map((s) => s.replace(/[{}\s]/g, '')) ?? [];
      return { field: keys[0], text: merged.edits.find((e) => e.id === x.id)!.text, widthPt: x.widthPt, boxPt: x.boxPt };
    });
  } catch (e) {
    logger.warn('발송 전 점검: 파일 서식 폭 측정 실패', { templateId: t.id, message: (e as Error).message });
    return undefined;
  }
}

/** 서식 + 수신자 맥락 → 점검 결과. 예외를 던지지 않는다(점검 실패가 발송 흐름을 깨지 않게 — 실패하면 ok 가 아니라 측정 없이 판정). */
export async function preflightDocument(t: TemplateForPreflight, ctx: PreflightContext, opts: { base?: Uint8Array | null } = {}): Promise<PreflightResult> {
  const measured = await measureFileTemplate(t, ctx.values, opts.base);
  return runPreflight({
    template: { purpose: t.purpose, body: t.body, pdfTexts: pdfTextsOf(t), active: t.active, archivedAt: t.archivedAt },
    values: ctx.values as Record<string, string | null | undefined>,
    recipient: ctx.recipient ?? null,
    batch: ctx.batch,
    measured,
    now: ctx.now,
  });
}

/** 받는 사람 상태(연락처·탈퇴·차단)를 읽는다. */
export async function recipientFor(merchantId: string, payerId: string): Promise<RecipientLike> {
  const [payer, link, blocked] = await Promise.all([
    prisma.payerProfile.findUnique({ where: { id: payerId }, select: { phoneEnc: true, onboardingStatus: true } }),
    prisma.payerMerchantLink.findUnique({ where: { payerId_merchantId: { payerId, merchantId } }, select: { payerBlockedAt: true } }),
    prisma.blockedPayer.findFirst({ where: { merchantId, payerId }, select: { id: true } }),
  ]);
  let hasContact = false;
  if (payer?.phoneEnc) {
    try {
      hasContact = decrypt(payer.phoneEnc).replace(/\D/g, '').length >= 9;
    } catch {
      hasContact = false;
    }
  }
  return { hasContact, withdrawn: !payer || payer.onboardingStatus === 'WITHDRAWN', blocked: Boolean(blocked || link?.payerBlockedAt) };
}

/** 점검 결과 → 한 줄 사유(발급 결과·저니 기록·화면) */
export function preflightReason(r: PreflightResult): string {
  const blocks = r.issues.filter((i) => i.severity === 'block').map((i) => i.message);
  if (blocks.length) return `${PREFLIGHT_BLOCK_PREFIX}: ${blocks.join(' / ')}`.slice(0, 300);
  return r.issues.map((i) => i.message).join(' / ').slice(0, 300);
}

// ---------------------------------------------------------------------------
// 표본 미리보기 (저장·발송하지 않음)
// ---------------------------------------------------------------------------

export interface SamplePreview {
  kind: SampleKind;
  key: string;
  label: string;
  preflight: PreflightResult;
  /** 본문 서식: 머지 결과 HTML(이스케이프 + 빈칸 표시) */
  html: string | null;
  /** 파일 서식: 첫 쪽만 남긴 결과 PDF(data URL). 만들지 못하면 null */
  pdfDataUrl: string | null;
  missing: string[];
}

/** 파일 서식 결과 PDF 첫 쪽(메모리). 저장소에 쓰지 않는다. */
async function firstPagePdf(merchantId: string, t: TemplateForPreflight, values: MergeValues, base: Uint8Array | null): Promise<string | null> {
  if (t.templateType !== 'FILE' || !base) return null;
  const layout = parsePdfLayout(t.pdfLayout);
  if (!layout) return null;
  try {
    const { renderPdfLayout } = await import('./pdf-form/render');
    const { fontLoaderFor } = await import('./pdf-form/font-assets');
    const { PDFDocument } = await import('pdf-lib');
    const merged = { ...layout, edits: layout.edits.filter((e) => e.page === 1).map((e) => (e.kind === 'erase' ? e : { ...e, text: renderMergeText(e.text, values).text })) };
    const load = fontLoaderFor(merchantId);
    const r = await renderPdfLayout(base, merged, { loadAsset: (name) => (/^[a-f0-9]{32}\.(ttf|otf)$/.test(name) ? load(name) : Promise.resolve(null)) });
    const src = await PDFDocument.load(r.bytes, { updateMetadata: false });
    const one = await PDFDocument.create();
    const [p] = await one.copyPages(src, [0]);
    one.addPage(p);
    const bytes = await one.save();
    return `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`;
  } catch (e) {
    logger.warn('표본 미리보기 PDF 생성 실패', { templateId: t.id, message: (e as Error).message });
    return null;
  }
}

export interface SampleInput {
  key: string;
  label: string;
  values: MergeValues;
  recipient?: RecipientLike | null;
}

/**
 * 대량 발송·일괄 발급 전 표본 3건(정상 1 · 빈칸 1 · 이름이 가장 긴 1)을 실제 렌더 결과로 보여 준다.
 * 저장·발송하지 않는다. 묶음 전체 금액으로 이상값도 함께 본다.
 */
export async function previewSamples(merchantId: string, t: TemplateForPreflight, cands: SampleInput[], opts: { now?: Date } = {}): Promise<SamplePreview[]> {
  const used = templateMergeKeys({ body: t.body, pdfTexts: pdfTextsOf(t) });
  const picked = pickSamples(cands.map((c) => ({ ...c, values: c.values as Record<string, string | null | undefined> })), used);
  const amounts = cands.map((c) => {
    const v = c.values['금액'];
    const s = v == null ? '' : String(v).replace(/[,\s원]/g, '');
    return /^\d+$/.test(s) ? BigInt(s) : 0n;
  });
  let base: Uint8Array | null = null;
  if (t.templateType === 'FILE') {
    const { readMediaPdf } = await import('./pdf-form');
    base = await readMediaPdf(t.basePdfUrl).catch(() => null);
  }
  const out: SamplePreview[] = [];
  for (const { kind, cand } of picked) {
    const values = cand.values as MergeValues;
    const preflight = await preflightDocument(t, { values, recipient: cand.recipient ?? null, batch: { amounts }, now: opts.now }, { base });
    const merged = renderMergeHtml(t.body, values, { highlight: true });
    out.push({
      kind,
      key: cand.key,
      label: cand.label,
      preflight,
      html: t.body ? merged.html : null,
      pdfDataUrl: await firstPagePdf(merchantId, t, values, base),
      missing: merged.missing,
    });
  }
  return out;
}

/** 서식 등록·수정 화면 "점검": 가상의 긴 표본 값으로 점검·미리보기(저장·발송하지 않음). */
export async function previewTemplateWithStress(merchantId: string, templateId: string): Promise<SamplePreview | null> {
  const t = await prisma.documentTemplate.findFirst({ where: { id: templateId, merchantId } });
  if (!t) return null;
  const values = stressSampleValues();
  const [p] = await previewSamples(merchantId, t, [{ key: 'stress', label: '가상의 긴 표본', values, recipient: { hasContact: true } }]);
  return p ?? null;
}

/** 용도별 서식 화면 "발송 전 점검": 그 기관 최근 후원자들로 표본을 만든다(저장·발송 없음). */
export async function previewPurposeTemplate(merchantId: string, templateId: string): Promise<{ samples: SamplePreview[]; total: number } | null> {
  const t = await prisma.documentTemplate.findFirst({ where: { id: templateId, merchantId, archivedAt: null } });
  if (!t) return null;
  const m = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { displayName: true, representativeName: true } });
  const links = await prisma.payerMerchantLink.findMany({
    where: { merchantId },
    orderBy: { lastDonatedAt: 'desc' },
    take: 50,
    select: { payerId: true, totalAmount: true, totalCount: true, payer: { select: { displayName: true, phoneMasked: true } } },
  });
  const { mergeValuesFromContext } = await import('./purpose-templates');
  const cands: SampleInput[] = await Promise.all(
    links.map(async (l) => ({
      key: l.payerId,
      label: l.payer.displayName ? `${l.payer.displayName} (${l.payer.phoneMasked})` : l.payer.phoneMasked,
      values: mergeValuesFromContext(
        { donorName: l.payer.displayName ?? null, amount: null, totalAmount: l.totalAmount, count: l.totalCount },
        { merchantName: m.displayName, representative: m.representativeName ?? null },
      ),
      recipient: await recipientFor(merchantId, l.payerId),
    })),
  );
  if (!cands.length) {
    // 후원자가 아직 없으면 가상 표본으로만 보여 준다.
    const p = await previewTemplateWithStress(merchantId, templateId);
    return { samples: p ? [p] : [], total: 0 };
  }
  return { samples: await previewSamples(merchantId, t, cands), total: cands.length };
}
