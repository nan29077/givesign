import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { prisma } from '@/server/db';
import { giverPageContext } from '@/server/giver-context';
import { productSalesSummary } from '@/server/services/bazaar';
import { formatNumber, formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

/** 기부 리포트: 연도별 영수증 가액, 판매 결과, 기관별 기부. 기업은 ESG 보고에 쓸 수 있는 실데이터만 보여 준다. */
export default async function GiverReport() {
  const { donor } = await giverPageContext();
  const [receipts, donations] = await Promise.all([
    prisma.inKindReceipt.findMany({ where: { donorId: donor.id, status: 'ISSUED' }, include: { merchant: { select: { displayName: true } } } }),
    prisma.inKindDonation.findMany({ where: { donorId: donor.id }, include: { items: true, products: { select: { id: true } } } }),
  ]);
  const sums = await productSalesSummary(donations.flatMap((d) => d.products.map((p) => p.id)));
  let soldQty = 0;
  let net = 0n;
  for (const s of sums.values()) {
    soldQty += s.soldQty - s.refundQty;
    net += s.gross - s.refund;
  }
  const accepted = donations.flatMap((d) => d.items).reduce((s, it) => s + (it.acceptedQty ?? 0), 0);
  const byYear = new Map<number, bigint>();
  const byOrg = new Map<string, bigint>();
  for (const r of receipts) {
    byYear.set(r.taxYear, (byYear.get(r.taxYear) ?? 0n) + r.totalAmount);
    byOrg.set(r.merchant.displayName, (byOrg.get(r.merchant.displayName) ?? 0n) + r.totalAmount);
  }
  return (
    <>
      <PageHeader title="기부 리포트" description="기부하신 물품이 어떻게 쓰였는지 보여 드립니다." />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="영수증 가액 합계" value={formatWon(receipts.reduce((s, r) => s + r.totalAmount, 0n))} tone="brand" />
        <StatTile label="검수 합격 수량" value={`${formatNumber(accepted)}개`} />
        <StatTile label="판매된 수량" value={`${formatNumber(soldQty)}개`} />
        <StatTile label="판매로 만든 후원금(순판매액)" value={formatWon(net)} tone="success" />
      </div>
      {donor.donorType === 'CORPORATE' ? (
        <div className="mt-4"><Notice tone="brand" title="ESG 보고 참고">폐기 대신 기부된 수량(검수 합격 {formatNumber(accepted)}개)과 기관 기부 가액을 사회공헌 실적 자료로 쓸 수 있습니다. 수치는 모두 실제 처리 기록입니다.</Notice></div>
      ) : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Card><CardTitle>연도별 영수증 가액</CardTitle>
          <div className="mt-3"><Table><thead><tr><Th>연도</Th><Th className="text-right">금액</Th></tr></thead><tbody>
            {[...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([y, v]) => <tr key={y}><Td>{y}</Td><Td className="text-right tabular-nums">{formatWon(v)}</Td></tr>)}
          </tbody></Table></div>
        </Card>
        <Card><CardTitle>기관별 기부</CardTitle>
          <div className="mt-3"><Table><thead><tr><Th>기관</Th><Th className="text-right">영수증 가액</Th></tr></thead><tbody>
            {[...byOrg.entries()].map(([n, v]) => <tr key={n}><Td>{n}</Td><Td className="text-right tabular-nums">{formatWon(v)}</Td></tr>)}
          </tbody></Table></div>
        </Card>
      </div>
    </>
  );
}
