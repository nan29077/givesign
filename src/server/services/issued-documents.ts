import { createHash } from 'node:crypto';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { addDays } from '@/lib/datetime';
import { decrypt, encrypt, generateToken, tokenHash } from '@/lib/crypto';
import { maskSensitive, type MergeValues } from '@/lib/merge-fields';
import { getPrivateObject } from '@/server/uploads';
import { tplDocumentIssued } from './mt-templates';
import { sendMtForPayer } from './charge-flow';
import {
  DOCUMENT_PURPOSE_LABEL,
  type DocumentPurpose,
  type IssuePurposeDocumentInput,
  type IssuePurposeDocumentResult,
} from './purpose-documents';
import {
  isDocumentPurpose, mergeValuesFromContext, purposeNeedsSignature, renderTemplateBody, resolvePurposeTemplate, templateRevision,
} from './purpose-templates';
import type { EDocSignerRole } from '@/generated/prisma/enums';
import type { IssuedDocument } from '@/generated/prisma/client';

/**
 * 용도별 자동 발송 문서 — issuePurposeDocument 구현과 발급 문서 열람·재발송·보관.
 *
 * 계약(인터페이스)은 purpose-documents.ts 에 있다. 저니 엔진·이벤트 소비자는 그 파일만 부른다.
 *
 *  - 서명이 필요 없는 용도: issued_document 행 + 열람 토큰(해시만 저장) → `/l/[토큰]` 링크를 문자(알림톡 → 문자 대체)로 보낸다.
 *  - 서명이 필요한 용도: 전자문서 센터 봉투(createEnvelope)로 서명을 받는다. 서명자 1명 = 후원자, 이용요금 차감 규칙 그대로.
 *    issued_document 행은 envelope_id 로 그 봉투를 가리킨다. 봉투가 끝나면 syncIssuedFromEnvelope 가 상태를 옮긴다.
 *  - 스냅샷은 머지 결과 본문·값(마스킹)·서식 판을 담아 암호화하고 SHA-256 을 남긴다.
 *  - dedupe_key 유니크 — 같은 발송은 한 번. 이미 있으면 { ok: true, already: true }.
 *  - 실패는 예외 대신 { ok: false } (사후 처리 실패가 업무를 막지 않는다). 안내 문자 실패는 발급을 되돌리지 않고 send_error 에 남긴다.
 */

/** 열람 링크 유효기간(일). 지나면 후원자 마이페이지(/my/documents)에서 다시 연다. */
export const ISSUED_DOCUMENT_LINK_TTL_DAYS = 30;

export const ISSUED_STATUS_LABEL: Record<string, { text: string; tone: 'neutral' | 'brand' | 'success' | 'danger' | 'warning' }> = {
  ISSUED: { text: '발급', tone: 'brand' },
  REQUESTED: { text: '서명 요청', tone: 'warning' },
  SIGNED: { text: '서명 완료', tone: 'success' },
  DECLINED: { text: '서명 거절', tone: 'danger' },
  EXPIRED: { text: '기한 만료', tone: 'neutral' },
  CANCELLED: { text: '발송 취소', tone: 'neutral' },
};

export function issuedDocumentUrl(token: string) {
  return `${env.baseUrl}/l/${token}`;
}

export interface IssuedSnapshot {
  v: 1;
  purpose: DocumentPurpose;
  title: string;
  templateId: string;
  templateRevision: string;
  templateType: string;
  /** 머지 결과 본문(값은 마스킹 규칙을 거친 것) */
  body: string;
  /** 쓰인 머지 값(마스킹) */
  values: Record<string, string | null>;
  missing: string[];
  issuer: { name: string; representative: string | null; code: string };
  pdf: { object: string; hash: string } | null;
  signature: boolean;
  issuedAt: string;
}

