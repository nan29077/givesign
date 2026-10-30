import { cookies, headers } from 'next/headers';
import bcrypt from 'bcryptjs';
import { prisma } from '@/server/db';
import { kv, consumeAttempt } from '@/server/redis';
import { clientIpFrom } from '@/server/rate-limit';
import { newId, normalizeMerchantCode } from '@/lib/id';
import { encrypt, generateNumericCode, generateToken, hmac, maskPhone, normalizePhone, phoneHash, safeEqual, tokenHash } from '@/lib/crypto';
import { addDays } from '@/lib/datetime';
import { env, isLocal } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getMtAdapter } from '@/server/adapters/mt';
import { applyMtTemplateOverride, tplPhoneLinkVerify } from '@/server/services/mt-templates';
import { PAID_STATUSES } from '@/components/studio/shared';
import type { DonorMemberStatus } from '@/generated/prisma/enums';

/**
 * 기관 후원페이지 전용 후원 회원.
 *
 * 원칙
 *  - 회원은 한 기관에만 속한다. 같은 이메일로 다른 기관에 따로 가입할 수 있고 서로 연결되지 않는다.
 *  - 쿠키는 기관 코드별로 따로 둔다(givesign_donor_<코드>). 세션 행에도 기관을 기록해 두고, 읽을 때
 *    요청한 기관과 다르면 로그인으로 보지 않는다. A 기관에서 로그인한 상태로 B 기관 페이지에 가면 비로그인이다.
 *  - 관리자·기관 담당자·기존 통합 후원자 계정(app_user / givesign_session)과 섞이지 않는다.
 *  - 회원 화면은 그 기관 후원만 보여 준다. 후원 내역 연결은 휴대폰 인증(phoneHash)으로만 한다.
 */

export const DONOR_SESSION_DAYS = 30;
const OTP_TTL_SEC = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_SEND_WINDOW_SEC = 600;
const OTP_SEND_MAX = 3;
const LOGIN_FAIL_WINDOW_SEC = 900;
const LOGIN_FAIL_MAX = 8;

/** 존재하지 않는 이메일에도 같은 시간이 걸리도록 비교에 쓰는 더미 해시(계정 존재 여부 노출 방지). */
const DUMMY_HASH = bcrypt.hashSync('givesign-donor-dummy', 10);

export class DonorMemberError extends Error {}

export function donorCookieName(code: string) {
  return `givesign_donor_${normalizeMerchantCode(code).replace(/[^A-Z0-9]/g, '')}`;
}

export function normalizeEmail(raw: string) {
  return raw.trim().toLowerCase();
}

/** 공개 후원페이지가 열리는(승인·활성) 기관만 회원 가입·로그인을 받는다. */
export async function findDonationOrg(code: string) {
  return prisma.merchantProfile.findFirst({
    where: { code: normalizeMerchantCode(code), status: 'APPROVED', user: { status: 'ACTIVE', deletedAt: null } },
    select: { id: true, code: true, displayName: true, avatarUrl: true },
  });
}

async function issueSession(memberId: string, merchant: { id: string; code: string }) {
  const token = generateToken(32);
  const h = await headers();
  await prisma.donorSession.create({
    data: {
      id: newId(),
      memberId,
      merchantId: merchant.id,
      tokenHash: tokenHash(token),
      ip: clientIpFrom((n) => h.get(n)),
      userAgent: h.get('user-agent')?.slice(0, 300) ?? null,
      expiresAt: addDays(new Date(), DONOR_SESSION_DAYS),
    },
  });
  const jar = await cookies();
  jar.set(donorCookieName(merchant.code), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && env.baseUrl.startsWith('https'),
    path: '/',
    maxAge: DONOR_SESSION_DAYS * 86400,
  });
  await prisma.donorMember.update({ where: { id: memberId }, data: { lastLoginAt: new Date() } });
}

export interface DonorViewer {
  id: string;
  name: string;
  email: string;
  avatarIndex: number;
  phoneMasked: string | null;
  phoneVerified: boolean;
  merchantId: string;
}

/** 이 기관 후원페이지의 로그인 회원. 다른 기관 세션·정지·탈퇴·만료는 모두 null. */
export async function getDonorMember(org: { id: string; code: string }): Promise<DonorViewer | null> {
  const jar = await cookies();
  const token = jar.get(donorCookieName(org.code))?.value;
  if (!token) return null;
  const s = await prisma.donorSession.findUnique({ where: { tokenHash: tokenHash(token) }, include: { member: true } });
  if (!s || s.revokedAt || s.expiresAt < new Date()) return null;
  // 세션과 회원이 모두 이 기관 소속이어야 한다.
  if (s.merchantId !== org.id || s.member.merchantId !== org.id) return null;
  if (s.member.status !== 'ACTIVE') return null;
  return {
    id: s.member.id,
    name: s.member.name,
    email: s.member.email,
    avatarIndex: s.member.avatarIndex,
    phoneMasked: s.member.phoneMasked,
    phoneVerified: Boolean(s.member.phoneVerifiedAt),
    merchantId: s.member.merchantId,
  };
}

