/**
 * robots.txt · sitemap.xml 규칙(순수 함수 — 테스트 대상).
 *
 * 색인할 곳: 공개 안내 페이지 + 공개(published)된 기관 후원페이지 `/donate/[code]`.
 * 막을 곳: API, 콘솔(관리자·기관), 마이페이지, 결제·서명·영수증 토큰 화면, mock 결제사 화면, 호환 결제 화면(/c).
 * 개별 페이지의 noindex 메타는 그대로 두고, 크롤러가 애초에 두드리지 않도록 경로 단위로도 막는다.
 */

export const ROBOTS_DISALLOW = [
  '/api/',
  '/admin',
  '/studio',
  '/my',
  '/mock/',
  '/r/',
  '/receipt/',
  '/sign/',
  '/doc/',
  '/c/',
  '/login',
  '/signup',
  '/reset-password',
  '/donate/*/login',
  '/donate/*/signup',
  '/donate/*/my',
] as const;

export const PUBLIC_STATIC_PATHS = [
  { path: '/', priority: 1, changeFrequency: 'weekly' as const },
  { path: '/how-it-works', priority: 0.8, changeFrequency: 'monthly' as const },
  { path: '/business', priority: 0.8, changeFrequency: 'monthly' as const },
  { path: '/electronic-documents', priority: 0.7, changeFrequency: 'monthly' as const },
  { path: '/faq', priority: 0.6, changeFrequency: 'weekly' as const },
  { path: '/notice', priority: 0.5, changeFrequency: 'weekly' as const },
  { path: '/merchant-apply', priority: 0.6, changeFrequency: 'monthly' as const },
  { path: '/support', priority: 0.4, changeFrequency: 'monthly' as const },
  { path: '/terms', priority: 0.3, changeFrequency: 'yearly' as const },
  { path: '/terms/e-finance', priority: 0.3, changeFrequency: 'yearly' as const },
  { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' as const },
];

export interface SitemapEntry {
  url: string;
  lastModified?: Date;
  changeFrequency?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
}

/** 기관 코드는 GIV-XXXX 형식만 싣는다(이상한 값이 사이트맵에 섞이지 않게). */
const ORG_CODE = /^GIV-[A-Z0-9]{2,10}$/;

export function buildSitemap(
  siteUrl: string,
  orgs: Array<{ code: string; updatedAt?: Date | null }>,
): SitemapEntry[] {
  const base = new URL(siteUrl);
  const entries: SitemapEntry[] = PUBLIC_STATIC_PATHS.map((p) => ({
    url: new URL(p.path, base).toString(),
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));
  for (const o of orgs) {
    if (!ORG_CODE.test(o.code)) continue;
    entries.push({
      url: new URL(`/donate/${o.code}`, base).toString(),
      lastModified: o.updatedAt ?? undefined,
      changeFrequency: 'weekly',
      priority: 0.7,
    });
  }
  return entries;
}
