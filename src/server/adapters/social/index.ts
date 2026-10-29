import { env } from '@/lib/env';
import type { AdapterInfo } from '../types';

/**
 * 소셜 간편 로그인 어댑터 (카카오 / 네이버).
 *
 * 현재는 **연동 준비 단계**로, 실제 인증 API 를 호출하지 않는다.
 * 다른 외부 연동과 동일하게 어댑터 인터페이스만 먼저 정의하고,
 * 키가 설정되지 않은 상태에서 임의로 로그인 성공을 만들지 않는다.
 *
 * 실연동 시 필요한 것
 *  - 카카오: 카카오 디벨로퍼스 앱 생성, REST API 키, Redirect URI 등록, 동의항목 설정
 *  - 네이버: 네이버 개발자센터 앱 등록, Client ID/Secret, Callback URL 등록
 */

export type SocialProvider = 'kakao' | 'naver';

export const SOCIAL_PROVIDERS: SocialProvider[] = ['kakao', 'naver'];

export const SOCIAL_LABEL: Record<SocialProvider, string> = {
  kakao: '카카오',
  naver: '네이버',
};

export interface SocialProfile {
  provider: SocialProvider;
  /** 사업자 측 고유 사용자 식별자 */
  providerUserId: string;
  email?: string;
  name?: string;
}

export interface SocialTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface SocialAuthAdapter {
  info(): AdapterInfo;
  /** 동의 화면으로 보낼 URL */
  getAuthorizeUrl(state: string): string;
  /** 콜백 code -> 토큰 */
  exchangeCode(code: string, state: string): Promise<SocialTokens>;
  /** 토큰 -> 프로필 */
  getProfile(tokens: SocialTokens): Promise<SocialProfile>;
}

export interface SocialProviderStatus {
  provider: SocialProvider;
  label: string;
  /** 실제 연동 키가 모두 설정되어 사용 가능한 상태인지 */
  ready: boolean;
  /** 아직 없는 설정값 */
  missing: string[];
}

function configOf(provider: SocialProvider) {
  return provider === 'kakao' ? env.social.kakao : env.social.naver;
}

export function socialProviderStatus(provider: SocialProvider): SocialProviderStatus {
  const cfg = configOf(provider);
  const missing: string[] = [];
  if (!cfg.clientId) missing.push(provider === 'kakao' ? 'KAKAO_CLIENT_ID' : 'NAVER_CLIENT_ID');
  if (!cfg.clientSecret && provider === 'naver') missing.push('NAVER_CLIENT_SECRET');
  if (!cfg.redirectUri) missing.push(provider === 'kakao' ? 'KAKAO_REDIRECT_URI' : 'NAVER_REDIRECT_URI');

  return {
    provider,
    label: SOCIAL_LABEL[provider],
    ready: missing.length === 0,
    missing,
  };
}

export function allSocialProviderStatus(): SocialProviderStatus[] {
  return SOCIAL_PROVIDERS.map(socialProviderStatus);
}

export class SocialNotConfiguredError extends Error {
  constructor(public provider: SocialProvider, public missing: string[]) {
    super(`${SOCIAL_LABEL[provider]} 간편 로그인이 아직 연동되지 않았습니다.`);
    this.name = 'SocialNotConfiguredError';
  }
}

/**
 * 실 어댑터는 키 확보 후 이 위치에 추가한다.
 * 키가 없는 상태에서는 예외를 던져, 준비되지 않은 연동이 성공한 것처럼 보이지 않게 한다.
 */
export function getSocialAdapter(provider: SocialProvider): SocialAuthAdapter {
  const status = socialProviderStatus(provider);
  if (!status.ready) {
    throw new SocialNotConfiguredError(provider, status.missing);
  }
  throw new Error(
    `${SOCIAL_LABEL[provider]} 어댑터가 아직 구현되지 않았습니다. OAuth 앱 등록 후 구현하십시오.`,
  );
}
