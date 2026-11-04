'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { requireMerchant, writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { decrypt, generateToken, tokenHash } from '@/lib/crypto';
import { addDays, formatKst } from '@/lib/datetime';
import { sendMt } from '@/server/services/charge-flow';
import { tplDocumentRequest } from '@/server/services/mt-templates';
import {
  DOCUMENT_BODY_MAX, DOCUMENT_LINK_TTL_DAYS, MAX_DOCUMENT_FIELDS, MAX_DOCUMENT_TEMPLATES,
  documentUrl, fieldsToStorage, parseDocumentFieldsJson, presetOf, readValues,
} from '@/server/services/documents';
import { Prisma } from '@/generated/prisma/client';
import type { DocumentTemplateType } from '@/generated/prisma/enums';
import type { StudioActionState } from '@/app/actions/studio';
import {
  MEDIA_PDF_RE, layoutProblem, renderAndStore, saveTemplateLayout, verifyBasePdf, verifyBasePdfToken,
  type SaveLayoutResult,
} from '@/server/services/pdf-form';
import { parsePdfLayout, type PdfLayout } from '@/lib/pdf-form';

/**
 * 문서 상품 — 사회복지기관 관리자 서버 액션.
 *
 * 공통 규칙은 studio.ts 와 같다.
 *  - requireMerchant() 로 권한을 확인한다.
 *  - 대상 레코드의 merchantId 가 본인 것인지 반드시 재검증한 뒤에만 변경한다.
 *  - 후원자가 적어 넣은 원문(제출 내용·연락처)은 열람 액션에서만 돌려주고 감사로그를 남긴다.
 */

type Handler = (merchantId: string, userId: string) => Promise<StudioActionState>;

async function withMerchant(fn: Handler): Promise<StudioActionState> {
  let merchantId: string;
  let userId: string;
  try {
    const user = await requireMerchant();
    merchantId = user.merchantId;
    userId = user.id;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '사회복지기관 권한이 필요합니다.' };
  }
  try {
    return await fn(merchantId, userId);
  } catch (e) {
    const message = (e as Error)?.message ?? '';
    const internal =
      !message || /prisma|invocation|decrypt|ECONNREFUSED|ETIMEDOUT/i.test(message) || !/[가-힣]/.test(message);
    if (internal) {
      logger.error('문서 액션 처리 오류', { message });
      return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
    }
    return { ok: false, message };
  }
}

function text(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function checked(formData: FormData, key: string): boolean {
  return formData.get(key) != null;
}

function revalidateDocuments(id?: string) {
  revalidatePath('/studio/documents');
  if (id) revalidatePath(`/studio/documents/${id}`);
  // 상품 등록 화면의 서식 드롭다운도 함께 갱신한다.
  revalidatePath('/studio/products');
}

/**
 * 업로드한 서식 파일 주소를 검증한다.
 *
 * 무검증으로 저장하면 후원자 화면의 내려받기 링크가 제3자 도메인을 가리키게 되어
 * 그 화면을 여는 모든 후원자의 IP·UA 가 새어 나가고, javascript: 같은 스킴도 그대로 남는다.
 */
function safeFileUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  // 자체 업로드 경로
  if (value.startsWith('/api/media/') && !value.includes('..')) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('서식 파일 주소 형식이 올바르지 않습니다. 파일을 다시 올려 주세요.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('서식 파일 주소는 https 만 쓸 수 있습니다.');
  }
  return url.toString();
}

// ===========================================================================
// 서식 등록 · 수정
// ===========================================================================

interface ParsedTemplate {
  name: string;
  description: string | null;
  templateType: DocumentTemplateType;
  body: string | null;
  fields: Prisma.InputJsonValue | typeof Prisma.DbNull;
  fileUrl: string | null;
  fileName: string | null;
  presetKey: string | null;
  requireSignature: boolean;
  active: boolean;
  /** FILE 서식의 편집 바탕 PDF 주소(브라우저가 보낸 값). 저장 전에 서버가 다시 확인한다. */
  basePdfUrl: string | null;
  baseConvertedFrom: string | null;
  /** 업로드 응답의 서명 토큰(이 기관이 올린 바탕 PDF 인지 확인) */
  baseToken: string;
  /** 원본 위 편집 기록. null 이면 폼에 편집기가 없었다(기존 기록 유지). */
  pdfLayout: PdfLayout | null;
}

