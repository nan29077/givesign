import type { BusinessInfo } from '@/lib/business-info';

/**
 * 공개 푸터의 사업자 표시 줄. 훅이 없어 서버·클라이언트 어디서나 쓴다.
 * 값이 설정된 항목만 그린다(readBusinessInfo 가 빈 항목을 빼 둔다).
 */
export function BusinessFooterLines({ info, className }: { info: BusinessInfo; className?: string }) {
  return (
    <div className={className}>
      <p>
        <span className="font-semibold text-ink-500">{info.name}</span>
        {info.lines.length > 0 ? ' | ' : null}
        {info.lines.map((l, i) => (
          <span key={l.label}>
            {i > 0 ? ' | ' : null}
            {l.label} {l.value}
          </span>
        ))}
      </p>
    </div>
  );
}
