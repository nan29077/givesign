import { notFound } from 'next/navigation';
import { formatMoNumber } from '@/lib/mo-number';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { getCampaign } from '@/server/services/fundraising';
import { CampaignForm } from '@/components/studio/campaign-form';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, DataRow, Notice } from '@/components/ui';
import { campaignProgress, campaignStatusLabel, kstToday } from '@/lib/fundraising';
import { formatNumber, formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

export default async function CampaignEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const isNew = id === 'new';
  const c = isNew ? null : await getCampaign(merchantId, id);
  if (!isNew && !c) notFound();
  const moNumbers = await prisma.merchantMoNumber.findMany({ where: { merchantId, status: 'ASSIGNED' }, select: { phoneNumber: true, mode: true, keyword: true } });

  return (
    <>
      <PageHeader
        title={c ? '캠페인 수정' : '캠페인 만들기'}
        description="대표 이미지와 모집 기간, 지원 대상과 후원금 사용 계획을 입력하세요. 저장 후 목록에서 '모금 시작' 을 눌러야 공개됩니다."
      />
      {c ? (
        <Card className="mb-5">
          <div className="mb-2 flex items-center gap-2">
            <Badge tone={campaignStatusLabel[c.status].tone}>{campaignStatusLabel[c.status].text}</Badge>
            <span className="text-[13px] font-bold text-ink-900">현재 모금 현황</span>
          </div>
          <DataRow label="모금액" value={`${formatWon(c.stats.raised)} / ${formatWon(c.goalAmount)} (${campaignProgress(c.stats.raised, c.goalAmount).percent}%)`} />
          <DataRow label="후원" value={`${formatNumber(c.stats.chargeCount)}건 · ${formatNumber(c.stats.donorCount)}명`} />
          <DataRow
            label="문자 안내"
            value={
              moNumbers.length
                ? moNumbers.map((m) => `${formatMoNumber(m.phoneNumber)} 로 "${m.mode === 'SHARED_PREFIX' && m.keyword ? `${m.keyword} ` : ''}${c.code} 응원 메시지"`).join(' / ')
                : 'MO 번호 미배정'
            }
          />
        </Card>
      ) : null}
      <CampaignForm initial={c} today={kstToday()} />
      <div className="mt-5">
        <Notice tone="neutral" title="문자 키워드는 이렇게 동작합니다">
          후원자가 기관 수신번호로 <span className="font-mono">{c?.code ?? '키워드'} 응원합니다</span> 처럼 보내면 키워드를 떼어 낸 나머지가 후원 메시지로 남고, 결제 성공 시 이 캠페인 모금액에 집계됩니다.
          키워드 없이 보낸 문자는 기관 일반 후원이며, 금액 선택 화면에서 캠페인을 고를 수도 있습니다. 모금 기간이 끝나면 키워드가 있어도 일반 후원으로 처리됩니다.
        </Notice>
      </div>
    </>
  );
}
