'use client';

import * as React from 'react';
import { Smartphone, ShieldCheck, RotateCcw } from 'lucide-react';
import { Button, Card, CardTitle, Field, Input, Notice, Badge } from '@/components/ui';
import {
  requestPhoneVerification,
  confirmPhoneVerification,
  unlinkPhone,
  type PhoneLinkState,
} from '@/app/actions/phone-link';

const initial: PhoneLinkState = { ok: false };

/**
 * 휴대폰 번호 인증·연결 폼.
 * 1단계: 번호 입력 → 인증번호 발송 (MT mock 어댑터)
 * 2단계: 인증번호 입력 → PayerProfile 연결
 */
export function PhoneLinkForm({ linkedPhoneMasked }: { linkedPhoneMasked: string | null }) {
  const [sendState, sendAction, sending] = React.useActionState(requestPhoneVerification, initial);
  const [confirmState, confirmAction, confirming] = React.useActionState(confirmPhoneVerification, initial);
  const [changeMode, setChangeMode] = React.useState(false);
  // 코드 입력 단계 여부는 클라이언트 상태로 직접 관리한다.
  // 서버 응답 조합으로 계산하면 인증 만료 후 코드 화면에 갇힌다.
  const [codeStep, setCodeStep] = React.useState(false);
  const [restartMessage, setRestartMessage] = React.useState<string | null>(null);

  // 액션 응답이 바뀐 렌더에서 단계를 조정한다 (렌더 중 상태 조정 패턴)
  const [prevSend, setPrevSend] = React.useState(sendState);
  if (prevSend !== sendState) {
    setPrevSend(sendState);
    if (sendState.codeSent) {
      setCodeStep(true);
      setRestartMessage(null);
    }
  }
  const [prevConfirm, setPrevConfirm] = React.useState(confirmState);
  if (prevConfirm !== confirmState) {
    setPrevConfirm(confirmState);
    if (confirmState.linked) {
      setCodeStep(false);
    } else if (confirmState.message && !confirmState.codeSent) {
      // 유효시간 만료 또는 시도 횟수 소진 → 번호 입력부터 다시
      setCodeStep(false);
      setRestartMessage(confirmState.message);
    }
  }

  const linked = confirmState.linked || (Boolean(linkedPhoneMasked) && !changeMode);
  const codeSent = codeStep && !confirmState.linked;

  if (linked) {
    return (
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="flex gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-success-50 text-success-500">
              <ShieldCheck size={18} strokeWidth={1.7} />
            </span>
            <div>
              <CardTitle>연결된 휴대폰 번호</CardTitle>
              <p className="mt-1 text-[15px] font-extrabold tracking-tight text-ink-900">
                {confirmState.linked ? '연결 완료' : linkedPhoneMasked}
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
                이 번호로 보낸 문자후원와 후원 내역이 마이페이지에 표시됩니다.
              </p>
            </div>
          </div>
          <Badge tone="success">인증 완료</Badge>
        </div>
        {confirmState.linked && confirmState.message ? (
          <div className="mt-3">
            <Notice tone="success">{confirmState.message}</Notice>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setChangeMode(true)}>
            <RotateCcw size={14} strokeWidth={1.8} />
            번호 변경
          </Button>
          <UnlinkButton />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
          <Smartphone size={18} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <CardTitle>휴대폰 번호 연결</CardTitle>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-500">
            문자후원는 휴대전화 번호를 기준으로 기록됩니다. 번호를 인증하면 해당 번호로 결제한 내역과 결제
            내역을 이 계정에서 확인하고 관리할 수 있습니다.
          </p>

          {!codeSent ? (
            <form action={sendAction} className="mt-4 space-y-3">
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
              <Button type="submit" size="md" disabled={sending}>
                {sending ? '발송 중' : '인증번호 받기'}
              </Button>
            </form>
          ) : (
            <form action={confirmAction} className="mt-4 space-y-3">
              <Notice tone="brand">{sendState.message}</Notice>
              {sendState.devCode ? (
                <Notice tone="warning" title="개발·검수 환경 안내 (mock 발송)">
                  실제 문자는 발송되지 않습니다. 이번에 발송된 인증번호:{' '}
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
              {!confirmState.ok && confirmState.message ? <Notice tone="danger">{confirmState.message}</Notice> : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="md" disabled={confirming}>
                  {confirming ? '확인 중' : '인증하고 연결하기'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => {
                    setCodeStep(false);
                    setRestartMessage(null);
                  }}
                >
                  인증번호 다시 받기
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Card>
  );
}

function UnlinkButton() {
  const [state, action, pending] = React.useActionState(unlinkPhone, initial);
  return (
    <form action={action} className="contents">
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? '해제 중' : '연결 해제'}
      </Button>
      {state.message ? <p className="w-full text-[12px] text-ink-500">{state.message}</p> : null}
    </form>
  );
}
