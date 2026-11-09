import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { PageHeader } from '@/components/layout/console-shell';
import { CampaignForm } from '@/components/studio/campaign-form';
import { CampaignWizard } from '@/components/studio/campaign-wizard';
import { kstToday } from '@/lib/fundraising';
import { aiDraftAvailability } from '@/server/services/ai-drafts';
import { AFTER_END_DESCRIPTION, AFTER_END_LABEL, AFTER_END_POLICIES } from '@/server/services/campaign-setup';

export const dynamic = 'force-dynamic';

/**
 * 캠페인 만들기 (2026-11-12 4차 I1). 기본은 개설 마법사(한 번에 키워드·QR·콘텐츠 일정·감사 문구·종료 후 방침·결과 보고 예정일),
 * `?mode=full` 은 예전 상세 입력 폼(카드뉴스·이야기)이다.
 */
export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  await requireMerchant();
  const { mode } = await searchParams;
  const today = kstToday();
  if (mode === 'full') {
    return (
      <>
        <PageHeader title="캠페인 만들기(상세)" description="카드뉴스·이야기까지 한 번에 입력합니다. 저장 후 '모금 시작' 을 누르면 공개됩니다." />
        <p className="mb-4 text-[13px] text-ink-500"><Link href="/studio/campaigns/new" className="font-bold text-brand-700 underline">개설 마법사로 만들기</Link> — 콘텐츠 일정·감사 문구·결과 보고 예정일까지 한 번에</p>
        <CampaignForm initial={null} today={today} ai={aiDraftAvailability()} />
      </>
    );
  }
  const end = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  return (
    <>
      <PageHeader
        title="캠페인 만들기"
        description="제목·목표·기간·용도·대표 사진을 한 번 입력하면 후원페이지 카드·문자 키워드·QR·콘텐츠 일정·감사 문구·결과 보고 예정일을 함께 준비합니다. 콘텐츠는 승인해야 게시됩니다."
      />
      <p className="mb-4 text-[13px] text-ink-500">카드뉴스·긴 이야기는 저장 뒤 캠페인 화면에서 더할 수 있습니다. <Link href="/studio/campaigns/new?mode=full" className="font-bold text-brand-700 underline">상세 입력으로 만들기</Link></p>
      <CampaignWizard
        setupKey={randomUUID().replace(/-/g, '')}
        today={today}
        defaultEnd={end}
        ai={aiDraftAvailability()}
        policies={AFTER_END_POLICIES.map((v) => ({ value: v, label: AFTER_END_LABEL[v], description: AFTER_END_DESCRIPTION[v] }))}
      />
    </>
  );
}
