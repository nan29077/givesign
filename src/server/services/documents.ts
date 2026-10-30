import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { addDays } from '@/lib/datetime';
import {
  decrypt, encrypt, generateToken, maskName, maskPhone, normalizePhone, tokenHash,
} from '@/lib/crypto';
import { newObjectName, putObject } from '@/server/uploads';
import type { DocumentSubmissionStatus, DocumentTemplateType } from '@/generated/prisma/enums';
import type { Tone } from '@/lib/labels';
import { createHash } from 'node:crypto';
import type { DocumentTemplate } from '@/generated/prisma/client';

/**
 * 문서 상품 (약정서 · 주문서 · 계약서).
 *
 * ── 흐름 ────────────────────────────────────────────────────────────────
 *  1. 사회복지기관이 서식(DocumentTemplate)을 등록한다 — 에디터 직접 작성 / 파일 업로드 / 기본 서식.
 *  2. 그 서식을 가리키는 상품(ChargeProduct.kind = DOCUMENT)을 등록한다.
 *  3. 후원자가 문자 링크에서 그 상품을 골라 결제한다.
 *  4. 결제가 끝나면 제출 기록(DocumentSubmission)을 DRAFT 로 만들고,
 *     작성 링크(/doc/<토큰>)를 감사 문자에 붙여 보낸다.
 *  5. 후원자가 화면에서 채워 제출하거나(EDITOR·PRESET), 파일을 내려받아 작성한다(FILE).
 *  6. 사회복지기관이 콘솔에서 제출 내용을 확인한다.
 *
 * ── 왜 보안링크(SecureLink)를 쓰지 않는가 ───────────────────────────────
 * 보안링크는 1회용이고 수십 분 만에 만료된다. 결제·계좌 등록처럼 그 자리에서
 * 끝나는 일에는 맞지만, 문서 작성은 서류를 찾아보고 나중에 다시 여는 일이다.
 * 한 번 열었다고 링크가 죽으면 후원자는 작성할 방법이 없고, 사회복지기관이 대신
 * 새 링크를 만들어 줄 수단도 없다. 그래서 제출 기록 자체에 토큰을 두고
 * 제출 전까지 몇 번이든 열 수 있게 한다. 토큰은 해시만 저장한다.
 *
 * ── 개인정보 ────────────────────────────────────────────────────────────
 * 후원자가 적어 넣는 값은 성명·연락처·주소다. 배송지와 같은 기준으로
 * 암호화해 저장하고(valuesEnc), 목록에는 마스킹 값만 노출한다.
 * 원문 열람은 감사로그(DOCUMENT_SUBMISSION_VIEW)를 남긴다.
 */

// ===========================================================================
// 상수
// ===========================================================================

/** 작성 링크 유효기간(일). 서류를 찾아보고 다시 여는 일이라 넉넉히 둔다. */
export const DOCUMENT_LINK_TTL_DAYS = 30;

/** 사회복지기관당 서식 개수 상한. 관리할 수 있는 수를 넘기면 어떤 서식이 쓰이는지 알 수 없다. */
export const MAX_DOCUMENT_TEMPLATES = 30;

/** 입력 항목 개수 상한. 한 화면에서 채울 수 있는 수. */
export const MAX_DOCUMENT_FIELDS = 30;

/** 본문 길이 상한. */
export const DOCUMENT_BODY_MAX = 20_000;

/** 서명 이미지 용량 상한(디코딩 후). */
const SIGNATURE_MAX_BYTES = 512 * 1024;

/** 항목 1개 입력값 길이 상한. */
const VALUE_MAX = 2_000;

// ===========================================================================
// 입력 항목 정의
// ===========================================================================

export const DOCUMENT_FIELD_TYPES = ['TEXT', 'LONGTEXT', 'DATE', 'NUMBER', 'PHONE', 'CHECKBOX'] as const;

export type DocumentFieldType = (typeof DOCUMENT_FIELD_TYPES)[number];

