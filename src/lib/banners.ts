/**
 * 결제 페이지 기본 배너.
 * 사회복지기관이 배너를 설정하지 않으면 5종 중 하나가 사회복지기관별로 고정 적용된다.
 * (매 방문마다 바뀌지 않도록 사회복지기관 ID 해시로 결정한다)
 */

export const DEFAULT_BANNERS = [
  '/banners/givesign-live-banner-01-v2.png',
  '/banners/givesign-live-banner-02-v2.png',
  '/banners/givesign-live-banner-03-v2.png',
  '/banners/givesign-live-banner-04-v2.png',
  '/banners/givesign-live-banner-05-v2.png',
] as const;

export function defaultBannerFor(merchantId: string): string {
  let h = 0;
  for (let i = 0; i < merchantId.length; i += 1) h = (h * 31 + merchantId.charCodeAt(i)) >>> 0;
  return DEFAULT_BANNERS[h % DEFAULT_BANNERS.length];
}
