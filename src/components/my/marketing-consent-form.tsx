'use client';

import * as React from 'react';
import { BellRing, BellOff } from 'lucide-react';
import { Button, Card, CardTitle, Badge, Notice } from '@/components/ui';
import { setMarketingConsent, type PayerActionState } from '@/app/actions/payer';

const initial: PayerActionState = { ok: false };

/** 마케팅 수신 동의 상태 표시 + 동의/철회 토글 */
export function MarketingConsentForm({ agreed }: { agreed: boolean }) {
  const [state, formAction, pending] = React.useActionState(setMarketingConsent, initial);

  // 액션 성공 후에는 서버 revalidate 로 agreed 가 갱신되지만, 낙관적으로 메시지를 우선 보여준다.
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink-50 text-brand-700">
            {agreed ? <BellRing size={18} strokeWidth={1.7} /> : <BellOff size={18} strokeWidth={1.7} />}
          </span>
          <div>
            <CardTitle>마케팅 정보 수신 (선택)</CardTitle>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
              이벤트·혜택 안내 수신 여부입니다. 필수 약관 동의와 무관하게 언제든 변경할 수 있으며, 변경 이력은 아래
              동의 이력에 남습니다.
            </p>
          </div>
        </div>
        <Badge tone={agreed ? 'success' : 'neutral'}>{agreed ? '동의 중' : '미동의'}</Badge>
      </div>

      <form action={formAction} className="mt-3">
        <input type="hidden" name="agree" value={agreed ? 'off' : 'on'} />
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {pending ? '처리 중' : agreed ? '수신 동의 철회' : '수신 동의하기'}
        </Button>
      </form>

      {state.message ? (
        <div className="mt-3">
          <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice>
        </div>
      ) : null}
    </Card>
  );
}
