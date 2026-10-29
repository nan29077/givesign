'use client';

import * as React from 'react';
import { Truck } from 'lucide-react';
import { Card, CardTitle, Field, Input, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { bulkShipAction } from '@/app/actions/studio';

/**
 * 송장 일괄 등록.
 *
 * 택배사에서 받은 발송 결과를 엑셀에서 그대로 붙여 넣을 수 있게 한다.
 * 한 건씩 저장하게 두면 하루 수십 건에서 반드시 빠뜨리는 주문이 생긴다.
 */
export function BulkShipPanel({ pendingCount, defaultCarrier }: { pendingCount: number; defaultCarrier: string }) {
  const [open, setOpen] = React.useState(false);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Truck size={16} strokeWidth={1.7} />
          </span>
          <div>
            <CardTitle>송장 일괄 등록</CardTitle>
            <p className="mt-0.5 text-[12px] text-ink-500">
              배송 준비 {pendingCount.toLocaleString('ko-KR')}건. 엑셀에서 복사해 붙여 넣으면 한 번에 발송 처리됩니다.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-xl border border-ink-200 px-3.5 py-2 text-[12.5px] font-bold text-ink-700 hover:bg-ink-50"
        >
          {open ? '닫기' : '열기'}
        </button>
      </div>

      {open ? (
        <div className="mt-4">
          <ActionForm action={bulkShipAction} submitLabel="일괄 발송 처리" variant="primary">
            <Field label="택배사" hint="이번에 등록하는 모든 건에 같은 택배사가 적용됩니다." required>
              <Input name="carrier" maxLength={30} defaultValue={defaultCarrier} placeholder="CJ대한통운" />
            </Field>
            <Field
              label="거래번호 · 송장번호"
              hint="한 줄에 한 건. 쉼표 · 탭 · 두 칸 이상 공백 모두 구분자로 인식합니다. 최대 200줄."
              required
            >
              <Textarea
                name="rows"
                rows={8}
                placeholder={'TRD-20260902-0001, 123456789012\nTRD-20260902-0002, 123456789013'}
                className="font-mono text-[13px]"
              />
            </Field>
            <label className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-700">
              <input type="checkbox" name="notify" defaultChecked className="h-4 w-4" />
              후원자에게 발송 안내 문자 보내기
            </label>
          </ActionForm>
        </div>
      ) : null}
    </Card>
  );
}