function parseTemplateForm(
  formData: FormData,
): { ok: false; message: string } | { ok: true; data: ParsedTemplate } {
  const typeRaw = text(formData, 'templateType').toUpperCase();
  if (typeRaw !== 'EDITOR' && typeRaw !== 'FILE' && typeRaw !== 'PRESET') {
    return { ok: false, message: '서식을 만드는 방법을 골라 주세요.' };
  }
  const templateType = typeRaw as DocumentTemplateType;

  const name = text(formData, 'name').slice(0, 60);
  if (!name) return { ok: false, message: '서식 이름을 입력해 주세요. (예: 후원약정서)' };

  const description = text(formData, 'description').slice(0, 200) || null;
  let body = text(formData, 'body').slice(0, DOCUMENT_BODY_MAX) || null;
  let fields = parseDocumentFieldsJson(text(formData, 'fieldsJson'));
  let presetKey: string | null = null;
  let fileUrl: string | null = null;
  let fileName: string | null = null;
  let basePdfUrl: string | null = null;
  let baseConvertedFrom: string | null = null;
  let pdfLayout: PdfLayout | null = null;

  if (templateType === 'PRESET') {
    presetKey = text(formData, 'presetKey');
    const preset = presetOf(presetKey);
    if (!preset) return { ok: false, message: '기본 서식을 골라 주세요.' };
    // 화면에서 손보지 않았으면 기본 서식 내용을 그대로 쓴다.
    if (!body) body = preset.body;
    if (fields.length === 0) fields = preset.fields;
  }

  if (templateType === 'EDITOR') {
    if (!body || body.length < 10) {
      return { ok: false, message: '문서 본문을 10자 이상 입력해 주세요. 후원자가 이 내용을 읽고 작성합니다.' };
    }
  }

  if (templateType === 'FILE') {
    fileUrl = safeFileUrl(text(formData, 'fileUrl'));
    if (!fileUrl) {
      return { ok: false, message: '서식 파일(PDF·워드)을 올려 주세요.' };
    }
    fileName = text(formData, 'fileName').slice(0, 120) || '문서서식';
    const base = text(formData, 'basePdfUrl');
    basePdfUrl = MEDIA_PDF_RE.test(base) ? base : null;
    const from = text(formData, 'baseConvertedFrom');
    baseConvertedFrom = ['none', 'image', 'office'].includes(from) ? from : null;
    // 편집기의 기록은 길 수 있어 text() 의 길이 제한을 거치지 않고 읽는다.
    const rawLayout = formData.get('pdfLayoutJson');
    if (typeof rawLayout === 'string' && rawLayout.trim()) {
      if (rawLayout.length > 512 * 1024) return { ok: false, message: '원본 위 수정 내용이 너무 큽니다.' };
      pdfLayout = parsePdfLayout(rawLayout);
      if (!pdfLayout) return { ok: false, message: '원본 위 수정 내용을 읽지 못했습니다. 화면을 새로 고쳐 주세요.' };
    }
  }

  if (fields.length > MAX_DOCUMENT_FIELDS) {
    return { ok: false, message: `입력 항목은 최대 ${MAX_DOCUMENT_FIELDS}개까지 만들 수 있습니다.` };
  }

  // 파일 서식은 후원자가 내려받아 손으로 쓴다. 화면 입력 항목이 없어도 된다.
  if (templateType !== 'FILE' && fields.length === 0) {
    return {
      ok: false,
      message: '후원자가 채울 입력 항목을 1개 이상 만들어 주세요. (성명 · 연락처 등)',
    };
  }

  return {
    ok: true,
    data: {
      name,
      description,
      templateType,
      body,
      fields:
        fields.length > 0 ? (fieldsToStorage(fields) as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      fileUrl,
      fileName,
      presetKey,
      requireSignature: checked(formData, 'requireSignature'),
      // 체크박스는 해제하면 FormData 에 담기지 않는다. 짝이 되는 hidden 으로 구분한다.
      active: formData.has('activePresent') ? checked(formData, 'active') : true,
      basePdfUrl,
      baseConvertedFrom,
      baseToken: text(formData, 'baseToken'),
      pdfLayout,
    },
  };
}

/**
 * 파일 서식의 바탕 PDF·원본 위 편집을 DB 값으로 만든다.
 *
 *  - 바탕 PDF 가 바뀌면(새로 올림) 업로드 서명 토큰으로 이 기관이 올린 파일인지 확인하고,
 *    해시·쪽수는 저장소의 파일을 서버가 직접 읽어 정한다(브라우저 값은 믿지 않는다).
 *  - 편집 기록이 함께 왔으면 결과 PDF 를 새 파일로 만든다. 저장된 기록과 같으면 다시 만들지 않는다.
 *  - 바탕이 바뀌었는데 편집 기록이 없으면 이전 기록은 자리가 맞지 않으므로 비운다.
 */
type PdfApply =
  | { ok: false; message: string }
  | {
      ok: true;
      data: Record<string, unknown>;
      summary: { edits: number; fallback: number; stripped: number; coverOnlyPages: number[] } | null;
      cleared: boolean;
    };

async function applyPdf(
  merchantId: string,
  current: { basePdfUrl: string | null; pdfLayout: unknown } | null,
  parsed: ParsedTemplate,
): Promise<PdfApply> {
  const none = { ok: true as const, data: {}, summary: null, cleared: false };
  if (parsed.templateType !== 'FILE') return none;

  const url = parsed.basePdfUrl;
  const baseChanged = url !== (current?.basePdfUrl ?? null);
  const data: Record<string, unknown> = {};
  let pageCount: number | null = null;

  if (baseChanged) {
    if (!url) {
      return {
        ok: true,
        data: {
          basePdfUrl: null, basePdfHash: null, baseConvertedFrom: null, pdfPageCount: null,
          pdfLayout: Prisma.DbNull, renderedPdfUrl: null, renderedPdfHash: null, pdfEditedAt: null,
        },
        summary: null,
        cleared: !!current?.pdfLayout,
      };
    }
    if (!verifyBasePdfToken(merchantId, url, parsed.baseToken)) {
      return { ok: false, message: '올린 서식 파일을 확인하지 못했습니다. 파일을 다시 올려 주세요.' };
    }
    const v = await verifyBasePdf(url);
    if (!v) return { ok: false, message: '올린 서식 파일을 읽지 못했습니다. 파일을 다시 올려 주세요.' };
    Object.assign(data, {
      basePdfUrl: url,
      basePdfHash: v.hash,
      baseConvertedFrom: parsed.baseConvertedFrom ?? 'none',
      pdfPageCount: v.pageCount,
    });
    pageCount = v.pageCount;
  } else if (url) {
    pageCount = (await verifyBasePdf(url))?.pageCount ?? null;
  }

  const layout = parsed.pdfLayout;
  if (!url || (!layout && !baseChanged)) return { ok: true, data, summary: null, cleared: false };
  if (!layout) {
    // 새 파일을 올렸는데 편집 기록이 없으면 이전 기록을 비운다.
    Object.assign(data, { pdfLayout: Prisma.DbNull, renderedPdfUrl: null, renderedPdfHash: null, pdfEditedAt: null });
    return { ok: true, data, summary: null, cleared: !!current?.pdfLayout };
  }
  const problem = layoutProblem(layout, pageCount);
  if (problem) return { ok: false, message: problem };
  if (!baseChanged && JSON.stringify(parsePdfLayout(current?.pdfLayout) ?? null) === JSON.stringify(layout)) {
    return { ok: true, data, summary: null, cleared: false };
  }
  const rendered = await renderAndStore(url, layout);
  if (!rendered.ok) return rendered;
  Object.assign(data, {
    pdfLayout: layout as unknown as Prisma.InputJsonValue,
    renderedPdfUrl: rendered.file?.url ?? null,
    renderedPdfHash: rendered.file?.hash ?? null,
    pdfEditedAt: new Date(),
  });
  return {
    ok: true,
    data,
    cleared: false,
    summary: {
      edits: layout.edits.length,
      fallback: rendered.file?.report.filter((r) => r.tier === 'FALLBACK').length ?? 0,
      stripped: rendered.file?.stripped ?? 0,
      coverOnlyPages: rendered.file?.coverOnlyPages ?? [],
    },
  };
}

function pdfSummaryText(summary: { edits: number; fallback: number } | null): string {
  if (!summary) return '';
  if (summary.edits === 0) return ' 원본 서식 그대로 씁니다.';
  return (
    ` 원본 위 수정 ${summary.edits}곳을 반영했습니다.` +
    (summary.fallback ? ` (${summary.fallback}곳은 원본 글꼴에 없는 글자가 있어 같은 계열 글꼴로 넣었습니다)` : '')
  );
}

async function auditPdfEdit(userId: string, merchantId: string, templateId: string, summary: { edits: number; fallback: number } | null) {
  if (!summary) return;
  await writeAudit({
    adminUserId: userId,
    action: 'DOCUMENT_TEMPLATE_PDF_EDIT',
    targetType: 'document_template',
    targetId: templateId,
    after: { by: 'merchant', merchantId, userId, edits: summary.edits, fallback: summary.fallback },
  }).catch((err) => logger.warn('[documents] 원본 편집 감사로그 실패', { err: String(err) }));
}

function templateData(parsed: ParsedTemplate) {
  const {
    basePdfUrl: _b, baseConvertedFrom: _c, baseToken: _t, pdfLayout: _l, templateType: _y, ...rest
  } = parsed;
  return rest;
}

export async function createDocumentTemplateAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const parsed = parseTemplateForm(formData);
    if (!parsed.ok) return { ok: false, message: parsed.message };

    const count = await prisma.documentTemplate.count({ where: { merchantId, archivedAt: null } });
    if (count >= MAX_DOCUMENT_TEMPLATES) {
      return { ok: false, message: `서식은 최대 ${MAX_DOCUMENT_TEMPLATES}개까지 등록할 수 있습니다.` };
    }

    // 같은 이름이 둘이면 상품에 서식을 연결할 때 어느 것인지 알 수 없다.
    const dup = await prisma.documentTemplate.findFirst({
      where: { merchantId, name: parsed.data.name, archivedAt: null },
      select: { id: true },
    });
    if (dup) return { ok: false, message: '같은 이름의 서식이 이미 있습니다.' };

    const pdf = await applyPdf(merchantId, null, parsed.data);
    if (!pdf.ok) return { ok: false, message: pdf.message };

    const created = await prisma.documentTemplate.create({
      data: { id: newId(), merchantId, templateType: parsed.data.templateType, ...templateData(parsed.data), ...pdf.data },
      select: { id: true, name: true },
    });
    await auditPdfEdit(userId, merchantId, created.id, pdf.summary);
    revalidateDocuments();
    return {
      ok: true,
      message: `${created.name} 서식을 등록했습니다.${pdfSummaryText(pdf.summary)} 이제 후원 항목 관리·서명 요청에서 쓸 수 있습니다.`,
      redirectTo: `/studio/documents/${created.id}`,
    };
  });
}

