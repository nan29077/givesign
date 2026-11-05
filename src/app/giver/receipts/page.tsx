import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Table, Td, Th } from '@/components/ui';
import { prisma } from '@/server/db';
import { giverPageContext } from '@/server/giver-context';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function GiverReceipts() {
  const { donor } = await giverPageContext();
  const rows = await prisma.inKindReceipt.findMany({ where: { donorId: donor.id }, orderBy: { issuedAt: 'desc' }, include: { merchant: { select: { displayName: true } } } });
  return (
    <>
      <PageHeader title="기부금영수증" description="검수를 확정한 물품에 대해 기관 명의로 발급된 현물 기부금영수증입니다. 인쇄하거나 PDF 로 저장할 수 있습니다." />
      <Card>
        {rows.length === 0 ? <EmptyState title="발급된 영수증이 없습니다" description="입고·검수 후 기관이 검수를 확정하면 발급됩니다." /> : (
          <Table>
            <thead><tr><Th>발급번호</Th><Th>기관</Th><Th>귀속연도</Th><Th className="text-right">금액</Th><Th>발급일</Th><Th>상태</Th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td><Link href={`/giver/receipts/${r.id}`} className="font-mono text-[12px] font-bold text-brand-700 underline">{r.receiptNo}</Link></Td>
                  <Td>{r.merchant.displayName}</Td>
                  <Td>{r.taxYear}</Td>
                  <Td className="text-right tabular-nums">{formatWon(r.totalAmount)}</Td>
                  <Td>{formatKst(r.issuedAt, false)}</Td>
                  <Td>{r.status === 'ISSUED' ? <Badge tone="success">발급</Badge> : <Badge tone="danger">무효</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