/** 키 순서를 고정한 JSON (해시 재계산용) */
function stable(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function issuedSnapshotHash(s: IssuedSnapshot): string {
  return createHash('sha256').update(stable(s)).digest('hex');
}

/** 스냅샷을 풀고 해시를 대조한다. 맞지 않으면 verified=false(화면은 사실대로 알린다). */
export function readIssuedSnapshot(row: Pick<IssuedDocument, 'id' | 'snapshotEnc' | 'contentHash'>): { snapshot: IssuedSnapshot | null; verified: boolean } {
  try {
    const snap = JSON.parse(decrypt(row.snapshotEnc)) as IssuedSnapshot;
    return { snapshot: snap, verified: issuedSnapshotHash(snap) === row.contentHash };
  } catch (e) {
    logger.error('발급 문서 스냅샷 확인 실패', { issuedId: row.id, message: (e as Error).message });
    return { snapshot: null, verified: false };
  }
}

function maskedValues(values: MergeValues): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(values)) {
    const s = v == null ? '' : String(v).trim();
    out[k] = s ? maskSensitive(s) : null;
  }
  return out;
}

/** dedupeKey 로 만든 봉투 id(26자리, createEnvelope nonce 형식). 같은 발송을 다시 불러도 같은 봉투다. */
export function envelopeNonceFor(dedupeKey: string): string {
  return createHash('sha256').update(`purpose-doc:${dedupeKey}`).digest('hex').slice(0, 26).toUpperCase();
}

function signerRoleFor(purpose: DocumentPurpose): EDocSignerRole {
  return purpose === 'VOLUNTEER_APPLICATION' ? 'VOLUNTEER' : 'DONOR';
}

interface IssuedBase {
  merchantId: string;
  payerId: string;
  purpose: string;
  templateId: string;
  templateRevision: string;
  title: string;
  snapshotEnc: string;
  contentHash: string;
  pdfObject: string | null;
  pdfHash: string | null;
  signature: boolean;
  missingFields: string[];
  dedupeKey: string;
  subjectType: string | null;
  subjectId: string | null;
}

function isUnique(e: unknown) {
  return (e as { code?: string })?.code === 'P2002';
}

async function alreadyIssued(dedupeKey: string): Promise<IssuePurposeDocumentResult | null> {
  const row = await prisma.issuedDocument.findUnique({ where: { dedupeKey }, select: { id: true, signature: true } });
  // 토큰 원문은 저장하지 않으므로 이미 보낸 발송의 링크는 돌려줄 수 없다(다시 보내지도 않는다).
  return row ? { ok: true, issuedId: row.id, link: null, already: true, signature: row.signature } : null;
}

export async function issuePurposeDocumentImpl(input: IssuePurposeDocumentInput): Promise<IssuePurposeDocumentResult> {
  try {
    return await issueInner(input);
  } catch (e) {
    logger.error('용도별 문서 발송 실패', { merchantId: input.merchantId, purpose: input.purpose, message: (e as Error).message });
    return { ok: false, reason: '문서를 만들지 못했습니다. 잠시 후 다시 시도합니다.' };
  }
}

