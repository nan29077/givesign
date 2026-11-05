import type { MetadataRoute } from 'next';
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { buildSitemap } from '@/lib/seo';
import { configuredSiteUrl, fallbackSiteUrl } from '@/lib/site-url';
import { isLiveBazaarEnabled } from '@/server/services/bazaar-settings';

// 빌드 시점에 DB 를 읽지 않도록 요청마다 만든다.
export const dynamic = 'force-dynamic';

/**
 * /sitemap.xml — 정적 공개 경로 + 공개된 기관 후원페이지.
 * 후원페이지는 /donate 와 같은 노출 조건(승인·활성·미탈퇴·published)만 싣는다.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = fallbackSiteUrl(configuredSiteUrl());
  let orgs: Array<{ code: string; updatedAt: Date }> = [];
  try {
    const rows = await prisma.merchantProfile.findMany({
      where: {
        status: 'APPROVED',
        user: { status: 'ACTIVE', deletedAt: null },
        donationPage: { is: { published: true } },
      },
      select: { code: true, donationPage: { select: { updatedAt: true } } },
      orderBy: { code: 'asc' },
      take: 5000,
    });
    orgs = rows.map((r) => ({ code: r.code, updatedAt: r.donationPage?.updatedAt ?? new Date(0) }));
  } catch (err) {
    // DB 장애가 sitemap 요청 실패로 번지지 않게 정적 경로만 돌려준다.
    logger.warn('사이트맵 후원페이지 목록 조회 실패', { error: err instanceof Error ? err.message : String(err) });
  }
  const entries = buildSitemap(site, orgs);
  // 라이브 바자회 소개 페이지는 스위치가 켜져 있을 때만 싣는다.
  if (await isLiveBazaarEnabled()) {
    entries.push({ url: new URL('/bazaar', site).toString(), changeFrequency: 'weekly', priority: 0.6 });
  }
  return entries;
}
