import Link from 'next/link';
import { LayoutGrid, Rows3, Search } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Select, Table, Td, Th, cx } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import {
  CHARGE_PERIODS,
  buildQuery,
  normalizePeriod,
  one,
  periodStart,
  type SearchParamsRecord,
} from '@/components/studio/shared';
import { ChargeCardGrid } from '@/components/studio/charge-cards';
import { ActionForm } from '@/components/studio/action-form';
import { undoPointsGivenAction } from '@/app/actions/studio';
import { PAID_STATUSES } from '@/components/studio/shared';
import { productKindShort } from '@/server/services/products';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatNumber, formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import {
  deliveryStatusLabel, chargeStatusLabel, pointStatusLabel, refundStatusLabel, SELECTABLE_CHARGE_STATUSES,
} from '@/lib/labels';
import type { ChargeStatus, Prisma } from '@/generated/prisma/client';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;
/** CSV 라우트(api/studio/charges/export)의 상한과 같아야 한다. */
const CSV_MAX_ROWS = 5000;

const PERIODS = [
  { value: 'today', label: '오늘' },
  { value: '7d', label: '최근 7일' },
  { value: '30d', label: '최근 30일' },
  { value: 'all', label: '전체' },
] as const;

// 코드가 한 번도 기록하지 않는 상태(구 방송 송출 잔재 등)는 필터에서 뺀다.
const STATUS_VALUES = SELECTABLE_CHARGE_STATUSES;

/** 후원금 지급 처리 상태 필터 */
const POINT_FILTERS = [
  { value: '', label: '전체' },
  { value: 'pending', label: '지급 대기' },
  { value: 'given', label: '지급 완료' },
  { value: 'held', label: '보류' },
] as const;

/**
 * 보기 방식. 기본은 카드다.
 * 표는 컬럼이 12개라 모바일에서 가로 스크롤 없이는 읽을 수 없으므로,
 * 한 건씩 세로로 읽히는 카드를 기본으로 두고 표는 선택할 수 있게 남긴다.
 */
const VIEWS = [
  { value: 'card', label: '카드', icon: LayoutGrid },
  { value: 'table', label: '표', icon: Rows3 },
] as const;

type ViewMode = (typeof VIEWS)[number]['value'];

