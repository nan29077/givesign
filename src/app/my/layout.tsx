import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PublicShell } from '@/components/layout/public-shell';
import { MyNav } from '@/components/my/my-nav';
import { Card, CardTitle, LinkButton } from '@/components/ui';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { GeneratedAvatar } from '@/components/profile/generated-avatar';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '마이페이지',
  robots: { index: false, follow: false },
};

export default async function MyLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/my');

  const payer = await prisma.payerProfile.findUnique({
    where: { userId: user.id },
    select: { phoneMasked: true, registeredAt: true },
  });

  return (
    <PublicShell aside={<MyAside />}>
      <header className="mb-4 flex items-center gap-3">
        <GeneratedAvatar seed={user.id} avatarIndex={user.avatarIndex} name={user.name} className="h-12 w-12" />
        <div className="min-w-0">
          <h1 className="truncate text-[18px] font-black tracking-[-0.03em] text-ink-900">
            {user.name ?? '후원자'} 님
          </h1>
          <p className="mt-0.5 truncate text-[12.5px] text-ink-400">
            {payer?.phoneMasked ?? user.email ?? '휴대폰 번호 미연결'}
          </p>
        </div>
      </header>

      <MyNav />
      {children}
    </PublicShell>
  );
}

function MyAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>도움이 필요하신가요</CardTitle>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          환불, 결제 오류, 계좌 등록 문제는 거래번호와 함께 문의해 주세요.
        </p>
        <div className="mt-3 space-y-2">
          <LinkButton href="/support" variant="secondary" size="md" className="w-full">
            고객센터 문의
          </LinkButton>
          <LinkButton href="/faq" variant="secondary" size="md" className="w-full">
            자주 묻는 질문
          </LinkButton>
        </div>
      </Card>
    </div>
  );
}
