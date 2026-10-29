'use client';

import * as React from 'react';
import { X, Search, ShieldCheck, Info, ChevronRight, ReceiptText } from 'lucide-react';
import { Badge, Button, Field, Input, Notice, cx } from '@/components/ui';
import {
  requestLookupCode,
  verifyAndLookup,
  type LookupState,
} from '@/app/actions/charge-lookup';

const initial: LookupState = { ok: false, step: 'phone' };

/**
 * 결제내역 확인 바텀시트.
 *
 * 로그인 없이 휴대폰 번호로 후원 내역을 확인한다.
 * 후원 내역은 개인정보라, 번호 입력만으로는 열지 않고
 * 그 번호로 받은 문자 인증번호를 확인한 뒤에 보여준다.
 *
 * 높이는 화면의 약 2/3(66dvh~78dvh)로 올라오고 내부만 스크롤한다.
 */
export function ChargeLookupSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [sendState, sendAction, sending] = React.useActionState(requestLookupCode, initial);
  const [verifyState, verifyAction, verifying] = React.useActionState(verifyAndLookup, initial);

  // 화면 단계는 클라이언트 상태로 직접 관리한다.
  // 서버 응답 두 개(send/verify)를 조합해 계산하면, 인증 만료 시 send 쪽이 여전히
  // 'code' 라 코드 입력 화면에 갇히는 문제가 있었다.
  const [step, setStep] = React.useState<LookupState['step']>('phone');
  // 만료로 처음부터 다시 시작할 때 번호 입력 화면에 보여줄 안내
  const [restartMessage, setRestartMessage] = React.useState<string | null>(null);

  // 액션 응답이 바뀐 렌더에서 단계를 조정한다 (렌더 중 상태 조정 패턴 — effect 를 쓰면
  // 화면이 한 프레임 늦게 바뀌고 cascading render 경고가 난다)
  const [prevSend, setPrevSend] = React.useState(sendState);
  if (prevSend !== sendState) {
    setPrevSend(sendState);
    if (sendState.step === 'code' && sendState.ticket) {
      setStep('code');
      setRestartMessage(null);
    }
  }
  const [prevVerify, setPrevVerify] = React.useState(verifyState);
  if (prevVerify !== verifyState) {
    setPrevVerify(verifyState);
    if (verifyState.step === 'result') {
      setStep('result');
    } else if (verifyState.step === 'phone' && verifyState.message) {
      // 유효시간 만료 / 시도 소진 → 번호 입력부터 다시
      setStep('phone');
      setRestartMessage(verifyState.message);
    }
  }

  const ticket = verifyState.ticket ?? sendState.ticket ?? '';
  const phoneMasked = verifyState.phoneMasked ?? sendState.phoneMasked;
  const result = verifyState.result;

  // 열려 있는 동안 배경 스크롤을 막는다
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 열릴 때 대화상자 안으로 포커스를 옮긴다.
  // 옮기지 않으면 키보드·스크린리더 후원자는 배경 페이지를 계속 훑게 되어
  // 시트 안 입력칸에 닿기 전에 뒤 페이지 링크를 먼저 지나간다.
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const restoreFocusTo = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!open) {
      restoreFocusTo.current?.focus?.();
      restoreFocusTo.current = null;
      return;
    }
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const target = dialogRef.current?.querySelector<HTMLElement>(
      'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
    );
    target?.focus();
  }, [open]);

  return (
    <div
      className={cx('fixed inset-0 z-50', open ? '' : 'pointer-events-none invisible')}
      aria-hidden={!open}
    >
      {/* 배경 */}
      <button
        type="button"
        aria-label="닫기"
        onClick={onClose}
        className={cx(
          'absolute inset-0 bg-ink-900/45 backdrop-blur-[2px] transition-opacity duration-300',
          open ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* 시트 */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="결제내역 확인"
        className={cx(
          'absolute inset-x-0 bottom-0 mx-auto flex h-[72dvh] max-h-[720px] w-full max-w-[640px] flex-col',
          'rounded-t-[28px] bg-white shadow-[0_-18px_60px_rgba(23,22,26,0.28)] transition-transform duration-300 ease-out',
          open ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        {/* 손잡이 + 헤더 */}
        <div className="shrink-0 px-5 pb-3 pt-3">
          <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-ink-200" />
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] border border-brand-200 bg-brand-400 text-ink-900 shadow-[0_6px_16px_rgba(237,166,0,0.22)]">
                <ReceiptText size={21} strokeWidth={1.85} />
              </span>
              <div>
                <h2 className="text-[18px] font-black tracking-[-0.03em] text-ink-900">결제내역</h2>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
                  로그인 없이 휴대폰 번호로 내 후원 내역을 확인합니다.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="닫기"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-ink-200 text-ink-500 transition-colors hover:bg-ink-50"
            >
              <X size={17} strokeWidth={1.8} />
            </button>
          </div>
        </div>

        {/* 본문 (이 영역만 스크롤) */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          {step === 'phone' ? (
            <form action={sendAction} className="space-y-4">
              <div className="rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3.5">
                <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-brand-800">
                  <Info size={14} strokeWidth={1.6} />
                  결제내역 확인 안내
                </p>
                <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-ink-700">
                  <li>· 문자를 보낸 휴대폰 번호를 그대로 입력해 주세요.</li>
                  <li>· 본인 확인을 위해 그 번호로 인증번호가 발송됩니다.</li>
                  <li>· 회원가입이나 로그인은 필요하지 않습니다.</li>
                  <li>· 최근 30건까지 확인할 수 있고, 결과는 10분 뒤 자동으로 닫힙니다.</li>
                </ul>
              </div>

              <Field label="휴대전화 번호" required>
                <Input
                  type="tel"
                  name="phone"
                  required
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder="010-1234-5678"
                />
              </Field>

              {restartMessage ? <Notice tone="warning">{restartMessage}</Notice> : null}
              {!sendState.ok && sendState.message ? <Notice tone="danger">{sendState.message}</Notice> : null}

              <Button type="submit" size="lg" disabled={sending}>
                {sending ? '발송 중' : '인증번호 받기'}
                <Search size={16} strokeWidth={1.8} />
              </Button>

              <p className="text-center text-[11.5px] leading-relaxed text-ink-400">
                후원 내역은 개인정보이므로 휴대폰 번호 인증을 거칩니다.
              </p>
            </form>
          ) : null}

          {step === 'code' ? (
            <form action={verifyAction} className="space-y-4">
              <input type="hidden" name="ticket" value={ticket} />

              <Notice tone="brand">{sendState.message ?? `${phoneMasked ?? ''} 번호로 인증번호를 발송했습니다.`}</Notice>

              {sendState.devCode ? (
                <Notice tone="warning" title="개발·검수 환경 안내 (mock 발송)">
                  실제 문자는 발송되지 않습니다. 이번 인증번호:{' '}
                  <span className="font-mono font-extrabold">{sendState.devCode}</span>
                </Notice>
              ) : null}

              <Field label="인증번호 6자리" required>
                <Input
                  type="text"
                  name="code"
                  required
                  inputMode="numeric"
                  maxLength={6}
                  pattern="\d{6}"
                  placeholder="123456"
                  autoComplete="one-time-code"
                />
              </Field>

              {!verifyState.ok && verifyState.message ? <Notice tone="danger">{verifyState.message}</Notice> : null}

              <Button type="submit" size="lg" disabled={verifying}>
                {verifying ? '확인 중' : '결제내역 확인'}
              </Button>

              <button
                type="button"
                onClick={() => {
                  setStep('phone');
                  setRestartMessage(null);
                }}
                className="block w-full text-center text-[12.5px] font-semibold text-ink-400 transition-colors hover:text-ink-700"
              >
                번호를 다시 입력하거나 인증번호를 다시 받기
              </button>
            </form>
          ) : null}

          {step === 'result' && result ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3 rounded-2xl bg-ink-50 px-4 py-3">
                <div>
                  <p className="flex items-center gap-1.5 text-[12px] font-bold text-ink-500">
                    <ShieldCheck size={14} strokeWidth={1.6} className="text-success-500" />
                    {result.phoneMasked} 확인 완료
                  </p>
                  <p className="mt-1 text-[13px] font-semibold text-ink-900">
                    누적 {result.totalAmount} · {result.totalCount}건
                  </p>
                </div>
                {result.registered ? <Badge tone="success">결제수단 등록됨</Badge> : <Badge tone="neutral">결제수단 미등록</Badge>}
              </div>

              {result.items.length === 0 ? (
                <div className="rounded-2xl border border-ink-100 px-4 py-8 text-center">
                  <p className="text-[14px] font-bold text-ink-900">후원 내역이 없습니다</p>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-500">
                    이 번호로 처리된 문자후원가 없습니다. 서비스에 안내된 번호로 문자를 보내 결제하면 이곳에서 확인할 수 있습니다.
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {result.items.map((d) => (
                    <li key={d.id} className="rounded-2xl border border-ink-100 px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[13.5px] font-bold text-ink-900">{d.merchantName}</span>
                            <Badge tone={d.statusTone}>{d.statusText}</Badge>
                          </div>
                          <p className="mt-1.5 break-words text-[12.5px] leading-relaxed text-ink-700">{d.message}</p>
                          <p className="mt-1 text-[11px] text-ink-400">{d.receivedAt}</p>
                        </div>
                        <span className="shrink-0 text-[15px] font-extrabold tabular-nums text-ink-900">{d.amount}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <a
                href="/signup"
                className="flex items-center justify-between rounded-2xl border border-ink-200 px-4 py-3 text-[13px] font-semibold text-ink-700 transition-colors hover:bg-ink-50"
              >
                회원가입하면 환불 요청·한도 설정까지 관리할 수 있습니다
                <ChevronRight size={16} strokeWidth={1.8} className="shrink-0 text-ink-400" />
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
