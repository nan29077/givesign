'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FlaskConical, Loader2, MessageCircle } from 'lucide-react';
import { Checkbox, Field, Input } from '@/components/ui';
import {
  donorLoginAction,
  donorPhoneConfirmAction,
  donorPhoneRequestAction,
  donorSignupAction,
  donorTestLoginAction,
  donorWithdrawAction,
  type DonorAuthState,
  type DonorPhoneState,
} from '@/app/actions/donor-member';

/** 기관 후원 회원 폼 (로그인 · 가입 · 휴대폰 인증 · 탈퇴). 모든 폼은 기관 코드를 함께 보낸다. */

function Submit({ pending, label, color }: { pending: boolean; label: string; color: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-extrabold text-white shadow-md disabled:opacity-60"
      style={{ backgroundColor: color }}
    >
      {pending ? <Loader2 size={18} strokeWidth={1.8} className="animate-spin" /> : null}
      {label}
    </button>
  );
}

function ErrorLine({ message }: { message?: string }) {
  return message ? <p className="rounded-xl bg-danger-50 px-3.5 py-2.5 text-[13px] font-semibold text-danger-500">{message}</p> : null;
}

export function DonorLoginForm({ code, next, color }: { code: string; next: string; color: string }) {
  const [state, action, pending] = React.useActionState<DonorAuthState, FormData>(donorLoginAction, { ok: false });
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="next" value={next} />
      <Field label="이메일" required>
        <Input name="email" type="email" autoComplete="email" required defaultValue={state.values?.email ?? ''} />
      </Field>
      <Field label="비밀번호" required>
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      <ErrorLine message={state.ok ? undefined : state.message} />
      <Submit pending={pending} label="로그인" color={color} />
    </form>
  );
}

export function DonorSignupForm({ code, next, color, orgName }: { code: string; next: string; color: string; orgName: string }) {
  const [state, action, pending] = React.useActionState<DonorAuthState, FormData>(donorSignupAction, { ok: false });
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="next" value={next} />
      <Field label="이메일" required hint={`${orgName} 후원 회원 전용 계정입니다. 다른 기관과 따로 관리됩니다.`}>
        <Input name="email" type="email" autoComplete="email" required maxLength={120} defaultValue={state.values?.email ?? ''} />
      </Field>
      <Field label="이름" required>
        <Input name="name" autoComplete="name" required maxLength={20} defaultValue={state.values?.name ?? ''} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="비밀번호" required hint="8자 이상">
          <Input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} />
        </Field>
        <Field label="비밀번호 확인" required>
          <Input name="passwordConfirm" type="password" autoComplete="new-password" required minLength={8} maxLength={72} />
        </Field>
      </div>
      <div className="rounded-2xl border border-ink-100 bg-ink-50/60 px-3">
        <Checkbox
          name="agreeTerms"
          required
          label={
            <>
              [필수]{' '}
              <Link href="/terms" target="_blank" className="font-bold underline">이용약관</Link> 및{' '}
              <Link href="/privacy" target="_blank" className="font-bold underline">개인정보처리방침</Link>에 동의합니다
            </>
          }
        />
        <Checkbox name="agreeAge" required label="[필수] 만 19세 이상입니다" />
        <Checkbox name="marketing" label="[선택] 기관 소식·캠페인 결과를 받겠습니다" />
      </div>
      <ErrorLine message={state.ok ? undefined : state.message} />
      <Submit pending={pending} label="가입하기" color={color} />
    </form>
  );
}

export function DonorPhoneLinkForm({ code, color, phoneMasked }: { code: string; color: string; phoneMasked: string | null }) {
  const [sendState, send, sending] = React.useActionState<DonorPhoneState, FormData>(donorPhoneRequestAction, { ok: false });
  const [confirmState, confirm, confirming] = React.useActionState<DonorPhoneState, FormData>(donorPhoneConfirmAction, { ok: false });
  const router = useRouter();
  // 인증이 끝나면 아래 후원 내역·통계를 바로 다시 그린다(새로고침 없이).
  React.useEffect(() => {
    if (confirmState.linked) router.refresh();
  }, [confirmState.linked, router]);
  if (confirmState.linked) {
    return <p className="rounded-xl bg-[#eef6ef] px-3.5 py-3 text-[13px] font-semibold" style={{ color }}>{confirmState.message}</p>;
  }
  return (
    <div className="space-y-3">
      <form action={send} className="flex gap-2">
        <input type="hidden" name="code" value={code} />
        <Input name="phone" type="tel" inputMode="tel" placeholder={phoneMasked ? `현재 ${phoneMasked}` : '010-1234-5678'} required className="flex-1" />
        <button type="submit" disabled={sending} className="shrink-0 rounded-xl border border-ink-200 bg-white px-4 text-[13px] font-bold text-ink-700 disabled:opacity-60">
          {sendState.codeSent ? '다시 받기' : '인증번호 받기'}
        </button>
      </form>
      {sendState.message ? (
        <p className={sendState.ok ? 'text-[12.5px] text-ink-500' : 'text-[12.5px] font-semibold text-danger-500'}>
          {sendState.message}
          {sendState.devCode ? <span className="ml-1 font-mono font-bold text-ink-800">(테스트 인증번호 {sendState.devCode})</span> : null}
        </p>
      ) : null}
      {sendState.codeSent ? (
        <form action={confirm} className="flex gap-2">
          <input type="hidden" name="code" value={code} />
          <Input name="otp" inputMode="numeric" maxLength={6} placeholder="인증번호 6자리" required className="flex-1" />
          <button type="submit" disabled={confirming} className="shrink-0 rounded-xl px-4 text-[13px] font-extrabold text-white disabled:opacity-60" style={{ backgroundColor: color }}>
            확인
          </button>
        </form>
      ) : null}
      {confirmState.message && !confirmState.ok ? <p className="text-[12.5px] font-semibold text-danger-500">{confirmState.message}</p> : null}
    </div>
  );
}

