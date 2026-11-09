import { contractIntegrations } from '@/lib/env';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';

/**
 * 계좌 거래내역 자동 조회 어댑터 (2026-11-13 5차 L3 — 오픈뱅킹·펌뱅킹 계약 전).
 *
 * mock 은 시험 거래를 지어내지 않는다. 항상 "연동 안 됨"(NOT_CONNECTED)을 돌려준다.
 * 테스트만 `setMockBankFeedFixture` 로 고정 거래를 넣어 대사 경로(파일과 같은 정규화·중복 해시)를 검증한다.
 * 실공급자는 계약 후 구현한다(공급자 API 를 지어내 부르지 않는다).
 */

/** 공급자가 주는 거래 한 줄. 파일 업로드와 같은 정규화(parseStatementRows)를 거친다. */
export interface BankFeedTransaction {
  /** 'YYYY-MM-DD HH:mm:ss' 또는 'YYYY-MM-DD' (KST) — 은행 파일 날짜 칸과 같은 형식 */
  occurredAt: string;
  /** 입금액(원). 출금 줄은 0 이고 withdrawal 에 값 */
  deposit: bigint;
  withdrawal: bigint;
  /** 입금자명(통장 표시) */
  name: string;
  memo?: string | null;
  balance?: bigint | null;
}

export interface BankFeedAdapter {
  info(): AdapterInfo;
  fetchTransactions(input: { merchantId: string; from: Date; to: Date }): Promise<ProviderResult<{ transactions: BankFeedTransaction[] }>>;
}

let fixture: Map<string, BankFeedTransaction[]> | null = null;

/** 테스트 전용: 기관별 고정 거래. null 이면 지운다. 운영 코드에서 부르지 않는다. */
export function setMockBankFeedFixture(merchantId: string | null, rows?: BankFeedTransaction[]) {
  if (merchantId === null) {
    fixture = null;
    return;
  }
  fixture ??= new Map();
  fixture.set(merchantId, rows ?? []);
}

export const mockBankFeedAdapter: BankFeedAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async fetchTransactions({ merchantId }) {
    const rows = fixture?.get(merchantId);
    if (!rows) return { ok: false, code: 'NOT_CONNECTED', message: '계좌 거래내역 조회가 연동되지 않았습니다(오픈뱅킹·펌뱅킹 계약 전).' };
    return { ok: true, data: { transactions: rows } };
  },
};

export function getBankFeedAdapter(): BankFeedAdapter {
  const p = contractIntegrations().bankFeedProvider;
  if (p === 'mock') return mockBankFeedAdapter;
  return {
    info: () => ({ provider: p, mode: 'live', missingCredentials: ['계약 후 구현'] }),
    fetchTransactions: async () => {
      throw new AdapterNotConfiguredError(p, ['계약 후 구현']);
    },
  };
}
