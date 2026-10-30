'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { consumeIpRateLimit } from '@/server/rate-limit';
import {
  DonorMemberError,
  confirmDonorPhoneOtp,
  findDonationOrg,
  getDonorMember,
  loginDonorMember,
  logoutDonorMember,
  requestDonorPhoneOtp,
  signupDonorMember,
  withdrawDonorMember,
} from '@/server/services/donor-members';
import { logger } from '@/lib/logger';

/**
 * 기관 후원페이지 회원 액션. 모든 액션은 폼의 기관 코드로 기관을 다시 찾고,
 * 세션도 그 기관 것만 인정한다(services/donor-members.ts).
 */

export interface DonorAuthState {
  ok: boolean;
  message?: string;
  values?: { email?: string; name?: string };
}

export interface DonorPhoneState {
  ok: boolean;
  message?: string;
  codeSent?: boolean;
  phoneMasked?: string;
  devCode?: string;
  linked?: boolean;
}

const s = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/** 로그인 뒤 돌아갈 곳은 같은 기관 후원페이지 안으로만 허용한다(열린 리다이렉트 방지). */
function safeNext(code: string, next: string) {
  const base = `/donate/${code}`;
  return next.startsWith(base) && !next.startsWith('//') ? next : `${base}/my`;
}

function publicMessage(e: unknown, fallback: string) {
  if (e instanceof DonorMemberError) return e.message;
  logger.error('후원 회원 처리 오류', { message: (e as Error)?.message });
  return fallback;
}

const signupSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('이메일 형식이 올바르지 않습니다.').max(120),
    name: z.string().trim().min(1, '이름을 입력해 주세요.').max(20, '이름은 20자 이내로 입력해 주세요.'),
    password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다.').max(72, '비밀번호는 72자 이내로 입력해 주세요.'),
    passwordConfirm: z.string(),
    agreeTerms: z.literal('on', { message: '이용약관과 개인정보처리방침에 동의해 주세요.' }),
    agreeAge: z.literal('on', { message: '만 19세 이상만 가입할 수 있습니다.' }),
  })
  .refine((v) => v.password === v.passwordConfirm, { message: '비밀번호가 서로 일치하지 않습니다.', path: ['passwordConfirm'] });

export async function donorSignupAction(_prev: DonorAuthState, f: FormData): Promise<DonorAuthState> {
  const code = s(f, 'code');
  const values = { email: s(f, 'email'), name: s(f, 'name') };
  const org = await findDonationOrg(code);
  if (!org) return { ok: false, message: '후원페이지를 찾을 수 없습니다.', values };
  const parsed = signupSchema.safeParse({
    email: values.email,
    name: values.name,
    password: String(f.get('password') ?? ''),
    passwordConfirm: String(f.get('passwordConfirm') ?? ''),
    agreeTerms: f.get('agreeTerms') ? 'on' : undefined,
    agreeAge: f.get('agreeAge') ? 'on' : undefined,
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.', values };
  const limited = await consumeIpRateLimit('donor-signup', 5, 60);
  if (!limited.ok) return { ok: false, message: '가입 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.', values };
  try {
    await signupDonorMember(org, { ...parsed.data, marketingAgreed: Boolean(f.get('marketing')) });
  } catch (e) {
    return { ok: false, message: publicMessage(e, '가입 처리 중 오류가 발생했습니다.'), values };
  }
  redirect(safeNext(org.code, s(f, 'next')));
}

export async function donorLoginAction(_prev: DonorAuthState, f: FormData): Promise<DonorAuthState> {
  const code = s(f, 'code');
  const values = { email: s(f, 'email') };
  const org = await findDonationOrg(code);
  if (!org) return { ok: false, message: '후원페이지를 찾을 수 없습니다.', values };
  if (!values.email || !f.get('password')) return { ok: false, message: '이메일과 비밀번호를 입력해 주세요.', values };
  const limited = await consumeIpRateLimit('donor-login', 20, 60);
  if (!limited.ok) return { ok: false, message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.', values };
  try {
    await loginDonorMember(org, values.email, String(f.get('password')));
  } catch (e) {
    return { ok: false, message: publicMessage(e, '로그인 처리 중 오류가 발생했습니다.'), values };
  }
  redirect(safeNext(org.code, s(f, 'next')));
}

export async function donorLogoutAction(f: FormData) {
  const org = await findDonationOrg(s(f, 'code'));
  if (org) await logoutDonorMember(org);
  redirect(org ? `/donate/${org.code}` : '/');
}

export async function donorPhoneRequestAction(_prev: DonorPhoneState, f: FormData): Promise<DonorPhoneState> {
  const org = await findDonationOrg(s(f, 'code'));
  const member = org ? await getDonorMember(org) : null;
  if (!org || !member) return { ok: false, message: '로그인이 필요합니다.' };
  try {
    const r = await requestDonorPhoneOtp(member, s(f, 'phone'));
    return { ok: true, codeSent: true, phoneMasked: r.phoneMasked, devCode: r.devCode, message: `${r.phoneMasked} 번호로 인증번호를 보냈습니다.` };
  } catch (e) {
    return { ok: false, message: publicMessage(e, '인증번호를 보내지 못했습니다.') };
  }
}

export async function donorPhoneConfirmAction(_prev: DonorPhoneState, f: FormData): Promise<DonorPhoneState> {
  const org = await findDonationOrg(s(f, 'code'));
  const member = org ? await getDonorMember(org) : null;
  if (!org || !member) return { ok: false, message: '로그인이 필요합니다.' };
  try {
    const masked = await confirmDonorPhoneOtp(member, s(f, 'otp'));
    revalidatePath(`/donate/${org.code}/my`);
    return { ok: true, linked: true, phoneMasked: masked, message: `${masked} 번호를 인증했습니다. 이 번호로 보낸 ${org.displayName} 후원 내역이 표시됩니다.` };
  } catch (e) {
    return { ok: false, codeSent: true, message: publicMessage(e, '인증하지 못했습니다.') };
  }
}

export async function donorWithdrawAction(_prev: DonorAuthState, f: FormData): Promise<DonorAuthState> {
  const org = await findDonationOrg(s(f, 'code'));
  const member = org ? await getDonorMember(org) : null;
  if (!org || !member) return { ok: false, message: '로그인이 필요합니다.' };
  if (s(f, 'confirm') !== '탈퇴') return { ok: false, message: '확인란에 "탈퇴"를 입력해 주세요.' };
  await withdrawDonorMember(member.id);
  await logoutDonorMember(org);
  redirect(`/donate/${org.code}?withdrawn=1`);
}
