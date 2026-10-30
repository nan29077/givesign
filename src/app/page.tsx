import { EDocumentIntro } from '@/components/public/e-document-intro';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { HeartHandshake, Building2, Sprout } from 'lucide-react';
import { PublicShell } from '@/components/layout/public-shell';
import { HeroSlider } from '@/components/public/hero-slider';
import { BannerStrip } from '@/components/public/banner-strip';
import { Card, LinkButton, Notice } from '@/components/ui';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '기브싸인 — 문자 한 통으로 시작하는 사회복지기관 후원',
  description: '사회복지기관 전용 문자(MO) 후원 서비스. 기관 번호로 문자를 보내고 금액을 확인하면 후원이 완료됩니다. 정기후원과 기부금영수증까지 한곳에서.',
};
export default async function Home({ searchParams }: { searchParams: Promise<{ withdrawn?: string }> }) {
 const sp = await searchParams;
 return <PublicShell>{sp.withdrawn && <Notice tone="brand">회원 탈퇴가 완료되었습니다.</Notice>}<HeroSlider /><BannerStrip position="HOME_TOP" className="mt-5" />
 <section className="mt-12"><p className="text-xs font-bold tracking-widest text-brand-700">GIVE A SIGN OF HOPE</p><h2 className="mt-3 text-3xl font-black leading-tight">작은 마음을 모아<br />이웃의 내일을 바꿉니다</h2><p className="mt-5 leading-8 text-ink-500">기브싸인은 사회복지기관과 후원자를 잇는 문자후원 플랫폼입니다. 기관에 배정된 MO 번호로 후원을 시작하고 안내 링크에서 금액과 결제 내용을 확인해 마음을 전합니다.</p><div className="mt-6 grid gap-4 sm:grid-cols-2"><Card><HeartHandshake className="text-brand-700" /><h3 className="mt-4 text-lg font-bold">후원자에게는 간편하게</h3><p className="mt-3 text-sm leading-7">앱 설치 없이 익숙한 문자에서 시작하세요. 후원할 기관과 금액을 확인하고 승인합니다.</p></Card><Card><Building2 className="text-brand-700" /><h3 className="mt-4 text-lg font-bold">기관에게는 체계적으로</h3><p className="mt-3 text-sm leading-7">기관 소개와 캠페인을 만들고 MO 번호, 후원 내역, 정산 현황을 한곳에서 관리하세요.</p></Card></div></section>
 <section className="mt-12"><h2 className="text-2xl font-black">더 가까워지는 나눔</h2><div className="mt-5 grid grid-cols-2 gap-3">{['아동·청소년의 건강한 성장', '어르신의 든든한 일상', '장애인의 자립과 동행', '지역사회 이웃 돌봄'].map(x => <Card key={x}><Sprout size={20} className="text-brand-700" /><p className="mt-3 text-sm font-bold">{x}</p></Card>)}</div></section>
 <BannerStrip position="HOME_MIDDLE" className="mt-12" />
 <section className="mt-12 overflow-hidden rounded-3xl bg-white shadow-sm"><Image unoptimized width={1600} height={800} src="/assets/givesign/banner.png" alt="복지기관에서 도시락을 준비하는 봉사자들" className="aspect-[2/1] w-full object-cover" /><div className="p-6"><h2 className="text-2xl font-black">우리 기관의 이야기가<br />후원으로 이어지도록</h2><p className="mt-4 text-sm leading-7">대표 이미지와 기관 소개, 목표금액과 사용계획을 담은 캠페인으로 후원자를 만나세요.</p><Link href="/merchant-apply" className="mt-5 block font-bold text-brand-800">사회복지기관 도입 신청 →</Link></div></section>
 <section className="mt-12"><h2 className="text-2xl font-black">후원은 이렇게 시작합니다</h2><ol className="mt-6 space-y-4">{['기관 전용 MO 번호로 문자를 보냅니다.', '받은 링크에서 본인과 결제수단을 확인합니다.', '후원 대상과 금액을 확인한 뒤 승인합니다.', '처리 결과를 확인하고 따뜻한 마음을 전합니다.'].map((x, i) => <li key={x} className="flex gap-4 rounded-2xl border border-ink-100 bg-white p-5"><span className="font-bold text-brand-700">0{i + 1}</span><p className="text-sm leading-6">{x}</p></li>)}</ol><p className="mt-4 text-xs leading-6 text-ink-500">문자 발송만으로 후원이 완료되지는 않습니다. 안내된 승인 절차와 결제 결과에 따라 처리됩니다.</p></section>
 <EDocumentIntro /><Card className="mt-12 !bg-brand-50"><h2 className="text-2xl font-black">마음을 잇는 기브싸인</h2><p className="mt-3 text-sm leading-7">사회복지기관 전용 후원 운영 환경을 직접 확인해 보세요.</p><div className="mt-5 flex gap-3"><LinkButton href="/login">기관 로그인</LinkButton><LinkButton href="/business">도입 안내</LinkButton></div></Card></PublicShell>;
}
