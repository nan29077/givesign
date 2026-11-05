import { env } from '@/lib/env';
import { decrypt, maskPhone, sha256 } from '@/lib/crypto';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { formatNumber } from '@/lib/money';
import { kstMonthKey } from '@/lib/datetime';
import { prisma } from '@/server/db';
import { emitDomainEventSafe } from './events';
import { getESignAdapter } from '@/server/adapters/esign';
import type { AgreementKind } from '@/generated/prisma/enums';
import { currentTermsDoc } from './terms';
import * as tpl from './mt-templates';
import { sendMtForPayer } from './charge-flow';
import { mergeValuesFromContext, renderTemplateBody, resolvePurposeTemplate, templateRevision } from './purpose-templates';
import type { DocumentPurpose, MergeContext } from './purpose-documents';

/**
 * 전자 약정서·신청서.
 *
 * 약정이 생기거나 바뀔 때 그 시점의 내용을 스냅샷으로 고정해 문서로 남긴다.
 *  - 문서 내용(스냅샷)의 SHA-256 을 같이 저장해, 나중에 내용이 바뀌지 않았음을 확인할 수 있다.
 *  - 약정을 고치면 새 버전을 만들고 이전 버전은 그대로 둔다(supersedesId 로 연결).
 *  - 개인정보는 마스킹된 값만 스냅샷에 넣는다(절대 규칙 6). 원문은 후원자 프로필에만 있다.
 *  - ESIGN_ENABLED 이면 전자서명 요청을 함께 보낸다. 서명이 없어도 약정 자체는 동의 기록으로 성립한다.
 *  - 문서 발급 안내·서명 요청 실패는 약정 결과를 바꾸지 않는다(절대 규칙 3).
 *  - 기관의 용도 서식(SUPPORT_AGREEMENT·VOLUNTEER_APPLICATION, 없으면 기본 세트)을 머지 필드로 채운 본문을
 *    스냅샷 `form` 에 함께 고정한다(2026-11-06). 서식을 읽지 못해도 약정서는 만든다(form 없이).
 *  - ESIGN_PROVIDER=internal 이면 서명을 전자문서 센터 봉투로 받는다(esign_request_id = 봉투 id).
 */

/** 약정서 스냅샷에 고정하는 기관 서식 렌더 결과 */
export interface AgreementForm {
  templateId: string;
  templateRevision: string;
  name: string;
  /** 머지 결과 본문(값은 마스킹 규칙을 거친 것) */
  body: string;
  missing: string[];
}

const KIND_PURPOSE: Record<AgreementKind, DocumentPurpose> = {
  RECURRING_PLEDGE: 'SUPPORT_AGREEMENT',
  VOLUNTEER_APPLICATION: 'VOLUNTEER_APPLICATION',
};

async function agreementForm(merchantId: string, kind: AgreementKind, ctx: MergeContext): Promise<AgreementForm | null> {
  try {
    const t = await resolvePurposeTemplate(merchantId, KIND_PURPOSE[kind]);
    if (!t) return null;
    const m = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { displayName: true, representativeName: true } });
    const r = renderTemplateBody(t, mergeValuesFromContext(ctx, { merchantName: m.displayName, representative: m.representativeName ?? null }));
    return { templateId: t.id, templateRevision: templateRevision(t), name: t.name, body: r.text, missing: r.missing };
  } catch (e) {
    logger.warn('약정서 기관 서식 렌더 실패 — 서식 본문 없이 만듭니다', { merchantId, kind, message: (e as Error).message });
    return null;
  }
}

/** 약정서 스냅샷 → 내부 전자서명 머지 값 */
function contextFromSnapshot(snap: Record<string, unknown>): MergeContext {
  const s = snap as {
    donor?: { name: string };
    applicant?: { name: string };
    pledge?: { amount: string; dayOfMonth: number; campaign: string; firstChargeOn: string };
    application?: { wish: string | null };
  };
  if (s.pledge) {
    return {
      donorName: s.donor?.name ?? null,
      amount: BigInt(s.pledge.amount),
      dayOfMonth: s.pledge.dayOfMonth,
      campaignTitle: s.pledge.campaign,
      date: s.pledge.firstChargeOn,
    };
  }
  return { donorName: s.applicant?.name ?? null, activityTitle: s.application?.wish ?? null };
}

