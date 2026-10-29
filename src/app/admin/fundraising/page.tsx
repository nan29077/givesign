import Link from 'next/link';
import { requireAdmin } from '@/server/auth';
import { prisma } from '@/server/db';
import { getDonationPage, getCampaigns } from '@/server/services/fundraising';
import { PageHeader } from '@/components/layout/console-shell';
import { Card } from '@/components/ui';
export default async function FundraisingAdmin() {
  await requireAdmin();
  const orgs = await prisma.merchantProfile.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  const rows = await Promise.all(orgs.map(async org => ({ org, page: await getDonationPage(org.id), campaigns: await getCampaigns(org.id) })));
  return <><PageHeader title="기관 후원페이지·캠페인" description="최근 등록 기관 100곳의 후원페이지 공개 상태와 캠페인을 확인합니다. 설정은 해당 기관의 담당자가 관리합니다." /><div className="space-y-4">{rows.map(({ org, page, campaigns }) => <Card key={org.id}><h2 className="text-lg font-bold">{org.displayName}</h2><p className="mt-2 text-sm">{org.code} · 후원페이지 {page.published ? '공개' : '비공개'} · 캠페인 {campaigns.length}개</p><Link href={`/donate/${org.code}`} target="_blank" className="mt-3 block text-sm font-bold text-brand-700">기관 후원페이지 확인 ↗</Link><div className="mt-4 space-y-2">{campaigns.map(c => <Link className="block text-sm underline" key={c.id} target="_blank" href={`/donate/${org.code}/campaigns/${c.id}`}>{c.title} · {c.published ? '공개' : '비공개'}</Link>)}</div></Card>)}</div></>;
}
