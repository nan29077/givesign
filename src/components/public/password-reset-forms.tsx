'use client';

import * as React from 'react';
import Link from 'next/link';
import { KeyRound, MailCheck, ShieldCheck } from 'lucide-react';
import { Button, Field, Input, LinkButton, Notice } from '@/components/ui';
import {
  confirmPasswordResetAction,
  requestPasswordResetAction,
  type ResetConfirmState,
  type ResetRequestState,
} from '@/app/actions/password-reset';

/**
 * 비밀번호 재설정 화면의 폼 두 가지.
 *
 *  1) RequestResetForm  — 이메일을 받아 재설정 링크를 발급한다.
 *  2) ConfirmResetForm  — 링크로 들어와 새 비밀번호를 지정한다.
 *
 * 규칙
 *  - 이모지를 쓰지 않는다. 아이콘은 lucide-react 라인 아이콘만 사용한다.
 *  - 가입 여부를 화면에서 구분해 보여 주지 않는다(계정 열거 방지).
 */

const requestInitial: ResetRequestState = { submitted: false };
const confirmInitial: ResetConfirmState = { ok: false };

export function RequestResetForm() {
  const [state, formAction, pending] = React.useActionState(requestPasswordResetAction, requestInitial);

  if (state.submitted) {
    return (
      <div className="space-y-3">
        <Notice tone="brand" title="재설정 안내를 보냈습니다">
          가입된 이메일이라면 재설정 링크가 발송됩니다. 링크는 발급 후 1시간 동안만 사용할 수 있고, 한 번 사용하면
          다시 쓸 수 없습니다. 메일이 오지 않으면 스팸함을 확인하거나 잠시 후 다시 요청해 주세요.
        </Notice>

        {state.devLink ? (
          <Notice tone="warning" title="[MOCK] 이메일 발송은 아직 연동 전입니다">
            <span className="block">
              메일 발송 대신 링크를 그대로 보여 줍니다. 이 안내는 로컬 개발 환경에서만 나타납니다.
            </span>
            <Link href={state.devLink} className="mt-2 block break-all font-semibold text-brand-700">
              {state.devLink}
            </Link>
          </Notice>
        ) : null}

        <p className="text-center text-[13px] text-ink-500">
          <Link href="/login" className="font-semibold text-brand-700">
            로그인 화면으로 돌아가기
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <Field label="가입한 이메일" required hint="가입 시 사용한 이메일 주소를 입력해 주세요.">
        <Input
          type="email"
          name="email"
          required
          autoComplete="email"
          inputMode="email"
          defaultValue={state.values?.email}
          placeholder="givesign@example.com"
        />
      </Field>

      {state.message ? <Notice tone="warning">{state.message}</Notice> : null}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? '요청 중' : '재설정 링크 받기'}
        <MailCheck size={16} strokeWidth={1.7} />
      </Button>

      <p className="text-center text-[13px] text-ink-500">
        비밀번호가 기억나셨나요{' '}
        <Link href="/login" className="font-semibold text-brand-700">
          로그인
        </Link>
      </p>
    </form>
  );
}

export function ConfirmResetForm({ token, emailMasked }: { token: string; emailMasked: string }) {
  const [state, formAction, pending] = React.useActionState(confirmPasswordResetAction, confirmInitial);

  if (state.ok) {
    return (
      <div className="space-y-3">
        <Notice tone="success" title="비밀번호를 변경했습니다">
          보안을 위해 이 계정의 기존 로그인 상태는 모두 해제되었습니다. 새 비밀번호로 다시 로그인해 주세요.
        </Notice>
        <LinkButton href="/login" size="lg">
          로그인하러 가기
          <ShieldCheck size={16} strokeWidth={1.7} />
        </LinkButton>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />

      <Field label="계정">
        <Input value={emailMasked} readOnly disabled />
      </Field>

      <Field label="새 비밀번호" required hint="8자 이상 입력해 주세요.">
        <Input type="password" name="password" required minLength={8} autoComplete="new-password" />
      </Field>

      <Field label="새 비밀번호 확인" required>
        <Input type="password" name="passwordConfirm" required minLength={8} autoComplete="new-password" />
      </Field>

      {state.message ? <Notice tone="warning">{state.message}</Notice> : null}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? '변경 중' : '비밀번호 변경'}
        <KeyRound size={16} strokeWidth={1.7} />
      </Button>
    </form>
  );
}
