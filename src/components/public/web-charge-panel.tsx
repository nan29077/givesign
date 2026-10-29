'use client';

import * as React from 'react';
import { Check, Heart, MessageSquare, Pencil, ShieldCheck, Smartphone } from 'lucide-react';
import { cx, Notice } from '@/components/ui';
import { formatWon } from '@/lib/money';
import {
  requestWebDonateCode,
  verifyWebDonateCode,
  submitWebCharge,
  checkWebDonateRegistered,
  type WebDonateState,
} from '@/app/actions/web-charge';

/**
 * 후원 페이지 PC 웹 결제 패널.
 *
 * "문자후원하기" 버튼을 누르면 곧바로 금액 선택 + 메시지 입력 단계로 넘어가고,
 * 그다음 전화번호 본인 인증(미가입 시 내통장결제 가입 팝업)을 거쳐 즉시 결제된다.
 * 결제가 성공한 건만 사회복지기관에 후원으로 반영된다.
 */


const initial: WebDonateState = { ok: false, step: 'phone' };

export function WebChargePanel({
  merchantId,
  merchantName,
  products,
  allowCustom,
  minAmount,
  maxAmount,
  paymentMock = false,
}: {
  merchantId: string;
  merchantName: string;
  products: { name: string; amount: string }[];
  allowCustom: boolean;
  minAmount: string;
  maxAmount: string;
  /** 결제 연동이 아직 mock 이면 화면에 반드시 알린다 (가짜 성공 금지 원칙) */
  paymentMock?: boolean;
}) {
  const min = BigInt(minAmount);
  const max = BigInt(maxAmount);

  // 서버 액션 상태 (본인 인증 · 결제)
  const [sendState, sendAction, sendPending] = React.useActionState(requestWebDonateCode, initial);
  const [verifyState, verifyAction, verifyPending] = React.useActionState(verifyWebDonateCode, initial);
  const [donateState, donateAction, donatePending] = React.useActionState(submitWebCharge, initial);
  const [recheckState, recheckAction, recheckPending] = React.useActionState(checkWebDonateRegistered, initial);

  const [view, setView] = React.useState<WebDonateState>(initial);
  const [prevSend, setPrevSend] = React.useState(sendState);
  const [prevVerify, setPrevVerify] = React.useState(verifyState);
  const [prevDonate, setPrevDonate] = React.useState(donateState);
  const [prevRecheck, setPrevRecheck] = React.useState(recheckState);
  if (prevSend !== sendState) { setPrevSend(sendState); setView(sendState); }
  if (prevVerify !== verifyState) { setPrevVerify(verifyState); setView(verifyState); }
  if (prevDonate !== donateState) { setPrevDonate(donateState); setView(donateState); }
  if (prevRecheck !== recheckState) { setPrevRecheck(recheckState); setView(recheckState); }

  // 로컬 단계: 시작 전 → 금액·메시지 작성 → (서버 단계: 인증/가입/결제)
  const [started, setStarted] = React.useState(false);
  const [composeDone, setComposeDone] = React.useState(false);

  // 금액·메시지 입력
  const [amountMode, setAmountMode] = React.useState<'preset' | 'custom'>('preset');
  const [amount, setAmount] = React.useState<bigint | null>(null);
  const [customAmount, setCustomAmount] = React.useState('');
  const [message, setMessage] = React.useState('');
  /**
   * 결제 멱등키.
   * 금액·메시지를 확정한 시점에 1회 생성해 고정한다. 제출할 때마다 새로 만들면
   * 더블클릭·새로고침 재전송이 서로 다른 키가 되어 같은 결제가 두 번 출금된다.
   * 결제가 성공한 뒤에만 새 키로 회전한다.
   */
  const [requestId, setRequestId] = React.useState('');
  const newRequestId = () =>
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${performance.now().toString(36)}`;

  /** 사회복지기관이 등록한 후원 항목. 한도 범위를 벗어난 상품은 고를 수 없으므로 감춘다. */
  const chargeOptions = React.useMemo(
    () =>
      products
        .map((p) => ({ name: p.name, amount: BigInt(p.amount) }))
        .filter((p) => p.amount >= min && p.amount <= max),
    [products, min, max],
  );

  const effectiveAmount = React.useMemo(() => {
    if (amountMode === 'custom') {
      const digits = customAmount.replace(/[^\d]/g, '');
      if (!digits) return null;
      try {
        return BigInt(digits);
      } catch {
        return null;
      }
    }
    return amount;
  }, [amountMode, amount, customAmount]);
  const amountValid = effectiveAmount !== null && effectiveAmount >= min && effectiveAmount <= max;
  // 메모는 선택이다. 후원은 금액만 정해지면 진행할 수 있다.
  const composeValid = amountValid;

  const serverStep = view.step;
  // 화면 단계 계산
  const phase: 'idle' | 'compose' | 'verify' | 'register' | 'pay' | 'done' = !started
    ? 'idle'
    : !composeDone
      ? 'compose'
      : serverStep === 'register'
        ? 'register'
        : serverStep === 'ready'
          ? 'pay'
          : serverStep === 'done'
            ? 'done'
            : 'verify';

  const inputClass =
    'h-11 w-full rounded-xl border border-ink-200 px-3.5 text-[14px] outline-none transition-colors focus:border-brand-400';
  const ctaClass =
    'inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-brand-400 text-[15.5px] font-extrabold text-ink-900 shadow-[0_8px_20px_rgba(237,166,0,0.28)] transition-colors hover:bg-brand-500 disabled:opacity-50';

  return (
    <div>
      {paymentMock ? (
        <div className="mb-3">
          <Notice tone="warning" title="현재 모의(mock) 결제 상태입니다">
            내통장결제가 아직 실제 연동 전이라 실제 출금은 일어나지 않습니다. 계약과
            연동이 완료되면 이 화면 그대로 실제 결제로 전환됩니다.
          </Notice>
        </div>
      ) : null}

      {/* 시작 전: 문자후원하기 버튼 → 바로 금액·메시지 단계 */}
      {phase === 'idle' ? (
        <div>
          <button type="button" onClick={() => setStarted(true)} className={ctaClass}>
            <MessageSquare size={18} strokeWidth={1.7} />
            문자후원하기
          </button>
          <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-ink-400">
            금액과 메모를 고르면 등록된 내통장결제 계좌에서 바로 결제되고, 사회복지기관에 후원이
            화면에 표시됩니다.
          </p>
        </div>
      ) : (
        <>
          {/* 단계 표시 */}
          <div className="mb-4 flex items-center gap-1.5">
            {(['금액·메시지', '본인 인증', '결제 완료'] as const).map((label, i) => {
              const idx = phase === 'compose' ? 0 : phase === 'done' ? 2 : 1;
              const on = i <= idx;
              return (
                <React.Fragment key={label}>
                  {i > 0 ? <span className={cx('h-px flex-1', on ? 'bg-brand-400' : 'bg-ink-100')} /> : null}
                  <span
                    className={cx(
                      'rounded-full px-2.5 py-1 text-[11px] font-bold',
                      on ? 'bg-brand-100 text-brand-800' : 'bg-ink-50 text-ink-300',
                    )}
                  >
                    {i + 1}. {label}
                  </span>
                </React.Fragment>
              );
            })}
          </div>

          {/* 1. 금액 + 메모 */}
          {phase === 'compose' ? (
            <div className="space-y-4">
              <div>
                <p className="text-[13px] font-bold text-ink-900">후원 금액</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {chargeOptions.map((opt) => {
                    const active = amountMode === 'preset' && amount === opt.amount;
                    return (
                      <button
                        key={opt.amount.toString()}
                        type="button"
                        onClick={() => {
                          setAmountMode('preset');
                          setAmount(opt.amount);
                        }}
                        className={cx(
                          'h-11 rounded-2xl px-4 text-left text-[13px] font-bold transition-colors',
                          active ? 'bg-ink-900 text-brand-400' : 'bg-ink-50 text-ink-700 hover:bg-ink-100',
                        )}
                      >
                        <span className="block leading-tight">{opt.name}</span>
                        <span className="block text-[11.5px] font-semibold opacity-80">{formatWon(opt.amount)}</span>
                      </button>
                    );
                  })}
                  {allowCustom ? <button
                    type="button"
                    onClick={() => setAmountMode('custom')}
                    className={cx(
                      'inline-flex h-10 items-center gap-1 rounded-full px-4 text-[13px] font-bold transition-colors',
                      amountMode === 'custom' ? 'bg-ink-900 text-brand-400' : 'bg-ink-50 text-ink-700 hover:bg-ink-100',
                    )}
                  >
                    <Pencil size={13} strokeWidth={1.9} />
                    직접입력
                  </button> : null}
                </div>
                {amountMode === 'custom' ? (
                  <div className="mt-2.5 flex items-center gap-2">
                    <input
                      inputMode="numeric"
                      value={customAmount}
                      onChange={(e) => setCustomAmount(e.target.value.replace(/[^\d]/g, ''))}
                      placeholder={`${minAmount} ~ ${maxAmount}`}
                      aria-label="직접 입력 결제 금액"
                      className={cx(inputClass, 'w-44 text-right font-bold tabular-nums')}
                    />
                    <span className="text-[14px] font-bold text-ink-700">원</span>
                    {!amountValid && customAmount ? (
                      <span className="text-[12px] font-semibold text-danger-500">
                        {formatWon(min)} ~ {formatWon(max)} 사이로 입력해 주세요.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div>
                <p className="text-[13px] font-bold text-ink-900">메모 <span className="font-semibold text-ink-400">(선택)</span></p>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  maxLength={200}
                  placeholder={`${merchantName} 님에게 남길 메모 (200자 이내). 후원 내역에 함께 저장됩니다.`}
                  className="mt-2 w-full resize-none rounded-xl border border-ink-200 px-3.5 py-3 text-[14px] leading-relaxed outline-none transition-colors focus:border-brand-400"
                />
              </div>

              <button
                type="button"
                disabled={!composeValid}
                onClick={() => {
                  setRequestId(newRequestId());
                  setComposeDone(true);
                }}
                className={ctaClass}
              >
                {composeValid && effectiveAmount !== null
                  ? `${formatWon(effectiveAmount)} 결제 진행 (본인 인증)`
                  : '금액과 메시지를 입력해 주세요'}
              </button>
            </div>
          ) : null}

          {/* 2. 본인 인증 - 전화번호 */}
          {phase === 'verify' && serverStep === 'phone' ? (
            <div className="space-y-3">
              <form action={sendAction} className="space-y-3">
                <p className="text-[13px] leading-relaxed text-ink-500">
                  내통장결제에 등록된 휴대전화 번호로 본인 인증 후 결제됩니다. 아직 가입 전이라도 인증 후 바로 가입할
                  수 있습니다.
                </p>
                <div className="flex gap-2">
                  <input
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    aria-label="휴대전화 번호"
                    placeholder="010-1234-5678"
                    required
                    className={cx(inputClass, 'flex-1')}
                  />
                  <button
                    type="submit"
                    disabled={sendPending}
                    className="h-11 shrink-0 rounded-xl bg-ink-900 px-4 text-[13px] font-extrabold text-white disabled:opacity-60"
                  >
                    {sendPending ? '발송 중' : '인증번호 받기'}
                  </button>
                </div>
                {view.message && !view.ok ? <Notice tone="warning">{view.message}</Notice> : null}
              </form>
              <button
                type="button"
                onClick={() => setComposeDone(false)}
                className="text-[12px] font-semibold text-ink-400 underline-offset-2 hover:underline"
              >
                금액·메시지 다시 고르기
              </button>
            </div>
          ) : null}

          {/* 2. 본인 인증 - 인증번호 */}
          {phase === 'verify' && serverStep === 'code' ? (
            <form action={verifyAction} className="space-y-3">
              <input type="hidden" name="ticket" value={view.ticket ?? ''} />
              <input type="hidden" name="merchantId" value={merchantId} />
              <p className="text-[13px] text-ink-500">{view.phoneMasked} 번호로 발송된 인증번호 6자리를 입력해 주세요.</p>
              {view.devCode ? (
                <Notice tone="brand">테스트(mock) 환경 인증번호: <span className="font-mono font-bold">{view.devCode}</span></Notice>
              ) : null}
              <div className="flex gap-2">
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  aria-label="문자로 받은 인증번호 6자리"
                  maxLength={6}
                  placeholder="123456"
                  required
                  className={cx(inputClass, 'flex-1 text-center font-mono text-[18px] font-bold tracking-[0.3em]')}
                />
                <button
                  type="submit"
                  disabled={verifyPending}
                  className="h-11 shrink-0 rounded-xl bg-brand-400 px-4 text-[13px] font-extrabold text-ink-900 disabled:opacity-60"
                >
                  {verifyPending ? '확인 중' : '인증 확인'}
                </button>
              </div>
              {view.message && !view.ok ? <Notice tone="warning">{view.message}</Notice> : null}
            </form>
          ) : null}

          {/* 2-1. 내통장결제 가입 팝업 안내 */}
          {phase === 'register' ? (
            <div className="space-y-3">
              <Notice tone="warning" title="내통장결제 가입이 필요합니다">
                처음 한 번만 본인 명의 계좌를 등록하면 이후에는 바로 결제할 수 있습니다. 아래 버튼을 누르면 가입 창이
                팝업으로 열립니다.
              </Notice>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (view.registerUrl) window.open(view.registerUrl, 'givesign-register', 'width=480,height=760');
                  }}
                  className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-brand-400 px-4 text-[13px] font-extrabold text-ink-900"
                >
                  <ShieldCheck size={15} strokeWidth={1.8} />
                  내통장결제 가입 창 열기
                </button>
                <form action={recheckAction}>
                  {/* 인증 세션은 HttpOnly 쿠키로만 오간다. 토큰을 hidden 필드에 실으면 DOM·화면공유로 새 나간다. */}
                  <button
                    type="submit"
                    disabled={recheckPending}
                    className="h-11 rounded-xl border border-ink-200 px-4 text-[13px] font-bold text-ink-700 disabled:opacity-60"
                  >
                    {recheckPending ? '확인 중' : '가입 완료했어요'}
                  </button>
                </form>
              </div>
              {view.message && !view.ok ? <Notice tone="neutral">{view.message}</Notice> : null}
            </div>
          ) : null}

          {/* 3. 결제 확인 (즉시 출금) */}
          {phase === 'pay' ? (
            <form action={donateAction} className="space-y-3">
              {/* 인증 세션은 HttpOnly 쿠키로만 오간다. 토큰을 hidden 필드에 실으면 DOM·화면공유로 새 나간다. */}
              <input type="hidden" name="merchantId" value={merchantId} />
              <input type="hidden" name="requestId" value={requestId} />
              <input type="hidden" name="amount" value={amountValid && effectiveAmount !== null ? effectiveAmount.toString() : ''} />
              <input type="hidden" name="message" value={message} />

              {view.message ? <Notice tone={view.ok ? 'success' : 'warning'}>{view.message}</Notice> : null}

              <div className="rounded-xl bg-ink-50 px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-ink-500">결제 금액</span>
                  <span className="text-[20px] font-extrabold tracking-tight text-brand-700">
                    {amountValid && effectiveAmount !== null ? formatWon(effectiveAmount) : '-'}
                  </span>
                </div>
                <p className="mt-2 break-words border-t border-ink-200/60 pt-2 text-[13px] leading-relaxed text-ink-700">
                  {message}
                </p>
              </div>

              <button type="submit" disabled={donatePending || !composeValid} className={ctaClass}>
                <Heart size={17} strokeWidth={1.8} />
                {donatePending
                  ? '결제 진행 중...'
                  : amountValid && effectiveAmount !== null
                    ? `${formatWon(effectiveAmount)} 결제하고 후원하기`
                    : '금액을 확인해 주세요'}
              </button>
              <p className="text-center text-[11.5px] leading-relaxed text-ink-400">
                버튼을 누르면 등록된 내통장결제 계좌에서 위 금액이 바로 출금됩니다.
              </p>
              <button
                type="button"
                onClick={() => setComposeDone(false)}
                className="mx-auto block text-[12px] font-semibold text-ink-400 underline-offset-2 hover:underline"
              >
                금액·메시지 수정
              </button>
            </form>
          ) : null}

          {/* 4. 완료 */}
          {phase === 'done' ? (
            <div className="space-y-3 text-center">
              <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-100 text-brand-700">
                <Check size={26} strokeWidth={1.7} />
              </span>
              <p className="text-[16px] font-extrabold text-ink-900">결제가 완료되었습니다</p>
              <p className="text-[13px] leading-relaxed text-ink-500">
                {view.message}
                {view.transactionNo ? (
                  <span className="mt-1 block font-mono text-[12px] text-ink-400">거래번호 {view.transactionNo}</span>
                ) : null}
              </p>
              <button
                type="button"
                onClick={() => {
                  setMessage('');
                  setComposeDone(false);
                  setRequestId('');
                  setView({ ok: true, step: 'ready', session: view.session });
                }}
                className="mx-auto h-10 rounded-xl border border-ink-200 px-4 text-[13px] font-bold text-ink-700"
              >
                한 번 더 후원하기
              </button>
            </div>
          ) : null}
        </>
      )}

      <p className="mt-4 flex items-center justify-center gap-1.5 border-t border-ink-100 pt-3 text-[11.5px] text-ink-400">
        <Smartphone size={13} strokeWidth={1.8} />
        휴대전화에서는 문자후원하기 버튼 한 번으로 더 간단하게 결제할 수 있습니다.
      </p>
    </div>
  );
}