export default async function StudioChargesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;

  const period = normalizePeriod(one(sp.period) || '30d', CHARGE_PERIODS, '30d');
  const status = one(sp.status);
  const q = one(sp.q).trim();
  const point = one(sp.point);
  // Number('1.5') 는 1.5 다. 그대로 skip 에 넣으면 Prisma 가 정수를 요구하며 500 이 난다.
  // 소수·문자·음수 모두 1페이지로 본다.
  const pageRaw = Number(one(sp.page));
  const page = Number.isSafeInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const rawView = one(sp.view);
  const view: ViewMode = VIEWS.some((v) => v.value === rawView) ? (rawView as ViewMode) : 'card';

  const where: Prisma.ChargeWhereInput = { merchantId };
  const gte = periodStart(period);
  if (gte) where.receivedAt = { gte };
  if (status && (STATUS_VALUES as string[]).includes(status)) where.status = status as ChargeStatus;
  if (q) where.transactionNo = { contains: q, mode: 'insensitive' };
  if (point === 'pending') where.pointStatus = 'PENDING';
  if (point === 'given') where.pointStatus = 'SENT';
  if (point === 'held') where.pointStatus = 'FAILED';

  // 지급 대기 건은 필터와 무관하게 항상 위에 모아 보여 준다(빠뜨리지 않게).
  const pendingWhere: Prisma.ChargeWhereInput = {
    merchantId,
    status: { in: PAID_STATUSES },
    pointStatus: 'PENDING',
  };

  const [total, rows, pendingTotal] = await Promise.all([
    prisma.charge.count({ where }),
    prisma.charge.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        transactionNo: true,
        receivedAt: true,
        displayName: true,
        anonymous: true,
        message: true,
        channel: true,
        amount: true,
        status: true,
        mtStatus: true,
        pointStatus: true,
        quantity: true,
        payer: { select: { phoneMasked: true } },
        product: { select: { name: true, kind: true } },
        refunds: { orderBy: { requestedAt: 'desc' }, take: 1, select: { status: true } },
      },
    }),
    prisma.charge.count({ where: pendingWhere }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 보기 방식은 페이지를 넘겨도 유지된다.
  const base = { period, status, q, view, point };

  return (
    <>
      <PageHeader
        title="후원 내역"
        description={`조건에 해당하는 결제 ${formatNumber(total)}건 (${page}/${totalPages} 페이지)`}
      />

      <div className="space-y-4">
        {/* 지급 처리는 후원 처리 > 비실물(컨텐츠) 판매로 옮겼다.
            후원 내역은 "돈이 어떻게 됐나" 를 보는 화면이고, 지급은 "무엇을 줘야 하나" 라
            섞어 두면 실물 주문까지 지급 목록에 끼어든다. */}
        {pendingTotal > 0 ? (
          <Notice tone="warning" title={`지급 대기 ${formatNumber(pendingTotal)}건`}>
            비실물(컨텐츠) 상품의 지급 처리는{' '}
            <Link href="/studio/orders?tab=digital" className="font-bold text-brand-700">
              주문 · 판매 &gt; 비실물(컨텐츠) 판매
            </Link>{' '}
            에서 합니다.
          </Notice>
        ) : null}

        <Card>
          <form method="get" className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_2fr_auto] md:items-end">
            <Field label="기간">
              <Select name="period" defaultValue={period}>
                {PERIODS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="상태">
              <Select name="status" defaultValue={status}>
                <option value="">전체 상태</option>
                {STATUS_VALUES.map((s) => (
                  <option key={s} value={s}>
                    {chargeStatusLabel[s].text}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="후원금 지급">
              <Select name="point" defaultValue={point}>
                {POINT_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="거래번호 검색">
              <Input name="q" defaultValue={q} placeholder="TRD-20260819-XXXXXXXX" />
            </Field>
            <Button type="submit" variant="secondary">
              <Search size={16} strokeWidth={1.7} />
              조회
            </Button>
            {/* 조회해도 보기 방식이 초기화되지 않게 함께 넘긴다 */}
            <input type="hidden" name="view" value={view} />
          </form>
        </Card>

        {/* 보기 전환 */}
        <div className="flex items-center justify-between gap-3">
          <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-400">
            결제 {formatNumber(total)}건 중 {formatNumber(rows.length)}건 표시
            <Link
              href={`/api/studio/charges/export${buildQuery(base, {})}`}
              prefetch={false}
              className="font-bold text-brand-700 underline underline-offset-2"
            >
              CSV 내려받기
            </Link>
            {/* 라우트가 5,000건에서 자르는데 파일에는 아무 표시가 없어, 전량으로 믿고 반영하면 누락된다. */}
            {total > CSV_MAX_ROWS ? (
              <span className="font-semibold text-danger-500">
                CSV 는 최대 {formatNumber(CSV_MAX_ROWS)}건까지 담깁니다. 기간을 좁혀 나눠 받아 주세요.
              </span>
            ) : null}
          </p>
          <nav
            aria-label="보기 방식"
            className="flex shrink-0 items-center gap-1 rounded-xl border border-ink-100 bg-white p-1"
          >
            {VIEWS.map((v) => {
              const Icon = v.icon;
              const active = view === v.value;
              return (
                <Link
                  key={v.value}
                  href={`/studio/charges${buildQuery(base, { view: v.value, page })}`}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-bold transition-colors',
                    active ? 'bg-brand-400 text-ink-900 shadow-sm' : 'text-ink-400 hover:bg-ink-50 hover:text-ink-800',
                  )}
                >
                  <Icon size={15} strokeWidth={1.7} />
                  {v.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {rows.length === 0 ? (
          <EmptyState title="조건에 맞는 후원 내역이 없습니다" description="기간이나 상태 조건을 바꿔서 다시 조회해 보세요." />
        ) : view === 'card' ? (
          <ChargeCardGrid
            items={rows.map((d) => ({
              id: d.id,
              transactionNo: d.transactionNo,
              receivedAt: d.receivedAt,
              displayName: d.displayName,
              anonymous: d.anonymous,
              message: d.message,
              amount: d.amount,
              status: d.status,
              channel: d.channel,
              // 마스킹된 값만 내려온다. 원문 전화번호는 사회복지기관에 제공하지 않는다.
              phoneMasked: d.payer?.phoneMasked ?? null,
              delivery: { mt: d.mtStatus, point: d.pointStatus },
              refundStatus: d.refunds[0]?.status ?? null,
            }))}
          />
        ) : (
          <Table className="min-w-full">
            <thead>
              <tr>
                <Th>거래번호</Th>
                <Th>수신시각</Th>
                <Th>후원자</Th>
                <Th>표시명</Th>
                <Th>접수</Th>
                <Th>상품</Th>
                <Th>내용</Th>
                <Th className="text-right">결제 금액</Th>
                <Th>결제 상태</Th>
                <Th>MT 안내</Th>
                <Th>지급 처리</Th>
                <Th>환불</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const st = chargeStatusLabel[d.status];
                const mt = deliveryStatusLabel[d.mtStatus];
                const rf = pointStatusLabel[d.pointStatus];
                const refund = d.refunds[0] ? refundStatusLabel[d.refunds[0].status] : null;
                return (
                  <tr key={d.id} className="hover:bg-ink-50">
                    <Td>
                      <Link
                        href={`/studio/charges/${d.id}`}
                        className="font-mono text-[12px] font-semibold text-brand-700 underline-offset-2 hover:underline"
                      >
                        {d.transactionNo}
                      </Link>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(d.receivedAt, false)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{d.payer?.phoneMasked ?? '-'}</Td>
                    <Td className="whitespace-nowrap">{d.anonymous ? '익명의 후원자' : d.displayName}</Td>
                    <Td>
                      <Badge tone={d.channel === 'WEB' ? 'brand' : 'neutral'}>
                        {d.channel === 'WEB' ? '웹(PC)' : '문자(MO)'}
                      </Badge>
                    </Td>
                    <Td className="max-w-[180px]">
                      {d.product ? (
                        <span className="block truncate">
                          <Badge tone={d.product.kind === 'PHYSICAL' ? 'neutral' : 'brand'}>
                            {productKindShort[d.product.kind]}
                          </Badge>
                          <span className="ml-1.5 align-middle">{d.product.name}</span>
                          {d.quantity > 1 ? <span className="ml-1 text-ink-400">× {d.quantity}</span> : null}
                        </span>
                      ) : (
                        <span className="text-ink-300">직접 입력</span>
                      )}
                    </Td>
                    <Td className="max-w-[240px]">
                      <span className="line-clamp-2">{d.message || '-'}</span>
                    </Td>
                    <Td className="whitespace-nowrap text-right font-semibold tabular-nums text-ink-900">
                      {formatWon(d.amount)}
                    </Td>
                    <Td>
                      <Badge tone={st.tone}>{st.text}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={mt.tone}>{mt.text}</Badge>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <Badge tone={rf.tone}>{rf.text}</Badge>
                        {/*
                          일괄 처리 화면이 "잘못 눌렀으면 되돌릴 수 있습니다" 라고 안내하므로
                          되돌리는 자리가 실제로 있어야 한다. 지급 완료 건에만 보인다.
                        */}
                        {d.pointStatus === 'SENT' ? (
                          <ActionForm
                            action={undoPointsGivenAction}
                            submitLabel="되돌리기"
                            variant="ghost"
                            size="sm"
                            confirmTitle="지급 대기로 되돌릴까요?"
                            confirmMessage="지급 완료 표시를 지우고 대기 목록으로 되돌립니다. 내 서비스에 넣은 후원금는 직접 회수해 주세요."
                            doneTitle="지급 대기로 되돌렸습니다"
                          >
                            <input type="hidden" name="chargeIds" value={d.id} />
                          </ActionForm>
                        ) : null}
                      </div>
                    </Td>
                    <Td>{refund ? <Badge tone={refund.tone}>{refund.text}</Badge> : <span className="text-ink-300">-</span>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}

        {totalPages > 1 ? (
          <nav className="flex items-center justify-center gap-2">
            <PageLink href={`/studio/charges${buildQuery(base, { page: page - 1 })}`} disabled={page <= 1}>
              이전
            </PageLink>
            <span className="text-[13px] tabular-nums text-ink-500">
              {page} / {totalPages}
            </span>
            <PageLink href={`/studio/charges${buildQuery(base, { page: page + 1 })}`} disabled={page >= totalPages}>
              다음
            </PageLink>
          </nav>
        ) : null}
      </div>
    </>
  );
}

function PageLink({ href, disabled, children }: { href: string; disabled: boolean; children: React.ReactNode }) {
  if (disabled) {
    return (
      <span className="inline-flex h-9 items-center rounded-lg border border-ink-100 px-3 text-[13px] font-semibold text-ink-300">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="inline-flex h-9 items-center rounded-lg border border-ink-200 bg-white px-3 text-[13px] font-semibold text-ink-700 hover:bg-ink-50"
    >
      {children}
    </Link>
  );
}
