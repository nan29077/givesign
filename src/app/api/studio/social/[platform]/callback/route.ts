import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { featureContentEnabled } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireMerchant } from '@/server/auth';
import { clientIpFromRequest } from '@/server/rate-limit';
import { platformFromSlug, SNS_PLATFORM_SLUG } from '@/server/adapters/sns/platforms';
import { completeSocialConnect, SocialOAuthError, socialOAuthCookieName } from '@/server/services/social-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SNS 계정 연결 콜백. state 서명·만료(10분)·플랫폼·세션 기관 일치·브라우저 nonce 를 확인한 뒤 코드를 교환한다.
 * 토큰은 암호화해 저장하고 주소·로그에 싣지 않는다. 실패 사유는 고정 코드로만 넘긴다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform: slug } = await ctx.params;
  const platform = platformFromSlug(slug);
  const done = (q: string) => {
    const res = NextResponse.redirect(new URL(`/studio/channels?${q}`, req.url), 303);
    if (platform) res.cookies.set(socialOAuthCookieName(platform), '', { path: '/api/studio/social', maxAge: 0 });
    return res;
  };
  if (!featureContentEnabled()) return done('error=disabled');
  if (!platform) return done('error=unknown');
  let user;
  try {
    user = await requireMerchant();
  } catch {
    return NextResponse.redirect(new URL('/login?next=/studio/channels', req.url), 303);
  }
  const url = new URL(req.url);
  const jar = await cookies();
  try {
    await completeSocialConnect({
      sessionMerchantId: user.merchantId,
      sessionUserId: user.id,
      platform,
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      providerError: url.searchParams.get('error') ?? url.searchParams.get('error_code'),
      cookieValue: jar.get(socialOAuthCookieName(platform))?.value ?? null,
      ip: clientIpFromRequest(req),
      userAgent: req.headers.get('user-agent'),
    });
    return done(`connected=${SNS_PLATFORM_SLUG[platform]}`);
  } catch (e) {
    const code = e instanceof SocialOAuthError ? e.code : 'error';
    logger.warn('SNS 계정 연결 실패', { platform, code, message: (e as Error).message });
    return done(`error=${encodeURIComponent(code)}&platform=${SNS_PLATFORM_SLUG[platform]}`);
  }
}
