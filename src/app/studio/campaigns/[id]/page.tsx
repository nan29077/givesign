import { notFound } from 'next/navigation';
import { formatMoNumber } from '@/lib/mo-number';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { getCampaign } from '@/server/services/fundraising';
import { CampaignForm } from '@/components/studio/campaign-form';
import { QrCard } from '@/components/studio/qr-card';
import { campaignUrl } from '@/server/services/qr';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, DataRow, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { campaignProgress, campaignStatusLabel, kstToday } from '@/lib/fundraising';
import { formatNumber, formatWon } from '@/lib/money';
import { aiDraftAvailability } from '@/server/services/ai-drafts';
import { CampaignChangePanel } from '@/components/studio/campaign-change-panel';
import { ActionForm } from '@/components/studio/action-form';
import { saveCampaignFollowupAction } from '@/app/actions/campaign-setup';
import { AFTER_END_DESCRIPTION, AFTER_END_LABEL, AFTER_END_POLICIES, readContentPlan } from '@/server/services/campaign-setup';
import { CampaignPromos } from '@/components/studio/campaign-promos';
import { moCommandKind } from '@/lib/mo-commands';

export const dynamic = 'force-dynamic';

export default async function CampaignEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const isNew = id === 'new';
  const c = isNew ? null : await getCampaign(merchantId, id);
  if (!isNew && !c) notFound();
  const org = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { code: true } });
  const moNumbers = await prisma.merchantMoNumber.findMany({ where: { merchantId, status: 'ASSIGNED' }, select: { phoneNumber: true, mode: true, keyword: true } });

  return (
    <>
      <PageHeader
        title={c ? '캠페인 수정' : '캠페인 만들기'}
        description="표지 이미지와 카드뉴스로 캠페인의 이야기를 구성하세요. 이미지·제목·설명을 순서대로 넣고 미리볼 수 있습니다. 저장 후 '모금 시작'을 누르면 공개됩니다."
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
          <div className="mt-4 border-t border-ink-100 pt-4">
            <QrCard title={`${c.title} QR 코드`} subtitle="이 캠페인 페이지로 바로 연결됩니다" qrPath={`/api/qr/${org.code}/campaigns/${c.id}`} targetUrl={campaignUrl(org.code, c.id)} compact />
          </div>
        </Card>
      ) : null}
      {c && c.status !== 'ARCHIVED' ? (
        <div className="mb-5 grid gap-5 lg:grid-cols-2">
          <Card>
            <p className="mb-1 text-[13px] font-bold text-ink-900">기간·목표 바꾸기 · 모금 종료</p>
            <p className="mb-3 text-[12px] leading-relaxed text-ink-500">반영 전에 후원페이지 문구·예약 콘텐츠·문자 키워드·결과 보고 예정일에 미칠 영향을 보여 줍니다.{readContentPlan(c.contentPlan) ? ` 콘텐츠 일정: 주 ${readContentPlan(c.contentPlan)!.weeklyCount}건 ${readContentPlan(c.contentPlan)!.postHour}시.` : ''}</p>
            <CampaignChangePanel id={c.id} endsOn={c.endsOn.toISOString().slice(0, 10)} goalAmount={Number(c.goalAmount)} canClose={c.status === 'ACTIVE'} />
          </Card>
          <Card>
            <p className="mb-3 text-[13px] font-bold text-ink-900">종료 후 처리 · 감사 문자 · 결과 보고</p>
            <ActionForm action={saveCampaignFollowupAction} submitLabel="저장">
              <input type="hidden" name="id" value={c.id} />
              <Field label="종료 후 들어온 후원" hint={AFTER_END_DESCRIPTION[(AFTER_END_POLICIES as readonly string[]).includes(c.afterEndPolicy) ? (c.afterEndPolicy as 'GENERAL' | 'REJECT') : 'GENERAL']}>
                <Select name="afterEndPolicy" defaultValue={c.afterEndPolicy}>
                  {AFTER_END_POLICIES.map((v) => <option key={v} value={v}>{AFTER_END_LABEL[v]}</option>)}
                </Select>
              </Field>
              <Field label="이 캠페인 감사 문자" hint="비우면 기관 기본 감사 문구. {후원자} 치환자를 넣어 주세요.">
                <Textarea name="thanksMessage" rows={3} maxLength={300} defaultValue={c.thanksMessage ?? ''} />
              </Field>
              <Field label="결과 보고 예정일" hint="이 날부터 승인 대기함에 '결과 보고 작성' 이 올라옵니다.">
                <Input type="date" name="resultReportDueOn" defaultValue={c.resultReportDueOn ? c.resultReportDueOn.toISOString().slice(0, 10) : ''} />
              </Field>
            </ActionForm>
          </Card>
        </div>
      ) : null}
      {c && moCommandKind(c.code) ? (
        <div className="mb-5">
          <Notice tone="warning" title="키워드가 문자 명령어와 겹칩니다">
            &quot;{c.code}&quot; 는 새 문자 명령어(영수증·내역·변경·해지·문의)와 같은 말입니다. 이 캠페인 키워드가 우선해 지금처럼 이 캠페인 후원으로 처리됩니다. 후원자가 명령어를 쓸 수 있게 하려면 키워드를 바꿔 주세요.
          </Notice>
        </div>
      ) : null}
      {c ? (
        <CampaignPromos
          merchantId={merchantId}
          campaign={{ id: c.id, code: c.code, title: c.title, aliases: c.aliases, status: c.status }}
          moHint={moNumbers.length ? moNumbers.map((m) => `${formatMoNumber(m.phoneNumber)} 로${m.mode === 'SHARED_PREFIX' && m.keyword ? ` "${m.keyword}" 다음에` : ''}`).join(' / ') : null}
        />
      ) : null}
      <CampaignForm initial={c} today={kstToday()} ai={aiDraftAvailability()} />
      <div className="mt-5">
        <Notice tone="neutral" title="문자 키워드는 이렇게 동작합니다">
          후원자가 기관 수신번호로 <span className="font-mono">{c?.code ?? '키워드'} 응원합니다</span> 처럼 보내면 키워드를 떼어 낸 나머지가 후원 메시지로 남고, 결제 성공 시 이 캠페인 모금액에 집계됩니다.
          키워드 없이 보낸 문자는 기관 일반 후원이며, 금액 선택 화면에서 캠페인을 고를 수도 있습니다. 모금 기간이 끝나면 키워드가 있어도 일반 후원으로 처리됩니다.
        </Notice>
      </div>
    </>
  );
}
