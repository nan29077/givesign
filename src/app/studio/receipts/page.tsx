import Link from 'next/link';
import { Download } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Input, Notice, SectionTitle, Select, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionForm, InlineActionForm } from '@/components/studio/action-form';
import { issueReceiptAction, issueReceiptsBulkAction, reissueReceiptAction, voidReceiptAction } from '@/app/actions/fundraising';
import { issuerReadiness, receiptCandidates, receiptStatusLabel, DONATION_CODES } from '@/server/services/receipts';
import { formatKst } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { displayPayerName } from '@/lib/payer-name';

export const dynamic = 'force-dynamic';

/**
 * 기부금영수증 (기관).
 *
 * 흐름: 기관 정보 준비 → 후원자가 영수증 정보 등록(마이페이지) → 연도별 발급(건별·일괄)
 *      → 홈택스 제출 명세 파일 내려받기 → 기관이 홈택스에서 직접 제출.
 * 전산 전송은 하지 않는다(절대 규칙 2). 주민등록번호는 어떤 화면에도 원문을 표시하지 않는다.
 */
export default async function StudioReceiptsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const nowYear = new Date().getFullYear();
  const years = Array.from({ length: Math.min(5, nowYear - 2025 + 1) }, (_, i) => nowYear - i);
  const year = years.includes(Number(sp.year)) ? Number(sp.year) : nowYear;

  const [merchant, candidates, issued, exports] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId } }),
    receiptCandidates(merchantId, year),
    prisma.donationReceipt.findMany({
      where: { merchantId, taxYear: year },
      orderBy: { seq: 'desc' },
      take: 300,
      include: { payer: { select: { displayName: true, phoneMasked: true } } },
    }),
    prisma.receiptExport.findMany({ where: { merchantId, taxYear: year }, orderBy: { createdAt: 'desc' }, take: 5 }),
  ]);
  const readiness = issuerReadiness(merchant);
  const ready = candidates.filter((c) => c.ready);
  const notReady = candidates.filter((c) => !c.ready);
  const issuedValid = issued.filter((r) => r.status === 'ISSUED');
  const issuedTotal = issuedValid.reduce((s, r) => s + r.totalAmount, 0n);

  return (
    <>
      <PageHeader
        title="기부금영수증"
        description="연말정산용 기부금영수증을 발급하고 국세청 제출 명세를 준비합니다. 발급은 결제 성공 건만 합산하며 환불된 건은 자동으로 제외됩니다."
        action={
          <form method="get" className="flex items-center gap-2">
            <Select name="year" defaultValue={String(year)} className="h-11 w-[130px]">
              {years.map((y) => <option key={y} value={y}>{y}년 귀속</option>)}
            </Select>
            <button className="h-11 rounded-xl bg-ink-900 px-4 text-[14px] font-extrabold text-white">조회</button>
          </form>
        }
      />

      {!readiness.ok ? (
        <div className="mb-5">
          <Notice tone="warning" title="영수증을 발급하려면 기관 정보가 먼저 필요합니다">
            부족한 항목: {readiness.missing.join(' · ')} — <Link href="/studio/profile" className="font-bold underline">기관 정보</Link>에서 입력하세요.
          </Notice>
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={`${year}년 발급 영수증`} value={`${formatNumber(issuedValid.length)}장`} tone="brand" sub={`합계 ${formatWon(issuedTotal)}`} />
        <StatTile label="발급 가능(정보 등록)" value={`${formatNumber(ready.length)}명`} sub={`합계 ${formatWon(ready.reduce((s, c) => s + c.amount, 0n))}`} />
        <StatTile label="정보 미등록 후원자" value={`${formatNumber(notReady.length)}명`} sub="후원자가 마이페이지에서 등록" tone={notReady.length ? 'warning' : 'neutral'} />
        <StatTile label="무효 처리" value={`${formatNumber(issued.length - issuedValid.length)}장`} sub="환불·정정" />
      </div>

      <section className="mb-6">
        <SectionTitle title="발급 대기" description="결제 성공 건 중 아직 영수증에 포함되지 않은 금액입니다. 후원자가 영수증 정보를 등록해야 발급할 수 있습니다." />
        {candidates.length === 0 ? (
          <EmptyState title={`${year}년에 발급 대기 중인 후원이 없습니다`} />
        ) : (
          <>
            {ready.length > 0 && readiness.ok ? (
              <div className="mb-3 flex justify-end">
                <InlineActionForm
                  action={issueReceiptsBulkAction}
                  submitLabel={`정보 등록 후원자 ${ready.length}명 일괄 발급`}
                  variant="primary"
                  fields={{ taxYear: String(year) }}
                  confirmMessage={`${year}년 귀속 영수증을 ${ready.length}명에게 일괄 발급하고 안내 문자를 보냅니다. 발급 번호는 되돌릴 수 없습니다. 진행할까요?`}
                />
              </div>
            ) : null}
            <Table>
              <thead>
                <tr>
                  <Th>후원자</Th>
                  <Th>영수증 성명</Th>
                  <Th>미발급 금액</Th>
                  <Th>건수</Th>
                  <Th>간소화 제출</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.payerId}>
                    <Td>
                      <span className="font-semibold text-ink-900">{displayPayerName(c.displayName)}</span>
                      <span className="ml-2 font-mono text-[12px] text-ink-400">{c.phoneMasked}</span>
                    </Td>
                    <Td>{c.ready ? c.legalName : <Badge tone="warning">정보 미등록</Badge>}</Td>
                    <Td className="font-semibold tabular-nums">{formatWon(c.amount)}</Td>
                    <Td className="tabular-nums">{c.count}건</Td>
                    <Td>{c.ready ? (c.hometaxOptIn ? <Badge tone="success">동의</Badge> : <Badge tone="neutral">종이만</Badge>) : '-'}</Td>
                    <Td>
                      {c.ready && readiness.ok ? (
                        <InlineActionForm action={issueReceiptAction} submitLabel="발급" variant="secondary" fields={{ taxYear: String(year), payerId: c.payerId }} confirmMessage={`${c.legalName} 님에게 ${year}년 귀속 영수증(${formatWon(c.amount)})을 발급할까요?`} />
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </section>

      <section className="mb-6">
        <SectionTitle title="발급 대장" description="발급 번호는 기관·연도별 일련번호입니다. 환불이 승인되면 해당 영수증은 자동으로 무효 처리되고, 남은 건으로 재발급할 수 있습니다." />
        {issued.length === 0 ? (
          <EmptyState title="발급된 영수증이 없습니다" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>발급번호</Th>
                <Th>상태</Th>
                <Th>후원자</Th>
                <Th>금액</Th>
                <Th>건수</Th>
                <Th>코드</Th>
                <Th>발급일</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {issued.map((r) => {
                const donor = r.donorSnapshot as { legalName?: string };
                return (
                  <tr key={r.id}>
                    <Td className="font-mono font-semibold text-ink-900">{r.receiptNo}</Td>
                    <Td>
                      <Badge tone={receiptStatusLabel[r.status].tone}>{receiptStatusLabel[r.status].text}</Badge>
                      {r.voidReason ? <span className="ml-1 block max-w-[180px] truncate text-[11px] text-ink-400" title={r.voidReason}>{r.voidReason}</span> : null}
                    </Td>
                    <Td>
                      {donor.legalName ?? displayPayerName(r.payer.displayName ?? '')}
                      <span className="ml-2 font-mono text-[12px] text-ink-400">{r.payer.phoneMasked}</span>
                    </Td>
                    <Td className="font-semibold tabular-nums">{formatWon(r.totalAmount)}</Td>
                    <Td className="tabular-nums">{r.chargeCount}건</Td>
                    <Td><span title={DONATION_CODES[r.donationCode]}>{r.donationCode}</span></Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(r.issuedAt, false)}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1.5">
                        <Link href={`/studio/receipts/${r.id}`} className="inline-flex h-9 items-center rounded-xl border border-ink-200 bg-white px-3 text-[12.5px] font-extrabold text-ink-900">보기</Link>
                        {r.status === 'ISSUED' ? (
                          <ActionForm action={voidReceiptAction} submitLabel="무효" variant="ghost" size="sm" confirmMessage="영수증을 무효 처리합니다. 포함된 후원 건은 다시 발급 대기로 돌아갑니다." className="flex items-center gap-1.5 space-y-0">
                            <input type="hidden" name="receiptId" value={r.id} />
                            <Input name="reason" placeholder="사유" className="h-9 w-[120px] text-[12px]" required />
                          </ActionForm>
                        ) : !r.supersededById ? (
                          <InlineActionForm action={reissueReceiptAction} submitLabel="재발급" variant="secondary" fields={{ receiptId: r.id }} confirmMessage="남은 유효 후원 건으로 새 번호의 영수증을 발급합니다." />
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>

      <section>
        <SectionTitle title="국세청(홈택스) 제출 명세" description="발급 영수증을 연말정산 간소화 제출용 CSV 로 내려받습니다. 전송은 기관이 홈택스에서 직접 하며, 제출 전 홈택스 변환·검증 프로그램으로 확인하세요." />
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[13px] text-ink-600">
              <p>파일에는 <strong>주민등록번호 원문</strong>이 포함됩니다. 생성 때마다 이력과 감사로그가 남고, 간소화 제출에 동의하지 않은 후원자는 제외됩니다.</p>
              <p className="mt-1 text-ink-400">포함 대상: {year}년 귀속 · 발급 상태 영수증 {formatNumber(issuedValid.length)}장</p>
            </div>
            {issuedValid.length > 0 ? (
              <a href={`/api/studio/receipts/export?year=${year}`} className="inline-flex h-11 items-center gap-2 rounded-xl bg-ink-900 px-4 text-[14px] font-extrabold text-white">
                <Download size={16} strokeWidth={1.7} /> {year}년 명세 CSV 내려받기
              </a>
            ) : null}
          </div>
          {exports.length ? (
            <div className="mt-4 border-t border-ink-100 pt-3">
              <p className="mb-1 text-[12px] font-bold text-ink-500">최근 생성 이력</p>
              <ul className="space-y-1 text-[12px] text-ink-500">
                {exports.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-x-3">
                    <span className="tabular-nums">{formatKst(e.createdAt)}</span>
                    <span className="font-mono">{e.fileName}</span>
                    <span>{e.rowCount}건 · {formatWon(e.totalAmount)}</span>
                    <span className="font-mono text-ink-300">sha256 {e.checksum.slice(0, 12)}…</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      </section>
    </>
  );
}
