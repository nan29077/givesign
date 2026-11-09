import Link from 'next/link';
import { ChevronRight, Landmark } from 'lucide-react';
import { prisma } from '@/server/db';
import { formatWon } from '@/lib/money';
import { offlineMonthTotal } from '@/server/services/deposits';

/**
 * 대시보드: 이번 달 후원액을 "기브싸인 결제" 와 "계좌이체(확정분)" 로 나눠 보여 준다(2026-11-09 E).
 * 두 숫자를 합쳐 하나로 바꾸지 않는다 — 기존 숫자(결제 기준)의 의미를 지킨다.
 * 계좌이체 기록·거래내역 업로드가 한 번도 없으면 그리지 않는다.
 */
export async function OfflineMonthStrip({ merchantId, giveSignMonth }: { merchantId: string; giveSignMonth: bigint }) {
  const [month, used] = await Promise.all([
    offlineMonthTotal(merchantId),
    prisma.bankStatementImport.findFirst({ where: { merchantId }, select: { id: true } }).then((r) => r ?? prisma.offlineDonation.findFirst({ where: { merchantId }, select: { id: true } })),
  ]);
  if (!used) return null;
  return (
    <Link
      href="/studio/deposits"
      className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-ink-100 bg-white px-4 py-3 text-[12.5px] transition-colors hover:bg-ink-50"
    >
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Landmark size={16} strokeWidth={1.7} className="shrink-0 text-ink-400" />
        <span className="font-bold text-ink-900">이번 달 후원</span>
        <span className="text-ink-600">기브싸인 결제 <strong className="tabular-nums text-ink-900">{formatWon(giveSignMonth)}</strong></span>
        <span className="text-ink-600">계좌이체(확정) <strong className="tabular-nums text-ink-900">{formatWon(month.amount)}</strong> · {month.count}건</span>
      </span>
      <ChevronRight size={15} strokeWidth={1.8} className="text-ink-300" />
    </Link>
  );
}
