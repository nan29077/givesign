import Link from 'next/link';
import { PauseCircle } from 'lucide-react';
import { Card, CardTitle } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { balanceBlockedQueue } from '@/server/services/document-bundles';
import { walletOverview } from '@/server/services/edoc-billing';

/**
 * 잔액 부족으로 멈춘 서명 문서 발송 — 충전 승인 뒤 어디서부터 이어지는지(2026-11-12 4차 J3).
 * 순서는 오래된 것부터, 지금 보낼 수 있는 건수만큼. 실제 재시도는 충전 승인 이벤트 소비자(edoc-balance-retry)가 한다.
 */
export async function BalanceBlockedCard({ merchantId }: { merchantId: string }) {
  const [queue, w] = await Promise.all([balanceBlockedQueue(merchantId), walletOverview(merchantId)]);
  if (!queue.length) return null;
  let room = w.sendable;
  let resumable = 0;
  for (const q of queue) {
    if (q.units > room) break;
    room -= q.units;
    resumable += 1;
  }
  const units = queue.reduce((a, q) => a + q.units, 0);
  const first = queue[resumable];
  const short = Math.max(0, units - w.sendable);
  return (
    <Card className="mb-4 border border-warning-500/30">
      <CardTitle className="flex items-center gap-1.5">
        <PauseCircle size={18} strokeWidth={1.7} className="text-warning-500" /> 잔액 부족으로 멈춘 발송 {queue.length}건(문서 {units}건)
      </CardTitle>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-700">
        충전이 승인되면 오래된 것부터 차례로 다시 보냅니다. 같은 문서는 두 번 나가지 않습니다.
        {resumable ? ` 지금 잔액으로도 앞의 ${resumable}건은 이어서 보낼 수 있습니다(다음 재시도 때).` : ''}
        {first ? ` ${formatKst(first.since, false)}에 멈춘 「${first.label}」부터는 ${(short * w.plan.perDocument).toLocaleString('ko-KR')}원 이상 충전이 필요합니다.` : ''}
      </p>
      <ol className="mt-2 space-y-1 text-[12px]">
        {queue.slice(0, 8).map((q, i) => (
          <li key={`${q.kind}:${q.id}`} className="flex flex-wrap items-center gap-2">
            <span className="w-5 text-right font-bold text-ink-400">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-ink-800">{q.kind === 'BUNDLE' ? `문서 묶음 · ${q.label}` : q.label}</span>
            <span className="text-ink-400">{q.units}건 · {formatKst(q.since, false)}</span>
            {i < resumable ? <span className="text-[11px] font-bold text-brand-700">지금 잔액으로 가능</span> : null}
          </li>
        ))}
      </ol>
      {queue.length > 8 ? <p className="mt-1 text-[11.5px] text-ink-400">외 {queue.length - 8}건</p> : null}
      <Link href="/studio/agreements/bundles" className="mt-2 inline-block text-[12px] font-bold text-brand-700 underline">문서 묶음 발송 보기</Link>
    </Card>
  );
}
