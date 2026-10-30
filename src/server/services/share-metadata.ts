import type { Metadata, ResolvingMetadata } from 'next';
import { prisma } from '@/server/db';
import { normalizeMerchantCode } from '@/lib/id';

/** 공개 캠페인은 주제에 어울리는 생성형 이미지+로고+슬로건 합성 카드를 사용한다. */
function campaignShareImage(text: string) {
  const index = /아동|아이|청소년|어린이|교육|꿈/.test(text) ? 2
    : /김장|식사|급식|도시락|한 끼|먹거리/.test(text) ? 1
    : /어르신|노인|홀몸|안부|돌봄/.test(text) ? 3
    : /장애|자립|동행/.test(text) ? 5 : 4;
  return `/assets/givesign-campaign-share-v9-${index}.png`;
}

export async function donationShareMetadata(code: string, campaignId: string | undefined, parent: ResolvingMetadata): Promise<Metadata> {
  const org = await prisma.merchantProfile.findFirst({
    where: { code: normalizeMerchantCode(code), status: 'APPROVED', user: { status: 'ACTIVE', deletedAt: null } },
    select: { id: true, code: true, displayName: true, donationPage: { select: { published: true, subtitle: true } } },
  });
  // 미공개 기관·작성 중 캠페인의 내용은 공유 크롤러에도 공개하지 않는다.
  if (!org || !org.donationPage?.published) return { title: '기브싸인', robots: { index: false, follow: false } };
  const campaign = campaignId ? await prisma.campaign.findFirst({ where: { id: campaignId, merchantId: org.id, status: { in: ['ACTIVE', 'CLOSED'] } }, select: { id: true, title: true, summary: true, beneficiary: true } }) : null;
  if (campaignId && !campaign) return { title: '기브싸인', robots: { index: false, follow: false } };
  const inherited = await parent;
  const base = inherited.metadataBase || new URL(process.env.NEXT_PUBLIC_SITE_URL || process.env.APP_BASE_URL || 'http://localhost:3060');
  const path = `/donate/${org.code}${campaign ? `/campaigns/${campaign.id}` : ''}`;
  const url = new URL(path, base).toString();
  const title = campaign ? `${campaign.title} | ${org.displayName}` : `${org.displayName} 후원 | 기브싸인`;
  const description = campaign?.summary || org.donationPage.subtitle || '작은 나눔이, 자라나는 희망으로. 기브싸인에서 이웃의 내일을 함께 응원해 주세요.';
  const image = new URL(campaign ? campaignShareImage(`${campaign.title} ${campaign.summary} ${campaign.beneficiary || ''}`) : '/assets/givesign-share-v9.png', base).toString();
  return {
    title: { absolute: title }, description, alternates: { canonical: url },
    openGraph: { title, description, url, siteName: '기브싸인 GiveSign', type: 'website', locale: 'ko_KR', images: [{ url: image, width: 1200, height: 630, alt: '기브싸인 로고와 나눔의 메시지를 담은 캠페인 공유카드' }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}