export interface DocumentField {
  /** 폼 필드 이름. 영문·숫자·밑줄만. 제출값의 키가 된다. */
  id: string;
  label: string;
  type: DocumentFieldType;
  required: boolean;
  /** 입력 도움말 (placeholder). */
  hint: string | null;
}

export const fieldTypeLabel: Record<DocumentFieldType, { text: string; hint: string }> = {
  TEXT: { text: '한 줄 텍스트', hint: '성명 · 주소처럼 짧은 글' },
  LONGTEXT: { text: '여러 줄 텍스트', hint: '특약 사항 · 요청 내용' },
  DATE: { text: '날짜', hint: '계약일 · 희망일' },
  NUMBER: { text: '숫자', hint: '수량 · 금액' },
  PHONE: { text: '연락처', hint: '010-0000-0000 형식으로 확인한다' },
  CHECKBOX: { text: '동의 체크', hint: '약관 동의처럼 예/아니오' },
};

export const documentTemplateTypeLabel: Record<DocumentTemplateType, { text: string; hint: string }> = {
  EDITOR: { text: '직접 작성', hint: '본문과 빈칸을 콘솔에서 직접 만든다. 후원자는 화면에서 채운다.' },
  FILE: { text: '파일 업로드', hint: 'PDF·워드 서식을 올린다. 후원자는 내려받아 작성한다.' },
  PRESET: { text: '기본 서식', hint: '기브싸인이 준비한 서식에서 고른다. 내용은 그대로 손볼 수 있다.' },
};

export const documentStatusLabel: Record<DocumentSubmissionStatus, { text: string; tone: Tone }> = {
  DRAFT: { text: '작성 대기', tone: 'warning' },
  SUBMITTED: { text: '제출 완료', tone: 'brand' },
  REVIEWED: { text: '확인 완료', tone: 'success' },
};

/** 항목 id 를 정규화한다. 빈 값이면 순번으로 만든다. */
function normalizeFieldId(raw: string, index: number): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return cleaned || `field_${index + 1}`;
}

function toFieldType(raw: unknown): DocumentFieldType {
  const v = String(raw ?? '').toUpperCase();
  return (DOCUMENT_FIELD_TYPES as readonly string[]).includes(v) ? (v as DocumentFieldType) : 'TEXT';
}

/**
 * DB 에 담긴 fields JSON 을 읽는다.
 *
 * 저장 형식이 깨져 있어도 화면이 죽지 않아야 한다(후원자가 결제까지 마친 뒤 여는 화면이다).
 * 모양이 아닌 값은 조용히 버린다.
 */
export function parseDocumentFields(raw: unknown): DocumentField[] {
  if (!raw) return [];
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];

  const out: DocumentField[] = [];
  const used = new Set<string>();
  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const label = String(row.label ?? '').trim().slice(0, 60);
    if (!label) continue;
    let id = normalizeFieldId(String(row.id ?? label), i);
    // 같은 id 가 둘이면 뒤엣것이 앞엣것의 값을 덮어쓴다. 제출 내용이 사라지므로 겹치지 않게 만든다.
    while (used.has(id)) id = `${id}_${used.size + 1}`.slice(0, 34);
    used.add(id);
    out.push({
      id,
      label,
      type: toFieldType(row.type),
      required: row.required === true || row.required === 'true' || row.required === 1,
      hint: row.hint != null && String(row.hint).trim() ? String(row.hint).trim().slice(0, 80) : null,
    });
    if (out.length >= MAX_DOCUMENT_FIELDS) break;
  }
  return out;
}

/** 폼 편집기가 보낸 JSON 문자열을 읽는다. */
export function parseDocumentFieldsJson(text: string): DocumentField[] {
  if (!text.trim()) return [];
  return parseDocumentFields(text);
}

/** DB 저장 형식으로 만든다. */
export function fieldsToStorage(fields: DocumentField[]) {
  return fields.map((f) => ({
    id: f.id,
    label: f.label,
    type: f.type,
    required: f.required,
    hint: f.hint,
  }));
}

// ===========================================================================
// 기본 서식 (PRESET)
// ===========================================================================

export interface DocumentPreset {
  key: string;
  name: string;
  description: string;
  body: string;
  fields: DocumentField[];
  requireSignature: boolean;
}

