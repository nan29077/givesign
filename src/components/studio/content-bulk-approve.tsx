'use client';

import * as React from 'react';
import { CheckCheck } from 'lucide-react';
import { Button, Notice, Select } from '@/components/ui';
import type { StudioActionState } from '@/app/actions/studio';

type StudioAction = (prev: StudioActionState, formData: FormData) => Promise<StudioActionState>;

/**
 * 주간 묶음 승인 폼(2026-11-09). 카드의 체크박스는 `form={formId}` 로 이 폼에 붙는다(카드마다 반려·수정 요청 폼이 따로 있어 폼을 겹칠 수 없다).
 * 모바일에서 한 손으로 쓰게 화면 아래에 붙는 큰 버튼으로 둔다.
 */
export function ContentBulkApprove({ action, formId, total, hasPastDue }: { action: StudioAction; formId: string; total: number; hasPastDue: boolean }) {
  const [state, formAction, pending] = React.useActionState(action, { ok: false } as StudioActionState);
  const [selected, setSelected] = React.useState(0);

  React.useEffect(() => {
    const count = () => setSelected(document.querySelectorAll(`input[type=checkbox][form="${formId}"]:checked`).length);
    count();
    document.addEventListener('change', count);
    return () => document.removeEventListener('change', count);
  }, [formId, state]);

  const toggleAll = (on: boolean) => {
    document.querySelectorAll<HTMLInputElement>(`input[type=checkbox][form="${formId}"]`).forEach((el) => {
      if (!el.disabled) el.checked = on;
    });
    setSelected(on ? document.querySelectorAll(`input[type=checkbox][form="${formId}"]:checked`).length : 0);
  };

  return (
    <form id={formId} action={formAction} className="sticky bottom-0 z-10 -mx-4 mt-4 space-y-2 border-t border-ink-100 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border">
      {state.message ? <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => toggleAll(selected === 0)} disabled={total === 0}>
          {selected === 0 ? '모두 고르기' : '모두 풀기'}
        </Button>
        {hasPastDue ? (
          <label className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-600">
            <span className="shrink-0">게시 시각이 지난 건</span>
            <Select name="whenPast" defaultValue="NEXT_SLOT" className="h-9 min-w-0 text-[12.5px]">
              <option value="NEXT_SLOT">다음 빈 슬롯에 예약</option>
              <option value="NOW">지금 게시 예약</option>
              <option value="APPROVE_ONLY">승인만</option>
            </Select>
          </label>
        ) : null}
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={pending || selected === 0}>
        <CheckCheck size={18} strokeWidth={1.7} />
        {pending ? '승인하는 중' : `고른 ${selected}건 한 번에 승인`}
      </Button>
    </form>
  );
}
