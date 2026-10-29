import { createHash } from 'node:crypto';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import {
  decrypt,
  encrypt,
  generateToken,
  hmac,
  isValidResident,
  maskResident,
  normalizeResident,
  tokenHash,
} from '@/lib/crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { PAID_STATUSES } from '@/components/studio/shared';
import { DONATION_CODES } from '@/lib/receipt-codes';
import { currentTermsDoc } from './terms';
import { writeAudit } from '@/server/auth';
import { sendMtForPayer } from './charge-flow';
import * as tpl from './mt-templates';
import type { Prisma } from '@/generated/prisma/client';

/**
 * 기부금영수증.
 *
 *  - 후원자 정보(성명·주민등록번호)는 암호화 + 해시 + 마스킹 3분리 저장 (절대 규칙 6).
 *  - 영수증은 결제 성공 건만, 환불 건 제외. 환불되면 VOID 후 재발급 (절대 규칙 9).
 *  - 발급 번호 {기관코드}-{연도}-{6자리}. 기관·연도별 일련번호는 기관 행을 잠그고 채번한다.
 *  - 국세청 제출: 전산매체 파일만 만든다. 전송은 기관이 홈택스에서 직접 한다 (절대 규칙 2).
 */

export { DONATION_CODES };

/** 주민등록번호 조회용 해시. 전화번호 해시와 같은 HMAC 비밀을 쓰되 접두어로 영역을 나눈다. */
export function residentHash(resident: string): string {
  return hmac(`resident:${resident}`);
}

function yearRange(taxYear: number) {
  return {
    gte: new Date(`${taxYear}-01-01T00:00:00+09:00`),
    lt: new Date(`${taxYear + 1}-01-01T00:00:00+09:00`),
  };
}

// ---------------------------------------------------------------------------
// 후원자 영수증 정보
// ---------------------------------------------------------------------------

export interface ReceiptProfileInput {
  legalName: string;
  residentNo: string;
  address?: string | null;
  hometaxOptIn: boolean;
  ip?: string;
  userAgent?: string;
}

export type ReceiptProfileResult = { ok: true } | { ok: false; message: string };

