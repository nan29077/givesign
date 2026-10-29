import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * 지급대행 어댑터.
 *
 * 정산금을 사회복지기관 계좌로 실제 이체하는 외부 서비스다.
 * 결제 어댑터와 같은 구조로, 실제 계약·키가 없으면 mock 으로만 동작하고
 * 화면과 로그에 mock 임을 명시한다(성공을 꾸며내지 않는다).
 *
 * 이중 지급 방지
 *   요청마다 `requestId` 를 멱등키로 넘긴다. 같은 키로 두 번 호출되면
 *   대행사는 새로 이체하지 않고 앞선 결과를 그대로 돌려줘야 한다.
 *   네트워크 오류로 결과를 못 받은 경우에는 inquire() 로 확정한다. 절대 재이체하지 않는다.
 */

export interface PayoutRequest {
  /** 정산 회차 ID. 멱등키로 그대로 쓴다. */
  requestId: string;
  merchantName: string;
  bankCode: string;
  /** 복호화된 계좌번호. 로그에 남기지 않는다. */
  accountNo: string;
  holderName: string;
  /** 실제 이체 금액(원천징수 제외) */
  amount: bigint;
  memo?: string;
}

export interface PayoutResult {
  ok: boolean;
  referenceNo?: string;
  /** 실패 사유 코드 (ACCOUNT_INVALID · HOLDER_MISMATCH · LIMIT · PROVIDER_ERROR · TIMEOUT) */
  code?: string;
  message: string;
  /** 결과를 확정하지 못했다. 조회로 확정해야 한다(재이체 금지). */
  unknown?: boolean;
  mock: boolean;
}

export interface PayoutAdapter {
  info(): { provider: string; mode: 'mock' | 'live'; missingCredentials: string[] };
  transfer(req: PayoutRequest): Promise<PayoutResult>;
  inquire(requestId: string): Promise<PayoutResult>;
}

const mockResults = new Map<string, PayoutResult>();
/** 조회로도 결과를 확정할 수 없는 요청(계좌번호 끝 8888). */
const unresolvableRequests = new Set<string>();

export function resetMockPayoutState() {
  mockResults.clear();
  unresolvableRequests.clear();
}

export const mockPayoutAdapter: PayoutAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },

  async transfer(req) {
    const seen = mockResults.get(req.requestId);
    if (seen) return seen;

    let result: PayoutResult;
    if (req.accountNo.endsWith('0000')) {
      result = { ok: false, code: 'ACCOUNT_INVALID', message: '[MOCK] 계좌번호가 올바르지 않습니다.', mock: true };
    } else if (req.accountNo.endsWith('9999')) {
      result = { ok: false, code: 'TIMEOUT', message: '[MOCK] 응답을 받지 못했습니다.', unknown: true, mock: true };
    } else if (req.accountNo.endsWith('8888')) {
      // 이체 결과를 못 받았고, 조회로도 확정되지 않는 경우.
      // 실제 지급대행은 이체 직후 조회에서 전파 지연으로 NOT_FOUND/PENDING 을 흔히 준다.
      // 이 분기가 없으면 "실패로 확정" 경로를 어떤 테스트도 밟지 못한다.
      result = { ok: false, code: 'TIMEOUT', message: '[MOCK] 응답을 받지 못했습니다.', unknown: true, mock: true };
    } else {
      result = {
        ok: true,
        referenceNo: `MOCKPAY-${req.requestId.slice(-10)}`,
        message: '[MOCK] 이체를 요청했습니다.',
        mock: true,
      };
    }

    mockResults.set(req.requestId, result);
    if (req.accountNo.endsWith('8888')) unresolvableRequests.add(req.requestId);
    logger.warn('[MOCK] 지급대행 이체 — 실제 이체가 아닙니다.', {
      requestId: req.requestId,
      amount: req.amount.toString(),
      ok: result.ok,
    });
    return result;
  },

  async inquire(requestId) {
    const seen = mockResults.get(requestId);
    if (!seen) {
      return { ok: false, code: 'NOT_FOUND', message: '[MOCK] 이체 요청을 찾을 수 없습니다.', mock: true };
    }
    if (seen.unknown) {
      // 8888 계좌는 조회로도 확정되지 않는다(미확정 유지).
      if (unresolvableRequests.has(requestId)) {
        return { ok: false, code: 'PENDING', message: '[MOCK] 아직 처리 결과를 확인할 수 없습니다.', unknown: true, mock: true };
      }
      const settled: PayoutResult = {
        ok: true,
        referenceNo: `MOCKPAY-${requestId.slice(-10)}`,
        message: '[MOCK] 조회 결과 이체가 완료되어 있었습니다.',
        mock: true,
      };
      mockResults.set(requestId, settled);
      return settled;
    }
    return seen;
  },
};

export function getPayoutAdapter(): PayoutAdapter {
  if (env.payout.provider !== 'mock') {
    // 실연동 어댑터가 없는데 mock 을 돌려주면, 이체가 0원인 채로 markSettlementPaid 가
    // 원장에 지급 분개를 남긴다(append-only 라 반대분개 없이는 되돌릴 수도 없다).
    // 구현되지 않은 연동은 성공으로 만들지 않는다 — 배치가 실패하고 알림이 뜨는 편이 낫다.
    logger.error('지급대행 실연동 어댑터가 없습니다. 지급을 중단합니다.', {
      provider: env.payout.provider,
    });
    throw new Error(
      `지급대행 연동(${env.payout.provider})이 구현되지 않았습니다. PAYOUT_PROVIDER=mock 으로 두거나 실연동 어댑터를 붙여 주세요.`,
    );
  }
  return mockPayoutAdapter;
}