export async function updateDocumentTemplateAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = text(formData, 'templateId');
    if (!id) return { ok: false, message: '서식을 찾을 수 없습니다.' };

    const current = await prisma.documentTemplate.findFirst({
      where: { id, merchantId, archivedAt: null },
      select: { id: true, templateType: true, basePdfUrl: true, pdfLayout: true },
    });
    if (!current) return { ok: false, message: '서식을 찾을 수 없습니다.' };

    // 만드는 방법은 등록 후 바꿀 수 없다. 이미 발송된 작성 링크가 다른 화면을 그리게 되면
    // 후원자는 결제한 상품과 다른 문서를 보게 된다.
    formData.set('templateType', current.templateType);
    const parsed = parseTemplateForm(formData);
    if (!parsed.ok) return { ok: false, message: parsed.message };

    const dup = await prisma.documentTemplate.findFirst({
      where: { merchantId, name: parsed.data.name, archivedAt: null, id: { not: id } },
      select: { id: true },
    });
    if (dup) return { ok: false, message: '같은 이름의 서식이 이미 있습니다.' };

    const pdf = await applyPdf(merchantId, current, parsed.data);
    if (!pdf.ok) return { ok: false, message: pdf.message };

    await prisma.documentTemplate.update({ where: { id }, data: { ...templateData(parsed.data), ...pdf.data } });
    await auditPdfEdit(userId, merchantId, id, pdf.summary);

    // 이미 제출된 문서는 그대로 남는다(저장 당시 값을 근거로 남겨야 한다).
    const submitted = await prisma.documentSubmission.count({
      where: { templateId: id, status: { in: ['SUBMITTED', 'REVIEWED'] } },
    });
    revalidateDocuments(id);
    revalidatePath(`/studio/documents/${id}/edit`);
    return {
      ok: true,
      message:
        (submitted > 0
          ? `서식을 저장했습니다. 이미 제출된 ${submitted}건은 제출 당시 내용 그대로 남습니다.`
          : '서식을 저장했습니다.') +
        pdfSummaryText(pdf.summary) +
        (pdf.cleared ? ' 원본 파일이 바뀌어 이전 원본 위 수정 내용을 비웠습니다.' : ''),
    };
  });
}

export async function toggleDocumentTemplateActiveAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'templateId');
    const current = await prisma.documentTemplate.findFirst({
      where: { id, merchantId, archivedAt: null },
      select: { id: true, name: true, active: true },
    });
    if (!current) return { ok: false, message: '서식을 찾을 수 없습니다.' };

    await prisma.documentTemplate.update({ where: { id }, data: { active: !current.active } });
    revalidateDocuments(id);
    return {
      ok: true,
      message: current.active
        ? `${current.name} 을(를) 사용하지 않도록 바꿨습니다. 이 서식을 쓰는 상품은 결제 화면에서 고를 수 없습니다.`
        : `${current.name} 을(를) 다시 사용합니다.`,
    };
  });
}

/** 서식 보관(소프트 삭제). 지난 제출 기록이 참조하므로 실제로 지우지 않는다. */
export async function archiveDocumentTemplateAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'templateId');
    const current = await prisma.documentTemplate.findFirst({
      where: { id, merchantId, archivedAt: null },
      select: { id: true, name: true },
    });
    if (!current) return { ok: false, message: '서식을 찾을 수 없습니다.' };

    // 상품이 아직 이 서식을 쓰고 있으면 보관할 수 없다. 보관해 버리면 그 상품을 결제한
    // 후원자에게 작성 화면을 그려 줄 수 없다.
    const used = await prisma.chargeProduct.count({
      where: { merchantId, documentTemplateId: id, archivedAt: null },
    });
    if (used > 0) {
      return {
        ok: false,
        message: `이 서식을 쓰는 상품이 ${used}개 있습니다. 상품에서 다른 서식으로 바꾸거나 상품을 먼저 보관해 주세요.`,
      };
    }

    // 아직 작성하지 않은(DRAFT) 문서가 남아 있으면 그 후원자는 작성할 곳을 잃는다.
    const pending = await prisma.documentSubmission.count({ where: { templateId: id, status: 'DRAFT' } });
    if (pending > 0) {
      return {
        ok: false,
        message: `아직 작성하지 않은 문서가 ${pending}건 있습니다. 후원자가 작성을 마친 뒤 보관해 주세요.`,
      };
    }

    await prisma.documentTemplate.update({
      where: { id },
      data: { archivedAt: new Date(), active: false },
    });
    revalidateDocuments();
    return {
      ok: true,
      message: `${current.name} 서식을 보관했습니다. 제출된 문서는 그대로 남습니다.`,
      redirectTo: '/studio/documents',
    };
  });
}

