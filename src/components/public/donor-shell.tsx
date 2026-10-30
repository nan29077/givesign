import Link from 'next/link';
import { Home, LogIn, LogOut, Megaphone, UserRound } from 'lucide-react';
import { cx } from '@/components/ui';
import { OrgLogo } from '@/components/brand/org-logo';
import { PublicMarginMascots } from '@/components/brand/mascot-decorations';
import { donorLogoutAction } from '@/app/actions/donor-member';
import type { DonorViewer } from '@/server/services/donor-members';

/**
 * 기관 후원페이지 공통 틀 (/donate/[code] 와 그 아래 회원 화면).
 *
 *  - 가운데 앱 기둥(최대 720px) + 오른쪽 메뉴(넓은 화면) / 하단 탭(좁은 화면)
 *  - 왼쪽 상단: 기관 로고 + 기관명 한 줄
 *  - 오른쪽 메뉴: 로고만(기관명 없음) · 홈 · 모금 캠페인 · 마이페이지 · 로그인/로그아웃
 *  - 로그인·마이페이지는 이 기관 전용 후원 회원 화면으로 간다(기관마다 독립된 회원).
 */

export type DonorNav = 'home' | 'campaigns' | 'my' | 'login';

export interface ShellOrg {
  code: string;
  displayName: string;
  logoUrl: string | null;
}

