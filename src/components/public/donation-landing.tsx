import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/server/db';
import { getSessionUser } from '@/server/auth';
import { getCampaigns, getDonationPage } from '@/server/services/fundraising';
import { campaignOpen } from '@/lib/fundraising';
import { normalizeMerchantCode } from '@/lib/id';
import { Logo } from '@/components/brand/logo';
import { isLocal } from '@/lib/env';

export async function DonationLanding({ code, campaignId }: { code: string; campaignId?: string }) {
  const org = await prisma.merchantProfile.findFirst({ where: { code: normalizeMerchantCode(code), status: 'APPROVED', user: { status: 'ACTIVE' } }, include: { moRoutes: { where: { status: 'ASSIGNED' }, orderBy: { assignedAt: 'desc' } } } });
  if (!org) notFound();
  const [c, campaigns, viewer] = await Promise.all([getDonationPage(org.id), getCampaigns(org.id), getSessionUser()]);
  const preview = viewer?.merchantId === org.id || viewer?.role === 'ADMIN';
  const campaign = campaignId ? campaigns.find(x => x.id === campaignId) : undefined;
  if (campaignId && (!campaign || (!campaign.published && !preview))) notFound();
  if (!c.published && !preview) return <main className="mx-auto max-w-xl px-6 py-24"><Logo /><h1 className="mt-10 text-3xl font-bold">후원페이지를 준비하고 있습니다</h1><p className="mt-4">{org.displayName}의 후원페이지가 공개되면 참여하실 수 있습니다.</p><Link href="/" className="mt-8 block">기브싸인 홈으로</Link></main>;
  const route = org.moRoutes[0];
  const accepting = !campaign || campaignOpen(campaign);
  const body = route?.mode === 'SHARED_PREFIX' ? `${route.keyword || org.code} 후원` : '후원';
  const sms = route ? `sms:${route.phoneNumber}?body=${encodeURIComponent(body)}` : '';
  return <main className="min-h-screen bg-[#f8f7f2] pb-20" style={{ '--donation-color': c.color } as React.CSSProperties}>
    <header className="mx-auto flex max-w-4xl items-center justify-between px-5 py-6"><Link href="/"><Logo /></Link><span className="text-sm font-bold">{org.displayName}</span></header>
    {preview && <p className="mx-auto max-w-4xl bg-amber-50 px-5 py-3 text-sm">담당자 미리보기 · 페이지 {c.published ? '공개' : '비공개'}{campaign ? ` / 캠페인 ${campaign.published ? '공개' : '비공개'}` : ''}</p>}
    {isLocal && <p className="mx-auto max-w-4xl px-5 py-3 text-sm text-amber-800">로컬 테스트 환경입니다. 표시된 MO 번호와 후원 흐름은 검수용이며 실제 후원 결제가 아닙니다.</p>}
    <div className="mx-auto max-w-4xl overflow-hidden bg-white shadow-sm sm:rounded-3xl">
      
      <Image unoptimized width={1600} height={800} src={campaign?.image || c.hero || '/assets/givesign/hero.png'} alt={campaign?.title || `${org.displayName} 후원 이야기`} className="aspect-[2/1] w-full object-cover" />
      <div className="space-y-7 p-6 sm:p-10"><div className="flex items-center gap-3"><Image unoptimized width={1600} height={800} src={c.logo || '/assets/givesign/mascot.png'} alt="기관 로고" className="h-14 w-14 rounded-full object-contain" /><p className="font-bold" style={{ color: c.color }}>{org.displayName}</p></div>
        <div><h1 className="text-3xl font-black leading-tight sm:text-4xl">{campaign?.title || c.title}</h1><p className="mt-4 text-lg text-stone-600">{campaign?.summary || c.subtitle}</p></div>
        {campaign && <div className="rounded-2xl bg-stone-50 p-5"><p className="font-bold">목표 후원금 {campaign.goal.toLocaleString('ko-KR')}원</p><p className="mt-2 text-sm">모집 기간 {campaign.start} ~ {campaign.end}</p><p className="mt-2 text-sm text-stone-500">MO 후원금은 기관 단위로 집계됩니다.</p></div>}
        <section><h2 className="text-xl font-bold">{campaign ? '함께 만드는 변화' : '우리 기관의 이야기'}</h2><p className="mt-4 whitespace-pre-wrap leading-8 text-stone-600">{campaign?.story || c.intro}</p></section>
        {campaign?.beneficiary && <section><h2 className="text-xl font-bold">지원 대상</h2><p className="mt-3 whitespace-pre-wrap">{campaign.beneficiary}</p></section>}
        {campaign?.usage && <section><h2 className="text-xl font-bold">후원금 사용계획</h2><p className="mt-3 whitespace-pre-wrap leading-8">{campaign.usage}</p></section>}
        <section className="rounded-2xl border border-stone-200 p-6"><h2 className="text-xl font-bold">문자로 마음 전하기</h2>{!accepting ? <p className="mt-3">캠페인 모집 기간이 아닙니다.</p> : route ? <><p className="mt-3">기관 MO 번호 <strong>{route.phoneNumber}</strong>로 <strong>{body}</strong> 문자를 보내 주세요.</p><p className="mt-3 text-sm leading-6 text-stone-500">문자를 보낸 뒤 받은 안내 링크에서 후원 대상과 금액, 결제수단을 확인하고 승인합니다. 문자 발송 자체로 후원이 완료되지 않습니다. 문자 요금은 통신사 요금제에 따릅니다.</p><a href={sms} className="mt-5 inline-block rounded-full px-7 py-3 font-bold text-white" style={{ background: c.color }}>문자 후원 시작하기</a><Link href={`/c/${org.code}`} className="ml-4 mt-4 inline-block text-sm underline">후원 금액·결제 안내</Link></> : <p className="mt-3">기관 전용 MO 번호를 준비 중입니다. 번호 배정 후 문자후원을 시작할 수 있습니다.</p>}</section>
        <p className="whitespace-pre-wrap rounded-2xl bg-stone-50 p-5 leading-7">{c.thanks}</p>
        {!campaign && c.showCampaigns && <section><h2 className="text-xl font-bold">함께하는 캠페인</h2><div className="mt-4 grid gap-4 sm:grid-cols-2">{campaigns.filter(x => x.published).map(x => <Link href={`/donate/${org.code}/campaigns/${x.id}`} key={x.id} className="overflow-hidden rounded-2xl border border-stone-200"><Image unoptimized width={1600} height={800} src={x.image || '/assets/givesign/banner.png'} alt="" className="aspect-video w-full object-cover" /><div className="p-4"><p className="text-xs text-stone-500">{campaignOpen(x) ? '모집 중' : '모집 예정 또는 종료'}</p><h3 className="mt-2 font-bold">{x.title}</h3><p className="mt-2 text-sm text-stone-600">{x.summary}</p></div></Link>)}</div>{!campaigns.some(x => x.published) && <p className="mt-4 text-stone-500">새로운 캠페인을 준비하고 있습니다.</p>}</section>}
        {campaign && <Link href={`/donate/${org.code}`} className="block text-sm underline">기관 후원페이지로</Link>}
      </div>
    </div><footer className="mt-10 text-center text-xs text-stone-500">마음을 잇는 문자후원, 기브싸인</footer>
  </main>;
}
