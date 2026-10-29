import { NextResponse } from 'next/server';
import { SOCIAL_PROVIDERS, socialProviderStatus, type SocialProvider } from '@/server/adapters/social';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 소셜 간편 로그인 콜백 (연동 준비 단계).
 *
 * 실연동 시 이 자리에서 다음을 수행한다.
 *   1) state 쿠키와 콜백 state 대조 (CSRF 방어)
 *   2) code -> 토큰 교환
 *   3) 토큰 -> 프로필 조회
 *   4) provider + providerUserId 로 기존 계정 조회, 없으면 신규 가입
 *   5) createSession 으로 로그인 처리
 *
 * 아직 연동 키가 없으므로 임의로 로그인시키지 않고 안내 화면으로 되돌린다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  if (!SOCIAL_PROVIDERS.includes(raw as SocialProvider)) {
    return NextResponse.redirect(new URL('/login?error=social_unknown', req.url), 303);
  }
  const provider = raw as SocialProvider;
  const status = socialProviderStatus(provider);

  logger.info('소셜 로그인 콜백 수신(미연동)', { provider, ready: status.ready });

  return NextResponse.redirect(
    new URL(`/login?error=social_not_ready&provider=${provider}`, req.url),
    303,
  );
}