export async function restoreDocumentTemplateAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'templateId');
    const current = await prisma.documentTemplate.findFirst({
      where: { id, merchantId, archivedAt: { not: null } },
      select: { id: true, name: true },
    });
    if (!current) return { ok: false, message: '보관된 서식을 찾을 수 없습니다.' };

    // 되살린 서식은 꺼진 상태로 돌아온다. 값을 확인한 뒤 켜게 한다.
    await prisma.documentTemplate.update({ where: { id }, data: { archivedAt: null, active: false } });
    revalidateDocuments(id);
    return { ok: true, message: `${current.name} 서식을 되살렸습니다. 내용을 확인한 뒤 사용을 켜 주세요.` };
  });
}

// ===========================================================================
// 제출 문서 처리
// ===========================================================================

export async function markDocumentReviewedAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'submissionId');
    const row = await prisma.documentSubmission.findFirst({
      where: { id, merchantId },
      select: { id: true, status: true },
    });
    if (!row) return { ok: false, message: '제출 문서를 찾을 수 없습니다.' };
    if (row.status === 'DRAFT') return { ok: false, message: '아직 제출되지 않은 문서입니다.' };
    if (row.status === 'REVIEWED') return { ok: false, message: '이미 확인한 문서입니다.' };

    await prisma.documentSubmission.update({
      where: { id },
      data: { status: 'REVIEWED', reviewedAt: new Date() },
    });
    revalidatePath('/studio/documents');
    revalidatePath(`/studio/documents/submissions/${id}`);
    return { ok: true, message: '확인 완료로 표시했습니다.' };
  });
}

