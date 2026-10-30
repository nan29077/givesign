import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SOCIAL_PROVIDERS, getSocialAdapter, socialProviderStatus, type SocialProvider } from '@/server/adapters/social';
import { DonorMemberError, findDonationOrg, loginDonorWithSocial } from '@/server/services/donor-members';
import { safeEqual } from '@/lib/crypto';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 소셜 간편 로그인 콜백.
 *
 * 1) 기관 후원 회원(쿠키 givesign_social_mode=donor:<기관코드>)
 *    API 키가 설정되어 있으면 state 대조 → code 교환 → 프로필 조회 → 그 기관 후원 회원으로 로그인(없으면 가입).
 *    키가 없으면 로그인시키지 않고 그 기관 로그인 화면으로 돌려 "연동 준비 중"을 알린다.
 * 2) 통합 계정(관리자·기관·통합 후원자)
 *    아직 연동 전이다. 임의로 로그인시키지 않고 안내 화면으로 되돌린다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  if (!SOCIAL_PROVIDERS.includes(raw as SocialProvider)) {
    return NextResponse.redirect(new URL('/login?error=social_unknown', req.url), 303);
  }
  const provider = raw as SocialProvider;
  const status = socialProviderStatus(provider);
  const jar = await cookies();
  const mode = jar.get('givesign_social_mode')?.value ?? '';

  if (mode.startsWith('donor:')) {
    const org = await findDonationOrg(mode.slice('donor:'.length));
    if (!org) return NextResponse.redirect(new URL('/', req.url), 303);
    const back = `/donate/${org.code}/login`;
    const fail = (q: string) => {
      const res = NextResponse.redirect(new URL(`${back}?${q}&provider=${provider}`, req.url), 303);
      res.cookies.delete('givesign_social_mode');
      res.cookies.delete(`givesign_social_state_${provider}`);
      return res;
    };
    if (!status.ready) return fail('error=social_not_ready');
    const url = new URL(req.url);
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const saved = jar.get(`givesign_social_state_${provider}`)?.value ?? '';
    if (!code || !state || !saved || !safeEqual(state, saved)) return fail('error=social_error&detail=' + encodeURIComponent('로그인 요청이 만료되었습니다. 다시 시도해 주세요.'));
    try {
      const adapter = getSocialAdapter(provider);
      const profile = await adapter.getProfile(await adapter.exchangeCode(code, state));
      await loginDonorWithSocial(org, { provider, providerUserId: profile.providerUserId, email: profile.email, name: profile.name });
      const res = NextResponse.redirect(new URL(`/donate/${org.code}/my`, req.url), 303);
      res.cookies.delete('givesign_social_mode');
      res.cookies.delete(`givesign_social_state_${provider}`);
      return res;
    } catch (e) {
      logger.warn('후원 회원 소셜 로그인 실패', { provider, merchantId: org.id, message: (e as Error).message });
      const detail = e instanceof DonorMemberError ? e.message : '간편 로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.';
      return fail('error=social_error&detail=' + encodeURIComponent(detail));
    }
  }

  logger.info('소셜 로그인 콜백 수신(미연동)', { provider, ready: status.ready });
  return NextResponse.redirect(new URL(`/login?error=social_not_ready&provider=${provider}`, req.url), 303);
}
