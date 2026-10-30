import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { recurringStatusLabel, recurringDebitAllowed, recurringIsMock } from '@/server/services/recurring';
import { formatKst } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { displayPayerName } from '@/lib/payer-name';

export const dynamic = 'force-dynamic';

/**
 * 정기후원 현황(기관).
 * 약정의 변경·해지는 후원자 본인만 할 수 있다. 기관은 현황과 실패 건을 본다.
 */
export default async function StudioRecurringPage() {
  const { merchantId } = await requireMerchant();
  const rows = await prisma.recurringDonation.findMany({
    where: { merchantId },
    include: { payer: { select: { displayName: true, phoneMasked: true } }, campaign: { select: { title: true } } },
    orderBy: [{ status: 'asc' }, { nextChargeOn: 'asc' }],
    take: 500,
  });
  const active = rows.filter((r) => r.status === 'ACTIVE');
  const monthly = active.reduce((s, r) => s + r.amount, 0n);
  const suspended = rows.filter((r) => r.status === 'SUSPENDED').length;
  const recentRuns = await prisma.recurringRun.findMany({
    where: { recurring: { merchantId } },
    orderBy: { ranAt: 'desc' },
    take: 20,
    include: { recurring: { include: { payer: { select: { displayName: true } } } } },
  });

  return (
    <>
      <PageHeader title="정기후원" description="매월 자동 출금되는 약정 현황입니다. 금액·출금일 변경과 해지는 후원자가 마이페이지에서 직접 합니다." />

      {!recurringDebitAllowed() ? (
        <div className="mb-4">
          <Notice tone="warning" title="자동 출금이 아직 승인되지 않았습니다">
            실결제사에서 PIN 없이 빌키로 출금하려면 금융사 승인이 필요합니다. 승인 전에는 배치가 약정을 건너뛰고(SKIPPED) 출금하지 않습니다. 운영 환경변수 ALLOW_RECURRING_DEBIT=true 로 켭니다.
          </Notice>
        </div>
      ) : recurringIsMock() ? (
        <div className="mb-4">
          <Notice tone="neutral">현재 mock 결제사입니다. 실제 출금 없이 흐름만 재현합니다.</Notice>
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="진행 중 약정" value={`${formatNumber(active.length)}건`} tone="brand" />
        <StatTile label="월 예상 후원액" value={formatWon(monthly)} sub="진행 중 약정 합계" />
        <StatTile label="출금 실패로 정지" value={`${formatNumber(suspended)}건`} tone={suspended ? 'danger' : 'neutral'} />
        <StatTile label="누적 정기후원액" value={formatWon(rows.reduce((s, r) => s + r.totalAmount, 0n))} />
      </div>

      {rows.length === 0 ? (
        <EmptyState title="아직 정기후원 약정이 없습니다" description="후원페이지의 '매월 후원하기' 로 후원자가 약정을 등록할 수 있습니다." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>후원자</Th>
              <Th>상태</Th>
              <Th>금액</Th>
              <Th>출금일</Th>
              <Th>다음 출금</Th>
              <Th>캠페인</Th>
              <Th>누적</Th>
              <Th>최근 실패</Th>
              <Th>약정서</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = recurringStatusLabel[r.status];
              return (
                <tr key={r.id}>
                  <Td>
                    <span className="font-semibold text-ink-900">{displayPayerName(r.payer.displayName ?? '')}</span>
                    <span className="ml-2 font-mono text-[12px] text-ink-400">{r.payer.phoneMasked}</span>
                  </Td>
                  <Td><Badge tone={st.tone}>{st.text}</Badge></Td>
                  <Td className="font-semibold tabular-nums">{formatWon(r.amount)}</Td>
                  <Td>매월 {r.dayOfMonth}일</Td>
                  <Td className="tabular-nums">{r.status === 'ACTIVE' ? r.nextChargeOn.toISOString().slice(0, 10) : '-'}</Td>
                  <Td>{r.campaign?.title ?? <span className="text-ink-300">일반</span>}</Td>
                  <Td className="tabular-nums">{formatWon(r.totalAmount)} · {r.successCount}회</Td>
                  <Td className="text-[12px] text-ink-500"><span className="block max-w-[220px] truncate" title={r.lastFailure ?? ''}>{r.lastFailure ?? '-'}</span></Td>
                  <Td>{r.agreementDocId ? <Link href={`/studio/agreements/${r.agreementDocId}`} className="text-[12.5px] font-bold text-brand-700">열람</Link> : <span className="text-ink-300">-</span>}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {recentRuns.length ? (
        <section className="mt-6">
          <h2 className="mb-2 text-[14px] font-extrabold text-ink-900">최근 실행 기록</h2>
          <Table>
            <thead>
              <tr>
                <Th>실행 시각</Th>
                <Th>후원자</Th>
                <Th>월</Th>
                <Th>회차</Th>
                <Th>결과</Th>
                <Th>사유</Th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map((run) => (
                <tr key={run.id}>
                  <Td className="whitespace-nowrap tabular-nums">{formatKst(run.ranAt)}</Td>
                  <Td>{displayPayerName(run.recurring.payer.displayName ?? '')}</Td>
                  <Td>{run.monthKey}</Td>
                  <Td>{run.attempt}</Td>
                  <Td><Badge tone={run.status === 'SUCCESS' ? 'success' : run.status === 'FAILED' ? 'danger' : run.status === 'PENDING' ? 'warning' : 'neutral'}>{run.status === 'SUCCESS' ? '성공' : run.status === 'FAILED' ? '실패' : run.status === 'PENDING' ? '결과 확인 대기' : '건너뜀'}</Badge></Td>
                  <Td className="text-[12px] text-ink-500">{run.reason ?? '-'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}
    </>
  );
}