function f(
  id: string,
  label: string,
  type: DocumentFieldType,
  required = true,
  hint: string | null = null,
): DocumentField {
  return { id, label, type, required, hint };
}

/**
 * 기브싸인이 준비한 기본 서식.
 *
 * 법률 자문을 받은 표준 약관이 아니라 **작성 편의를 위한 뼈대**다.
 * 그래서 화면에도 그대로 쓰지 말고 사회복지기관 사정에 맞게 손보라고 안내한다.
 */
export const DOCUMENT_PRESETS: DocumentPreset[] = [
  {
    key: 'VOLUNTEER_APPLICATION', name: '자원봉사 신청서', description: '희망 활동·일정·연락처와 참여 동의를 받는 기관용 서식',
    body: '기관의 자원봉사 활동에 참여를 신청합니다. 활동 일정과 장소, 역할은 담당자와 확인하며 안전수칙과 개인정보 보호 지침을 준수합니다. 기관은 아래 신청 정보를 활동 안내와 참여 관리 목적으로 사용합니다. 실제 수집 항목과 보유 기간은 기관의 운영 기준에 맞게 기재해 주세요.',
    fields: [f('name', '신청자 성명', 'TEXT'), f('phone', '연락처', 'PHONE'), f('activity', '희망 활동 분야', 'TEXT'), f('date', '희망 활동일', 'DATE'), f('experience', '경험과 요청 사항', 'LONGTEXT', false), f('agree_privacy', '기재된 개인정보 수집·이용 안내를 확인하고 동의합니다', 'CHECKBOX')], requireSignature: true,
  },
  {
    key: 'GOODS_DONATION', name: '현물 기부 신청서', description: '기부 물품·수량·전달 일정을 미리 확인하는 서식',
    body: '아래 물품의 기부를 신청합니다. 기관은 물품 상태와 수용 가능 여부를 확인하여 접수 결과와 전달 방법을 안내합니다. 이 신청서는 기부금영수증이 아니며 영수증 발급 가능 여부와 평가 금액은 기관의 적격 확인 후 별도로 안내합니다.',
    fields: [f('name', '기부자 성명 또는 단체명', 'TEXT'), f('phone', '연락처', 'PHONE'), f('goods', '기부 물품과 상태', 'LONGTEXT'), f('quantity', '수량', 'NUMBER'), f('date', '희망 전달일', 'DATE', false), f('agree_privacy', '기재된 개인정보 수집·이용 안내를 확인하고 동의합니다', 'CHECKBOX')], requireSignature: true,
  },
  {
    key: 'PROGRAM_APPLICATION', name: '복지 프로그램 참여 신청서', description: '기관 프로그램의 참여 희망 내용과 연락처를 접수합니다',
    body: '기관에서 운영하는 아래 프로그램에 참여를 신청합니다. 참여 가능 여부와 준비 사항은 담당자가 별도로 안내합니다. 주민등록번호와 건강정보 등 민감한 정보는 이 일반 신청서에 입력하지 마세요.',
    fields: [f('name', '신청자 성명', 'TEXT'), f('phone', '연락처', 'PHONE'), f('program', '신청 프로그램명', 'TEXT'), f('date', '희망 참여일', 'DATE', false), f('note', '문의 사항', 'LONGTEXT', false), f('agree_privacy', '기재된 개인정보 수집·이용 안내를 확인하고 동의합니다', 'CHECKBOX')], requireSignature: false,
  },
  {
    key: 'SUPPORT_AGREEMENT',
    name: '후원약정서',
    description: '정기·일시 후원 약정 내용을 확인받는 서식',
    body: [
      '제1조 (목적)',
      '이 약정서는 후원자와 사회복지기관 사이의 후원 금액·주기·기간에 관한 사항을 정하는 것을 목적으로 합니다.',
      '',
      '제2조 (후원 방법)',
      '후원자는 아래에 기재한 금액을 약정한 주기에 따라 납입합니다. 납입은 문자 결제로 이루어집니다.',
      '',
      '제3조 (변경과 해지)',
      '후원자는 언제든지 후원 금액의 변경 또는 후원 해지를 요청할 수 있으며, 사회복지기관은 요청을 받은 날이 속한 달의 다음 달부터 이를 반영합니다.',
      '',
      '제4조 (개인정보)',
      '사회복지기관은 후원금 관리와 영수증 발급 목적으로만 아래 정보를 이용하며, 목적이 끝나면 지체 없이 파기합니다.',
      '',
      '위 내용을 확인하였으며 이에 동의합니다.',
    ].join('\n'),
    fields: [
      f('name', '성명', 'TEXT'),
      f('phone', '연락처', 'PHONE'),
      f('address', '주소', 'TEXT', false),
      f('amount', '약정 금액(원)', 'NUMBER'),
      f('cycle', '후원 주기', 'TEXT', true, '매월 · 분기 · 1회'),
      f('start_date', '후원 시작일', 'DATE'),
      f('receipt', '기부금 영수증 발급 희망', 'CHECKBOX', false),
      f('note', '요청 사항', 'LONGTEXT', false),
      f('agree_privacy', '개인정보 수집·이용에 동의합니다', 'CHECKBOX'),
    ],
    requireSignature: true,
  },
  {
    key: 'INSURANCE_AGREEMENT',
    name: '보험약정서',
    description: '보험 상품 가입 의사와 고지 사항을 확인받는 서식',
    body: [
      '제1조 (계약의 성립)',
      '이 약정서는 계약자가 아래 보험 상품에 가입할 의사를 밝히고, 취급자가 이를 접수함으로써 성립합니다.',
      '',
      '제2조 (고지 의무)',
      '계약자는 계약 체결에 영향을 주는 사항을 사실대로 알려야 하며, 알리지 않거나 사실과 다르게 알린 경우 보장이 제한될 수 있습니다.',
      '',
      '제3조 (청약 철회)',
      '계약자는 청약을 한 날부터 15일 이내에 청약을 철회할 수 있습니다.',
      '',
      '제4조 (개인정보)',
      '취급자는 계약 인수·유지·지급 심사 목적으로만 아래 정보를 이용합니다.',
      '',
      '※ 실제 보장 내용과 조건은 보험 상품 약관을 따릅니다.',
      '',
      '위 내용을 확인하였으며 이에 동의합니다.',
    ].join('\n'),
    fields: [
      f('name', '계약자 성명', 'TEXT'),
      f('phone', '연락처', 'PHONE'),
      f('birth', '생년월일', 'DATE'),
      f('address', '주소', 'TEXT', false),
      f('product', '가입 상품명', 'TEXT'),
      f('premium', '월 보험료(원)', 'NUMBER', false),
      f('start_date', '보장 개시 희망일', 'DATE', false),
      f('health_note', '고지 사항 (질병·치료 이력 등)', 'LONGTEXT', false),
      f('agree_terms', '약관 및 상품 설명을 확인했습니다', 'CHECKBOX'),
      f('agree_privacy', '개인정보 수집·이용에 동의합니다', 'CHECKBOX'),
    ],
    requireSignature: true,
  },
  {
    key: 'ORDER_SHEET',
    name: '주문서',
    description: '품목·수량·수령 정보를 받아 두는 서식',
    body: [
      '아래와 같이 주문합니다.',
      '',
      '· 주문 내용과 수령 정보를 정확히 적어 주세요. 잘못 적으면 배송이 지연될 수 있습니다.',
      '· 주문 확정 뒤 품목 변경은 사회복지기관에 별도로 연락해 주세요.',
      '',
      '위 내용을 확인하였으며 이에 동의합니다.',
    ].join('\n'),
    fields: [
      f('name', '주문자 성명', 'TEXT'),
      f('phone', '연락처', 'PHONE'),
      f('item', '주문 품목', 'TEXT'),
      f('quantity', '수량', 'NUMBER'),
      f('receiver', '받는 분', 'TEXT', false),
      f('address', '받는 주소', 'TEXT'),
      f('wish_date', '희망 수령일', 'DATE', false),
      f('note', '요청 사항', 'LONGTEXT', false),
      f('agree_privacy', '개인정보 수집·이용에 동의합니다', 'CHECKBOX'),
    ],
    requireSignature: false,
  },
  {
    key: 'SERVICE_CONTRACT',
    name: '용역계약서',
    description: '작업 범위·기간·대금을 정하는 서식',
    body: [
      '제1조 (계약의 목적)',
      '이 계약은 아래 용역의 범위·기간·대금에 관한 사항을 정하는 것을 목적으로 합니다.',
      '',
      '제2조 (대금의 지급)',
      '대금은 아래 기재한 금액으로 하며, 지급 시기는 당사자가 합의한 바에 따릅니다.',
      '',
      '제3조 (계약의 해지)',
      '당사자 일방이 이 계약을 위반한 경우 상대방은 서면으로 시정을 요구하고, 시정되지 않으면 계약을 해지할 수 있습니다.',
      '',
      '제4조 (비밀유지)',
      '당사자는 이 계약을 이행하며 알게 된 상대방의 정보를 제3자에게 누설하지 않습니다.',
      '',
      '위 내용을 확인하였으며 이에 동의합니다.',
    ].join('\n'),
    fields: [
      f('name', '성명 (또는 상호)', 'TEXT'),
      f('phone', '연락처', 'PHONE'),
      f('scope', '용역 범위', 'LONGTEXT'),
      f('amount', '용역 대금(원)', 'NUMBER'),
      f('start_date', '착수일', 'DATE'),
      f('end_date', '완료 예정일', 'DATE', false),
      f('agree_privacy', '개인정보 수집·이용에 동의합니다', 'CHECKBOX'),
    ],
    requireSignature: true,
  },
  {
    key: 'CONSENT_PRIVACY',
    name: '개인정보 수집·이용 동의서',
    description: '수집 항목·목적·보유 기간을 알리고 동의를 받는 서식',
    body: [
      '1. 수집 항목: 성명, 연락처, 주소',
      '2. 수집·이용 목적: 서비스 제공, 본인 확인, 결제·정산 처리, 고객 응대',
      '3. 보유·이용 기간: 목적 달성 후 지체 없이 파기 (관계 법령에 보존 의무가 있으면 그 기간까지)',
      '4. 동의 거부 권리: 동의를 거부할 수 있으나, 이 경우 서비스 이용이 제한될 수 있습니다.',
      '',
      '위 내용을 확인하였으며 개인정보 수집·이용에 동의합니다.',
    ].join('\n'),
    fields: [
      f('name', '성명', 'TEXT'),
      f('phone', '연락처', 'PHONE'),
      f('agree_privacy', '개인정보 수집·이용에 동의합니다', 'CHECKBOX'),
      f('agree_third', '제3자 제공에 동의합니다 (선택)', 'CHECKBOX', false),
    ],
    requireSignature: true,
  },
];