export interface AgreementMeta {
  ip?: string;
  userAgent?: string;
}

export const AGREEMENT_TITLE: Record<AgreementKind, string> = {
  RECURRING_PLEDGE: '정기후원 약정서',
  VOLUNTEER_APPLICATION: '자원봉사 신청서',
};

/** 키 순서를 고정한 JSON. 같은 내용이면 항상 같은 해시가 나온다. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function agreementHash(snapshot: unknown): string {
  return sha256(stableStringify(snapshot));
}

/**
 * 약정서에 남길 기관 문의처. 스냅샷은 영구 보존되고 후원자 화면·인쇄에 나가므로
 * 휴대폰 번호(담당자 개인 번호일 수 있음)와 이메일 주소는 마스킹한다. 일반 전화(대표번호)는 그대로 둔다.
 */
export function maskedIssuerContact(name: string | null, phone: string | null, email: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  const phoneOut = !phone ? null : /^01[016789]/.test(digits) ? maskPhone(digits) : phone;
  const emailOut = !email ? null : email.replace(/^([^@]{0,2})[^@]*@/, (_m, head: string) => `${head}***@`);
  return [name, phoneOut, emailOut].filter(Boolean).join(' · ') || null;
}

async function issuerSnapshot(merchantId: string) {
  const m = await prisma.merchantProfile.findUniqueOrThrow({
    where: { id: merchantId },
    select: {
      code: true, displayName: true, businessNo: true, representativeName: true, address: true,
      contactName: true, contactPhone: true, contactEmail: true, fundraisingRegNo: true,
    },
  });
  return {
    code: m.code,
    name: m.displayName,
    businessNo: m.businessNo ?? null,
    representative: m.representativeName ?? null,
    address: m.address ?? null,
    contact: maskedIssuerContact(m.contactName ?? null, m.contactPhone ?? null, m.contactEmail ?? null),
    fundraisingRegNo: m.fundraisingRegNo ?? null,
  };
}

async function nextVersion(kind: AgreementKind, subjectId: string) {
  const last = await prisma.agreementDocument.findFirst({
    where: { kind, subjectId },
    orderBy: { version: 'desc' },
    select: { id: true, version: true },
  });
  return { version: (last?.version ?? 0) + 1, supersedesId: last?.id ?? null };
}

async function createDocument(input: {
  kind: AgreementKind;
  subjectId: string;
  merchantId: string;
  payerId: string;
  merchantCode: string;
  snapshot: Record<string, unknown>;
  termsVersion: string | null;
  meta: AgreementMeta;
}) {
  const { version, supersedesId } = await nextVersion(input.kind, input.subjectId);
  const now = new Date();
  const docNo = `${input.merchantCode}-AG-${kstMonthKey(now).replace('-', '')}-${newId().slice(-6)}`;
  const doc = await prisma.agreementDocument.create({
    data: {
      id: newId(),
      merchantId: input.merchantId,
      payerId: input.payerId,
      kind: input.kind,
      subjectId: input.subjectId,
      version,
      docNo,
      title: AGREEMENT_TITLE[input.kind],
      snapshot: input.snapshot as object,
      contentHash: agreementHash(input.snapshot),
      consentAt: now,
      consentIp: input.meta.ip ?? null,
      userAgent: input.meta.userAgent?.slice(0, 300) ?? null,
      termsVersion: input.termsVersion,
      supersedesId,
    },
  });
  return doc;
}

