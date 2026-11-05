import { PageHeader } from '@/components/layout/console-shell';
import { Card, EmptyState, LinkButton, Notice, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect, FilterBar } from '@/components/admin/controls';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { adminBazaarContext, ADMIN_BAZAAR_TABS } from '@/server/admin-bazaar-context';
import { productSalesSummary } from '@/server/services/bazaar';
import { getBazaarConfig } from '@/server/services/bazaar-settings';
import { endProductAction, listProductAction, updateProductAction } from '@/app/actions/admin/bazaar';
import { productStatusLabel, unsoldActionLabel } from '@/lib/bazaar';
import { formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * 판매 상품: 검수 확정된 품목 1개 = 상품 1개.
 * 1) 가격·배송비·수량을 정하고 2) 셀러브릭스 등록 정보를 내려받아 바자회 센터 창고 상품으로 등록한 뒤
 * 3) "등록 완료"를 누른다. 판매가 끝나면 남은 수량 처리 방법을 정해 종료한다.
 */
export default async function AdminBazaarProducts({ searchParams }: { searchParams: Promise<{ status?: string; merchantId?: string }> }) {
  await adminBazaarContext();
  const sp = await searchParams;
  const status = sp.status && Object.hasOwn(productStatusLabel, sp.status) ? sp.status : undefined;
  const [rows, cfg, merchants] = await Promise.all([
    prisma.bazaarProduct.findMany({
      where: { ...(status ? { status } : {}), ...(sp.merchantId ? { merchantId: sp.merchantId } : {}) },
      orderBy: { trackingCode: 'desc' },
      take: 300,
      include: { merchant: { select: { displayName: true } }, item: { select: { acceptedQty: true, unitValue: true } }, donation: { select: { donationNo: true, minSalePrice: true, unsoldAction: true } } },
    }),
    getBazaarConfig(),
    prisma.merchantBazaar.findMany({ include: { merchant: { select: { id: true, displayName: true } } } }),
  ]);
  const sums = await productSalesSummary(rows.map((p) => p.id));
  return (
    <>
      <PageHeader title="판매 상품" description={`판매가는 최소 ${cfg.minSalePrice.toLocaleString('ko-KR')}원 이상, 기부자가 정한 최저가 이상이어야 합니다. 셀러브릭스에는 상품명 앞 추적 코드를 그대로 붙여 등록하세요.`}
        action={<div className="flex flex-wrap gap-2"><LinkButton href="/api/bazaar/export?kind=sellerbricks" variant="secondary">셀러브릭스 등록 정보(등록 대기)</LinkButton><LinkButton href="/api/bazaar/export?kind=sellerbricks&status=all" variant="ghost">전체</LinkButton></div>} />
      <BazaarSubNav items={ADMIN_BAZAAR_TABS} current="/admin/bazaar/products" />
      <div className="mb-4"><Notice tone="brand">셀러브릭스에는 바자회 전용 창고(기브싸인 바자회 센터)의 상품으로 등록합니다. 방송 중 임시상품은 바자회 정산에 들어가지 않습니다(추적 코드가 없으면 판매 결과 입력에서 걸러집니다).</Notice></div>
      <FilterBar action="/admin/bazaar/products" resetHref="/admin/bazaar/products">
        <AdminSelect name="status" defaultValue={status ?? ''} aria-label="상태"><option value="">전체 상태</option>{Object.entries(productStatusLabel).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}</AdminSelect>
        <AdminSelect name="merchantId" defaultValue={sp.merchantId ?? ''} aria-label="기관"><option value="">전체 기관</option>{merchants.map((m) => <option key={m.merchant.id} value={m.merchant.id}>{m.merchant.displayName}</option>)}</AdminSelect>
      </FilterBar>
      <Card>
        {rows.length === 0 ? <EmptyState title="상품이 없습니다" description="기관이 검수를 확정하면 상품이 자동으로 만들어집니다." /> : (
          <Table>
            <thead><tr><Th>추적 코드</Th><Th>상품·기관</Th><Th className="text-right">판매 / 수량</Th><Th>상태</Th><Th>가격·배송비·수량</Th><Th>처리</Th></tr></thead>
            <tbody>{rows.map((p) => {
              const s = sums.get(p.id);
              const sold = (s?.soldQty ?? 0) - (s?.refundQty ?? 0);
              return (
                <tr key={p.id}>
                  <Td className="font-mono text-[12px] font-bold">{p.trackingCode}{p.externalRef ? <span className="block font-normal text-ink-400">SB {p.externalRef}</span> : null}</Td>
                  <Td>{p.name}<span className="block text-[11px] text-ink-400">{p.merchant.displayName} · {p.donation.donationNo} · 영수증 단가 {formatWon(p.item.unitValue ?? 0n)}</span></Td>
                  <Td className="text-right tabular-nums">{sold} / {p.quantity}<span className="block text-[11px] text-ink-400">{formatWon((s?.gross ?? 0n) - (s?.refund ?? 0n))}</span></Td>
                  <Td><LabelBadge map={productStatusLabel} value={p.status} />{p.remainingAction ? <span className="block text-[11px] text-ink-400">{unsoldActionLabel[p.remainingAction]}</span> : null}</Td>
                  <Td>
                    {p.status !== 'ENDED' ? (
                      <ActionForm action={updateProductAction} submitLabel="저장" variant="secondary" compact>
                        <input type="hidden" name="productId" value={p.id} />
                        <AdminInput name="name" defaultValue={p.name} aria-label="상품명" />
                        <div className="grid grid-cols-2 gap-1">
                          <AdminField label="판매가"><AdminInput name="salePrice" inputMode="numeric" defaultValue={p.salePrice.toString()} /></AdminField>
                          <AdminField label="배송비"><AdminInput name="shippingFee" inputMode="numeric" defaultValue={p.shippingFee.toString()} /></AdminField>
                          <AdminField label={`수량(최대 ${p.item.acceptedQty ?? 0})`}><AdminInput name="quantity" inputMode="numeric" defaultValue={String(p.quantity)} /></AdminField>
                          <AdminField label="1인 제한"><AdminInput name="perPersonLimit" inputMode="numeric" defaultValue={String(p.perPersonLimit)} /></AdminField>
                        </div>
                      </ActionForm>
                    ) : <span className="text-[12px] text-ink-400">{formatWon(p.salePrice)} · 배송 {formatWon(p.shippingFee)}</span>}
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-2">
                      {p.status === 'DRAFT' ? (
                        <ActionForm action={listProductAction} submitLabel="셀러브릭스 등록 완료" compact>
                          <input type="hidden" name="productId" value={p.id} />
                          <AdminInput name="externalRef" placeholder="셀러브릭스 상품번호(선택)" />
                        </ActionForm>
                      ) : null}
                      {p.status !== 'ENDED' ? (
                        <ActionForm action={endProductAction} submitLabel="판매 종료" variant="ghost" compact confirm="판매를 종료할까요? 셀러브릭스에서도 상품을 내려 주세요.">
                          <input type="hidden" name="productId" value={p.id} />
                          <AdminSelect name="remainingAction" defaultValue={p.donation.unsoldAction} aria-label="남은 수량 처리">
                            {['MERCHANT_USE', 'TRANSFER', 'RETURN', 'DISPOSE'].map((v) => <option key={v} value={v}>남은 수량: {unsoldActionLabel[v]}</option>)}
                          </AdminSelect>
                        </ActionForm>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              );
            })}</tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