export function DonorWithdrawForm({ code }: { code: string }) {
  const [state, action, pending] = React.useActionState<DonorAuthState, FormData>(donorWithdrawAction, { ok: false });
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="code" value={code} />
      <p className="text-[12.5px] leading-relaxed text-ink-500">
        탈퇴하면 이 기관의 후원 회원 정보(이메일·이름·인증한 번호)가 지워집니다. 이미 완료된 후원과 기부금영수증 기록은 법령에 따라 보관됩니다.
      </p>
      <div className="flex gap-2">
        <Input name="confirm" placeholder='확인을 위해 "탈퇴" 입력' className="flex-1" />
        <button type="submit" disabled={pending} className="shrink-0 rounded-xl border border-danger-500/40 bg-white px-4 text-[13px] font-bold text-danger-500 disabled:opacity-60">
          회원 탈퇴
        </button>
      </div>
      <ErrorLine message={state.ok ? undefined : state.message} />
    </form>
  );
}

/**
 * 카카오·네이버 간편 로그인 버튼. 이 기관 후원 회원으로만 로그인된다.
 * API 키 연결 전에는 누르면 로그인 화면으로 돌아와 "연동 준비 중" 안내가 나온다.
 */
export function DonorSocialButtons({ code, ready }: { code: string; ready: { kakao: boolean; naver: boolean } }) {
  const base = `/donate/${code}/social`;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-[11.5px] font-semibold text-ink-400">
        <span className="h-px flex-1 bg-ink-100" />
        간편 로그인
        <span className="h-px flex-1 bg-ink-100" />
      </div>
      <a href={`${base}/kakao`} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#FEE500] text-[14.5px] font-extrabold text-[#191600]">
        <MessageCircle size={18} strokeWidth={1.7} fill="currentColor" />
        카카오로 시작하기
      </a>
      <a href={`${base}/naver`} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#03C75A] text-[14.5px] font-extrabold text-white">
        <span className="grid h-[18px] w-[18px] place-items-center rounded-[4px] bg-white text-[12px] font-black leading-none text-[#03C75A]">N</span>
        네이버로 시작하기
      </a>
      {!ready.kakao || !ready.naver ? (
        <p className="text-center text-[11px] text-ink-400">
          {[!ready.kakao && '카카오', !ready.naver && '네이버'].filter(Boolean).join('·')} 간편 로그인은 API 연결 전입니다(연동 준비 중).
        </p>
      ) : null}
    </div>
  );
}

/** 기관 후원자 테스트 로그인(APP_ENV=local 에서만 그린다). */
export function DonorTestLoginButton({ code, next }: { code: string; next: string }) {
  const [state, action, pending] = React.useActionState<DonorAuthState, FormData>(donorTestLoginAction, { ok: false });
  return (
    <form action={action} className="rounded-2xl border border-warning-500/30 bg-warning-50 p-3">
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="next" value={next} />
      <button type="submit" disabled={pending} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink-900 text-[14px] font-extrabold text-white disabled:opacity-60">
        {pending ? <Loader2 size={16} strokeWidth={1.7} className="animate-spin" /> : <FlaskConical size={16} strokeWidth={1.7} />}
        기관 후원자 테스트 로그인
      </button>
      <p className="mt-1.5 text-center text-[11px] text-ink-500">개발·검수 환경 전용. 이 기관의 테스트 후원 회원으로 바로 들어갑니다.</p>
      <ErrorLine message={state.ok ? undefined : state.message} />
    </form>
  );
}
