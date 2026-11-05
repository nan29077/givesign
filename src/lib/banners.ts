/**
 * /c/[code] 기본 배너.
 * 기관이 배너를 설정하지 않으면 5종 중 하나가 기관별로 고정 적용된다.
 * (매 방문마다 바뀌지 않도록 기관 ID 해시로 결정한다)
 *
 * 예전 기본 배너 5종(`/banners/givesign-live-banner-0N-v2.png`)은 모두 같은 2MB PNG 였다(점검 F).
 * 서로 다른 프리셋 WebP(100~200KB)로 바꾸고, 예전 값을 고정 저장한 기관은 같은 순번의 새 배너로 보여 준다.
 */

export const DEFAULT_BANNERS = [
  '/assets/givesign/presets/banner-1.webp',
  '/assets/givesign/presets/banner-2.webp',
  '/assets/givesign/presets/banner-3.webp',
  '/assets/givesign/presets/banner-4.webp',
  '/assets/givesign/presets/banner-5.webp',
] as const;

/** 예전 기본 배너 경로. 이미 저장된 값의 호환용으로만 쓴다(파일은 public/banners 에 남아 있다). */
export const LEGACY_DEFAULT_BANNERS = [
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

/** 기본 배너(새 프리셋 또는 예전 경로) 선택 값인지. 저장 액션의 허용 판단에 쓴다. */
export function isPresetBanner(url: string): boolean {
  return (
    (DEFAULT_BANNERS as readonly string[]).includes(url) ||
    (LEGACY_DEFAULT_BANNERS as readonly string[]).includes(url)
  );
}

/** 예전 기본 배너를 같은 순번의 새 프리셋으로 바꾼다. 그 밖의 값은 그대로. */
export function upgradeLegacyBanner(url: string): string {
  const i = (LEGACY_DEFAULT_BANNERS as readonly string[]).indexOf(url);
  return i >= 0 ? DEFAULT_BANNERS[i] : url;
}

/** /c 에 그릴 배너 주소. 고정 배너가 없으면 기관별 기본 배너. */
export function resolveChargeBanner(merchantId: string, bannerUrl: string | null | undefined): string {
  return bannerUrl ? upgradeLegacyBanner(bannerUrl) : defaultBannerFor(merchantId);
}
