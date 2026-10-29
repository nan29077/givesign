'use client';

import * as React from 'react';
import { Check, Clock, MessageSquare, Pencil, Send, ShieldCheck, Smartphone } from 'lucide-react';
import { cx, Notice } from '@/components/ui';
import { formatWon } from '@/lib/money';
import {
  startWebPinCharge,
  checkWebPinChargeStatus,
  type WebPinState,
} from '@/app/actions/web-charge-pin';

/**
 * 결제 페이지 PC 웹 결제 패널 — 결제사 PIN 인증 흐름.
 *
 *   금액·메시지 작성 → 휴대전화 번호 입력 → PIN 링크 문자 발송
 *   → 대기 화면(유효시간 카운트다운 + 상태 폴링) → 결제 완료
 *
 * 이 화면에서는 결제가 일어나지 않는다. 결제는 후원자가 문자로 받은 링크에서
 * PIN 을 입력해야 완료되며, 입력하지 않으면 유효시간이 지나 자동 취소된다.
 *
 * 구(舊) 즉시결제 화면은 web-charge-panel.tsx 에 그대로 남아 있고
 * ALLOW_LEGACY_WEB_INSTANT_PAY=true 일 때만 쓰인다.
 */


/** 대기 화면 폴링 간격 */
const POLL_MS = 3000;

const initial: WebPinState = { ok: false, step: 'phone' };

