import Link from 'next/link';
import { EmptyState, LinkButton, Badge, Card } from '@/components/ui';
import { featureGoodsEnabled } from '@/lib/env';
import { RefundRequestForm } from '@/components/my/refund-request-form';
import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { redirect } from 'next/navigation';
import { chargeStatusLabel, pointStatusLabel, refundStatusLabel } from '@/lib/labels';
import type { ChargeStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

/** 결제가 완료되어 환불 요청이 가능한 상태 */
const REFUNDABLE: ChargeStatus[] = [
  'PAYMENT_SUCCESS',
  'BROADCAST_PENDING',
  'BROADCASTED',
  'PARTIAL_DELIVERY_FAILED',
  'SETTLEMENT_PENDING',
  'SETTLED',
];

/**
 * 후원 내역.
 * 카드에는 서비스 / 결제 메시지 / 금액만 두고,
 * 거래번호·송출 상태·환불처럼 가끔 필요한 정보는 접어둔다.
 */
export default async function MyChargesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { payerId } = await requirePayerContext('/my');
  const goodsEnabled = featureGoodsEnabled();
  const sp = await searchParams;
  const pageRaw = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  if (!payerId) {
    return (
      <>
        <EmptyState title={NO_PAYER_TITLE} description={NO_PAYER_DESC} />
        <div className="mt-4">
          <LinkButton href="/my/account#phone-link" size="md" className="w-full">
            휴대폰 번호 연결하기
          </LinkButton>
        </div>
      </>
    );
  }

  const [total, charges, paidAgg] = await Promise.all([
    prisma.charge.count({ where: { payerId } }),
    prisma.charge.findMany({
      where: { payerId },
      orderBy: { receivedAt: 'desc' },
      skip: (pageRaw - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        transactionNo: true,
        amount: true,
        message: true,
        status: true,
        pointStatus: true,
        pointGivenAt: true,
        receivedAt: true,
        paidAt: true,
        merchant: { select: { displayName: true, code: true } },
        refunds: {
          orderBy: { requestedAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    }),
    prisma.charge.aggregate({
      where: { payerId, status: { in: REFUNDABLE } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 로 들어오면 "후원 내역이 없습니다" 가 떠 누적 금액과 모순돼 보이고,
  // 되돌아갈 링크도 사라진다. 마지막 페이지로 보낸다.
  if (pageRaw > lastPage && total > 0) redirect(`/my?page=${lastPage}`);
  const page = pageRaw;

  return (
    <div className="space-y-4">
      {/* 요약 한 줄 */}
      <div className="flex items-end justify-between rounded-2xl bg-ink-900 px-5 py-4 text-white">
        <div>
          <p className="text-[11.5px] font-semibold text-white/60">누적 결제</p>
          <p className="mt-1 text-[24px] font-black tracking-[-0.035em] tabular-nums">
            {formatWon(paidAgg._sum.amount ?? 0n)}
          </p>
        </div>
        <p className="text-[12.5px] font-semibold text-white/70 tabular-nums">
          결제 완료 {formatNumber(paidAgg._count._all)}건
        </p>
      </div>

      {charges.length === 0 ? (
        <EmptyState title="후원 내역이 없습니다" description="서비스에 안내된 번호로 문자를 보내 결제하면 이곳에 표시됩니다." />
      ) : (
        <ul className="space-y-2">
          {charges.map((d) => {
            const status = chargeStatusLabel[d.status];
            const refund = d.refunds[0] ?? null;
            const refundOpen = refund ? ['REQUESTED', 'APPROVED', 'DONE'].includes(refund.status) : false;
            const canRefund = REFUNDABLE.includes(d.status) && !refundOpen;
            // 지급 상태는 상품 기능(FEATURE_GOODS)을 켠 기관의 디지털 항목에만 의미가 있다.
            // 후원에는 기관이 따로 지급할 것이 없으므로 기본 설정에서는 아무것도 표시하지 않는다(점검 M-17).
            const paidCharge = REFUNDABLE.includes(d.status);
            const point =
              !goodsEnabled || !paidCharge || d.pointStatus === 'SKIPPED'
                ? null
                : d.pointStatus === 'SENT'
                  ? { text: pointStatusLabel.SENT.text, tone: 'success' as const }
                  : d.pointStatus === 'FAILED'
                    ? { text: pointStatusLabel.FAILED.text, tone: 'warning' as const }
                    : { text: pointStatusLabel.PENDING.text, tone: 'neutral' as const };

            return (
              <li key={d.id}>
                <Card className="p-4 sm:p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link
                          href={`/donate/${d.merchant.code}`}
                          className="text-[14.5px] font-bold text-ink-900 hover:text-brand-700"
                        >
                          {d.merchant.displayName}
                        </Link>
                        <Badge tone={status.tone}>{status.text}</Badge>
                        {refund && d.status !== 'REFUND_REQUESTED' && d.status !== 'REFUNDED' ? (
                          <Badge tone={refundStatusLabel[refund.status].tone}>
                            환불 {refundStatusLabel[refund.status].text}
                          </Badge>
                        ) : null}
                        {point ? <Badge tone={point.tone}>{point.text}</Badge> : null}
                      </div>
                      <p className="mt-2 break-words text-[13.5px] leading-relaxed text-ink-700">
                        {d.message || '(내용 없음)'}
                      </p>
                      <p className="mt-1.5 text-[11.5px] tabular-nums text-ink-400">
                        {formatKst(d.receivedAt, false)}
                      </p>
                    </div>
                    <p className="shrink-0 text-[17px] font-extrabold tracking-tight tabular-nums text-ink-900">
                      {formatWon(d.amount)}
                    </p>
                  </div>

                  {/* 자세한 정보는 접어둔다 */}
                  <details className="group mt-3 border-t border-ink-100 pt-2.5">
                    <summary className="cursor-pointer list-none text-[12px] font-semibold text-ink-400 transition-colors hover:text-ink-700">
                      자세히 보기
                    </summary>
                    <dl className="mt-2.5 space-y-1.5 text-[12px]">
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-ink-400">거래번호</dt>
                        <dd className="break-all text-right font-mono font-semibold text-ink-900">{d.transactionNo}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-ink-400">결제 일시</dt>
                        <dd className="tabular-nums text-ink-700">{d.paidAt ? formatKst(d.paidAt, false) : '-'}</dd>
                      </div>
                      {point ? (
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-ink-400">상품 지급</dt>
                          <dd className="tabular-nums text-ink-700">
                            {d.pointStatus === 'SENT'
                              ? d.pointGivenAt
                                ? formatKst(d.pointGivenAt, false)
                                : '완료'
                              : point.text}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                    {point && d.pointStatus !== 'SENT' ? (
                      <p className="mt-2 rounded-lg bg-ink-50 px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-500">
                        상품은 <strong className="text-ink-700">{d.merchant.displayName}</strong>에서 직접 보내 드립니다.
                        후원은 정상 완료되었으며, 받지 못하셨다면 기관으로 문의해 주세요.
                      </p>
                    ) : null}
                    <div className="mt-3 space-y-2">
                      <RefundRequestForm
                        chargeId={d.id}
                        disabled={!canRefund}
                        disabledReason={
                          refundOpen
                            ? `환불 ${refundStatusLabel[refund!.status].text} 상태`
                            : '결제 완료 건만 환불 요청 가능'
                        }
                      />
                      <p className="text-right">
                        <Link
                          href={`/support?tx=${encodeURIComponent(d.transactionNo)}`}
                          className="text-[12px] font-semibold text-ink-400 hover:text-brand-700"
                        >
                          이 건 문의하기
                        </Link>
                      </p>
                    </div>
                  </details>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {lastPage > 1 ? (
        <nav className="flex items-center justify-between gap-3">
          {page > 1 ? (
            <LinkButton href={`/my?page=${page - 1}`} variant="secondary" size="sm">
              이전
            </LinkButton>
          ) : (
            <span />
          )}
          <span className="text-[12.5px] font-semibold tabular-nums text-ink-500">
            {page} / {lastPage}
          </span>
          {page < lastPage ? (
            <LinkButton href={`/my?page=${page + 1}`} variant="secondary" size="sm">
              다음
            </LinkButton>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
