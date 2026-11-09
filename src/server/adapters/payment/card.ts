import { contractIntegrations, env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';
import { MockPaymentTimeout, getPaymentAdapter, type ApproveResult, type InquiryStatus } from './index';

/**
 * 카드 일시후원 결제 어댑터 (2026-11-13 5차 L2). 내통장결제(index.ts)와 **별도 공급자**다.
 *
 * 흐름(카드 PG 일반형)
 *   1) createCheckout  → 결제창 주소(후원자가 카드 인증)
 *   2) 결제창 인증 완료 → 우리 완료 지점(completeCardCheckout)이 인증 결과(authToken)를 받는다
 *   3) approve          → 승인(출금). 결과를 모르면 inquire 로 확정, 못 하면 결과 미확인(UNKNOWN)
 *   4) cancel           → 카드 취소(환불)
 *
 * 정기후원 카드 빌링은 만들지 않는다(계약·승인 범위 확인 필요) — 카드는 일시후원만.
 * 실공급자는 PG 규격 수령 후 구현한다(공급자 API 를 지어내 부르지 않는다).
 *
 * 결제 거래(payment_transaction.provider)에는 `card:{공급자}` 로 남겨 환불·대사가 이 어댑터로 간다.
 */

export const CARD_PROVIDER_PREFIX = 'card:';

export function isCardProvider(provider: string | null | undefined): boolean {
  return Boolean(provider && provider.startsWith(CARD_PROVIDER_PREFIX));
}

export interface CardCheckout {
  checkoutUrl: string;
  sessionId: string;
  expiresAt: Date;
  mock: boolean;
}

export interface CardPaymentAdapter {
  info(): AdapterInfo;
  createCheckout(input: { chargeId: string; amount: bigint; productName: string }): Promise<ProviderResult<CardCheckout>>;
  /** 결제창 인증 결과로 승인한다. 타임아웃이면 예외(MockPaymentTimeout 등) — 호출부가 inquire 로 확정한다. */
  approve(req: { orderNo: string; amount: bigint; authToken: string }): Promise<ProviderResult<ApproveResult>>;
  inquire(orderNo: string): Promise<ProviderResult<{ status: InquiryStatus; providerTid?: string; amount?: bigint }>>;
  cancel(input: { orderNo: string; providerTid: string; amount: bigint; reason?: string }): Promise<ProviderResult<{ canceledAt: Date }>>;
}

// ---------------------------------------------------------------------------
// Mock 카드. 계좌 mock 과 같은 금액 끝자리 규칙:
//   ...555 → 결제창 생성 실패 · ...999 → 승인 거절 · ...888 → 타임아웃 후 조회로 승인
//   ...777 → 타임아웃 후 조회로 실패 · ...666 → 타임아웃 + 조회 실패(결과 미확인) · ...444 → 승인되지만 취소 실패
// 실제 카드사에 아무것도 보내지 않는다. 결제창은 기브싸인 내부 모의 화면(/mock/pg/card)이다.
// ---------------------------------------------------------------------------

const approved = new Map<string, { tid: string; amount: bigint; at: Date; canceled?: boolean }>();
const timeouts = new Map<string, 'APPROVED' | 'FAILED' | 'UNKNOWN'>();
let seq = 0;

export function resetMockCardState() {
  approved.clear();
  timeouts.clear();
  seq = 0;
}

export const mockCardAdapter: CardPaymentAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async createCheckout({ chargeId, amount }) {
    if (Number(amount % 1000n) === 555) return { ok: false, code: 'C0555', message: '[MOCK] 카드 결제창을 만들지 못했습니다.' };
    seq += 1;
    const sessionId = `MOCKCARD-${chargeId}-${seq}`;
    return {
      ok: true,
      data: {
        checkoutUrl: `/mock/pg/card?session=${encodeURIComponent(sessionId)}`,
        sessionId,
        expiresAt: new Date(Date.now() + env.payment.pinTtlSec * 1000),
        mock: true,
      },
    };
  },
  async approve(req) {
    const tail = Number(req.amount % 1000n);
    if (tail === 999) return { ok: false, code: 'C0001', message: '[MOCK] 카드 승인이 거절되었습니다(한도 초과 등).' };
    if (tail === 888 || tail === 777 || tail === 666) {
      timeouts.set(req.orderNo, tail === 888 ? 'APPROVED' : tail === 777 ? 'FAILED' : 'UNKNOWN');
      if (tail === 888 || tail === 666) approved.set(req.orderNo, { tid: `MOCKCARDTID-${req.orderNo}`, amount: req.amount, at: new Date() });
      throw new MockPaymentTimeout(req.orderNo);
    }
    const prev = approved.get(req.orderNo);
    if (prev) return { ok: true, data: { providerTid: prev.tid, approvedAt: prev.at, amount: prev.amount } };
    const rec = { tid: `MOCKCARDTID-${req.orderNo}`, amount: req.amount, at: new Date() };
    approved.set(req.orderNo, rec);
    return { ok: true, data: { providerTid: rec.tid, approvedAt: rec.at, amount: rec.amount } };
  },
  async inquire(orderNo) {
    const forced = timeouts.get(orderNo);
    if (forced === 'UNKNOWN') return { ok: false, code: 'C0999', message: '[MOCK] 카드 거래 조회에 실패했습니다.' };
    if (forced === 'FAILED') return { ok: true, data: { status: 'FAILED' } };
    const rec = approved.get(orderNo);
    if (!rec) return { ok: true, data: { status: 'NOT_FOUND' } };
    if (rec.canceled) return { ok: true, data: { status: 'CANCELED', providerTid: rec.tid, amount: rec.amount } };
    return { ok: true, data: { status: 'APPROVED', providerTid: rec.tid, amount: rec.amount } };
  },
  async cancel({ orderNo }) {
    const rec = approved.get(orderNo);
    if (!rec) return { ok: false, code: 'C0404', message: '[MOCK] 취소할 카드 거래를 찾을 수 없습니다.' };
    if (Number(rec.amount % 1000n) === 444) return { ok: false, code: 'C0444', message: '[MOCK] 카드 취소가 거절되었습니다.' };
    rec.canceled = true;
    return { ok: true, data: { canceledAt: new Date() } };
  },
};