async function issueInner(input: IssuePurposeDocumentInput): Promise<IssuePurposeDocumentResult> {
  if (!isDocumentPurpose(input.purpose)) return { ok: false, reason: '알 수 없는 문서 용도입니다.' };
  const dedupeKey = (input.dedupeKey ?? '').trim();
  if (!dedupeKey || dedupeKey.length > 200) return { ok: false, reason: '발송 키(dedupeKey)가 필요합니다.' };

  const done = await alreadyIssued(dedupeKey);
  if (done) return done;

  const purpose = input.purpose;
  const signature = purposeNeedsSignature(purpose);

  // 약정서 한 판에 서명 요청은 하나 — 같은 약정서(agreement_document)를 다른 키로 다시 불러도 새로 보내지 않는다.
  if (signature && input.subject?.type === 'agreement_document') {
    const prev = await prisma.issuedDocument.findFirst({
      where: { merchantId: input.merchantId, purpose, subjectType: 'agreement_document', subjectId: input.subject.id, archivedAt: null },
      select: { id: true },
    });
    if (prev) return { ok: true, issuedId: prev.id, link: null, already: true, signature };
  }

  const [payer, merchant] = await Promise.all([
    prisma.payerProfile.findUnique({ where: { id: input.payerId }, select: { id: true, displayName: true, phoneEnc: true, onboardingStatus: true } }),
    prisma.merchantProfile.findUnique({ where: { id: input.merchantId }, select: { id: true, code: true, displayName: true, representativeName: true, status: true } }),
  ]);
  if (!merchant) return { ok: false, reason: '기관을 찾을 수 없습니다.' };
  if (!payer) return { ok: false, reason: '후원자를 찾을 수 없습니다.' };
  if (payer.onboardingStatus === 'WITHDRAWN') return { ok: false, reason: '탈퇴한 후원자에게는 문서를 보내지 않습니다.', blocked: 'WITHDRAWN' };
  if (merchant.status !== 'APPROVED') return { ok: false, reason: '승인된 기관만 문서를 보낼 수 있습니다.', blocked: 'NOT_READY' };

  const template = await resolvePurposeTemplate(merchant.id, purpose);
  if (!template) return { ok: false, reason: `${DOCUMENT_PURPOSE_LABEL[purpose]} 서식이 없습니다.`, blocked: 'NO_TEMPLATE' };
  if (!template.active || !template.autoSend) {
    return { ok: false, reason: `기관이 ${DOCUMENT_PURPOSE_LABEL[purpose]} 자동 발송을 꺼 두었습니다.`, blocked: 'DISABLED' };
  }

  const now = new Date();
  const donorName = input.context.donorName ?? payer.displayName ?? null;
  const values = mergeValuesFromContext(
    { ...input.context, donorName },
    { merchantName: merchant.displayName, representative: merchant.representativeName ?? null },
    now,
  );
  const body = renderTemplateBody(template, values);
  const missing = [...body.missing];

  // 파일 서식: 편집 글자에 머지 값을 채운 새 PDF(원본 불변). 열람 문서는 비공개, 서명 봉투는 서명 화면이 읽는 공개 객체.
  let pdf: { object: string; hash: string; url: string | null } | null = null;
  if (template.templateType === 'FILE') {
    const { renderMergedTemplatePdf } = await import('./pdf-form');
    const merged = await renderMergedTemplatePdf(merchant.id, template, values, signature ? 'public' : 'private');
    if (!merged.ok) return { ok: false, reason: merged.message, blocked: 'NO_TEMPLATE' };
    pdf = { object: merged.pdf.objectName, hash: merged.pdf.hash, url: merged.pdf.url };
    for (const m of merged.pdf.missing) if (!missing.includes(m)) missing.push(m);
  }

  const snapshot: IssuedSnapshot = {
    v: 1,
    purpose,
    title: template.name,
    templateId: template.id,
    templateRevision: templateRevision(template),
    templateType: template.templateType,
    body: body.text,
    values: maskedValues(values),
    missing,
    issuer: { name: merchant.displayName, representative: merchant.representativeName ?? null, code: merchant.code },
    pdf: pdf ? { object: pdf.object, hash: pdf.hash } : null,
    signature,
    issuedAt: now.toISOString(),
  };
  const snapshotEnc = encrypt(JSON.stringify(snapshot));
  const contentHash = issuedSnapshotHash(snapshot);
  const base: IssuedBase = {
    merchantId: merchant.id,
    payerId: payer.id,
    purpose,
    templateId: template.id,
    templateRevision: snapshot.templateRevision,
    title: template.name,
    snapshotEnc,
    contentHash,
    pdfObject: pdf?.object ?? null,
    pdfHash: pdf?.hash ?? null,
    signature,
    missingFields: missing,
    dedupeKey,
    subjectType: input.subject?.type ?? null,
    subjectId: input.subject?.id ?? null,
  };

  if (signature) return issueForSignature(input, { base, template, payer, body: body.text, pdf });

  const token = generateToken(32);
  let issuedId: string;
  try {
    const row = await prisma.issuedDocument.create({
      data: { id: newId(), ...base, status: 'ISSUED', tokenHash: tokenHash(token), expiresAt: addDays(now, ISSUED_DOCUMENT_LINK_TTL_DAYS) },
      select: { id: true },
    });
    issuedId = row.id;
  } catch (e) {
    if (isUnique(e)) return (await alreadyIssued(dedupeKey)) ?? { ok: false, reason: '이미 처리 중인 발송입니다.' };
    throw e;
  }
  const link = issuedDocumentUrl(token);
  if (input.notify !== false) await sendIssuedNotice(issuedId, payer.id, merchant.id, merchant.displayName, template.name, link);
  return { ok: true, issuedId, link, signature: false };
}

