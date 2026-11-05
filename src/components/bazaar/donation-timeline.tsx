import { Check } from 'lucide-react';
import { cx } from '@/components/ui';
import { DONATION_FLOW, donationStatusLabel, type DonationStatus } from '@/lib/bazaar';

/** 기부 진행 단계. 택배 조회처럼 지금 단계를 강조한다. 취소·반송은 빨간 띠로 따로 보여 준다. */
export function DonationTimeline({ status }: { status: string }) {
  const st = status as DonationStatus;
  if (st === 'CANCELED' || st === 'RETURNED') {
    return (
      <p className="rounded-xl border border-danger-500/30 bg-danger-50 px-4 py-3 text-[13px] font-bold text-danger-500">
        {donationStatusLabel[st].text} — 더 이상 진행되지 않는 기부 건입니다.
      </p>
    );
  }
  const idx = DONATION_FLOW.indexOf(st);
  return (
    <ol className="flex flex-wrap gap-x-1 gap-y-2" aria-label="진행 단계">
      {DONATION_FLOW.map((s, i) => {
        const done = i < idx;
        const now = i === idx;
        return (
          <li key={s} className="flex items-center gap-1">
            <span
              className={cx(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-bold',
                now ? 'bg-ink-900 text-white' : done ? 'bg-success-50 text-[#0b7d59]' : 'bg-ink-100 text-ink-400',
              )}
              aria-current={now ? 'step' : undefined}
            >
              {done ? <Check size={12} strokeWidth={2} aria-hidden /> : null}
              {donationStatusLabel[s].text}
            </span>
            {i < DONATION_FLOW.length - 1 ? <span className="text-ink-300" aria-hidden>·</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
