import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { PublicShell } from '@/components/layout/public-shell';
import { HeroSlider } from '@/components/public/hero-slider';
import { BannerStrip } from '@/components/public/banner-strip';
import { HomeAutomation } from '@/components/public/home-automation';
import { EDocumentIntro } from '@/components/public/e-document-intro';
import { Card, LinkButton, Notice } from '@/components/ui';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '기브싸인 — 게시물 하나가 한 해의 후원이 되기까지',
  description:
    '사회복지기관 전용 문자(MO) 후원 서비스. 캠페인 숏폼과 이미지를 자동으로 만들어 SNS 로 알리고, 문자 한 통으로 후원·정기 약정·자원봉사 신청을 받고, 약정서·월간 안내·기부금영수증까지 이어서 보냅니다.',
};

const DONOR_STEPS = [
  '기관 번호로 응원 메시지를 보냅니다. 정기후원은 ‘정기’, 자원봉사는 ‘봉사’ 를 보내면 됩니다.',
  '답장 링크에서 금액을 고르고 등록한 계좌의 PIN 으로 승인합니다. 처음이면 계좌 등록 안내가 먼저 옵니다.',
  '결과와 감사 인사를 받고, 매달 후원 내역과 연말 기부금영수증을 알림으로 받습니다.',
];

export default async function Home({ searchParams }: { searchParams: Promise<{ withdrawn?: string }> }) {
  const sp = await searchParams;
  return (
    <PublicShell>
      {sp.withdrawn && <Notice tone="brand">회원 탈퇴가 완료되었습니다.</Notice>}
      <HeroSlider />
      <BannerStrip position="HOME_TOP" className="mt-5" />

      <HomeAutomation />

      <BannerStrip position="HOME_MIDDLE" className="mt-14" />

      <section className="mt-14 overflow-hidden rounded-3xl bg-white shadow-sm">
        <Image unoptimized width={1600} height={800} src="/assets/givesign/banner.png" alt="복지기관에서 도시락을 준비하는 봉사자들" className="aspect-[2/1] w-full object-cover" />
        <div className="p-6">
          <h2 className="text-[22px] font-black leading-snug tracking-[-0.03em]">후원하는 분은<br />문자 한 통이면 됩니다</h2>
          <ol className="mt-5 space-y-3">
            {DONOR_STEPS.map((x, i) => (
              <li key={x} className="grid grid-cols-[28px_1fr] gap-2 text-[14px] leading-[1.7] text-ink-700">
                <span className="font-black text-brand-700 tabular-nums">{i + 1}</span>
                <p>{x}</p>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-[12px] leading-6 text-ink-500">문자를 보내는 것만으로 후원이 결제되지는 않습니다. 안내된 승인 절차와 결제 결과에 따라 처리됩니다.</p>
        </div>
      </section>

      <EDocumentIntro />

      <Card className="mt-12 !bg-brand-50">
        <h2 className="text-[22px] font-black tracking-[-0.03em]">우리 기관에서 먼저 써 보세요</h2>
        <p className="mt-3 text-[14px] leading-7 text-ink-700">캠페인 하나를 만들면 콘텐츠·문자 키워드·후원페이지가 함께 준비됩니다. 기관 콘솔에서 바로 확인할 수 있습니다.</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <LinkButton href="/login">기관 로그인</LinkButton>
          <LinkButton href="/merchant-apply" variant="secondary">도입 신청</LinkButton>
        </div>
        <p className="mt-4 text-[12.5px] text-ink-500">후원자라면 <Link href="/my" className="font-bold text-brand-700 underline underline-offset-2">마이페이지</Link>에서 후원 내역·약정서·영수증을 볼 수 있습니다.</p>
      </Card>
    </PublicShell>
  );
}
