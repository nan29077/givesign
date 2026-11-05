import { NextResponse } from 'next/server';
import { env, featureContentEnabled } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireMerchant } from '@/server/auth';
import { platformFromSlug, SNS_PLATFORM_SLUG } from '@/server/adapters/sns/platforms';
import { SocialOAuthError, startSocialConnect } from '@/server/services/social-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SNS 계정 연결 시작 (기관 담당자). state 를 서명해 공급자 동의 화면으로 보낸다.
 * 키가 없거나 mock 이면 동의 화면으로 보내지 않고 채널 화면으로 되돌린다(오류 코드만 주소에 싣는다).
 */
export async function GET(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform: slug } = await ctx.params;
  const back = (q: string) => NextResponse.redirect(new URL(`/studio/channels?${q}`, req.url), 303);
  if (!featureContentEnabled()) return back('error=disabled');
  const platform = platformFromSlug(slug);
  if (!platform) return back('error=unknown');
  let user;
  try {
    user = await requireMerchant();
  } catch {
    return NextResponse.redirect(new URL('/login?next=/studio/channels', req.url), 303);
  }
  try {
    const s = startSocialConnect({ merchantId: user.merchantId, userId: user.id, platform });
    const res = NextResponse.redirect(s.authorizeUrl, 303);
    res.cookies.set(s.cookieName, s.cookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && env.baseUrl.startsWith('https'),
      path: '/api/studio/social',
      maxAge: s.maxAgeSec,
    });
    return res;
  } catch (e) {
    const code = e instanceof SocialOAuthError ? e.code : 'error';
    logger.warn('SNS 계정 연결 시작 거절', { platform, code });
    return back(`error=${encodeURIComponent(code)}&platform=${SNS_PLATFORM_SLUG[platform]}`);
  }
}
