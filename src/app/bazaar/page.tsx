import type { Metadata } from 'next';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { Card, CardTitle, LinkButton, Notice } from '@/components/ui';
import { BazaarHomeSection } from '@/components/bazaar/home-section';
import { bazaarPageGuard, getBazaarConfig } from '@/server/services/bazaar-settings';
import { publicBazaarInfo } from '@/server/services/bazaar-views';
import { BLOCKED_KEYWORDS } from '@/lib/bazaar';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '라이브 바자회',
  description: '기업·개인이 기부한 물품을 라이브 방송으로 판매해 사회복지기관의 후원금으로 만드는 기브싸인 라이브 바자회.',
};

export default async function BazaarPage() {
  await bazaarPageGuard();
  const [info, cfg] = await Promise.all([publicBazaarInfo(), getBazaarConfig()]);
  return (
    <PublicShell>
      <PageHeader eyebrow="라이브 바자회" title="물품 기부가 기관의 후원금이 되는 곳" description="기부하신 물품은 기관 명의로 기부금영수증이 발급되고, 기브싸인 셀러가 라이브 방송으로 판매합니다." />
      <BazaarHomeSection lives={info.lives} merchants={info.merchants} paidTotal={info.paidTotal} />

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>기부하시는 분께</CardTitle>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-ink-700">
            <li>기업 회원·개인 회원으로 가입한 뒤 기부자 콘솔에서 물품을 등록합니다.</li>
            <li>기부할 기관을 직접 고르거나, 운영자가 필요한 기관을 찾아 연결해 드립니다.</li>
            <li>기부 가액은 기관과 협의해 정하고, 입고·검수 후 합격 수량에 대해 기관이 기부금영수증을 발급합니다.</li>
            <li>판매 가격은 영수증 가액보다 낮을 수 있으며, 원하시면 최저 판매가를 정할 수 있습니다.</li>
            <li>판매되지 않은 물품은 기관 사용·다른 기관 이관·반환 중 고르신 방법으로 처리합니다.</li>
          </ul>
        </Card>
        <Card>
          <CardTitle>사회복지기관께</CardTitle>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-ink-700">
            <li>기관 콘솔의 라이브 바자회 메뉴에서 위탁판매에 동의하고 참여를 신청합니다.</li>
            <li>기관이 할 일은 매칭 수락, 가액 확정, 검수 확정, 방송 편성 승인 네 가지입니다.</li>
            <li>보관·판매·배송·고객 응대는 기브싸인이 대행합니다.</li>
            <li>판매 금액에서 수수료 {cfg.feeRatePercent}%를 뺀 금액을 매월 1회 정산해 다음 달 {cfg.settlementPayDay}일에 지급합니다.</li>
          </ul>
        </Card>
      </div>

      <div className="mt-4">
        <Notice tone="neutral" title="받지 않는 물품">
          {BLOCKED_KEYWORDS.join(' · ')} 등 판매에 별도 신고·인증이 필요한 물품과 유통기한이 30일 미만 남은 물품은 받지 않습니다.
        </Notice>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <LinkButton href="/bazaar/join">회원가입하고 기부하기</LinkButton>
        <LinkButton href="/login?next=/giver" variant="secondary">기부자 로그인</LinkButton>
        <LinkButton href="/login?next=/studio/bazaar" variant="ghost">기관 참여하기</LinkButton>
      </div>
    </PublicShell>
  );
}
