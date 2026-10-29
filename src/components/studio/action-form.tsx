'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice, cx } from '@/components/ui';
import { SecretBox } from '@/components/studio/copy';
import { ConfirmDialog, useConfirmSubmit } from '@/components/studio/confirm-dialog';
import type { StudioActionState } from '@/app/actions/studio';

/**
 * 사회복지기관 관리자 공용 액션 폼.
 * 서버 컴포넌트에서 필드를 children 으로 넘기고, 서버 액션을 그대로 전달한다.
 *
 * confirmMessage 를 주면 브라우저 기본 confirm 이 아니라 기브싸인 알림창을 띄우고,
 * 그 [확인] 을 눌러야 실제로 제출된다. 처리 결과도 같은 알림창에서 보여 준다.
 */

type StudioAction = (prev: StudioActionState, formData: FormData) => Promise<StudioActionState>;

const initial: StudioActionState = { ok: false };

/**
 * 액션이 redirectTo 를 돌려주면 그 화면으로 이동한다.
 *
 * 서버 액션 안에서 redirect() 를 부르면 결과 문구를 보여줄 새가 없이 화면이 바뀐다.
 * 그래서 문구를 먼저 렌더한 다음, 짧은 텀을 두고 이동한다.
 */
function useActionRedirect(state: StudioActionState) {
  const router = useRouter();
  React.useEffect(() => {
    if (!state.ok || !state.redirectTo) return;
    const t = setTimeout(() => router.push(state.redirectTo!), 700);
    return () => clearTimeout(t);
  }, [state, router]);
}

export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = '처리 중',
  variant = 'primary',
  size = 'md',
  confirmMessage,
  confirmTitle,
  confirmActionLabel,
  confirmVariant,
  doneTitle,
  className,
}: {
  action: StudioAction;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  size?: 'sm' | 'md' | 'lg';
  /** 있으면 기브싸인 알림창으로 한 번 물어본 뒤 제출한다. */
  confirmMessage?: string;
  /** 알림창 제목. 없으면 버튼 문구로 물어본다. */
  confirmTitle?: string;
  /** 알림창의 실행 버튼 문구. 없으면 [확인] */
  confirmActionLabel?: string;
  /** 되돌릴 수 없는 동작이면 danger 를 준다. */
  confirmVariant?: 'primary' | 'danger' | 'accent';
  /** 성공했을 때 알림창 제목. 없으면 [완료되었습니다] */
  doneTitle?: string;
  className?: string;
}) {
  const [state, formAction, pending] = React.useActionState(action, initial);
  const formRef = React.useRef<HTMLFormElement>(null);
  const confirm = useConfirmSubmit(formRef, state, pending);
  useActionRedirect(state);

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={(e) => {
        if (confirmMessage) confirm.onSubmit(e);
      }}
      className={cx('space-y-3.5', className)}
    >
      {children}

      {confirmMessage ? (
        <ConfirmDialog
          phase={confirm.phase}
          title={confirmTitle ?? `${submitLabel}할까요?`}
          description={confirmMessage}
          confirmLabel={confirmActionLabel ?? '확인'}
          busyLabel={pendingLabel}
          variant={confirmVariant ?? (variant === 'danger' ? 'danger' : 'primary')}
          doneOk={state.ok}
          doneTitle={state.ok ? doneTitle ?? '완료되었습니다' : '처리하지 못했습니다'}
          doneDescription={state.message}
          onConfirm={confirm.confirm}
          onClose={confirm.close}
        />
      ) : null}

      {state.secret ? (
        <SecretBox label={state.secretLabel ?? '발급된 값'} value={state.secret} hint={state.secretHint} />
      ) : null}

      {state.message ? (
        <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice>
      ) : null}

      <Button type="submit" variant={variant} size={size} disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}

/** 테이블 행 등에 들어가는 소형 액션 버튼 */
export function InlineActionForm({
  action,
  submitLabel,
  pendingLabel = '처리 중',
  variant = 'secondary',
  confirmMessage,
  fields,
  disabled,
  disabledReason,
}: {
  action: StudioAction;
  submitLabel: string;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  confirmMessage?: string;
  fields: Record<string, string>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, formAction, pending] = React.useActionState(action, initial);
  const formRef = React.useRef<HTMLFormElement>(null);
  const confirm = useConfirmSubmit(formRef, state, pending);
  useActionRedirect(state);

  if (disabled) {
    return <span className="text-[12px] text-ink-300">{disabledReason ?? '처리 불가'}</span>;
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={(e) => {
        if (confirmMessage) confirm.onSubmit(e);
      }}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}

      {/* 확인창은 화면 전체에서 한 가지 모양이어야 한다.
          여기만 브라우저 기본 confirm 을 쓰면 같은 페이지에 두 종류의 확인창이 뜬다. */}
      {confirmMessage ? (
        <ConfirmDialog
          phase={confirm.phase}
          title={`${submitLabel}할까요?`}
          description={confirmMessage}
          confirmLabel="확인"
          busyLabel={pendingLabel}
          variant={variant === 'danger' ? 'danger' : 'primary'}
          doneOk={state.ok}
          doneTitle={state.ok ? '완료되었습니다' : '처리하지 못했습니다'}
          doneDescription={state.message}
          onConfirm={confirm.confirm}
          onClose={confirm.close}
        />
      ) : null}

      <Button type="submit" variant={variant} size="sm" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>

      {/* 확인창이 있는 경우 결과는 그 안에서 보여 준다. 두 곳에 같은 문구가 뜨지 않게 한다. */}
      {state.message && !confirmMessage ? (
        <span className={cx('mt-1 block text-[11.5px] leading-snug', state.ok ? 'text-success-500' : 'text-danger-500')}>
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
