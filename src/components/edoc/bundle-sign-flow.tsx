'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, CircleX, Loader2, ShieldCheck } from 'lucide-react';
import { Checkbox, Field, Input, Textarea } from '@/components/ui';
import { SignaturePad } from '@/app/doc/[token]/document-form';
import {
  bundleDeclineAction,
  bundleOtpConfirmAction,
  bundleOtpRequestAction,
  bundleSignAction,
  type BundleActionState,
} from '@/app/actions/edoc-bundle';
import type { SignField } from '@/components/edoc/signer-flow';

/**
 * 문서 묶음 서명 화면 조각(2026-11-12 4차 J2). 후원자 화면이라 본문 16px 이상·큰 버튼.
 *  - BundleOtpGate: 본인확인 1번(묶음 전체)
 *  - BundleSignForm: 문서마다 확인 체크(선택 문서는 체크한 것만) + 입력 항목 + 서명 한 번 → 문서마다 서명
 */

function Btn({ pending, children, tone = 'primary' }: { pending?: boolean; children: React.ReactNode; tone?: 'primary' | 'ghost' }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        tone === 'primary'
          ? 'flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 text-[17px] font-extrabold text-white shadow-md disabled:opacity-60'
          : 'flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-ink-200 bg-white text-[16px] font-bold text-ink-600 disabled:opacity-60'
      }
    >
      {pending ? <Loader2 size={20} strokeWidth={1.7} className="animate-spin" /> : null}
      {children}
    </button>
  );
}

export function BundleOtpGate({ token, phoneMasked, count }: { token: string; phoneMasked: string; count: number }) {
  const router = useRouter();
  const [sent, send, sending] = React.useActionState<BundleActionState, FormData>(bundleOtpRequestAction, { ok: false });
  const [conf, confirm, confirming] = React.useActionState<BundleActionState, FormData>(bundleOtpConfirmAction, { ok: false });
  React.useEffect(() => {
    if (conf.done === 'verified') router.refresh();
  }, [conf.done, router]);
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-[16px] leading-relaxed text-ink-700">
        <ShieldCheck size={20} strokeWidth={1.7} className="mt-1 shrink-0 text-brand-700" />
        <span>
          문서 {count}건을 한 번에 확인합니다. 받은 휴대폰 <b className="font-mono">{phoneMasked}</b>로 인증번호를 한 번만 받으면 됩니다.
        </span>
      </p>
      <form action={send}>
        <input type="hidden" name="token" value={token} />
        <Btn pending={sending} tone={sent.codeSent ? 'ghost' : 'primary'}>{sent.codeSent ? '인증번호 다시 받기' : '인증번호 받기'}</Btn>
      </form>
      {sent.message ? (
        <p className={sent.ok ? 'text-[15px] text-ink-500' : 'text-[15px] font-semibold text-danger-500'}>
          {sent.message}
          {sent.devCode ? <span className="ml-1 font-mono font-bold text-ink-800">(테스트 인증번호 {sent.devCode})</span> : null}
        </p>
      ) : null}
      {sent.codeSent ? (
        <form action={confirm} className="flex gap-2">
          <input type="hidden" name="token" value={token} />
          <Input name="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="인증번호 6자리" required className="flex-1 text-[17px]" />
          <button type="submit" disabled={confirming} className="shrink-0 rounded-xl bg-ink-900 px-6 text-[16px] font-extrabold text-white disabled:opacity-60">확인</button>
        </form>
      ) : null}
      {conf.message && !conf.ok ? <p className="text-[15px] font-semibold text-danger-500">{conf.message}</p> : null}
    </div>
  );
}

export interface BundleSignItem {
  id: string;
  label: string;
  required: boolean;
  fields: SignField[];
  prefill: Record<string, string>;
}

