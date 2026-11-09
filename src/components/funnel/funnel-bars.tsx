import { TrendingDown } from 'lucide-react';
import { cx } from '@/components/ui';
import { formatNumber } from '@/lib/money';
import type { FunnelReport } from '@/server/services/funnel-report';

/**
 * 후원 단계 가로 막대 깔때기 (2026-11-09). 외부 차트 라이브러리 없이 CSS 막대만 쓴다(서버 컴포넌트).
 * 막대 길이 = 첫 단계 대비 비율. 가장 많이 끊기는 단계(다음 단계로 넘어가지 못한 수가 가장 큰 곳)를 강조한다.
 */
export function FunnelBars({ report, compact = false }: { report: FunnelReport; compact?: boolean }) {
  const dropTo = report.biggestDrop?.to ?? null;
  return (
    <div className="space-y-3">
      {report.sentence ? (
        <p className="flex items-start gap-2 rounded-xl bg-warning-50 px-3 py-2.5 text-[13.5px] font-bold leading-snug text-ink-900">
          <TrendingDown size={18} strokeWidth={1.7} className="mt-px shrink-0 text-warning-500" />
          <span>{report.sentence}</span>
        </p>
      ) : null}
      <ol className="space-y-2" aria-label="단계별 도달 수">
        {report.steps.map((s) => {
          const width = report.total > 0 ? Math.max(s.count > 0 ? 2 : 0, s.rateFromStart) : 0;
          const isDrop = s.step === dropTo;
          return (
            <li key={s.step}>
              <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                <span className={cx('font-bold', isDrop ? 'text-warning-500' : 'text-ink-800')}>{s.label}</span>
                <span className="shrink-0 tabular-nums text-ink-500">
                  <b className="text-ink-900">{formatNumber(s.count)}</b>
                  {s.rateFromPrev !== null ? <span className="ml-1.5">앞 단계의 {s.rateFromPrev}%</span> : null}
                </span>
              </div>
              <div className={cx('mt-1 w-full overflow-hidden rounded-full bg-ink-100', compact ? 'h-2' : 'h-3')}>
                <div
                  className={cx('h-full rounded-full', isDrop ? 'bg-warning-500' : 'bg-brand-600')}
                  style={{ width: `${width}%` }}
                />
              </div>
            </li>
          );
        })}
      </ol>
      {!compact && report.ends.length ? (
        <div>
          <p className="mb-1 text-[12.5px] font-bold text-ink-700">끝난 이유</p>
          <ul className="flex flex-wrap gap-1.5">
            {report.ends.map((e) => (
              <li key={`${e.step}:${e.reason}`} className="rounded-lg border border-ink-100 px-2.5 py-1 text-[12px] text-ink-600">
                {e.label} <b className="tabular-nums text-ink-900">{formatNumber(e.count)}</b>
              </li>
            ))}
            {report.open ? (
              <li className="rounded-lg border border-ink-100 px-2.5 py-1 text-[12px] text-ink-600">
                진행 중·중간에 나감 <b className="tabular-nums text-ink-900">{formatNumber(report.open)}</b>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