/** 전자서명 요청 (켜져 있을 때만). 실패해도 문서는 그대로 남는다. */
async function requestSignatureIfEnabled(docId: string) {
  if (!env.automation.esignEnabled) return null;
  const doc = await prisma.agreementDocument.findUniqueOrThrow({
    where: { id: docId },
    include: { payer: { select: { phoneEnc: true, displayName: true } } },
  });
  const adapter = getESignAdapter();
  try {
    const snap = doc.snapshot as Record<string, unknown>;
    const res = await adapter.request({
      docNo: doc.docNo,
      title: doc.title,
      signerPhone: decrypt(doc.payer.phoneEnc),
      signerName: doc.payer.displayName ?? '후원자',
      body: renderAgreementText(snap),
      contentHash: doc.contentHash,
      internal: {
        merchantId: doc.merchantId,
        payerId: doc.payerId,
        agreementDocId: doc.id,
        purpose: KIND_PURPOSE[doc.kind] as 'SUPPORT_AGREEMENT' | 'VOLUNTEER_APPLICATION',
        context: contextFromSnapshot(snap),
      },
    });
    if (!res.ok || !res.data) {
      logger.warn('전자서명 요청 실패 — 동의 기록 약정서로 유지합니다', { docNo: doc.docNo, code: res.code });
      return null;
    }
    await prisma.agreementDocument.update({
      where: { id: doc.id },
      data: { esignProvider: adapter.info().provider, esignRequestId: res.data.requestId, esignStatus: 'REQUESTED' },
    });
    return res.data;
  } catch (e) {
    logger.warn('전자서명 요청 예외 — 동의 기록 약정서로 유지합니다', { docNo: doc.docNo, message: (e as Error).message });
    return null;
  }
}

async function notifyIssued(doc: { id: string; payerId: string; merchantId: string; title: string }, merchantName: string) {
  const link = `${env.baseUrl}/my/agreements/${doc.id}`;
  await sendMtForPayer(doc.payerId, tpl.tplAgreementIssued({ merchantName, title: doc.title, link }), null, doc.merchantId).catch((e) =>
    logger.warn('약정서 발급 안내 실패', { message: (e as Error).message }),
  );
}

/** 정기후원 약정서를 만든다(약정 생성·변경 시). 현행 문서 ID 를 약정에 연결한다. */
export async function issueRecurringAgreement(recurringId: string, meta: AgreementMeta = {}, opts: { notify?: boolean } = {}) {
  const r = await prisma.recurringDonation.findUniqueOrThrow({
    where: { id: recurringId },
    include: {
      payer: { select: { displayName: true, phoneMasked: true } },
      campaign: { select: { title: true, code: true } },
      merchant: { select: { code: true, displayName: true } },
    },
  });
  const terms = await currentTermsDoc('RECURRING_DEBIT');
  const campaignLabel = r.campaign ? `${r.campaign.title} (${r.campaign.code})` : '기관 일반 후원';
  const form = await agreementForm(r.merchantId, 'RECURRING_PLEDGE', {
    donorName: r.payer.displayName ?? '후원자',
    amount: r.amount,
    dayOfMonth: r.dayOfMonth,
    campaignTitle: r.campaign?.title ?? '기관 일반 후원',
    date: r.nextChargeOn.toISOString().slice(0, 10),
  });
  const snapshot = {
    kind: 'RECURRING_PLEDGE',
    issuer: await issuerSnapshot(r.merchantId),
    // 후원자 표시 이름은 약정 당사자 표기로 필요해 그대로 둔다(전화는 마스킹 값만). 규칙상 예외 — 점검 2026-11-05 C.
    donor: { name: r.payer.displayName ?? '후원자', phoneMasked: r.payer.phoneMasked },
    pledge: {
      amount: r.amount.toString(),
      amountText: `${formatNumber(r.amount)}원`,
      dayOfMonth: r.dayOfMonth,
      cycle: '매월',
      firstChargeOn: r.nextChargeOn.toISOString().slice(0, 10),
      campaign: campaignLabel,
      anonymous: r.anonymous,
      message: r.message,
      method: '등록된 결제수단 자동 출금',
    },
    consent: {
      type: 'RECURRING_DEBIT',
      termsTitle: terms?.title ?? '정기후원 자동 출금 동의',
      termsVersion: terms?.version ?? null,
      termsHash: terms ? sha256(terms.content) : null,
      consentId: r.consentId,
    },
    // 기관 서식(후원 약정서) 본문 — 머지 필드를 채운 결과. 서식을 읽지 못하면 넣지 않는다.
    ...(form ? { form } : {}),
  };
  const doc = await createDocument({
    kind: 'RECURRING_PLEDGE',
    subjectId: r.id,
    merchantId: r.merchantId,
    payerId: r.payerId,
    merchantCode: r.merchant.code,
    snapshot,
    termsVersion: terms?.version ?? null,
    meta,
  });
  await prisma.recurringDonation.update({ where: { id: r.id }, data: { agreementDocId: doc.id } });
  await requestSignatureIfEnabled(doc.id);
  if (opts.notify !== false) await notifyIssued(doc, r.merchant.displayName);
  return doc;
}

