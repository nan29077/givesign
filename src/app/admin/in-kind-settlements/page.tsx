import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, EmptyState, Notice, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput } from '@/components/admin/controls';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { requireAdmin } from '@/server/auth';
import { prisma } from '@/server/db';
import { ADMIN_BAZAAR_TABS } from '@/server/admin-bazaar-context';
import { isLiveBazaarEnabled } from '@/server/services/bazaar-settings';
import { internalNetSales } from '@/server/services/bazaar';
import { carryOverSettlementAction, confirmSettlementAction, generateSettlementsAction, paySettlementAction, reconcileAction } from '@/app/actions/admin/bazaar';
import { settlementStatusLabel } from '@/lib/bazaar';
import { formatWon } from '@/lib/money';
import { formatKst, kstDateKey, kstMonthKey } from '@/lib/datetime';
import { previousMonthKey } from '@/server/services/monthly-notice';

export const dynamic = 'force-dynamic';

/**
 * 현물 판매 정산(월 1회).
 * 라이브 바자회 스위치가 꺼져도 이 화면은 열린다 — 확정된 정산은 계속 지급한다(2026-11-05 결정).
 * 꺼져 있을 때는 바자회 메뉴·문구 없이 정산(집계·확정·이월·지급)만 보여 준다. 꺼진 동안에는 새 판매 결과가 들어오지 않으므로
 * 집계는 이미 승인된 판매분에 대해서만 일어난다(2026-11-06 점검: 안내와 동작을 맞춤).
 */
