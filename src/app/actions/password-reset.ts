'use server';

import { z } from 'zod';
import {
  consumePasswordReset,
  requestPasswordReset,
} from '@/server/services/password-reset';
import { clientIpFromHeaders, consumeRateLimit } from '@/server/rate-limit';

/**
 * 비밀번호 재설정 서버 액션.
 *
 * 요청 화면은 가입 여부를 알려 주지 않는다(계정 열거 방지).
 * 어떤 입력이 와도 같은 안내 문구로 응답한다.
 */

export interface ResetRequestState {
  /** 요청이 접수되어 안내 화면으로 넘어갈지 */
  submitted: boolean;
  message?: string;
  /** 로컬(APP_ENV=local)에서만 채워지는 개발용 링크 */
  devLink?: string;
  values?: { email: string };
}

const emailSchema = z.string().trim().toLowerCase().email('이메일 형식이 올바르지 않습니다.');

export async function requestPasswordResetAction(
  _prev: ResetRequestState,
  formData: FormData,
): Promise<ResetRequestState> {
  const raw = String(formData.get('email') ?? '');
  const values = { email: raw.trim() };

  const parsed = emailSchema.safeParse(raw);
  if (!parsed.success) {
    return { submitted: false, message: parsed.error.issues[0]?.message, values };
  }

  // 메일 폭탄과 계정 존재 여부 탐색을 함께 막는다. (IP 분당 5회 / 이메일 시간당 5회)
  const ip = await clientIpFromHeaders();
  const [byIp, byEmail] = await Promise.all([
    consumeRateLimit('pwreset:ip', ip, 5, 60),
    consumeRateLimit('pwreset:email', parsed.data, 5, 3600),
  ]);
  if (!byIp.ok || !byEmail.ok) {
    return {
      submitted: false,
      message: '재설정 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
      values,
    };
  }

  const result = await requestPasswordReset(parsed.data, ip);
  return { submitted: result.accepted, devLink: result.devLink, values };
}

export interface ResetConfirmState {
  ok: boolean;
  message?: string;
}

const passwordSchema = z
  .object({
    password: z
      .string()
      .min(8, '비밀번호는 8자 이상이어야 합니다.')
      .max(72, '비밀번호는 72자 이내로 입력해 주세요.'),
    passwordConfirm: z.string(),
  })
  .refine((v) => v.password === v.passwordConfirm, {
    message: '비밀번호가 서로 일치하지 않습니다.',
    path: ['passwordConfirm'],
  });

export async function confirmPasswordResetAction(
  _prev: ResetConfirmState,
  formData: FormData,
): Promise<ResetConfirmState> {
  const token = String(formData.get('token') ?? '').trim();
  if (!token) return { ok: false, message: '유효하지 않은 링크입니다. 다시 요청해 주세요.' };

  const parsed = passwordSchema.safeParse({
    password: String(formData.get('password') ?? ''),
    passwordConfirm: String(formData.get('passwordConfirm') ?? ''),
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.' };
  }

  // 토큰 대입 공격 방지. 토큰 자체가 32바이트 난수지만 입구도 함께 조인다.
  const ip = await clientIpFromHeaders();
  // 재설정 토큰 대입을 막는 유일한 제한이다. 저장소 장애 때 열어 두면 안 된다.
  const limited = await consumeRateLimit('pwreset:confirm', ip, 20, 600, { failClosed: true });
  if (!limited.ok) {
    return { ok: false, message: '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' };
  }

  const result = await consumePasswordReset(token, parsed.data.password, ip);
  return { ok: result.ok, message: result.message };
}
