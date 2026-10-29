import { beforeEach, describe, expect, it, vi } from 'vitest';

// 감사로그(writeAudit)는 요청 헤더·쿠키를 읽는다. 테스트에서는 빈 요청으로 대체한다.
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { hashPassword } from '@/server/auth';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, type Fixture } from './helpers';
import {
  buildHometaxExport,
  deleteReceiptProfile,
  doneeVerified,
  issueReceipt,
  issuerReadiness,
  receiptByToken,
  upsertReceiptProfile,
  voidReceipt,
  ReceiptError,
  RECEIPT_PROFILE_DAILY_CHANGES,
} from '@/server/services/receipts';
import {
  consumeHometaxExportToken,
  issueHometaxExportToken,
  ExportGateError,
  HOMETAX_EXPORT_DAILY_LIMIT,
} from '@/server/services/hometax-export-gate';

/**
 * 기부금영수증 통제 (점검 M-6 ~ M-12).
 *  - 공익법인 지정은 관리자 확인이 있어야 하고 만료되면 무효
 *  - 홈택스 명세는 발급 당시 스냅샷으로 만든다
 *  - 같은 주민번호를 다른 계정에 등록할 수 없고, 하루 변경 횟수가 제한된다
 *  - 열람 링크는 만료되고, 무효 처리자와 사유를 나눠 기록한다
 *  - 명세 내려받기는 비밀번호·사유·1회용 토큰·하루 횟수 제한을 거친다
 */

let fx: Fixture;
const year = new Date().getFullYear();
const RESIDENT_A = '900101-1234568';
const RESIDENT_B = '850505-1012344';

async function seedContextualTerms() {
  await prisma.termsVersion.create({
    data: { id: newId(), type: 'RECEIPT_ISSUANCE', version: '1.0', title: '영수증 동의', content: '테스트', required: false, effectiveFrom: new Date('2026-01-01') },
  });
}

async function makeIssuer(over: Record<string, unknown> = {}) {
  await prisma.merchantProfile.update({
    where: { id: fx.merchantId },
    data: {
      businessNo: '123-82-00001', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true,
      designatedDoneeVerifiedAt: new Date(), orgType: 'WELFARE_CORPORATION', ...over,
    },
  });
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  await seedContextualTerms();
});

describe('공익법인 지정 확인 (M-8)', () => {
  it('[1] 기관이 체크만 하고 관리자 확인이 없으면 발급할 수 없고, 지정 기간이 지나면 다시 막힌다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: RESIDENT_A, hometaxOptIn: true });
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원' }), fx.merchantId);

    await makeIssuer({ designatedDoneeVerifiedAt: null });
    const m = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: fx.merchantId } });
    expect(issuerReadiness(m).missing).toContain('관리자의 공익법인 지정 확인');
    expect(doneeVerified(m)).toBe(false);
    await expect(issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 't' })).rejects.toBeInstanceOf(ReceiptError);

    await makeIssuer({ designatedDoneeUntil: new Date('2020-12-31T00:00:00Z') });
    const expired = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: fx.merchantId } });
    expect(doneeVerified(expired)).toBe(false);
    expect(issuerReadiness(expired).missing).toContain('공익법인 지정 기간(만료됨)');

    await makeIssuer({ designatedDoneeUntil: null });
    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 't' });
    expect(receipt.status).toBe('ISSUED');
  });
});

describe('후원자 영수증 정보 (M-10, M-11)', () => {
  it('[2] 다른 계정에 이미 등록된 주민등록번호는 거절한다', async () => {
    const a = await seedRegisteredPayer(fx.payerPhone);
    const b = await seedRegisteredPayer('01099990002');
    expect((await upsertReceiptProfile(a.id, { legalName: '홍길동', residentNo: RESIDENT_A, hometaxOptIn: true })).ok).toBe(true);
    const r = await upsertReceiptProfile(b.id, { legalName: '김철수', residentNo: RESIDENT_A, hometaxOptIn: true });
    expect(r.ok).toBe(false);
    // 본인 계정에서 같은 번호로 다시 저장하는 것은 된다.
    expect((await upsertReceiptProfile(a.id, { legalName: '홍길동', residentNo: RESIDENT_A, address: '서울', hometaxOptIn: true })).ok).toBe(true);
  });

  it('[3] 하루 변경 횟수를 넘으면 거절하고, 등록·삭제는 감사로그와 동의 철회 기록을 남긴다(주민번호 원문 없이)', async () => {
    const a = await seedRegisteredPayer(fx.payerPhone);
    for (let i = 0; i < RECEIPT_PROFILE_DAILY_CHANGES; i++) {
      expect((await upsertReceiptProfile(a.id, { legalName: '홍길동', residentNo: RESIDENT_A, hometaxOptIn: true })).ok).toBe(true);
    }
    expect((await upsertReceiptProfile(a.id, { legalName: '홍길동', residentNo: RESIDENT_A, hometaxOptIn: true })).ok).toBe(false);

    const logs = await prisma.adminAuditLog.findMany({ where: { action: 'RECEIPT_PROFILE_UPSERT', targetId: a.id } });
    expect(logs).toHaveLength(RECEIPT_PROFILE_DAILY_CHANGES);
    expect(JSON.stringify(logs.map((l) => l.afterValue))).not.toContain('1234568');

    await deleteReceiptProfile(a.id);
    expect(await prisma.payerReceiptProfile.count({ where: { payerId: a.id } })).toBe(0);
    expect(await prisma.consentRecord.count({ where: { phoneHash: a.phoneHash, type: 'RECEIPT_ISSUANCE', agreed: false } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { action: 'RECEIPT_PROFILE_DELETE', targetId: a.id } })).toBe(1);
  });
});

