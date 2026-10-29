import Link from 'next/link';
import { Download, Search } from 'lucide-react';
import {
  Badge, Button, Card, EmptyState, Field, Input, LinkButton, Notice, SectionTitle, Select, StatTile, Textarea, cx,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { AddressReveal } from '@/components/studio/address-reveal';
import { BulkShipPanel } from '@/components/studio/bulk-ship-panel';
import { PointBulkPanel } from '@/components/studio/point-bulk-panel';
import { requestChargeRefundAction, updateShipmentAction } from '@/app/actions/studio';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { scrubText } from '@/lib/logger';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import {
  DELIVERY_SHIPMENT_STATUSES, RETURN_SHIPMENT_STATUSES, pointStatusLabel, shipmentStatusLabel,
} from '@/lib/labels';
import {
  ORDER_CHARGE_STATUSES,
  ORDER_PERIODS,
  PAID_STATUSES,
  buildQuery,
  normalizePeriod,
  one,
  periodStart,
  type SearchParamsRecord,
} from '@/components/studio/shared';
import { digitalTypeLabel, fulfillmentLabel, shippingPolicyOf } from '@/server/services/products';
import type { Prisma } from '@/generated/prisma/client';
import type { ShipmentStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

/**
 * 주문 · 판매.
 *
 * 실물은 배송지·송장을 다루고, 비실물(컨텐츠)은 지급 처리를 다룬다.
 * 두 가지가 완전히 다른 업무라 탭으로 나눈다. 반품·교환은 배송 목록에 섞으면
 * "오늘 보낼 것" 을 찾기 어려워지므로 따로 뗀다.
 *
 * 배송지 원문은 목록에서 자동으로 풀지 않는다. [주소 보기] 를 눌러야 열리고 열람 기록이 남는다.
 */

/**
 * 비실물 지급 대상 조건.
 *
 * 상품이 없는 직접 입력 결제(productId = null)도 지급 대상이다.
 * 실물 주문만 금액 확정 시점에 pointStatus = SKIPPED 로 빠진다(charge-select.ts).
 */
const DIGITAL_PAYABLE = {
  OR: [{ product: { kind: 'DIGITAL' as const } }, { productId: null }],
};

const PAGE_SIZE = 20;
/** 주문서 CSV 라우트의 상한과 같아야 한다. */
const CSV_MAX_ROWS = 3000;

const TABS = [
  { key: 'delivery', label: '실물 주문·배송' },
  { key: 'digital', label: '비실물(컨텐츠) 판매' },
  { key: 'return', label: '반품·교환' },
] as const;

type Tab = (typeof TABS)[number]['key'];

const PERIODS = [
  { value: '30d', label: '최근 30일' },
  { value: '7d', label: '최근 7일' },
  { value: '90d', label: '최근 90일' },
  { value: 'all', label: '전체' },
] as const;

const SORTS = [
  { value: 'oldest', label: '오래된 주문 먼저' },
  { value: 'newest', label: '최근 주문 먼저' },
] as const;

/** 결제 후 이 일수를 넘겨 발송되지 않으면 지연으로 본다. */
const DELAY_DAYS = 2;

/**
 * 발송 지연 판정 기준 시각.
 *
 * 렌더 본문에서 Date.now() 를 직접 부르면 렌더가 순수하지 않다(react-hooks/purity).
 * 값이 필요한 곳에서 이 함수를 호출한다.
 */
function delayCutoff(): Date {
  return new Date(Date.now() - DELAY_DAYS * 86_400_000);
}

export default async function StudioOrdersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;

  const tab: Tab = TABS.some((t) => t.key === one(sp.tab)) ? (one(sp.tab) as Tab) : 'delivery';
  const period = normalizePeriod(one(sp.period) || '30d', ORDER_PERIODS, '30d');
  const sort = one(sp.sort) === 'newest' ? 'newest' : 'oldest';
  const q = one(sp.q).trim();
  const page = Math.max(1, Number.parseInt(one(sp.page) || '1', 10) || 1);
  const statusParam = one(sp.status);

  const gte = periodStart(period);
  const base = { tab, period, sort, q, status: statusParam };

  const [byStatus, pointCounts, shippingRow] = await Promise.all([
    prisma.chargeShipment.groupBy({
      by: ['status'],
      where: { merchantId, charge: { status: { in: PAID_STATUSES } } },
      _count: { _all: true },
    }),
    prisma.charge.groupBy({
      by: ['pointStatus'],
      // 직접 입력 결제(productId = null)도 지급 대상이다.
      // 여기서 빼면 후원 내역의 "지급 대기 N건" 안내를 따라와도 처리할 건이 보이지 않는다.
      where: { merchantId, status: { in: PAID_STATUSES }, ...DIGITAL_PAYABLE },
      _count: { _all: true },
    }),
    prisma.merchantShippingPolicy.findUnique({ where: { merchantId } }),
  ]);
  const shipping = shippingPolicyOf(shippingRow);
  const countOf = (s: ShipmentStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  const pointOf = (s: 'PENDING' | 'SENT' | 'FAILED') =>
    pointCounts.find((b) => b.pointStatus === s)?._count._all ?? 0;
  const returnTotal = RETURN_SHIPMENT_STATUSES.reduce((sum, s) => sum + countOf(s), 0);

  return (
    <>
      <PageHeader
        title="주문 · 판매"
        description="실물 주문의 배송과 비실물(컨텐츠) 상품의 지급을 한 곳에서 처리합니다."
      />

      <nav
        aria-label="주문 판매 메뉴"
        className="mb-4 grid grid-cols-3 overflow-hidden rounded-2xl border border-ink-100 bg-white p-1 shadow-[0_8px_24px_rgba(23,22,26,0.05)]"
      >
        {TABS.map((t) => {
          const badge =
            t.key === 'delivery'
              ? countOf('PREPARING')
              : t.key === 'digital'
                ? pointOf('PENDING')
                : returnTotal;
          return (
            <Link
              key={t.key}
              href={`/studio/orders?tab=${t.key}`}
              aria-current={tab === t.key ? 'page' : undefined}
              className={cx(
                'flex min-h-11 items-center justify-center gap-1 rounded-xl px-1 text-center text-[12px] font-bold transition-colors sm:px-3 sm:text-[13px]',
                tab === t.key ? 'bg-brand-400 text-ink-900 shadow-sm' : 'text-ink-400 hover:bg-ink-50 hover:text-ink-800',
              )}
            >
              {t.label}
              {badge > 0 ? (
                <span className="rounded-full bg-danger-500 px-1.5 py-0.5 text-[10px] font-black text-white">
                  {badge > 99 ? '99+' : badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      {tab === 'digital' ? (
        <DigitalSales merchantId={merchantId} pending={pointOf('PENDING')} sent={pointOf('SENT')} held={pointOf('FAILED')} />
      ) : (
        <ShipmentList
          merchantId={merchantId}
          tab={tab}
          base={base}
          page={page}
          gte={gte}
          q={q}
          sort={sort}
          statusParam={statusParam}
          countOf={countOf}
          defaultCarrier={shipping.carrier ?? ''}
          returnAddress={shipping.returnAddress}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 실물 주문·배송 / 반품·교환
// ---------------------------------------------------------------------------

async function ShipmentList({
  merchantId,
  tab,
  base,
  page,
  gte,
  q,
  sort,
  statusParam,
  countOf,
  defaultCarrier,
  returnAddress,
}: {
  merchantId: string;
  tab: 'delivery' | 'return';
  base: Record<string, string>;
  page: number;
  gte: Date | null;
  q: string;
  sort: 'oldest' | 'newest';
  statusParam: string;
  countOf: (s: ShipmentStatus) => number;
  defaultCarrier: string;
  returnAddress: string | null;
}) {
  const scope = tab === 'delivery' ? DELIVERY_SHIPMENT_STATUSES : RETURN_SHIPMENT_STATUSES;
  const status = scope.includes(statusParam as ShipmentStatus) ? (statusParam as ShipmentStatus) : undefined;

  const where: Prisma.ChargeShipmentWhereInput = {
    merchantId,
    status: status ? status : { in: scope },
    // 결제가 완료된 주문만 처리 대상이다. 결제 전 단계는 아직 주문이 아니다.
    // 환불 요청·완료 건도 회수·반품 업무가 남으므로 목록에는 남긴다(행에 환불 배지가 붙는다).
    charge: {
      status: { in: ORDER_CHARGE_STATUSES },
      ...(gte ? { paidAt: { gte } } : {}),
      ...(q
        ? {
            OR: [
              { transactionNo: { contains: q, mode: 'insensitive' as const } },
              { product: { name: { contains: q, mode: 'insensitive' as const } } },
              { product: { sku: { contains: q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    },
    ...(q ? {} : {}),
  };
  // 송장번호·받는분 마스킹으로도 찾을 수 있게 한다(원문은 암호화라 검색할 수 없다).
  if (q) {
    where.OR = [
      { trackingNo: { contains: q, mode: 'insensitive' } },
      { receiverMasked: { contains: q } },
      { phoneMasked: { contains: q } },
      { charge: { transactionNo: { contains: q, mode: 'insensitive' } } },
      { charge: { product: { name: { contains: q, mode: 'insensitive' } } } },
      { charge: { product: { sku: { contains: q, mode: 'insensitive' } } } },
    ];
    delete (where.charge as Prisma.ChargeWhereInput).OR;
  }

  const [total, rows, delayed] = await Promise.all([
    prisma.chargeShipment.count({ where }),
    prisma.chargeShipment.findMany({
      where,
      orderBy: sort === 'newest' ? [{ createdAt: 'desc' }] : [{ status: 'asc' }, { createdAt: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        charge: {
          select: {
            id: true, transactionNo: true, amount: true, shippingFee: true, quantity: true,
            optionText: true, paidAt: true, status: true, displayName: true,
            refunds: { orderBy: { requestedAt: 'desc' }, take: 1, select: { status: true } },
            product: { select: { name: true, sku: true, imageUrl: true } },
          },
        },
      },
    }),
    // 결제 후 오래 발송되지 않은 건. 사회복지기관이 먼저 알아야 민원이 되지 않는다.
    prisma.chargeShipment.count({
      where: {
        merchantId,
        status: 'PREPARING',
        charge: { status: { in: PAID_STATUSES }, paidAt: { lt: delayCutoff() } },
      },
    }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const exportHref = `/api/studio/orders/export${buildQuery(base, { page: undefined })}`;
  const cutoff = delayCutoff().getTime();

  return (
    <>
      {tab === 'delivery' ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <StatTile
              label="배송 준비"
              value={formatNumber(countOf('PREPARING'))}
              sub={countOf('PREPARING') > 0 ? '송장 등록 필요' : '없음'}
              tone={countOf('PREPARING') > 0 ? 'warning' : 'neutral'}
            />
            <StatTile
              label={`발송 지연 (${DELAY_DAYS}일 초과)`}
              value={formatNumber(delayed)}
              sub={delayed > 0 ? '먼저 처리해 주세요' : '없음'}
              tone={delayed > 0 ? 'danger' : 'neutral'}
            />
            <StatTile label="발송 완료" value={formatNumber(countOf('SHIPPED'))} tone="brand" />
            <StatTile label="배송 완료" value={formatNumber(countOf('DELIVERED'))} tone="success" />
          </div>

          <div className="mb-4">
            <BulkShipPanel pendingCount={countOf('PREPARING')} defaultCarrier={defaultCarrier} />
          </div>
        </>
      ) : (
        <div className="mb-4">
          {returnAddress ? (
            <Notice tone="neutral" title="반품지">
              {returnAddress}
            </Notice>
          ) : (
            <Notice tone="warning" title="반품지가 등록되어 있지 않습니다">
              후원자가 어디로 보낼지 알 수 없습니다.{' '}
              <Link href="/studio/settings?tab=shipping" className="font-bold text-brand-700">
                후원 설정 &gt; 배송 정책
              </Link>{' '}
              에서 등록해 주세요.
            </Notice>
          )}
        </div>
      )}

      {/* ── 검색 ─────────────────────────────────────────────── */}
      <Card className="mb-4">
        <form method="get" className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_2fr_auto] md:items-end">
          <input type="hidden" name="tab" value={tab} />
          <Field label="기간">
            <Select name="period" defaultValue={base.period}>
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="상태">
            <Select name="status" defaultValue={statusParam}>
              <option value="">전체 상태</option>
              {scope.map((s) => (
                <option key={s} value={s}>
                  {shipmentStatusLabel[s].text}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="정렬">
            <Select name="sort" defaultValue={base.sort}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="검색" hint="거래번호 · 상품명 · SKU · 송장번호 · 받는 분(가려진 이름)">
            <Input name="q" defaultValue={q} placeholder="TRD-2026... / 티셔츠 / 홍*동" />
          </Field>
          <Button type="submit" variant="secondary">
            <Search size={15} strokeWidth={1.9} />
            검색
          </Button>
        </form>
      </Card>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SectionTitle
          title={tab === 'delivery' ? '주문 목록' : '반품·교환 목록'}
          description={`${formatNumber(total)}건 (${page}/${lastPage} 페이지)`}
        />
        {total > CSV_MAX_ROWS ? (
          <p className="mb-2 text-[12px] font-semibold text-danger-500">
            주문서 CSV 는 최대 {formatNumber(CSV_MAX_ROWS)}건까지 담깁니다. 기간을 좁혀 나눠 받아 주세요.
          </p>
        ) : null}
        <LinkButton href={exportHref} variant="secondary" size="sm" prefetch={false}>
          <Download size={14} strokeWidth={1.9} />
          주문서 엑셀
        </LinkButton>
      </div>

      <Notice tone="warning" title="배송지는 배송 목적으로만 사용해 주세요">
        받는 분 이름·연락처·주소는 암호화되어 저장되며 기본은 가려져 있습니다. [주소 보기] 를 누르면 원문이 열리고
        열람 기록이 남습니다. 배송 외의 목적으로 이용하거나 제3자에게 제공하면 개인정보보호법 위반입니다.
      </Notice>

      {rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title={q ? '검색 결과가 없습니다' : tab === 'delivery' ? '주문이 없습니다' : '반품·교환 건이 없습니다'}
            description={
              q
                ? '검색어나 기간을 바꿔 보세요.'
                : tab === 'delivery'
                  ? '실물 상품이 결제되면 여기에 배송지와 함께 표시됩니다.'
                  : '주문 카드에서 상태를 반품 접수로 바꾸면 이 목록으로 옮겨집니다.'
            }
          />
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((s) => {
            const st = shipmentStatusLabel[s.status];
            const goods = s.charge.amount - s.charge.shippingFee;
            const refund = s.charge.refunds[0]?.status;
            const late =
              s.status === 'PREPARING' &&
              s.charge.paidAt !== null &&
              s.charge.paidAt.getTime() < cutoff;
            return (
              <li key={s.id}>
                <Card>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge tone={st.tone}>{st.text}</Badge>
                    <Link
                      href={`/studio/charges/${s.charge.id}`}
                      className="font-mono text-[12px] font-semibold text-brand-700 hover:underline"
                    >
                      {s.charge.transactionNo}
                    </Link>
                    <span className="text-[12px] text-ink-400">{formatKst(s.charge.paidAt, false)}</span>
                    {late ? <Badge tone="danger">발송 지연</Badge> : null}
                    {s.charge.status === 'REFUNDED' ? <Badge tone="danger">환불됨</Badge> : null}
                    {refund === 'REQUESTED' ? <Badge tone="warning">환불 요청됨</Badge> : null}
                    {s.remote ? <Badge tone="warning">도서산간</Badge> : null}
                  </div>

                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="rounded-xl bg-ink-50/70 px-3.5 py-2.5">
                      <div className="flex items-start gap-2.5">
                        {s.charge.product?.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={s.charge.product.imageUrl}
                            alt=""
                            className="h-12 w-12 shrink-0 rounded-lg object-cover"
                          />
                        ) : null}
                        <div className="min-w-0">
                          <p className="text-[13px] font-bold text-ink-900">
                            {s.charge.product?.name ?? '(보관된 상품)'}
                            <span className="ml-1 text-ink-500">× {s.charge.quantity}</span>
                          </p>
                          {s.charge.optionText ? (
                            <p className="mt-0.5 text-[12px] text-ink-600">{s.charge.optionText}</p>
                          ) : null}
                          {s.charge.product?.sku ? (
                            <p className="mt-0.5 font-mono text-[11px] text-ink-400">{s.charge.product.sku}</p>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-2 space-y-0.5 text-[12px]">
                        <div className="flex justify-between">
                          <span className="text-ink-500">상품 금액</span>
                          <span className="tabular-nums text-ink-800">{formatWon(goods)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-ink-500">배송비</span>
                          <span className="tabular-nums text-ink-800">
                            {s.charge.shippingFee === 0n ? '무료' : formatWon(s.charge.shippingFee)}
                          </span>
                        </div>
                        <div className="flex justify-between border-t border-ink-200 pt-1 font-bold">
                          <span className="text-ink-700">결제 금액</span>
                          <span className="tabular-nums text-ink-900">{formatWon(s.charge.amount)}</span>
                        </div>
                      </div>
                    </div>

                    <AddressReveal
                      chargeId={s.charge.id}
                      receiverMasked={s.receiverMasked}
                      phoneMasked={s.phoneMasked}
                      addressMasked={s.addressMasked}
                      zipCode={s.zipCode}
                    />
                  </div>

                  {s.memo ? (
                    <p className="mt-2 rounded-lg bg-warning-50 px-2.5 py-1.5 text-[11.5px] text-ink-700">
                      {/*
                        배송 요청 메모는 후원자가 자유롭게 쓰는 칸이라 "부재 시 010-1234-5678 로
                        연락 주세요" 처럼 연락처가 자주 들어온다. 배송지 원문은 열람 기록을 남기고
                        보여 주는데(revealShipmentAddressAction) 메모만 목록에서 그대로 보이면
                        같은 개인정보가 기록 없이 노출된다. 번호는 가려서 보여 준다.
                      */}
                      후원자 요청: {scrubText(s.memo)}
                    </p>
                  ) : null}
                  {s.merchantMemo ? (
                    <p className="mt-2 rounded-lg bg-ink-50 px-2.5 py-1.5 text-[11.5px] text-ink-600">
                      내부 메모: {s.merchantMemo}
                    </p>
                  ) : null}

                  <div className="mt-3 border-t border-ink-100 pt-3">
                    <ActionForm action={updateShipmentAction} submitLabel="배송 정보 저장" variant="secondary" size="sm">
                      <input type="hidden" name="chargeId" value={s.charge.id} />
                      <div className="grid gap-2.5 sm:grid-cols-3">
                        <Field label="상태">
                          <Select name="status" defaultValue={s.status}>
                            <optgroup label="배송">
                              {DELIVERY_SHIPMENT_STATUSES.map((v) => (
                                <option key={v} value={v}>
                                  {shipmentStatusLabel[v].text}
                                </option>
                              ))}
                            </optgroup>
                            <optgroup label="반품·교환">
                              {RETURN_SHIPMENT_STATUSES.map((v) => (
                                <option key={v} value={v}>
                                  {shipmentStatusLabel[v].text}
                                </option>
                              ))}
                            </optgroup>
                          </Select>
                        </Field>
                        <Field label="택배사">
                          <Input name="carrier" defaultValue={s.carrier ?? defaultCarrier} maxLength={30} placeholder="CJ대한통운" />
                        </Field>
                        <Field label="송장번호">
                          <Input
                            name="trackingNo"
                            defaultValue={s.trackingNo ?? ''}
                            maxLength={40}
                            placeholder="123456789012"
                            className="tabular-nums"
                          />
                        </Field>
                      </div>
                      <div className="grid gap-2.5 sm:grid-cols-2">
                        <Field label="반품·교환 사유" hint="반품·교환 상태로 바꿀 때 필수입니다.">
                          <Input name="returnReason" defaultValue={s.returnReason ?? ''} maxLength={200} placeholder="사이즈 교환 요청" />
                        </Field>
                        <Field label="회수 송장번호" hint="반품 회수용">
                          <Input
                            name="returnTrackingNo"
                            defaultValue={s.returnTrackingNo ?? ''}
                            maxLength={40}
                            className="tabular-nums"
                          />
                        </Field>
                      </div>
                      <Field
                        label="내부 메모 (선택)"
                        hint="100자 이내. 후원자에게는 보이지 않습니다. 후원자가 남긴 배송 요청은 위에 그대로 보존됩니다."
                      >
                        <Textarea
                          name="merchantMemo"
                          rows={1}
                          maxLength={100}
                          defaultValue={s.merchantMemo ?? ''}
                        />
                      </Field>
                      <label className="flex items-center gap-2 text-[12px] font-semibold text-ink-600">
                        <input type="checkbox" name="skipNotify" className="h-4 w-4" />
                        발송 안내 문자 보내지 않기
                      </label>
                    </ActionForm>

                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[11.5px] text-ink-400">
                        {s.shippedAt ? `발송 ${formatKst(s.shippedAt, false)}` : '미발송'}
                        {s.deliveredAt ? ` · 배송 완료 ${formatKst(s.deliveredAt, false)}` : ''}
                        {s.returnRequestedAt ? ` · 반품·교환 접수 ${formatKst(s.returnRequestedAt, false)}` : ''}
                      </p>

                      {s.charge.status !== 'REFUNDED' &&
                      !(refund === 'REQUESTED' || refund === 'APPROVED' || refund === 'DONE') ? (
                        <details className="w-full sm:w-auto">
                          <summary className="cursor-pointer list-none rounded-lg border border-ink-200 px-2.5 py-1.5 text-[12px] font-bold text-ink-600 hover:bg-ink-50">
                            환불 요청
                          </summary>
                          <div className="mt-2 rounded-xl border border-ink-100 p-3">
                            <ActionForm
                              action={requestChargeRefundAction}
                              submitLabel="환불 요청 보내기"
                              variant="danger"
                              size="sm"
                              confirmMessage="통합 관리자 승인 후 실제 환불이 처리됩니다. 요청하시겠습니까?"
                            >
                              <input type="hidden" name="chargeId" value={s.charge.id} />
                              <Field label="사유" hint="품절·배송불가·후원자 요청 등. 5자 이상." required>
                                <Input name="reason" maxLength={200} placeholder="재고 소진으로 배송 불가" />
                              </Field>
                            </ActionForm>
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {lastPage > 1 ? (
        <nav className="mt-4 flex items-center justify-between gap-3">
          {page > 1 ? (
            <Link
              href={`/studio/orders${buildQuery(base, { page: page - 1 })}`}
              className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12.5px] font-bold text-ink-700 hover:bg-ink-50"
            >
              이전
            </Link>
          ) : (
            <span />
          )}
          <span className="text-[12.5px] font-semibold tabular-nums text-ink-500">
            {page} / {lastPage}
          </span>
          {page < lastPage ? (
            <Link
              href={`/studio/orders${buildQuery(base, { page: page + 1 })}`}
              className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12.5px] font-bold text-ink-700 hover:bg-ink-50"
            >
              다음
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 비실물(컨텐츠) 판매
// ---------------------------------------------------------------------------

/** 일괄 처리 패널에 한 번에 올리는 최대 건수 */
const BULK_PANEL_SIZE = 100;

async function DigitalSales({
  merchantId,
  pending,
  sent,
  held,
}: {
  merchantId: string;
  pending: number;
  sent: number;
  held: number;
}) {
  const [pendingRows, recent] = await Promise.all([
    prisma.charge.findMany({
      where: {
        merchantId,
        status: { in: PAID_STATUSES },
        pointStatus: 'PENDING',
        ...DIGITAL_PAYABLE,
      },
      orderBy: { paidAt: 'asc' },
      take: BULK_PANEL_SIZE,
      select: {
        id: true, transactionNo: true, receivedAt: true, amount: true, displayName: true,
        payer: { select: { phoneMasked: true } },
      },
    }),
    prisma.charge.findMany({
      where: { merchantId, status: { in: PAID_STATUSES }, ...DIGITAL_PAYABLE },
      orderBy: { paidAt: 'desc' },
      take: 30,
      select: {
        id: true, transactionNo: true, amount: true, paidAt: true, pointStatus: true,
        pointGivenAt: true, pointNote: true, displayName: true,
        payer: { select: { phoneMasked: true } },
        product: { select: { name: true, digitalType: true, fulfillment: true } },
      },
    }),
  ]);

  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-2.5">
        <StatTile
          label="지급 대기"
          value={formatNumber(pending)}
          sub={pending > 0 ? '처리 필요' : '없음'}
          tone={pending > 0 ? 'warning' : 'neutral'}
        />
        <StatTile label="지급 완료" value={formatNumber(sent)} tone="success" />
        <StatTile label="지급 보류" value={formatNumber(held)} tone={held > 0 ? 'danger' : 'neutral'} />
      </div>

      <Notice tone="neutral" title="실물 주문은 여기에 오지 않습니다">
        배송으로 끝나는 실물 주문은 지급 대상이 아니므로 이 목록과 연동 API 의 지급 대기 응답에서 제외됩니다.
        상품마다 지급 방식(수동 / 연동 API / 결제 즉시 문자 발급)은 후원 항목 관리에서 정합니다.
      </Notice>

      <div className="mt-4">
        <PointBulkPanel
          total={pending}
          rows={pendingRows.map((r) => ({
            id: r.id,
            transactionNo: r.transactionNo,
            receivedAt: formatKst(r.receivedAt, false),
            amount: r.amount.toString(),
            displayName: r.displayName,
            phoneMasked: r.payer?.phoneMasked ?? null,
          }))}
        />
      </div>

      <div className="mt-5">
        <SectionTitle title="최근 판매" description="비실물(컨텐츠) 상품의 최근 결제 30건입니다." />
      </div>

      {recent.length === 0 ? (
        <EmptyState
          title="판매 내역이 없습니다"
          description="비실물 상품이 결제되면 여기에 지급 상태와 함께 표시됩니다."
        />
      ) : (
        <ul className="space-y-2">
          {recent.map((c) => {
            const st = pointStatusLabel[c.pointStatus];
            return (
              <li key={c.id}>
                <Card>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={st.tone}>{st.text}</Badge>
                    <Link
                      href={`/studio/charges/${c.id}`}
                      className="font-mono text-[12px] font-semibold text-brand-700 hover:underline"
                    >
                      {c.transactionNo}
                    </Link>
                    <span className="text-[12px] text-ink-400">{formatKst(c.paidAt, false)}</span>
                    <span className="ml-auto text-[13px] font-bold tabular-nums text-ink-900">
                      {formatWon(c.amount)}
                    </span>
                  </div>
                  <p className="mt-1 text-[12.5px] text-ink-600">
                    {c.product?.name ?? '(보관된 상품)'}
                    {c.product?.digitalType ? (
                      <span className="ml-1.5 text-ink-400">{digitalTypeLabel[c.product.digitalType]}</span>
                    ) : null}
                    {c.product ? (
                      <span className="ml-1.5 text-ink-400">· {fulfillmentLabel[c.product.fulfillment].text}</span>
                    ) : null}
                    <span className="ml-1.5 text-ink-400">· {c.payer?.phoneMasked ?? '-'}</span>
                  </p>
                  {c.pointGivenAt || c.pointNote ? (
                    <p className="mt-0.5 text-[11.5px] text-ink-400">
                      {c.pointGivenAt ? `지급 ${formatKst(c.pointGivenAt, false)}` : ''}
                      {c.pointNote ? ` · ${c.pointNote}` : ''}
                    </p>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
