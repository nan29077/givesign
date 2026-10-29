'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bell, CheckCheck, X } from 'lucide-react';
import { cx } from '@/components/ui';

interface NotificationItem {
  id: string;
  title: string;
  body: string;
  linkUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return '방금 전';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}일 전`;
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(new Date(value));
}

export function NotificationBell({ className }: { className?: string }) {
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async (quiet = false) => {
    // 이펙트에서 곧바로 호출되므로 setState 는 반드시 await 이후에 일어나야 한다.
    // (동기 setState 는 연쇄 렌더를 유발한다)
    await Promise.resolve();
    if (!quiet) setLoading(true);
    try {
      const response = await fetch('/api/notifications', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json() as { items: NotificationItem[]; unreadCount: number };
      setItems(data.items);
      setUnreadCount(data.unreadCount);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    // 최초 1회도 타이머로 미룬다. 이펙트 본문에서 곧바로 호출하면 동기 setState 로 연쇄 렌더가 발생한다.
    const first = window.setTimeout(() => void load(true), 0);
    const timer = window.setInterval(() => void load(true), 45_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load]);

  React.useEffect(() => {
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const markRead = async (id: string) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item));
    setUnreadCount((count) => Math.max(0, count - (items.find((item) => item.id === id)?.readAt ? 0 : 1)));
    await fetch('/api/notifications', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  };

  const markAll = async () => {
    setUnreadCount(0);
    setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    await fetch('/api/notifications', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) });
  };

  return (
    <div ref={rootRef} className={cx('relative', className)}>
      <button
        type="button"
        aria-label={unreadCount ? `읽지 않은 알림 ${unreadCount}개` : '알림'}
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); if (!open) void load(); }}
        className="relative grid h-10 w-10 place-items-center rounded-full border border-ink-200 bg-white text-ink-700 shadow-sm transition-colors hover:border-brand-300 hover:bg-brand-50"
      >
        <Bell size={18} strokeWidth={1.7} />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 grid min-h-5 min-w-5 place-items-center rounded-full bg-danger-500 px-1 text-[10px] font-black text-white ring-2 ring-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="fixed inset-x-3 top-[72px] z-[70] overflow-hidden rounded-[22px] border border-ink-100 bg-white shadow-[0_22px_65px_rgba(23,22,26,0.2)] sm:absolute sm:left-auto sm:right-0 sm:top-12 sm:w-[360px]">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
            <div>
              <p className="text-[15px] font-black text-ink-900">알림</p>
              <p className="text-[11px] text-ink-400">최근 알림을 한곳에서 확인하세요.</p>
            </div>
            <div className="flex items-center gap-1">
              {unreadCount ? (
                <button type="button" onClick={() => void markAll()} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-bold text-brand-700 hover:bg-brand-50">
                  <CheckCheck size={14} /> 모두 읽음
                </button>
              ) : null}
              <button type="button" aria-label="알림 닫기" onClick={() => setOpen(false)} className="grid h-8 w-8 place-items-center rounded-full text-ink-400 hover:bg-ink-50">
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="max-h-[min(65dvh,480px)] overflow-y-auto">
            {loading && items.length === 0 ? <p className="px-4 py-8 text-center text-[13px] text-ink-400">알림을 불러오는 중입니다.</p> : null}
            {!loading && items.length === 0 ? <p className="px-4 py-10 text-center text-[13px] text-ink-400">새 알림이 없습니다.</p> : null}
            {items.map((item) => {
              const content = (
                <div className={cx('border-b border-ink-100 px-4 py-3.5 transition-colors hover:bg-ink-50', !item.readAt && 'bg-brand-50/60')}>
                  <div className="flex items-start gap-2.5">
                    <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', item.readAt ? 'bg-ink-200' : 'bg-brand-500')} />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-extrabold text-ink-900">{item.title}</span>
                      <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-500">{item.body}</span>
                      <span className="mt-1.5 block text-[10.5px] font-semibold text-ink-300">{relativeTime(item.createdAt)}</span>
                    </span>
                  </div>
                </div>
              );
              return item.linkUrl ? (
                <Link key={item.id} href={item.linkUrl} onClick={() => { void markRead(item.id); setOpen(false); }}>{content}</Link>
              ) : (
                <button key={item.id} type="button" onClick={() => void markRead(item.id)} className="block w-full text-left">{content}</button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
