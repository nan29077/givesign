'use client';

import * as React from 'react';
import Link from 'next/link';
import { UserPlus } from 'lucide-react';
import { Button, Field, Input, Notice, Checkbox } from '@/components/ui';
import { signupPayer, type SignupFormState } from '@/app/actions/auth';
import { GeneratedAvatar } from '@/components/profile/generated-avatar';

const initial: SignupFormState = { ok: false };

export function SignupForm() {
  const [state, formAction, pending] = React.useActionState(signupPayer, initial);

  return (
    <form action={formAction} className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-brand-200 bg-brand-50/70 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[13.5px] font-extrabold text-ink-900">나만의 캐릭터를 선물해 드려요</p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-500">가입이 완료되면 50종 중 하나가 무작위로 배정됩니다.</p>
          </div>
          <div className="flex -space-x-2" aria-hidden>
            {['preview-a', 'preview-b', 'preview-c'].map((seed) => (
              <GeneratedAvatar key={seed} seed={seed} className="h-10 w-10" />
            ))}
          </div>
        </div>
      </div>

      <Field label="이름" required hint="후원 내역 확인 시 사용할 이름입니다.">
        <Input name="name" required maxLength={20} defaultValue={state.values?.name} autoComplete="name" placeholder="홍길동" />
      </Field>

      <Field label="이메일" required>
        <Input
          type="email"
          name="email"
          required
          defaultValue={state.values?.email}
          autoComplete="email"
          inputMode="email"
          placeholder="givesign@example.com"
        />
      </Field>

      <Field label="비밀번호" required hint="8자 이상 입력해 주세요.">
        <Input type="password" name="password" required minLength={8} autoComplete="new-password" />
      </Field>

      <Field label="비밀번호 확인" required>
        <Input type="password" name="passwordConfirm" required minLength={8} autoComplete="new-password" />
      </Field>

      <div className="rounded-xl border border-ink-200 px-3 py-1">
        <Checkbox
          name="agreeTerms"
          label={
            <span>
              <Link href="/terms" className="font-semibold text-brand-700">
                이용약관
              </Link>
              과{' '}
              <Link href="/privacy" className="font-semibold text-brand-700">
                개인정보처리방침
              </Link>
              에 동의합니다. (필수)
            </span>
          }
          description="만 19세 이상만 가입할 수 있습니다."
        />
      </div>

      {state.message ? <Notice tone="warning">{state.message}</Notice> : null}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? '가입 중' : '회원가입'}
        <UserPlus size={16} strokeWidth={1.7} />
      </Button>
    </form>
  );
}
