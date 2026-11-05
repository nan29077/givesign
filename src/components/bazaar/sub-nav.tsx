import Link from 'next/link';

/** 바자회 화면 상단 탭(서버 컴포넌트) */
export function BazaarSubNav({ items, current }: { items: Array<{ href: string; label: string; badge?: number }>; current: string }) {
  return (
    <nav className="mb-4 flex flex-wrap gap-1.5" aria-label="라이브 바자회 하위 메뉴">
      {items.map((it) => {
        const active = current === it.href;
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'rounded-full bg-ink-900 px-3.5 py-1.5 text-[12.5px] font-bold text-white'
                : 'rounded-full border border-ink-200 bg-white px-3.5 py-1.5 text-[12.5px] font-bold text-ink-700 hover:bg-ink-50'
            }
          >
            {it.label}
            {it.badge ? <span className="ml-1 rounded-full bg-danger-500 px-1.5 text-[10.5px] text-white">{it.badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