export async function saveDocumentMemoAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'submissionId');
    const memo = text(formData, 'merchantMemo').slice(0, 500);
    const row = await prisma.documentSubmission.findFirst({ where: { id, merchantId }, select: { id: true } });
    if (!row) return { ok: false, message: '제출 문서를 찾을 수 없습니다.' };

    await prisma.documentSubmission.update({ where: { id }, data: { merchantMemo: memo || null } });
    revalidatePath(`/studio/documents/submissions/${id}`);
    return { ok: true, message: '메모를 저장했습니다.' };
  });
}

/**
 * 작성 링크 재발송.
 *
 * 토큰은 해시만 저장하므로 예전 링크를 다시 만들 수는 없다. 새 토큰으로 갈아 끼우고
 * 문자를 다시 보낸다(예전 링크는 그 순간 무효가 된다 — 같은 문서로 두 경로가 열려 있으면
 * 어느 쪽이 제출됐는지 추적할 수 없다).
 */
export async function resendDocumentLinkAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = text(formData, 'submissionId');
    const row = await prisma.documentSubmission.findFirst({
      where: { id, merchantId },
      select: {
        id: true,
        status: true,
        payerPhoneEnc: true,
        chargeId: true,
        template: { select: { name: true, active: true, archivedAt: true } },
        merchant: { select: { displayName: true } },
      },
    });
    if (!row) return { ok: false, message: '제출 문서를 찾을 수 없습니다.' };
    if (row.status !== 'DRAFT') return { ok: false, message: '이미 제출된 문서입니다.' };
    if (!row.payerPhoneEnc) {
      return { ok: false, message: '후원자 연락처가 없어 문자를 보낼 수 없습니다. 고객센터로 문의해 주세요.' };
    }
    if (row.template.archivedAt || !row.template.active) {
      return { ok: false, message: '서식이 보관·중지 상태입니다. 서식을 먼저 사용 상태로 바꿔 주세요.' };
    }

    const token = generateToken(32);
    const expiresAt = addDays(new Date(), DOCUMENT_LINK_TTL_DAYS);
    await prisma.documentSubmission.update({
      where: { id },
      data: { tokenHash: tokenHash(token), expiresAt },
    });

    const sent = await sendMt({
      phone: decrypt(row.payerPhoneEnc),
      template: tplDocumentRequest({
        merchantName: row.merchant.displayName,
        documentName: row.template.name,
        link: documentUrl(token),
        ttlDays: DOCUMENT_LINK_TTL_DAYS,
      }),
      chargeId: row.chargeId ?? undefined,
      merchantId,
    });

    await writeAudit({
      adminUserId: userId,
      action: 'DOCUMENT_LINK_RESEND',
      targetType: 'document_submission',
      targetId: id,
      after: { by: 'merchant', merchantId, userId, sent },
    });

    revalidatePath(`/studio/documents/submissions/${id}`);
    return sent
      ? { ok: true, message: `작성 링크를 다시 보냈습니다. ${formatKst(expiresAt, false)} 까지 쓸 수 있습니다.` }
      : { ok: false, message: '문자 발송에 실패했습니다. 잠시 후 다시 시도해 주세요. (링크는 새로 발급되었습니다)' };
  });
}

