import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { formatWon } from '@/lib/money';
import { IMPACT_STATUS_LABEL, listImpactUpdates } from '@/server/services/impact-reports';
import { ImpactForm } from '@/components/studio/impact/impact-form';

export const dynamic = 'force-dynamic';

/**
 * 사업 진행·결과 보고 (2026-11-09 3차 H1). 진행 기록 → 집행 내역 → 보고서 초안(AI·규칙) → 담당자 승인 → 승인 대기함 확인 후 발송.
 */
export default async function ImpactListPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const showArchived = sp.archived === '1';
  const [rows, campaigns] = await Promise.all([
    listImpactUpdates(merchantId, { includeArchived: showArchived }),
    prisma.campaign.findMany({ where: { merchantId, status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'desc' }, select: { id: true, title: true } }),
  ]);
  return (
    <>
      <PageHeader title="사업 진행·결과 보고" description="캠페인(또는 기관 일반 후원)의 진행 기록과 집행 내역을 남기고, 승인한 결과 보고를 함께한 후원자에게 보냅니다." />
      <div className="mb-4">
        <Notice tone="neutral" title="결과 보고는 캠페인 전체 결과입니다">
          한 분 한 분의 후원금이 어디에 쓰였는지 따로 만들지 않습니다. 후원자에게는 캠페인 전체 결과와 본인이 함께한 후원 횟수·합계를 나눠 보여 드립니다. 보고는 정보성 안내라 후원 권유 문구·후원 링크를 넣지 않습니다.
        </Notice>
      </div>
      <Card className="mb-5">
        <CardTitle>새 진행 기록</CardTitle>
        <div className="mt-3">
          <ImpactForm campaigns={campaigns} />
        </div>
      </Card>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>진행 기록</CardTitle>
          <Link href={showArchived ? '/studio/impact' : '/studio/impact?archived=1'} className="text-[12.5px] font-semibold text-brand-700 hover:underline">
            {showArchived ? '보관한 기록 숨기기' : '보관한 기록도 보기'}
          </Link>
        </div>
        {rows.length === 0 ? (
          <div className="mt-3"><EmptyState title="아직 진행 기록이 없습니다" description="위에서 첫 진행 기록을 만들어 보세요." /></div>
        ) : (
          <ul className="mt-3 divide-y divide-ink-100">
            {rows.map((r) => {
              const st = IMPACT_STATUS_LABEL[r.status] ?? { text: r.status, tone: 'neutral' as const };
              return (
                <li key={r.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={st.tone}>{st.text}</Badge>
                      {r.archivedAt ? <Badge tone="neutral">보관됨</Badge> : null}
                      {r.publicVisible ? <Badge tone="success">후원페이지 공개</Badge> : null}
                      <span className="text-[12px] text-ink-400">{r.campaignTitle}</span>
                    </div>
                    <Link href={`/studio/impact/${r.id}`} className="mt-1 block break-keep text-[14px] font-bold text-ink-900 hover:underline">{r.title}</Link>
                  </div>
                  <p className="shrink-0 text-[12.5px] text-ink-500">집행 {formatWon(r.expenseTotal)} · {formatKst(r.createdAt, false)}</p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
