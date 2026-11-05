import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { adminBazaarContext, ADMIN_BAZAAR_TABS } from '@/server/admin-bazaar-context';
import { adminBazaarCounts } from '@/server/services/bazaar-views';
import { getBazaarConfig } from '@/server/services/bazaar-settings';
import { donationStatusLabel } from '@/lib/bazaar';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function AdminBazaarHome() {
  await adminBazaarContext();
  const [c, cfg, recent] = await Promise.all([
    adminBazaarCounts(),
    getBazaarConfig(),
    prisma.inKindDonation.findMany({ orderBy: { updatedAt: 'desc' }, take: 12, include: { donor: { select: { displayName: true } }, merchant: { select: { displayName: true } } } }),
  ]);
  const tile = (label: string, n: number, href: string, warn = true) => (
    <Link href={href} className="block"><StatTile label={label} value={`${n}건`} tone={n && warn ? 'warning' : 'neutral'} /></Link>
  );
  return (
    <>
      <PageHeader title="라이브 바자회 현황" description="현물 기부 접수부터 매칭·입고·판매 결과·정산까지 운영자가 처리할 일을 모았습니다." />
      <BazaarSubNav items={ADMIN_BAZAAR_TABS} current="/admin/bazaar" />
      {!cfg.warehouseAddress ? <div className="mb-4"><Notice tone="warning">기부자에게 안내할 창고 주소가 비어 있습니다. <Link href="/admin/bazaar/settings" className="font-bold underline">바자회 설정</Link>에서 입력해 주세요.</Notice></div> : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {tile('매칭 대기(접수)', c.submitted, '/admin/bazaar/donations?status=SUBMITTED')}
        {tile('기관 응답 대기', c.proposed, '/admin/bazaar/donations?status=MATCH_PROPOSED', false)}
        {tile('가액 협의·약정', c.valuating, '/admin/bazaar/donations?status=VALUATING', false)}
        {tile('입고 대기', c.waitingInbound, '/admin/bazaar/donations?status=PLEDGED')}
        {tile('검수 확정 대기', c.inspected, '/admin/bazaar/donations?status=INSPECTED', false)}
        {tile('셀러브릭스 등록 대기', c.draftProducts, '/admin/bazaar/products?status=DRAFT')}
        {tile('판매 중 상품', c.listed, '/admin/bazaar/products?status=LISTED', false)}
        {tile('판매 결과 승인 대기', c.draftBatches, '/admin/bazaar/sales')}
        {tile('미지급 정산', c.unpaid, '/admin/in-kind-settlements')}
        {tile('참여 신청 대기', c.applied, '/admin/bazaar/merchants')}
      </div>
      <Card className="mt-5">
        <CardTitle>최근 변경된 기부 건</CardTitle>
        <div className="mt-3"><Table>
          <thead><tr><Th>기부번호</Th><Th>물품</Th><Th>기부자</Th><Th>기관</Th><Th className="text-right">가액</Th><Th>상태</Th><Th>변경</Th></tr></thead>
          <tbody>{recent.map((d) => (
            <tr key={d.id}><Td><Link href={`/admin/bazaar/donations/${d.id}`} className="font-mono text-[12px] font-bold text-brand-700 underline">{d.donationNo}</Link></Td><Td>{d.title}</Td><Td>{d.donor.displayName}</Td><Td>{d.merchant?.displayName ?? '-'}</Td><Td className="text-right tabular-nums">{formatWon(d.confirmedTotal ?? d.declaredTotal)}</Td><Td><LabelBadge map={donationStatusLabel} value={d.status} /></Td><Td>{formatKst(d.updatedAt, false)}</Td></tr>
          ))}</tbody>
        </Table></div>
      </Card>
    </>
  );
}
