'use client';

import * as React from 'react';
import { ShieldOff } from 'lucide-react';
import { Button, Notice, Checkbox } from '@/components/ui';
import { revokeAutoWithdrawal, type PayerActionState } from '@/app/actions/payer';

const initial: PayerActionState = { ok: false };

/** 자동출금 동의 해지. 실수 방지를 위해 확인 체크 후에만 활성화된다. */
export function RevokeForm() {
  const [state, formAction, pending] = React.useActionState(revokeAutoWithdrawal, initial);
  const [confirmed, setConfirmed] = React.useState(false);

  if (state.ok) {
    return (
      <Notice tone="success" title="해지 완료">
        {state.message}
      </Notice>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <div className="rounded-xl border border-ink-200 px-3 py-1">
        <Checkbox
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          label="해지 시 문자후원이 더 이상 접수되지 않는다는 점을 확인했습니다."
          description="다시 이용하려면 계좌를 새로 등록해야 합니다."
        />
      </div>
      {state.message ? <Notice tone="warning">{state.message}</Notice> : null}
      <Button type="submit" variant="danger" size="md" disabled={!confirmed || pending}>
        {pending ? '해지 중' : '자동출금 동의 해지'}
        <ShieldOff size={16} strokeWidth={1.7} />
      </Button>
    </form>
  );
}
