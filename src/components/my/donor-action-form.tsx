'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice, cx } from '@/components/ui';
import type { DonorActionState } from '@/app/actions/donor';

type DonorAction = (prev: DonorActionState, f: FormData) => Promise<DonorActionState>;
const initial: DonorActionState = { ok: false };

/**
 * 마이페이지 공용 액션 폼(정기후원·영수증).
 * 성공 문구를 먼저 보여 주고 redirectTo 가 있으면 잠시 뒤 이동한다.
 */
export function DonorActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = '처리 중',
  variant = 'primary',
  size = 'md',
  confirmMessage,
  className,
  hideFormAfterSuccess = false,
}: {
  action: DonorAction;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  size?: 'sm' | 'md' | 'lg';
  confirmMessage?: string;
  className?: string;
  hideFormAfterSuccess?: boolean;
}) {
  const [state, formAction, pending] = React.useActionState(action, initial);
  const router = useRouter();
  React.useEffect(() => {
    if (!state.ok || !state.redirectTo) return;
    const t = setTimeout(() => router.push(state.redirectTo!), 600);
    return () => clearTimeout(t);
  }, [state, router]);

  if (state.ok && hideFormAfterSuccess) {
    return <Notice tone="success">{state.message}</Notice>;
  }
  return (
    <form
      action={formAction}
      className={cx('space-y-3', className)}
      onSubmit={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      {children}
      {state.message ? <Notice tone={state.ok ? 'success' : 'warning'}>{state.message}</Notice> : null}
      <Button type="submit" variant={variant} size={size} disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