export function WebChargePinPanel({
  merchantId,
  merchantName,
  products,
  allowCustom,
  minAmount,
  maxAmount,
  paymentMock = false,
  campaigns = [],
  defaultCampaignId = '',
}: {
  merchantId: string;
  merchantName: string;
  products: { name: string; amount: string }[];
  allowCustom: boolean;
  minAmount: string;
  maxAmount: string;
  /** 결제 연동이 아직 mock 이면 화면에 반드시 알린다 (가짜 성공 금지 원칙) */
  paymentMock?: boolean;
  /** 모금 중 캠페인. 비어 있으면 선택 UI 를 숨긴다. */
  campaigns?: { id: string; title: string }[];
  defaultCampaignId?: string;
}) {
  const min = BigInt(minAmount);
  const max = BigInt(maxAmount);
  const [campaignId, setCampaignId] = React.useState(defaultCampaignId);
  const [anonymous, setAnonymous] = React.useState(false);

  const [startState, startAction, startPending] = React.useActionState(startWebPinCharge, initial);

  const [view, setView] = React.useState<WebPinState>(initial);
  const [prevStart, setPrevStart] = React.useState(startState);
  if (prevStart !== startState) {
    setPrevStart(startState);
    setView(startState);
  }

  // 로컬 단계: 시작 전 → 금액·메시지 작성 → (서버 단계)
  const [started, setStarted] = React.useState(false);
  const [composeDone, setComposeDone] = React.useState(false);

  const [amountMode, setAmountMode] = React.useState<'preset' | 'custom'>('preset');
  const [amount, setAmount] = React.useState<bigint | null>(null);
  const [customAmount, setCustomAmount] = React.useState('');
  const [message, setMessage] = React.useState('');

  /**
   * 결제 멱등키.
   * 금액·메시지를 확정한 시점에 1회 생성해 고정한다. 제출할 때마다 새로 만들면
   * 더블클릭·새로고침 재전송이 서로 다른 키가 되어 같은 결제가 두 건 만들어진다.
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
  const phase: 'idle' | 'compose' | 'phone' | 'register' | 'waiting' | 'done' | 'failed' = !started
    ? 'idle'
    : !composeDone
      ? 'compose'
      : serverStep === 'register'
        ? 'register'
        : serverStep === 'waiting'
          ? 'waiting'
          : serverStep === 'done'
            ? 'done'
            : serverStep === 'failed'
              ? 'failed'
              : 'phone';

  // ── 대기 화면: 유효시간 카운트다운 + 결제 완료 폴링 ──────────────────
  const expiresAtMs = React.useMemo(
    () => (view.expiresAt ? new Date(view.expiresAt).getTime() : 0),
    [view.expiresAt],
  );
  const [remainMs, setRemainMs] = React.useState(0);
  const waiting = phase === 'waiting';

  React.useEffect(() => {
    if (!waiting || !expiresAtMs) return;
    const tick = () => setRemainMs(Math.max(0, expiresAtMs - Date.now()));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [waiting, expiresAtMs]);

  React.useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const id = setInterval(async () => {
      const next = await checkWebPinChargeStatus();
      if (!alive) return;
      // 대기 상태가 이어지는 동안에는 화면을 갈아끼우지 않는다(카운트다운이 튀지 않도록).
      if (next.step !== 'waiting') setView(next);
      else if (next.message) setView((cur) => ({ ...cur, message: next.message }));
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [waiting]);

  const expired = waiting && expiresAtMs > 0 && remainMs <= 0;
  const mm = String(Math.floor(remainMs / 60000)).padStart(2, '0');
  const ss = String(Math.floor((remainMs % 60000) / 1000)).padStart(2, '0');

  function restart() {
    setMessage('');
    setCustomAmount('');
    setAmountMode('preset');
    setAmount(chargeOptions[0]?.amount ?? null);
    setRequestId('');
    setComposeDone(false);
    setView(initial);
  }

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

      {/* 시작 전 */}
      {phase === 'idle' ? (
        <div>
          <button type="button" onClick={() => setStarted(true)} className={ctaClass}>
            <MessageSquare size={18} strokeWidth={1.7} />
            문자후원하기
          </button>
          <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-ink-400">
            금액과 메모를 고르면 결제 PIN 입력 링크를 문자로 보내드립니다. PIN 을 입력하면 결제가 완료되고,
            사회복지기관에 후원이 반영됩니다.
          </p>
        </div>
      ) : (
        <>
          {/* 단계 표시 */}
          <div className="mb-4 flex items-center gap-1.5">
            {(['금액·메시지', '번호 입력', 'PIN 입력', '결제 완료'] as const).map((label, i) => {
              const idx =
                phase === 'compose' ? 0 : phase === 'done' ? 3 : phase === 'waiting' ? 2 : 1;
              const on = i <= idx;
              return (
                <React.Fragment key={label}>
                  {i > 0 ? <span className={cx('h-px flex-1', on ? 'bg-brand-400' : 'bg-ink-100')} /> : null}
                  <span
                    className={cx(
                      'rounded-full px-2 py-1 text-[11px] font-bold',
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

              {campaigns.length > 0 ? (
                <div>
                  <p className="text-[13px] font-bold text-ink-900">후원할 곳</p>
                  <select
                    value={campaignId}
                    onChange={(e) => setCampaignId(e.target.value)}
                    className="mt-2 h-12 w-full rounded-xl border border-ink-200 bg-white px-3 text-[14px] outline-none focus:border-brand-400"
                  >
                    <option value="">{merchantName} 일반 후원</option>
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                </div>
              ) : null}

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
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px] text-ink-700">
                  <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="h-4 w-4 rounded border-ink-300" />
                  후원페이지에 익명으로 표시
                </label>
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
                  ? `${formatWon(effectiveAmount)} 후원 진행 (번호 입력)`
                  : '후원 금액을 선택해 주세요'}
              </button>
            </div>
          ) : null}

          {/* 2. 휴대전화 번호 입력 (인증번호 없음) */}
          {phase === 'phone' ? (
            <div className="space-y-3">
              <form action={startAction} className="space-y-3">
                <input type="hidden" name="merchantId" value={merchantId} />
                <input type="hidden" name="requestId" value={requestId} />
                <input
                  type="hidden"
                  name="amount"
                  value={amountValid && effectiveAmount !== null ? effectiveAmount.toString() : ''}
                />
                <input type="hidden" name="message" value={message} />
                <input type="hidden" name="campaignId" value={campaignId} />
                <input type="hidden" name="anonymous" value={anonymous ? '1' : ''} />

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

                <p className="text-[13px] leading-relaxed text-ink-500">
                  결제수단을 등록한 휴대전화 번호를 입력해 주세요. 그 번호로 결제 PIN 입력 링크를 문자로 보내드립니다.
                </p>
                <input
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  aria-label="결제수단을 등록한 휴대전화 번호"
                  placeholder="010-1234-5678"
                  required
                  className={inputClass}
                />
                <button type="submit" disabled={startPending || !composeValid} className={ctaClass}>
                  <Send size={17} strokeWidth={1.8} />
                  {startPending ? 'PIN 링크 발송 중...' : 'PIN 입력 링크 문자로 받기'}
                </button>
                {view.message && !view.ok ? (
                  // 버튼을 누른 뒤 오류가 조용히 렌더되면 스크린리더에는 아무 일도 없는 것으로 들린다.
                  <div role="alert" aria-live="assertive">
                    <Notice tone="warning">{view.message}</Notice>
                  </div>
                ) : null}
              </form>
              <p className="text-center text-[11.5px] leading-relaxed text-ink-400">
                이 단계에서는 출금되지 않습니다. 문자로 받은 링크에서 PIN 을 입력해야 결제가 완료됩니다.
              </p>
              <button
                type="button"
                onClick={() => setComposeDone(false)}
                className="mx-auto block text-[12px] font-semibold text-ink-400 underline-offset-2 hover:underline"
              >
                금액·메시지 다시 고르기
              </button>
            </div>
          ) : null}

          {/* 2-1. 결제수단 등록 안내 */}
          {phase === 'register' ? (
            <div className="space-y-3">
              <Notice tone="warning" title="결제수단 등록이 필요합니다">
                처음 한 번만 본인 명의 계좌를 등록하면 이후에는 바로 결제할 수 있습니다. 등록 링크는 입력하신 번호로
                문자를 보내 드립니다.
              </Notice>
              {view.message ? <Notice tone="neutral">{view.message}</Notice> : null}
              <div className="flex items-start gap-2 rounded-xl bg-ink-50 px-3.5 py-3">
                <ShieldCheck size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-brand-700" />
                <p className="text-[12.5px] leading-relaxed text-ink-500">
                  본인 번호로만 등록할 수 있도록 링크를 문자로만 보냅니다. 문자가 오지 않으면 번호를 다시 확인해 주세요.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={restart}
                  className="h-11 rounded-xl border border-ink-200 px-4 text-[13px] font-bold text-ink-700"
                >
                  등록 완료했어요
                </button>
              </div>
            </div>
          ) : null}

          {/* 3. PIN 입력 대기 */}
          {phase === 'waiting' ? (
            <div className="space-y-3">
              <div className="rounded-2xl border border-brand-200 bg-brand-50/60 px-4 py-4 text-center">
                <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand-100 text-brand-700">
                  <Smartphone size={22} strokeWidth={1.8} />
                </span>
                <p className="mt-2.5 text-[15px] font-extrabold text-ink-900">
                  PIN 번호 입력 링크를 문자로 발송했습니다
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-600">
                  {view.phoneMasked ? `${view.phoneMasked} 번호로 ` : ''}보낸 문자의 링크를 열어 결제 PIN 을 입력하면
                  결제가 완료됩니다.
                </p>
                {expiresAtMs > 0 ? (
                  <span
                    className={cx(
                      'mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-bold tabular-nums',
                      expired ? 'bg-danger-50 text-danger-500' : 'bg-white text-ink-700',
                    )}
                  >
                    <Clock size={14} strokeWidth={1.7} />
                    {expired ? '유효시간 종료' : `남은 유효시간 ${mm}:${ss}`}
                  </span>
                ) : null}
              </div>

              {view.mock ? (
                <Notice tone="warning" title="[MOCK] 실제 결제사 연동이 아닙니다">
                  결제사 연동규격 수령 전이라 테스트용 PIN 화면 링크가 발송됩니다. 실제 출금은 일어나지 않습니다.
                </Notice>
              ) : null}

              {expired ? (
                <Notice tone="warning" title="링크가 만료됐습니다">
                  PIN 입력 시간이 지나 결제가 자동 취소됩니다. 결제는 진행되지 않았습니다. 다시 시도해 주세요.
                </Notice>
              ) : (
                <Notice tone="brand">
                  {view.message ?? '문자를 확인하는 동안 이 창을 닫지 마세요. 결제가 완료되면 자동으로 안내됩니다.'}
                </Notice>
              )}

              <button
                type="button"
                onClick={restart}
                className="mx-auto block text-[12px] font-semibold text-ink-400 underline-offset-2 hover:underline"
              >
                처음부터 다시 하기
              </button>
            </div>
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
                onClick={restart}
                className="mx-auto h-10 rounded-xl border border-ink-200 px-4 text-[13px] font-bold text-ink-700"
              >
                한 번 더 후원하기
              </button>
            </div>
          ) : null}

          {/* 4-1. 실패·만료 */}
          {phase === 'failed' ? (
            <div className="space-y-3">
              <Notice tone="warning" title="결제가 완료되지 않았습니다">
                {view.message}
              </Notice>
              <button type="button" onClick={restart} className={ctaClass}>
                다시 시도하기
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