export async function upsertReceiptProfile(payerId: string, input: ReceiptProfileInput): Promise<ReceiptProfileResult> {
  const name = (input.legalName ?? '').trim();
  if (name.length < 2 || name.length > 30) return { ok: false, message: '성명은 2~30자로 입력해 주세요.' };
  const resident = normalizeResident(input.residentNo);
  if (!resident || !isValidResident(resident)) return { ok: false, message: '주민등록번호 13자리를 정확히 입력해 주세요.' };

  const payer = await prisma.payerProfile.findUnique({ where: { id: payerId } });
  if (!payer) return { ok: false, message: '후원자 정보를 찾을 수 없습니다.' };

  // 같은 주민등록번호가 다른 후원자 계정에 이미 등록돼 있으면 막는다. 타인의 번호로 등록하면
  // 그 사람 명의로 영수증이 발급되고 국세청 명세에 실리기 때문이다.
  // (실명 확인(본인인증) 계약 전이라 성명·번호 일치는 확인하지 못한다. 중복·변경 횟수로 막는다)
  const hash = residentHash(resident);
  const taken = await prisma.payerReceiptProfile.findFirst({
    where: { residentNoHash: hash, payerId: { not: payerId } },
    select: { payerId: true },
  });
  if (taken) {
    return { ok: false, message: '이미 다른 계정에 등록된 주민등록번호입니다. 본인 번호가 맞다면 고객센터로 문의해 주세요.' };
  }
  // 하루 변경 횟수 제한(번호를 바꿔 가며 시도하는 것을 막는다)
  const changesToday = await prisma.consentRecord.count({
    where: { phoneHash: payer.phoneHash, type: 'RECEIPT_ISSUANCE', agreed: true, createdAt: { gte: new Date(Date.now() - 86_400_000) } },
  });
  if (changesToday >= RECEIPT_PROFILE_DAILY_CHANGES) {
    return { ok: false, message: '영수증 정보는 하루 3번까지 바꿀 수 있습니다. 내일 다시 시도하거나 고객센터로 문의해 주세요.' };
  }

  const terms = await currentTermsDoc('RECEIPT_ISSUANCE');
  if (!terms) return { ok: false, message: '기부금영수증 동의 약관이 준비되지 않았습니다. 관리자에게 문의해 주세요.' };

  await prisma.$transaction(async (tx) => {
    const consent = await tx.consentRecord.create({
      data: {
        id: newId(),
        userId: payer.userId,
        phoneHash: payer.phoneHash,
        termsId: terms.id,
        type: 'RECEIPT_ISSUANCE',
        agreed: true,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
    const data = {
      legalName: name,
      residentNoEnc: encrypt(resident),
      residentNoHash: hash,
      residentNoMasked: maskResident(resident),
      address: (input.address ?? '').trim() || null,
      hometaxOptIn: input.hometaxOptIn,
      consentId: consent.id,
      consentAt: new Date(),
    };
    await tx.payerReceiptProfile.upsert({ where: { payerId }, create: { payerId, ...data }, update: data });
  });
  // 주민번호 원문·해시는 감사로그에 남기지 않는다. 등록 사실과 마스킹 값만.
  await writeAudit({
    action: 'RECEIPT_PROFILE_UPSERT',
    targetType: 'PayerReceiptProfile',
    targetId: payerId,
    after: { legalName: name, residentNoMasked: maskResident(resident), hometaxOptIn: input.hometaxOptIn },
  }).catch((e) => logger.warn('영수증 정보 감사로그 실패', { message: (e as Error).message }));
  return { ok: true };
}

/** 하루에 영수증 정보를 바꿀 수 있는 횟수 */
export const RECEIPT_PROFILE_DAILY_CHANGES = 3;

export async function getReceiptProfile(payerId: string) {
  const row = await prisma.payerReceiptProfile.findUnique({ where: { payerId } });
  if (!row) return null;
  // 암호문은 돌려주지 않는다. 화면은 마스킹 값만 쓴다.
  return {
    legalName: row.legalName,
    residentNoMasked: row.residentNoMasked,
    address: row.address,
    hometaxOptIn: row.hometaxOptIn,
    consentAt: row.consentAt,
    updatedAt: row.updatedAt,
  };
}

/** 동의 철회: 정보를 지우고 철회 기록을 남긴다. 이미 발급된 영수증 대장(스냅샷)은 법정 보유 기간 동안 남는다. */
export async function deleteReceiptProfile(payerId: string, meta: { ip?: string; userAgent?: string } = {}) {
  const [payer, terms] = await Promise.all([
    prisma.payerProfile.findUnique({ where: { id: payerId }, select: { userId: true, phoneHash: true } }),
    currentTermsDoc('RECEIPT_ISSUANCE'),
  ]);
  const removed = await prisma.payerReceiptProfile.deleteMany({ where: { payerId } });
  if (removed.count > 0 && payer && terms) {
    await prisma.consentRecord.create({
      data: {
        id: newId(), userId: payer.userId, phoneHash: payer.phoneHash, termsId: terms.id,
        type: 'RECEIPT_ISSUANCE', agreed: false, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null,
      },
    });
  }
  await writeAudit({ action: 'RECEIPT_PROFILE_DELETE', targetType: 'PayerReceiptProfile', targetId: payerId }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// 발급 대상·발급
// ---------------------------------------------------------------------------

export async function eligibleCharges(merchantId: string, payerId: string, taxYear: number) {
  return prisma.charge.findMany({
    where: {
      merchantId,
      payerId,
      isTest: false,
      status: { in: PAID_STATUSES },
      receiptId: null,
      paidAt: yearRange(taxYear),
    },
    orderBy: { paidAt: 'asc' },
    select: { id: true, transactionNo: true, paidAt: true, amount: true },
  });
}

/** 기관 콘솔용: 연도별 후원자별 미발급 합계와 발급 가능 여부(영수증 정보 등록 여부). */
export async function receiptCandidates(merchantId: string, taxYear: number) {
  const groups = await prisma.charge.groupBy({
    by: ['payerId'],
    where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, receiptId: null, paidAt: yearRange(taxYear), payerId: { not: null } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const payerIds = groups.map((g) => g.payerId!).filter(Boolean);
  const [payers, profiles] = await Promise.all([
    prisma.payerProfile.findMany({ where: { id: { in: payerIds } }, select: { id: true, displayName: true, phoneMasked: true } }),
    prisma.payerReceiptProfile.findMany({ where: { payerId: { in: payerIds } }, select: { payerId: true, legalName: true, hometaxOptIn: true } }),
  ]);
  const payerMap = new Map(payers.map((p) => [p.id, p]));
  const profMap = new Map(profiles.map((p) => [p.payerId, p]));
  return groups
    .map((g) => ({
      payerId: g.payerId!,
      displayName: payerMap.get(g.payerId!)?.displayName ?? '',
      phoneMasked: payerMap.get(g.payerId!)?.phoneMasked ?? '',
      legalName: profMap.get(g.payerId!)?.legalName ?? null,
      hometaxOptIn: profMap.get(g.payerId!)?.hometaxOptIn ?? null,
      ready: profMap.has(g.payerId!),
      amount: g._sum.amount ?? 0n,
      count: g._count._all,
    }))
    .sort((a, b) => Number(b.amount - a.amount));
}

export class ReceiptError extends Error {}

/**
 * 공익법인 지정이 지금 유효한가.
 * 기관의 자기 신고(designatedDonee)만으로는 부족하고 관리자 확인(designatedDoneeVerifiedAt)이 있어야 하며,
 * 지정 만료일이 지났으면 무효다. 공개 페이지의 "영수증 발급 가능" 표시도 이 판정을 쓴다.
 */
export function doneeVerified(
  m: { designatedDonee: boolean; designatedDoneeVerifiedAt?: Date | null; designatedDoneeUntil?: Date | null },
  now = new Date(),
) {
  if (!m.designatedDonee || !m.designatedDoneeVerifiedAt) return false;
  if (m.designatedDoneeUntil) {
    const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    if (m.designatedDoneeUntil.toISOString().slice(0, 10) < today) return false;
  }
  return true;
}

/** 기관이 영수증을 발급할 수 있는 상태인지. 발급 주체 정보가 비어 있으면 서식을 채울 수 없다. */
export function issuerReadiness(m: {
  businessNo: string | null;
  representativeName: string | null;
  address: string | null;
  designatedDonee: boolean;
  designatedDoneeVerifiedAt?: Date | null;
  designatedDoneeUntil?: Date | null;
}) {
  const missing: string[] = [];
  if (!m.businessNo) missing.push('고유번호(사업자등록번호)');
  if (!m.representativeName) missing.push('대표자');
  if (!m.address) missing.push('소재지');
  if (!m.designatedDonee) missing.push('공익법인(지정기부금단체) 지정 여부');
  else if (!m.designatedDoneeVerifiedAt) missing.push('관리자의 공익법인 지정 확인');
  else if (!doneeVerified(m)) missing.push('공익법인 지정 기간(만료됨)');
  return { ok: missing.length === 0, missing };
}

export interface IssueReceiptInput {
  merchantId: string;
  payerId: string;
  taxYear: number;
  issuedBy: string;
  /** 문자 안내 생략(일괄 발급 때 기관이 끄는 경우) */
  silent?: boolean;
}

export async function issueReceipt(input: IssueReceiptInput) {
  const [merchant, payer, profile, charges] = await Promise.all([
    prisma.merchantProfile.findUnique({ where: { id: input.merchantId } }),
    prisma.payerProfile.findUnique({ where: { id: input.payerId } }),
    prisma.payerReceiptProfile.findUnique({ where: { payerId: input.payerId } }),
    eligibleCharges(input.merchantId, input.payerId, input.taxYear),
  ]);
  if (!merchant) throw new ReceiptError('기관을 찾을 수 없습니다.');
  const readiness = issuerReadiness(merchant);
  if (!readiness.ok) throw new ReceiptError(`기관 정보가 부족합니다: ${readiness.missing.join(', ')}`);
  // 후원 내역 확인을 먼저 한다. 임의의 후원자 ID 로 "후원자 없음 / 정보 미등록" 을 구분해 볼 수 없게.
  if (charges.length === 0 || !payer) throw new ReceiptError('발급할 후원 내역이 없습니다(이미 발급됐거나 결제 성공 건이 없음).');
  if (!profile) throw new ReceiptError('후원자가 기부금영수증 정보(성명·주민등록번호)를 아직 등록하지 않았습니다.');

  const total = charges.reduce((s, c) => s + c.amount, 0n);
  const viewToken = generateToken(24);

  const receipt = await prisma.$transaction(async (tx) => {
    // 기관 행을 잠가 같은 기관·연도의 일련번호가 겹치지 않게 한다.
    await tx.$queryRaw`SELECT id FROM merchant_profile WHERE id = ${merchant.id} FOR UPDATE`;
    const last = await tx.donationReceipt.findFirst({
      where: { merchantId: merchant.id, taxYear: input.taxYear },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    const seq = (last?.seq ?? 0) + 1;
    const receiptNo = `${merchant.code}-${input.taxYear}-${String(seq).padStart(6, '0')}`;

    const created = await tx.donationReceipt.create({
      data: {
        id: newId(),
        merchantId: merchant.id,
        payerId: payer.id,
        taxYear: input.taxYear,
        seq,
        receiptNo,
        totalAmount: total,
        chargeCount: charges.length,
        donationCode: merchant.donationCode,
        donorSnapshot: {
          legalName: profile.legalName,
          residentNoMasked: profile.residentNoMasked,
          address: profile.address,
          hometaxOptIn: profile.hometaxOptIn,
        } as Prisma.InputJsonValue,
        issuerSnapshot: {
          name: merchant.displayName,
          businessNo: merchant.businessNo,
          representativeName: merchant.representativeName,
          address: merchant.address,
          orgType: merchant.orgType,
          code: merchant.code,
        } as Prisma.InputJsonValue,
        items: charges.map((c) => ({
          chargeId: c.id,
          transactionNo: c.transactionNo,
          paidAt: c.paidAt!.toISOString(),
          amount: c.amount.toString(),
        })) as Prisma.InputJsonValue,
        issuedBy: input.issuedBy,
        // 발급 당시 주민번호(암호문). 홈택스 명세는 이 값을 쓴다.
        residentNoEnc: profile.residentNoEnc,
        viewTokenHash: tokenHash(viewToken),
        viewTokenExpiresAt: new Date(Date.now() + RECEIPT_VIEW_TTL_DAYS * 86_400_000),
      },
    });

    // 포함한 건을 영수증에 묶는다. 읽은 뒤 사이에 환불되었거나(상태 변경) 다른 발급이 가로챘으면
    // (receipt_id 가 채워졌으면) 건수가 어긋난다. 그때는 트랜잭션 전체를 되돌린다(절대 규칙 9).
    const bound = await tx.charge.updateMany({
      where: { id: { in: charges.map((c) => c.id) }, receiptId: null, status: { in: PAID_STATUSES } },
      data: { receiptId: created.id },
    });
    if (bound.count !== charges.length) {
      throw new ReceiptError('발급하는 사이 후원 상태가 바뀌어(환불·다른 발급) 중단했습니다. 다시 시도해 주세요.');
    }
    return created;
  });

  let mtSent = false;
  if (!input.silent) {
    const link = `${env.baseUrl}/receipt/${viewToken}`;
    mtSent = await sendMtForPayer(
      payer.id,
      tpl.tplReceiptIssued({ merchantName: merchant.displayName, taxYear: input.taxYear, amount: total, link }),
      null,
      merchant.id,
    )
      .then((r) => Boolean(r))
      .catch((e) => {
        logger.warn('영수증 발급 안내 문자 실패', { message: (e as Error).message });
        return false;
      });
  }
  return { receipt, viewToken, mtSent };
}

/** 영수증 열람 링크 유효 기간(일). 지나면 마이페이지에서 다시 연다. */
export const RECEIPT_VIEW_TTL_DAYS = 30;

/** 사용자에게 보여 줄 수 있는 오류 문구로 바꾼다(Prisma 등 내부 오류 원문을 내보내지 않는다). */
function publicReason(e: unknown): string {
  if (e instanceof ReceiptError) return e.message;
  logger.error('영수증 발급 내부 오류', { message: (e as Error)?.message });
  return '처리 중 오류가 발생했습니다.';
}

/** 기관의 연도별 일괄 발급. 준비된(정보 등록된) 후원자만 발급하고 나머지는 건너뛴 이유를 돌려준다. */
export async function issueReceiptsBulk(merchantId: string, taxYear: number, issuedBy: string) {
  const candidates = await receiptCandidates(merchantId, taxYear);
  const result = { issued: 0, skipped: 0, failed: 0, details: [] as Array<{ payerId: string; status: 'ISSUED' | 'SKIPPED' | 'FAILED'; reason?: string; receiptNo?: string }> };
  for (const c of candidates) {
    if (!c.ready) {
      result.skipped += 1;
      result.details.push({ payerId: c.payerId, status: 'SKIPPED', reason: '영수증 정보 미등록' });
      continue;
    }
    try {
      const { receipt } = await issueReceipt({ merchantId, payerId: c.payerId, taxYear, issuedBy });
      result.issued += 1;
      result.details.push({ payerId: c.payerId, status: 'ISSUED', receiptNo: receipt.receiptNo });
    } catch (e) {
      result.failed += 1;
      result.details.push({ payerId: c.payerId, status: 'FAILED', reason: publicReason(e) });
    }
  }
  return result;
}

export async function voidReceipt(receiptId: string, reason: string, by: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.donationReceipt.findUnique({ where: { id: receiptId } });
    if (!r) throw new ReceiptError('영수증을 찾을 수 없습니다.');
    if (r.status === 'VOID') return r;
    await tx.charge.updateMany({ where: { receiptId }, data: { receiptId: null } });
    return tx.donationReceipt.update({
      where: { id: receiptId },
      // 사유와 처리자를 나눠 둔다. 사유는 후원자 화면에 보이지만 처리자 ID 는 보이면 안 된다.
      data: { status: 'VOID', voidedAt: new Date(), voidReason: reason.slice(0, 300), voidedBy: by },
    });
  });
}

/** 환불 승인 시: 환불된 건이 포함된 영수증을 무효화한다. 재발급은 기관이 나머지 건으로 다시 한다. */
export async function voidReceiptForRefundedCharge(chargeId: string, by = 'SYSTEM') {
  const charge = await prisma.charge.findUnique({ where: { id: chargeId }, select: { receiptId: true, transactionNo: true } });
  if (!charge?.receiptId) return null;
  const r = await voidReceipt(charge.receiptId, `후원 환불 ${charge.transactionNo}`, by);
  logger.info('기부금영수증 무효화 — 환불', { receiptId: r.id, receiptNo: r.receiptNo });
  return r;
}

/** 무효화된 영수증을 남은 유효 건으로 다시 발급하고 supersededById 를 잇는다. */
export async function reissueReceipt(receiptId: string, issuedBy: string) {
  const old = await prisma.donationReceipt.findUnique({ where: { id: receiptId } });
  if (!old) throw new ReceiptError('영수증을 찾을 수 없습니다.');
  if (old.status !== 'VOID') throw new ReceiptError('무효 처리된 영수증만 재발급할 수 있습니다.');
  if (old.supersededById) throw new ReceiptError('이미 재발급된 영수증입니다.');
  const issued = await issueReceipt({ merchantId: old.merchantId, payerId: old.payerId, taxYear: old.taxYear, issuedBy });
  await prisma.donationReceipt.update({ where: { id: old.id }, data: { supersededById: issued.receipt.id } });
  return issued;
}

// ---------------------------------------------------------------------------
// 열람
// ---------------------------------------------------------------------------

export async function receiptByToken(token: string, now = new Date()) {
  if (!token || token.length < 16) return null;
  return prisma.donationReceipt.findFirst({
    where: { viewTokenHash: tokenHash(token), OR: [{ viewTokenExpiresAt: null }, { viewTokenExpiresAt: { gt: now } }] },
    include: { merchant: { select: { displayName: true, code: true } } },
  });
}

/** 새 열람 토큰 발급(후원자가 링크를 잃었을 때 마이페이지에서). 이전 토큰은 무효가 된다. */
export async function rotateReceiptToken(receiptId: string, payerId: string) {
  const r = await prisma.donationReceipt.findFirst({ where: { id: receiptId, payerId } });
  if (!r) throw new ReceiptError('영수증을 찾을 수 없습니다.');
  const token = generateToken(24);
  await prisma.donationReceipt.update({
    where: { id: receiptId },
    data: { viewTokenHash: tokenHash(token), viewTokenExpiresAt: new Date(Date.now() + RECEIPT_VIEW_TTL_DAYS * 86_400_000) },
  });
  return token;
}

/** 후원자 마이페이지: 연도별 기관별 발급·미발급 요약 */
export async function payerReceiptOverview(payerId: string, taxYear: number) {
  const [issued, unreceipted] = await Promise.all([
    prisma.donationReceipt.findMany({
      where: { payerId, taxYear },
      orderBy: { issuedAt: 'desc' },
      include: { merchant: { select: { displayName: true, code: true } } },
    }),
    prisma.charge.groupBy({
      by: ['merchantId'],
      where: { payerId, isTest: false, status: { in: PAID_STATUSES }, receiptId: null, paidAt: yearRange(taxYear) },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);
  const merchantIds = unreceipted.map((u) => u.merchantId);
  const merchants = await prisma.merchantProfile.findMany({
    where: { id: { in: merchantIds } },
    select: {
      id: true, displayName: true, designatedDonee: true, designatedDoneeVerifiedAt: true, designatedDoneeUntil: true,
      businessNo: true, representativeName: true, address: true,
    },
  });
  const mm = new Map(merchants.map((m) => [m.id, m]));
  return {
    issued,
    pending: unreceipted.map((u) => {
      const m = mm.get(u.merchantId);
      return {
        merchantId: u.merchantId,
        merchantName: m?.displayName ?? '',
        amount: u._sum.amount ?? 0n,
        count: u._count._all,
        issuerReady: m ? issuerReadiness(m).ok : false,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 국세청(홈택스) 제출 명세
// ---------------------------------------------------------------------------

/**
 * 홈택스 "기부금영수증 발급명세서" 업로드용 CSV.
 *
 * 열 구성은 국세청 전산매체 신고 서식(기부금영수증 발급명세)을 기준으로 했으나, 연도별로
 * 서식이 바뀌므로 **제출 전 기관이 홈택스 변환 프로그램으로 검증해야 한다.** 이 파일은
 * 제출 자료를 준비하는 단계까지만 책임진다(절대 규칙 2).
 *
 * 주민등록번호는 이 함수 안에서만 복호화하며, 로그에 남기지 않는다.
 */
export const HOMETAX_CSV_COLUMNS = [
  '일련번호',
  '발급번호',
  '기부자성명',
  '기부자주민등록번호',
  '기부자주소',
  '기부금코드',
  '기부유형',
  '기부시작일',
  '기부종료일',
  '기부금액',
  '건수',
  '기부내용',
  '발급일자',
] as const;

function csvCell(v: string | number | bigint | null | undefined): string {
  const s = v == null ? '' : String(v);
  // 엑셀 수식 주입(=, +, -, @) 방지와 따옴표 이스케이프
  const guarded = /^[=+\-@\t\r\n]/.test(s) ? `'${s}` : s;
  return /[",\n\r\t]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function kstYmd(d: Date): string {
  return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
}

export async function buildHometaxExport(merchantId: string, taxYear: number, createdBy: string) {
  const merchant = await prisma.merchantProfile.findUnique({ where: { id: merchantId } });
  if (!merchant) throw new ReceiptError('기관을 찾을 수 없습니다.');
  const receipts = await prisma.donationReceipt.findMany({
    where: { merchantId, taxYear, status: 'ISSUED' },
    orderBy: { seq: 'asc' },
  });

  const lines: string[] = ['﻿' + HOMETAX_CSV_COLUMNS.join(',')];
  let rows = 0;
  let total = 0n;
  const skipped: string[] = [];
  for (const r of receipts) {
    // 발급 당시 스냅샷을 쓴다. 발급 뒤 후원자가 정보를 바꾸거나 지워도 제출본은 발급본과 같아야 한다.
    const donor = (r.donorSnapshot ?? {}) as { legalName?: string; address?: string | null; hometaxOptIn?: boolean };
    // 발급 당시 연말정산 간소화 제출에 동의하지 않은 영수증은 명세에서 뺀다(종이 영수증만 발급).
    if (donor.hometaxOptIn === false || !r.residentNoEnc) {
      skipped.push(r.receiptNo);
      continue;
    }
    rows += 1;
    total += r.totalAmount;
    const resident = decrypt(r.residentNoEnc);
    const items = (r.items as unknown as Array<{ paidAt?: string }> | null) ?? [];
    const dates = items
      .map((i) => (i.paidAt ? new Date(i.paidAt) : null))
      .filter((d): d is Date => !!d && !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    lines.push(
      [
        rows,
        r.receiptNo,
        donor.legalName ?? '',
        resident,
        donor.address ?? '',
        r.donationCode,
        DONATION_CODES[r.donationCode] ?? '',
        dates.length ? kstYmd(dates[0]) : '',
        dates.length ? kstYmd(dates[dates.length - 1]) : '',
        r.totalAmount.toString(),
        r.chargeCount,
        '금전(문자후원)',
        kstYmd(r.issuedAt),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  const content = lines.join('\r\n') + '\r\n';
  const checksum = createHash('sha256').update(content, 'utf8').digest('hex');
  const fileName = `hometax_donation_${merchant.code}_${taxYear}_${new Date().toISOString().slice(0, 10)}.csv`;
  await prisma.receiptExport.create({
    data: { id: newId(), merchantId, taxYear, format: 'HOMETAX_CSV', fileName, rowCount: rows, totalAmount: total, checksum, createdBy },
  });
  logger.info('홈택스 제출 명세 생성', { merchantId, taxYear, rows, skipped: skipped.length, checksum });
  return { fileName, content, rows, total, skipped, checksum };
}

export const receiptStatusLabel = {
  ISSUED: { text: '발급', tone: 'success' as const },
  VOID: { text: '무효', tone: 'danger' as const },
};
