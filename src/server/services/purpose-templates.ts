import { createHash } from 'node:crypto';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { formatNumber } from '@/lib/money';
import { kstDateKey } from '@/lib/datetime';
import { renderMergeText, type MergeResult, type MergeValues } from '@/lib/merge-fields';
import { DOCUMENT_PRESETS, fieldsToStorage, presetForPurpose } from './documents';
import { DOCUMENT_PURPOSES, DOCUMENT_PURPOSE_LABEL, type DocumentPurpose, type MergeContext } from './purpose-documents';
import type { DocumentTemplate } from '@/generated/prisma/client';

/**
 * 용도별 자동 발송 서식 — 기본 세트 제공·서식 고르기·머지 값.
 *
 *  - 기관×용도마다 보관 전 서식은 1개다(document_template_merchant_purpose_one 부분 유니크 인덱스).
 *  - 그 용도 서식이 없으면 기본 세트(DOCUMENT_PRESETS 의 purpose)를 기관 PRESET 서식으로 복사한다. 멱등이고
 *    동시에 불러도 인덱스가 두 번째 행을 막는다(P2002 는 "이미 있다" 로 본다).
 *  - 기관 승인 시점과 issuePurposeDocument 첫 호출 때 부른다. 운영 시드에는 넣지 않는다.
 *  - 이 파일은 시드에서도 쓰므로 무거운 모듈(전자문서·문자)을 가져오지 않는다.
 */

/** 서명을 받아야 하는 용도(전자문서 센터 봉투로 보낸다). 나머지는 열람 링크로 보낸다. */
export const SIGNATURE_PURPOSES: readonly DocumentPurpose[] = ['SUPPORT_AGREEMENT', 'VOLUNTEER_APPLICATION', 'RECURRING_CHANGE'];

export function purposeNeedsSignature(purpose: DocumentPurpose): boolean {
  return SIGNATURE_PURPOSES.includes(purpose);
}

export function isDocumentPurpose(v: unknown): v is DocumentPurpose {
  return typeof v === 'string' && (DOCUMENT_PURPOSES as readonly string[]).includes(v);
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}

/**
 * 그 기관에 용도 서식이 없으면 기본 세트에서 만든다. 만든 용도 목록을 돌려준다.
 *
 *  - 이미 보관 전 서식이 그 용도를 쥐고 있으면 아무것도 하지 않는다(중지·자동 발송 끔도 기관의 선택이다).
 *  - 같은 기본 서식(presetKey)에서 만든 용도 없는 서식이 있으면 새로 만들지 않고 그 서식에 용도를 붙인다
 *    (이 기능 이전에 기관이 등록해 둔 약정서·신청서를 그대로 쓰게).
 *  - 이름이 겹치면 "(자동 발송)" 을 붙인다(서식 이름은 기관 안에서 겹치지 않게 관리한다).
 */
export async function ensureDefaultPurposeTemplates(
  merchantId: string,
  only?: DocumentPurpose[],
): Promise<DocumentPurpose[]> {
  const targets = (only ?? [...DOCUMENT_PURPOSES]).filter((p) => presetForPurpose(p));
  const existing = await prisma.documentTemplate.findMany({
    where: { merchantId, archivedAt: null },
    select: { id: true, name: true, purpose: true, presetKey: true },
  });
  const taken = new Set(existing.map((t) => t.purpose).filter(Boolean) as string[]);
  const names = new Set(existing.map((t) => t.name));
  const created: DocumentPurpose[] = [];

  for (const purpose of targets) {
    if (taken.has(purpose)) continue;
    const preset = presetForPurpose(purpose)!;
    try {
      const adopt = existing.find((t) => !t.purpose && t.presetKey === preset.key);
      if (adopt) {
        const r = await prisma.documentTemplate.updateMany({
          where: { id: adopt.id, purpose: null, archivedAt: null },
          data: { purpose },
        });
        if (r.count === 1) {
          created.push(purpose);
          continue;
        }
      }
      let name = preset.name;
      if (names.has(name)) name = `${preset.name} (자동 발송)`.slice(0, 60);
      await prisma.documentTemplate.create({
        data: {
          id: newId(),
          merchantId,
          name,
          description: preset.description,
          templateType: 'PRESET',
          presetKey: preset.key,
          body: preset.body,
          fields: preset.fields.length ? (fieldsToStorage(preset.fields) as object) : undefined,
          requireSignature: preset.requireSignature,
          purpose,
          autoSend: true,
          defaultSet: true,
          active: true,
        },
      });
      names.add(name);
      created.push(purpose);
    } catch (e) {
      // 동시에 다른 호출이 먼저 만들었다 — 이미 있으므로 그대로 둔다.
      if (isUniqueViolation(e)) continue;
      logger.error('기본 서식 제공 실패', { merchantId, purpose, message: (e as Error).message });
    }
  }
  return created;
}