export function presetOf(key: string | null | undefined): DocumentPreset | null {
  if (!key) return null;
  return DOCUMENT_PRESETS.find((p) => p.key === key) ?? null;
}

// ===========================================================================
// 작성 링크 · 제출 기록
// ===========================================================================

export function documentUrl(token: string): string {
  return `${env.baseUrl}/doc/${token}`;
}

/** 이 상품이 문서 작성을 요구하는지. */
export function isDocumentProduct(
  product: { kind: string; documentTemplateId: string | null } | null | undefined,
): boolean {
  return Boolean(product && product.kind === 'DOCUMENT' && product.documentTemplateId);
}

/**
 * 결제 건에 문서 작성 기록을 만들고 링크를 돌려준다.
 *
 * 이미 만들어 둔 기록이 있으면 새로 만들지 않는다(중복 승인·재시도 방어).
 * 다만 그때는 토큰 원문을 알 수 없다(해시만 저장한다) — 링크는 null 로 돌려주고
 * 호출부는 문자를 다시 보내지 않는다.
 */
export async function ensureDocumentSubmission(chargeId: string): Promise<
  | { ok: true; created: boolean; submissionId: string; url: string | null; templateName: string }
  | { ok: false; reason: string }
> {
  const charge = await prisma.charge.findUnique({
    where: { id: chargeId },
    select: {
      id: true,
      merchantId: true,
      displayName: true,
      product: { select: { kind: true, documentTemplateId: true } },
      documentSubmission: { select: { id: true, template: { select: { name: true } } } },
    },
  });
  if (!charge) return { ok: false, reason: '결제 건을 찾을 수 없습니다.' };
  if (!isDocumentProduct(charge.product)) return { ok: false, reason: '문서 상품 결제가 아닙니다.' };

  if (charge.documentSubmission) {
    return {
      ok: true,
      created: false,
      submissionId: charge.documentSubmission.id,
      url: null,
      templateName: charge.documentSubmission.template.name,
    };
  }

  const template = await prisma.documentTemplate.findFirst({
    where: { id: charge.product!.documentTemplateId!, merchantId: charge.merchantId },
    select: { id: true, name: true },
  });
  if (!template) return { ok: false, reason: '연결된 문서 서식을 찾을 수 없습니다.' };

  // 후원자 연락처는 결제 건에 붙은 후원자 프로필에서 가져온다(제출자 확인용 마스킹 값).
  const payerPhone = await payerPhoneOf(chargeId);
  const token = generateToken(32);

  try {
    const row = await prisma.documentSubmission.create({
      data: {
        id: newId(),
        templateId: template.id,
        merchantId: charge.merchantId,
        chargeId: charge.id,
        tokenHash: tokenHash(token),
        expiresAt: addDays(new Date(), DOCUMENT_LINK_TTL_DAYS),
        payerNameEnc: charge.displayName ? encrypt(charge.displayName) : null,
        payerNameMasked: charge.displayName ? maskName(charge.displayName) : null,
        payerPhoneEnc: payerPhone ? encrypt(payerPhone) : null,
        payerPhoneMasked: payerPhone ? maskPhone(payerPhone) : null,
      },
      select: { id: true },
    });
    return { ok: true, created: true, submissionId: row.id, url: documentUrl(token), templateName: template.name };
  } catch (e) {
    // chargeId 는 unique 다. 동시에 두 번 승인되면 한쪽이 여기로 떨어진다.
    const existing = await prisma.documentSubmission.findUnique({
      where: { chargeId: charge.id },
      select: { id: true },
    });
    if (existing) {
      return { ok: true, created: false, submissionId: existing.id, url: null, templateName: template.name };
    }
    logger.error('문서 작성 기록 생성 실패', { chargeId, message: (e as Error).message });
    return { ok: false, reason: '문서 작성 기록을 만들지 못했습니다.' };
  }
}

