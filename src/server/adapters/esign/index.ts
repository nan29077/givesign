import { env, isLocal } from '@/lib/env';
import { generateToken } from '@/lib/crypto';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';

/**
 * 전자서명 어댑터 (페이싸인 · 모두싸인 등).
 *
 * 약정서는 전자서명 없이도 "동의 기록(시각·IP·약관 버전) + 내용 해시" 로 성립한다.
 * 기관이 서명 이미지가 들어간 서류를 원하거나, 계좌 CMS 출금동의처럼 법이 정한 방식이 필요할 때
 * 이 어댑터로 서명 요청을 보낸다. 결과는 콜백(/api/esign/callback)으로 받는다.
 *
 * mock 은 실제 서명 요청을 보내지 않는다. 로컬에서만 열리는 모의 서명 화면(/mock/esign/[id])에서
 * 사람이 직접 [서명]/[거절] 을 눌러야 결과가 난다 — 자동으로 "서명 완료" 를 만들지 않는다(절대 규칙 2).
 */

export interface ESignRequest {
  docNo: string;
  title: string;
  /** 서명자 (복호화된 휴대폰 번호. 로그에 남기지 않는다) */
  signerPhone: string;
  signerName: string;
  /** 서명 화면에 보여 줄 본문(서식 렌더 결과) */
  body: string;
  contentHash: string;
}

export interface ESignRequestResult {
  requestId: string;
  /** 서명자에게 보낼 서명 화면 주소 */
  signUrl: string;
}

export interface ESignAdapter {
  info(): AdapterInfo;
  request(req: ESignRequest): Promise<ProviderResult<ESignRequestResult>>;
}

export const mockESignAdapter: ESignAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async request() {
    const requestId = `ESMOCK${generateToken(9).replace(/[^0-9A-Za-z]/g, '').slice(0, 12)}`;
    return {
      ok: true,
      data: { requestId, signUrl: `${env.baseUrl}/mock/esign/${requestId}` },
      latencyMs: 3,
    };
  },
};

function notConfigured(provider: string): ESignAdapter {
  return {
    info() {
      return { provider, mode: 'live', missingCredentials: [`${provider.toUpperCase()}_API_KEY 연동 구현`] };
    },
    async request() {
      const err = new AdapterNotConfiguredError(provider, [`${provider.toUpperCase()}_API_KEY`]);
      return { ok: false, code: 'NOT_CONFIGURED', message: err.message };
    },
  };
}

export function getESignAdapter(): ESignAdapter {
  switch (env.automation.esignProvider) {
    case 'mock':
      return mockESignAdapter;
    default:
      return notConfigured(env.automation.esignProvider);
  }
}

/** 모의 서명 화면을 열어도 되는지 (로컬 + mock 공급자) */
export function mockESignPageAllowed(): boolean {
  return isLocal && env.automation.esignProvider === 'mock';
}
