import { z } from 'zod';

export const safeImage = z.string().max(1000).refine(v => !v || (v.startsWith('/') && !v.startsWith('//') && !v.includes('\\')) || /^https:\/\//i.test(v), '이미지는 업로드 경로나 HTTPS 주소를 사용해 주세요.');
export const donationPageSchema = z.object({
  title: z.string().trim().min(1).max(100), subtitle: z.string().trim().max(300),
  intro: z.string().trim().max(10000), hero: safeImage, logo: safeImage,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/), thanks: z.string().trim().max(1000),
  published: z.boolean(), showCampaigns: z.boolean(),
});
export type DonationPage = z.infer<typeof donationPageSchema>;
export const defaultDonationPage: DonationPage = {
  title: '당신의 마음이, 이웃의 내일이 됩니다', subtitle: '문자 한 통에서 시작하는 따뜻한 변화',
  intro: '지역의 이웃과 함께 더 나은 일상을 만들어 갑니다. 보내주신 후원은 꼭 필요한 곳에 소중히 사용됩니다.',
  hero: '/assets/givesign/hero.png', logo: '/assets/givesign/mascot.png', color: '#28634e',
  thanks: '함께해 주셔서 감사합니다. 보내주신 마음을 이웃에게 전하겠습니다.', published: false, showCampaigns: true,
};
export const campaignSchema = z.object({
  title: z.string().trim().min(1).max(100), summary: z.string().trim().min(1).max(300),
  story: z.string().trim().max(10000), beneficiary: z.string().trim().max(300), usage: z.string().trim().max(3000),
  image: safeImage, goal: z.coerce.number().int().min(10000).max(1000000000000),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  published: z.boolean(),
}).refine(v => {
  const valid = (d: string) => Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
  return valid(v.start) && valid(v.end) && v.end >= v.start;
}, '올바른 날짜를 입력하고 종료일을 시작일 이후로 설정해 주세요.');
export type CampaignInput = z.infer<typeof campaignSchema>;
export type Campaign = CampaignInput & { id: string; merchantId: string; createdAt: string };
export const pageKey = (id: string) => `givesign:page:${id}`;
export const campaignKey = (owner: string, id: string) => `givesign:campaign:${owner}:${id}`;
export const kstToday = (now = new Date()) => new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
export function campaignOpen(c: Campaign, now = new Date()) {
  const today = kstToday(now);
  return c.published && c.start <= today && today <= c.end;
}