async function payerPhoneOf(chargeId: string): Promise<string | null> {
  const charge = await prisma.charge.findUnique({
    where: { id: chargeId },
    select: { payer: { select: { phoneEnc: true } } },
  });
  if (!charge?.payer) return null;
  try {
    return decrypt(charge.payer.phoneEnc);
  } catch {
    return null;
  }
}

// ===========================================================================
// 공개 작성 화면
// ===========================================================================

export interface DocumentContext {
  submissionId: string;
  merchantName: string;
  templateName: string;
  templateType: DocumentTemplateType;
  description: string | null;
  body: string | null;
  fileUrl: string | null;
  fileName: string | null;
  fields: DocumentField[];
  requireSignature: boolean;
  status: DocumentSubmissionStatus;
  expiresAt: Date;
  submittedAt: Date | null;
  /** 결제 거래번호. 후원자가 어느 결제 건인지 알 수 있게 보여 준다. */
  transactionNo: string | null;
  productName: string | null;
  /** 제출한 뒤 다시 열었을 때 보여 줄 값. 제출 전에는 빈 객체다. */
  values: Record<string, string>;
  signatureUrl: string | null;
  documentHash?: string;
}

/** Standalone requests retain the exact template sent, even after template edits. */
export async function documentTemplateSnapshot(submissionId: string, fallback: DocumentTemplate) {
  const saved = await prisma.systemSetting.findUnique({ where: { key: `givesign:edoc:snapshot:${submissionId}` } });
  if (!saved) return { template: fallback, sha256: undefined };
  const value = saved.value as { encrypted: string; sha256: string };
  const raw = decrypt(value.encrypted);
  if (createHash('sha256').update(raw).digest('hex') !== value.sha256) throw new Error('문서 원본 확인에 실패했습니다.');
  const frozen = JSON.parse(raw) as DocumentTemplate;
  return { template: { ...fallback, ...frozen }, sha256: value.sha256 };
}

