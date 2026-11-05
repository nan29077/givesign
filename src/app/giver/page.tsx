import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, EmptyState, LinkButton, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { giverPageContext } from '@/server/giver-context';
import { donationStatusLabel } from '@/lib/bazaar';
import { formatWon } from '@/lib/money';
import { formatKst, kstDateKey } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function GiverHome() {
  const { donor } = await giverPageContext();
  const year = Number(kstDateKey().slice(0, 4));
  const [donations, receipts] = await Promise.all([
    prisma.inKindDonation.findMany({
      where: { donorId: donor.id },
      orderBy: { createdAt: 'desc' },
      include: { merchant: { select: { displayName: true } }, valuations: { orderBy: { createdAt: 'desc' }, take: 1 } },
    }),
    prisma.inKindReceipt.findMany({ where: { donorId: donor.id, status: 'ISSUED' }, select: { totalAmount: true, taxYear: true } }),
  ]);
  const todos: Array<{ id: string; title: string; text: string }> = [];
  for (const d of donations) {
    const last = d.valuations[0];
    if (d.status === 'VALUATING' && last && last.actorType === 'MERCHANT' && last.kind === 'COUNTER') todos.push({ id: d.id, title: d.title, text: '기관이 가액을 다시 제안했습니다. 수락하거나 다시 제안해 주세요.' });
    if (d.status === 'VALUE_CONFIRMED') todos.push({ id: d.id, title: d.title, text: '가액이 확정되었습니다. 기부 약정에 동의해 주세요.' });
    if (d.status === 'PLEDGED' && d.deliveryMethod === 'SEND' && !d.shippingTrackingNo) todos.push({ id: d.id, title: d.title, text: '창고로 물품을 보내고 송장번호를 적어 주세요.' });
  }
  const needReceiptInfo = donor.donorType === 'INDIVIDUAL' && !donor.residentNoEnc && donations.some((d) => !['CANCELED', 'SUBMITTED'].includes(d.status));
  const active = donations.filter((d) => !['CANCELED', 'RETURNED', 'CLOSED'].includes(d.status)).length;
  const thisYear = receipts.filter((r) => r.taxYear === year).reduce((s, r) => s + r.totalAmount, 0n);

  return (
    <>
      <PageHeader title={`${donor.displayName} 님, 반갑습니다`} description="물품 기부 진행 상황과 기부금영수증을 한곳에서 확인합니다." action={<LinkButton href="/giver/donate">물품 기부하기</LinkButton>} />
      {needReceiptInfo ? (
        <div className="mb-4">
          <Notice tone="warning" title="영수증 정보를 등록해 주세요">
            개인 기부금영수증은 성명·주민등록번호가 있어야 발급됩니다. <Link href="/giver/account" className="font-bold underline">회원 정보</Link>에서 등록해 주세요.
          </Notice>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="해야 할 일" value={`${todos.length}건`} tone={todos.length ? 'warning' : 'neutral'} />
        <StatTile label="진행 중 기부" value={`${active}건`} />
        <StatTile label={`${year}년 영수증 합계`} value={formatWon(thisYear)} tone="brand" />
        <StatTile label="전체 기부" value={`${donations.length}건`} />
      </div>

      <Card className="mt-5">
        <CardTitle>해야 할 일</CardTitle>
        {todos.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-500">지금 처리할 일은 없습니다. 진행 상황은 알림과 이 화면으로 알려 드립니다.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {todos.map((t, i) => (
              <li key={`${t.id}-${i}`}>
                <Link href={`/giver/donations/${t.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-ink-200 px-4 py-3 hover:bg-ink-50">
                  <span>
                    <span className="block text-[14px] font-bold text-ink-900">{t.title}</span>
                    <span className="block text-[12.5px] text-ink-500">{t.text}</span>
                  </span>
                  <ArrowRight size={16} strokeWidth={1.7} aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-5">
        <CardTitle>최근 기부</CardTitle>
        {donations.length === 0 ? (
          <div className="mt-3"><EmptyState title="아직 기부 내역이 없습니다" action={<LinkButton href="/giver/donate">첫 기부 접수하기</LinkButton>} /></div>
        ) : (
          <div className="mt-3"><Table>
            <thead><tr><Th>기부번호</Th><Th>물품</Th><Th>기관</Th><Th>상태</Th><Th>접수일</Th></tr></thead>
            <tbody>
              {donations.slice(0, 8).map((d) => (
                <tr key={d.id}>
                  <Td><Link href={`/giver/donations/${d.id}`} className="font-mono text-[12px] font-bold text-brand-700 underline">{d.donationNo}</Link></Td>
                  <Td>{d.title}</Td>
                  <Td>{d.merchant?.displayName ?? '매칭 전'}</Td>
                  <Td><LabelBadge map={donationStatusLabel} value={d.status} /></Td>
                  <Td>{formatKst(d.createdAt, false)}</Td>
                </tr>
              ))}
            </tbody>
          </Table></div>
        )}
      </Card>
    </>
  );
}
