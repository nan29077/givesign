import { beforeEach, describe, expect, it, vi } from 'vitest';

// 감사로그·세션은 요청 헤더·쿠키를 읽는다. 테스트에서는 빈 요청으로 대체한다.
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({ redirect: () => undefined }));
// 세션만 바꿔 끼우고 나머지(writeAudit·hashPassword 등)는 실제 구현을 쓴다.
const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/server/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/auth')>();
  return {
    ...real,
    getSessionUser: async () => session.user,
    requireMerchant: async () => {
      if (!session.user?.merchantId) throw new Error('사회복지기관 권한이 필요합니다.');
      return session.user;
    },
    destroySession: async () => undefined,
  };
});

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, maskPhone, tokenHash } from '@/lib/crypto';
import { verifyPassword } from '@/server/auth';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, type Fixture } from './helpers';
import {
  doneeVerified,
  issueReceipt,
  issueReceiptsBulk,
  receiptCandidates,
  residentHash,
  upsertReceiptProfile,
  ReceiptError,
  RECEIPT_PROFILE_DAILY_ATTEMPTS,
} from '@/server/services/receipts';
import { withdrawAccount } from '@/app/actions/payer';
import { revealDocumentSubmissionAction } from '@/app/actions/studio-documents';
import { DonorMemberError, donorSocialErrorMessage, DONOR_SOCIAL_ERRORS, loginDonorWithSocial } from '@/server/services/donor-members';
import { findGuestInquiry, newGuestInquiryToken, claimGuestInquiry } from '@/server/services/inquiry';

/**
 * 2026-11-05 점검 B(영수증·개인정보·인증) 조치 회귀 테스트.
 */

let fx: Fixture;
const year = new Date().getFullYear();
const RESIDENT_A = '900101-1234568';
const RESIDENT_B = '850505-1012344';

async function makeIssuer() {
  await prisma.merchantProfile.update({
    where: { id: fx.merchantId },
    data: {
      businessNo: '123-82-00001', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true,
      designatedDoneeVerifiedAt: new Date(), orgType: 'WELFARE_CORPORATION',
    },
  });
}

async function payerWithAccount(phone: string) {
  const payer = await seedRegisteredPayer(phone);
  const user = await prisma.user.create({ data: { id: newId(), email: `p-${newId()}@test.kr`, role: 'PAYER', name: '후원자' } });
  await prisma.payerProfile.update({ where: { id: payer.id }, data: { userId: user.id } });
  return { payer, user };
}

beforeEach(async () => {
  await resetDb();
  session.user = null;
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  await prisma.termsVersion.create({
    data: { id: newId(), type: 'RECEIPT_ISSUANCE', version: '1.0', title: '영수증 동의', content: '테스트', required: false, effectiveFrom: new Date('2026-01-01') },
  });
});

describe('H-5 탈퇴 시 영수증 정보', () => {
  it('[1] 탈퇴하면 영수증 정보가 지워지고 동의 철회가 남으며, 이미 발급된 영수증은 그대로다', async () => {
    const { payer, user } = await payerWithAccount(fx.payerPhone);
    await makeIssuer();
    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: RESIDENT_A, hometaxOptIn: true });
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원' }), fx.merchantId);
    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 't' });
    // 발급 뒤 새 후원 한 건(미발급)
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원2' }), fx.merchantId);

    session.user = { id: user.id, role: 'PAYER' };
    const fd = new FormData();
    fd.set('confirm', '탈퇴합니다');
    const r = await withdrawAccount({ ok: false }, fd);
    expect(r).toBeUndefined(); // redirect 로 끝난다(테스트에서는 no-op)

    expect(await prisma.payerReceiptProfile.count({ where: { payerId: payer.id } })).toBe(0);
    expect(
      await prisma.consentRecord.count({ where: { phoneHash: payer.phoneHash, type: 'RECEIPT_ISSUANCE', agreed: false } }),
    ).toBe(1);
    const kept = await prisma.donationReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(kept.status).toBe('ISSUED');
    expect(kept.residentNoEnc).toBe(receipt.residentNoEnc);

    // 발급 대기 목록에는 "탈퇴" 로 분리되고 발급되지 않는다.
    const cands = await receiptCandidates(fx.merchantId, year);
    expect(cands).toHaveLength(1);
    expect(cands[0].withdrawn).toBe(true);
    expect(cands[0].ready).toBe(false);
    await expect(issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 't' })).rejects.toThrow(/탈퇴/);
    const bulk = await issueReceiptsBulk(fx.merchantId, year, 't');
    expect(bulk.issued).toBe(0);
    expect(bulk.details[0]).toMatchObject({ status: 'SKIPPED', reason: '발급 불가(탈퇴)' });
  });

  it('[2] 영수증 정보가 남아 있는 옛 탈퇴 프로필도 발급하지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await makeIssuer();
    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: RESIDENT_A, hometaxOptIn: true });
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원' }), fx.merchantId);
    await prisma.payerProfile.update({ where: { id: payer.id }, data: { onboardingStatus: 'WITHDRAWN' } });
    await expect(issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 't' })).rejects.toBeInstanceOf(ReceiptError);
    expect((await receiptCandidates(fx.merchantId, year))[0]).toMatchObject({ withdrawn: true, ready: false });
  });
});

