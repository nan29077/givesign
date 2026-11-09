'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { Button, Field, Input, Notice, Select, cx } from '@/components/ui';
import {
  recurringApplyAction,
  recurringPreviewAction,
  recurringRegisterAction,
  stepUpConfirmAction,
  stepUpRequestAction,
  type SelfServiceState,
} from '@/app/actions/self-service';

/**
 * 후원자 셀프서비스 화면 조각 (2026-11-09 2차 F). 통합 후원자(/my)·기관 후원 회원(/donate/[코드]/my) 공용.
 * 고령 후원자를 고려해 본문 16px 이상, 버튼은 크게(lg). 결과 문장은 서버의 describeRecurringChange 한 곳에서 온다.
 */

type Action = (prev: SelfServiceState, f: FormData) => Promise<SelfServiceState>;
const initial: SelfServiceState = { ok: false };

function ScopeInput({ code }: { code?: string }) {
  return code ? <input type="hidden" name="code" value={code} /> : null;
}

/** 공용 폼: 성공하면 화면을 새로 그리고, redirectTo 가 있으면 이동한다. */
export function SelfServiceForm({
  action,
  code,
  children,
  submitLabel,
  variant = 'primary',
  confirmMessage,
  className,
  size = 'lg',
}: {
  action: Action;
  code?: string;
  children?: React.ReactNode;
  submitLabel: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  confirmMessage?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [state, formAction, pending] = React.useActionState(action, initial);
  const router = useRouter();
  React.useEffect(() => {
    if (!state.ok) return;
    if (state.redirectTo) {
      const t = setTimeout(() => router.push(state.redirectTo!), 500);
      return () => clearTimeout(t);
    }
    router.refresh();
  }, [state, router]);
  return (
    <form
      action={formAction}
      className={cx('space-y-3', className)}
      onSubmit={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      <ScopeInput code={code} />
      {children}
      {state.message ? <Notice tone={state.ok ? 'success' : 'warning'}><span className="text-[16px] leading-relaxed">{state.message}</span></Notice> : null}
      <Button type="submit" variant={variant} size={size} disabled={pending} className="text-[16px]">
        {pending ? '처리 중' : submitLabel}
      </Button>
    </form>
  );
}

/** 본인 재확인(휴대폰 인증번호). 확인되면 10분 동안 바꿀 수 있다. */
export function StepUpPanel({ code, verified, phoneMasked }: { code?: string; verified: boolean; phoneMasked: string | null }) {
  const [sent, requestAction, requesting] = React.useActionState(stepUpRequestAction, initial);
  const [confirmed, confirmAction, confirming] = React.useActionState(stepUpConfirmAction, initial);
  const router = useRouter();
  React.useEffect(() => {
    if (confirmed.ok) router.refresh();
  }, [confirmed, router]);

  if (verified || confirmed.ok) {
    return (
      <div className="flex items-start gap-2 rounded-2xl bg-success-50 px-4 py-3 text-[16px] text-[#0b7d59]">
        <ShieldCheck size={20} strokeWidth={1.7} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">본인 확인이 끝났습니다. 10분 동안 정기후원을 바꾸거나 해지할 수 있습니다.</p>
      </div>
    );
  }
  const codeSent = sent.codeSent || confirmed.codeSent;
  return (
    <div className="space-y-3 rounded-2xl border border-ink-200 bg-white p-4">
      <p className="flex items-center gap-2 text-[17px] font-extrabold text-ink-900"><ShieldCheck size={20} strokeWidth={1.7} /> 본인 확인</p>
      <p className="text-[16px] leading-relaxed text-ink-700">
        정기후원을 바꾸거나 해지하려면 {phoneMasked ? `${phoneMasked} 번호로` : '인증한 휴대폰으로'} 받은 인증번호를 한 번 확인해 주세요. 확인하면 10분 동안 유효합니다.
      </p>
      <form action={requestAction}>
        <ScopeInput code={code} />
        <Button type="submit" variant={codeSent ? 'secondary' : 'primary'} size="lg" disabled={requesting} className="text-[16px]">
          {requesting ? '보내는 중' : codeSent ? '인증번호 다시 받기' : '인증번호 받기'}
        </Button>
      </form>
      {sent.message && !confirmed.message ? <Notice tone={sent.ok ? 'success' : 'warning'}><span className="text-[16px]">{sent.message}{sent.devCode ? ` (테스트 환경 인증번호 ${sent.devCode})` : ''}</span></Notice> : null}
      {codeSent ? (
        <form action={confirmAction} className="space-y-3">
          <ScopeInput code={code} />
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

/** 바꾸기 전 미리보기 상자 */
function PreviewBox({ preview, loading }: { preview: SelfServiceState['preview'] | null; loading: boolean }) {
  if (!preview && !loading) return null;
  return (
    <div className={cx('rounded-2xl px-4 py-3 text-[16px] leading-relaxed', preview && !preview.allowed ? 'bg-warning-50 text-ink-900' : 'bg-brand-50 text-ink-900')} aria-live="polite">
      <p className="text-[13px] font-bold text-ink-500">저장하면 이렇게 됩니다</p>
      {loading && !preview ? <p className="mt-1 text-ink-500">계산 중</p> : preview?.lines.map((l, i) => <p key={i} className="mt-1">{l}</p>)}
    </div>
  );
}

function usePreview(id: string, code: string | undefined) {
  const [preview, setPreview] = React.useState<SelfServiceState['preview'] | null>(null);
  const [loading, startTransition] = React.useTransition();
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = React.useCallback(
    (fields: Record<string, string>) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const fd = new FormData();
        fd.set('id', id);
        if (code) fd.set('code', code);
        for (const [k, v] of Object.entries(fields)) fd.set(k, v);
        startTransition(async () => {
          const res = await recurringPreviewAction(initial, fd);
          setPreview(res.preview ?? (res.message ? { allowed: false, text: res.message, lines: [res.message] } : null));
        });
      }, 350);
    },
    [id, code],
  );
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { preview, loading, run };
}

/** 금액·출금일 바꾸기(입력하면 바로 결과 문장 미리보기) */
export function RecurringChangeForm({ id, code, amount, dayOfMonth, amountMin, amountMax, changesLeft }: {
  id: string; code?: string; amount: string; dayOfMonth: number; amountMin: string; amountMax: string; changesLeft: number;
}) {
  const [amt, setAmt] = React.useState(amount);
  const [day, setDay] = React.useState(String(dayOfMonth));
  const { preview, loading, run } = usePreview(id, code);
  const update = (a: string, d: string) => {
    setAmt(a);
    setDay(d);
    run({ action: 'CHANGE', amount: a, dayOfMonth: d });
  };
  const fmt = (v: string) => Number(v).toLocaleString('ko-KR');
  return (
    <SelfServiceForm action={recurringApplyAction} code={code} submitLabel="변경 저장">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value="CHANGE" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="매월 후원 금액(원)" hint={`${fmt(amountMin)}원 ~ ${fmt(amountMax)}원`}>
          <Input name="amount" inputMode="numeric" value={amt} onChange={(e) => update(e.target.value, day)} className="text-[17px]" />
        </Field>
        <Field label="출금일">
          <Select name="dayOfMonth" value={day} onChange={(e) => update(amt, e.target.value)} className="text-[17px]">
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>매월 {d}일</option>)}
          </Select>
        </Field>
      </div>
      <p className="text-[14px] text-ink-500">약정 내용(금액·출금일)은 하루 3번까지 바꿀 수 있습니다. 오늘 남은 횟수 {changesLeft}번. 바꾸면 약정서 새 판이 만들어집니다.</p>
      <PreviewBox preview={preview} loading={loading} />
    </SelfServiceForm>
  );
}

/** 날짜를 정해 쉬어 가기(1차 재개 예정일 재사용) */
export function RecurringPauseForm({ id, code, defaultDate, min, max, staticPausePreview, canPauseWithoutDate }: {
  id: string; code?: string; defaultDate: string; min: string; max: string; staticPausePreview: string | null; canPauseWithoutDate: boolean;
}) {
  const { preview, loading, run } = usePreview(id, code);
  const [date, setDate] = React.useState(defaultDate);
  React.useEffect(() => {
    run({ action: 'PAUSE_UNTIL', resumeOn: defaultDate });
  }, [run, defaultDate]);
  return (
    <div className="space-y-4">
      <SelfServiceForm action={recurringApplyAction} code={code} submitLabel="이 날까지 쉬기" variant="secondary">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="action" value="PAUSE_UNTIL" />
        <Field label="다시 시작할 날" hint="그날 자동으로 다시 시작하고, 하루 전에 문자로 알려 드립니다.">
          <Input type="date" name="resumeOn" value={date} min={min} max={max} required className="text-[17px]" onChange={(e) => { setDate(e.target.value); run({ action: 'PAUSE_UNTIL', resumeOn: e.target.value }); }} />
        </Field>
        <PreviewBox preview={preview} loading={loading} />
      </SelfServiceForm>
      {canPauseWithoutDate ? (
        <SelfServiceForm action={recurringApplyAction} code={code} submitLabel="날짜 없이 일시정지" variant="ghost" size="md">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="action" value="PAUSE" />
          {staticPausePreview ? <p className="text-[15px] leading-relaxed text-ink-700">{staticPausePreview}</p> : null}
        </SelfServiceForm>
      ) : null}
    </div>
  );
}

const CANCEL_REASONS = ['경제적인 사정', '다른 기관을 후원하려고', '후원 금액을 정리하려고', '기타'];

/** 해지(확인 1번, 사유는 선택) */
export function RecurringCancelForm({ id, code, merchantName, previewText }: { id: string; code?: string; merchantName: string; previewText: string }) {
  return (
    <SelfServiceForm
      action={recurringApplyAction}
      code={code}
      submitLabel="정기후원 해지"
      variant="secondary"
      confirmMessage={`${merchantName} 정기후원을 해지할까요? ${previewText}`}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value="CANCEL" />
      <p className="text-[16px] leading-relaxed text-ink-700">{previewText}</p>
      <Field label="해지 사유 (고르지 않아도 됩니다)">
        <Select name="reason" defaultValue="" className="text-[17px]">
          <option value="">고르지 않음</option>
          {CANCEL_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </Select>
      </Field>
    </SelfServiceForm>
  );
}

/** 다시 시작 */
export function RecurringResumeForm({ id, code, previewText }: { id: string; code?: string; previewText: string }) {
  return (
    <SelfServiceForm action={recurringApplyAction} code={code} submitLabel="다시 시작">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value="RESUME" />
      <p className="text-[16px] leading-relaxed text-ink-700">{previewText}</p>
    </SelfServiceForm>
  );
}

/** 결제수단 다시 등록(기존 등록 흐름) */
export function RecurringRegisterForm({ id, code, label }: { id: string; code?: string; label: string }) {
  return (
    <SelfServiceForm action={recurringRegisterAction} code={code} submitLabel={label} variant="secondary">
      <input type="hidden" name="id" value={id} />
    </SelfServiceForm>
  );
}
