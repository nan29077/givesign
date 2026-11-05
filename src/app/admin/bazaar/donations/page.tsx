import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, EmptyState, Table, Td, Th } from '@/components/ui';
import { AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { adminBazaarContext, ADMIN_BAZAAR_TABS } from '@/server/admin-bazaar-context';
import { expireMatches } from '@/server/services/bazaar';
import { DONATION_STATUS, donationStatusLabel, donorTypeLabel, type DonorType } from '@/lib/bazaar';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';
const PAGE = 30;

export default async function AdminBazaarDonations({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; merchantId?: string; page?: string }> }) {
  await adminBazaarContext();
  await expireMatches().catch(() => 0);
  const sp = await searchParams;
  const status = sp.status && Object.hasOwn(donationStatusLabel, sp.status) ? sp.status : undefined;
  const q = (sp.q ?? '').trim().slice(0, 50);
  const page = Math.max(1, Number(sp.page) || 1);
  const where = {
    ...(status ? { status } : {}),
    ...(sp.merchantId ? { merchantId: sp.merchantId } : {}),
    ...(q ? { OR: [{ donationNo: { contains: q, mode: 'insensitive' as const } }, { title: { contains: q, mode: 'insensitive' as const } }, { donor: { displayName: { contains: q, mode: 'insensitive' as const } } }] } : {}),
  };
  const [total, rows, merchants] = await Promise.all([
    prisma.inKindDonation.count({ where }),
    prisma.inKindDonation.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * PAGE, take: PAGE, include: { donor: { select: { displayName: true, donorType: true } }, merchant: { select: { displayName: true } }, _count: { select: { items: true } } } }),
    prisma.merchantBazaar.findMany({ include: { merchant: { select: { id: true, displayName: true } } } }),
  ]);
  const lastPage = Math.max(1, Math.ceil(total / PAGE));
  return (
    <>
      <PageHeader title="현물 기부 관리" description="전 기관·전 기부자의 물품 기부를 단계별로 관리합니다. 기부 건을 열어 매칭·입고 검수·취소를 처리하세요." />
      <BazaarSubNav items={ADMIN_BAZAAR_TABS} current="/admin/bazaar/donations" />
      <FilterBar action="/admin/bazaar/donations" resetHref="/admin/bazaar/donations">
        <AdminSelect name="status" defaultValue={status ?? ''} aria-label="상태">
          <option value="">전체 상태</option>
          {Object.values(DONATION_STATUS).map((s) => <option key={s} value={s}>{donationStatusLabel[s].text}</option>)}
        </AdminSelect>
        <AdminSelect name="merchantId" defaultValue={sp.merchantId ?? ''} aria-label="기관">
          <option value="">전체 기관</option>
          {merchants.map((m) => <option key={m.merchant.id} value={m.merchant.id}>{m.merchant.displayName}</option>)}
        </AdminSelect>
        <AdminInput name="q" defaultValue={q} placeholder="기부번호·물품·기부자" />
      </FilterBar>
      <Card className="mt-3">
        {rows.length === 0 ? <EmptyState title="조건에 맞는 기부 건이 없습니다" /> : (
          <Table>
            <thead><tr><Th>기부번호</Th><Th>물품</Th><Th>기부자</Th><Th>기관</Th><Th className="text-right">가액</Th><Th>상태</Th><Th>접수 / 변경</Th></tr></thead>
            <tbody>{rows.map((d) => (
              <tr key={d.id}>
                <Td><Link href={`/admin/bazaar/donations/${d.id}`} className="font-mono text-[12px] font-bold text-brand-700 underline">{d.donationNo}</Link></Td>
                <Td>{d.title}<span className="block text-[11px] text-ink-400">{d._count.items}개 품목</span></Td>
                <Td>{d.donor.displayName}<span className="block text-[11px] text-ink-400">{donorTypeLabel[d.donor.donorType as DonorType]}</span></Td>
                <Td>{d.merchant?.displayName ?? '-'}</Td>
                <Td className="text-right tabular-nums">{formatWon(d.confirmedTotal ?? d.declaredTotal)}</Td>
                <Td><LabelBadge map={donationStatusLabel} value={d.status} /></Td>
                <Td className="text-[12px]">{formatKst(d.createdAt, false)}<span className="block text-ink-400">{formatKst(d.updatedAt, false)}</span></Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
        <Pager basePath="/admin/bazaar/donations" params={{ status, q, merchantId: sp.merchantId }} page={page} lastPage={lastPage} total={total} />
      </Card>
    </>
  );
}
