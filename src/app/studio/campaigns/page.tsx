import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { getCampaigns } from '@/server/services/fundraising';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, LinkButton } from '@/components/ui';
import { archiveCampaign } from '@/app/actions/fundraising';
export default async function Campaigns() {
  const { merchantId } = await requireMerchant();
  const [rows, org] = await Promise.all([getCampaigns(merchantId), prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId } })]);
  return <><PageHeader title="후원 캠페인" description="이웃에게 필요한 변화를 소개하고 기관의 후원 참여를 안내하세요." /><LinkButton href="/studio/campaigns/new">캠페인 만들기</LinkButton><div className="mt-5 space-y-4">{!rows.length && <Card>등록된 캠페인이 없습니다. 첫 캠페인을 만들어 보세요.</Card>}{rows.map(c => <Card key={c.id}><p className="text-xs text-ink-500">{c.published ? '공개' : '비공개'} · {c.start} ~ {c.end}</p><h2 className="mt-2 text-xl font-bold">{c.title}</h2><p className="mt-2">{c.summary}</p><p className="mt-2 text-sm">목표 {c.goal.toLocaleString('ko-KR')}원</p><div className="mt-4 flex flex-wrap gap-4 text-sm font-bold"><Link href={`/studio/campaigns/${c.id}`}>수정</Link><Link href={`/donate/${org.code}/campaigns/${c.id}`} target="_blank">미리보기 ↗</Link>{c.published && <form action={archiveCampaign}><input type="hidden" name="id" value={c.id} /><button>비공개로 전환</button></form>}</div></Card>)}</div></>;
}