/** 자원봉사 신청서를 만든다. */
export async function issueVolunteerAgreement(applicationId: string, meta: AgreementMeta = {}, opts: { notify?: boolean } = {}) {
  const a = await prisma.volunteerApplication.findUniqueOrThrow({
    where: { id: applicationId },
    include: {
      payer: { select: { displayName: true, phoneMasked: true, volunteerProfile: true } },
      merchant: { select: { code: true, displayName: true } },
    },
  });
  const vp = a.payer.volunteerProfile;
  const terms = await currentTermsDoc('VOLUNTEER_PRIVACY');
  const form = await agreementForm(a.merchantId, 'VOLUNTEER_APPLICATION', {
    donorName: a.payer.displayName ?? '신청자',
    activityTitle: a.wish ?? null,
  });
  const snapshot = {
    kind: 'VOLUNTEER_APPLICATION',
    issuer: await issuerSnapshot(a.merchantId),
    applicant: { name: a.payer.displayName ?? '신청자', phoneMasked: a.payer.phoneMasked },
    application: {
      wish: a.wish ?? null,
      interests: vp?.interests ?? [],
      availableDays: vp?.availableDays ?? [],
      timeSlot: vp?.timeSlot ?? null,
      experience: vp?.experience ?? null,
      emergency: vp?.emergencyName ? `${vp.emergencyName} ${vp.emergencyPhoneMasked ?? ''}`.trim() : null,
      safetyPledged: Boolean(vp?.safetyPledgedAt),
      message: a.message ?? null,
    },
    consent: {
      type: 'VOLUNTEER_PRIVACY',
      termsTitle: terms?.title ?? '자원봉사 개인정보 수집·이용 동의',
      termsVersion: terms?.version ?? null,
      termsHash: terms ? sha256(terms.content) : null,
      consentId: vp?.consentId ?? null,
    },
    ...(form ? { form } : {}),
  };
  const doc = await createDocument({
    kind: 'VOLUNTEER_APPLICATION',
    subjectId: a.id,
    merchantId: a.merchantId,
    payerId: a.payerId,
    merchantCode: a.merchant.code,
    snapshot,
    termsVersion: terms?.version ?? null,
    meta,
  });
  await prisma.volunteerApplication.update({ where: { id: a.id }, data: { agreementDocId: doc.id } });
  await requestSignatureIfEnabled(doc.id);
  if (opts.notify) await notifyIssued(doc, a.merchant.displayName);
  return doc;
}

/** 전자서명 결과 반영 (콜백·모의 서명 화면). 이미 결론이 난 요청은 바꾸지 않는다. */
export async function completeESign(requestId: string, outcome: 'SIGNED' | 'DECLINED') {
  const doc = await prisma.agreementDocument.findFirst({ where: { esignRequestId: requestId } });
  if (!doc) return { ok: false as const, message: '서명 요청을 찾을 수 없습니다.' };
  if (doc.esignStatus !== 'REQUESTED') return { ok: true as const, already: true, status: doc.esignStatus };
  const updated = await prisma.agreementDocument.updateMany({
    where: { id: doc.id, esignStatus: 'REQUESTED' },
    data: { esignStatus: outcome, signedAt: outcome === 'SIGNED' ? new Date() : null },
  });
  if (updated.count > 0 && outcome === 'SIGNED') {
    await emitDomainEventSafe({
      merchantId: doc.merchantId,
      type: 'agreement.signed',
      subjectType: 'agreement_document',
      subjectId: doc.id,
      payerId: doc.payerId,
      payload: { kind: doc.kind, title: doc.title },
    });
  }
  return { ok: true as const, already: updated.count === 0, status: outcome };
}

/** 이 기간 동안 결과가 오지 않은 전자서명 요청은 만료로 닫는다(서명 대기 집계가 영구히 쌓이지 않게). */
export const ESIGN_REQUEST_TTL_DAYS = 30;

