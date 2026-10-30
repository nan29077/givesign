'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bell, Building2, CircleHelp, CircleUserRound, CreditCard, House, LayoutDashboard,
  LifeBuoy, LogIn, LogOut, Map, Menu, X,
} from 'lucide-react';
import { Logo, GiveSignMark } from '@/components/brand/logo';
import { PublicMarginMascots } from '@/components/brand/mascot-decorations';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { ChargeLookupSheet } from '@/components/public/charge-lookup-sheet';
import { cx } from '@/components/ui';

/**
 * 공개 영역 레이아웃 (클라이언트).
 * - PC: 중앙 콘텐츠는 앱 폭 유지, 우측 세로 메뉴는 모바일 하단 내비와 동일한 5개 구성
 *       + 하단에 프로필/로그아웃(로그인) 영역
 * - 모바일: 하단 내비게이션 5개 (홈 / 이용방법 / 후원내역 / FAQ / 마이페이지)
 * - 마이페이지는 로그인 역할에 따라 대시보드(/admin, /studio) 또는 마이페이지(/my)로 이동
 */

export interface ShellViewer {
  id: string;
  name: string | null;
  email: string | null;
  /** 역할별 마이페이지 목적지 (/admin, /studio, /my) */
  myHref: string;
  roleLabel: string;
  /** 프로필 캐릭터(아바타) 이미지. 사회복지기관 프로필의 아바타를 그대로 사용한다. */
  avatarUrl: string | null;
  /** 사회복지기관은 재시드에도 바뀌지 않는 사회복지기관 코드를 사용한다. */
  avatarSeed: string;
  /** 가입 시 무작위로 배정되어 DB에 고정된 0~49 캐릭터 번호 */
  avatarIndex: number;
}

/** 마이페이지 탭 활성 판정에 쓰는 콘솔 경로들 */
const MY_PREFIXES = ['/my', '/studio', '/admin'];

interface NavItem {
  href: string;
  label: string;
  icon: typeof House;
  /** 마이페이지 탭(역할별 이동) */
  my?: boolean;
  /** 로그인 없이 휴대폰 인증으로 후원 내역을 여는 항목 */
  lookup?: boolean;
}

function buildNav(myHref: string): NavItem[] {
  return [
    { href: '/', label: '홈', icon: House },
    { href: '/how-it-works', label: '이용방법', icon: Map },
    { href: '#payment-history', label: '후원내역', icon: CreditCard, lookup: true },
    { href: '/faq', label: 'FAQ', icon: CircleHelp },
    { href: myHref, label: '마이페이지', icon: CircleUserRound, my: true },
  ];
}

const DRAWER_EXTRA: NavItem[] = [
  { href: '/business', label: '기관 도입', icon: Building2 },
  { href: '/electronic-documents', label: '기관 전자문서', icon: Building2 },
  { href: '/notice', label: '공지', icon: Bell },
  { href: '/support', label: '고객센터', icon: LifeBuoy },
];

