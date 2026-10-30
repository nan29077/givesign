'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity, BadgeCheck, BookOpenText, CalendarDays, ClipboardList, Code2, CreditCard, FlaskConical,
  FilePen, FileSignature, Flag, Gauge, HeartHandshake, Home, Images, KeyRound, LayoutDashboard, LogOut,
  Menu, MessageCircleQuestion, MessageSquareText, Package, Percent, PhoneCall, Truck,
  ScrollText, Send, ServerCog, ShieldAlert, ShieldBan,
  SlidersHorizontal, Undo2, UserCog, CircleUserRound, UserRoundCog,
  UsersRound, WalletCards, X,
  Megaphone,
  Repeat,
  ReceiptText,
  Building2,
  HandHeart,
  Clapperboard,
  Share2,
  BellRing,
  Contact,
  FileSignature as FileSignatureIcon,
  QrCode,
} from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { ConsoleCornerMascot, MascotAccent } from '@/components/brand/mascot-decorations';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { OrgLogo } from '@/components/brand/org-logo';
import { cx } from '@/components/ui';

/**
 * 사회복지기관 관리자 / 통합 관리자 공통 콘솔 레이아웃.
 * 좌측 LNB(그룹형) + 상단 바. 모바일에서는 드로어로 전환한다.
 *
 * 좌측 메뉴 맨 아래에는 프로필·메인으로·로그아웃을 고정한다.
 * 메뉴가 길어져도 항상 같은 자리에 있어야 하므로 메뉴 영역만 스크롤시킨다.
 */

export interface NavGroup {
  title: string;
  items: Array<{
    href: string;
    label: string;
    icon?: ConsoleIconName;
    /**
     * 처리 대기 건수.
     *
     * 0 이면 그리지 않는다. 메뉴에 숫자가 없으면 사회복지기관은 매일 모든 화면을 한 번씩
     * 열어 봐야 밀린 일이 있는지 알 수 있다.
     */
    badge?: number;
  }>;
}

export type ConsoleIconName =
  | 'activity' | 'admins' | 'audit' | 'banners' | 'codes' | 'contents' | 'merchants'
  | 'dashboard' | 'charges' | 'payers' | 'fees' | 'holidays' | 'inquiries' | 'messages'
  | 'moderation' | 'numbers' | 'payments' | 'policies' | 'profile'
  | 'refunds' | 'reports' | 'risk' | 'settlement' | 'simulator'
  | 'system' | 'templates' | 'terms' | 'users' | 'settings' | 'send'
  | 'products' | 'orders' | 'apidocs' | 'documents'
  | 'campaigns' | 'recurring' | 'receipts' | 'donors' | 'building'
  | 'supporters' | 'volunteers' | 'content' | 'channels' | 'notices' | 'agreements' | 'qr';

const CONSOLE_ICONS = {
  activity: Activity,
  admins: UserCog,
  audit: ClipboardList,
  banners: Images,
  codes: KeyRound,
  contents: BookOpenText,
  merchants: BadgeCheck,
  dashboard: LayoutDashboard,
  charges: HeartHandshake,
  payers: CircleUserRound,
  fees: Percent,
  holidays: CalendarDays,
  inquiries: MessageCircleQuestion,
  messages: MessageSquareText,
  moderation: ShieldBan,
  numbers: PhoneCall,
  payments: CreditCard,
  policies: Gauge,
  profile: UserRoundCog,
  refunds: Undo2,
  reports: Flag,
  risk: ShieldAlert,
  settlement: WalletCards,
  simulator: FlaskConical,
  system: ServerCog,
  templates: FilePen,
  terms: ScrollText,
  users: UsersRound,
  settings: SlidersHorizontal,
  send: Send,
  products: Package,
  orders: Truck,
  apidocs: Code2,
  documents: FileSignature,
  campaigns: Megaphone,
  recurring: Repeat,
  receipts: ReceiptText,
  donors: HeartHandshake,
  building: Building2,
  supporters: Contact,
  volunteers: HandHeart,
  content: Clapperboard,
  channels: Share2,
  notices: BellRing,
  agreements: FileSignatureIcon,
  qr: QrCode,
} satisfies Record<ConsoleIconName, typeof Home>;

