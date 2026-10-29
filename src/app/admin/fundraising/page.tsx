import Link from 'next/link';
import { requireAdmin } from '@/server/auth';
import { prisma } from '@/server/db';
import { campaignStats } from '@/server/services/fundraising';
import { recurringStatusLabel, recurringDebitAllowed } from '@/server/services/recurring';
import { issuerReadiness, receiptStatusLabel } from '@/server/services/receipts';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { ProgressBar } from '@/components/public/progress-bar';
import { campaignProgress, campaignStatusLabel } from '@/lib/fundraising';
import { PAID_STATUSES } from '@/components/studio/shared';
import { formatKst } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'campaigns', label: '캠페인' },
  { key: 'recurring', label: '정기후원' },
  { key: 'receipts', label: '기부금영수증' },
  { key: 'orgs', label: '기관 준비 상태' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/**
 * 모금 현황 (통합 관리자).
 * 기관 전체의 캠페인·정기후원·영수증 발급 상태를 한곳에서 본다. 설정은 각 기관 담당자가 한다.
 */
export default async function AdminFundraisingPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : 'campaigns';

  const [campaignCount, activeCampaigns, recurringAgg, receiptAgg, orgs] = await Promise.all([
    prisma.campaign.count({ where: { status: { not: 'ARCHIVED' } } }),
    prisma.campaign.count({ where: { status: 'ACTIVE' } }),
    prisma.recurringDonation.aggregate({ where: { status: 'ACTIVE' }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.donationReceipt.aggregate({ where: { status: 'ISSUED', taxYear: new Date().getFullYear() }, _count: { _all: true }, _sum: { totalAmount: true } }),
    prisma.merchantProfile.findMany({ where: { status: 'APPROVED' }, orderBy: { createdAt: 'desc' }, take: 200, include: { donationPage: { select: { published: true } } } }),
  ]);

  return (
    <>
      <PageHeader title="모금 현황" description="기관 전체의 캠페인·정기후원·기부금영수증 상태입니다. 설정과 발급은 각 기관 담당자가 기관 콘솔에서 합니다." />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="모금 중 캠페인" value={`${formatNumber(activeCampaigns)}개`} sub={`전체 ${formatNumber(campaignCount)}개`} tone="brand" />
        <StatTile label="진행 중 정기후원" value={`${formatNumber(recurringAgg._count._all)}건`} sub={`월 ${formatWon(recurringAgg._sum.amount ?? 0n)}`} />
        <StatTile label={`${new Date().getFullYear()}년 발급 영수증`} value={`${formatNumber(receiptAgg._count._all)}장`} sub={formatWon(receiptAgg._sum.totalAmount ?? 0n)} />
        <StatTile label="승인 기관" value={`${formatNumber(orgs.length)}곳`} sub={`후원페이지 공개 ${orgs.filter((o) => o.donationPage?.published).length}곳`} />
      </div>

      <div className="mb-4 flex gap-1 rounded-2xl bg-ink-100 p-1 text-[13px] font-bold">
        {TABS.map((t) => (
          <Link key={t.key} href={`/admin/fundraising?tab=${t.key}`} className={t.key === tab ? 'flex-1 rounded-xl bg-white px-3 py-2 text-center text-ink-900 shadow-sm' : 'flex-1 rounded-xl px-3 py-2 text-center text-ink-500'}>{t.label}</Link>
        ))}
      </div>

      {tab === 'campaigns' ? <CampaignsTab /> : null}
      {tab === 'recurring' ? <RecurringTab /> : null}
      {tab === 'receipts' ? <ReceiptsTab /> : null}
      {tab === 'orgs' ? <OrgsTab orgs={orgs} /> : null}
    </>
  );
}

async function CampaignsTab() {
  const rows = await prisma.campaign.findMany({
    where: { status: { in: ['ACTIVE', 'CLOSED', 'DRAFT'] } },
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    take: 200,
    include: { merchant: { select: { displayName: true, code: true } } },
  });
  const stats = await campaignStats(rows.map((r) => r.id));
  if (rows.length === 0) return <EmptyState title="등록된 캠페인이 없습니다" />;
  return (
    <Table>
      <thead>
        <tr><Th>기관</Th><Th>캠페인</Th><Th>키워드</Th><Th>상태</Th><Th>모금액 / 목표</Th><Th>후원</Th><Th>기간</Th></tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const s = stats.get(c.id)!;
          const p = campaignProgress(s.raised, c.goalAmount);
          return (
            <tr key={c.id}>
              <Td><span className="font-semibold text-ink-900">{c.merchant.displayName}</span> <span className="font-mono text-[11px] text-ink-400">{c.merchant.code}</span></Td>
              <Td><Link href={`/donate/${c.merchant.code}/campaigns/${c.id}`} target="_blank" className="font-semibold text-ink-900 hover:underline">{c.title}</Link></Td>
              <Td className="font-mono">{c.code}</Td>
              <Td><Badge tone={campaignStatusLabel[c.status].tone}>{campaignStatusLabel[c.status].text}</Badge></Td>
              <Td className="min-w-[180px]"><span className="tabular-nums">{formatWon(s.raised)} / {formatWon(c.goalAmount)} ({p.percent}%)</span><ProgressBar percent={p.capped} className="mt-1" height="h-1.5" /></Td>
              <Td className="tabular-nums">{s.chargeCount}건 · {s.donorCount}명</Td>
              <Td className="whitespace-nowrap tabular-nums text-[12px]">{c.startsOn.toISOString().slice(0, 10)} ~ {c.endsOn.toISOString().slice(0, 10)}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

async function RecurringTab() {
  const [rows, failed] = await Promise.all([
    prisma.recurringDonation.findMany({
      where: { status: { in: ['ACTIVE', 'PAUSED', 'SUSPENDED'] } },
      orderBy: [{ status: 'desc' }, { nextChargeOn: 'asc' }],
      take: 300,
      include: { merchant: { select: { displayName: true } }, payer: { select: { displayName: true, phoneMasked: true } } },
    }),
    prisma.recurringRun.findMany({ where: { status: 'FAILED' }, orderBy: { ranAt: 'desc' }, take: 20, include: { recurring: { include: { merchant: { select: { displayName: true } } } } } }),
  ]);
  return (
    <div className="space-y-5">
      {!recurringDebitAllowed() ? (
        <Notice tone="warning" title="실결제사 자동 출금 미승인">ALLOW_RECURRING_DEBIT 가 꺼져 있어 배치가 약정을 건너뜁니다(SKIPPED). 금융사 승인 후 운영 환경변수로 켜 주세요. mock 결제사에서는 정상 실행됩니다.</Notice>
      ) : null}
      {rows.length === 0 ? <EmptyState title="정기후원 약정이 없습니다" /> : (
        <Table>
          <thead><tr><Th>기관</Th><Th>후원자</Th><Th>상태</Th><Th>금액</Th><Th>출금일</Th><Th>다음 출금</Th><Th>누적</Th><Th>실패</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="font-semibold text-ink-900">{r.merchant.displayName}</Td>
                <Td>{r.payer.displayName} <span className="font-mono text-[11px] text-ink-400">{r.payer.phoneMasked}</span></Td>
                <Td><Badge tone={recurringStatusLabel[r.status].tone}>{recurringStatusLabel[r.status].text}</Badge></Td>
                <Td className="tabular-nums">{formatWon(r.amount)}</Td>
                <Td>{r.dayOfMonth}일</Td>
                <Td className="tabular-nums">{r.status === 'ACTIVE' ? r.nextChargeOn.toISOString().slice(0, 10) : '-'}</Td>
                <Td className="tabular-nums">{formatWon(r.totalAmount)} ({r.successCount}회)</Td>
                <Td className="text-[12px] text-ink-500">{r.failCount ? `${r.failCount}회 · ${r.lastFailure ?? ''}` : '-'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {failed.length ? (
        <Card>
          <p className="mb-2 text-[13px] font-extrabold text-ink-900">최근 출금 실패</p>
          <ul className="divide-y divide-ink-100 text-[12.5px]">
            {failed.map((f) => (
              <li key={f.id} className="flex flex-wrap justify-between gap-2 py-1.5"><span>{formatKst(f.ranAt)} · {f.recurring.merchant.displayName} · {f.monthKey} {f.attempt}차</span><span className="text-danger-500">{f.reason}</span></li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

async function ReceiptsTab() {
  const year = new Date().getFullYear();
  const [byOrg, recent, exportsRecent] = await Promise.all([
    prisma.donationReceipt.groupBy({ by: ['merchantId', 'status'], where: { taxYear: year }, _count: { _all: true }, _sum: { totalAmount: true } }),
    prisma.donationReceipt.findMany({ orderBy: { issuedAt: 'desc' }, take: 50, include: { merchant: { select: { displayName: true } } } }),
    prisma.receiptExport.findMany({ orderBy: { createdAt: 'desc' }, take: 20, include: { merchant: { select: { displayName: true } } } }),
  ]);
  const merchantIds = [...new Set(byOrg.map((b) => b.merchantId))];
  const merchants = await prisma.merchantProfile.findMany({ where: { id: { in: merchantIds } }, select: { id: true, displayName: true, code: true } });
  const mm = new Map(merchants.map((m) => [m.id, m]));
  const perOrg = merchantIds.map((id) => {
    const issued = byOrg.find((b) => b.merchantId === id && b.status === 'ISSUED');
    const voided = byOrg.find((b) => b.merchantId === id && b.status === 'VOID');
    return { id, name: mm.get(id)?.displayName ?? id, code: mm.get(id)?.code ?? '', issued: issued?._count._all ?? 0, amount: issued?._sum.totalAmount ?? 0n, voided: voided?._count._all ?? 0 };
  });
  return (
    <div className="space-y-5">
      <Notice tone="neutral">기브싸인은 영수증 발급과 홈택스 제출 파일 생성까지만 담당합니다. 국세청 전송은 기관이 홈택스에서 직접 하며, 생성 이력에 체크섬이 남습니다.</Notice>
      <Card>
        <p className="mb-2 text-[13px] font-extrabold text-ink-900">{year}년 기관별 발급</p>
        {perOrg.length === 0 ? <p className="text-[13px] text-ink-400">발급된 영수증이 없습니다.</p> : (
          <Table>
            <thead><tr><Th>기관</Th><Th>발급</Th><Th>합계</Th><Th>무효</Th></tr></thead>
            <tbody>{perOrg.map((o) => <tr key={o.id}><Td className="font-semibold text-ink-900">{o.name} <span className="font-mono text-[11px] text-ink-400">{o.code}</span></Td><Td>{o.issued}장</Td><Td className="tabular-nums">{formatWon(o.amount)}</Td><Td>{o.voided}장</Td></tr>)}</tbody>
          </Table>
        )}
      </Card>
      <Card>
        <p className="mb-2 text-[13px] font-extrabold text-ink-900">최근 발급</p>
        <Table>
          <thead><tr><Th>발급번호</Th><Th>기관</Th><Th>귀속</Th><Th>금액</Th><Th>상태</Th><Th>발급일</Th></tr></thead>
          <tbody>{recent.map((r) => <tr key={r.id}><Td className="font-mono">{r.receiptNo}</Td><Td>{r.merchant.displayName}</Td><Td>{r.taxYear}</Td><Td className="tabular-nums">{formatWon(r.totalAmount)}</Td><Td><Badge tone={receiptStatusLabel[r.status].tone}>{receiptStatusLabel[r.status].text}</Badge></Td><Td className="whitespace-nowrap tabular-nums">{formatKst(r.issuedAt, false)}</Td></tr>)}</tbody>
        </Table>
      </Card>
      {exportsRecent.length ? (
        <Card>
          <p className="mb-2 text-[13px] font-extrabold text-ink-900">홈택스 명세 생성 이력</p>
          <ul className="divide-y divide-ink-100 text-[12.5px]">{exportsRecent.map((e) => <li key={e.id} className="flex flex-wrap gap-x-3 py-1.5"><span className="tabular-nums">{formatKst(e.createdAt)}</span><span>{e.merchant.displayName}</span><span>{e.taxYear}년 · {e.rowCount}건 · {formatWon(e.totalAmount)}</span><span className="font-mono text-ink-400">{e.checksum.slice(0, 16)}…</span></li>)}</ul>
        </Card>
      ) : null}
    </div>
  );
}

async function OrgsTab({ orgs }: { orgs: Array<Awaited<ReturnType<typeof prisma.merchantProfile.findMany<{ include: { donationPage: { select: { published: true } } } }>>>[number]> }) {
  const ids = orgs.map((o) => o.id);
  const [mo, raised] = await Promise.all([
    prisma.merchantMoNumber.groupBy({ by: ['merchantId'], where: { merchantId: { in: ids }, status: 'ASSIGNED' }, _count: { _all: true } }),
    prisma.charge.groupBy({ by: ['merchantId'], where: { merchantId: { in: ids }, status: { in: PAID_STATUSES }, isTest: false }, _sum: { amount: true } }),
  ]);
  const moMap = new Map(mo.map((m) => [m.merchantId, m._count._all]));
  const raisedMap = new Map(raised.map((r) => [r.merchantId, r._sum.amount ?? 0n]));
  return (
    <Table>
      <thead><tr><Th>기관</Th><Th>유형</Th><Th>MO 번호</Th><Th>후원페이지</Th><Th>영수증 발급 준비</Th><Th>모집등록</Th><Th>누적 후원</Th></tr></thead>
      <tbody>
        {orgs.map((o) => {
          const r = issuerReadiness(o);
          return (
            <tr key={o.id}>
              <Td><Link href={`/admin/merchants?q=${encodeURIComponent(o.code)}`} className="font-semibold text-ink-900 hover:underline">{o.displayName}</Link> <span className="font-mono text-[11px] text-ink-400">{o.code}</span></Td>
              <Td>{o.orgType ?? <span className="text-ink-300">-</span>}</Td>
              <Td>{moMap.get(o.id) ? <Badge tone="success">{moMap.get(o.id)}개</Badge> : <Badge tone="warning">미배정</Badge>}</Td>
              <Td>{o.donationPage?.published ? <Badge tone="success">공개</Badge> : <span className="text-ink-400">비공개</span>}</Td>
              <Td>{r.ok ? <Badge tone="success">준비됨</Badge> : <span className="text-[12px] text-ink-500">{r.missing.join(' · ')}</span>}</Td>
              <Td>{o.fundraisingRegNo ?? <span className="text-ink-300">-</span>}</Td>
              <Td className="tabular-nums">{formatWon(raisedMap.get(o.id) ?? 0n)}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
