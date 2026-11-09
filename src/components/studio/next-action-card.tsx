import Link from 'next/link';
import { ArrowRight, CircleCheck, Clock3, TriangleAlert } from 'lucide-react';
import { Badge, Card } from '@/components/ui';
import type { NextAction } from '@/server/services/next-action';

/** 후원자 "다음 할 일" 카드 (2026-11-09 D1) — 이유 + 다음 자동 실행 + 버튼. */
export function NextActionCard({ action }: { action: NextAction }) {
  const tone = action.key === 'NONE' ? 'neutral' : action.autoHandled ? 'brand' : action.key === 'STAFF_CHECK' || action.key === 'RECURRING_ACTION' ? 'danger' : 'warning';
  const Icon = action.key === 'NONE' ? CircleCheck : action.autoHandled ? Clock3 : TriangleAlert;
  return (
    <Card>
      <div className="flex items-start gap-3">
        <Icon size={20} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-black text-ink-900">다음 할 일</h2>
            <Badge tone={tone}>{action.label}</Badge>
            {action.autoHandled ? <Badge tone="brand">자동 처리 중</Badge> : null}
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-600">{action.reason}</p>
          {action.suggestedAction ? (
            <Link href={action.suggestedAction.href} className="mt-3 inline-flex items-center gap-1 text-[13px] font-bold text-brand-700">
              {action.suggestedAction.label}
              <ArrowRight size={16} strokeWidth={1.7} aria-hidden />
            </Link>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/** 목록용 짧은 표시 */
export function NextActionBadge({ action }: { action: NextAction | undefined }) {
  if (!action || action.key === 'NONE') return <span className="text-ink-300">-</span>;
  return (
    <span title={action.reason}>
      <Badge tone={action.autoHandled ? 'neutral' : action.key === 'STAFF_CHECK' || action.key === 'RECURRING_ACTION' ? 'danger' : 'warning'}>
        {action.autoHandled ? `${action.label} · 자동` : action.label}
      </Badge>
    </span>
  );
}
