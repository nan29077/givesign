'use client';

import * as React from 'react';
import { Badge, Button, Field, Input, Notice, Select } from '@/components/ui';
import { depositUploadAction, type DepositUploadState } from '@/app/actions/deposits';

const initial: DepositUploadState = { ok: false };

const MAP_FIELDS: Array<{ key: string; label: string; required?: boolean }> = [
  { key: 'map_date', label: '거래일시(또는 거래일자)', required: true },
  { key: 'map_time', label: '거래시간(따로 있을 때)' },
  { key: 'map_in', label: '입금액', required: true },
  { key: 'map_out', label: '출금액' },
  { key: 'map_name', label: '입금자(보낸 분·내용)' },
  { key: 'map_memo', label: '적요·메모' },
  { key: 'map_balance', label: '잔액' },
];

/**
 * 통장 거래내역 파일 올리기. 열을 알아보지 못하면 같은 화면에서 열을 고르고 같은 파일로 다시 올린다
 * (서버에 파일을 보관하지 않는다).
 */
export function DepositUploadForm() {
  const [state, action, pending] = React.useActionState(depositUploadAction, initial);
  const m = state.needsMapping;
  return (
    <form action={action} className="space-y-3.5">
      <Field label="거래내역 파일" hint="인터넷뱅킹에서 내려받은 CSV 또는 엑셀(.xlsx). 2MB·입금 5,000건까지. 예전 엑셀(.xls)은 CSV 로 저장해 올려 주세요. 출금 행과 계좌번호는 저장하지 않습니다.">
        <Input type="file" name="file" accept=".csv,.txt,.xlsx,text/csv" required className="pt-2.5" />
      </Field>

      {m ? (
        <div className="space-y-3 rounded-xl border border-warning-500/30 bg-warning-50 p-3.5">
          <input type="hidden" name="map_header" value={String(m.headerRow)} />
          <p className="text-[12.5px] text-ink-700">
            머리글로 보이는 줄({m.headerRow + 1}번째 줄)의 열입니다. 각 항목에 맞는 열을 고르세요.
          </p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {MAP_FIELDS.map((fd) => (
              <Field key={fd.key} label={fd.label} required={fd.required}>
                <Select name={fd.key} defaultValue="" required={fd.required}>
                  <option value="">{fd.required ? '열 고르기' : '없음'}</option>
                  {m.headers.map((h, i) => (
                    <option key={i} value={String(i)}>
                      {i + 1}열 · {h || '(빈 머리글)'}{m.sample[0]?.[i] ? ` — 예: ${m.sample[0][i]}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
        </div>
      ) : null}

      {state.message ? <Notice tone={state.ok ? 'success' : m ? 'warning' : 'danger'}>{state.message}</Notice> : null}

      {state.summary ? (
        <div className="flex flex-wrap gap-1.5 text-[12px]">
          <Badge tone="success">자동 확정 {state.summary.autoMatched}</Badge>
          <Badge tone="warning">확인 필요 {state.summary.suggested}</Badge>
          <Badge tone="neutral">모름 {state.summary.unmatched}</Badge>
          {state.summary.duplicateCount ? <Badge tone="neutral">이미 넣은 입금 {state.summary.duplicateCount}</Badge> : null}
          {state.summary.duplicateWarnings ? <Badge tone="danger">같은 날 같은 금액 {state.summary.duplicateWarnings}</Badge> : null}
          {state.summary.skippedCount ? <Badge tone="neutral">출금·빈 줄 {state.summary.skippedCount}</Badge> : null}
          {state.summary.errors.length ? (
            <span className="w-full text-[12px] text-danger-500">
              읽지 못한 줄: {state.summary.errors.slice(0, 5).map((e) => `${e.line}번째(${e.reason})`).join(', ')}
            </span>
          ) : null}
        </div>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? '읽는 중' : m ? '고른 열로 다시 올리기' : '파일 올리기'}
      </Button>
    </form>
  );
}