export async function loadDocumentContext(
  token: string,
): Promise<{ ok: true; ctx: DocumentContext } | { ok: false; reason: string }> {
  if (!token || token.length < 16) return { ok: false, reason: '유효하지 않은 링크입니다.' };

  const row = await prisma.documentSubmission.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: {
      template: true,
      merchant: { select: { displayName: true } },
      charge: { select: { transactionNo: true, product: { select: { name: true } } } },
    },
  });
  if (!row) return { ok: false, reason: '유효하지 않은 링크입니다.' };
  // 제출이 끝난 문서는 만료 뒤에도 내용을 볼 수 있어야 한다(본인 보관용).
  if (row.status === 'DRAFT' && row.expiresAt < new Date()) {
    return { ok: false, reason: '작성 기간이 지났습니다. 사회복지기관에 문의해 주세요.' };
  }

  const snapshot = await documentTemplateSnapshot(row.id, row.template);
  const template = snapshot.template;
  const fields = parseDocumentFields(template.fields);

  return {
    ok: true,
    ctx: {
      submissionId: row.id,
      merchantName: row.merchant.displayName,
      templateName: template.name,
      templateType: template.templateType,
      description: template.description,
      body: template.body,
      fileUrl: template.fileUrl,
      fileName: template.fileName,
      fields,
      requireSignature: template.requireSignature,
      documentHash: snapshot.sha256,
      status: row.status,
      expiresAt: row.expiresAt,
      submittedAt: row.submittedAt,
      transactionNo: row.charge?.transactionNo ?? null,
      productName: row.charge?.product?.name ?? null,
      values: row.status === 'DRAFT' ? {} : readValues(row.valuesEnc),
      signatureUrl: row.status === 'DRAFT' ? null : row.signatureUrl,
    },
  };
}

