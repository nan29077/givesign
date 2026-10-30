import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { DonorShell } from '@/components/public/donor-shell';
import { DonorSignupForm, DonorSocialButtons } from '@/components/public/donor-auth-forms';
import { socialProviderStatus } from '@/server/adapters/social';
import { OrgLogo } from '@/components/brand/org-logo';
import { loadDonorContext, safeDonorNext } from '../_shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '후원 회원 가입', robots: { index: false } };

export default async function DonorSignupPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ next?: string }> }) {
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
          <h1 className="mt-4 text-[20px] font-black tracking-[-0.02em] text-ink-900">{ctx.org.displayName} 후원 회원 가입</h1>
          <p className="mt-1.5 text-[12.5px] text-ink-500">이 기관 후원페이지 전용 회원입니다.</p>
        </div>
        <div className="mt-6">
          <DonorSocialButtons code={ctx.org.code} ready={{ kakao: socialProviderStatus('kakao').ready, naver: socialProviderStatus('naver').ready }} />
        </div>
        <div className="mt-6">
          <DonorSignupForm code={ctx.org.code} next={next} color={ctx.color} orgName={ctx.org.displayName} />
        </div>
        <p className="mt-5 text-center text-[13px] text-ink-500">
          이미 회원이신가요?{' '}
          <Link href={`${base}/login?next=${encodeURIComponent(next)}`} className="font-extrabold underline" style={{ color: ctx.color }}>
            로그인
          </Link>
        </p>
      </section>
    </DonorShell>
  );
}
