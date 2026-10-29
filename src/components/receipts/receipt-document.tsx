import { formatNumber } from '@/lib/money';
import { DONATION_CODES } from '@/lib/receipt-codes';
import type { DonationReceipt } from '@/generated/prisma/client';

/**
 * 기부금영수증 서식 (소득세법 시행규칙 별지 제45호의2 서식을 기준으로 한 화면·인쇄용).
 *
 * 발급 당시 스냅샷(donorSnapshot · issuerSnapshot · items)만으로 그린다.
 * 나중에 기관 정보나 후원자 정보가 바뀌어도 발급본은 변하지 않는다.
 * 주민등록번호는 마스킹 값만 인쇄한다 — 원문이 필요하면 기관이 보관 중인 명세를 쓴다.
 */
interface Donor { legalName?: string; residentNoMasked?: string; address?: string | null }
interface Issuer { name?: string; businessNo?: string | null; representativeName?: string | null; address?: string | null; orgType?: string | null }
interface Item { transactionNo: string; paidAt: string; amount: string }

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

export function ReceiptDocument({ receipt: r }: { receipt: DonationReceipt }) {
  const donor = r.donorSnapshot as Donor;
  const issuer = r.issuerSnapshot as Issuer;
  const items = (r.items as unknown as Item[]) ?? [];
  const kst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const issuedKst = new Date(r.issuedAt.getTime() + 9 * 3600000).toISOString().slice(0, 10);

  return (
    <article className="receipt-doc mx-auto max-w-[760px] rounded-2xl border border-ink-200 bg-white p-6 text-ink-900 shadow-sm print:border-0 print:shadow-none sm:p-10">
      {r.status === 'VOID' ? (
        <p className="mb-4 rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2 text-center text-[13px] font-extrabold text-danger-500">
          무효 처리된 영수증입니다{r.voidReason ? ` — ${r.voidReason}` : ''}
        </p>
      ) : null}
      <header className="border-b-2 border-ink-900 pb-4 text-center">
        <h1 className="text-[24px] font-black tracking-[0.3em]">기부금영수증</h1>
        <p className="mt-1 text-[12px] text-ink-500">발급번호 <span className="font-mono">{r.receiptNo}</span> · 귀속연도 {r.taxYear}년</p>
      </header>

      <section className="mt-5">
        <h2 className="mb-2 text-[13px] font-extrabold">1. 기부자</h2>
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-ink-50 p-4">
          <Cell label="성명">{donor.legalName ?? '-'}</Cell>
          <Cell label="주민등록번호">{donor.residentNoMasked ?? '-'}</Cell>
          <Cell label="주소" span={2}>{donor.address || '-'}</Cell>
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
        <h2 className="mb-2 text-[13px] font-extrabold">3. 기부내용</h2>
        <div className="overflow-x-auto rounded-xl border border-ink-200">
          <table className="w-full text-[13px]">
            <thead className="bg-ink-50 text-[11.5px] text-ink-500">
              <tr>
                <th className="px-3 py-2 text-left">코드</th>
                <th className="px-3 py-2 text-left">구분</th>
                <th className="px-3 py-2 text-left">기부일자</th>
                <th className="px-3 py-2 text-left">내용</th>
                <th className="px-3 py-2 text-right">금액(원)</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.transactionNo} className="border-t border-ink-100">
                  <td className="px-3 py-2 tabular-nums">{r.donationCode}</td>
                  <td className="px-3 py-2">{DONATION_CODES[r.donationCode] ?? ''}</td>
                  <td className="px-3 py-2 tabular-nums">{kst(it.paidAt)}</td>
                  <td className="px-3 py-2">금전 (문자후원 <span className="font-mono text-[11px]">{it.transactionNo}</span>)</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(BigInt(it.amount))}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-ink-900 font-extrabold">
                <td className="px-3 py-2" colSpan={3}>합계</td>
                <td className="px-3 py-2">{r.chargeCount}건</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.totalAmount)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <footer className="mt-8 text-center text-[13px] leading-relaxed">
        <p>「소득세법」 제34조, 「조세특례제한법」 제76조·제88조의4 및 「법인세법」 제24조에 따른 기부금을 위와 같이 기부하였음을 증명하여 주시기 바랍니다.</p>
        <p className="mt-3">{issuedKst}</p>
        <p className="mt-1">신청인 <strong>{donor.legalName}</strong></p>
        <p className="mt-5">위와 같이 기부금을 기부받았음을 증명합니다.</p>
        <p className="mt-3">{issuedKst}</p>
        <p className="mt-1 text-[15px] font-black">{issuer.name} 대표자 {issuer.representativeName ?? ''} (인)</p>
        <p className="mt-6 text-[11px] text-ink-400">
          이 영수증은 기브싸인(GIVESIGN) 문자후원 시스템에서 발급되었습니다. 발급번호로 진위를 확인할 수 있으며, 무효 처리된 영수증은 효력이 없습니다.
        </p>
      </footer>
    </article>
  );
}
