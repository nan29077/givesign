import { beforeEach, expect, it } from 'vitest';
import { campaignCardsSchema, campaignSchema, readCampaignCards } from '@/lib/fundraising';
import { getCampaign, saveCampaign } from '@/server/services/fundraising';
import { resetDb, seedBasics } from './helpers';

beforeEach(resetDb);
const card = { imageUrl: '/assets/givesign/presets/banner-1.webp', title: '따뜻한 한 끼', body: '어르신에게 안부를 전합니다.', alt: '도시락을 준비하는 봉사자', layout: 'editorial' as const, theme: 'cream' as const };
const input = () => campaignSchema.parse({ code: '카드뉴스', title: '카드뉴스 모금', summary: '작은 나눔', goalAmount: 100000, startsOn: '2026-10-01', endsOn: '2027-01-01', cardNews: [card, { ...card, layout: 'image', title: '두 번째' }] });

it('카드 수·이미지 주소·빈 카드와 구성 값을 서버에서 검증한다', () => {
  expect(campaignCardsSchema.safeParse(Array(16).fill(card)).success).toBe(false);
  expect(campaignCardsSchema.safeParse([{ ...card, imageUrl: 'javascript:alert(1)' }]).success).toBe(false);
  expect(campaignCardsSchema.safeParse([{ ...card, imageUrl: '/api/admin/payments' }]).success).toBe(false);
  expect(campaignCardsSchema.safeParse([{ ...card, layout: 'image', imageUrl: '' }]).success).toBe(false);
  expect(campaignCardsSchema.safeParse([{ title: '', body: '', imageUrl: '' }]).success).toBe(false);
  expect(campaignCardsSchema.safeParse([{ ...card, theme: 'unknown' }]).success).toBe(false);
  expect(readCampaignCards(null)).toEqual([]);
});

it('캠페인의 카드뉴스 순서와 내용이 저장되고 기존 방식의 수정에서는 보존된다', async () => {
  const fx = await seedBasics();
  const c = await saveCampaign(fx.merchantId, input());
  expect(readCampaignCards((await getCampaign(fx.merchantId, c.id))?.cardNews).map((c) => c.title)).toEqual(['따뜻한 한 끼', '두 번째']);
  const { cardNews: _cards, ...legacy } = input();
  await saveCampaign(fx.merchantId, legacy, c.id);
  expect(readCampaignCards((await getCampaign(fx.merchantId, c.id))?.cardNews)).toHaveLength(2);
  await saveCampaign(fx.merchantId, { ...input(), cardNews: [input().cardNews![1], card] }, c.id);
  expect(readCampaignCards((await getCampaign(fx.merchantId, c.id))?.cardNews)[0].title).toBe('두 번째');
  await saveCampaign(fx.merchantId, { ...input(), cardNews: [] }, c.id);
  expect((await getCampaign(fx.merchantId, c.id))?.cardNews).toEqual([]);
});

it('다른 기관의 캠페인 카드뉴스를 읽거나 수정할 수 없다', async () => {
  const fx = await seedBasics();
  const c = await saveCampaign(fx.merchantId, input());
  expect(await getCampaign('other-merchant', c.id)).toBeNull();
  await expect(saveCampaign('other-merchant', input(), c.id)).rejects.toThrow('캠페인을 찾을 수 없습니다.');
  expect(readCampaignCards((await getCampaign(fx.merchantId, c.id))?.cardNews)).toHaveLength(2);
});
