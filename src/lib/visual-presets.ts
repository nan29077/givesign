import { z } from 'zod';
import { safeImage } from './fundraising';

const labels = ['따뜻한 한 끼', '아이들의 내일', '어르신과 동행', '함께 가꾸는 정원', '이웃 돌봄'];
export const DONATION_BANNERS = labels.map((label, i) => ({ label, url: `/assets/givesign/presets/banner-${i + 1}.webp` }));
export const DONATION_MARGINS = labels.map((label, i) => ({ label, url: `/assets/givesign/presets/org-margin-${i + 1}.webp` }));
export const MAIN_MARGINS = labels.map((label, i) => ({ label, url: `/assets/givesign/presets/main-margin-${i + 1}.webp` }));
export const mainVisualSchema = z.object({
  activeIndex: z.coerce.number().int().min(0).max(4),
  images: z.array(safeImage.refine(Boolean, '이미지를 선택해 주세요.')).length(5),
});
export const orgVisualSchema = z.object({
  bannerIndex: z.number().int().min(0).max(4),
  marginIndex: z.number().int().min(0).max(4),
  backgroundUrl: safeImage.default(''),
});
export const MAIN_VISUAL_KEY = 'givesign:main-visuals';
export const orgVisualKey = (id: string) => `givesign:org-visuals:${id}`;
