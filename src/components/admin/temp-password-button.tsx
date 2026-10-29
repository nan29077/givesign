'use client';

import * as React from 'react';
import { KeyRound } from 'lucide-react';
import { Button, cx } from '@/components/ui';
import { CopyButton } from '@/components/public/copy-button';
import { initialAdminState } from './state';
import type { AdminServerAction } from './action-form';

/**
 * 임시 비밀번호 발급 버튼 (회원 관리 표 안에서 사용).
 *
 * 발급된 비밀번호는 **이 화면에서 한 번만** 표시된다(서버는 해시만 저장한다).
 * 다른 액션 버튼과 달리 결과값 자체가 산출물이라 복사 버튼을 함께 둔다.
 */
export function TempPasswordButton({
  action,
  userId,
  label,
  disabled = false,
}: {
  action: AdminServerAction;
  userId: string;
  /** 확인 문구에 표시할 대상 (이메일 등) */
  label: string;
  /** 권한이 없으면 잠근다. 서버(issueTemporaryPasswordAction)도 같은 기준으로 막는다. */
  disabled?: boolean;
}) {
  const [state, formAction, pending] = React.useActionState(action, initialAdminState);
  const password = state.detail?.tempPassword;

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (
          !window.confirm(
            `${label} 계정에 임시 비밀번호를 발급합니다.\n` +
              '기존 비밀번호는 즉시 사용할 수 없게 되고 모든 기기에서 로그아웃됩니다.\n' +
              '본인 확인을 마친 뒤에만 진행해 주세요. 계속할까요?',
          )
        ) {
          e.preventDefault();
        }
      }}
      className="flex flex-col items-start gap-1"
    >
      <input type="hidden" name="userId" value={userId} />
      <Button type="submit" variant="secondary" size="sm" disabled={disabled || pending}>
        {pending ? '발급 중' : '임시 비밀번호'}
        <KeyRound size={15} strokeWidth={1.7} />
      </Button>

      {password ? (
        <div className="mt-1 w-[220px] rounded-lg border border-warning-500/30 bg-warning-50 p-2">
          <p className="text-[11px] font-bold text-ink-900">한 번만 표시됩니다</p>
          <p className="mt-1 break-all font-mono text-[13px] font-bold text-ink-900">{password}</p>
          <div className="mt-1.5">
            <CopyButton value={password} label="비밀번호" />
          </div>
        </div>
      ) : state.message ? (
        <span
          className={cx('block max-w-[220px] text-[11px] leading-tight', state.ok ? 'text-success-500' : 'text-danger-500')}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
