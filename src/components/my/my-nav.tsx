'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/components/ui';
import { HandHeart, HeartHandshake, Repeat, ReceiptText, UserRound } from 'lucide-react';

/**
 * 마이페이지 탭.
 * 후원 내역 · 정기후원 · 영수증 · 내 정보. 한도·차단·동의 같은 설정은 "내 정보" 안에서 이동한다.
 */
const TABS = [
  { href: '/my', label: '후원 내역', icon: HeartHandshake, match: ['/my', '/my/payments'] },
  { href: '/my/recurring', label: '정기후원', icon: Repeat, match: ['/my/recurring', '/my/recurring/new', '/my/agreements'] },
  { href: '/my/volunteer', label: '봉사', icon: HandHeart, match: ['/my/volunteer', '/my/volunteer/apply'] },
  { href: '/my/receipts', label: '영수증', icon: ReceiptText, match: ['/my/receipts'] },
  { href: '/my/account', label: '내 정보', icon: UserRound, match: ['/my/account', '/my/limits', '/my/blocks', '/my/consents'] },
];

export function MyNav() {
  const pathname = usePathname();
  return (
    <nav className="mb-4">
      <div className="flex gap-1 rounded-2xl bg-ink-100 p-1">
        {TABS.map((t) => {
          const active = t.match.includes(pathname);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cx(
                'flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-center text-[13px] font-bold transition-colors',
                active ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900',
              )}
            >
              <Icon size={15} strokeWidth={1.85} />
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
