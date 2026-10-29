'use client';

import * as React from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { revealShipmentAddressAction } from '@/app/actions/studio';

/**
 * 배송지 원문 보기.
 *
 * 목록에는 마스킹만 그린다. 화면을 열기만 해도 수십 명의 이름·전화·주소가 평문으로 뜨면
 * 어깨너머 노출과 화면 캡처만으로 개인정보가 새어 나간다.
 * 실제 배송 작업을 할 때만 눌러서 열고, 그 순간이 감사로그에 남는다.
 */
export function AddressReveal({
  chargeId,
  receiverMasked,
  phoneMasked,
  addressMasked,
  zipCode,
}: {
  chargeId: string;
  receiverMasked: string;
  phoneMasked: string;
  addressMasked: string;
  zipCode: string;
}) {
  const [full, setFull] = React.useState<{ receiver: string; phone: string; address: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await revealShipmentAddressAction(chargeId);
      if (!res.ok) setError(res.message);
      else setFull({ receiver: res.receiver, phone: res.phone, address: res.address });
    } catch {
      setError('배송지를 여는 중 오류가 발생했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!full) return;
    try {
      await navigator.clipboard.writeText(`${full.receiver}\t${full.phone}\t${zipCode}\t${full.address}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('복사에 실패했습니다. 직접 선택해 복사해 주세요.');
    }
  };

  return (
    <div className="rounded-xl border border-ink-100 px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11.5px] font-bold text-ink-400">배송지</p>
        {full ? (
          <button
            type="button"
            onClick={copy}
            className="rounded-lg border border-ink-200 px-2 py-1 text-[11.5px] font-bold text-ink-600 hover:bg-ink-50"
          >
            {copied ? '복사됨' : '복사'}
          </button>
        ) : (
          <button
            type="button"
            onClick={reveal}
            disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-ink-200 px-2 py-1 text-[11.5px] font-bold text-ink-600 hover:bg-ink-50 disabled:opacity-60"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} strokeWidth={1.9} />}
            {busy ? '여는 중' : '주소 보기'}
          </button>
        )}
      </div>

      <p className="mt-1 text-[13px] font-semibold text-ink-900">
        {full ? full.receiver : receiverMasked}
        <span className="ml-2 font-normal tabular-nums text-ink-600">{full ? full.phone : phoneMasked}</span>
      </p>
      <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-700">
        ({zipCode}) {full ? full.address : addressMasked}
      </p>

      {!full ? (
        <p className="mt-1 text-[11px] text-ink-300">가려진 값입니다. 열람 기록이 남습니다.</p>
      ) : null}
      {error ? <p className="mt-1 text-[11.5px] text-danger-500">{error}</p> : null}
    </div>
  );
}