/**
 * 제출 원문 열람.
 *
 * 성명·연락처·입력값은 개인정보다. 목록에서 자동으로 복호화하지 않고, 이 액션으로
 * 열 때마다 감사로그(DOCUMENT_SUBMISSION_VIEW)를 남긴다. 배송지 열람과 같은 기준이다.
 */
export async function revealDocumentSubmissionAction(
  submissionId: string,
): Promise<
  | {
      ok: true;
      payerName: string | null;
      payerPhone: string | null;
      values: Array<{ id: string; value: string }>;
    }
  | { ok: false; message: string }
> {
  let merchantId: string;
  let userId: string;
  try {
    const user = await requireMerchant();
    merchantId = user.merchantId;
    userId = user.id;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '사회복지기관 권한이 필요합니다.' };
  }

  try {
    const row = await prisma.documentSubmission.findFirst({
      where: { id: submissionId, merchantId },
      select: {
        id: true,
        status: true,
        payerNameEnc: true,
        payerPhoneEnc: true,
        valuesEnc: true,
        charge: { select: { transactionNo: true } },
      },
    });
    if (!row) return { ok: false, message: '제출 문서를 찾을 수 없습니다.' };
    if (row.status === 'DRAFT') return { ok: false, message: '아직 제출되지 않은 문서입니다.' };

    await writeAudit({
      adminUserId: userId,
      action: 'DOCUMENT_SUBMISSION_VIEW',
      targetType: 'document_submission',
      targetId: row.id,
      // writeAudit 은 관리자 프로필이 없는 주체를 adminId 에 남기지 못한다.
      // 사회복지기관 담당자가 여럿이면 "어느 사회복지기관" 까지만 남아 추적이 불가능하므로 계정을 함께 남긴다.
      after: { transactionNo: row.charge?.transactionNo ?? null, by: 'merchant', merchantId, userId },
    });

    const values = readValues(row.valuesEnc);
    return {
      ok: true,
      payerName: row.payerNameEnc ? decrypt(row.payerNameEnc) : null,
      payerPhone: row.payerPhoneEnc ? decrypt(row.payerPhoneEnc) : null,
      values: Object.entries(values).map(([id, value]) => ({ id, value })),
    };
  } catch (e) {
    logger.error('문서 제출 원문 열람 실패', { submissionId, message: (e as Error).message });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

// ===========================================================================
// 원본 위에서 고치기 (FILE 서식)
// ===========================================================================

export type SavePdfLayoutState = SaveLayoutResult | { ok: false; message: string };

/**
 * 원본 편집 저장. 편집기(클라이언트)가 직접 부른다.
 * 결과 PDF 는 새 파일로 남고, 이미 발송된 서명 요청은 발송 당시 파일을 그대로 가리킨다.
 */
export async function saveDocumentPdfLayoutAction(templateId: string, layoutJson: string): Promise<SavePdfLayoutState> {
  let merchantId: string;
  let userId: string;
  try {
    const user = await requireMerchant();
    merchantId = user.merchantId;
    userId = user.id;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '사회복지기관 권한이 필요합니다.' };
  }
  if (typeof layoutJson !== 'string' || layoutJson.length > 512 * 1024) {
    return { ok: false, message: '편집 내용이 너무 큽니다.' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(layoutJson);
  } catch {
    return { ok: false, message: '편집 내용 형식이 올바르지 않습니다.' };
  }

  try {
    const res = await saveTemplateLayout(merchantId, templateId, raw);
    if (!res.ok) return res;
    await writeAudit({
      adminUserId: userId,
      action: 'DOCUMENT_TEMPLATE_PDF_EDIT',
      targetType: 'document_template',
      targetId: templateId,
      after: {
        by: 'merchant', merchantId, userId,
        edits: res.edits,
        renderedPdfUrl: res.renderedPdfUrl,
        fallback: res.report.filter((r) => r.tier === 'FALLBACK').length,
      },
    }).catch((err) => logger.warn('[documents] 원본 편집 감사로그 실패', { err: String(err) }));
    revalidateDocuments(templateId);
    revalidatePath(`/studio/documents/${templateId}/edit`);
    return res;
  } catch (err) {
    logger.error('[documents] 원본 편집 저장 실패', { templateId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, message: '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
