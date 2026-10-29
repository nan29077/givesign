'use client';

import * as React from 'react';
import { CircleCheck, CircleX, Clock, ShieldCheck } from 'lucide-react';
import { Button, Card, DataRow, Input, Notice } from '@/components/ui';
import { confirmChargeAction, updatePayerNicknameAction, type ConfirmActionResult } from '@/app/actions/confirm';
import { checkPayerName, PAYER_NAME_MAX, isDefaultPayerName } from '@/lib/payer-name';
import { SNS_PLATFORMS, type SnsPlatform, SnsPlatformSelector } from '@/components/shared/sns-platform-selector';

/**
 * 문자후원 결제 확인 화면.
 * - 남은 유효시간을 카운트다운으로 표시한다.
 * - 확인 버튼은 1회만 눌리며, 서버에서도 1회용 보안링크로 중복 결제를 막는다.
 * - PIN 입력 전 SNS 닉네임을 선택 입력할 수 있다 (미등록자는 항상 노출, 등록자는 기존 값 표시 후 수정 허용).
 */

export function ConfirmPanel({
  token,
  merchantName,
  amountText,
  buttonText,
  message,
  expiresAtIso,
  payerId,
  payerNickname,
  payerSnsPlatform,
}: {
  token: string;
  merchantName: string;
  amountText: string;
  buttonText: string;
  message: string;
  expiresAtIso: string;
  payerId?: string;
  /** 기존에 저장된 닉네임 (없으면 undefined) */
  payerNickname?: string;
  /** 기존에 저장된 SNS 플랫폼 (없으면 undefined) */
  payerSnsPlatform?: string;
}) {
  const expiresAt = React.useMemo(() => new Date(expiresAtIso).getTime(), [expiresAtIso]);
  const [remainMs, setRemainMs] = React.useState(() => Math.max(0, expiresAt - Date.now()));
  const [pending, startTransition] = React.useTransition();
  const [result, setResult] = React.useState<ConfirmActionResult | null>(null);
  const submitted = React.useRef(false);

  // 닉네임 필드: 기존 값이 기본값(후원자XXXX)이면 비워두고, 직접 입력한 값이면 표시
  const hasRealNickname = payerNickname && !isDefaultPayerName(payerNickname);
  const [nickname, setNickname] = React.useState(hasRealNickname ? payerNickname : '');
  const [snsPlatform, setSnsPlatform] = React.useState<SnsPlatform | ''>(
    (payerSnsPlatform as SnsPlatform) || '',
  );
  const [nicknameError, setNicknameError] = React.useState<string | null>(null);
  const [nicknameSaved, setNicknameSaved] = React.useState(false);

  React.useEffect(() => {
    const id = setInterval(() => setRemainMs(Math.max(0, expiresAt - Date.now())), 500);
    return () => clearInterval(id);
  }, [expiresAt]);

  const expired = remainMs <= 0;
  const mm = String(Math.floor(remainMs / 60000)).padStart(2, '0');
  const ss = String(Math.floor((remainMs % 60000) / 1000)).padStart(2, '0');

  const nameCheck = checkPayerName(nickname);
  const nameErrorDisplay = nickname.trim().length > 1 && !nameCheck.ok ? nameCheck.message : null;

  function submit() {
    if (submitted.current || pending || expired) return;
    submitted.current = true;
    startTransition(async () => {
      // 닉네임 입력값이 있으면 먼저 저장
      if (payerId && nickname.trim()) {
        const res = await updatePayerNicknameAction(token, nickname.trim(), snsPlatform || undefined);
        if (!res.ok) {
          setNicknameError(res.message ?? '닉네임 저장에 실패했습니다.');
          submitted.current = false;
          return;
        }
        setNicknameSaved(true);
      }
      const res = await confirmChargeAction(token);
      setResult(res);
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
          <DataRow label="사회복지기관" value={merchantName} />
          <DataRow label="결제 금액" value={amountText} />
          {result.transactionNo ? <DataRow label="거래번호" value={result.transactionNo} /> : null}
        </div>
        <div className="mt-3">
          <Notice tone="brand" title="후원 반영 안내">
            결제가 완료된 건만 사회복지기관에 후원으로 반영됩니다. 사회복지기관 연동이
            지연되는 경우 반영이 늦어질 수 있습니다.
          </Notice>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-400">
          결제 결과는 문자로도 안내됩니다. 결제 취소·환불 문의는 고객센터로 접수해 주세요.
        </p>
      </Card>
    );
  }

  if (result && !result.ok) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-danger-500">
          <CircleX size={20} strokeWidth={1.7} />
          <p className="text-[16px] font-extrabold text-ink-900">결제가 완료되지 않았습니다</p>
        </div>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">{result.message}</p>
        <div className="mt-3">
          <Notice tone="warning" title="결제되지 않았습니다">
            이 요청으로는 계좌에서 출금이 발생하지 않았으며, 후원도 반영되지 않습니다. 다시 결제하시려면
            사회복지기관 번호로 문자를 새로 보내주세요.
          </Notice>
        </div>
      </Card>
    );
  }

  const platformLabel = SNS_PLATFORMS.find((p) => p.value === snsPlatform)?.label ?? '';

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-semibold text-ink-500">결제 확인</p>
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

      {/* SNS 닉네임 (선택) */}
      {payerId ? (
        <Card>
          <p className="text-[13.5px] font-bold text-ink-900">
            후원 내역에 표시될 이름 <span className="font-normal text-ink-400">(선택)</span>
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
            {hasRealNickname
              ? '현재 저장된 닉네임입니다. 수정하거나 그대로 두세요.'
              : '이름을 입력하면 후원 내역과 사회복지기관 화면에 그 이름으로 표시됩니다. 입력하지 않으면 번호 끝자리로 표시됩니다.'}
          </p>
          <div className="mt-2.5">
            <SnsPlatformSelector value={snsPlatform} onChange={setSnsPlatform} />
          </div>
          <div className="mt-2">
            <Input
              value={nickname}
              onChange={(e) => {
                setNickname(e.target.value);
                setNicknameError(null);
              }}
              maxLength={PAYER_NAME_MAX + 4}
              placeholder={snsPlatform ? `${platformLabel} 닉네임` : '예: 밤톨이'}
              aria-label="후원 내역에 표시될 이름"
            />
          </div>
          {nicknameError ?? nameErrorDisplay ? (
            <p className="mt-1.5 text-[12px] font-semibold text-danger-500">
              {nicknameError ?? nameErrorDisplay}
            </p>
          ) : nicknameSaved ? (
            <p className="mt-1.5 text-[12px] font-semibold text-success-600">닉네임이 저장되었습니다.</p>
          ) : null}
        </Card>
      ) : null}

      {expired ? (
        <Notice tone="warning" title="확인 시간이 지났습니다">
          확인 시간이 지나 결제가 자동 취소되었습니다. 결제는 진행되지 않았습니다. 다시 결제하시려면 사회복지기관
          번호로 문자를 새로 보내주세요.
        </Notice>
      ) : (
        <Notice tone="brand" title="확인 시 즉시 출금됩니다">
          아래 버튼을 누르면 등록한 계좌에서 결제 금액이 출금됩니다. 확인하지 않으면 결제는 진행되지 않습니다.
        </Notice>
      )}

      <Button size="lg" onClick={submit} disabled={expired || pending || Boolean(nameErrorDisplay)}>
        <ShieldCheck size={18} strokeWidth={1.7} />
        {pending ? '처리 중' : buttonText}
      </Button>
    </div>
  );
}
