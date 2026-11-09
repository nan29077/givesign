import { prisma } from '@/server/db';
import { kv, consumeAttempt } from '@/server/redis';
import { decrypt, generateNumericCode, hmac, safeEqual } from '@/lib/crypto';
import { env, isLocal } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getMtAdapter } from '@/server/adapters/mt';
import { applyMtTemplateOverride, tplPhoneLinkVerify } from './mt-templates';

/**
 * 후원자 셀프서비스 본인 재확인 (2026-11-09 2차 F).
 *
 * 정기후원 변경·정지·해지 같은 돈과 관련된 조작은 로그인 상태만으로는 받지 않고, 이미 연결(인증)된 휴대폰 번호로
 * 인증번호를 한 번 더 받아 확인한다. 한 번 확인하면 10분 동안 유효하다(`STEP_UP_TTL_SEC`).
 *
 * 기존 휴대폰 인증 경로(phone-link.ts · donor-members.ts requestDonorPhoneOtp)와 같은 방식이다:
 *  - 인증번호 원문은 저장하지 않고 HMAC 만 서버측 KV 에 둔다. 클라이언트에는 검증값을 내려보내지 않는다.
 *  - 유효 5분, 오입력 5회면 폐기, 발송은 10분에 3회(대상·번호 각각).
 *  - 같은 인증 문자 템플릿(tplPhoneLinkVerify), 같은 MT 어댑터(mock 이면 비운영 화면에만 번호 표시).
 * 다른 점은 번호를 입력받지 않는다는 것 — 계정에 이미 연결된 번호로만 보낸다(번호 바꾸기는 기존 인증 화면).
 * 재확인 결과는 그 번호의 해시와 묶는다. 번호가 바뀌면 재확인도 무효다.
 *
 * 대상(subject):
 *  - { kind: 'USER', userId }     통합 후원자(/my). 번호 = 그 계정에 연결된 payer_profile 의 번호
 *  - { kind: 'MEMBER', memberId } 기관 후원 회원(/donate/[code]/my). 번호 = 그 회원이 인증한 번호
 */

export const STEP_UP_TTL_SEC = 600;
const OTP_TTL_SEC = 300;
const OTP_MAX_ATTEMPTS = 5;
const SEND_WINDOW_SEC = 600;
const SEND_MAX = 3;

export type StepUpSubject =
  | { kind: 'USER'; userId: string }
  | { kind: 'MEMBER'; memberId: string }
  /** 문자 명령 링크(/mo/[토큰], 2026-11-12 4차 K3). 번호 = 그 링크를 받은 번호(링크 유효 기간 안) */
  | { kind: 'SMS_LINK'; linkId: string };

export class StepUpError extends Error {}

/** 재확인이 필요한 조작에서 던진다(화면은 인증번호 입력을 띄운다). */
export class StepUpRequiredError extends Error {
  constructor() {
    super('본인 확인이 필요합니다. 휴대폰으로 받은 인증번호를 먼저 확인해 주세요.');
  }
}

const subjectKey = (s: StepUpSubject) => (s.kind === 'USER' ? `user:${s.userId}` : s.kind === 'MEMBER' ? `member:${s.memberId}` : `smslink:${s.linkId}`);
const otpKey = (s: StepUpSubject) => `selfsvc:otp:${subjectKey(s)}`;
const tryKey = (s: StepUpSubject) => `selfsvc:otp-try:${subjectKey(s)}`;
const grantKey = (s: StepUpSubject) => `selfsvc:grant:${subjectKey(s)}`;
const digest = (code: string) => hmac(`stepup:${code}`, env.crypto.sessionSecret);

/** 대상에 연결된 휴대폰 번호(해시·암호문·마스킹). 없으면 null. */
async function phoneOf(s: StepUpSubject): Promise<{ hash: string; enc: string; masked: string } | null> {
  if (s.kind === 'USER') {
    const p = await prisma.payerProfile.findUnique({ where: { userId: s.userId }, select: { phoneHash: true, phoneEnc: true, phoneMasked: true, onboardingStatus: true } });
    if (!p || p.onboardingStatus === 'WITHDRAWN' || !p.phoneEnc) return null;
    return { hash: p.phoneHash, enc: p.phoneEnc, masked: p.phoneMasked };
  }
  if (s.kind === 'SMS_LINK') {
    const link = await prisma.moReplyLink.findUnique({ where: { id: s.linkId }, select: { phoneHash: true, expiresAt: true } });
    if (!link || link.expiresAt.getTime() < Date.now()) return null;
    const p = await prisma.payerProfile.findUnique({ where: { phoneHash: link.phoneHash }, select: { phoneHash: true, phoneEnc: true, phoneMasked: true, onboardingStatus: true } });
    if (!p || p.onboardingStatus === 'WITHDRAWN' || !p.phoneEnc) return null;
    return { hash: p.phoneHash, enc: p.phoneEnc, masked: p.phoneMasked };
  }
  const m = await prisma.donorMember.findUnique({ where: { id: s.memberId }, select: { phoneHash: true, phoneEnc: true, phoneMasked: true, phoneVerifiedAt: true, status: true } });
  if (!m || m.status !== 'ACTIVE' || !m.phoneHash || !m.phoneEnc || !m.phoneVerifiedAt) return null;
  return { hash: m.phoneHash, enc: m.phoneEnc, masked: m.phoneMasked ?? '' };
}

