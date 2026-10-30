import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { generateToken } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { SOCIAL_PROVIDERS, getSocialAdapter, socialProviderStatus, type SocialProvider } from '@/server/adapters/social';
import { findDonationOrg } from '@/server/services/donor-members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 기관 후원 회원 소셜 간편 로그인 시작 (카카오·네이버).
 *
 * 콜백은 통합 콜백(/api/auth/social/[provider]/callback)을 같이 쓰고, 쿠키 givesign_social_mode=donor:<기관코드> 로
 * 기관 후원 회원 로그인임을 표시한다. API 키가 없으면 인증을 시도하지 않고 로그인 화면으로 돌려 "연동 준비 중"을 알린다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ code: string; provider: string }> }) {
  const { code, provider: raw } = await ctx.params;
  const org = await findDonationOrg(code);
  if (!org) return NextResponse.redirect(new URL('/', req.url), 303);
  const back = `/donate/${org.code}/login`;
  if (!SOCIAL_PROVIDERS.includes(raw as SocialProvider)) {
    return NextResponse.redirect(new URL(`${back}?error=social_unknown`, req.url), 303);
  }
  const provider = raw as SocialProvider;
  const status = socialProviderStatus(provider);
  if (!status.ready) {
    logger.info('후원 회원 소셜 로그인 미연동 요청', { provider, merchantId: org.id, missing: status.missing });
    return NextResponse.redirect(new URL(`${back}?error=social_not_ready&provider=${provider}`, req.url), 303);
  }
  try {
    const state = generateToken(16);
    const res = NextResponse.redirect(getSocialAdapter(provider).getAuthorizeUrl(state), 303);
    const secure = process.env.NODE_ENV === 'production' && env.baseUrl.startsWith('https');
    res.cookies.set(`givesign_social_state_${provider}`, state, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 600 });
    res.cookies.set('givesign_social_mode', `donor:${org.code}`, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 600 });
    return res;
  } catch (e) {
    logger.warn('후원 회원 소셜 로그인 시작 실패', { provider, message: (e as Error).message });
    return NextResponse.redirect(new URL(`${back}?error=social_not_ready&provider=${provider}`, req.url), 303);
  }
}
