'use client';

import * as React from 'react';
import { CheckCheck, Clock3 } from 'lucide-react';
import { Badge, Card, CardTitle, cx } from '@/components/ui';
import { formatWon } from '@/lib/money';
import { ActionForm } from '@/components/studio/action-form';
import { markPointsGivenAction, markPointsHeldAction } from '@/app/actions/studio';

/**
 * 포인트 지급 대기 건 일괄 처리.
 *
 * 사회복지기관이 자기 서비스에 포인트를 넣은 뒤, 어떤 건을 처리했는지 여기서 한 번에 표시한다.
 * 건수가 많은 사회복지기관이 버튼을 수백 번 누르지 않도록 체크박스 + 일괄 처리로 만든다.
 */

export interface PendingChargeRow {
  id: string;
  transactionNo: string;
  receivedAt: string;
  amount: string;
  displayName: string;
  phoneMasked: string | null;
}

export function PointBulkPanel({ rows, total }: { rows: PendingChargeRow[]; total: number }) {
  const [selected, setSelected] = React.useState<string[]>([]);

  const allChecked = rows.length > 0 && selected.length === rows.length;
  const toggleAll = () => setSelected(allChecked ? [] : rows.map((r) => r.id));
  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));

  if (rows.length === 0) {
    return (
      <Card>
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-success-50 text-success-500">
            <CheckCheck size={17} strokeWidth={1.7} />
          </span>
          <div>
            <CardTitle>지급 대기 건이 없습니다</CardTitle>
            <p className="mt-0.5 text-[12.5px] text-ink-500">
              새 결제가 들어오면 여기에 쌓입니다. 포인트를 넣은 뒤 지급 완료로 표시해 주세요.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <p className="flex items-center gap-2 text-[13px] font-bold text-ink-900">
          <Clock3 size={16} strokeWidth={1.8} className="text-warning-500" />
          포인트 지급 대기
          <Badge tone="warning">{total}건</Badge>
        </p>
        <button
          type="button"
          onClick={toggleAll}
          className="text-[12.5px] font-bold text-brand-700 underline underline-offset-2"
        >
          {allChecked ? '선택 해제' : '이 화면 전체 선택'}
        </button>
      </div>

      <ul className="max-h-[320px] overflow-y-auto">
        {rows.map((r) => {
          const checked = selected.includes(r.id);
          return (
            <li key={r.id} className="border-b border-ink-100 last:border-0">
              <label
                className={cx(
                  'flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors',
                  checked ? 'bg-brand-50/60' : 'hover:bg-ink-50',
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(r.id)}
                  className="h-4 w-4 shrink-0"
                  aria-label={`${r.transactionNo} 선택`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-bold text-ink-900">
                    {r.displayName}
                    <span className="ml-1.5 font-medium text-ink-400">{r.phoneMasked ?? ''}</span>
                  </span>
                  <span className="block truncate font-mono text-[11.5px] text-ink-400">
                    {r.transactionNo} · {r.receivedAt}
                  </span>
                </span>
                <span className="shrink-0 text-[14px] font-extrabold tabular-nums text-ink-900">
                  {formatWon(BigInt(r.amount))}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="space-y-2 border-t border-ink-100 px-4 py-3">
        <p className="text-[12px] text-ink-500">
          선택 <b className="text-ink-900">{selected.length}</b>건
          {total > rows.length ? ` · 대기 ${total}건 중 최근 ${rows.length}건 표시` : null}
        </p>
        <div className="flex flex-wrap gap-2">
          <ActionForm
            action={markPointsGivenAction}
            submitLabel="선택 건 지급 완료"
            size="sm"
            confirmTitle="지급 완료로 표시할까요?"
            confirmMessage="내 서비스에 포인트를 이미 넣은 건만 표시해 주세요. 잘못 눌렀으면 되돌릴 수 있습니다."
            doneTitle="지급 완료로 표시했습니다"
          >
            {selected.map((id) => (
              <input key={id} type="hidden" name="chargeIds" value={id} />
            ))}
          </ActionForm>

          <ActionForm
            action={markPointsHeldAction}
            submitLabel="보류"
            variant="secondary"
            size="sm"
            confirmTitle="보류로 표시할까요?"
            confirmMessage="확인이 필요한 건을 따로 모아 둡니다. 사유는 필수입니다."
          >
            {selected.map((id) => (
              <input key={id} type="hidden" name="chargeIds" value={id} />
            ))}
            <input
              name="note"
              maxLength={100}
              placeholder="보류 사유 (예: 계정 확인 필요)"
              className="h-10 w-full rounded-xl border border-ink-200 px-3 text-[13px] outline-none focus:border-brand-400"
            />
          </ActionForm>
        </div>
      </div>
    </Card>
  );
}
