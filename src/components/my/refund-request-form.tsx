'use client';

import * as React from 'react';
import { Undo2 } from 'lucide-react';
import { Button, Textarea, Notice } from '@/components/ui';
import { requestChargeRefund, type PayerActionState } from '@/app/actions/payer';

const initial: PayerActionState = { ok: false };

/**
 * 결제 건별 환불 요청.
 * - 이미 요청된 건은 버튼이 비활성화된다.
 * - 소유권 검증은 서버 액션에서 다시 수행한다.
 */
export function RefundRequestForm({
  chargeId,
  disabled,
  disabledReason,
}: {
  chargeId: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, formAction, pending] = React.useActionState(requestChargeRefund, initial);

  if (disabled) {
    return (
      <Button type="button" variant="ghost" size="sm" disabled title={disabledReason}>
        <Undo2 size={15} strokeWidth={1.7} />
        {disabledReason ?? '환불 요청 불가'}
      </Button>
    );
  }

  if (state.ok) {
    return (
      <p className="rounded-lg bg-success-50 px-3 py-2 text-[12.5px] font-semibold text-success-500">
        {state.message}
      </p>
    );
  }

  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-[12.5px] font-semibold text-ink-700 hover:bg-ink-50">
        <Undo2 size={15} strokeWidth={1.7} />
        환불 요청
      </summary>
      <form action={formAction} className="mt-2 space-y-2">
        <input type="hidden" name="chargeId" value={chargeId} />
        <Textarea
          name="reason"
          rows={3}
          required
          minLength={2}
          maxLength={300}
          placeholder="환불 사유를 입력해 주세요. (예: 실수로 중복 발송)"
          className="text-[13px]"
        />
        {state.message ? <Notice tone="warning">{state.message}</Notice> : null}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? '요청 중' : '요청 보내기'}
          </Button>
        </div>
        <p className="text-[11.5px] leading-relaxed text-ink-400">
          요청 후 관리자 검토를 거쳐 승인되면 결제가 취소됩니다. 이미 정산된 건은 환불이 제한될 수 있습니다.
        </p>
      </form>
    </details>
  );
}
