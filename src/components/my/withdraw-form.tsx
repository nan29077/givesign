'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, Card, Input, Notice } from '@/components/ui';
import { withdrawAccount, type PayerActionState } from '@/app/actions/payer';

const initial: PayerActionState = { ok: false };

/**
 * 회원 탈퇴.
 * 실수로 누르는 것을 막기 위해 두 단계(열기 → 확인 문구 입력)로 진행한다.
 */
export function WithdrawForm() {
  const [state, formAction, pending] = React.useActionState(withdrawAccount, initial);
  const [open, setOpen] = React.useState(false);

  return (
    <Card className="border-danger-500/25">
      <div className="flex gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-danger-50 text-danger-500">
          <AlertTriangle size={18} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold text-ink-900">회원 탈퇴</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
            탈퇴하면 계정 정보가 삭제되고 다시 로그인할 수 없습니다. 등록된 자동출금 수단은 즉시 해지되어 이후
            문자후원이 접수되지 않습니다. 다만 이미 발생한 결제·정산 기록은 관계 법령에 따라 보관됩니다.
          </p>

          {!open ? (
            <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => setOpen(true)}>
              회원 탈퇴 진행
            </Button>
          ) : (
            <form action={formAction} className="mt-3 space-y-2.5">
              <p className="text-[12.5px] font-semibold text-ink-700">
                확인을 위해 <span className="font-mono text-danger-500">탈퇴합니다</span> 를 입력해 주세요.
              </p>
              <Input name="confirm" placeholder="탈퇴합니다" autoComplete="off" required />
              {state.message ? <Notice tone="danger">{state.message}</Notice> : null}
              <div className="flex gap-2">
                <Button type="submit" variant="danger" size="sm" disabled={pending}>
                  {pending ? '처리 중' : '탈퇴하기'}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
                  취소
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Card>
  );
}
