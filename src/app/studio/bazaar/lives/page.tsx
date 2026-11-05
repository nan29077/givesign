import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, EmptyState, Field, Input, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { studioBazaarContext, studioTabs } from '@/server/studio-bazaar-context';
import { decideLiveAction } from '@/app/actions/bazaar-studio';
import { liveStatusLabel } from '@/lib/bazaar';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function StudioBazaarLives() {
  const { merchant } = await studioBazaarContext();
  const lives = await prisma.bazaarLive.findMany({ where: { merchantId: merchant.merchantId }, include: { seller: { select: { name: true } } }, orderBy: { scheduledAt: 'desc' } });
  const ids = [...new Set(lives.flatMap((l) => (l.productIds as string[]) ?? []))];
  const products = await prisma.bazaarProduct.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, trackingCode: true } });
  const pname = new Map(products.map((p) => [p.id, `${p.trackingCode} ${p.name}`]));
  const pending = lives.filter((l) => l.status === 'PROPOSED');
  return (
    <>
      <PageHeader title="방송 편성" description="운영자가 셀러·일시·판매 상품을 정해 편성을 제안합니다. 승인하면 셀러브릭스 라이브로 방송합니다." />
      <BazaarSubNav items={studioTabs({ lives: pending.length })} current="/studio/bazaar/lives" />
      <Card>
        <CardTitle>승인 대기</CardTitle>
        {pending.length === 0 ? <p className="mt-2 text-[13px] text-ink-500">승인할 편성이 없습니다.</p> : (
          <ul className="mt-3 space-y-3">
            {pending.map((l) => (
              <li key={l.id} className="rounded-2xl border border-ink-200 p-4">
                <p className="text-[14.5px] font-extrabold text-ink-900">{l.title}</p>
                <p className="mt-1 text-[12.5px] text-ink-500">{formatKst(l.scheduledAt, false)} · 셀러 {l.seller.name}{l.note ? ` · ${l.note}` : ''}</p>
                <ul className="mt-2 text-[12.5px] text-ink-700">{((l.productIds as string[]) ?? []).map((pid) => <li key={pid}>· {pname.get(pid) ?? pid}</li>)}</ul>
                <div className="mt-3 flex flex-wrap items-start gap-3">
                  <ActionForm action={decideLiveAction} submitLabel="승인" compact><input type="hidden" name="liveId" value={l.id} /><input type="hidden" name="decision" value="APPROVE" /></ActionForm>
                  <ActionForm action={decideLiveAction} submitLabel="반려" variant="secondary" compact>
                    <input type="hidden" name="liveId" value={l.id} /><input type="hidden" name="decision" value="REJECT" />
                    <Field label="반려 사유"><Input name="note" maxLength={200} className="h-9 text-[13px]" /></Field>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="mt-5">
        <CardTitle>전체 편성</CardTitle>
        {lives.length === 0 ? <div className="mt-3"><EmptyState title="편성 내역이 없습니다" /></div> : (
          <div className="mt-3"><Table>
            <thead><tr><Th>일시</Th><Th>제목</Th><Th>셀러</Th><Th>상태</Th><Th>방송</Th></tr></thead>
            <tbody>{lives.map((l) => (
              <tr key={l.id}><Td>{formatKst(l.scheduledAt, false)}</Td><Td>{l.title}</Td><Td>{l.seller.name}</Td><Td><LabelBadge map={liveStatusLabel} value={l.status} /></Td>
                <Td>{l.broadcastUrl ? <a href={l.broadcastUrl} target="_blank" rel="noopener noreferrer" className="text-brand-700 underline">열기</a> : '-'}</Td></tr>
            ))}</tbody>
          </Table></div>
        )}
      </Card>
    </>
  );
}
