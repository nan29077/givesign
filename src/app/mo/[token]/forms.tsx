'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { Button, Field, Input, Notice, Textarea } from '@/components/ui';
import { moInquirySubmitAction, moStepUpConfirmAction, moStepUpRequestAction, type MoCommandState } from '@/app/actions/mo-command';

const initial: MoCommandState = { ok: false };

/** 본인 확인(인증번호) — 링크를 받은 번호로만 보낸다. */
export function MoOtpPanel({ token, phoneMasked, purpose }: { token: string; phoneMasked: string; purpose: string }) {
  const [sent, requestAction, requesting] = React.useActionState(moStepUpRequestAction, initial);
  const [confirmed, confirmAction, confirming] = React.useActionState(moStepUpConfirmAction, initial);
  const router = useRouter();
  React.useEffect(() => {
    if (confirmed.ok) router.refresh();
  }, [confirmed, router]);
  const codeSent = sent.codeSent || confirmed.codeSent;
  return (
    <div className="space-y-3 rounded-2xl border border-ink-200 bg-white p-4">
      <p className="flex items-center gap-2 text-[17px] font-extrabold text-ink-900"><ShieldCheck size={20} strokeWidth={1.7} /> 본인 확인</p>
      <p className="text-[16px] leading-relaxed text-ink-700">{purpose} 문자를 보낸 번호({phoneMasked})로 받은 인증번호를 확인해 주세요.</p>
      <form action={requestAction}>
        <input type="hidden" name="token" value={token} />
        <Button type="submit" variant={codeSent ? 'secondary' : 'primary'} size="lg" disabled={requesting} className="text-[16px]">
          {requesting ? '보내는 중' : codeSent ? '인증번호 다시 받기' : '인증번호 받기'}
        </Button>
      </form>
      {sent.message && !confirmed.message ? <Notice tone={sent.ok ? 'success' : 'warning'}><span className="text-[16px]">{sent.message}{sent.devCode ? ` (테스트 환경 인증번호 ${sent.devCode})` : ''}</span></Notice> : null}
      {codeSent ? (
        <form action={confirmAction} className="space-y-3">
          <input type="hidden" name="token" value={token} />
          <Field label="인증번호 6자리">
            <Input name="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required className="text-[18px] tracking-[0.3em]" />
          </Field>
          {confirmed.message ? <Notice tone={confirmed.ok ? 'success' : 'warning'}><span className="text-[16px]">{confirmed.message}</span></Notice> : null}
          <Button type="submit" size="lg" disabled={confirming} className="text-[16px]">{confirming ? '확인 중' : '확인'}</Button>
        </form>
      ) : null}
    </div>
  );
}

export function MoInquiryForm({ token }: { token: string }) {
  const [state, action, pending] = React.useActionState(moInquirySubmitAction, initial);
  if (state.done) return <Notice tone="success"><span className="text-[16px]">{state.message}</span></Notice>;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <Field label="문의 내용">
        <Textarea name="body" rows={5} maxLength={1000} required className="text-[16px]" placeholder="궁금한 점을 적어 주세요. 주민등록번호·계좌번호는 쓰지 마세요." />
      </Field>
      {state.message ? <Notice tone={state.ok ? 'success' : 'warning'}><span className="text-[16px]">{state.message}</span></Notice> : null}
      <Button type="submit" size="lg" disabled={pending} className="text-[16px]">{pending ? '보내는 중' : '문의 보내기'}</Button>
    </form>
  );
}