export async function signupDonorMember(
  org: { id: string; code: string },
  input: { email: string; name: string; password: string; marketingAgreed: boolean },
) {
  const email = normalizeEmail(input.email);
  const exists = await prisma.donorMember.findUnique({ where: { merchantId_email: { merchantId: org.id, email } }, select: { id: true } });
  if (exists) throw new DonorMemberError('이 기관에 이미 가입된 이메일입니다. 로그인해 주세요.');
  const id = newId();
  try {
    await prisma.donorMember.create({
      data: {
        id,
        merchantId: org.id,
        email,
        name: input.name.trim(),
        passwordHash: await bcrypt.hash(input.password, 10),
        marketingAgreed: input.marketingAgreed,
        termsAgreedAt: new Date(),
      },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') throw new DonorMemberError('이 기관에 이미 가입된 이메일입니다. 로그인해 주세요.');
    throw e;
  }
  await issueSession(id, org);
  return id;
}

export async function loginDonorMember(org: { id: string; code: string }, rawEmail: string, password: string) {
  const email = normalizeEmail(rawEmail);
  const failKey = `donor:login-fail:${org.id}:${hmac(email, env.crypto.sessionSecret)}`;
  const fails = Number((await kv.get(failKey)) ?? 0);
  if (fails >= LOGIN_FAIL_MAX) throw new DonorMemberError('로그인 시도가 너무 많습니다. 15분 뒤에 다시 시도해 주세요.');

  const member = await prisma.donorMember.findUnique({ where: { merchantId_email: { merchantId: org.id, email } } });
  const ok = await bcrypt.compare(password, member?.passwordHash || DUMMY_HASH);
  if (!member || !ok) {
    await kv.incr(failKey, LOGIN_FAIL_WINDOW_SEC);
    throw new DonorMemberError('이메일 또는 비밀번호가 맞지 않습니다.');
  }
  if (member.status === 'SUSPENDED') throw new DonorMemberError('이용이 정지된 회원입니다. 기관 또는 고객센터로 문의해 주세요.');
  if (member.status !== 'ACTIVE') throw new DonorMemberError('이메일 또는 비밀번호가 맞지 않습니다.');
  await kv.del(failKey);
  await issueSession(member.id, org);
  return member.id;
}

export async function logoutDonorMember(org: { code: string }) {
  const jar = await cookies();
  const name = donorCookieName(org.code);
  const token = jar.get(name)?.value;
  if (token) await prisma.donorSession.updateMany({ where: { tokenHash: tokenHash(token), revokedAt: null }, data: { revokedAt: new Date() } });
  jar.delete(name);
}

/** 탈퇴: 개인정보를 지우고 세션을 끊는다. 행은 감사·통계용으로 남긴다(같은 이메일로 다시 가입할 수 있게 이메일은 비운다). */
export async function withdrawDonorMember(memberId: string) {
  await prisma.$transaction([
    prisma.donorMember.update({
      where: { id: memberId },
      data: {
        status: 'WITHDRAWN',
        withdrawnAt: new Date(),
        email: `withdrawn+${memberId}@deleted.local`,
        name: '탈퇴 회원',
        passwordHash: '',
        phoneHash: null,
        phoneEnc: null,
        phoneMasked: null,
        phoneVerifiedAt: null,
        marketingAgreed: false,
      },
    }),
    prisma.donorSession.updateMany({ where: { memberId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
}

// ---------------------------------------------------------------- 휴대폰 인증(후원 내역 연결)

interface OtpRecord { ph: string; pe: string; pm: string; ch: string }
const otpKey = (memberId: string) => `donor:otp:${memberId}`;
const otpTryKey = (memberId: string) => `donor:otp-try:${memberId}`;
const codeDigest = (code: string) => hmac(code, env.crypto.sessionSecret);

export async function requestDonorPhoneOtp(member: DonorViewer, rawPhone: string) {
  const phone = normalizePhone(rawPhone);
  if (!/^01[0-9]{8,9}$/.test(phone)) throw new DonorMemberError('휴대전화 번호 형식을 확인해 주세요. (예: 010-1234-5678)');
  const ph = phoneHash(phone);
  const [byMember, byPhone] = await Promise.all([
    kv.incr(`donor:otp-send:m:${member.id}`, OTP_SEND_WINDOW_SEC),
    kv.incr(`donor:otp-send:p:${ph}`, OTP_SEND_WINDOW_SEC),
  ]);
  if (byMember > OTP_SEND_MAX || byPhone > OTP_SEND_MAX) throw new DonorMemberError('인증번호 발송이 너무 잦습니다. 10분 후 다시 시도해 주세요.');
  const taken = await prisma.donorMember.findFirst({ where: { merchantId: member.merchantId, phoneHash: ph, id: { not: member.id } }, select: { id: true } });
  if (taken) throw new DonorMemberError('이 기관의 다른 회원이 이미 인증한 번호입니다. 기관 또는 고객센터로 문의해 주세요.');

  const code = generateNumericCode(6);
  const adapter = getMtAdapter();
  const tpl = await applyMtTemplateOverride(tplPhoneLinkVerify(code));
  const sent = await adapter.send({ to: phone, text: tpl.text, templateCode: tpl.code });
  if (!sent.ok) throw new DonorMemberError('인증번호 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  const rec: OtpRecord = { ph, pe: encrypt(phone), pm: maskPhone(phone), ch: codeDigest(code) };
  await kv.set(otpKey(member.id), JSON.stringify(rec), OTP_TTL_SEC);
  await kv.del(otpTryKey(member.id));
  logger.info('후원 회원 휴대폰 인증번호 발송', { memberId: member.id, phone: rec.pm });
  return { phoneMasked: rec.pm, devCode: isLocal && adapter.info().provider === 'mock' ? code : undefined };
}

export async function confirmDonorPhoneOtp(member: DonorViewer, rawCode: string) {
  const code = rawCode.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) throw new DonorMemberError('인증번호 6자리를 입력해 주세요.');
  const raw = await kv.get(otpKey(member.id));
  if (!raw) throw new DonorMemberError('인증 유효시간이 지났습니다. 인증번호를 다시 요청해 주세요.');
  const rec = JSON.parse(raw) as OtpRecord;
  if (!safeEqual(codeDigest(code), rec.ch)) {
    const remain = await consumeAttempt(otpTryKey(member.id), OTP_MAX_ATTEMPTS, OTP_TTL_SEC);
    if (remain <= 0) {
      await kv.del(otpKey(member.id));
      throw new DonorMemberError(`인증번호를 ${OTP_MAX_ATTEMPTS}회 잘못 입력했습니다. 처음부터 다시 시도해 주세요.`);
    }
    throw new DonorMemberError(`인증번호가 일치하지 않습니다. (남은 시도 ${remain}회)`);
  }
  await kv.del(otpKey(member.id));
  await kv.del(otpTryKey(member.id));
  try {
    await prisma.donorMember.update({
      where: { id: member.id },
      data: { phoneHash: rec.ph, phoneEnc: rec.pe, phoneMasked: rec.pm, phoneVerifiedAt: new Date() },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') throw new DonorMemberError('이 기관의 다른 회원이 이미 인증한 번호입니다.');
    throw e;
  }
  return rec.pm;
}

// ---------------------------------------------------------------- 회원 화면 데이터(이 기관 것만)

export async function donorMemberOverview(member: { id: string; merchantId: string }) {
  const m = await prisma.donorMember.findUniqueOrThrow({ where: { id: member.id }, select: { phoneHash: true } });
  if (!m.phoneHash) return { linked: false as const, charges: [], total: 0n, count: 0, recurring: [], receipts: [] };
  const payer = await prisma.payerProfile.findUnique({ where: { phoneHash: m.phoneHash }, select: { id: true } });
  if (!payer) return { linked: true as const, charges: [], total: 0n, count: 0, recurring: [], receipts: [] };
  const where = { payerId: payer.id, merchantId: member.merchantId, isTest: false, status: { in: PAID_STATUSES } };
  const [charges, agg, recurring, receipts] = await Promise.all([
    prisma.charge.findMany({
      where,
      orderBy: { paidAt: 'desc' },
      take: 50,
      select: { id: true, transactionNo: true, amount: true, message: true, paidAt: true, channel: true, anonymous: true, campaign: { select: { title: true } } },
    }),
    prisma.charge.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
    prisma.recurringDonation.findMany({
      where: { payerId: payer.id, merchantId: member.merchantId, status: { in: ['ACTIVE', 'PAUSED', 'SUSPENDED'] } },
      select: { id: true, amount: true, dayOfMonth: true, status: true, nextChargeOn: true },
    }),
    prisma.donationReceipt.findMany({
      where: { payerId: payer.id, merchantId: member.merchantId, status: 'ISSUED' },
      orderBy: { taxYear: 'desc' },
      select: { id: true, receiptNo: true, taxYear: true, totalAmount: true },
    }),
  ]);
  return { linked: true as const, charges, total: agg._sum.amount ?? 0n, count: agg._count._all, recurring, receipts };
}

// ---------------------------------------------------------------- 관리

export async function setDonorMemberStatus(memberId: string, status: Extract<DonorMemberStatus, 'ACTIVE' | 'SUSPENDED'>, note: string | null) {
  const m = await prisma.donorMember.findUniqueOrThrow({ where: { id: memberId }, select: { status: true } });
  if (m.status === 'WITHDRAWN') throw new DonorMemberError('탈퇴한 회원은 상태를 바꿀 수 없습니다.');
  await prisma.$transaction([
    prisma.donorMember.update({ where: { id: memberId }, data: { status, adminNote: note } }),
    ...(status === 'SUSPENDED'
      ? [prisma.donorSession.updateMany({ where: { memberId, revokedAt: null }, data: { revokedAt: new Date() } })]
      : []),
  ]);
  return m.status;
}
