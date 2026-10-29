/**
 * 외부 연동 Provider Adapter 공통 타입.
 *
 * 원칙
 *  - 실제 계약/키가 없는 기능은 절대 임의로 "성공"을 반환하지 않는다.
 *  - 각 어댑터는 mock 구현을 기본으로 제공하고, 실 사업자 구현은 별도 파일로 추가한다.
 *  - 어댑터는 DB 를 직접 만지지 않는다. 순수하게 외부 통신만 담당한다.
 */

export type AdapterMode = 'mock' | 'live';

export interface AdapterInfo {
  /** 사업자 코드 (mock, hecto, google, ...) */
  provider: string;
  mode: AdapterMode;
  /** 실연동에 필요하지만 아직 없는 항목 */
  missingCredentials: string[];
}

export class AdapterNotConfiguredError extends Error {
  constructor(provider: string, missing: string[]) {
    super(`[${provider}] 실연동에 필요한 설정이 없습니다: ${missing.join(', ')}`);
    this.name = 'AdapterNotConfiguredError';
  }
}

export interface ProviderResult<T> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
  /** 마스킹된 원본 응답 (로그/감사용) */
  raw?: Record<string, unknown>;
  latencyMs?: number;
}
