/**
 * 공유·크롤러용 절대 주소의 기준(사이트 주소).
 *
 *  - 운영: NEXT_PUBLIC_SITE_URL(없으면 APP_BASE_URL)만 쓴다. 요청 Host 헤더는 절대 반영하지 않는다
 *    (임의 Host 로 공유 주소·사이트맵을 오염시키지 못하게).
 *  - 로컬(APP_ENV=local)이면서 설정 주소가 비었거나 localhost 일 때만, Cloudflare 임시 터널처럼
 *    요청마다 공개 호스트가 달라지는 미리보기를 위해 전달된 호스트로 주소를 만든다.
 */

export const SITE_NAME = '기브싸인 GIVESIGN';

export function isLocalUrl(value: string | undefined | null): boolean {
  if (!value) return true;
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
  } catch {
    return true;
  }
}

export function configuredSiteUrl(source: Record<string, string | undefined> = process.env): string | undefined {
  return source.NEXT_PUBLIC_SITE_URL || source.APP_BASE_URL || undefined;
}

/** 요청 헤더를 읽어야 하는지(로컬 미리보기에서만). 이 값이 false 면 headers() 를 부르지 않는다. */
export function needsRequestHost(configured: string | undefined, local: boolean): boolean {
  return local && isLocalUrl(configured);
}

export function siteUrlFromHost(host: string | null | undefined, forwardedProto: string | null | undefined): string | null {
  const h = host?.split(',')[0]?.trim();
  if (!h || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(h)) return null;
  const p = forwardedProto?.split(',')[0]?.trim();
  const protocol = p === 'https' || p === 'http' ? p : h.includes('localhost') || h.startsWith('127.') ? 'http' : 'https';
  return `${protocol}://${h}`;
}

export function fallbackSiteUrl(configured: string | undefined): string {
  return configured || 'http://localhost:3060';
}
