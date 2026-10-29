'use client';

import * as React from 'react';
import { Ban, Check } from 'lucide-react';
import { Button, Notice } from '@/components/ui';
import { toggleMerchantBlock, type PayerActionState } from '@/app/actions/payer';

const initial: PayerActionState = { ok: false };

/** 사회복지기관별 결제 차단 토글. 소유권 검증은 서버 액션에서 수행한다. */
export function BlockToggle({ linkId, blocked }: { linkId: string; blocked: boolean }) {
  const [state, formAction, pending] = React.useActionState(toggleMerchantBlock, initial);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="linkId" value={linkId} />
      <input type="hidden" name="next" value={blocked ? 'UNBLOCK' : 'BLOCK'} />
      <Button
        type="submit"
        variant={blocked ? 'secondary' : 'danger'}
        size="sm"
        disabled={pending}
        // 반복 결제를 막으려고 건 차단이 오조작 한 번으로 풀리지 않게 해제 방향에만 확인을 받는다.
        onClick={(e) => {
          if (!blocked) return;
          if (!window.confirm('차단을 해제하면 이 사회복지기관의 문자 결제가 다시 접수됩니다. 계속할까요?')) {
            e.preventDefault();
          }
        }}
      >
        {blocked ? <Check size={15} strokeWidth={1.8} /> : <Ban size={15} strokeWidth={1.7} />}
        {pending ? '처리 중' : blocked ? '차단 해제' : '결제 차단'}
      </Button>
      {state.message ? (
        <Notice tone={state.ok ? 'success' : 'warning'}>{state.message}</Notice>
      ) : null}
    </form>
  );
}
