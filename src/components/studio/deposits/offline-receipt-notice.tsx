import Link from 'next/link';
import { Notice } from '@/components/ui';
import { formatWon } from '@/lib/money';
import { offlineReceiptCorrections } from '@/server/services/deposits';
import { receiptIncludesOffline } from '@/server/services/receipts';

/**
 * 기부금영수증 화면 안내(2026-11-09 E): 계좌이체 합산 설정 상태와 "정정 필요" 영수증.
 * 정정 필요 = 발급된 영수증에 묶인 계좌이체가 나중에 확정 취소됨. 자동 무효화하지 않는다 — 담당자가 무효 후 재발급.
 */
export async function OfflineReceiptNotice({ merchantId, year }: { merchantId: string; year: number }) {
  const [on, corrections] = await Promise.all([receiptIncludesOffline(merchantId), offlineReceiptCorrections(merchantId, year)]);
  return (
    <div className="mb-5 space-y-3">
      {corrections.length ? (
        <Notice tone="danger" title={`정정이 필요한 영수증 ${corrections.length}장`}>
          발급 뒤 계좌이체 확정이 취소된 금액이 들어 있습니다. 아래 발급 목록에서 무효 처리한 뒤 재발급하세요(재발급은 확정분만 합산합니다).
          <ul className="mt-1.5 list-disc pl-5">
            {corrections.map((c) => (
              <li key={c.receiptId}>
                {c.receiptNo} — 발급 {formatWon(c.totalAmount)} 중 취소된 계좌이체 {formatWon(c.revertedAmount)}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <p className="text-[12px] text-ink-500">
        계좌이체 후원(입금 맞추기 확정분) 합산: <strong className="text-ink-800">{on ? '켬' : '끔'}</strong> —{' '}
        <Link href="/studio/deposits" className="font-semibold underline">입금 맞추기</Link>에서 바꿀 수 있습니다.
      </p>
    </div>
  );
}