export function ConsoleShell({
  title,
  groups,
  user,
  children,
}: {
  title: string;
  groups: NavGroup[];
  /** logo: true 면 기관 로고(미등록 시 기본 캐릭터)를 둥근 사각형으로 보여 준다(기관 콘솔). */
  user?: { id: string; name: string; role: string; avatarUrl?: string | null; avatarSeed?: string; avatarIndex?: number | null; logo?: boolean };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // 현재 경로와 가장 길게 일치하는 메뉴 1개만 활성 표시한다.
  // (대시보드(/admin, /studio)나 상위 메뉴(/studio/settlement)가
  //  하위 경로에서 동시에 활성되는 문제 방지)
  const bestMatch = React.useMemo(() => {
    const hrefs = groups.flatMap((g) => g.items.map((i) => i.href));
    return (
      hrefs
        .filter((h) => pathname === h || pathname.startsWith(`${h}/`))
        .sort((a, b) => b.length - a.length)[0] ?? null
    );
  }, [groups, pathname]);

  return (
    <div className="console-canvas relative min-h-dvh">
      <ConsoleCornerMascot />
      <header className="console-header sticky top-0 z-40 border-b backdrop-blur-xl">
        <div className="flex h-16 items-center gap-3 px-4 lg:px-6">
          <button
            type="button"
            aria-label="메뉴"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="grid h-9 w-9 place-items-center rounded-lg border border-ink-200 text-ink-700 lg:hidden"
          >
            {open ? <X size={18} strokeWidth={1.6} /> : <Menu size={18} strokeWidth={1.6} />}
          </button>
          <Link href="/" className="hidden sm:block">
            <Logo compact />
          </Link>
          <span className="min-w-0 flex-1 truncate text-[15px] font-black tracking-[-0.025em] text-ink-900">{title}</span>
          {user ? <NotificationBell /> : null}
        </div>
      </header>

      <div className="relative z-[1] flex items-start">
        {open ? (
          <button
            type="button"
            aria-label="메뉴 닫기"
            onClick={() => setOpen(false)}
            className="fixed inset-0 top-16 z-20 bg-ink-900/25 backdrop-blur-[2px] lg:hidden"
          />
        ) : null}

        <aside
          className={cx(
            'console-sidebar fixed bottom-0 left-0 top-16 z-30 w-[260px] flex-col border-r shadow-2xl',
            'lg:sticky lg:top-16 lg:ml-4 lg:mt-4 lg:h-[calc(100dvh-5rem)] lg:w-[244px] lg:rounded-[24px] lg:border lg:shadow-[0_14px_40px_rgba(23,22,26,0.08)]',
            open ? 'flex' : 'hidden lg:flex',
          )}
        >
          {/* 메뉴 (이 영역만 스크롤) */}
          <nav className="console-navigation min-h-0 flex-1 overflow-y-auto px-3 py-5">
            {groups.map((g) => (
              <div key={g.title} className="mb-5 last:mb-0">
                <p className="mb-2 px-3 text-[10px] font-extrabold tracking-[0.12em] text-ink-300">{g.title}</p>
                {g.items.map((item) => {
                  const active = item.href === bestMatch;
                  const ItemIcon = CONSOLE_ICONS[item.icon ?? 'settings'];
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={cx(
                        'group flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px] font-semibold transition-all',
                        active
                          ? 'bg-brand-100 font-extrabold text-brand-800 shadow-sm'
                          : 'text-ink-500 hover:bg-ink-50 hover:text-ink-900',
                      )}
                    >
                      <span
                        className={cx(
                          'grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border transition-all',
                          active
                            ? 'border-brand-300/70 bg-brand-400 text-ink-900 shadow-[0_4px_10px_rgba(237,166,0,0.2)]'
                            : 'border-ink-100 bg-white text-ink-400 group-hover:border-brand-200 group-hover:bg-brand-50 group-hover:text-brand-700',
                        )}
                      >
                        <ItemIcon size={16} strokeWidth={active ? 2 : 1.7} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.badge && item.badge > 0 ? (
                        <span
                          className="shrink-0 rounded-full bg-danger-500 px-1.5 py-0.5 text-[10px] font-black tabular-nums text-white"
                          aria-label={`처리 대기 ${item.badge}건`}
                        >
                          {item.badge > 99 ? '99+' : item.badge}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>

          {/* 하단 고정: 프로필 · 메인으로 · 로그아웃 */}
          <div className="console-account shrink-0 border-t px-3 py-3 lg:rounded-b-[24px]">
            {user ? (
              <div className="console-profile mb-2 flex items-center gap-2.5 rounded-xl px-3 py-2.5">
                {user.logo ? (
                  <OrgLogo code={user.avatarSeed ?? user.id} name={user.name} logoUrl={user.avatarUrl} avatarIndex={user.avatarIndex} className="h-10 w-10" />
                ) : (
                  <ProfileAvatar
                    seed={user.avatarSeed ?? user.id}
                    avatarIndex={user.avatarIndex}
                    name={user.name}
                    imageUrl={user.avatarUrl}
                    className="h-10 w-10"
                  />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-bold text-ink-900">{user.name}</span>
                  <span className="block text-[11px] font-semibold text-ink-400">{user.role}</span>
                </span>
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <Link
                href="/"
                className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-ink-200 bg-white text-[12.5px] font-bold text-ink-700 transition-colors hover:bg-ink-50"
              >
                <Home size={15} strokeWidth={1.7} />
                메인으로
              </Link>
              <form action="/api/auth/logout" method="post" className="flex-1">
                <button
                  type="submit"
                  className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-ink-200 bg-white text-[12.5px] font-bold text-ink-700 transition-colors hover:bg-ink-50"
                >
                  <LogOut size={15} strokeWidth={1.7} />
                  로그아웃
                </button>
              </form>
            </div>
          </div>
        </aside>

        <main className="console-content min-w-0 max-w-full flex-1 overflow-x-hidden px-3 py-4 sm:px-4 sm:py-5 lg:px-7 lg:py-7">
          <div className="mx-auto w-full max-w-[1480px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="console-page-header relative mb-5 flex min-h-[66px] flex-col items-stretch justify-between gap-3 overflow-hidden rounded-[20px] border px-4 py-3.5 backdrop-blur-sm sm:flex-row sm:flex-wrap sm:items-end sm:px-5">
      <div className="relative min-w-0 flex-1 lg:pr-20">
        <h1 className="break-keep text-[21px] font-black tracking-[-0.035em] text-ink-900 sm:text-[22px]">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-ink-500">{description}</p>
        ) : null}
        <MascotAccent seed={title} className="console-page-mascot absolute -bottom-3 right-0 h-[70px] w-[70px] opacity-80" />
      </div>
      {action ? <div className="w-full sm:w-auto [&>*]:w-full sm:[&>*]:w-auto">{action}</div> : null}
    </div>
  );
}
