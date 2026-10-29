import { cx } from '@/components/ui';

/** 모금 진행률 막대. 서버 컴포넌트에서도 쓸 수 있게 상태 없이 그린다. */
export function ProgressBar({
  percent,
  color,
  className,
  height = 'h-2.5',
}: {
  /** 0~100 을 넘는 값은 100 으로 잘라 그린다 */
  percent: number;
  /** 기관 대표 색상(#rrggbb). 없으면 브랜드 색 */
  color?: string | null;
  className?: string;
  height?: string;
}) {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <div className={cx('w-full overflow-hidden rounded-full bg-ink-100', height, className)} role="progressbar" aria-valuenow={Math.round(width)} aria-valuemin={0} aria-valuemax={100}>
      <div
        className={cx('h-full rounded-full transition-[width] duration-700', color ? '' : 'bg-brand-500')}
        style={{ width: `${width}%`, ...(color ? { backgroundColor: color } : {}) }}
      />
    </div>
  );
}
