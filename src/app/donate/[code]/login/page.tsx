import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { DonorShell } from '@/components/public/donor-shell';
import { DonorLoginForm } from '@/components/public/donor-auth-forms';
import { OrgLogo } from '@/components/brand/org-logo';
import { loadDonorContext, safeDonorNext } from '../_shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '후원 회원 로그인', robots: { index: false } };

export default async function DonorLoginPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ next?: string }> }) {
  const { code } = await params;
  const sp = await searchParams;
  const ctx = await loadDonorContext(code);
  const base = `/donate/${ctx.org.code}`;
  const next = safeDonorNext(ctx.org.code, sp.next, `${base}/my`);
  if (ctx.viewer) redirect(next);

  return (
    <DonorShell org={ctx.shellOrg} viewer={null} active="login" color={ctx.color} backgroundUrl={ctx.backgroundUrl}>
      <section className="mx-5 mt-8 rounded-[32px] bg-white p-6 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.06)] sm:mx-12 sm:p-8">
        <div className="text-center">
          <OrgLogo code={ctx.org.code} name={ctx.org.displayName} logoUrl={ctx.shellOrg.logoUrl} className="mx-auto h-16 w-16" />
          <h1 className="mt-4 text-[20px] font-black tracking-[-0.02em] text-ink-900">{ctx.org.displayName} 후원 회원 로그인</h1>
          <p className="mt-1.5 text-[12.5px] text-ink-500">이 기관 후원페이지에서 가입한 계정으로 로그인합니다.</p>
        </div>
        <div className="mt-6">
          <DonorLoginForm code={ctx.org.code} next={next} color={ctx.color} />
        </div>
        <p className="mt-5 text-center text-[13px] text-ink-500">
          아직 회원이 아니신가요?{' '}
          <Link href={`${base}/signup?next=${encodeURIComponent(next)}`} className="font-extrabold underline" style={{ color: ctx.color }}>
            후원 회원 가입
          </Link>
        </p>
        <p className="mt-3 rounded-2xl bg-ink-50 px-4 py-3 text-[11.5px] leading-relaxed text-ink-500">
          문자 후원은 회원 가입 없이도 할 수 있습니다. 회원이 되면 휴대폰 인증 후 이 기관에서의 후원 내역·정기후원·기부금영수증을 한곳에서 볼 수 있습니다.
          다른 기관 후원페이지의 계정과는 따로 관리됩니다.
        </p>
      </section>
    </DonorShell>
  );
}
