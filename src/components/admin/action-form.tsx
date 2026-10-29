'use client';

import * as React from 'react';
import { Button, Notice, cx } from '@/components/ui';
import { initialAdminState, type AdminActionState } from './state';

/**
 * 관리자 화면 공용 액션 폼.
 * - 모든 변경은 서버 액션을 통해 수행하고 결과 메시지를 그 자리에서 보여준다.
 * - 되돌릴 수 없는 작업에는 confirm 문구를 반드시 지정한다.
 */

export type AdminServerAction = (
  prev: AdminActionState,
  formData: FormData,
) => Promise<AdminActionState>;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';

export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = '처리 중',
  variant = 'primary',
  confirm,
  className,
  disabled,
  compact = false,
}: {
  action: AdminServerAction;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: Variant;
  confirm?: string;
  className?: string;
  disabled?: boolean;
  /** true 이면 버튼과 메시지를 한 줄 크기로 압축해 표/목록 안에서 사용한다. */
  compact?: boolean;
}) {
  const [state, formAction, pending] = React.useActionState(action, initialAdminState);

  return (
    <form
      action={formAction}
      onSubmit={
        confirm
          ? (e) => {
              if (!window.confirm(confirm)) e.preventDefault();
            }
          : undefined
      }
      className={cx(compact ? 'flex flex-col items-start gap-1' : 'space-y-3', className)}
    >
      {children}
      <Button type="submit" variant={variant} size={compact ? 'sm' : 'md'} disabled={pending || disabled}>
        {pending ? pendingLabel : submitLabel}
      </Button>
      {state.message ? (
        compact ? (
          <span
            className={cx(
              'block max-w-[220px] text-[11px] leading-tight',
              state.ok ? 'text-success-500' : 'text-danger-500',
            )}
          >
            {state.message}
          </span>
        ) : (
          <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice>
        )
      ) : null}
    </form>
  );
}

/** 숨은 값 + 버튼 하나로 끝나는 단순 액션 (표 안에서 사용) */
export function ActionButton({
  action,
  values,
  label,
  variant = 'secondary',
  confirm,
  disabled,
  className,
}: {
  action: AdminServerAction;
  values: Record<string, string>;
  label: string;
  variant?: Variant;
  confirm?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <ActionForm action={action} submitLabel={label} variant={variant} confirm={confirm} disabled={disabled} compact className={className}>
      {Object.entries(values).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </ActionForm>
  );
}

/** 표 안에서 선택값 하나를 바꾸는 액션 (상태 변경 등) */
export function SelectActionForm({
  action,
  values,
  name,
  options,
  defaultValue,
  submitLabel = '변경',
  confirm,
  hint,
  disabled,
}: {
  action: AdminServerAction;
  values: Record<string, string>;
  name: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  defaultValue?: string;
  submitLabel?: string;
  confirm?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = React.useActionState(action, initialAdminState);

  return (
    <form
      action={formAction}
      onSubmit={
        confirm
          ? (e) => {
              if (!window.confirm(confirm)) e.preventDefault();
            }
          : undefined
      }
      className="flex flex-col gap-1"
    >
      {Object.entries(values).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div className="flex items-center gap-1.5">
        <select
          name={name}
          defaultValue={defaultValue}
          disabled={disabled}
          className="h-9 rounded-lg border border-ink-200 bg-white px-2 text-[13px] text-ink-900 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-ink-50 disabled:text-ink-400"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" variant="secondary" disabled={pending || disabled}>
          {pending ? '처리 중' : submitLabel}
        </Button>
      </div>
      {hint ? <span className="text-[11px] leading-tight text-ink-400">{hint}</span> : null}
      {state.message ? (
        <span className={cx('text-[11px] leading-tight', state.ok ? 'text-success-500' : 'text-danger-500')}>
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

/**
 * 실행 결과의 부가 정보(detail)를 함께 보여주는 폼.
 * MO 시뮬레이터처럼 실행 결과 자체가 화면 산출물인 경우에 사용한다.
 */
export function ActionFormWithDetail({
  disabled,
  action,
  children,
  submitLabel,
  detailLabels,
  confirm,
}: {
  action: AdminServerAction;
  children?: React.ReactNode;
  submitLabel: string;
  detailLabels: Record<string, string>;
  confirm?: string;
  /** 권한이 없어 어차피 거절될 동작은 눌리지 않게 한다. */
  disabled?: boolean;
}) {
  const [state, formAction, pending] = React.useActionState(action, initialAdminState);

  return (
    <form
      action={formAction}
      onSubmit={
        confirm
          ? (e) => {
              if (!window.confirm(confirm)) e.preventDefault();
            }
          : undefined
      }
      className="space-y-3"
    >
      {children}
      <Button type="submit" size="md" disabled={pending || disabled}>
        {pending ? '실행 중' : submitLabel}
      </Button>
      {state.message ? <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice> : null}
      {state.detail ? (
        <div className="rounded-xl border border-ink-100 bg-ink-50 p-3">
          {Object.entries(detailLabels).map(([key, label]) =>
            state.detail?.[key] ? (
              <div key={key} className="flex items-start justify-between gap-4 border-b border-ink-100 py-1.5 last:border-0">
                <span className="text-[12px] text-ink-400">{label}</span>
                <span className="text-right text-[12px] font-semibold break-all text-ink-900">{state.detail[key]}</span>
              </div>
            ) : null,
          )}
        </div>
      ) : null}
    </form>
  );
}