export function cardPaymentEnabled(): boolean {
  return contractIntegrations().cardEnabled;
}

export function getCardAdapter(): CardPaymentAdapter {
  const p = contractIntegrations().cardProvider;
  if (env.safety.safeMode && p !== 'mock') {
    logger.warn('SAFE_MODE 가 켜져 있어 실제 카드 결제를 차단하고 mock 으로 대체합니다.');
    return mockCardAdapter;
  }
  if (p === 'mock') return mockCardAdapter;
  // 계약 PG 의 규격 수령 후 구현한다. 지금 지정하면 mock 으로 조용히 바꾸지 않고 설정 오류로 막는다.
  throw new AdapterNotConfiguredError(`card:${p}`, ['카드 PG 규격 수령 후 구현']);
}

/** 결제 거래에 남길 공급자 값 */
export function cardTransactionProvider(adapter: CardPaymentAdapter = getCardAdapter()): string {
  return `${CARD_PROVIDER_PREFIX}${adapter.info().provider}`;
}

/**
 * 결제 거래의 공급자 값으로 취소·조회 어댑터를 고른다. 카드 거래가 아니면 기존 결제 어댑터 그대로다
 * (카드 결제를 끈 환경에는 card: 거래가 없으므로 결과가 예전과 같다).
 */
export function cancelAdapterFor(provider: string | null | undefined): Pick<CardPaymentAdapter, 'cancel' | 'inquire'> {
  if (!isCardProvider(provider)) return getPaymentAdapter();
  const name = provider!.slice(CARD_PROVIDER_PREFIX.length);
  if (name === 'mock') return mockCardAdapter;
  return getCardAdapter();
}
