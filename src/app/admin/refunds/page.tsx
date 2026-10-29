import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { SafetyBanner } from '@/components/admin/safety-banner';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, AdminTextarea, FilterBar, Pager } from '@/components/admin/controls';
import { ActionForm } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, clampPage, canManageMoney } from '@/components/admin/constants';
import {
  approveRefundAction,
  rejectRefundAction,
  reopenRefundAction,
  createAdminRefund,
} from '@/app/actions/admin/transactions';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { refundStatusLabel, chargeStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { RefundStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const STATUSES: RefundStatus[] = ['REQUESTED', 'APPROVED', 'REJECTED', 'DONE', 'FAILED'];

export default async function AdminRefundsPage({
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
  const status = STATUSES.includes(sp.status as RefundStatus) ? (sp.status as RefundStatus) : undefined;

  const where: Prisma.RefundWhereInput = {
    ...(status ? { status } : {}),
    ...(q ? { charge: { transactionNo: { contains: q, mode: 'insensitive' as const } } } : {}),
  };

  const [total, refunds, grouped] = await Promise.all([
    prisma.refund.count({ where }),
    prisma.refund.findMany({
      where,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, amount: true, reason: true, status: true, requestedAt: true, processedAt: true,
        resultCode: true, resultMessage: true,
        charge: {
          select: {
            id: true, transactionNo: true, status: true, paidAt: true, settledAt: true,
            merchant: { select: { id: true, displayName: true } },
            payer: { select: { id: true, phoneMasked: true } },
          },
        },
      },
    }),
    // 아래 집계는 필터와 무관한 전체 기준이다(라벨에 명시한다).
    prisma.refund.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/refunds', params: { q, status: status ?? '' }, page, lastPage, total });
  const countOf = (s: RefundStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const doneSum = grouped.find((g) => g.status === 'DONE')?._sum.amount ?? 0n;

  return (
    <>
      <PageHeader
        title="환불 관리"
        description="환불이 승인되면 결제 취소와 함께 정산 원장에 반대 분개가 추가됩니다."
      />

      {/* 실제 계약이 없는 외부 연동은 mock 으로 동작한다. 그 사실을 이 화면에도 명시한다. */}
      <div className="mb-4">
        <SafetyBanner />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="처리 대기 (전체)"
          value={formatNumber(countOf('REQUESTED'))}
          tone={countOf('REQUESTED') > 0 ? 'warning' : 'neutral'}
        />
        <StatTile label="환불 완료" value={formatNumber(countOf('DONE'))} sub={formatWon(doneSum)} tone="success" />
        <StatTile label="거절" value={formatNumber(countOf('REJECTED'))} />
        <StatTile label="실패" value={formatNumber(countOf('FAILED'))} tone={countOf('FAILED') > 0 ? 'danger' : 'neutral'} />
      </div>

      <Notice tone="warning" title="환불이 정산에 미치는 영향">
        환불 승인 시 정산 원장에 환불(-) 분개와 플랫폼 수수료 환입(+) 분개가 추가됩니다. 정산 원장은 append-only 이므로
        기존 분개를 수정하지 않습니다. 이미 지급이 끝난 건을 환불하면 해당 사회복지기관의 잔액이 마이너스로 남아 다음
        정산에서 자동 차감됩니다.
      </Notice>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>관리자 직접 환불</CardTitle>
          <p className="mt-1 mb-3 text-[12px] leading-relaxed text-ink-400">
            후원자 요청 없이 운영 판단으로 환불합니다. 요청 생성과 승인이 한 번에 진행되므로 신중히 사용하세요.
          </p>
          <ActionForm disabled={!canEdit}
            action={createAdminRefund}
            submitLabel="즉시 환불 처리"
            variant="danger"
            confirm="입력한 거래를 즉시 환불합니다. 되돌릴 수 없습니다."
          >
            <AdminField label="거래번호" hint="예: TRD-20260819-XXXXXXXX">
              <AdminInput name="transactionNo" placeholder="TRD-20260819-XXXXXXXX" required />
            </AdminField>
            <AdminField label="결제 금액 (원)" hint="대상 확인용. 실제 결제 금액과 다르면 처리되지 않습니다.">
              <AdminInput name="amount" inputMode="numeric" placeholder="3000" required />
            </AdminField>
            <AdminField label="환불 사유">
              <AdminTextarea name="reason" rows={3} placeholder="예: 오발송 민원 처리" required />
            </AdminField>
          </ActionForm>
        </Card>

        <div className="lg:col-span-2">
          <FilterBar action="/admin/refunds" resetHref="/admin/refunds">
            <AdminField label="거래번호 검색" className="w-56">
              <AdminInput name="q" defaultValue={q} placeholder="TRD-20260819-XXXXXXXX" />
            </AdminField>
            <AdminField label="상태" className="w-40">
              <AdminSelect name="status" defaultValue={status ?? ''}>
                <option value="">전체</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {refundStatusLabel[s].text}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
          </FilterBar>

          <Notice tone="neutral" title="처리 순서">
            요청 상태의 건만 승인 또는 거절할 수 있습니다. 거절하면 결제 거래는 환불 요청 직전 상태로 되돌아갑니다.
            PG 취소가 실패해 <b>실패</b> 로 남은 건은 PG 내역을 확인한 뒤 <b>요청 상태로 되돌리기</b> 로 재시도하거나 거절할 수 있습니다.
          </Notice>
        </div>
      </div>

      <div className="mt-5">
        <SectionTitle title="환불 요청 목록" />
        {refunds.length === 0 ? (
          <EmptyState title="조건에 맞는 환불 요청이 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1200px]">
              <thead>
                <tr>
                  <Th>요청 시각</Th>
                  <Th>거래번호</Th>
                  <Th>사회복지기관 / 후원자</Th>
                  <Th className="text-right">환불 금액</Th>
                  <Th>사유</Th>
                  <Th>상태</Th>
                  <Th>정산 상태</Th>
                  <Th>처리</Th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap">
                      {formatKst(r.requestedAt, false)}
                      {r.processedAt ? (
                        <span className="mt-0.5 block text-[11px] text-ink-400">처리 {formatKst(r.processedAt, false)}</span>
                      ) : null}
                    </Td>
                    <Td className="font-mono text-[12px]">{r.charge.transactionNo}</Td>
                    <Td>
                      <Link href={`/admin/merchants/${r.charge.merchant.id}`} className="font-semibold text-brand-700">
                        {r.charge.merchant.displayName}
                      </Link>
                      {r.charge.payer ? (
                        <Link href={`/admin/payers/${r.charge.payer.id}`} className="mt-0.5 block text-[11px] text-ink-400">
                          {r.charge.payer.phoneMasked}
                        </Link>
                      ) : null}
                    </Td>
                    <Td className="text-right tabular-nums">{formatWon(r.amount)}</Td>
                    <Td className="max-w-[200px] break-words">{r.reason ?? '-'}</Td>
                    <Td>
                      <Badge tone={refundStatusLabel[r.status].tone}>{refundStatusLabel[r.status].text}</Badge>
                      {r.resultMessage ? (
                        <span className="mt-0.5 block max-w-[160px] text-[11px] break-words text-ink-400">
                          {r.resultCode ? `${r.resultCode} ` : ''}
                          {r.resultMessage}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={chargeStatusLabel[r.charge.status].tone}>
                        {chargeStatusLabel[r.charge.status].text}
                      </Badge>
                      {r.charge.settledAt ? (
                        <span className="mt-0.5 block text-[11px] text-warning-500">
                          지급 완료분 · 다음 정산 차감
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {r.status === 'REQUESTED' ? (
                        <div className="flex flex-col gap-1.5">
                          <details>
                            <summary className="cursor-pointer text-[12px] font-semibold text-brand-700">승인</summary>
                            <div className="mt-1.5 w-48">
                              <ActionForm disabled={!canEdit}
                                action={approveRefundAction}
                                submitLabel="승인 처리"
                                variant="primary"
                                compact
                                confirm="환불을 승인하고 결제를 취소합니다. 되돌릴 수 없습니다."
                              >
                                <input type="hidden" name="refundId" value={r.id} />
                                <AdminField label="승인 사유">
                                  <AdminInput name="memo" placeholder="예: 오발송 확인" />
                                </AdminField>
                              </ActionForm>
                            </div>
                          </details>
                          <details>
                            <summary className="cursor-pointer text-[12px] text-ink-500">거절</summary>
                            <div className="mt-1.5 w-48">
                              <ActionForm disabled={!canEdit} action={rejectRefundAction} submitLabel="거절 처리" variant="secondary" compact>
                                <input type="hidden" name="refundId" value={r.id} />
                                <AdminField label="거절 사유">
                                  <AdminInput name="memo" placeholder="예: 정상 결제 확인" />
                                </AdminField>
                              </ActionForm>
                            </div>
                          </details>
                        </div>
                      ) : r.status === 'FAILED' || r.status === 'APPROVED' ? (
                        <details>
                          <summary className="cursor-pointer text-[12px] font-semibold text-warning-500">
                            요청 상태로 되돌리기
                          </summary>
                          <div className="mt-1.5 w-52">
                            <p className="mb-1.5 text-[11px] leading-relaxed text-ink-400">
                              PG 취소 내역을 먼저 확인해 주세요. 이미 취소된 건을 되돌려 다시 승인하면 취소가 거절됩니다.
                            </p>
                            <ActionForm disabled={!canEdit} action={reopenRefundAction} submitLabel="되돌리기" variant="secondary" compact>
                              <input type="hidden" name="refundId" value={r.id} />
                              <AdminField label="사유">
                                <AdminInput name="memo" placeholder="예: PG 미취소 확인" />
                              </AdminField>
                            </ActionForm>
                          </div>
                        </details>
                      ) : (
                        <span className="text-[12px] text-ink-300">처리 완료</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/refunds"
              params={{ q, status: status ?? '' }}
              page={page}
              lastPage={lastPage}
              total={total}
            />
          </>
        )}
      </div>
    </>
  );
}
