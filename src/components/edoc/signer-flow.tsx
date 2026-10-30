'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, Loader2, ShieldCheck } from 'lucide-react';
import { Checkbox, Field, Input, Textarea } from '@/components/ui';
import { SignaturePad } from '@/app/doc/[token]/document-form';
import {
  signerDeclineAction,
  signerOtpConfirmAction,
  signerOtpRequestAction,
  signerSignAction,
  type SignerActionState,
} from '@/app/actions/edoc';

function Btn({ pending, children, tone = 'primary', type = 'submit' }: { pending?: boolean; children: React.ReactNode; tone?: 'primary' | 'ghost'; type?: 'submit' | 'button' }) {
  return (
    <button
      type={type}
      disabled={pending}
      className={
        tone === 'primary'
          ? 'flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 text-[15px] font-extrabold text-white shadow-md disabled:opacity-60'
          : 'flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-ink-200 bg-white text-[14px] font-bold text-ink-600 disabled:opacity-60'
      }
    >
      {pending ? <Loader2 size={18} strokeWidth={1.7} className="animate-spin" /> : null}
      {children}
    </button>
  );
}

/** 받은 번호로 인증번호를 확인해야 문서 내용을 볼 수 있다. */
export function SignerOtpGate({ token, phoneMasked }: { token: string; phoneMasked: string }) {
  const router = useRouter();
  const [sent, send, sending] = React.useActionState<SignerActionState, FormData>(signerOtpRequestAction, { ok: false });
  const [conf, confirm, confirming] = React.useActionState<SignerActionState, FormData>(signerOtpConfirmAction, { ok: false });
  React.useEffect(() => {
    if (conf.done === 'verified') router.refresh();
  }, [conf.done, router]);
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-[13.5px] leading-relaxed text-ink-700">
        <ShieldCheck size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-brand-700" />
        개인정보 보호를 위해 이 문서를 받은 휴대폰 <b className="font-mono">{phoneMasked}</b>로 인증번호를 보내 본인을 확인합니다.
      </p>
      <form action={send}>
        <input type="hidden" name="token" value={token} />
        <Btn pending={sending} tone={sent.codeSent ? 'ghost' : 'primary'}>{sent.codeSent ? '인증번호 다시 받기' : '인증번호 받기'}</Btn>
      </form>
      {sent.message ? (
        <p className={sent.ok ? 'text-[12.5px] text-ink-500' : 'text-[12.5px] font-semibold text-danger-500'}>
          {sent.message}
          {sent.devCode ? <span className="ml-1 font-mono font-bold text-ink-800">(테스트 인증번호 {sent.devCode})</span> : null}
        </p>
      ) : null}
      {sent.codeSent ? (
        <form action={confirm} className="flex gap-2">
          <input type="hidden" name="token" value={token} />
          <Input name="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="인증번호 6자리" required className="flex-1" />
          <button type="submit" disabled={confirming} className="shrink-0 rounded-xl bg-ink-900 px-5 text-[14px] font-extrabold text-white disabled:opacity-60">확인</button>
        </form>
      ) : null}
      {conf.message && !conf.ok ? <p className="text-[12.5px] font-semibold text-danger-500">{conf.message}</p> : null}
    </div>
  );
}

export interface SignField {
  id: string;
  label: string;
  type: 'TEXT' | 'LONGTEXT' | 'DATE' | 'NUMBER' | 'PHONE' | 'CHECKBOX';
  required: boolean;
  hint: string | null;
}

/** 서명 폼. 첫 번째 서명자는 항목을 채우고, 나머지는 확인 후 서명만 한다. */
export function SignerSignForm({ token, fields, prefill, editable }: { token: string; fields: SignField[]; prefill: Record<string, string>; editable: boolean }) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState<SignerActionState, FormData>(signerSignAction, { ok: false });
  const [declineState, decline, declining] = React.useActionState<SignerActionState, FormData>(signerDeclineAction, { ok: false });
  const [signature, setSignature] = React.useState('');
  const [showDecline, setShowDecline] = React.useState(false);
  React.useEffect(() => {
    if (state.done || declineState.done) router.refresh();
  }, [state.done, declineState.done, router]);

  // 제출에 실패하면 폼이 초기화되므로, 돌려받은 입력값을 기본값으로 다시 채운다.
  const v: Record<string, string> = state.values
    ? Object.fromEntries(Object.entries(state.values).map(([k, x]) => [k, x === 'on' ? 'Y' : x]))
    : prefill;

  if (state.done || declineState.done) {
    return (
      <p className="flex items-center gap-2 rounded-2xl bg-success-50 px-4 py-3 text-[14px] font-bold text-[#0b7d59]">
        <CircleCheck size={18} strokeWidth={1.7} /> {state.message ?? declineState.message}
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="signature" value={signature} />
        {editable
          ? fields.map((f) =>
              f.type === 'CHECKBOX' ? (
                <Checkbox key={f.id} name={`v_${f.id}`} required={f.required} defaultChecked={v[f.id] === 'Y'} label={`${f.required ? '[필수] ' : ''}${f.label}`} />
              ) : (
                <Field key={f.id} label={f.label} required={f.required} hint={f.hint ?? undefined}>
                  {f.type === 'LONGTEXT' ? (
                    <Textarea name={`v_${f.id}`} rows={3} defaultValue={v[f.id] ?? ''} required={f.required} maxLength={2000} />
                  ) : (
                    <Input
                      name={`v_${f.id}`}
                      type={f.type === 'DATE' ? 'date' : f.type === 'PHONE' ? 'tel' : 'text'}
                      inputMode={f.type === 'NUMBER' ? 'numeric' : f.type === 'PHONE' ? 'tel' : undefined}
                      defaultValue={v[f.id] ?? ''}
                      required={f.required}
                      maxLength={200}
                    />
                  )}
                </Field>
              ),
            )
          : null}
        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-ink-700">서명 <span className="text-accent-500">*</span></p>
          <SignaturePad value={signature} onChange={setSignature} />
        </div>
        <Checkbox name="agreed" required label="문서 내용을 모두 확인했으며, 위 서명이 본인의 의사임을 확인합니다" />
        {state.message && !state.ok ? <p className="rounded-xl bg-danger-50 px-3.5 py-2.5 text-[13px] font-semibold text-danger-500">{state.message}</p> : null}
        <Btn pending={pending}>서명하고 제출</Btn>
      </form>

      {showDecline ? (
        <form action={decline} className="space-y-2 rounded-2xl border border-ink-100 p-4">
          <input type="hidden" name="token" value={token} />
          <Field label="거절 사유" required hint="기관 담당자에게 전달됩니다.">
            <Textarea name="reason" rows={2} maxLength={200} required />
          </Field>
          {declineState.message && !declineState.ok ? <p className="text-[12.5px] font-semibold text-danger-500">{declineState.message}</p> : null}
          <Btn pending={declining} tone="ghost">서명 거절</Btn>
        </form>
      ) : (
        <button type="button" onClick={() => setShowDecline(true)} className="w-full text-center text-[12.5px] font-bold text-ink-400 underline">
          서명하지 않고 거절하기
        </button>
      )}
    </div>
  );
}
