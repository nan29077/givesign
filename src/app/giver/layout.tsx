import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ConsoleShell, type NavGroup } from '@/components/layout/console-shell';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { bazaarPageGuard } from '@/server/services/bazaar-settings';
import { donorTypeLabel, type DonorType } from '@/lib/bazaar';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '기부자 콘솔', robots: { index: false, follow: false } };

/**
 * 현물 기부자(기업·개인) 콘솔. 라이브 바자회 스위치가 꺼지면 경로 전체가 404 다.
 */
export default async function GiverLayout({ children }: { children: React.ReactNode }) {
  await bazaarPageGuard();
  const user = await getSessionUser().catch(() => null);
  if (!user) redirect('/login?next=/giver');
  if (user.role !== 'GIVER') redirect(user.role === 'ADMIN' ? '/admin/bazaar' : user.role === 'MERCHANT' ? '/studio/bazaar' : '/bazaar/join');
  const donor = await prisma.inKindDonor.findUnique({ where: { userId: user.id }, select: { id: true, donorType: true, displayName: true } });
  if (!donor) redirect('/bazaar/join');
  const todo = await prisma.inKindDonation.count({ where: { donorId: donor.id, status: { in: ['VALUATING', 'VALUE_CONFIRMED'] } } });
  const groups: NavGroup[] = [
    {
      title: '기부',
      items: [
        { href: '/giver', label: '홈', icon: 'dashboard', badge: todo },
        { href: '/giver/donate', label: '물품 기부하기', icon: 'products' },
        { href: '/giver/donations', label: '내 기부', icon: 'donors' },
      ],
    },
    {
      title: '결과',
      items: [
        { href: '/giver/receipts', label: '기부금영수증', icon: 'receipts' },
        { href: '/giver/report', label: '기부 리포트', icon: 'activity' },
      ],
    },
    { title: '계정', items: [{ href: '/giver/account', label: '회원 정보', icon: 'profile' }] },
  ];
  return (
    <ConsoleShell
      title="기부자 콘솔"
      groups={groups}
      user={{ id: user.id, name: donor.displayName, role: `${donorTypeLabel[donor.donorType as DonorType] ?? ''} 기부 회원`, avatarIndex: user.avatarIndex }}
    >
      {children}
    </ConsoleShell>
  );
}
