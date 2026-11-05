import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, EmptyState, Field, Input, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { studioBazaarContext, studioTabs } from '@/server/studio-bazaar-context';
import { respondMatchAction } from '@/app/actions/bazaar-studio';
import { donationStatusLabel, donorTypeLabel, type DonorType } from '@/lib/bazaar';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function StudioBazaarDonations() {
  const { merchant } = await studioBazaarContext();
  const mid = merchant.merchantId;
  const now = new Date();
  const [proposals, donations, lives] = await Promise.all([
    prisma.inKindMatch.findMany({
      where: { merchantId: mid, status: 'PROPOSED', deadline: { gte: now } },
      include: { donation: { include: { donor: { select: { donorType: true, displayName: true } }, items: true } } },
      orderBy: { proposedAt: 'asc' },
    }),
    prisma.inKindDonation.findMany({
      where: { merchantId: mid },
      orderBy: { updatedAt: 'desc' },
      include: { donor: { select: { donorType: true, displayName: true } }, _count: { select: { items: true } } },
      take: 200,
    }),
    prisma.bazaarLive.count({ where: { merchantId: mid, status: 'PROPOSED' } }),
  ]);
  const needs = donations.filter((d) => d.status === 'VALUATING' || d.status === 'INSPECTED').length;
  return (
    <>
      <PageHeader title="기부 접수함" description="매칭 제안을 수락하면 그 기부 건의 가액 협의를 시작합니다. 수락 기한이 지나면 다른 기관에 제안됩니다." />
      <BazaarSubNav items={studioTabs({ inbox: proposals.length + needs, lives })} current="/studio/bazaar/donations" />

      <Card>
        <CardTitle>매칭 제안</CardTitle>
        {proposals.length === 0 ? <p className="mt-2 text-[13px] text-ink-500">응답할 제안이 없습니다.</p> : (
          <ul className="mt-3 space-y-3">
            {proposals.map((m) => (
              <li key={m.id} className="rounded-2xl border border-ink-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[14.5px] font-extrabold text-ink-900">{m.donation.title}</p>
                  <span className="text-[12px] text-warning-500">수락 기한 {formatKst(m.deadline, false)}</span>
                </div>
                <p className="mt-1 text-[12.5px] text-ink-500">
                  {donorTypeLabel[m.donation.donor.donorType as DonorType]} 기부 · {m.donation.items.length}개 품목 · 제시 가액 {formatWon(m.donation.declaredTotal)} ·{' '}
                  <Link href={`/studio/bazaar/donations/${m.donation.id}`} className="font-bold text-brand-700 underline">물품 자세히 보기</Link>
                </p>
                <ul className="mt-2 text-[12.5px] text-ink-700">
                  {m.donation.items.slice(0, 5).map((it) => <li key={it.id}>· {it.name} × {it.quantity}</li>)}
                </ul>
                <div className="mt-3 flex flex-wrap items-start gap-3">
                  <ActionForm action={respondMatchAction} submitLabel="수락" compact>
                    <input type="hidden" name="matchId" value={m.id} />
                    <input type="hidden" name="decision" value="ACCEPT" />
                  </ActionForm>
                  <ActionForm action={respondMatchAction} submitLabel="거절" variant="secondary" compact>
                    <input type="hidden" name="matchId" value={m.id} />
                    <input type="hidden" name="decision" value="REJECT" />
                    <Field label="거절 사유"><Input name="reason" maxLength={200} className="h-9 text-[13px]" placeholder="예: 보관 공간 부족" /></Field>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-5">
        <CardTitle>우리 기관 기부 건</CardTitle>
        {donations.length === 0 ? <div className="mt-3"><EmptyState title="수락한 기부 건이 없습니다" /></div> : (
          <div className="mt-3"><Table>
            <thead><tr><Th>기부번호</Th><Th>물품</Th><Th>기부자</Th><Th className="text-right">가액</Th><Th>상태</Th><Th>최근 변경</Th></tr></thead>
            <tbody>
              {donations.map((d) => (
                <tr key={d.id}>
                  <Td><Link href={`/studio/bazaar/donations/${d.id}`} className="font-mono text-[12px] font-bold text-brand-700 underline">{d.donationNo}</Link></Td>
                  <Td>{d.title}<span className="block text-[11px] text-ink-400">{d._count.items}개 품목</span></Td>
                  <Td>{d.donor.displayName}<span className="block text-[11px] text-ink-400">{donorTypeLabel[d.donor.donorType as DonorType]}</span></Td>
                  <Td className="text-right tabular-nums">{formatWon(d.confirmedTotal ?? d.declaredTotal)}</Td>
                  <Td><LabelBadge map={donationStatusLabel} value={d.status} /></Td>
                  <Td>{formatKst(d.updatedAt, false)}</Td>
                </tr>
              ))}
            </tbody>
          </Table></div>
        )}
      </Card>
    </>
  );
}
