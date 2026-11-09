import Link from 'next/link';
import { ChevronRight, ListChecks } from 'lucide-react';
import { merchantPayerIds, needsStaff, nextActionsForMerchant } from '@/server/services/next-action';

/** 기관 대시보드 한 줄 — "다음 할 일이 있는 후원자 N명" (2026-11-09 D1). 자동 처리 중·할 일 없음은 세지 않는다. 0명이면 그리지 않는다. */
export async function NextActionBanner({ merchantId }: { merchantId: string }) {
  const ids = await merchantPayerIds(merchantId);
  if (ids.length === 0) return null;
  const actions = await nextActionsForMerchant(merchantId, ids);
  const count = [...actions.values()].filter(needsStaff).length;
  if (count === 0) return null;
  return (
    <Link href="/studio/donors?filter=next" className="flex items-center gap-3 rounded-2xl border border-ink-100 bg-white px-4 py-3 text-[13px] text-ink-800 hover:bg-ink-50">
      <ListChecks size={18} strokeWidth={1.7} className="shrink-0 text-brand-700" aria-hidden />
      <span className="min-w-0 flex-1">
        <b className="font-black">다음 할 일이 있는 후원자 {count}명</b> <span className="text-ink-600">· 서명·정기 출금·영수증 정보처럼 담당자가 챙길 일</span>
      </span>
      <ChevronRight size={16} strokeWidth={1.7} className="shrink-0 text-ink-400" aria-hidden />
    </Link>
  );
}
