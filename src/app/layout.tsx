import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { isLocal } from '@/lib/env';
import { SITE_NAME, configuredSiteUrl, fallbackSiteUrl, needsRequestHost, siteUrlFromHost } from '@/lib/site-url';

const shareTitle = '기브싸인 | 작은 나눔이, 자라나는 희망으로';
const shareDescription = '후원과 사람을 잇고, 기관의 일을 가볍게. 문자후원·모금 캠페인·기관 전자문서를 기브싸인에서 함께 운영하세요.';

/**
 * Cloudflare 임시 터널처럼 요청마다 공개 호스트가 달라지는 로컬 미리보기에서만
 * 전달된 호스트로 절대 OG 주소를 만든다. 운영(APP_ENV != local)에서는 headers() 를 부르지 않고
 * NEXT_PUBLIC_SITE_URL(없으면 APP_BASE_URL)만 쓴다 — 임의 Host 헤더가 공유 주소에 반영되지 않는다.
 */
export async function generateMetadata(): Promise<Metadata> {
  const configuredUrl = configuredSiteUrl();
  let siteUrl = fallbackSiteUrl(configuredUrl);

  if (needsRequestHost(configuredUrl, isLocal)) {
    const h = await headers();
    const fromHost = siteUrlFromHost(h.get('x-forwarded-host') || h.get('host'), h.get('x-forwarded-proto'));
    if (fromHost) siteUrl = fromHost;
  }

  const metadataBase = new URL(siteUrl);
  const shareImage = new URL('/assets/givesign-share-v10.png', metadataBase).toString();

  return {
    metadataBase,
    title: { default: shareTitle, template: '%s | 기브싸인' },
    description: shareDescription,
    keywords: ['기브싸인', 'GIVESIGN', '문자후원', 'MO 후원', '사회복지기관 후원', '정기후원', '기부금영수증'],
    icons: {
      icon: [
        { url: '/givesign-icon-v7.png?v=7', type: 'image/png', sizes: '512x512' },
      ],
      shortcut: '/favicon.ico?v=7',
      apple: '/apple-touch-icon-v7.png',
    },
    openGraph: {
      title: shareTitle,
      description: shareDescription,
      type: 'website',
      url: metadataBase,
      siteName: SITE_NAME,
      locale: 'ko_KR',
      images: [{ url: shareImage, width: 1200, height: 630, alt: '기브싸인 - 작은 나눔이 자라나는 희망으로' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: shareTitle,
      description: shareDescription,
      images: [shareImage],
    },
    robots: { index: true, follow: true },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#203c32',
  // 다크 모드 디자인이 없다. 브라우저 강제 다크 변환으로 대비가 깨지지 않도록 밝은 테마임을 명시한다.
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // suppressHydrationWarning: 번역기·다크모드·비밀번호 관리자 같은 브라우저 확장이
  // 하이드레이션 전에 <html>/<body> 속성을 주입해 발생하는 속성 불일치 경고를 막는다.
  // (한 단계 깊이의 속성에만 적용되므로 내부 콘텐츠의 실제 불일치는 계속 감지된다)
  return (
    <html lang="ko" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
