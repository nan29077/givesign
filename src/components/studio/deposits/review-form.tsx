'use client';

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';
import { Badge, Button, Notice, Select } from '@/components/ui';
import { depositReviewAction } from '@/app/actions/deposits';
import type { StudioActionState } from '@/app/actions/studio';

const initial: StudioActionState = { ok: false };

export interface ReviewRow {
  id: string;
  occurredAt: string;
  depositorName: string;
  memo: string | null;
  amount: string;
  duplicateWarning: boolean;
  candidates: Array<{ key: string; name: string; phoneMasked: string; reason: 'EXACT' | 'SIMILAR' }>;
}

/**
 * 확인 필요 목록 — 체크한 입금을 한 번에 확정하거나 무시한다.
 * 후보가 여럿이면 행마다 고른다(기본은 첫 후보). 같은 날 같은 금액이 또 있는 입금은 경고를 붙인다.
 */
export function DepositReviewForm({ rows, campaigns }: { rows: ReviewRow[]; campaigns: Array<{ id: string; title: string }> }) {
  const [state, action, pending] = React.useActionState(depositReviewAction, initial);
  const [intent, setIntent] = React.useState<'confirm' | 'ignore'>('confirm');
  const [pickedRaw, setPicked] = React.useState<Set<string>>(new Set());
  // 처리 뒤 목록에서 사라진 행은 고른 것에서 뺀다(서버가 다시 그린 목록 기준).
  const picked = new Set([...pickedRaw].filter((id) => rows.some((r) => r.id === id)));
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set([...p].filter((x) => rows.some((r) => r.id === x)));
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOn = rows.length > 0 && picked.size === rows.length;

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="intent" value={intent} />
      <label className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-600">
        <input type="checkbox" className="h-4 w-4 rounded border-ink-300" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(rows.map((r) => r.id)))} />
        전체 선택 ({picked.size}/{rows.length})
      </label>
      <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
            <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
              <input type="checkbox" name="pick" value={r.id} checked={picked.has(r.id)} onChange={() => toggle(r.id)} className="mt-1 h-4 w-4 shrink-0 rounded border-ink-300" />
              <span className="min-w-0">
                <span className="block text-[13.5px] font-bold text-ink-900">
                  {r.depositorName} <span className="tabular-nums">{Number(r.amount).toLocaleString('ko-KR')}원</span>
                </span>
                <span className="block text-[11.5px] text-ink-400">
                  {r.occurredAt}
                  {r.memo ? ` · ${r.memo}` : ''}
                </span>
                {r.duplicateWarning ? (
                  <span className="mt-1 flex items-center gap-1 text-[11.5px] font-semibold text-warning-500">
                    <TriangleAlert size={14} strokeWidth={1.7} /> 같은 날 같은 이름·금액 입금이 또 있습니다. 두 번 낸 것인지 확인하세요.
                  </span>
                ) : null}
              </span>
            </label>
            <div className="w-full sm:w-[260px]">
              {r.candidates.length > 1 ? (
                <Select name={`cand_${r.id}`} defaultValue={r.candidates[0]!.key} aria-label="후원자 고르기" className="h-10 text-[12.5px]">
                  {r.candidates.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name} · {c.phoneMasked}
                      {c.reason === 'SIMILAR' ? ' (비슷한 이름)' : ''}
                    </option>
                  ))}
                </Select>
              ) : r.candidates[0] ? (
                <>
                  <input type="hidden" name={`cand_${r.id}`} value={r.candidates[0].key} />
                  <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-700">
                    <Badge tone={r.candidates[0].reason === 'EXACT' ? 'brand' : 'neutral'}>{r.candidates[0].reason === 'EXACT' ? '이름 일치' : '비슷한 이름'}</Badge>
                    {r.candidates[0].name} · {r.candidates[0].phoneMasked}
                  </span>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {campaigns.length ? (
        <label className="block text-[12.5px] text-ink-600">
          <span className="mb-1 block font-semibold">캠페인(선택) — 확정하는 입금 모두에 적용</span>
          <Select name="campaignId" defaultValue="" className="h-10 text-[12.5px]">
            <option value="">캠페인 없음</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
      {state.message ? <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || picked.size === 0} onClick={() => setIntent('confirm')}>
          {pending && intent === 'confirm' ? '확정 중' : `선택 ${picked.size}건 확정`}
        </Button>
        <Button type="submit" variant="secondary" disabled={pending || picked.size === 0} onClick={() => setIntent('ignore')}>
          {pending && intent === 'ignore' ? '처리 중' : '후원 아님(무시)'}
        </Button>
      </div>
    </form>
  );
}