async function issueForSignature(
  input: IssuePurposeDocumentInput,
  ctx: {
    base: IssuedBase;
    template: { id: string; name: string };
    payer: { id: string; displayName: string | null; phoneEnc: string };
    body: string;
    pdf: { object: string; hash: string; url: string | null } | null;
  },
): Promise<IssuePurposeDocumentResult> {
  const { createEnvelope, EDocError, EDOC_SYSTEM_ACTOR } = await import('./edoc');
  const { EDocBillingError } = await import('./edoc-billing');
  let phone: string;
  try {
    phone = decrypt(ctx.payer.phoneEnc);
  } catch {
    return { ok: false, reason: '후원자 연락처를 읽지 못했습니다.' };
  }
  const nonce = envelopeNonceFor(ctx.base.dedupeKey);
  let envelopeId: string;
  try {
    const r = await createEnvelope({
      merchantId: ctx.base.merchantId,
      actorId: EDOC_SYSTEM_ACTOR,
      nonce,
      templateId: ctx.template.id,
      title: ctx.template.name,
      signingOrder: 'PARALLEL',
      signers: [{ name: (input.context.donorName ?? ctx.payer.displayName ?? '후원자').slice(0, 30), phone, role: signerRoleFor(input.purpose) }],
      override: { body: ctx.body, ...(ctx.pdf ? { pdfUrl: ctx.pdf.url, pdfHash: ctx.pdf.hash } : {}) },
      deferSend: input.notify === false,
    });
    envelopeId = r.envelopeId;
  } catch (e) {
    if (e instanceof EDocBillingError) return { ok: false, reason: e.message, blocked: 'EDOC_BALANCE' };
    if (e instanceof EDocError) return { ok: false, reason: e.message };
    throw e;
  }
  try {
    const row = await prisma.issuedDocument.create({
      data: { id: newId(), ...ctx.base, status: 'REQUESTED', envelopeId, tokenHash: null, expiresAt: null, sentAt: input.notify === false ? null : new Date(), sendCount: input.notify === false ? 0 : 1 },
      select: { id: true },
    });
    return { ok: true, issuedId: row.id, link: null, signature: true };
  } catch (e) {
    if (isUnique(e)) return (await alreadyIssued(ctx.base.dedupeKey)) ?? { ok: false, reason: '이미 처리 중인 발송입니다.' };
    throw e;
  }
}

/** 안내 문자(알림톡 → 문자 대체). 실패는 발급을 되돌리지 않고 send_error 에 남긴다. */
async function sendIssuedNotice(issuedId: string, payerId: string, merchantId: string, merchantName: string, title: string, link: string) {
  let ok = false;
  let error: string | null = null;
  try {
    ok = await sendMtForPayer(payerId, tplDocumentIssued({ merchantName, title, link }), null, merchantId);
    if (!ok) error = '문자 발송 실패';
  } catch (e) {
    error = '문자 발송 오류';
    logger.warn('발급 문서 안내 실패', { issuedId, message: (e as Error).message });
  }
  await prisma.issuedDocument.update({
    where: { id: issuedId },
    data: ok ? { sentAt: new Date(), sendCount: { increment: 1 }, sendError: null } : { sendError: error },
  });
  return ok;
}

// ---------------------------------------------------------------- 열람

export type IssuedLoad =
  | { ok: true; row: IssuedDocument; snapshot: IssuedSnapshot; verified: boolean }
  | { ok: false; reason: string; expired?: boolean; merchantName?: string };