/**
 * 오래된 전자서명 요청(REQUESTED)을 EXPIRED 로 닫는다(/api/cron/cleanup).
 * 조건부 갱신이라 그 사이 도착한 서명 결과(completeESign)를 덮어쓰지 않는다.
 * 약정서 자체(동의 기록 + 해시)는 그대로 유효하다 — 전자서명은 덧붙이는 확인 수단이다.
 */
export async function expireStaleESignRequests(now = new Date()): Promise<number> {
  const r = await prisma.agreementDocument.updateMany({
    where: { esignStatus: 'REQUESTED', createdAt: { lt: new Date(now.getTime() - ESIGN_REQUEST_TTL_DAYS * 86_400_000) } },
    data: { esignStatus: 'EXPIRED' },
  });
  return r.count;
}

/** 문서 해시 검증: 저장된 스냅샷이 발급 당시와 같은지. */
export function verifyAgreement(doc: { snapshot: unknown; contentHash: string }): boolean {
  return agreementHash(doc.snapshot) === doc.contentHash;
}

const DAY_LABEL: Record<string, string> = { MON: '월', TUE: '화', WED: '수', THU: '목', FRI: '금', SAT: '토', SUN: '일' };
const SLOT_LABEL: Record<string, string> = { MORNING: '오전', AFTERNOON: '오후', EVENING: '저녁', WEEKEND: '주말' };

export function dayLabel(d: string) {
  return DAY_LABEL[d] ?? d;
}
export function slotLabel(s: string | null | undefined) {
  return s ? (SLOT_LABEL[s] ?? s) : '-';
}

/** 문서 본문 텍스트 (전자서명 화면·열람 화면 공용) */
export function renderAgreementText(snap: Record<string, unknown>): string {
  const s = snap as {
    kind: string;
    issuer: { name: string; code: string };
    donor?: { name: string; phoneMasked: string };
    applicant?: { name: string; phoneMasked: string };
    pledge?: { amountText: string; dayOfMonth: number; campaign: string; firstChargeOn: string; method: string };
    application?: { wish: string | null; interests: string[]; availableDays: string[]; timeSlot: string | null };
    consent: { termsTitle: string; termsVersion: string | null };
    form?: { name: string; body: string };
  };
  const formText = s.form?.body ? `\n\n[${s.form.name}]\n${s.form.body}` : '';
  return renderAgreementSummary(s) + formText;
}

function renderAgreementSummary(s: {
  kind: string;
  issuer: { name: string; code: string };
  donor?: { name: string; phoneMasked: string };
  applicant?: { name: string; phoneMasked: string };
  pledge?: { amountText: string; dayOfMonth: number; campaign: string; firstChargeOn: string; method: string };
  application?: { wish: string | null; interests: string[]; availableDays: string[]; timeSlot: string | null };
  consent: { termsTitle: string; termsVersion: string | null };
}): string {
  if (s.kind === 'RECURRING_PLEDGE' && s.pledge && s.donor) {
    return [
      `${s.issuer.name} 정기후원 약정서`,
      `후원자: ${s.donor.name} (${s.donor.phoneMasked})`,
      `약정 내용: 매월 ${s.pledge.dayOfMonth}일 ${s.pledge.amountText} (${s.pledge.method})`,
      `지정: ${s.pledge.campaign}`,
      `첫 출금 예정일: ${s.pledge.firstChargeOn}`,
      `동의: ${s.consent.termsTitle} ${s.consent.termsVersion ?? ''}`.trim(),
    ].join('\n');
  }
  const a = s.application!;
  return [
    `${s.issuer.name} 자원봉사 신청서`,
    `신청자: ${s.applicant?.name} (${s.applicant?.phoneMasked})`,
    `희망 활동: ${a.wish ?? '-'} / 분야: ${a.interests.join(', ') || '-'}`,
    `가능 요일: ${a.availableDays.map(dayLabel).join(', ') || '-'} / 시간대: ${slotLabel(a.timeSlot)}`,
    `동의: ${s.consent.termsTitle} ${s.consent.termsVersion ?? ''}`.trim(),
  ].join('\n');
}
