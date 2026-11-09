import { contractIntegrations } from '@/lib/env';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';

/**
 * 시점확인(TSA, RFC 3161) 어댑터 (2026-11-13 5차 L1-4).
 *
 * 완료 문서 해시에 공인 시점 토큰을 붙이는 자리다. **실연동은 없다.**
 * mock 은 토큰을 만들지 않고 NOT_CONNECTED 를 돌려준다 — 가짜 토큰을 만들어 "시점확인 완료" 로 보이게 하지 않는다.
 * 실공급자(공인전자문서센터·TSA 기관)는 계약·규격 수령 후 구현한다.
 */

export interface TimestampAdapter {
  info(): AdapterInfo;
  /** sha256 hex 해시 → 시점 토큰(DER base64)과 시각 */
  stamp(documentHash: string): Promise<ProviderResult<{ token: string; stampedAt: Date }>>;
}

export const mockTimestampAdapter: TimestampAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async stamp() {
    return { ok: false, code: 'NOT_CONNECTED', message: '시점확인 미연동' };
  },
};

export function getTimestampAdapter(): TimestampAdapter {
  const p = contractIntegrations().timestampProvider;
  if (p === 'mock') return mockTimestampAdapter;
  return {
    info: () => ({ provider: p, mode: 'live', missingCredentials: ['규격 수령 후 구현'] }),
    stamp: async () => {
      throw new AdapterNotConfiguredError(p, ['규격 수령 후 구현']);
    },
  };
}
