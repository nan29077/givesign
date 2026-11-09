'use client';

import * as React from 'react';
import { Notice } from '@/components/ui';
import { optOutAction, saveRelationshipSettingAction, type RelationshipActionState } from '@/app/actions/relationship';

const initial: RelationshipActionState = { ok: false };

/** 기관 관계 안내 설정 폼(2026-11-13 5차 L4) */
export function RelationshipSettingForm({ enabled, kinds, options }: { enabled: boolean; kinds: string[]; options: Array<{ key: string; label: string; rule: string }> }) {
  const [state, action, pending] = React.useActionState(saveRelationshipSettingAction, initial);
  return (
    <form action={action} className="space-y-3">
      <label className="flex items-center gap-2 text-[14px] font-bold text-ink-900">
        <input type="checkbox" name="enabled" defaultChecked={enabled} className="h-4 w-4" /> 관계 안내 사용
      </label>
      <div className="space-y-2">
        {options.map((o) => (
          <label key={o.key} className="flex items-start gap-2 rounded-xl border border-ink-100 p-3 text-[13.5px]">
            <input type="checkbox" name="kinds" value={o.key} defaultChecked={kinds.includes(o.key)} className="mt-0.5 h-4 w-4" />
            <span><strong className="text-ink-900">{o.label}</strong><br /><span className="text-ink-500">{o.rule}</span></span>
          </label>
        ))}
      </div>
      <button type="submit" disabled={pending} className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-brand-400 text-[14px] font-extrabold text-ink-900 hover:bg-brand-500 disabled:bg-ink-100 sm:w-auto sm:px-6">
        {pending ? '저장 중' : '저장'}
      </button>
      {state.message ? <Notice tone={state.ok ? 'success' : 'warning'}>{state.message}</Notice> : null}
    </form>
  );
}

/** 무료 수신 거부 확인 버튼 */
export function OptOutForm({ token }: { token: string }) {
  const [state, action, pending] = React.useActionState(optOutAction, initial);
  if (state.ok) return <Notice tone="success">{state.message}</Notice>;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <button type="submit" disabled={pending} className="inline-flex h-14 w-full items-center justify-center rounded-2xl bg-brand-400 text-[17px] font-extrabold text-ink-900 hover:bg-brand-500 disabled:bg-ink-100">
        {pending ? '처리 중' : '수신 거부하기'}
      </button>
      {state.message ? <Notice tone="warning">{state.message}</Notice> : null}
    </form>
  );
}
