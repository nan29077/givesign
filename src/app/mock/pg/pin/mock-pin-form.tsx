'use client';

import * as React from 'react';
import { CircleCheck, CircleX, Clock, KeyRound } from 'lucide-react';
import { Button, Card, DataRow, Field, Input, Notice } from '@/components/ui';
import { submitMockPinAction, type MockPinResult } from '@/app/actions/pin';

/**
 * 테스트용 모의 PIN 입력 폼.
 * 실제 결제사 화면에서는 PIN 이 결제사 서버로만 전송된다.
 * 여기서는 자릿수만 확인하고, 인증 완료 처리(콜백과 동일한 함수)를 호출한다.
 */

export function MockPinForm({
  sessionId,
  merchantName,
  amountText,
  message,
  status,
  expiresAtIso,
}: {
  sessionId: string;
  merchantName: string;
  amountText: string;
  message: string;
  status: string;
  expiresAtIso: string;
}) {
  const expiresAt = React.useMemo(() => new Date(expiresAtIso).getTime(), [expiresAtIso]);
  const [remainMs, setRemainMs] = React.useState(() => Math.max(0, expiresAt - Date.now()));
  const [pin, setPin] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const [result, setResult] = React.useState<MockPinResult | null>(null);
  const submitted = React.useRef(false);

  React.useEffect(() => {
    const id = setInterval(() => setRemainMs(Math.max(0, expiresAt - Date.now())), 500);
    return () => clearInterval(id);
  }, [expiresAt]);

  const expired = remainMs <= 0;
  const mm = String(Math.floor(remainMs / 60000)).padStart(2, '0');
  const ss = String(Math.floor((remainMs % 60000) / 1000)).padStart(2, '0');
  const canSubmit = pin.length === 6 && !expired && !pending && status === 'PENDING';

  function submit() {
    if (submitted.current || !canSubmit) return;
    submitted.current = true;
    startTransition(async () => {
      const res = await submitMockPinAction(sessionId, pin);
      setResult(res);
      // 실패 시에는 다시 시도할 수 있게 잠금을 푼다(중복 결제는 서버에서 막힌다).
      if (!res.ok) submitted.current = false;
    });
  }

  if (result?.ok) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-success-500">
          <CircleCheck size={20} strokeWidth={1.7} />
          <p className="text-[16px] font-extrabold text-ink-900">결제가 완료되었습니다</p>
        </div>
        <div className="mt-3">
          <DataRow label="사회복지기관" value={result.merchantName ?? merchantName} />
          <DataRow label="결제 금액" value={result.amountText ?? amountText} />
          {result.transactionNo ? <DataRow label="거래번호" value={result.transactionNo} /> : null}
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-400">
          결제 결과는 문자로도 안내됩니다. 결제가 완료된 건만 후원으로 반영됩니다.
        </p>
      </Card>
    );
  }

  if (status !== 'PENDING') {
    return (
      <Card>
        <p className="text-[15px] font-extrabold text-ink-900">이미 처리된 인증입니다</p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          이 링크로는 더 이상 결제가 진행되지 않습니다. 결제 결과는 문자로 안내됩니다.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-semibold text-ink-500">결제 PIN 인증</p>
          <span className="inline-flex items-center gap-1 rounded-md bg-ink-50 px-2 py-1 text-[12px] font-bold tabular-nums text-ink-700">
            <Clock size={14} strokeWidth={1.7} />
            {expired ? '00:00' : `${mm}:${ss}`}
          </span>
        </div>
        <p className="mt-2 text-[22px] font-extrabold tracking-tight text-ink-900">{amountText}</p>
        <div className="mt-3">
          <DataRow label="사회복지기관" value={merchantName} />
          <DataRow label="메시지" value={message || '(내용 없음)'} />
        </div>
      </Card>

      {expired ? (
        <Notice tone="warning" title="입력 시간이 지났습니다">
          PIN 입력 시간이 지나 결제가 자동 취소됩니다. 결제는 진행되지 않았습니다.
        </Notice>
      ) : (
        <Notice tone="brand" title="PIN 입력 시 출금됩니다">
          PIN 을 입력하면 등록한 결제수단에서 결제 금액이 출금됩니다. 입력하지 않으면 결제는 진행되지 않습니다.
        </Notice>
      )}

      <Card>
        <Field label="결제 PIN (테스트: 숫자 6자리)">
          <Input
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            placeholder="000000"
            onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
          />
        </Field>
        {result && !result.ok ? (
          <div className="mt-2 flex items-start gap-2 text-danger-500">
            <CircleX size={16} strokeWidth={1.7} />
            <p className="text-[13px] leading-relaxed">{result.message}</p>
          </div>
        ) : null}
      </Card>

      <Button size="lg" onClick={submit} disabled={!canSubmit}>
        <KeyRound size={18} strokeWidth={1.7} />
        {pending ? '결제 처리 중' : 'PIN 입력하고 결제하기'}
      </Button>
    </div>
  );
}