export function BundleSignForm({ token, items }: { token: string; items: BundleSignItem[] }) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState<BundleActionState, FormData>(bundleSignAction, { ok: false });
  const [dState, decline, declining] = React.useActionState<BundleActionState, FormData>(bundleDeclineAction, { ok: false });
  const [signature, setSignature] = React.useState('');
  const [showDecline, setShowDecline] = React.useState(false);
  React.useEffect(() => {
    if (state.done || dState.done) router.refresh();
  }, [state.done, dState.done, router]);

  if (dState.done) {
    return <p className="rounded-2xl bg-ink-50 px-4 py-3 text-[16px] font-bold text-ink-700">{dState.message}</p>;
  }

  return (
    <div className="space-y-5">
      <form action={action} className="space-y-5">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="signature" value={signature} />
        {items.map((it, n) => (
          <fieldset key={it.id} className="space-y-3 rounded-2xl border border-ink-100 p-4">
            <legend className="px-1 text-[16px] font-extrabold text-ink-900">
              {n + 1}. {it.label} {it.required ? <span className="text-[13px] font-bold text-brand-700">필수</span> : <span className="text-[13px] font-bold text-ink-400">선택</span>}
            </legend>
            {it.fields.map((f) =>
              f.type === 'CHECKBOX' ? (
                <Checkbox key={f.id} name={`v:${it.id}:${f.id}`} defaultChecked={it.prefill[f.id] === 'Y'} label={`${f.required ? '[필수] ' : ''}${f.label}`} />
              ) : (
                <Field key={f.id} label={f.label} required={f.required} hint={f.hint ?? undefined}>
                  {f.type === 'LONGTEXT' ? (
                    <Textarea name={`v:${it.id}:${f.id}`} rows={3} defaultValue={it.prefill[f.id] ?? ''} maxLength={2000} className="text-[16px]" />
                  ) : (
                    <Input
                      name={`v:${it.id}:${f.id}`}
                      type={f.type === 'DATE' ? 'date' : f.type === 'PHONE' ? 'tel' : 'text'}
                      inputMode={f.type === 'NUMBER' ? 'numeric' : f.type === 'PHONE' ? 'tel' : undefined}
                      defaultValue={it.prefill[f.id] ?? ''}
                      maxLength={200}
                      className="text-[16px]"
                    />
                  )}
                </Field>
              ),
            )}
            <Checkbox
              name={`agree:${it.id}`}
              required={it.required}
              label={it.required ? '위 문서 내용을 확인했고 동의합니다' : '이 선택 문서에도 동의합니다(체크하지 않으면 서명하지 않습니다)'}
            />
          </fieldset>
        ))}
        <div>
          <p className="mb-1.5 text-[16px] font-semibold text-ink-700">서명 (한 번 그리면 위 문서마다 같은 서명으로 남습니다)</p>
          <SignaturePad value={signature} onChange={setSignature} />
        </div>
        {state.message && !state.ok ? <p className="rounded-xl bg-danger-50 px-3.5 py-2.5 text-[15px] font-semibold text-danger-500">{state.message}</p> : null}
        {state.results?.length ? (
          <ul className="space-y-1 text-[15px]">
            {state.results.map((r) => (
              <li key={r.label} className="flex items-start gap-1.5">
                {r.ok ? <CircleCheck size={18} strokeWidth={1.7} className="mt-0.5 text-success-500" /> : <CircleX size={18} strokeWidth={1.7} className="mt-0.5 text-ink-400" />}
                <span>{r.label}{r.message ? ` — ${r.message}` : ''}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <Btn pending={pending}>서명하고 모두 제출</Btn>
      </form>
      {showDecline ? (
        <form action={decline} className="space-y-2 rounded-2xl border border-ink-100 p-4">
          <input type="hidden" name="token" value={token} />
          <Field label="거절 사유" required hint="기관 담당자에게 전달됩니다.">
            <Textarea name="reason" rows={2} maxLength={200} required className="text-[16px]" />
          </Field>
          {dState.message && !dState.ok ? <p className="text-[15px] font-semibold text-danger-500">{dState.message}</p> : null}
          <Btn pending={declining} tone="ghost">남은 문서 모두 서명 거절</Btn>
        </form>
      ) : (
        <button type="button" onClick={() => setShowDecline(true)} className="w-full text-center text-[15px] font-bold text-ink-400 underline">
          서명하지 않고 거절하기
        </button>
      )}
    </div>
  );
}