function isActive(pathname: string, href: string, my?: boolean) {
  if (my) return MY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PublicShellClient({
  children,
  aside,
  viewer,
  marginUrl,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
  viewer: ShellViewer | null;
  marginUrl: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [lookupOpen, setLookupOpen] = React.useState(false);
  const myHref = viewer?.myHref ?? '/my';
  const nav = buildNav(myHref);

  return (
    <div className="public-canvas min-h-dvh pb-20 lg:pb-0">
      <PublicMarginMascots src={marginUrl} />
      <div className="relative z-[2] mx-auto flex w-full max-w-[824px] items-start justify-center">
        <div className="public-app-surface min-h-dvh w-full min-w-0 max-w-[720px] shadow-[0_0_70px_rgba(32,60,50,0.12)]">
      <header className="public-header sticky top-0 z-40 border-b backdrop-blur-xl">
        <div className="flex h-[68px] w-full items-center justify-between px-4 sm:px-6">
          <Link href="/" aria-label="기브싸인 홈">
            <Logo />
          </Link>

          {/*
            알림 버튼.
            PC 에서는 햄버거(lg:hidden)가 숨겨지므로 이 버튼만 남아 우측 상단에 위치하고,
            모바일에서는 햄버거 바로 왼쪽에 나란히 놓인다.
            알림은 사용자별 데이터라 로그인한 경우에만 노출한다.
          */}
          <div className="flex items-center gap-2">
            {viewer ? <NotificationBell /> : null}
            <button
              type="button"
              aria-label="메뉴"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="grid h-10 w-10 place-items-center rounded-full border border-ink-200 bg-white text-ink-700 shadow-sm lg:hidden"
            >
              {open ? <X size={18} strokeWidth={1.6} /> : <Menu size={18} strokeWidth={1.6} />}
            </button>
          </div>
        </div>

        {open ? (
          <div className="border-t border-ink-100 bg-white px-4 py-3 lg:hidden">
            {[...nav, ...DRAWER_EXTRA].map((m) => {
              const DrawerIcon = m.icon;
              const drawerContent = (
                <>
                  <span className="grid h-8 w-8 place-items-center rounded-[10px] border border-brand-100 bg-brand-50 text-brand-700">
                    <DrawerIcon size={16} strokeWidth={1.75} />
                  </span>
                  <span>{m.label}</span>
                </>
              );
              const drawerClass = 'flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-[14px] font-semibold text-ink-700 hover:bg-ink-50';
              return m.lookup ? (
                <button key={m.href + m.label} type="button" onClick={() => { setOpen(false); setLookupOpen(true); }} className={drawerClass}>
                  {drawerContent}
                </button>
              ) : (
                <Link key={m.href + m.label} href={m.href} onClick={() => setOpen(false)} className={drawerClass}>
                  {drawerContent}
                </Link>
              );
            })}
            {viewer ? (
              <form action="/api/auth/logout" method="post" className="border-t border-ink-100 pt-2">
                <button
                  type="submit"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-3 text-[15px] font-semibold text-ink-500"
                >
                  <LogOut size={16} strokeWidth={1.7} />
                  로그아웃
                </button>
              </form>
            ) : (
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-lg border-t border-ink-100 px-2 py-3 text-[15px] font-semibold text-brand-700"
              >
                <LogIn size={16} strokeWidth={1.7} />
                로그인
              </Link>
            )}
          </div>
        ) : null}
      </header>

      <main className="public-content px-4 py-5 sm:px-6 sm:py-7">
        {children}
        {/*
          보조 영역.
          레이아웃이 한 컬럼(앱 화면 형태)으로 바뀌면서 aside 를 아무 데도 그리지 않아,
          고객센터·사회복지기관 가입 신청 같은 안내 카드가 통째로 사라져 있었다.
          좁은 화면 기준이므로 본문 아래에 이어 붙인다.
        */}
        {aside ? <div className="mt-8 border-t border-ink-100 pt-6">{aside}</div> : null}
      </main>

      <Footer />
        </div>

        {/* PC 우측 메뉴: 화면 세로 중앙에 붙는다 */}
        <aside
          className="sticky top-1/2 hidden max-h-[calc(100dvh-2rem)] w-[96px] shrink-0 -translate-y-1/2 self-start overflow-y-auto pl-2 lg:block"
          aria-label="PC 메뉴"
        >
          <nav className="public-side-nav flex w-full flex-col items-center gap-0.5 rounded-[24px] border px-2 py-3 backdrop-blur-xl">
            <Link
              href="/"
              aria-label="기브싸인 홈"
              className="mb-2 grid h-10 w-10 place-items-center rounded-[14px] bg-ink-900 text-brand-400 shadow-[0_8px_18px_rgba(32,60,50,0.24)] ring-1 ring-white/10 transition-transform hover:-translate-y-0.5"
            >
              <GiveSignMark size={38} onDark />
            </Link>
            {nav.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href, item.my);
              const cls = cx(
                'group flex w-full flex-col items-center gap-0.5 rounded-[14px] py-2 text-[9.5px] font-bold transition-all',
                active ? 'bg-brand-50 text-brand-700 shadow-[inset_0_0_0_1px_rgba(237,166,0,0.14)]' : 'text-ink-400 hover:bg-ink-50 hover:text-ink-900',
              );
              const inner = (
                <>
                  <span
                    className={cx(
                      'grid h-8 w-8 place-items-center rounded-[11px] border transition-all group-hover:-translate-y-0.5',
                      active
                        ? 'border-brand-300/80 bg-brand-400 text-ink-900 shadow-[0_4px_10px_rgba(237,166,0,0.22)]'
                        : 'border-ink-100 bg-white text-ink-400 group-hover:border-brand-200 group-hover:bg-brand-50 group-hover:text-brand-700',
                    )}
                  >
                    <Icon size={17} strokeWidth={active ? 2 : 1.7} />
                  </span>
                  <span>{item.label}</span>
                </>
              );
              return item.lookup ? (
                <button key={item.href + item.label} type="button" onClick={() => setLookupOpen(true)} className={cls}>{inner}</button>
              ) : (
                <Link key={item.href + item.label} href={item.href} aria-current={active ? 'page' : undefined} className={cls}>{inner}</Link>
              );
            })}

            <div className="mt-1.5 h-px w-8 bg-ink-100" />

            {viewer ? (
              <>
                <Link
                  href={myHref}
                  className="group mt-1.5 flex w-full flex-col items-center gap-1 rounded-[14px] py-2 text-ink-500 transition-colors hover:bg-ink-50"
                  aria-label="내 프로필"
                >
                  <ProfileAvatar
                    seed={viewer.avatarSeed}
                    avatarIndex={viewer.avatarIndex}
                    name={viewer.name ?? viewer.email}
                    imageUrl={viewer.avatarUrl}
                    className="h-9 w-9"
                  />
                  <span className="w-full truncate text-center text-[9px] font-bold text-ink-700">
                    {viewer.name ?? viewer.email ?? '사용자'}
                  </span>
                  <span className="text-[8px] font-semibold text-ink-300">{viewer.roleLabel}</span>
                </Link>
                <form action="/api/auth/logout" method="post" className="w-full">
                  <button
                    type="submit"
                    className="flex w-full flex-col items-center gap-0.5 rounded-[14px] py-2 text-[9.5px] font-bold text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-900"
                  >
                    <LogOut size={17} strokeWidth={1.65} />
                    <span>로그아웃</span>
                  </button>
                </form>
              </>
            ) : (
              <Link
                href="/login"
                className={cx(
                  'mt-1.5 flex w-full flex-col items-center gap-0.5 rounded-[14px] py-2 text-[9.5px] font-bold transition-all',
                  isActive(pathname, '/login')
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-ink-400 hover:bg-ink-50 hover:text-ink-900',
                )}
              >
                <LogIn size={18} strokeWidth={1.65} />
                <span>로그인</span>
              </Link>
            )}

            <p className="mt-2 text-[8px] font-extrabold tracking-[0.12em] text-ink-300">GiveSign</p>
          </nav>
        </aside>
      </div>

      <nav className="public-bottom-nav fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        <div className="mx-auto grid max-w-[720px] grid-cols-5">
          {nav.map((t) => {
            const Icon = t.icon;
            const active = isActive(pathname, t.href, t.my);
            const cls = cx(
              'flex min-h-16 flex-col items-center justify-center gap-1 py-2 text-[11px] font-semibold',
              active ? 'text-brand-700' : 'text-ink-400',
            );
            const inner = (
              <>
                <span
                  className={cx(
                    'grid h-8 w-8 place-items-center rounded-[11px] border',
                    active ? 'border-brand-300 bg-brand-400 text-ink-900 shadow-sm' : 'border-transparent bg-ink-50 text-ink-400',
                  )}
                >
                  {t.my && viewer && viewer.myHref !== '/my' ? (
                    <LayoutDashboard size={18} strokeWidth={1.75} />
                  ) : (
                    <Icon size={18} strokeWidth={1.75} />
                  )}
                </span>
                {t.label}
              </>
            );
            return t.lookup ? (
              <button key={t.href + t.label} type="button" onClick={() => setLookupOpen(true)} className={cls}>{inner}</button>
            ) : (
              <Link key={t.href + t.label} href={t.href} className={cls}>{inner}</Link>
            );
          })}
        </div>
      </nav>

      <ChargeLookupSheet open={lookupOpen} onClose={() => setLookupOpen(false)} />

    </div>
  );
}

function Footer() {
  return (
    <footer className="public-footer mt-10 border-t">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 text-[12px] leading-relaxed text-ink-400">
        <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2 text-[13px] font-semibold text-ink-700">
          <Link href="/terms">이용약관</Link>
          <Link href="/privacy">개인정보처리방침</Link>
          <Link href="/terms/e-finance">전자금융거래약관</Link>
          <Link href="/support">고객센터</Link>
        </div>
        <p>GiveSign(기브싸인) | 쉽고 빠른 문자후원</p>
        <p className="mt-1">사회복지기관 전용 MO 번호와 후원페이지로 이웃에게 따뜻한 마음을 전하는 문자후원 플랫폼입니다.</p>
        <p className="mt-1">현재 준비 단계로 실제 결제와 문자 발송은 비활성화되어 있습니다.</p>
      </div>
    </footer>
  );
}