describe('주민등록번호 등록', () => {
  it('[3] resident_no_hash 는 DB 유니크다 — 확인을 건너뛴 동시 저장도 막힌다', async () => {
    const a = await seedRegisteredPayer(fx.payerPhone);
    const b = await seedRegisteredPayer('01099990002');
    expect((await upsertReceiptProfile(a.id, { legalName: '홍길동', residentNo: RESIDENT_A, hometaxOptIn: true })).ok).toBe(true);
    await expect(
      prisma.payerReceiptProfile.create({
        data: { payerId: b.id, legalName: '김철수', residentNoEnc: encrypt('9001011234568'), residentNoHash: residentHash('9001011234568'), residentNoMasked: '900101-1******' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('[4] 거절된 시도도 하루 시도 횟수에 들어간다', async () => {
    const a = await seedRegisteredPayer(fx.payerPhone);
    const b = await seedRegisteredPayer('01099990002');
    await upsertReceiptProfile(a.id, { legalName: '홍길동', residentNo: RESIDENT_A, hometaxOptIn: true });
    for (let i = 0; i < RECEIPT_PROFILE_DAILY_ATTEMPTS; i++) {
      const r = await upsertReceiptProfile(b.id, { legalName: '김철수', residentNo: RESIDENT_A, hometaxOptIn: true });
      expect(r).toMatchObject({ ok: false, message: expect.stringContaining('다른 계정') });
    }
    // 이제는 본인 번호여도, 중복 여부를 알려 주지 않고 시도 제한으로 거절한다.
    const r = await upsertReceiptProfile(b.id, { legalName: '김철수', residentNo: RESIDENT_B, hometaxOptIn: true });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('더 시도할 수 없습니다') });
    const r2 = await upsertReceiptProfile(b.id, { legalName: '김철수', residentNo: RESIDENT_A, hometaxOptIn: true });
    expect(r2.ok === false && r2.message).not.toContain('다른 계정');
  });

  it('[5] 마이그레이션이 중복으로 표시한 행(conflict:)은 발급하지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await makeIssuer();
    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: RESIDENT_A, hometaxOptIn: true });
    await prisma.payerReceiptProfile.update({ where: { payerId: payer.id }, data: { residentNoHash: `conflict:${payer.id}:${residentHash('9001011234568')}` } });
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원' }), fx.merchantId);
    expect((await receiptCandidates(fx.merchantId, year))[0]).toMatchObject({ conflict: true, ready: false });
    await expect(issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 't' })).rejects.toThrow(/중복/);
  });
});

describe('기관 콘솔 전화번호 원문 미노출', () => {
  it('[6] 문서 제출 원문 열람은 이름·작성 값은 원문, 전화번호는 마스킹으로만 돌려주고 감사로그를 남긴다', async () => {
    const t = await prisma.documentTemplate.create({ data: { id: newId(), merchantId: fx.merchantId, name: '신청서', templateType: 'EDITOR', body: 'x', requireSignature: false } });
    const sub = await prisma.documentSubmission.create({
      data: {
        id: newId(), templateId: t.id, merchantId: fx.merchantId, tokenHash: tokenHash(newId()), expiresAt: new Date(Date.now() + 86_400_000),
        payerNameEnc: encrypt('홍길동'), payerNameMasked: '홍*동', payerPhoneEnc: encrypt('01012345678'), payerPhoneMasked: maskPhone('01012345678'),
        valuesEnc: encrypt(JSON.stringify({ f1: '값' })), status: 'SUBMITTED', submittedAt: new Date(),
      },
    });
    session.user = { id: fx.merchantUserId, role: 'MERCHANT', merchantId: fx.merchantId };
    const r = await revealDocumentSubmissionAction(sub.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payerName).toBe('홍길동');
    expect(r.payerPhoneMasked).toBe('010-****-5678');
    expect(JSON.stringify(r)).not.toContain('01012345678');
    expect(await prisma.adminAuditLog.count({ where: { action: 'DOCUMENT_SUBMISSION_VIEW', targetId: sub.id } })).toBe(1);
  });
});

