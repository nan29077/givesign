'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/components/ui';
import { HandHeart, HeartHandshake, Repeat, ReceiptText, UserRound } from 'lucide-react';
import { activeMyTab, visibleMyTabs, type MyTabKey } from './my-tabs';

/**
 * 마이페이지 탭.
 * 후원 내역 · 정기후원 · 봉사(FEATURE_VOLUNTEER) · 영수증 · 내 정보. 한도·차단·동의 같은 설정은 "내 정보" 안에서 이동한다.
 */
const ICONS: Record<MyTabKey, typeof HeartHandshake> = {
  donations: HeartHandshake,
  recurring: Repeat,
  volunteer: HandHeart,
  receipts: ReceiptText,
  account: UserRound,
};

export function MyNav({ volunteerEnabled }: { volunteerEnabled: boolean }) {
  const pathname = usePathname();
  const tabs = visibleMyTabs({ volunteerEnabled });
  const activeKey = activeMyTab(pathname, tabs);
  return (
    <nav className="mb-4" aria-label="마이페이지 메뉴">
      <div className="flex gap-1 rounded-2xl bg-ink-100 p-1">
        {tabs.map((t) => {
          const active = t.key === activeKey;
          const Icon = ICONS[t.key];
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
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
