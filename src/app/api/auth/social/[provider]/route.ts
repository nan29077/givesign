import { env } from '@/lib/env';
import { NextResponse } from 'next/server';
import {
  SOCIAL_PROVIDERS,
  SOCIAL_LABEL,
  socialProviderStatus,
  getSocialAdapter,
  SocialNotConfiguredError,
  type SocialProvider,
} from '@/server/adapters/social';
import { generateToken } from '@/lib/crypto';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 소셜 간편 로그인 시작.
 *
 * 아직 OAuth 앱이 등록되지 않았으므로, 키가 없으면 인증을 시도하지 않고
 * 로그인/회원가입 화면으로 되돌려 "연동 준비 중"임을 알린다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') === 'signup' ? 'signup' : 'login';
  const backTo = mode === 'signup' ? '/signup' : '/login';

  if (!SOCIAL_PROVIDERS.includes(raw as SocialProvider)) {
    return NextResponse.redirect(new URL(`${backTo}?error=social_unknown`, req.url), 303);
  }
  const provider = raw as SocialProvider;
  const status = socialProviderStatus(provider);

  if (!status.ready) {
    logger.info('소셜 로그인 미연동 요청', { provider, missing: status.missing, mode });
    return NextResponse.redirect(
      new URL(`${backTo}?error=social_not_ready&provider=${provider}`, req.url),
      303,
    );
  }

  try {
    const state = generateToken(16);
    const authorizeUrl = getSocialAdapter(provider).getAuthorizeUrl(state);
    const res = NextResponse.redirect(authorizeUrl, 303);
    // CSRF 방어용 state 는 쿠키에 보관하고 콜백에서 대조한다.
    res.cookies.set(`givesign_social_state_${provider}`, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && env.baseUrl.startsWith('https'),
      path: '/',
      maxAge: 600,
    });
    res.cookies.set('givesign_social_mode', mode, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && env.baseUrl.startsWith('https'),
      path: '/',
      maxAge: 600,
    });
    return res;
  } catch (e) {
    const message =
      e instanceof SocialNotConfiguredError
        ? 'social_not_ready'
        : `social_error&detail=${encodeURIComponent(`${SOCIAL_LABEL[provider]} 연동이 준비되지 않았습니다.`)}`;
    logger.warn('소셜 로그인 시작 실패', { provider, message: (e as Error).message });
    return NextResponse.redirect(new URL(`${backTo}?error=${message}&provider=${provider}`, req.url), 303);
  }
}
