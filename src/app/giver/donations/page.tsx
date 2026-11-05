import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, EmptyState, LinkButton, Table, Td, Th } from '@/components/ui';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { giverPageContext } from '@/server/giver-context';
import { donationStatusLabel } from '@/lib/bazaar';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function GiverDonations() {
  const { donor } = await giverPageContext();
  const rows = await prisma.inKindDonation.findMany({
    where: { donorId: donor.id },
    orderBy: { createdAt: 'desc' },
    include: { merchant: { select: { displayName: true } }, _count: { select: { items: true } } },
  });
  return (
    <>
      <PageHeader title="내 기부" description="접수한 물품 기부와 진행 상황입니다." action={<LinkButton href="/giver/donate">물품 기부하기</LinkButton>} />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="기부 내역이 없습니다" action={<LinkButton href="/giver/donate">물품 기부하기</LinkButton>} />
        ) : (
          <Table>
            <thead><tr><Th>기부번호</Th><Th>물품</Th><Th>기관</Th><Th className="text-right">가액</Th><Th>상태</Th><Th>접수일</Th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <Td><Link href={`/giver/donations/${d.id}`} className="font-mono text-[12px] font-bold text-brand-700 underline">{d.donationNo}</Link></Td>
                  <Td>{d.title}<span className="block text-[11px] text-ink-400">{d._count.items}개 품목</span></Td>
                  <Td>{d.merchant?.displayName ?? '매칭 전'}</Td>
                  <Td className="text-right tabular-nums">{formatWon(d.confirmedTotal ?? d.declaredTotal)}{d.confirmedTotal == null ? <span className="block text-[11px] text-ink-400">제시</span> : null}</Td>
                  <Td><LabelBadge map={donationStatusLabel} value={d.status} /></Td>
                  <Td>{formatKst(d.createdAt, false)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
