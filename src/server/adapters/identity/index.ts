import { contractIntegrations } from '@/lib/env';
import { normalizePhone } from '@/lib/crypto';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';

/**
 * 본인인증 어댑터 (2026-11-13 5차 L1) — 휴대폰 본인확인(PASS·NICE 등).
 *
 * 흐름
 *   1) start({ requestToken, returnUrl })  → 공급자 인증창 주소
 *   2) 후원자가 공급자 창에서 인증 → 공급자가 우리 돌아오는 주소로 결과를 넘긴다
 *   3) fetchResult({ requestToken, payload }) → 이름·생년월일·휴대폰·CI
 *
 * 원칙
 *  - 결과 원문(이름·생년월일·CI)은 서비스가 바로 HMAC 으로 바꿔 저장한다. 어댑터는 DB 를 만지지 않는다.
 *  - mock 은 실제 본인인증이 아니다. 결과에 mock=true 가 붙고, 화면·증명서에 [MOCK] 으로 표시된다.
 *    운영에서 IDENTITY_REQUIRED_FOR_* 를 켰는데 mock 이면 부팅을 거부한다(env.contractBootProblems).
 *  - pass·nice 실연동은 **규격(연동 규격서·사이트 코드·암호화 키) 수령 후 구현**한다. 지금은 인터페이스만 있고
 *    공급자 API 를 지어내 부르지 않는다 — 지정하면 AdapterNotConfiguredError.
 */

export interface IdentityResult {
  /** 공급자가 확인한 실명 */
  name: string;
  /** YYYYMMDD */
  birthDate: string;
  /** 숫자만 */
  phone: string;
  /** 연계정보(CI). 서비스가 즉시 HMAC 으로 바꾼다. */
  ci: string;
  mock: boolean;
}

export interface IdentityAdapter {
  info(): AdapterInfo;
  start(input: { requestToken: string; returnUrl: string }): Promise<ProviderResult<{ redirectUrl: string }>>;
  fetchResult(input: { requestToken: string; payload: Record<string, unknown> }): Promise<ProviderResult<IdentityResult>>;
}

/** 모의 본인인증. /mock/identity 화면에서 입력한 값을 그대로 돌려준다(실제 확인 아님). */
export const mockIdentityAdapter: IdentityAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async start({ requestToken, returnUrl }) {
    return {
      ok: true,
      data: { redirectUrl: `/mock/identity?req=${encodeURIComponent(requestToken)}&return=${encodeURIComponent(returnUrl)}` },
    };
  },
  async fetchResult({ payload }) {
    const name = String(payload.name ?? '').trim();
    const birthDate = String(payload.birthDate ?? '').replace(/\D/g, '');
    const phone = normalizePhone(String(payload.phone ?? ''));
    if (payload.cancel === true || payload.cancel === '1') return { ok: false, code: 'CANCELED', message: '[MOCK] 본인인증을 취소했습니다.' };
    if (name.length < 2 || !/^\d{8}$/.test(birthDate) || !/^01\d{8,9}$/.test(phone)) {
      return { ok: false, code: 'INVALID', message: '[MOCK] 이름·생년월일(8자리)·휴대폰 번호를 확인해 주세요.' };
    }
    return { ok: true, data: { name, birthDate, phone, ci: `MOCKCI:${birthDate}:${phone}`, mock: true } };
  },
};

/** 실연동 자리. 규격 수령 후 구현한다(지금 호출하면 설정 오류). */
function notImplemented(provider: string): IdentityAdapter {
  return {
    info() {
      return { provider, mode: 'live', missingCredentials: ['규격 수령 후 구현'] };
    },
    async start() {
      throw new AdapterNotConfiguredError(provider, ['규격 수령 후 구현']);
    },
    async fetchResult() {
      throw new AdapterNotConfiguredError(provider, ['규격 수령 후 구현']);
    },
  };
}

export function getIdentityAdapter(): IdentityAdapter {
  const p = contractIntegrations().identityProvider;
  if (p === 'mock') return mockIdentityAdapter;
  // pass | nice | 그 밖: 규격 수령 후 구현
  return notImplemented(p);
}
