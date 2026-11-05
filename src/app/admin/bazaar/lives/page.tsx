import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect, AdminTextarea } from '@/components/admin/controls';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { adminBazaarContext, ADMIN_BAZAAR_TABS } from '@/server/admin-bazaar-context';
import { createLiveAction, liveStatusAction, saveSellerAction } from '@/app/actions/admin/bazaar';
import { liveStatusLabel } from '@/lib/bazaar';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/** 편성·셀러: 기브싸인 소속 셀러 명단과 방송 편성. 방송 자체는 셀러브릭스에서 한다. */
export default async function AdminBazaarLives({ searchParams }: { searchParams: Promise<{ merchantId?: string }> }) {
  await adminBazaarContext();
  const sp = await searchParams;
  const [sellers, lives, merchants] = await Promise.all([
    prisma.bazaarSeller.findMany({ orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] }),
    prisma.bazaarLive.findMany({ orderBy: { scheduledAt: 'desc' }, take: 100, include: { seller: { select: { name: true } } } }),
    prisma.merchantBazaar.findMany({ where: { status: 'APPROVED' }, include: { merchant: { select: { id: true, displayName: true } } } }),
  ]);
  const mName = new Map(merchants.map((m) => [m.merchant.id, m.merchant.displayName]));
  const selMerchant = sp.merchantId && mName.has(sp.merchantId) ? sp.merchantId : merchants[0]?.merchant.id;
  const products = selMerchant ? await prisma.bazaarProduct.findMany({ where: { merchantId: selMerchant, status: { in: ['DRAFT', 'LISTED'] } }, orderBy: { trackingCode: 'asc' } }) : [];
  return (
    <>
      <PageHeader title="편성·셀러" description="셀러와 방송 일시·판매 상품을 정해 기관에 편성을 제안합니다. 기관이 승인하면 셀러가 셀러브릭스에서 방송합니다." />
      <BazaarSubNav items={ADMIN_BAZAAR_TABS} current="/admin/bazaar/lives" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>새 편성</CardTitle>
          {merchants.length === 0 ? <p className="mt-2 text-[13px] text-ink-500">참여 승인된 기관이 없습니다.</p> : (
            <>
              <form method="get" className="mt-3 flex items-end gap-2">
                <AdminField label="기관(바꾸면 상품 목록이 바뀝니다)" className="flex-1"><AdminSelect name="merchantId" defaultValue={selMerchant}>{merchants.map((m) => <option key={m.merchant.id} value={m.merchant.id}>{m.merchant.displayName}</option>)}</AdminSelect></AdminField>
                <button className="h-9 rounded-lg border border-ink-200 px-3 text-[12px] font-bold">불러오기</button>
              </form>
              <div className="mt-3">
                <ActionForm action={createLiveAction} submitLabel="편성 제안">
                  <input type="hidden" name="merchantId" value={selMerchant} />
                  <AdminField label="방송 제목"><AdminInput name="title" placeholder="예: ○○복지관 나눔 바자회 1회" /></AdminField>
                  <div className="grid grid-cols-2 gap-2">
                    <AdminField label="방송 일시"><AdminInput type="datetime-local" name="scheduledAt" /></AdminField>
                    <AdminField label="셀러"><AdminSelect name="sellerId">{sellers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</AdminSelect></AdminField>
                  </div>
                  <AdminField label="셀러브릭스 방송 주소(나중에 넣어도 됩니다)"><AdminInput name="broadcastUrl" placeholder="https://" /></AdminField>
                  <fieldset className="rounded-lg border border-ink-200 p-2">
                    <legend className="px-1 text-[11px] font-semibold text-ink-400">판매 상품</legend>
                    {products.length === 0 ? <p className="text-[12px] text-ink-400">판매할 상품이 없습니다.</p> : products.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 py-0.5 text-[12.5px]"><input type="checkbox" name="productIds" value={p.id} defaultChecked /> <span className="font-mono">{p.trackingCode}</span> {p.name}</label>
                    ))}
                  </fieldset>
                  <AdminField label="메모"><AdminTextarea name="note" rows={2} /></AdminField>
                </ActionForm>
              </div>
            </>
          )}
        </Card>
        <Card>
          <CardTitle>셀러(기브싸인 소속)</CardTitle>
          <ul className="mt-3 space-y-2">
            {sellers.map((s) => (
              <li key={s.id} className="rounded-lg border border-ink-200 p-2">
                <details>
                  <summary className="cursor-pointer text-[13px]"><strong>{s.name}</strong> · 셀러브릭스 {s.sellerbricksId} · {s.phoneMasked ?? '-'} {s.active ? <Badge tone="success">활동</Badge> : <Badge>중지</Badge>}</summary>
                  <div className="mt-2"><ActionForm action={saveSellerAction} submitLabel="저장" variant="secondary" compact>
                    <input type="hidden" name="sellerId" value={s.id} /><input type="hidden" name="activeField" value="1" />
                    <AdminInput name="name" defaultValue={s.name} aria-label="이름" /><AdminInput name="sellerbricksId" defaultValue={s.sellerbricksId} aria-label="셀러브릭스 계정" /><AdminInput name="phone" placeholder="연락처(바꿀 때만)" /><AdminInput name="memo" defaultValue={s.memo ?? ''} placeholder="메모" />
                    <label className="flex items-center gap-1 text-[12px]"><input type="checkbox" name="active" defaultChecked={s.active} /> 활동 중</label>
                  </ActionForm></div>
                </details>
              </li>
            ))}
          </ul>
          <div className="mt-3"><ActionForm action={saveSellerAction} submitLabel="셀러 추가" variant="secondary">
            <div className="grid grid-cols-2 gap-2">
              <AdminField label="이름"><AdminInput name="name" /></AdminField>
              <AdminField label="셀러브릭스 계정"><AdminInput name="sellerbricksId" /></AdminField>
              <AdminField label="연락처"><AdminInput name="phone" /></AdminField>
              <AdminField label="메모"><AdminInput name="memo" /></AdminField>
            </div>
          </ActionForm></div>
        </Card>
      </div>
      <Card className="mt-5">
        <CardTitle>편성 목록</CardTitle>
        {lives.length === 0 ? <div className="mt-3"><EmptyState title="편성이 없습니다" /></div> : (
          <div className="mt-3"><Table>
            <thead><tr><Th>일시</Th><Th>제목·기관</Th><Th>셀러</Th><Th>상품</Th><Th>상태</Th><Th>방송 주소·처리</Th></tr></thead>
            <tbody>{lives.map((l) => (
              <tr key={l.id}>
                <Td className="text-[12px]">{formatKst(l.scheduledAt, false)}</Td>
                <Td>{l.title}<span className="block text-[11px] text-ink-400">{mName.get(l.merchantId) ?? ''}</span></Td>
                <Td>{l.seller.name}</Td>
                <Td className="tabular-nums">{((l.productIds as string[]) ?? []).length}개</Td>
                <Td><LabelBadge map={liveStatusLabel} value={l.status} /></Td>
                <Td>
                  {l.status === 'PROPOSED' || l.status === 'APPROVED' ? (
                    <div className="flex flex-col gap-1.5">
                      <ActionForm action={liveStatusAction} submitLabel="주소 저장" variant="ghost" compact><input type="hidden" name="liveId" value={l.id} /><input type="hidden" name="status" value="URL" /><AdminInput name="broadcastUrl" defaultValue={l.broadcastUrl ?? ''} placeholder="https://" /></ActionForm>
                      <div className="flex gap-2">
                        <ActionForm action={liveStatusAction} submitLabel="방송 완료" compact><input type="hidden" name="liveId" value={l.id} /><input type="hidden" name="status" value="DONE" /></ActionForm>
                        <ActionForm action={liveStatusAction} submitLabel="취소" variant="ghost" compact confirm="편성을 취소할까요?"><input type="hidden" name="liveId" value={l.id} /><input type="hidden" name="status" value="CANCELED" /></ActionForm>
                      </div>
                    </div>
                  ) : l.broadcastUrl ? <a href={l.broadcastUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] text-brand-700 underline">방송 열기</a> : '-'}
                </Td>
              </tr>
            ))}</tbody>
          </Table></div>
        )}
      </Card>
    </>
  );
}
