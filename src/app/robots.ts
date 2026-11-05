import type { MetadataRoute } from 'next';
import { ROBOTS_DISALLOW } from '@/lib/seo';
import { configuredSiteUrl, fallbackSiteUrl } from '@/lib/site-url';

/** /robots.txt — 공개 안내·후원페이지만 색인하고 API·콘솔·토큰 화면은 막는다(@/lib/seo). */
export default function robots(): MetadataRoute.Robots {
  const site = fallbackSiteUrl(configuredSiteUrl());
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...ROBOTS_DISALLOW] }],
    sitemap: new URL('/sitemap.xml', site).toString(),
  };
}