/** 암호화해 둔 입력값을 읽는다. 복호화 실패는 화면을 멈추지 않는다. */
export function readValues(valuesEnc: string | null): Record<string, string> {
  if (!valuesEnc) return {};
  try {
    const parsed = JSON.parse(decrypt(valuesEnc)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : String(v ?? '');
    }
    return out;
  } catch (e) {
    logger.error('문서 제출값 복호화 실패', { message: (e as Error).message });
    return {};
  }
}

/** 항목 정의에 맞춰 입력값을 검증한다. */
export function validateValues(
  fields: DocumentField[],
  input: Record<string, string>,
): { ok: false; message: string } | { ok: true; values: Record<string, string> } {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const raw = (input[field.id] ?? '').trim().slice(0, VALUE_MAX);

    if (field.type === 'CHECKBOX') {
      const on = raw === 'on' || raw === 'true' || raw === '1' || raw === 'Y';
      if (field.required && !on) return { ok: false, message: `${field.label} 에 동의해 주세요.` };
      values[field.id] = on ? 'Y' : 'N';
      continue;
    }

    if (!raw) {
      if (field.required) return { ok: false, message: `${field.label} 을(를) 입력해 주세요.` };
      values[field.id] = '';
      continue;
    }

    if (field.type === 'NUMBER') {
      const cleaned = raw.replace(/,/g, '');
      if (!/^\d{1,15}$/.test(cleaned)) {
        return { ok: false, message: `${field.label} 은(는) 숫자만 입력해 주세요.` };
      }
      values[field.id] = cleaned;
      continue;
    }

    if (field.type === 'DATE') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return { ok: false, message: `${field.label} 은(는) 날짜를 골라 주세요.` };
      }
      values[field.id] = raw;
      continue;
    }

    if (field.type === 'PHONE') {
      const phone = normalizePhone(raw);
      if (!/^0\d{8,10}$/.test(phone)) {
        return { ok: false, message: `${field.label} 을(를) 확인해 주세요.` };
      }
      values[field.id] = phone;
      continue;
    }

    values[field.id] = raw;
  }
  return { ok: true, values };
}

