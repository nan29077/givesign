import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, EmptyState, LinkButton, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { studioBazaarContext, studioTabs } from '@/server/studio-bazaar-context';
import { merchantSalesOverview } from '@/server/services/bazaar-views';
import { getBazaarConfig } from '@/server/services/bazaar-settings';
import { ledgerTypeLabel, productStatusLabel, settlementStatusLabel } from '@/lib/bazaar';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function StudioBazaarSales() {
  const { merchant } = await studioBazaarContext();
  const mid = merchant.merchantId;
  const [{ products, sums, settlements }, cfg, ledger, account] = await Promise.all([
    merchantSalesOverview(mid),
    getBazaarConfig(),
    prisma.bazaarLedger.findMany({ where: { merchantId: mid }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.settlementAccount.findUnique({ where: { merchantId: mid }, select: { bankName: true, accountTail4: true, holderMasked: true } }),
  ]);
  let net = 0n;
  for (const s of sums.values()) net += s.gross - s.refund;
  const paid = settlements.filter((s) => s.status === 'PAID').reduce((a, s) => a + s.payout, 0n);
  // 지급 예정은 집계·확정 중이면서 지급액이 있는 것만. 0원 이하는 다음 달로 이월된다.
  const due = settlements.filter((s) => (s.status === 'DRAFT' || s.status === 'CONFIRMED') && s.payout > 0n).reduce((a, s) => a + s.payout, 0n);
  return (
    <>
      <PageHeader title="판매·정산" description={`판매 금액에서 수수료 ${cfg.feeRatePercent}%(부가세 ${cfg.feeVatMode === 'INCLUDED' ? '포함' : '별도'})와 기관 부담 반송비를 뺀 금액을 매월 1회 정산해 다음 달 ${cfg.settlementPayDay}일에 지급합니다.`} action={<LinkButton href="/api/bazaar/export?kind=ledger" variant="secondary">현물 기부 대장(CSV)</LinkButton>} />
      <BazaarSubNav items={studioTabs()} current="/studio/bazaar/sales" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="누적 순판매액" value={formatWon(net)} />
        <StatTile label="지급 예정" value={formatWon(due)} tone="brand" />
        <StatTile label="지급 완료" value={formatWon(paid)} tone="success" />
        <StatTile label="판매 상품" value={`${products.length}개`} />
      </div>
      {!account ? <div className="mt-4"><Notice tone="warning">정산 받을 계좌가 없습니다. 정산 관리 메뉴에서 계좌를 등록해 주세요.</Notice></div> : <p className="mt-3 text-[12.5px] text-ink-500">지급 계좌: {account.bankName} ****{account.accountTail4} ({account.holderMasked})</p>}

      <Card className="mt-5">
        <CardTitle>월 정산</CardTitle>
        <p className="mt-1 text-[12.5px] text-ink-500">환불이 판매보다 많아 기관 귀속이 0원 이하인 달은 지급하지 않고 다음 달 정산으로 넘겨 차감합니다.</p>
        {settlements.length === 0 ? <p className="mt-2 text-[13px] text-ink-500">아직 정산 내역이 없습니다.</p> : (
          <div className="mt-3"><Table>
            <thead><tr><Th>정산 월</Th><Th className="text-right">판매</Th><Th className="text-right">환불</Th><Th className="text-right">수수료</Th><Th className="text-right">반송비·이월</Th><Th className="text-right">기관 귀속</Th><Th>지급일</Th><Th>상태</Th></tr></thead>
            <tbody>{settlements.map((s) => (
              <tr key={s.id}><Td>{s.month}</Td><Td className="text-right tabular-nums">{formatWon(s.gross)}</Td><Td className="text-right tabular-nums">{formatWon(s.refund)}</Td><Td className="text-right tabular-nums">{formatWon(s.fee)}<span className="block text-[11px] text-ink-400">부가세 {formatWon(s.feeVat)}</span></Td><Td className="text-right tabular-nums">{formatWon(s.returnCost)}{s.carryAmount !== 0n ? <span className="block text-[11px] text-ink-400">전월 이월 {formatWon(s.carryAmount)}</span> : null}</Td><Td className="text-right font-bold tabular-nums">{formatWon(s.payout)}</Td><Td>{s.paidAt ? formatKst(s.paidAt, false) : s.status === 'CARRIED' ? (s.carriedToMonth ? `${s.carriedToMonth} 정산에서 차감` : '지급 없음') : s.dueDate.toISOString().slice(0, 10)}</Td><Td><LabelBadge map={settlementStatusLabel} value={s.status} /></Td></tr>
            ))}</tbody>
          </Table></div>
        )}
      </Card>

      <Card className="mt-5">
        <CardTitle>상품별 판매</CardTitle>
        {products.length === 0 ? <div className="mt-3"><EmptyState title="판매 상품이 없습니다" description="검수를 확정하면 판매 상품이 만들어집니다." /></div> : (
          <div className="mt-3"><Table>
            <thead><tr><Th>추적 코드</Th><Th>상품</Th><Th>기부번호</Th><Th className="text-right">판매가</Th><Th className="text-right">판매 / 수량</Th><Th className="text-right">순판매액</Th><Th>상태</Th></tr></thead>
            <tbody>{products.map((p) => { const s = sums.get(p.id); return (
              <tr key={p.id}><Td className="font-mono text-[12px]">{p.trackingCode}</Td><Td>{p.name}</Td><Td className="font-mono text-[11.5px]">{p.donation.donationNo}</Td><Td className="text-right tabular-nums">{formatWon(p.salePrice)}</Td><Td className="text-right tabular-nums">{(s?.soldQty ?? 0) - (s?.refundQty ?? 0)} / {p.quantity}</Td><Td className="text-right tabular-nums">{formatWon((s?.gross ?? 0n) - (s?.refund ?? 0n))}</Td><Td><LabelBadge map={productStatusLabel} value={p.status} /></Td></tr>
            ); })}</tbody>
          </Table></div>
        )}
      </Card>

      <Card className="mt-5">
        <CardTitle>정산 원장(최근 50건)</CardTitle>
        {ledger.length === 0 ? <p className="mt-2 text-[13px] text-ink-500">원장 기록이 없습니다.</p> : (
          <div className="mt-3"><Table>
            <thead><tr><Th>일시</Th><Th>월</Th><Th>구분</Th><Th className="text-right">금액</Th><Th>내용</Th></tr></thead>
            <tbody>{ledger.map((l) => (
              <tr key={l.id}><Td>{formatKst(l.createdAt, false)}</Td><Td>{l.month}</Td><Td>{ledgerTypeLabel[l.entryType] ?? l.entryType}</Td><Td className="text-right tabular-nums">{formatWon(l.amount)}</Td><Td className="text-[12px]">{l.memo}</Td></tr>
            ))}</tbody>
          </Table></div>
        )}
      </Card>
    </>
  );
}
