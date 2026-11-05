import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { Card } from '@/components/ui';
import { GiverSignupForm } from '@/components/bazaar/giver-signup-form';
import { bazaarPageGuard } from '@/server/services/bazaar-settings';
import { getSessionUser } from '@/server/auth';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '현물 기부 회원가입', robots: { index: false, follow: false } };

export default async function GiverJoinPage() {
  await bazaarPageGuard();
  const user = await getSessionUser().catch(() => null);
  if (user?.role === 'GIVER') redirect('/giver');
  return (
    <PublicShell>
      <PageHeader eyebrow="라이브 바자회" title="현물 기부 회원가입" description="기업 또는 개인으로 가입하고 물품 기부를 시작하세요. 기부 진행 상황과 기부금영수증을 기부자 콘솔에서 확인합니다." />
      <Card>
        <GiverSignupForm />
        <p className="mt-4 text-center text-[13px] text-ink-500">
          이미 가입하셨나요 <Link href="/login?next=/giver" className="font-semibold text-brand-700">로그인</Link>
        </p>
      </Card>
    </PublicShell>
  );
}
