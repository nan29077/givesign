'use client';

import * as React from 'react';
import { AlertTriangle, Landmark, Smartphone } from 'lucide-react';
import { Button, Card, CardTitle, Field, Input, Notice, Select } from '@/components/ui';

/**
 * 테스트용 모의 결제창 입력 폼.
 * 입력값은 서버로 전송되지 않고, 복귀 URL 의 쿼리스트링으로만 전달된다.
 * 실제 헥토파이낸셜 결제창에서는 계좌 인증과 ARS/휴대폰 본인확인이 금융기관을 통해 수행된다.
 */

const BANKS: Array<{ code: string; name: string }> = [
  { code: '004', name: 'KB국민은행' },
  { code: '088', name: '신한은행' },
  { code: '020', name: '우리은행' },
  { code: '081', name: '하나은행' },
  { code: '011', name: 'NH농협은행' },
];

export function MockRegisterForm({
  tid,
  ref_,
  returnUrl,
}: {
  tid: string;
  ref_: string;
  returnUrl: string;
}) {
  const [bankCode, setBankCode] = React.useState(BANKS[0].code);
  const [account, setAccount] = React.useState('');
  const [authCode, setAuthCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const bankName = BANKS.find((b) => b.code === bankCode)?.name ?? BANKS[0].name;
  const canSubmit = account.replace(/[^0-9]/g, '').length >= 8 && authCode.length === 6;

  function go(extra: Record<string, string>) {
    setError(null);
    if (!returnUrl) {
      setError('복귀 주소(return)가 없습니다. 등록 링크를 통해 다시 진입해 주세요.');
      return;
    }
    let url: URL;
    try {
      url = new URL(returnUrl, window.location.origin);
    } catch {
      setError('복귀 주소가 올바르지 않습니다.');
      return;
    }
    // 외부 주소로의 이동을 막는다(오픈 리다이렉트 방지).
    if (url.origin !== window.location.origin) {
      setError('허용되지 않은 복귀 주소입니다.');
      return;
    }
    url.searchParams.set('tid', tid);
    url.searchParams.set('registrationId', ref_);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    window.location.href = url.toString();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    go({
      bankCode,
      bankName,
      account: account.replace(/[^0-9]/g, ''),
    });
  }

  function simulateFailure() {
    go({
      fail: '1',
      code: 'MOCK_AUTH_FAIL',
      message: '예금주 정보가 일치하지 않아 계좌 인증에 실패했습니다. (모의 실패)',
    });
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border-2 border-warning-500/50 bg-warning-50 px-4 py-4">
        <div className="flex items-start gap-2">
          <AlertTriangle size={20} strokeWidth={1.7} className="mt-0.5 shrink-0 text-warning-500" />
          <div>
            <p className="text-[15px] font-extrabold text-ink-900">
              테스트용 모의 결제창입니다. 실제 계좌 인증과 출금이 발생하지 않습니다.
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-700">
              입력한 값은 금융기관으로 전송되지 않으며 저장되지도 않습니다. 실제 서비스에서는 이 화면이 제거되고
              헥토파이낸셜 내통장결제 결제창으로 대체됩니다.
            </p>
          </div>
        </div>
      </div>

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Landmark size={17} strokeWidth={1.7} />
          </span>
          <div>
            <CardTitle>계좌 인증 및 출금이체 등록 (모의)</CardTitle>
            <p className="text-[12px] text-ink-400">거래번호 {tid || '-'}</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <Field label="은행 선택" required>
            <Select value={bankCode} onChange={(e) => setBankCode(e.target.value)}>
              {BANKS.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="계좌번호" required hint="테스트용 임의 숫자를 입력하세요. 끝 4자리만 결과 화면에 표시됩니다.">
            <Input
              value={account}
              onChange={(e) => setAccount(e.target.value.replace(/[^0-9-]/g, ''))}
              inputMode="numeric"
              maxLength={20}
              placeholder="숫자만 입력"
            />
          </Field>

          <Field label="휴대폰 인증번호 (모의)" required hint="실제 인증이 아닙니다. 6자리 아무 숫자나 입력하세요.">
            <div className="flex gap-2">
              <Input
                value={authCode}
                onChange={(e) => setAuthCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                className="flex-1 tracking-[0.3em]"
              />
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-ink-50 text-ink-400">
                <Smartphone size={18} strokeWidth={1.7} />
              </span>
            </div>
          </Field>

          {error ? <Notice tone="danger">{error}</Notice> : null}

          <Button type="submit" size="lg" disabled={!canSubmit}>
            계좌 인증 및 출금이체 등록
          </Button>
        </form>

        <div className="mt-3 border-t border-ink-100 pt-3">
          <p className="mb-2 text-[12px] text-ink-400">테스트 시나리오</p>
          <Button type="button" variant="secondary" size="md" onClick={simulateFailure} className="w-full">
            인증 실패 시뮬레이션
          </Button>
        </div>
      </Card>

      <p className="text-center text-[11.5px] leading-relaxed text-ink-400">
        실제 연동 시에는 헥토파이낸셜 결제창에서 본인 명의 계좌 확인과 출금이체 동의가 진행되며, 기브싸인는 계좌번호
        원문을 전달받지 않습니다.
      </p>
    </div>
  );
}
