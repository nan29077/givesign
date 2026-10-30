'use client';

import * as React from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { revealEDocValuesAction, type RevealState } from '@/app/actions/edoc';

/** 서명자가 입력한 값을 누를 때만 복호화해 보여 준다. 열람할 때마다 감사로그·감사추적이 남는다. */
export function EDocReveal({ envelopeId }: { envelopeId: string }) {
  const [state, action, pending] = React.useActionState<RevealState, FormData>(revealEDocValuesAction, { ok: false });
  if (state.ok && state.rows) {
    return (
      <dl className="divide-y divide-ink-100 rounded-2xl border border-ink-100">
        {state.rows.map((r, i) => (
          <div key={i} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[180px_1fr]">
            <dt className="text-[12.5px] font-semibold text-ink-500">{r.label}</dt>
            <dd className="whitespace-pre-wrap break-words text-[13.5px] text-ink-900">{r.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="envelopeId" value={envelopeId} />
      <p className="text-[12.5px] leading-relaxed text-ink-500">입력값은 암호화되어 있습니다. 열람하면 열람자와 시각이 감사로그와 문서 감사추적에 남습니다.</p>
      <button type="submit" disabled={pending} className="inline-flex items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3.5 py-2 text-[13px] font-bold text-ink-700 hover:bg-ink-50 disabled:opacity-60">
        {pending ? <Loader2 size={16} strokeWidth={1.7} className="animate-spin" /> : <Eye size={16} strokeWidth={1.7} />} 입력값 열람
      </button>
      {state.message && !state.ok ? <p className="text-[12.5px] font-semibold text-danger-500">{state.message}</p> : null}
    </form>
  );
}