/** 공개 열람(/l/[토큰]). 토큰 해시로 찾고, 만료·보관·서명 문서는 열지 않는다. 열람하면 시각·횟수를 남긴다. */
export async function loadIssuedByToken(token: string, opts: { record?: boolean } = {}): Promise<IssuedLoad> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token ?? '')) return { ok: false, reason: '유효하지 않은 링크입니다.' };
  const row = await prisma.issuedDocument.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!row || row.signature) return { ok: false, reason: '유효하지 않은 링크입니다. 가장 최근에 받은 문자의 링크를 열어 주세요.' };
  const merchant = await prisma.merchantProfile.findUnique({ where: { id: row.merchantId }, select: { displayName: true } });
  if (row.archivedAt) return { ok: false, reason: '기관이 보관 처리한 문서입니다. 기관에 문의해 주세요.', merchantName: merchant?.displayName };
  if (row.expiresAt && row.expiresAt <= new Date()) {
    return { ok: false, expired: true, reason: '열람 기간이 지난 링크입니다.', merchantName: merchant?.displayName };
  }
  const { snapshot, verified } = readIssuedSnapshot(row);
  if (!snapshot) return { ok: false, reason: '문서를 읽지 못했습니다. 기관에 문의해 주세요.' };
  if (opts.record !== false) await recordView(row.id);
  return { ok: true, row, snapshot, verified };
}

async function recordView(id: string) {
  const now = new Date();
  await prisma.issuedDocument.updateMany({ where: { id, firstViewedAt: null }, data: { firstViewedAt: now } });
  await prisma.issuedDocument.update({ where: { id }, data: { lastViewedAt: now, viewCount: { increment: 1 } } }).catch(() => undefined);
}

/** 후원자 마이페이지 열람(만료와 무관하게 본인 문서는 다시 연다). */
export async function loadIssuedForPayer(payerId: string, id: string): Promise<IssuedLoad> {
  const row = await prisma.issuedDocument.findFirst({ where: { id, payerId, archivedAt: null } });
  if (!row) return { ok: false, reason: '문서를 찾을 수 없습니다.' };
  const { snapshot, verified } = readIssuedSnapshot(row);
  if (!snapshot) return { ok: false, reason: '문서를 읽지 못했습니다. 기관에 문의해 주세요.' };
  return { ok: true, row, snapshot, verified };
}

/** 열람 문서 PDF(비공개 저장소). 해시가 맞지 않으면 내보내지 않는다. */
export async function readIssuedPdf(row: Pick<IssuedDocument, 'pdfObject' | 'pdfHash' | 'signature'>): Promise<Buffer | null> {
  if (!row.pdfObject || row.signature) return null;
  const buf = await getPrivateObject(row.pdfObject);
  if (!buf) return null;
  if (row.pdfHash && createHash('sha256').update(buf).digest('hex') !== row.pdfHash) {
    logger.error('발급 문서 PDF 해시 불일치', { object: row.pdfObject });
    return null;
  }
  return buf;
}

// ---------------------------------------------------------------- 기관 조작

export class IssuedDocumentError extends Error {}

const RESEND_GAP_MS = 10 * 60 * 1000;

/**
 * 재발송: 새 열람 토큰을 만들어(이전 링크 무효) 기간을 다시 30일로 하고 안내 문자를 보낸다.
 * 서명 문서는 전자문서 센터의 재안내를 쓴다(서명 링크·본인확인이 그쪽에 있다).
 */
