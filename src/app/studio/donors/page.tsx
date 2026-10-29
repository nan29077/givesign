import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Input, Select, StatTile, Table, Td, Th } from '@/components/ui';
import { PAID_STATUSES } from '@/components/studio/shared';
import { addDays, formatKst, kstStartOfDay } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { displayPayerName } from '@/lib/payer-name';

export const dynamic = 'force-dynamic';

const SORTS = ['recent', 'amount', 'count'] as const;
type Sort = (typeof SORTS)[number];

/**
 * 후원자 관리.
 *
 * 기관이 보는 후원자 정보는 표시 이름 · 마스킹 번호 · 누적 · 최근 후원 · 정기후원 여부 · 영수증 정보 등록 여부까지다.
 * 전화번호 원문과 주민등록번호는 어떤 화면에서도 보여 주지 않는다.
 */
export default async function StudioDonorsPage({ searchParams }: { searchParams: Promise<{ q?: string; sort?: string; filter?: string }> }) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const sort: Sort = SORTS.includes(sp.sort as Sort) ? (sp.sort as Sort) : 'recent';
  const filter = sp.filter === 'recurring' || sp.filter === 'lapsed' || sp.filter === 'receipt' ? sp.filter : 'all';

  // 누적은 결제 성공 건 집계로 계산한다(payer_merchant_link 의 totalAmount 는 환불 전 값이 남을 수 있다).
  const sums = await prisma.charge.groupBy({
    by: ['payerId'],
    where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, payerId: { not: null } },
    _sum: { amount: true },
    _count: { _all: true },
    _max: { paidAt: true },
    _min: { paidAt: true },
  });
  const payerIds = sums.map((s) => s.payerId!).filter(Boolean);
  const [payers, recurring, profiles] = await Promise.all([
    prisma.payerProfile.findMany({ where: { id: { in: payerIds } }, select: { id: true, displayName: true, phoneMasked: true } }),
    prisma.recurringDonation.findMany({ where: { merchantId, payerId: { in: payerIds }, status: { in: ['ACTIVE', 'PAUSED', 'SUSPENDED'] } }, select: { payerId: true, status: true, amount: true, dayOfMonth: true } }),
    prisma.payerReceiptProfile.findMany({ where: { payerId: { in: payerIds } }, select: { payerId: true } }),
  ]);
  const pm = new Map(payers.map((p) => [p.id, p]));
  const rm = new Map(recurring.map((r) => [r.payerId, r]));
  const receiptReady = new Set(profiles.map((p) => p.payerId));
  const ninetyDaysAgo = addDays(kstStartOfDay(), -90).getTime();

  let rows = sums.map((s) => {
    const p = pm.get(s.payerId!);
    const r = rm.get(s.payerId!);
    return {
      payerId: s.payerId!,
      name: displayPayerName(p?.displayName ?? ''),
      phoneMasked: p?.phoneMasked ?? '',
      total: s._sum.amount ?? 0n,
      count: s._count._all,
      last: s._max.paidAt,
      first: s._min.paidAt,
      recurring: r ?? null,
      receiptReady: receiptReady.has(s.payerId!),
      lapsed: (s._max.paidAt?.getTime() ?? 0) < ninetyDaysAgo && !r,
    };
  });
  if (q) rows = rows.filter((r) => r.name.includes(q) || r.phoneMasked.includes(q));
  if (filter === 'recurring') rows = rows.filter((r) => r.recurring);
  if (filter === 'lapsed') rows = rows.filter((r) => r.lapsed);
  if (filter === 'receipt') rows = rows.filter((r) => r.receiptReady);
  rows.sort((a, b) =>
    sort === 'amount' ? Number(b.total - a.total) : sort === 'count' ? b.count - a.count : (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0),
  );

  const totalDonors = sums.length;
  const recurringCount = recurring.filter((r) => r.status === 'ACTIVE').length;
  const lapsedCount = rows.length === sums.length ? rows.filter((r) => r.lapsed).length : sums.filter((s) => (s._max.paidAt?.getTime() ?? 0) < ninetyDaysAgo && !rm.has(s.payerId!)).length;

  return (
    <>
      <PageHeader title="후원자 관리" description="기관에 후원한 분들의 누적·최근 후원과 정기후원·영수증 준비 상태입니다. 전화번호 원문은 표시하지 않습니다." />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="전체 후원자" value={`${formatNumber(totalDonors)}명`} tone="brand" />
        <StatTile label="정기후원자" value={`${formatNumber(recurringCount)}명`} sub="진행 중 약정 기준" />
        <StatTile label="90일 이상 후원 없음" value={`${formatNumber(lapsedCount)}명`} sub="정기후원 제외" tone={lapsedCount ? 'warning' : 'neutral'} />
        <StatTile label="영수증 정보 등록" value={`${formatNumber(receiptReady.size)}명`} sub="기부금영수증 발급 가능" />
      </div>

      <Card className="mb-4">
        <form className="grid gap-3 sm:grid-cols-[1fr_180px_180px_auto]" method="get">
          <Input name="q" defaultValue={q} placeholder="이름 또는 번호 끝자리 검색" />
          <Select name="filter" defaultValue={filter}>
            <option value="all">전체</option>
            <option value="recurring">정기후원자</option>
            <option value="lapsed">90일 이상 후원 없음</option>
            <option value="receipt">영수증 정보 등록</option>
          </Select>
          <Select name="sort" defaultValue={sort}>
            <option value="recent">최근 후원순</option>
            <option value="amount">누적 금액순</option>
            <option value="count">후원 횟수순</option>
          </Select>
          <button className="h-12 rounded-xl bg-ink-900 px-5 text-[14px] font-extrabold text-white">조회</button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title="조건에 맞는 후원자가 없습니다" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>후원자</Th>
              <Th>누적</Th>
              <Th>횟수</Th>
              <Th>첫 후원</Th>
              <Th>최근 후원</Th>
              <Th>정기후원</Th>
              <Th>영수증</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.payerId}>
                <Td>
                  <span className="font-semibold text-ink-900">{r.name}</span>
                  <span className="ml-2 font-mono text-[12px] text-ink-400">{r.phoneMasked}</span>
                  {r.lapsed ? <Badge tone="warning" className="ml-2">휴면</Badge> : null}
                </Td>
                <Td className="font-semibold tabular-nums text-ink-900">{formatWon(r.total)}</Td>
                <Td className="tabular-nums">{formatNumber(r.count)}회</Td>
                <Td className="whitespace-nowrap tabular-nums">{formatKst(r.first, false)}</Td>
                <Td className="whitespace-nowrap tabular-nums">{formatKst(r.last, false)}</Td>
                <Td>
                  {r.recurring ? (
                    <Badge tone={r.recurring.status === 'ACTIVE' ? 'brand' : r.recurring.status === 'PAUSED' ? 'warning' : 'danger'}>
                      매월 {r.recurring.dayOfMonth}일 {formatWon(r.recurring.amount)}
                    </Badge>
                  ) : (
                    <span className="text-ink-300">-</span>
                  )}
                </Td>
                <Td>{r.receiptReady ? <Badge tone="success">정보 등록</Badge> : <span className="text-ink-300">미등록</span>}</Td>
                <Td>
                  <Link href={`/studio/charges?q=${encodeURIComponent(r.phoneMasked.slice(-4))}`} className="text-[12.5px] font-bold text-brand-700">후원 내역</Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
