import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { getCampaigns } from '@/server/services/fundraising';
import { CampaignForm } from '@/components/studio/campaign-form';
import { PageHeader } from '@/components/layout/console-shell';
import { Notice } from '@/components/ui';
import { kstToday } from '@/lib/fundraising';
export default async function Edit({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { merchantId } = await requireMerchant();
  const [{ id }, sp, campaigns] = await Promise.all([params, searchParams, getCampaigns(merchantId)]);
  const c = campaigns.find(x => x.id === id);
  if (id !== 'new' && !c) notFound();
  const today = kstToday();
  return <><PageHeader title={c ? '캠페인 수정' : '캠페인 만들기'} description="대표 이미지와 모집 기간, 지원 대상과 후원금 사용계획을 입력하세요." />{sp.error && <Notice tone="danger">{sp.error}</Notice>}<CampaignForm initial={c} today={today} /></>;
}