describe('발급·명세 (M-6, M-7, M-12)', () => {
  it('[4] 명세는 발급 당시 스냅샷으로 만든다 — 발급 뒤 정보를 바꾸거나 지워도 제출본은 같다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await makeIssuer();
    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: RESIDENT_A, address: '서울 중구', hometaxOptIn: true });
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원' }), fx.merchantId);
    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 't' });
    expect(receipt.residentNoEnc).toBeTruthy();

    // 발급 뒤 다른 번호로 바꾸고, 그다음 아예 삭제한다.
    await upsertReceiptProfile(payer.id, { legalName: '바뀐이름', residentNo: RESIDENT_B, hometaxOptIn: false });
    await deleteReceiptProfile(payer.id);

    const out = await buildHometaxExport(fx.merchantId, year, 't');
    expect(out.rows).toBe(1);
    expect(out.content).toContain('9001011234568');
    expect(out.content).toContain('홍길동');
    expect(out.content).not.toContain('바뀐이름');
    expect(out.content).not.toContain('8505051012344');
    // 기부 기간(시작·종료일)이 KST 날짜로 들어가고 1231 고정값을 쓰지 않는다.
    const header = out.content.split(/\r?\n/)[0];
    expect(header).toContain('기부시작일');
    const kst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
    expect(out.content).toContain(kst);
  });

  it('[5] 결제 성공이 아닌 건은 영수증에 묶이지 않는다 (상태 조건으로 바인딩)', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await makeIssuer();
    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: RESIDENT_A, hometaxOptIn: true });
    const a = await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: 'A' }), fx.merchantId);
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: 'B' }), fx.merchantId);
    // A 를 환불 상태로 바꾼 뒤 발급하면 B 만 들어간다.
    await prisma.charge.update({ where: { id: a.chargeId! }, data: { status: 'REFUNDED' } });
    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 't' });
    expect(receipt.chargeCount).toBe(1);
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: a.chargeId! } })).receiptId).toBeNull();
  });

  it('[6] 열람 링크는 만료되고, 무효 처리 사유와 처리자를 나눠 기록한다; 앞 공백을 지운 뒤에도 수식 주입을 막는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await makeIssuer();
    await upsertReceiptProfile(payer.id, { legalName: ' =cmd', residentNo: RESIDENT_A, hometaxOptIn: true });
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원' }), fx.merchantId);
    const { receipt, viewToken } = await issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 't' });
    expect(receipt.viewTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(await receiptByToken(viewToken)).not.toBeNull();
    expect(await receiptByToken(viewToken, new Date(Date.now() + 31 * 86_400_000))).toBeNull();

    const out = await buildHometaxExport(fx.merchantId, year, 't');
    expect(out.content).toContain("'=cmd");

    const v = await voidReceipt(receipt.id, '금액 정정', 'user-123');
    expect(v.voidReason).toBe('금액 정정');
    expect(v.voidedBy).toBe('user-123');
  });
});

describe('홈택스 명세 내려받기 관문 (M-9)', () => {
  async function merchantWithPassword() {
    await prisma.user.update({ where: { id: fx.merchantUserId }, data: { passwordHash: await hashPassword('pass-1234!') } });
    return { userId: fx.merchantUserId, merchantId: fx.merchantId, taxYear: year };
  }

  it('[7] 비밀번호·사유가 맞아야 토큰이 나오고, 토큰은 한 번만·본인·같은 연도로만 쓸 수 있다', async () => {
    const ctx = await merchantWithPassword();
    await expect(issueHometaxExportToken({ ...ctx, password: 'wrong', reason: '연말정산 제출' })).rejects.toBeInstanceOf(ExportGateError);
    await expect(issueHometaxExportToken({ ...ctx, password: 'pass-1234!', reason: '제출' })).rejects.toBeInstanceOf(ExportGateError);

    const token = await issueHometaxExportToken({ ...ctx, password: 'pass-1234!', reason: '연말정산 제출' });
    await expect(consumeHometaxExportToken(token, { ...ctx, taxYear: year - 1 })).rejects.toBeInstanceOf(ExportGateError);
    // 연도가 틀린 시도에서도 토큰은 소비된다(재사용 불가).
    await expect(consumeHometaxExportToken(token, ctx)).rejects.toBeInstanceOf(ExportGateError);

    const t2 = await issueHometaxExportToken({ ...ctx, password: 'pass-1234!', reason: '연말정산 제출' });
    expect((await consumeHometaxExportToken(t2, ctx)).reason).toBe('연말정산 제출');
    await expect(consumeHometaxExportToken(t2, ctx)).rejects.toBeInstanceOf(ExportGateError);
  });

  it('[8] 하루 생성 횟수를 넘으면 거절한다', async () => {
    const ctx = await merchantWithPassword();
    for (let i = 0; i < HOMETAX_EXPORT_DAILY_LIMIT; i++) {
      await issueHometaxExportToken({ ...ctx, password: 'pass-1234!', reason: '연말정산 제출' });
    }
    await expect(issueHometaxExportToken({ ...ctx, password: 'pass-1234!', reason: '연말정산 제출' })).rejects.toThrow(/하루/);
  });
});