export async function resendIssuedDocument(input: { merchantId: string; id: string }) {
  const row = await prisma.issuedDocument.findFirst({ where: { id: input.id, merchantId: input.merchantId } });
  if (!row) throw new IssuedDocumentError('발급 문서를 찾을 수 없습니다.');
  if (row.archivedAt) throw new IssuedDocumentError('보관한 문서는 다시 보낼 수 없습니다. 먼저 되살려 주세요.');
  if (row.signature) throw new IssuedDocumentError('서명 문서는 전자문서 센터에서 재안내해 주세요.');
  if (row.sentAt && Date.now() - row.sentAt.getTime() < RESEND_GAP_MS) throw new IssuedDocumentError('방금 보낸 문서입니다. 10분 뒤 다시 보내 주세요.');
  const payer = await prisma.payerProfile.findUnique({ where: { id: row.payerId }, select: { onboardingStatus: true } });
  if (!payer || payer.onboardingStatus === 'WITHDRAWN') throw new IssuedDocumentError('탈퇴한 후원자에게는 다시 보내지 않습니다.');
  const merchant = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: row.merchantId }, select: { displayName: true } });
  const token = generateToken(32);
  await prisma.issuedDocument.update({
    where: { id: row.id },
    data: { tokenHash: tokenHash(token), expiresAt: addDays(new Date(), ISSUED_DOCUMENT_LINK_TTL_DAYS) },
  });
  const ok = await sendIssuedNotice(row.id, row.payerId, row.merchantId, merchant.displayName, row.title, issuedDocumentUrl(token));
  return { ok };
}

export async function archiveIssuedDocument(input: { merchantId: string; id: string }) {
  const r = await prisma.issuedDocument.updateMany({ where: { id: input.id, merchantId: input.merchantId, archivedAt: null }, data: { archivedAt: new Date() } });
  if (r.count !== 1) throw new IssuedDocumentError('보관할 문서를 찾을 수 없습니다.');
}

export async function restoreIssuedDocument(input: { merchantId: string; id: string }) {
  const r = await prisma.issuedDocument.updateMany({ where: { id: input.id, merchantId: input.merchantId, archivedAt: { not: null } }, data: { archivedAt: null } });
  if (r.count !== 1) throw new IssuedDocumentError('보관된 문서를 찾을 수 없습니다.');
}

// ---------------------------------------------------------------- 서명 봉투 결과 반영

const ENVELOPE_TO_ISSUED: Record<string, string> = { COMPLETED: 'SIGNED', DECLINED: 'DECLINED', EXPIRED: 'EXPIRED', CANCELLED: 'CANCELLED' };

/**
 * 봉투가 끝나면(완료·거절·만료·취소) 발급 문서 상태를 옮기고, 내부 전자서명(ESIGN_PROVIDER=internal)으로 요청한
 * 약정서·신청서(agreement_document.esign_request_id = 봉투 id)에 결과를 반영한다. 여러 번 불러도 결과는 한 번만 바뀐다.
 * 봉투 완료 지점(edoc.ts)에서 바로 부르고, `document.signed` 이벤트 소비자가 한 번 더 확인한다(재시도 안전).
 */
export async function syncIssuedFromEnvelope(envelopeId: string) {
  const e = await prisma.eDocEnvelope.findUnique({ where: { id: envelopeId }, select: { status: true, completedAt: true } });
  if (!e) return { changed: false };
  const next = ENVELOPE_TO_ISSUED[e.status];
  if (!next) return { changed: false };
  const r = await prisma.issuedDocument.updateMany({
    where: { envelopeId, status: 'REQUESTED' },
    data: { status: next, signedAt: next === 'SIGNED' ? (e.completedAt ?? new Date()) : null },
  });
  const { completeESign } = await import('./agreements');
  if (next === 'SIGNED' || next === 'DECLINED') {
    await completeESign(envelopeId, next);
  } else {
    await prisma.agreementDocument.updateMany({ where: { esignRequestId: envelopeId, esignStatus: 'REQUESTED' }, data: { esignStatus: 'EXPIRED' } });
  }
  return { changed: r.count > 0 };
}

/** `document.signed` 소비자 */
export async function handleDocumentSigned(ev: { subjectType: string; subjectId: string }) {
  if (ev.subjectType !== 'edoc_envelope') return 'SKIPPED' as const;
  const linked = await prisma.issuedDocument.count({ where: { envelopeId: ev.subjectId } })
    + await prisma.agreementDocument.count({ where: { esignRequestId: ev.subjectId } });
  if (!linked) return 'SKIPPED' as const;
  await syncIssuedFromEnvelope(ev.subjectId);
}
