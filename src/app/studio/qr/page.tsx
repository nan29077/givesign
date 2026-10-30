import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Notice, StatTile } from '@/components/ui';
import { QrCard } from '@/components/studio/qr-card';
import { campaignStatusLabel } from '@/lib/fundraising';
import { PAID_STATUSES } from '@/components/studio/shared';
import { formatNumber, formatWon } from '@/lib/money';
import { campaignUrl, donationPageUrl } from '@/server/services/qr';

export const dynamic = 'force-dynamic';

/**
 * QR 코드 — 기관 후원페이지 1개 + 캠페인마다 1개.
 * 캠페인을 만들면 QR 이 바로 생긴다(별도 생성 단계 없음). 포스터·전단·현수막에 넣어 쓴다.
 * QR 로 들어온 후원은 유입 경로 'QR' 로 집계된다.
 */
export default async function StudioQrPage() {
  const { merchantId } = await requireMerchant();
  const [org, campaigns, qrAgg, qrPledges] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { code: true, displayName: true } }),
    prisma.campaign.findMany({ where: { merchantId, status: { not: 'ARCHIVED' } }, orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }] }),
    prisma.charge.groupBy({ by: ['campaignId'], where: { merchantId, source: 'QR', isTest: false, status: { in: PAID_STATUSES } }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.recurringDonation.count({ where: { merchantId, source: 'QR' } }),
  ]);
  const byCampaign = new Map(qrAgg.map((a) => [a.campaignId ?? 'none', a]));
  const total = qrAgg.reduce((a, r) => ({ n: a.n + r._count._all, amt: a.amt + (r._sum.amount ?? 0n) }), { n: 0, amt: 0n });
  const pageQr = `/api/qr/${org.code}`;
  return (
    <>
      <PageHeader title="QR 코드" description="후원페이지와 캠페인마다 QR 코드가 자동으로 만들어집니다. 포스터·전단·현수막에 넣으면 휴대폰 카메라로 비춰 바로 후원페이지가 열립니다." />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="QR 로 들어온 후원" value={`${formatNumber(total.n)}건`} sub={formatWon(total.amt)} tone="brand" />
        <StatTile label="QR 로 들어온 정기 약정" value={`${formatNumber(qrPledges)}건`} />
        <StatTile label="캠페인 QR" value={`${campaigns.length}개`} sub="보관한 캠페인 제외" />
        <StatTile label="후원페이지 QR" value="1개" sub={`/donate/${org.code}`} />
      </div>

      <Card className="mb-5">
        <h2 className="mb-3 text-[16px] font-black text-ink-900">기관 후원페이지</h2>
        <QrCard title={`${org.displayName} 후원페이지`} subtitle="기관 일반 후원 · 정기후원 · 자원봉사 신청" qrPath={pageQr} targetUrl={donationPageUrl(org.code)} />
        <p className="mt-3 text-[12px] text-ink-400">QR 로 들어온 기관 일반 후원 {formatNumber(byCampaign.get('none')?._count._all ?? 0)}건</p>
      </Card>

      <h2 className="mb-3 text-[16px] font-black text-ink-900">캠페인별 QR</h2>
      {campaigns.length === 0 ? (
        <EmptyState title="캠페인이 없습니다" description="캠페인을 만들면 그 캠페인으로 바로 연결되는 QR 코드가 여기에 생깁니다." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {campaigns.map((c) => {
            const st = campaignStatusLabel[c.status];
            const agg = byCampaign.get(c.id);
            return (
              <Card key={c.id}>
                <div className="mb-2 flex items-center gap-2">
                  <Badge tone={st.tone}>{st.text}</Badge>
                  <span className="font-mono text-[12px] text-ink-500">키워드 {c.code}</span>
                  <span className="ml-auto text-[12px] text-ink-400">QR 후원 {formatNumber(agg?._count._all ?? 0)}건</span>
                </div>
                <QrCard title={c.title} subtitle={`${org.displayName} 캠페인`} qrPath={`/api/qr/${org.code}/campaigns/${c.id}`} targetUrl={campaignUrl(org.code, c.id)} />
                {c.status !== 'ACTIVE' ? <p className="mt-2 text-[12px] text-warning-500">모금 중이 아닌 캠페인입니다. QR 로 들어오면 캠페인 안내와 함께 기관 일반 후원으로 이어집니다.</p> : null}
              </Card>
            );
          })}
        </div>
      )}
      <div className="mt-5"><Notice tone="neutral">QR 주소는 기관 코드와 캠페인이 바뀌지 않는 한 그대로입니다. 한 번 인쇄한 QR 도 계속 쓸 수 있습니다. 캠페인을 보관하면 그 캠페인 QR 은 열리지 않습니다.</Notice></div>
    </>
  );
}
