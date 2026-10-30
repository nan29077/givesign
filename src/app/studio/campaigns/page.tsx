import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { listCampaigns } from '@/server/services/fundraising';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, LinkButton, Notice, StatTile } from '@/components/ui';
import { InlineActionForm } from '@/components/studio/action-form';
import { ProgressBar } from '@/components/public/progress-bar';
import { setCampaignStatusAction } from '@/app/actions/fundraising';
import { campaignProgress, campaignStatusLabel, daysLeft } from '@/lib/fundraising';
import { formatNumber, formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * 캠페인 목록.
 * 모금액은 결제 성공 건 집계값이라 환불이 반영된 실제 금액이다.
 */
export default async function StudioCampaignsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const showArchived = sp.archived === '1';
  const [rows, org, moCount] = await Promise.all([
    listCampaigns(merchantId, { includeArchived: showArchived }),
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { code: true } }),
    prisma.merchantMoNumber.count({ where: { merchantId, status: 'ASSIGNED' } }),
  ]);
  const active = rows.filter((r) => r.status === 'ACTIVE');
  const raisedActive = active.reduce((s, r) => s + r.stats.raised, 0n);
  const donorsActive = active.reduce((s, r) => s + r.stats.donorCount, 0);

  return (
    <>
      <PageHeader
        title="캠페인"
        description="목표액과 기간이 있는 모금 단위입니다. 후원자가 문자 맨 앞에 키워드를 적으면 그 캠페인의 지정후원으로 집계됩니다."
        action={<LinkButton href="/studio/campaigns/new">캠페인 만들기</LinkButton>}
      />

      {moCount === 0 ? (
        <div className="mb-4">
          <Notice tone="warning" title="배정된 MO 번호가 없습니다">
            문자 후원을 받으려면 관리자가 기관 전용 수신번호를 배정해야 합니다. 번호가 배정되기 전에는 캠페인을 만들어 둘 수만 있고 모금을 시작할 수 없습니다.
          </Notice>
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="모금 중 캠페인" value={`${active.length}개`} tone="brand" />
        <StatTile label="모금 중 누적 후원액" value={formatWon(raisedActive)} />
        <StatTile label="모금 중 후원자" value={`${formatNumber(donorsActive)}명`} />
        <StatTile label="전체 캠페인" value={`${rows.length}개`} sub={showArchived ? '보관 포함' : '보관 제외'} />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="등록된 캠페인이 없습니다"
          description="첫 캠페인을 만들어 보세요. 캠페인이 없어도 기관 일반 후원은 받을 수 있습니다."
          action={<LinkButton href="/studio/campaigns/new" variant="secondary">캠페인 만들기</LinkButton>}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((c) => {
            const p = campaignProgress(c.stats.raised, c.goalAmount);
            const st = campaignStatusLabel[c.status];
            const left = daysLeft(c.endsOn);
            return (
              <Card key={c.id} className="flex flex-col gap-3">
                {c.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.imageUrl} alt={c.title} className="aspect-[2/1] w-full rounded-xl object-cover" loading="lazy" />
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={st.tone}>{st.text}</Badge>
                  {c.featured ? <Badge tone="warning">강조</Badge> : null}
                  <span className="font-mono text-[12px] text-ink-500">키워드 {c.code}</span>
                  <span className="ml-auto text-[12px] text-ink-400">
                    {c.startsOn.toISOString().slice(0, 10)} ~ {c.endsOn.toISOString().slice(0, 10)}
                    {c.status === 'ACTIVE' ? (c.open ? ` · ${left}일 남음` : ' · 기간 외') : ''}
                  </span>
                </div>
                <div>
                  <h2 className="text-[17px] font-extrabold text-ink-900">{c.title}</h2>
                  <p className="mt-1 text-[13px] text-ink-500">{c.summary}</p>
                </div>
                <div>
                  <div className="mb-1.5 flex items-end justify-between">
                    <span className="text-[20px] font-black tabular-nums text-ink-900">{formatWon(c.stats.raised)}</span>
                    <span className="text-[12px] text-ink-500">
                      목표 {formatWon(c.goalAmount)} · {p.percent}% · 후원 {formatNumber(c.stats.chargeCount)}건 / {formatNumber(c.stats.donorCount)}명
                    </span>
                  </div>
                  <ProgressBar percent={p.capped} />
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
                  <LinkButton href={`/studio/campaigns/${c.id}`} variant="secondary" size="sm">수정</LinkButton>
                  <Link href={`/donate/${org.code}/campaigns/${c.id}`} target="_blank" className="inline-flex items-center gap-1 text-[12.5px] font-bold text-brand-700">
                    미리보기 <ExternalLink size={14} strokeWidth={1.7} />
                  </Link>
                  <span className="ml-auto flex flex-wrap gap-2">
                    {c.status === 'DRAFT' ? (
                      <InlineActionForm action={setCampaignStatusAction} submitLabel="모금 시작" variant="primary" fields={{ id: c.id, status: 'ACTIVE' }} disabled={moCount === 0} disabledReason="MO 번호 배정 후 시작할 수 있습니다" confirmMessage="캠페인을 공개하고 문자 키워드 수신을 시작할까요?" />
                    ) : null}
                    {c.status === 'ACTIVE' ? (
                      <>
                        <InlineActionForm action={setCampaignStatusAction} submitLabel="모금 종료" fields={{ id: c.id, status: 'CLOSED' }} confirmMessage="모금을 종료할까요? 이후 키워드 문자는 기관 일반 후원으로 처리됩니다." />
                        <InlineActionForm action={setCampaignStatusAction} submitLabel="비공개" variant="ghost" fields={{ id: c.id, status: 'DRAFT' }} />
                      </>
                    ) : null}
                    {c.status === 'CLOSED' ? (
                      <>
                        <InlineActionForm action={setCampaignStatusAction} submitLabel="다시 모금" fields={{ id: c.id, status: 'ACTIVE' }} />
                        <InlineActionForm action={setCampaignStatusAction} submitLabel="보관" variant="ghost" fields={{ id: c.id, status: 'ARCHIVED' }} />
                      </>
                    ) : null}
                    {c.status === 'ARCHIVED' ? (
                      <InlineActionForm action={setCampaignStatusAction} submitLabel="복원" fields={{ id: c.id, status: 'DRAFT' }} />
                    ) : null}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-[12px] text-ink-400">
        {showArchived ? <Link href="/studio/campaigns" className="underline">보관 캠페인 숨기기</Link> : <Link href="/studio/campaigns?archived=1" className="underline">보관 캠페인 보기</Link>}
      </p>
    </>
  );
}
