import Link from 'next/link';
import { ChevronRight, Inbox } from 'lucide-react';
import { inboxActionCount, automationReadiness } from '@/server/services/inbox';

/**
 * 대시보드 맨 위 "승인 대기함" 띠.
 * 모바일에서는 사이드바가 메뉴 속에 숨어 배지가 보이지 않으므로, 처리할 일과 자동화 필수 누락을 첫 화면에 보여 준다.
 * 처리할 일도 필수 누락도 없으면 그리지 않는다.
 */
export async function InboxBanner({ merchantId }: { merchantId: string }) {
  const [count, readiness] = await Promise.all([inboxActionCount(merchantId), automationReadiness(merchantId)]);
  if (count === 0 && readiness.requiredMissing === 0) return null;
  const parts = [
    count ? `처리할 일 ${count}건` : null,
    readiness.requiredMissing ? `자동화 필수 항목 ${readiness.requiredMissing}개 빠짐` : null,
  ].filter(Boolean);
  return (
    <Link
      href="/studio/inbox"
      className="flex items-center gap-3 rounded-2xl border border-warning-500/30 bg-warning-50 px-4 py-3 text-[13px] text-ink-800 hover:bg-warning-50/70"
    >
      <Inbox size={18} strokeWidth={1.7} className="shrink-0 text-warning-500" aria-hidden />
      <span className="min-w-0 flex-1">
        <b className="font-black">승인 대기함</b> <span className="text-ink-600">· {parts.join(' · ')}</span>
      </span>
      <ChevronRight size={16} strokeWidth={1.7} className="shrink-0 text-ink-400" aria-hidden />
    </Link>
  );
}
