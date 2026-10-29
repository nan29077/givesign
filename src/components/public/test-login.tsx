'use client';

import * as React from 'react';
import { ShieldCheck, UserCog, Radio, Heart } from 'lucide-react';
import { Card, CardTitle, Notice, cx } from '@/components/ui';
import { testLogin, type TestLoginState } from '@/app/actions/auth';

const initial: TestLoginState = {};

/**
 * 테스트 로그인 버튼 (개발·검수 전용).
 * 운영 환경에서는 이 컴포넌트를 렌더링하지 않으며, 서버 액션에서도 한 번 더 차단한다.
 */
export function TestLoginPanel({ seedAccounts }: { seedAccounts: { email: string; password: string }[] }) {
  const [state, formAction, pending] = React.useActionState(testLogin, initial);

  const buttons = [
    {
      account: 'admin',
      label: '최고관리자로 로그인',
      hint: '통합 관리자 · /admin',
      icon: <ShieldCheck size={17} strokeWidth={1.7} />,
      className: 'bg-brand-400 text-ink-900 hover:bg-brand-500',
    },
    {
      account: 'merchant',
      label: '사회복지기관 테스트 로그인',
      hint: '사회복지기관 관리자 · /studio',
      icon: <Radio size={17} strokeWidth={1.7} />,
      className: 'bg-ink-900 text-white hover:opacity-90',
    },
    {
      account: 'payer',
      label: '후원자 테스트 로그인',
      hint: '마이페이지 · /my',
      icon: <Heart size={17} strokeWidth={1.7} />,
      className: 'border border-ink-200 bg-white text-ink-900 hover:bg-ink-50',
    },
  ];

  return (
    <Card className="border border-warning-500/30 bg-warning-50">
      <div className="flex gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-warning-500">
          <UserCog size={17} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <CardTitle>테스트 로그인</CardTitle>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-700">
            비밀번호 없이 시드 계정으로 바로 들어갑니다. 개발·검수 환경에서만 표시되며 운영 환경에서는 노출되지
            않습니다.
          </p>

          <div className="mt-3 space-y-2">
            {buttons.map((b) => (
              <form action={formAction} key={b.account}>
                <input type="hidden" name="account" value={b.account} />
                <button
                  type="submit"
                  disabled={pending}
                  className={cx(
                    'flex h-12 w-full items-center justify-between gap-2 rounded-xl px-4 text-[14px] font-bold transition-colors',
                    'disabled:opacity-50',
                    b.className,
                  )}
                >
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    {b.icon}
                    {b.label}
                  </span>
                  <span className="hidden whitespace-nowrap text-[11.5px] font-medium opacity-80 sm:inline">
                    {b.hint}
                  </span>
                </button>
              </form>
            ))}
          </div>

          {state.message ? (
            <div className="mt-3">
              <Notice tone="danger">{state.message}</Notice>
            </div>
          ) : null}

          <details className="mt-3">
            <summary className="cursor-pointer list-none text-[12.5px] font-semibold text-ink-700">
              시드 계정 정보 보기
            </summary>
            <ul className="mt-2 space-y-1 font-mono text-[12.5px] text-ink-900">
              {seedAccounts.map((a) => (
                <li key={a.email}>
                  {a.email} / {a.password}
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>
    </Card>
  );
}