export function DonorShell({
  org,
  viewer,
  active,
  color = '#28634e',
  backgroundUrl,
  children,
}: {
  org: ShellOrg;
  viewer: DonorViewer | null;
  active: DonorNav;
  color?: string;
  backgroundUrl?: string | null;
  children: React.ReactNode;
}) {
  const base = `/donate/${org.code}`;
  const items: Array<{ key: DonorNav; href: string; label: string; icon: React.ReactNode }> = [
    { key: 'home', href: base, label: '홈', icon: <Home size={20} strokeWidth={1.7} /> },
    { key: 'campaigns', href: `${base}#donation-campaigns`, label: '모금 캠페인', icon: <Megaphone size={20} strokeWidth={1.7} /> },
    { key: 'my', href: viewer ? `${base}/my` : `${base}/login?next=${encodeURIComponent(`${base}/my`)}`, label: '마이페이지', icon: <UserRound size={20} strokeWidth={1.7} /> },
  ];

  return (
    <main className="donation-canvas relative isolate min-h-screen" style={{ ['--org' as string]: color }}>
      <PublicMarginMascots src={backgroundUrl || undefined} />
      <div className="relative z-[2] mx-auto flex max-w-[860px] items-start justify-center gap-5 lg:px-4 lg:py-6">
        {/* 앱 기둥 */}
        <div className="w-full max-w-[720px] overflow-hidden bg-[#fffdf9] pb-24 lg:rounded-[32px] lg:pb-0 lg:shadow-[0_20px_60px_rgba(48,65,45,0.10)]">
          <header className="flex items-center justify-between gap-3 border-b border-ink-100/80 bg-white/80 px-5 py-4 backdrop-blur sm:px-7">
            <Link href={base} className="flex min-w-0 items-center gap-2.5" aria-label={`${org.displayName} 후원 홈`}>
              <OrgLogo code={org.code} name={org.displayName} logoUrl={org.logoUrl} className="h-9 w-9" />
              <span className="truncate text-[16px] font-black tracking-[-0.02em] text-ink-900">{org.displayName}</span>
            </Link>
            {viewer ? (
              <Link href={`${base}/my`} className="flex shrink-0 items-center gap-1.5 rounded-full border border-ink-200 bg-white px-3.5 py-2 text-[12.5px] font-bold text-ink-700 lg:hidden">
                <UserRound size={16} strokeWidth={1.7} /> {viewer.name}님
              </Link>
            ) : (
              <Link href={`${base}/login`} className="flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-extrabold text-white lg:hidden" style={{ backgroundColor: color }}>
                <LogIn size={16} strokeWidth={1.7} /> 로그인
              </Link>
            )}
            <p className="hidden shrink-0 text-[12px] text-ink-400 lg:block">작은 마음이 만드는 따뜻한 변화</p>
          </header>

          {children}

          <footer className="mx-5 mb-8 mt-10 rounded-[28px] border border-ink-100 bg-white p-6 sm:mx-7">
            <div className="flex items-center gap-3 border-b border-ink-100 pb-4">
              <OrgLogo code={org.code} name={org.displayName} logoUrl={org.logoUrl} className="h-9 w-9" />
              <p className="truncate text-[14px] font-extrabold text-ink-900">{org.displayName}</p>
            </div>
            <nav aria-label="법적 안내" className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-ink-500">
              <Link href="/terms" className="hover:underline">이용약관</Link>
              <Link href="/privacy" className="font-bold text-ink-700 hover:underline">개인정보처리방침</Link>
              <Link href="/terms/e-finance" className="hover:underline">전자금융거래약관</Link>
              <Link href="/how-it-works" className="hover:underline">이용 안내</Link>
              <Link href="/support" className="hover:underline">고객센터</Link>
            </nav>
            <p className="mt-3 text-[11.5px] text-ink-400">© {new Date().getFullYear()} {org.displayName} · 기브싸인 후원 페이지</p>
          </footer>
        </div>

        {/* 오른쪽 메뉴 (넓은 화면) */}
        <nav aria-label="기관 후원 메뉴" className="sticky top-[50vh] hidden w-[104px] -translate-y-1/2 shrink-0 flex-col items-stretch rounded-[28px] bg-white/95 p-3 shadow-[0_14px_40px_rgba(48,65,45,0.12)] backdrop-blur lg:flex">
          <Link href={base} className="mx-auto mb-3 mt-1" aria-label={`${org.displayName} 후원 홈`}>
            <OrgLogo code={org.code} name={org.displayName} logoUrl={org.logoUrl} className="h-14 w-14" />
          </Link>
          <div className="mb-2 h-px bg-ink-100" />
          <div className="flex flex-col gap-1">
            {items.map((it) => (
              <Link
                key={it.key}
                href={it.href}
                aria-current={active === it.key ? 'page' : undefined}
                className={cx(
                  'flex flex-col items-center gap-1.5 rounded-2xl px-1 py-3 text-[11.5px] font-bold transition-colors',
                  active === it.key ? 'bg-[color-mix(in_srgb,var(--org)_10%,white)] text-[var(--org)]' : 'text-ink-500 hover:bg-ink-50 hover:text-ink-800',
                )}
              >
                {it.icon}
                {it.label}
              </Link>
            ))}
          </div>
          <div className="my-2 h-px bg-ink-100" />
          {viewer ? (
            <form action={donorLogoutAction}>
              <input type="hidden" name="code" value={org.code} />
              <button type="submit" className="flex w-full flex-col items-center gap-1.5 rounded-2xl border border-ink-200 bg-white px-1 py-3 text-[11.5px] font-bold text-ink-600 hover:bg-ink-50">
                <LogOut size={20} strokeWidth={1.7} />
                로그아웃
              </button>
            </form>
          ) : (
            <Link
              href={`${base}/login`}
              aria-current={active === 'login' ? 'page' : undefined}
              className="flex flex-col items-center gap-1.5 rounded-2xl px-1 py-3 text-[11.5px] font-extrabold text-white shadow-md"
              style={{ backgroundColor: color }}
            >
              <LogIn size={20} strokeWidth={1.7} />
              로그인
            </Link>
          )}
        </nav>
      </div>

      {/* 하단 탭 (좁은 화면) */}
      <nav aria-label="기관 후원 메뉴" className="fixed inset-x-0 bottom-0 z-20 border-t border-ink-100 bg-white/95 backdrop-blur lg:hidden">
        <div className="mx-auto grid max-w-[720px] grid-cols-3 px-2 pb-[max(env(safe-area-inset-bottom),6px)] pt-1.5">
          {items.map((it) => (
            <Link
              key={it.key}
              href={it.href}
              aria-current={active === it.key ? 'page' : undefined}
              className={cx('flex flex-col items-center gap-1 rounded-xl py-1.5 text-[11px] font-bold', active === it.key ? 'text-[var(--org)]' : 'text-ink-400')}
            >
              {it.icon}
              {it.label}
            </Link>
          ))}
        </div>
      </nav>
    </main>
  );
}
