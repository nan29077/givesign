/**
 * next/image 최적화 사용 여부.
 *
 * 저장소에 들어 있는 정적 자산(`/assets/**`, `/banners/**`)은 Next 이미지 최적화로 화면 폭에 맞춘
 * WebP/AVIF 를 내려보낸다(원본 hero.png 1.7MB·banner.png 2.0MB 를 모바일에 그대로 보내지 않도록, 점검 F).
 * 업로드 파일(`/api/media/**`)·외부 https 주소는 최적화 대상 허용 목록 밖이라 원본 그대로(unoptimized) 쓴다.
 */
export function isOptimizableImage(src: string | null | undefined): boolean {
  if (!src) return false;
  if (src.includes('?') || src.includes('#')) return false;
  return /^\/(assets|banners)\/[A-Za-z0-9._/-]+\.(png|jpe?g|webp|avif)$/i.test(src) && !src.includes('..');
}