/** 인증번호 보내기. 비운영 + mock 문자일 때만 devCode 를 돌려준다. */
export async function requestStepUp(s: StepUpSubject): Promise<{ phoneMasked: string; devCode?: string }> {
  const phone = await phoneOf(s);
  if (!phone) throw new StepUpError('인증된 휴대폰 번호가 없습니다. 먼저 휴대폰 번호를 인증해 주세요.');
  const [bySubject, byPhone] = await Promise.all([
    kv.incr(`selfsvc:otp-send:s:${subjectKey(s)}`, SEND_WINDOW_SEC),
    kv.incr(`selfsvc:otp-send:p:${phone.hash}`, SEND_WINDOW_SEC),
  ]);
  if (bySubject > SEND_MAX || byPhone > SEND_MAX) throw new StepUpError('인증번호 발송이 너무 잦습니다. 10분 후 다시 시도해 주세요.');
  const code = generateNumericCode(6);
  const adapter = getMtAdapter();
  const tpl = await applyMtTemplateOverride(tplPhoneLinkVerify(code));
  const sent = await adapter.send({ to: decrypt(phone.enc), text: tpl.text, templateCode: tpl.code });
  if (!sent.ok) throw new StepUpError('인증번호 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  await kv.set(otpKey(s), JSON.stringify({ ph: phone.hash, ch: digest(code) }), OTP_TTL_SEC);
  await kv.del(tryKey(s));
  logger.info('셀프서비스 본인 재확인 인증번호 발송', { subject: s.kind, phone: phone.masked });
  return { phoneMasked: phone.masked, devCode: isLocal && adapter.info().provider === 'mock' ? code : undefined };
}

/** 인증번호 확인 → 10분 동안 재확인 상태 */
export async function confirmStepUp(s: StepUpSubject, rawCode: string): Promise<{ expiresInSec: number }> {
  const code = rawCode.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) throw new StepUpError('인증번호 6자리를 입력해 주세요.');
  const raw = await kv.get(otpKey(s));
  if (!raw) throw new StepUpError('인증 유효시간이 지났습니다. 인증번호를 다시 받아 주세요.');
  let rec: { ph: string; ch: string };
  try {
    rec = JSON.parse(raw) as { ph: string; ch: string };
  } catch {
    await kv.del(otpKey(s));
    throw new StepUpError('인증 정보가 손상되었습니다. 인증번호를 다시 받아 주세요.');
  }
  if (!safeEqual(digest(code), rec.ch)) {
    const remain = await consumeAttempt(tryKey(s), OTP_MAX_ATTEMPTS, OTP_TTL_SEC);
    if (remain <= 0) {
      await kv.del(otpKey(s));
      await kv.del(tryKey(s));
      throw new StepUpError(`인증번호를 ${OTP_MAX_ATTEMPTS}회 잘못 입력했습니다. 처음부터 다시 시도해 주세요.`);
    }
    throw new StepUpError(`인증번호가 일치하지 않습니다. (남은 시도 ${remain}회)`);
  }
  await kv.del(otpKey(s));
  await kv.del(tryKey(s));
  const phone = await phoneOf(s);
  if (!phone || phone.hash !== rec.ph) throw new StepUpError('휴대폰 번호가 바뀌었습니다. 다시 시도해 주세요.');
  await kv.set(grantKey(s), JSON.stringify({ ph: phone.hash, at: Date.now() }), STEP_UP_TTL_SEC);
  return { expiresInSec: STEP_UP_TTL_SEC };
}

/** 지금 재확인 상태인가(10분 안, 같은 번호) */
export async function hasStepUp(s: StepUpSubject): Promise<boolean> {
  const raw = await kv.get(grantKey(s));
  if (!raw) return false;
  try {
    const g = JSON.parse(raw) as { ph: string };
    const phone = await phoneOf(s);
    return Boolean(phone && phone.hash === g.ph);
  } catch {
    return false;
  }
}

export async function assertStepUp(s: StepUpSubject): Promise<void> {
  if (!(await hasStepUp(s))) throw new StepUpRequiredError();
}

/** 재확인 상태를 지운다(로그아웃·번호 변경 등에서 쓸 수 있게) */
export async function clearStepUp(s: StepUpSubject): Promise<void> {
  await kv.del(grantKey(s));
}
