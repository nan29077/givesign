import { formatNumber } from '@/lib/money';
import { DONATION_CODES } from '@/lib/receipt-codes';
import { formatBizNo } from '@/lib/bazaar';
import type { InKindReceipt } from '@/generated/prisma/client';

/**
 * 현물 기부금영수증 서식(화면·인쇄용). 발급 당시 스냅샷으로만 그린다.
 * 개인 기부자는 주민등록번호 마스킹 값만, 기업은 사업자등록번호를 인쇄한다.
 */
interface Donor { type?: string; name?: string | null; businessNo?: string | null; representativeName?: string | null; residentNoMasked?: string | null; address?: string | null }
interface Issuer { name?: string; businessNo?: string | null; representativeName?: string | null; address?: string | null; orgType?: string | null }
interface Item { name: string; quantity: number; unitValue: string; amount: string }

const ORG_TYPE: Record<string, string> = {
  WELFARE_CORPORATION: '사회복지법인',
  WELFARE_FACILITY: '사회복지시설',
  NONPROFIT_ORG: '비영리민간단체',
  PUBLIC_INTEREST_CORP: '공익법인',
  RELIGIOUS: '종교단체',
  OTHER: '기타',
};

function Cell({ label, children, span = 1 }: { label: string; children: React.ReactNode; span?: number }) {
  return (
    <div className={span === 2 ? 'col-span-2' : ''}>
      <p className="text-[11px] font-bold text-ink-400">{label}</p>
      <p className="mt-0.5 text-[14px] font-semibold text-ink-900">{children}</p>
    </div>
  );
}

const ymd = (d: Date) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);

export function InKindReceiptDocument({ receipt: r }: { receipt: InKindReceipt }) {
  const donor = r.donorSnapshot as Donor;
  const issuer = r.issuerSnapshot as Issuer;
  const items = (r.items as unknown as Item[]) ?? [];
  const corporate = r.donorType === 'CORPORATE';
  return (
    <article className="receipt-doc mx-auto max-w-[760px] rounded-2xl border border-ink-200 bg-white p-6 text-ink-900 shadow-sm print:border-0 print:shadow-none sm:p-10">
      {r.status === 'VOID' ? (
        <p className="mb-4 rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2 text-center text-[13px] font-extrabold text-danger-500">
          무효 처리된 영수증입니다{r.voidReason ? ` — ${r.voidReason}` : ''}
        </p>
      ) : null}
      <header className="border-b-2 border-ink-900 pb-4 text-center">
        <h1 className="text-[24px] font-black tracking-[0.3em]">기부금영수증</h1>
        <p className="mt-1 text-[12px] text-ink-500">
          발급번호 <span className="font-mono">{r.receiptNo}</span> · 귀속연도 {r.taxYear}년 · 현물
        </p>
      </header>

      <section className="mt-5">
        <h2 className="mb-2 text-[13px] font-extrabold">1. 기부자</h2>
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-ink-50 p-4">
          <Cell label={corporate ? '상호(법인명)' : '성명'}>{donor.name ?? '-'}</Cell>
          <Cell label={corporate ? '사업자등록번호' : '주민등록번호'}>{corporate ? formatBizNo(donor.businessNo) : donor.residentNoMasked ?? '-'}</Cell>
          {corporate ? <Cell label="대표자">{donor.representativeName ?? '-'}</Cell> : null}
          <Cell label="주소" span={corporate ? 1 : 2}>{donor.address || '-'}</Cell>
        </div>
      </section>

      <section className="mt-5">
        <h2 className="mb-2 text-[13px] font-extrabold">2. 기부금 단체</h2>
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-ink-50 p-4">
          <Cell label="단체명">{issuer.name ?? '-'}</Cell>
          <Cell label="고유번호(사업자등록번호)">{issuer.businessNo ?? '-'}</Cell>
          <Cell label="대표자">{issuer.representativeName ?? '-'}</Cell>
          <Cell label="단체 유형">{issuer.orgType ? ORG_TYPE[issuer.orgType] ?? issuer.orgType : '-'}</Cell>
          <Cell label="소재지" span={2}>{issuer.address ?? '-'}</Cell>
        </div>
      </section>

      <section className="mt-5">
        <h2 className="mb-2 text-[13px] font-extrabold">3. 기부내용 (현물)</h2>
        <p className="mb-2 text-[12px] text-ink-500">
          기부금 코드 {r.donationCode} ({DONATION_CODES[r.donationCode] ?? ''}) · 기부일자 {ymd(r.donatedAt)}
        </p>
        <div className="overflow-x-auto rounded-xl border border-ink-200">
          <table className="w-full text-[13px]">
            <thead className="bg-ink-50 text-[11.5px] text-ink-500">
              <tr>
                <th className="px-3 py-2 text-left">품명</th>
                <th className="px-3 py-2 text-right">수량</th>
                <th className="px-3 py-2 text-right">단가(원)</th>
                <th className="px-3 py-2 text-right">금액(원)</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={`${it.name}-${i}`} className="border-t border-ink-100">
                  <td className="px-3 py-2">{it.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(it.quantity)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(BigInt(it.unitValue))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(BigInt(it.amount))}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-ink-900 font-extrabold">
                <td className="px-3 py-2" colSpan={3}>합계</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.totalAmount)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <footer className="mt-8 text-center text-[13px] leading-relaxed">
        <p>「소득세법」 제34조, 「조세특례제한법」 제76조·제88조의4 및 「법인세법」 제24조에 따른 기부금을 위와 같이 기부하였음을 증명하여 주시기 바랍니다.</p>
        <p className="mt-3">{ymd(r.issuedAt)}</p>
        <p className="mt-1">신청인 <strong>{donor.name}</strong></p>
        <p className="mt-5">위와 같이 기부금을 기부받았음을 증명합니다.</p>
        <p className="mt-3">{ymd(r.issuedAt)}</p>
        <p className="mt-1 text-[15px] font-black">{issuer.name} 대표자 {issuer.representativeName ?? ''} (인)</p>
        <p className="mt-6 text-[11px] text-ink-400">
          현물 기부금은 기부 당시 기관과 기부자가 협의해 확정한 가액이며, 검수에서 합격한 수량만 포함합니다. 무효 처리된 영수증은 효력이 없습니다.
        </p>
      </footer>
    </article>
  );
}