describe('기관 후원회원 간편 로그인 오류 문구', () => {
  it('[7] 화면 문구는 고정 코드 표로만 고르고, 임의 문구는 거절한다', async () => {
    expect(donorSocialErrorMessage('social_email_taken')).toBe(DONOR_SOCIAL_ERRORS.social_email_taken);
    expect(donorSocialErrorMessage('계정이 잠겼습니다. 010-0000-0000 로 연락')).toBeNull();
    expect(donorSocialErrorMessage('toString')).toBeNull();
    expect(DONOR_SOCIAL_ERRORS.social_email_taken).toContain('이메일 인증');
  });

  it('[8] 같은 이메일 회원이 있으면 합치지 않고 코드가 붙은 오류를 던진다', async () => {
    const org = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: fx.merchantId }, select: { id: true, code: true } });
    await prisma.donorMember.create({ data: { id: newId(), merchantId: org.id, email: 'a@test.kr', name: '선점', passwordHash: 'x', termsAgreedAt: new Date() } });
    const e = await loginDonorWithSocial(org, { provider: 'kakao', providerUserId: 'k-1', email: 'A@test.kr' }).catch((x) => x);
    expect(e).toBeInstanceOf(DonorMemberError);
    expect((e as DonorMemberError).code).toBe('social_email_taken');
  });
});

describe('인증·세션·문의 토큰', () => {
  it('[9] 비밀번호 해시가 없는 계정도 더미 비교를 거쳐 false', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
  });

  it('[10] 게스트 문의 토큰은 해시만 저장하고, 쿠키 원문으로 찾으며, 예전 ULID 쿠키도 인정한다', async () => {
    const g = newGuestInquiryToken();
    expect(g.stored).not.toBe(g.token);
    const row = await prisma.supportInquiry.create({ data: { id: newId(), guestToken: g.stored, status: 'OPEN', lastMessageAt: new Date() } });
    expect((await findGuestInquiry(g.token))?.id).toBe(row.id);
    expect(await findGuestInquiry(g.stored)).toBeNull();

    const legacy = newId();
    const old = await prisma.supportInquiry.create({ data: { id: newId(), guestToken: legacy, status: 'OPEN', lastMessageAt: new Date() } });
    expect((await findGuestInquiry(legacy))?.id).toBe(old.id);

    const user = await prisma.user.create({ data: { id: newId(), email: `u-${newId()}@test.kr`, role: 'PAYER' } });
    expect(await claimGuestInquiry(user.id, g.token)).toBe(row.id);
  });
});

describe('지정기부금단체 만료일 KST (점검 E)', () => {
  it('[11] KST 자정으로 저장한 만료일은 당일까지 유효, 다음 날 무효 — 예전 UTC 자정 값도 같은 날짜로 본다', () => {
    const base = { designatedDonee: true, designatedDoneeVerifiedAt: new Date() };
    const until = new Date('2026-12-31T00:00:00+09:00');
    // 만료 당일 KST 08:00 (UTC 로는 전날 23:00)
    expect(doneeVerified({ ...base, designatedDoneeUntil: until }, new Date('2026-12-31T08:00:00+09:00'))).toBe(true);
    expect(doneeVerified({ ...base, designatedDoneeUntil: until }, new Date('2026-12-31T23:59:00+09:00'))).toBe(true);
    expect(doneeVerified({ ...base, designatedDoneeUntil: until }, new Date('2027-01-01T00:01:00+09:00'))).toBe(false);
    const legacy = new Date('2026-12-31T00:00:00Z');
    expect(doneeVerified({ ...base, designatedDoneeUntil: legacy }, new Date('2026-12-31T23:59:00+09:00'))).toBe(true);
    expect(doneeVerified({ ...base, designatedDoneeUntil: legacy }, new Date('2027-01-01T00:01:00+09:00'))).toBe(false);
  });
});
