import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { SafetyBanner } from '@/components/admin/safety-banner';
import { Badge, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { PAGE_SIZE, parsePage, clampPage, canManageMoney } from '@/components/admin/constants';
import { ActionForm } from '@/components/admin/action-form';
import { reconcilePaymentAction } from '@/app/actions/admin/transactions';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { paymentTxStatusLabel, chargeStatusLabel } from '@/lib/labels';
import { channelLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { PaymentTxStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const STATUSES: PaymentTxStatus[] = ['REQUESTED', 'APPROVED', 'FAILED', 'CANCELED', 'TIMEOUT', 'UNKNOWN'];

const txSelect = {
  id: true, orderNo: true, provider: true, providerTid: true, amount: true, status: true,
  resultCode: true, resultMessage: true, requestedAt: true, approvedAt: true, canceledAt: true,
  charge: {
    select: {
      id: true, transactionNo: true, status: true, paymentMode: true, channel: true,
      merchant: { select: { id: true, displayName: true } },
      payer: { select: { id: true, phoneMasked: true } },
    },
  },
  attempts: {
    orderBy: { attemptNo: 'asc' as const },
    select: { id: true, attemptNo: true, operation: true, latencyMs: true, errorCode: true, errorMessage: true, createdAt: true },
  },
} satisfies Prisma.PaymentTransactionSelect;

type TxRow = Prisma.PaymentTransactionGetPayload<{ select: typeof txSelect }>;

function TxRows({
  rows,
  reconcilable = false,
  canEdit = true,
}: {
  rows: TxRow[];
  reconcilable?: boolean;
  /** 권한이 없으면 대사 컨트롤을 잠근다. */
  canEdit?: boolean;
}) {
  return (
    <tbody>
      {rows.map((t) => (
        <tr key={t.id}>
          <Td className="font-mono text-[12px]">
            {t.orderNo}
            <span className="mt-0.5 block text-[11px] text-ink-400">{t.provider}</span>
          </Td>
          <Td className="font-mono text-[12px]">{t.charge.transactionNo}</Td>
          <Td>
            <Link href={`/admin/merchants/${t.charge.merchant.id}`} className="font-semibold text-brand-700">
              {t.charge.merchant.displayName}
            </Link>
            {t.charge.payer ? (
              <Link href={`/admin/payers/${t.charge.payer.id}`} className="mt-0.5 block text-[11px] text-ink-400">
                {t.charge.payer.phoneMasked}
              </Link>
            ) : null}
          </Td>
          <Td className="text-right tabular-nums">{formatWon(t.amount)}</Td>
          <Td>
            <Badge tone={paymentTxStatusLabel[t.status].tone}>{paymentTxStatusLabel[t.status].text}</Badge>
            <span className="mt-0.5 block text-[11px] text-ink-400">
              {chargeStatusLabel[t.charge.status].text}
            </span>
            <span className="mt-0.5 block text-[11px] font-semibold text-ink-300">
              {channelLabel(t.charge.channel, 'long')}
            </span>
          </Td>
          <Td className="max-w-[200px] break-words">
            {t.resultCode ?? '-'}
            {t.resultMessage ? <span className="block text-[11px] text-ink-400">{t.resultMessage}</span> : null}
          </Td>
          <Td className="whitespace-nowrap">
            {formatKst(t.requestedAt, false)}
            {t.approvedAt ? <span className="mt-0.5 block text-[11px] text-success-500">승인 {formatKst(t.approvedAt, false)}</span> : null}
            {t.canceledAt ? <span className="mt-0.5 block text-[11px] text-danger-500">취소 {formatKst(t.canceledAt, false)}</span> : null}
          </Td>
          <Td>
            <details>
              <summary className="cursor-pointer text-[12px] font-semibold text-brand-700">
                시도 {t.attempts.length}건
              </summary>
              <div className="mt-2 space-y-1.5">
                {t.attempts.length === 0 ? (
                  <p className="text-[12px] text-ink-400">기록된 시도가 없습니다.</p>
                ) : (
                  t.attempts.map((a) => (
                    <div key={a.id} className="rounded-lg border border-ink-100 bg-ink-50 px-2.5 py-1.5 text-[11px] leading-relaxed">
                      <span className="font-semibold text-ink-700">
                        #{a.attemptNo} {a.operation}
                      </span>
                      <span className="ml-2 text-ink-400">{formatKst(a.createdAt, false)}</span>
                      <span className="ml-2 tabular-nums text-ink-400">{a.latencyMs != null ? `${a.latencyMs}ms` : '-'}</span>
                      {a.errorCode ? (
                        <span className="block text-danger-500">
                          {a.errorCode} {a.errorMessage ?? ''}
                        </span>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </details>
          </Td>
          {reconcilable ? (
            <Td>
              <ReconcileCell transactionId={t.id} orderNo={t.orderNo} canEdit={canEdit} />
            </Td>
          ) : null}
        </tr>
      ))}
    </tbody>
  );
}

/**
 * 결과 미확인 결제의 수동 확정.
 * PG 관리자 화면에서 실제 승인 여부를 대사한 뒤에만 사용한다. 되돌릴 수 없다.
 */
function ReconcileCell({
  transactionId,
  orderNo,
  canEdit,
}: {
  transactionId: string;
  orderNo: string;
  canEdit: boolean;
}) {
  return (
    <div className="flex min-w-[210px] flex-col gap-2">
      <ActionForm disabled={!canEdit}
        action={reconcilePaymentAction}
        submitLabel="결제 확정"
        variant="primary"
        compact
        confirm={`${orderNo} 건을 결제 승인으로 확정합니다.
PG 관리자에서 실제 출금을 확인하셨나요? 정산 원장에 분개가 추가되며 되돌릴 수 없습니다.`}
      >
        <input type="hidden" name="transactionId" value={transactionId} />
        <input type="hidden" name="decision" value="APPROVE" />
        <input
          name="memo"
          placeholder="대사 근거 (예: PG 조회 결과 승인)"
          className="h-8 w-full rounded-lg border border-ink-200 px-2 text-[12px] text-ink-900 focus:border-brand-400 focus:outline-none"
        />
      </ActionForm>
      <ActionForm disabled={!canEdit}
        action={reconcilePaymentAction}
        submitLabel="결제 취소"
        variant="danger"
        compact
        confirm={`${orderNo} 건을 결제 취소로 확정합니다.
출금이 없었음을 확인하셨나요? 결제는 실패로 확정되며 되돌릴 수 없습니다.`}
      >
        <input type="hidden" name="transactionId" value={transactionId} />
        <input type="hidden" name="decision" value="CANCEL" />
        <input
          name="memo"
          placeholder="대사 근거 (예: PG 조회 결과 미승인)"
          className="h-8 w-full rounded-lg border border-ink-200 px-2 text-[12px] text-ink-900 focus:border-brand-400 focus:outline-none"
        />
      </ActionForm>
    </div>
  );
}

const HEAD = (
  <thead>
    <tr>
      <Th>주문번호</Th>
      <Th>거래번호</Th>
      <Th>사회복지기관 / 후원자</Th>
      <Th className="text-right">금액</Th>
      <Th>상태</Th>
      <Th>결과</Th>
      <Th>시각</Th>
      <Th>PG 시도 이력</Th>
    </tr>
  </thead>
);

export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canManageMoney(me.adminPermission);

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? '').trim();
  const status = STATUSES.includes(sp.status as PaymentTxStatus) ? (sp.status as PaymentTxStatus) : undefined;

  const where: Prisma.PaymentTransactionWhereInput = {
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { orderNo: { contains: q, mode: 'insensitive' as const } },
            { providerTid: { contains: q, mode: 'insensitive' as const } },
            { charge: { transactionNo: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const needsCheckWhere: Prisma.PaymentTransactionWhereInput = { status: { in: ['UNKNOWN', 'TIMEOUT'] } };

  const [total, rows, needsCheck, needsCheckTotal, grouped] = await Promise.all([
    prisma.paymentTransaction.count({ where }),
    prisma.paymentTransaction.findMany({
      where,
      // 같은 시각의 거래가 있어도 페이지 사이에서 순서가 흔들리지 않게 id 를 보조 정렬로 둔다.
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: txSelect,
    }),
    prisma.paymentTransaction.findMany({
      where: needsCheckWhere,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: txSelect,
    }),
    // 목록은 상위 20건만 보여 주지만 경고 제목에는 실제 건수를 쓴다.
    prisma.paymentTransaction.count({ where: needsCheckWhere }),
    prisma.paymentTransaction.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/payments', params: { q, status: status ?? '' }, page, lastPage, total });
  const countOf = (s: PaymentTxStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const approvedSum = grouped.find((g) => g.status === 'APPROVED')?._sum.amount ?? 0n;

  return (
    <>
      <PageHeader
        title="결제 관리"
        description="PG 결제 거래와 연결된 결제 건을 함께 조회합니다. 결과를 확인할 수 없는 건은 상단에 별도로 모아 표시합니다."
      />

      {/* 실제 계약이 없는 외부 연동은 mock 으로 동작한다. 그 사실을 이 화면에도 명시한다. */}
      <div className="mb-4">
        <SafetyBanner />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {/* 아래 네 타일은 필터와 무관한 전체 기준이다(목록만 필터를 탄다). */}
        <StatTile label="승인 (전체)" value={formatNumber(countOf('APPROVED'))} sub={formatWon(approvedSum)} tone="success" />
        <StatTile label="실패" value={formatNumber(countOf('FAILED'))} tone={countOf('FAILED') > 0 ? 'danger' : 'neutral'} />
        <StatTile label="취소" value={formatNumber(countOf('CANCELED'))} />
        <StatTile
          label="결과 확인 필요"
          value={formatNumber(countOf('UNKNOWN') + countOf('TIMEOUT'))}
          sub="UNKNOWN + TIMEOUT"
          tone={countOf('UNKNOWN') + countOf('TIMEOUT') > 0 ? 'danger' : 'neutral'}
        />
      </div>

      {needsCheck.length > 0 ? (
        <section className="mb-6">
          <Notice
            tone="danger"
            title={`결과 확인이 필요한 결제 ${formatNumber(needsCheckTotal)}건${
              needsCheckTotal > needsCheck.length ? ` (오래된 순 ${needsCheck.length}건 표시)` : ''
            }`}
          >
            PG 응답이 타임아웃되었거나 결과를 알 수 없는 거래입니다. 실제 승인 여부를 PG 관리자에서 대사한 뒤 오른쪽
            [수동 확정]으로 결론을 반영해 주세요. 확인 전까지는 중복 결제를 유발할 수 있는 재시도를 하지 마세요.
            [결제 확정]은 정산 원장에 분개를 추가하고, [결제 취소]는 결제를 실패로 확정하며 한도 집계를 되돌립니다.
            어느 쪽도 되돌릴 수 없으므로 대사 근거를 반드시 남겨 주세요. 확정된 거래는 자동으로 다시 시도되지 않습니다.
          </Notice>
          <div className="mt-3">
            <Table className="min-w-[1400px]">
              <thead>
                <tr>
                  <Th>주문번호</Th>
                  <Th>거래번호</Th>
                  <Th>사회복지기관 / 후원자</Th>
                  <Th className="text-right">금액</Th>
                  <Th>상태</Th>
                  <Th>결과</Th>
                  <Th>시각</Th>
                  <Th>PG 시도 이력</Th>
                  <Th>수동 확정</Th>
                </tr>
              </thead>
              <TxRows rows={needsCheck} reconcilable canEdit={canEdit} />
            </Table>
          </div>
        </section>
      ) : null}

      <SectionTitle title="결제 거래 목록" />

      <FilterBar action="/admin/payments" resetHref="/admin/payments">
        <AdminField label="주문번호·거래번호·PG TID" className="w-64">
          <AdminInput name="q" defaultValue={q} placeholder="MSG2026... 또는 TRD-2026..." />
        </AdminField>
        <AdminField label="상태" className="w-40">
          <AdminSelect name="status" defaultValue={status ?? ''}>
            <option value="">전체</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {paymentTxStatusLabel[s].text}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
      </FilterBar>

      {rows.length === 0 ? (
        <EmptyState title="조건에 맞는 결제 거래가 없습니다" />
      ) : (
        <>
          <Table className="min-w-[1200px]">
            {HEAD}
            <TxRows rows={rows} />
          </Table>
          <Pager
            basePath="/admin/payments"
            params={{ q, status: status ?? '' }}
            page={page}
            lastPage={lastPage}
            total={total}
          />
        </>
      )}
    </>
  );
}