export default async function InKindSettlementsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await requireAdmin();
  const enabled = await isLiveBazaarEnabled();
  const sp = await searchParams;
  // 기본은 지난달(끝난 달)을 집계·확정한다(2026-11-13 B-M1). 이번 달은 주소 ?month= 로 미리 볼 수 있다.
  const thisMonth = kstMonthKey();
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : previousMonthKey();
  const [settlements, recon] = await Promise.all([
    prisma.bazaarSettlement.findMany({ orderBy: [{ month: 'desc' }, { status: 'asc' }], take: 200, include: { merchant: { select: { displayName: true, settlementAccount: { select: { bankName: true, accountTail4: true, holderMasked: true } } } } } }),
    enabled ? prisma.bazaarReconcile.findMany({ orderBy: { createdAt: 'desc' }, take: 12 }) : Promise.resolve([]),
  ]);
  const internal = enabled ? await internalNetSales(month) : 0n;
  return (
    <>
      <PageHeader title={enabled ? '바자회 정산·대사' : '현물 판매 정산'} description="월 1회 기관별로 집계 → 확정 → 이체 후 지급 완료를 기록합니다. 지급일은 정산 월의 다음 달 지정일입니다." />
      {enabled ? <BazaarSubNav items={ADMIN_BAZAAR_TABS} current="/admin/in-kind-settlements" /> : null}
      <Card>
        <CardTitle>월 정산 집계</CardTitle>
        <p className="mt-1 text-[12.5px] text-ink-500">끝난 달만 확정합니다(지난달 집계는 매월 1일 자동으로 만들어집니다). 이번 달은 미리 집계해 볼 수 있고, 행사 조기 마감 등으로 꼭 확정해야 하면 최고관리자가 사유를 적어 확정합니다. 해당 월 원장(승인된 판매 결과·반송비·전월 이월)을 기관별로 모읍니다. 이미 확정·지급·이월된 정산은 바뀌지 않으며, 확정 뒤 들어온 판매는 다음 달로 넘어갑니다. 지급액이 0원 이하이면 확정할 때 지급 없이 다음 달 정산으로 넘어갑니다(다음 정산에서 차감).</p>
        <div className="mt-3"><ActionForm action={generateSettlementsAction} submitLabel="집계하기"><AdminField label="정산 월"><AdminInput type="month" name="month" defaultValue={month} /></AdminField></ActionForm></div>
      </Card>

      <Card className="mt-5">
        <CardTitle>기관 정산</CardTitle>
        {settlements.length === 0 ? <div className="mt-3"><EmptyState title="정산 내역이 없습니다" /></div> : (
          <div className="mt-3"><Table>
            <thead><tr><Th>월</Th><Th>기관 · 계좌</Th><Th className="text-right">판매</Th><Th className="text-right">환불</Th><Th className="text-right">수수료(부가세)</Th><Th className="text-right">반송비·이월</Th><Th className="text-right">지급액</Th><Th>지급일</Th><Th>상태·처리</Th></tr></thead>
            <tbody>{settlements.map((s) => (
              <tr key={s.id}>
                <Td>{s.month}</Td>
                <Td>{s.merchant.displayName}<span className="block text-[11px] text-ink-400">{s.merchant.settlementAccount ? `${s.merchant.settlementAccount.bankName} ****${s.merchant.settlementAccount.accountTail4} (${s.merchant.settlementAccount.holderMasked})` : '계좌 미등록'}</span></Td>
                <Td className="text-right tabular-nums">{formatWon(s.gross)}</Td>
                <Td className="text-right tabular-nums">{formatWon(s.refund)}</Td>
                <Td className="text-right tabular-nums">{formatWon(s.fee)}<span className="block text-[11px] text-ink-400">{formatWon(s.feeVat)}</span></Td>
                <Td className="text-right tabular-nums">{formatWon(s.returnCost)}{s.carryAmount !== 0n ? <span className="block text-[11px] text-ink-400">이월 {formatWon(s.carryAmount)}</span> : null}</Td>
                <Td className={s.payout < 0n ? 'text-right font-bold text-danger-500 tabular-nums' : 'text-right font-bold tabular-nums'}>{formatWon(s.payout)}</Td>
                <Td className="text-[12px]">{s.paidAt ? formatKst(s.paidAt, false) : s.status === 'CARRIED' ? (s.carriedToMonth ? `${s.carriedToMonth}로 이월` : '지급 없음') : s.dueDate.toISOString().slice(0, 10)}</Td>
                <Td>
                  <LabelBadge map={settlementStatusLabel} value={s.status} />
                  {s.transferRef ? <span className="block text-[11px] text-ink-400">{s.transferRef}</span> : null}
                  {s.status === 'DRAFT' ? <div className="mt-1"><ActionForm action={confirmSettlementAction} submitLabel="확정" compact confirm={`${s.merchant.displayName} ${s.month} 정산을 확정할까요? 확정 금액은 바뀌지 않습니다.${s.payout <= 0n ? ' 지급액이 0원 이하라 지급 없이 다음 달로 넘어갑니다.' : ''}`}><input type="hidden" name="settlementId" value={s.id} />{s.month >= thisMonth ? <AdminInput name="earlyReason" placeholder="월 마감 전 확정 사유(최고관리자)" aria-label="월 마감 전 확정 사유" /> : null}</ActionForm></div> : null}
                  {s.status === 'CONFIRMED' && s.payout <= 0n ? (
                    <div className="mt-1"><ActionForm action={carryOverSettlementAction} submitLabel="다음 달로 이월" compact confirm="지급할 금액이 없는 정산입니다. 다음 달 정산으로 넘기고 마감할까요? 되돌릴 수 없습니다."><input type="hidden" name="settlementId" value={s.id} /></ActionForm></div>
                  ) : null}
                  {s.status === 'CONFIRMED' && s.payout > 0n ? (
                    <div className="mt-1"><ActionForm action={paySettlementAction} submitLabel="지급 완료 기록" compact confirm="은행 이체를 마쳤나요? 지급 완료로 기록합니다.">
                      <input type="hidden" name="settlementId" value={s.id} />
                      <AdminInput type="date" name="paidAt" defaultValue={kstDateKey()} aria-label="지급일" />
                      <AdminInput name="transferRef" placeholder="이체 확인 번호·메모" />
                    </ActionForm></div>
                  ) : null}
                </Td>
              </tr>
            ))}</tbody>
          </Table></div>
        )}
      </Card>

      {enabled ? (
        <Card className="mt-5">
          <CardTitle>월 대사(셀러브릭스 ↔ 기브싸인)</CardTitle>
          <p className="mt-1 text-[12.5px] text-ink-500">{month} 기브싸인 반영 순판매액(판매-환불): <strong>{formatWon(internal)}</strong>. 셀러브릭스 바자회 센터 창고의 같은 기간 주문 합계(환불 제외)를 넣어 비교합니다.</p>
          <div className="mt-3"><ActionForm action={reconcileAction} submitLabel="대사하기" variant="secondary">
            <div className="grid grid-cols-2 gap-2">
              <AdminField label="월"><AdminInput type="month" name="month" defaultValue={month} /></AdminField>
              <AdminField label="셀러브릭스 합계(원)"><AdminInput name="externalAmount" inputMode="numeric" /></AdminField>
            </div>
            <AdminField label="메모"><AdminInput name="note" /></AdminField>
          </ActionForm></div>
          {recon.length ? (
            <div className="mt-3"><Table><thead><tr><Th>일시</Th><Th>월</Th><Th className="text-right">셀러브릭스</Th><Th className="text-right">기브싸인</Th><Th className="text-right">차이</Th><Th>메모</Th></tr></thead>
              <tbody>{recon.map((r) => <tr key={r.id}><Td className="text-[12px]">{formatKst(r.createdAt, false)}</Td><Td>{r.month}</Td><Td className="text-right tabular-nums">{formatWon(r.externalAmount)}</Td><Td className="text-right tabular-nums">{formatWon(r.internalAmount)}</Td><Td className={r.diff === 0n ? 'text-right tabular-nums' : 'text-right font-bold text-danger-500 tabular-nums'}>{formatWon(r.diff)}</Td><Td className="text-[12px]">{r.note}</Td></tr>)}</tbody>
            </Table></div>
          ) : null}
        </Card>
      ) : <div className="mt-5"><Notice tone="neutral">서비스가 꺼져 있어 새 판매 결과는 받지 않습니다. 이미 승인된 판매분의 집계·확정·이월·지급은 그대로 처리할 수 있습니다.</Notice></div>}
    </>
  );
}