/**
 * 서명 이미지를 저장한다.
 *
 * 화면에서 캔버스로 그린 PNG data URL 만 받는다. 후원자(비로그인)가 올리는 값이라
 * 형식·용량을 서버에서 다시 판정한다(/api/upload 는 사회복지기관 로그인이 필요해 쓸 수 없다).
 */
async function storeSignature(dataUrl: string): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) return { ok: false, message: '서명을 다시 그려 주세요.' };
  let buf: Buffer;
  try {
    buf = Buffer.from(m[1]!, 'base64');
  } catch {
    return { ok: false, message: '서명을 다시 그려 주세요.' };
  }
  if (buf.length > SIGNATURE_MAX_BYTES) return { ok: false, message: '서명 이미지가 너무 큽니다. 다시 그려 주세요.' };
  // 매직바이트로 PNG 인지 다시 본다. data URL 의 선언은 위조할 수 있다.
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
    return { ok: false, message: '서명을 다시 그려 주세요.' };
  }
  const url = await putObject(newObjectName('png'), buf, 'image/png');
  return { ok: true, url };
}

export interface SubmitDocumentInput {
  token: string;
  values: Record<string, string>;
  /** 캔버스로 그린 서명 PNG data URL. */
  signature?: string | null;
  ip?: string;
  userAgent?: string;
}

/**
 * 문서 제출.
 *
 * 한 번 제출하면 더 고칠 수 없다(전자문서 근거로 남는다). 정정은 사회복지기관에 연락해
 * 새 결제·새 문서로 처리한다 — 제출 내용을 덮어쓰게 두면 무엇을 근거로 승인했는지
 * 알 수 없게 된다.
 */
export async function submitDocument(
  input: SubmitDocumentInput,
): Promise<{ ok: true; submissionId: string } | { ok: false; message: string }> {
  const loaded = await loadDocumentContext(input.token);
  if (!loaded.ok) return { ok: false, message: loaded.reason };
  const ctx = loaded.ctx;

  if (ctx.status !== 'DRAFT') return { ok: false, message: '이미 제출한 문서입니다.' };

  const checked = validateValues(ctx.fields, input.values);
  if (!checked.ok) return { ok: false, message: checked.message };

  let signatureUrl: string | null = null;
  if (ctx.requireSignature) {
    if (!input.signature) return { ok: false, message: '서명란에 자필 서명을 해 주세요.' };
    const stored = await storeSignature(input.signature);
    if (!stored.ok) return { ok: false, message: stored.message };
    signatureUrl = stored.url;
  } else if (input.signature) {
    const stored = await storeSignature(input.signature);
    if (stored.ok) signatureUrl = stored.url;
  }

  // 제출 선점: DRAFT 일 때만 바뀐다. 같은 링크로 두 번 눌러도 한 번만 제출된다.
  const claimed = await prisma.documentSubmission.updateMany({
    where: { id: ctx.submissionId, status: 'DRAFT' },
    data: {
      status: 'SUBMITTED',
      submittedAt: new Date(),
      valuesEnc: encrypt(JSON.stringify(checked.values)),
      signatureUrl,
      submitIp: input.ip ?? null,
      submitAgent: input.userAgent?.slice(0, 300) ?? null,
    },
  });
  if (claimed.count === 0) return { ok: false, message: '이미 제출한 문서입니다.' };

  return { ok: true, submissionId: ctx.submissionId };
}

// ===========================================================================
// 콘솔 집계
// ===========================================================================

/** 사회복지기관 콘솔 뱃지·요약에 쓰는 문서 처리 대기 건수. */
export async function countPendingDocuments(merchantId: string): Promise<number> {
  return prisma.documentSubmission.count({ where: { merchantId, status: 'SUBMITTED' } });
}