/** 그 용도에 걸린 서식(보관 전). 없으면 기본 세트를 깔고 다시 찾는다. */
export async function resolvePurposeTemplate(merchantId: string, purpose: DocumentPurpose): Promise<DocumentTemplate | null> {
  const find = () => prisma.documentTemplate.findFirst({ where: { merchantId, purpose, archivedAt: null } });
  const found = await find();
  if (found) return found;
  await ensureDefaultPurposeTemplates(merchantId, [purpose]);
  return find();
}

/** 서식 판 확인값: 본문·항목·PDF 해시·편집 기록이 같으면 같은 값. */
export function templateRevision(t: Pick<DocumentTemplate, 'body' | 'fields' | 'renderedPdfHash' | 'basePdfHash' | 'pdfLayout' | 'name'>): string {
  const raw = JSON.stringify([t.name, t.body ?? '', t.fields ?? null, t.basePdfHash ?? '', t.renderedPdfHash ?? '', t.pdfLayout ?? null]);
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** 기관 정보에서 채우는 머지 값 */
export interface IssuerMerge {
  merchantName: string;
  representative: string | null;
}

function hours(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const v = Math.round(n * 10) / 10;
  return `${v}시간`;
}

/** MergeContext + 기관 정보 → 자리표시 값. 값이 없으면 null(빈칸). */
export function mergeValuesFromContext(ctx: MergeContext, issuer: IssuerMerge, issuedAt = new Date()): MergeValues {
  return {
    후원자명: ctx.donorName ?? null,
    금액: ctx.amount != null ? `${formatNumber(ctx.amount)}원` : null,
    누적금액: ctx.totalAmount != null ? `${formatNumber(ctx.totalAmount)}원` : null,
    횟수: ctx.count != null ? `${ctx.count}회` : null,
    날짜: ctx.date ?? null,
    캠페인: ctx.campaignTitle ?? null,
    기관명: issuer.merchantName,
    대표자: issuer.representative,
    발급일: kstDateKey(issuedAt),
    출금일: ctx.dayOfMonth != null ? String(ctx.dayOfMonth) : null,
    활동명: ctx.activityTitle ?? null,
    활동일: ctx.activityDate ?? null,
    활동시간: hours(ctx.activityHours),
    누적시간: hours(ctx.totalHours),
    귀속연도: ctx.taxYear != null ? String(ctx.taxYear) : null,
    영수증번호: ctx.receiptNo ?? null,
    배정: ctx.assignment ?? null,
    보고제목: ctx.reportTitle ?? null,
    보고내용: ctx.reportBody ?? null,
    참여내역: ctx.participation ?? null,
    사용요약: ctx.usageSummary ?? null,
  };
}

/** 서식 본문을 머지한다(EDITOR·PRESET 본문, FILE 의 작성 안내). */
export function renderTemplateBody(t: Pick<DocumentTemplate, 'body'>, values: MergeValues): MergeResult {
  return renderMergeText(t.body, values);
}

/** 기관 승인 시점에 부른다. 실패해도 승인 결과를 바꾸지 않는다(첫 발송 때 다시 시도된다). */
export async function provisionDefaultPurposeTemplatesSafe(merchantId: string) {
  try {
    return await ensureDefaultPurposeTemplates(merchantId);
  } catch (e) {
    logger.error('기본 서식 세트 제공 실패', { merchantId, message: (e as Error).message });
    return [];
  }
}

export interface PurposeStatusRow {
  purpose: DocumentPurpose;
  label: string;
  signature: boolean;
  template: { id: string; name: string; active: boolean; autoSend: boolean; defaultSet: boolean; unchanged: boolean; templateType: string } | null;
  /** 실제로 자동 발송되는지 */
  sending: boolean;
}

/** 용도별 현황(콘솔 서식 화면 상단) */
export async function purposeStatus(merchantId: string): Promise<PurposeStatusRow[]> {
  const rows = await prisma.documentTemplate.findMany({
    where: { merchantId, archivedAt: null, purpose: { not: null } },
    select: { id: true, name: true, purpose: true, active: true, autoSend: true, defaultSet: true, presetKey: true, body: true, templateType: true },
  });
  return DOCUMENT_PURPOSES.map((purpose) => {
    const t = rows.find((r) => r.purpose === purpose);
    const preset = presetForPurpose(purpose);
    return {
      purpose,
      label: DOCUMENT_PURPOSE_LABEL[purpose],
      signature: purposeNeedsSignature(purpose),
      template: t
        ? {
            id: t.id, name: t.name, active: t.active, autoSend: t.autoSend, defaultSet: t.defaultSet, templateType: t.templateType,
            unchanged: !!preset && t.presetKey === preset.key && (t.body ?? '') === preset.body,
          }
        : null,
      sending: !!t && t.active && t.autoSend,
    };
  });
}

export { DOCUMENT_PRESETS };
