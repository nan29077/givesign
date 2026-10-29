import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminSelect, MerchantOptions, FilterBar, Pager } from '@/components/admin/controls';
import { PAGE_SIZE, parsePage, clampPage } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { digitalTypeLabel, productKindLabel, stockText } from '@/server/services/products';
import { PAID_STATUSES } from '@/components/studio/shared';
import type { Prisma } from '@/generated/prisma/client';
import type { ShipmentStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

/**
 * 최고관리자 상품·주문 모니터링.
 *
 * 사회복지기관이 무엇을 팔고 있는지, 실물 주문이 제때 발송되는지를 한 화면에서 본다.
 * 배송지 원문은 여기서 보여주지 않는다 — 발송에 필요한 곳(사회복지기관 콘솔)에서만 복호화한다.
 * 통합 관리자가 원문을 봐야 하는 경우는 분쟁 처리라, 결제 상세에서 건별로 확인한다.
 */


/** 이 시간을 넘도록 발송되지 않은 주문은 지연으로 본다. */
const DELAY_HOURS = 72;

export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ merchantId?: string; kind?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  await requireAdmin();

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const merchantId = (sp.merchantId ?? '').trim() || undefined;
  const kind = sp.kind === 'DIGITAL' || sp.kind === 'PHYSICAL' ? sp.kind : undefined;

  const where: Prisma.ChargeProductWhereInput = {
    archivedAt: null,
    ...(merchantId ? { merchantId } : {}),
    ...(kind ? { kind } : {}),
  };

  // 서버 컴포넌트(async RSC)라 요청마다 한 번 실행된다. 클라이언트 렌더 순수성 규칙의 대상이 아니다.
  // eslint-disable-next-line react-hooks/purity -- RSC: 요청 시각 기준으로 지연 배송을 집계한다
  const delayCut = new Date(Date.now() - DELAY_HOURS * 3_600_000);

  // 목록 필터(사회복지기관·종류)와 요약 타일의 모집단을 맞춘다.
  // 배송 집계는 상품 종류와 무관하므로 사회복지기관만 반영한다.
  const shipmentScope: Prisma.ChargeShipmentWhereInput = {
    charge: { status: { in: PAID_STATUSES } },
    ...(merchantId ? { merchantId } : {}),
  };
  const delayedWhere: Prisma.ChargeShipmentWhereInput = {
    status: 'PREPARING',
    charge: { status: { in: PAID_STATUSES }, paidAt: { lt: delayCut } },
    ...(merchantId ? { merchantId } : {}),
  };
  const lowStockWhere: Prisma.ChargeProductWhereInput = {
    kind: 'PHYSICAL',
    archivedAt: null,
    active: true,
    stock: { not: null, lte: 5 },
    ...(merchantId ? { merchantId } : {}),
  };

  const [
    merchants,
    total,
    products,
    shipmentCounts,
    delayed,
    delayedTotal,
    lowStock,
    lowStockTotal,
  ] = await Promise.all([
    prisma.merchantProfile.findMany({
      where: { status: 'APPROVED' },
      orderBy: { displayName: 'asc' },
      take: 60,
      select: { id: true, displayName: true, code: true },
    }),
    prisma.chargeProduct.count({ where }),
    prisma.chargeProduct.findMany({
      where,
      // sortOrder 는 기본값 0 이라 동률이 많다. id 를 마지막 정렬키로 두지 않으면
      // 페이지를 넘길 때 같은 상품이 다시 나오거나 빠질 수 있다.
      orderBy: [{ merchantId: 'asc' }, { kind: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { merchant: { select: { id: true, displayName: true } } },
    }),
    prisma.chargeShipment.groupBy({
      by: ['status'],
      where: shipmentScope,
      _count: { _all: true },
    }),
    // 결제된 지 오래됐는데 아직 발송되지 않은 주문
    prisma.chargeShipment.findMany({
      where: delayedWhere,
      orderBy: { createdAt: 'asc' },
      take: 20,
      include: {
        merchant: { select: { id: true, displayName: true } },
        charge: { select: { id: true, transactionNo: true, amount: true, paidAt: true, quantity: true, product: { select: { name: true } } } },
      },
    }),
    // 목록은 상위 20건만 보여 주지만, 타일 수치는 전체를 센다.
    // (잘린 배열 길이를 건수로 쓰면 지연 300건도 "20건" 으로 보여 심각도를 과소평가한다)
    prisma.chargeShipment.count({ where: delayedWhere }),
    prisma.chargeProduct.findMany({
      where: lowStockWhere,
      orderBy: { stock: 'asc' },
      take: 20,
      include: { merchant: { select: { id: true, displayName: true } } },
    }),
    prisma.chargeProduct.count({ where: lowStockWhere }),
  ]);

  // 판매 집계는 이 페이지에 보이는 상품만 조회한다(전체를 끌어와 메모리에서 찾지 않는다).
  const soldByProduct = await prisma.charge.groupBy({
    by: ['productId'],
    where: { productId: { in: products.map((p) => p.id) }, status: { in: PAID_STATUSES } },
    _count: { _all: true },
    _sum: { amount: true },
  });

  const shipOf = (s: ShipmentStatus) => shipmentCounts.find((c) => c.status === s)?._count._all ?? 0;
  const soldOf = (id: string) => soldByProduct.find((s) => s.productId === id);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/products', params: { merchantId: merchantId ?? '', kind: kind ?? '' }, page, lastPage, total });

  return (
    <>
      <PageHeader
        title="상품 · 주문"
        description="사회복지기관이 등록한 상품과 실물 주문의 배송 진행 상황을 모니터링합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="배송 준비"
          value={formatNumber(shipOf('PREPARING'))}
          sub={delayedTotal > 0 ? `${DELAY_HOURS}시간 초과 ${formatNumber(delayedTotal)}건` : '지연 없음'}
          tone={delayedTotal > 0 ? 'danger' : shipOf('PREPARING') > 0 ? 'warning' : 'neutral'}
        />
        <StatTile label="발송 완료" value={formatNumber(shipOf('SHIPPED'))} tone="brand" />
        <StatTile label="배송 완료" value={formatNumber(shipOf('DELIVERED'))} tone="success" />
        <StatTile
          label="재고 부족 상품"
          value={formatNumber(lowStockTotal)}
          sub={lowStockTotal > 0 ? '5개 이하' : '없음'}
          tone={lowStockTotal > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <Notice tone="neutral" title="배송지 원문은 이 화면에 표시하지 않습니다">
        받는 분 이름·연락처·주소는 암호화되어 저장되며 발송이 필요한 사회복지기관 콘솔에서만 복호화됩니다. 분쟁 처리로
        원문 확인이 필요하면 해당 결제 상세에서 확인해 주세요.
      </Notice>

      {delayed.length > 0 ? (
        <section className="mt-5">
          <SectionTitle
            title="발송 지연 주문"
            description={`결제 후 ${DELAY_HOURS}시간이 지나도록 발송되지 않은 주문입니다.`}
          />
          <Table className="min-w-[900px]">
            <thead>
              <tr>
                <Th>결제일</Th>
                <Th>사회복지기관</Th>
                <Th>상품</Th>
                <Th className="text-right">결제 금액</Th>
                <Th>거래번호</Th>
              </tr>
            </thead>
            <tbody>
              {delayed.map((d) => (
                <tr key={d.id}>
                  <Td className="whitespace-nowrap tabular-nums text-danger-500">{formatKst(d.charge.paidAt, false)}</Td>
                  <Td>
                    <Link href={`/admin/merchants/${d.merchant.id}`} className="font-semibold text-brand-700">
                      {d.merchant.displayName}
                    </Link>
                  </Td>
                  <Td>
                    {d.charge.product?.name ?? '(보관된 상품)'}
                    <span className="ml-1 text-ink-400">× {d.charge.quantity}</span>
                  </Td>
                  <Td className="text-right tabular-nums">{formatWon(d.charge.amount)}</Td>
                  <Td className="font-mono text-[11.5px] text-ink-400">{d.charge.transactionNo}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}

      {lowStock.length > 0 ? (
        <section className="mt-5">
          <SectionTitle title="재고 부족 상품" description="재고가 5개 이하로 남은 실물 상품입니다." />
          <Table className="min-w-[700px]">
            <thead>
              <tr>
                <Th>사회복지기관</Th>
                <Th>상품</Th>
                <Th className="text-right">가격</Th>
                <Th className="text-right">재고</Th>
              </tr>
            </thead>
            <tbody>
              {lowStock.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <Link href={`/admin/merchants/${p.merchant.id}`} className="font-semibold text-brand-700">
                      {p.merchant.displayName}
                    </Link>
                  </Td>
                  <Td>{p.name}</Td>
                  <Td className="text-right tabular-nums">{formatWon(p.amount)}</Td>
                  <Td className={`text-right tabular-nums ${p.stock !== null && p.stock <= 0 ? 'font-bold text-danger-500' : 'text-warning-500'}`}>
                    {stockText(p) ?? '-'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}

      <section className="mt-6">
        <SectionTitle
          title="등록된 상품"
          description={`전체 ${formatNumber(total)}개 (${page}/${lastPage} 페이지)`}
        />
        <FilterBar action="/admin/products" resetHref="/admin/products">
          <AdminField label="사회복지기관" className="w-52">
            <AdminSelect name="merchantId" defaultValue={merchantId ?? ''}>
              <MerchantOptions merchants={merchants} />
            </AdminSelect>
          </AdminField>
          <AdminField label="상품 종류" className="w-40">
            <AdminSelect name="kind" defaultValue={kind ?? ''}>
              <option value="">전체</option>
              <option value="DIGITAL">비실물</option>
              <option value="PHYSICAL">실물</option>
            </AdminSelect>
          </AdminField>
        </FilterBar>

        {products.length === 0 ? (
          <EmptyState title="조건에 맞는 상품이 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1000px]">
              <thead>
                <tr>
                  <Th>사회복지기관</Th>
                  <Th>상품</Th>
                  <Th>종류</Th>
                  <Th className="text-right">가격</Th>
                  <Th className="text-right">배송비</Th>
                  <Th className="text-right">재고</Th>
                  <Th className="text-right">판매</Th>
                  <Th>상태</Th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const sold = soldOf(p.id);
                  return (
                    <tr key={p.id}>
                      <Td>
                        <Link href={`/admin/merchants/${p.merchant.id}`} className="font-semibold text-brand-700">
                          {p.merchant.displayName}
                        </Link>
                      </Td>
                      <Td>
                        {p.name}
                        {p.sku ? <span className="ml-1 font-mono text-[11px] text-ink-400">{p.sku}</span> : null}
                      </Td>
                      <Td>
                        <Badge tone={p.kind === 'PHYSICAL' ? 'neutral' : 'brand'}>{productKindLabel[p.kind]}</Badge>
                        {p.digitalType ? (
                          <span className="ml-1 text-[11.5px] text-ink-500">{digitalTypeLabel[p.digitalType]}</span>
                        ) : null}
                      </Td>
                      <Td className="text-right tabular-nums">{formatWon(p.amount)}</Td>
                      <Td className="text-right tabular-nums text-ink-500">
                        {p.kind !== 'PHYSICAL'
                          ? '-'
                          : p.freeShipping
                            ? '무료'
                            : p.shippingFee != null
                              ? formatWon(p.shippingFee)
                              : '기본정책'}
                      </Td>
                      <Td className="text-right tabular-nums">{stockText(p) ?? (p.kind === 'PHYSICAL' ? '무제한' : '-')}</Td>
                      <Td className="text-right tabular-nums">
                        {formatNumber(sold?._count._all ?? 0)}건
                        {sold?._sum.amount ? (
                          <span className="block text-[11px] text-ink-400">{formatWon(sold._sum.amount)}</span>
                        ) : null}
                      </Td>
                      <Td>{p.active ? <Badge tone="success">노출</Badge> : <Badge tone="neutral">숨김</Badge>}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/products"
              params={{ merchantId: merchantId ?? '', kind: kind ?? '' }}
              page={page}
              lastPage={lastPage}
              total={total}
            />
          </>
        )}
      </section>
    </>
  );
}
