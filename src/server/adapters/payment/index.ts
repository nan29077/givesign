import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';
// hecto.ts 는 이 파일에서 '타입만' 가져오므로 런타임 순환 참조는 생기지 않는다.
import { hectoPaymentAdapter } from './hecto';
import { mockPinUrl } from './mock-pin';

export { mockPinUrl } from './mock-pin';

/**
 * 결제 어댑터 (헥토파이낸셜 내통장결제 EzAuth 기준 인터페이스).
 *
 * 실제 흐름
 *   1) 결제창에서 계좌 인증 + 출금이체 등록  → createRegistrationSession / completeRegistration
 *   2) 빌키(자동결제 키) 발급               → completeRegistration 결과
 *   3) MO 수신 시 PIN 인증 링크 발급        → requestPinLink
 *   4) 후원자가 PIN 입력 → 결제사 콜백      → (앱: /api/webhooks/pin-callback)
 *   5) 콜백 수신 후 빌키로 승인             → approve
 *   6) 타임아웃 시 거래결과조회로 확정      → inquire
 *   7) 취소/환불                            → cancel
 *
 * 주의: 헥토 공식 제약상 결제인증 완료 후 10분 이내에 승인 API 를 호출해야 한다.
 *       기브싸인는 CONFIRM_LINK 유효시간을 그보다 짧게(기본 300초) 운용한다.
 */

/**
 * 등록할 결제수단 종류.
 * ACCOUNT = 내통장결제 계좌 빌키(현재 운영), CARD = 카드 빌링키(구조만 준비, 실 연동 전).
 */
export type PaymentMethodKind = 'ACCOUNT' | 'CARD';

export interface RegistrationSession {
  /** 결제창 리다이렉트 URL */
  redirectUrl: string;
  providerTid: string;
  expiresAt: Date;
}

export interface RegistrationResult {
  providerTid: string;
  billKey: string;
  /** 발급된 빌키의 종류. 응답에 없으면 ACCOUNT 로 본다. */
  method?: PaymentMethodKind;
  bankCode?: string;
  bankName?: string;
  accountTail4?: string;
  /** 카드 빌링키일 때만 채워진다. 카드번호 원문은 어떤 경우에도 저장하지 않는다. */
  cardIssuer?: string;
  cardTail4?: string;
}

/**
 * 결제사가 발급하는 PIN 입력 세션.
 *
 * 후원자는 이 URL 에서 PIN 을 입력하고, 결제사가 완료 콜백을 보내면
 * 그때 승인(approve)이 실행된다. 링크 발급 자체는 출금이 아니다.
 */
export interface PinLinkSession {
  /** 후원자에게 MT 로 보낼 PIN 입력 URL */
  pinUrl: string;
  /** 결제사 인증 세션 식별자 */
  sessionId: string;
  expiresAt: Date;
  /**
   * 실제 결제사 연동이 아니라 mock 발급인지 여부.
   * true 이면 화면·문자·로그에 [MOCK] 을 표시해야 한다(계약 전 연동을 성공으로 오인하지 않도록).
   */
  mock: boolean;
}

export interface ApproveRequest {
  orderNo: string;
  amount: bigint;
  billKey: string;
  productName: string;
  buyerName?: string;
}

export interface ApproveResult {
  providerTid: string;
  approvedAt: Date;
  amount: bigint;
}

export type InquiryStatus = 'APPROVED' | 'FAILED' | 'CANCELED' | 'NOT_FOUND' | 'PENDING';

export interface PaymentAdapter {
  info(): AdapterInfo;
  createRegistrationSession(input: {
    payerRef: string;
    returnUrl: string;
    notifyUrl: string;
    /** 생략하면 ACCOUNT. 카드 빌링키는 규격 수령 후 어댑터에서 분기한다. */
    method?: PaymentMethodKind;
  }): Promise<ProviderResult<RegistrationSession>>;
  completeRegistration(payload: Record<string, unknown>): Promise<ProviderResult<RegistrationResult>>;
  /**
   * 등록된 빌키로 결제하기 위한 PIN 입력 링크를 결제사에 요청한다.
   *
   * 이 호출은 출금을 일으키지 않는다. 후원자가 PIN 을 입력해야 결제사가 콜백을 보내고,
   * 그 콜백을 받은 뒤에야 approve() 로 실제 승인이 이루어진다.
   *
   * @param chargeId 결제 거래 ID. 콜백에서 거래를 식별하는 키로 쓴다.
   * @param amount     결제 금액(원). 금액은 전 구간 bigint 로 다룬다.
   * @param phone      후원자 전화번호(정규화된 원문). 결제사 인증 대상 확인용이며 저장하지 않는다.
   * @param method     인증할 결제수단 종류. 생략하면 ACCOUNT(내통장결제 계좌 빌키).
   */
  requestPinLink(
    chargeId: string,
    amount: bigint,
    phone: string,
    method?: PaymentMethodKind,
  ): Promise<ProviderResult<PinLinkSession>>;
  approve(req: ApproveRequest): Promise<ProviderResult<ApproveResult>>;
  /** 타임아웃/불확실 상태에서 반드시 호출하여 최종 상태를 확정한다. */
  inquire(orderNo: string): Promise<ProviderResult<{ status: InquiryStatus; providerTid?: string; amount?: bigint }>>;
  cancel(input: { orderNo: string; providerTid: string; amount: bigint; reason?: string }): Promise<ProviderResult<{ canceledAt: Date }>>;
  revokeBillKey(billKey: string): Promise<ProviderResult<{ revokedAt: Date }>>;
}

// ---------------------------------------------------------------------------
// Mock 결제 어댑터
// 테스트 시나리오를 재현하기 위해 금액 끝자리로 결과를 제어한다.
//   ...999 → 승인 실패
//   ...888 → 타임아웃 (이후 inquire 로 APPROVED 확정)
//   ...777 → 타임아웃 (이후 inquire 로 FAILED 확정)
//   ...666 → 타임아웃 + inquire 도 실패 (결과 미확인 = UNKNOWN 경로)
//   ...555 → PIN 링크 발급 실패 (승인 단계까지 가지 않는다)
//   ...444 → 승인은 되지만 취소(환불)가 실패 (환불 경로의 PG 취소 실패)
//   그 외   → PIN 링크 발급 성공 / 승인 성공
// PIN 을 끝까지 입력하지 않는 시나리오는 콜백을 호출하지 않는 것으로 재현한다.
// ---------------------------------------------------------------------------

const approvedOrders = new Map<string, { tid: string; amount: bigint; at: Date; canceled?: boolean }>();
const timeoutOrders = new Map<string, 'APPROVED' | 'FAILED' | 'UNKNOWN'>();
let mockPinSeq = 0;

export function resetMockPaymentState() {
  approvedOrders.clear();
  timeoutOrders.clear();
  mockPinSeq = 0;
}



export class MockPaymentTimeout extends Error {
  constructor(public orderNo: string) {
    super(`결제 요청 타임아웃: ${orderNo}`);
    this.name = 'MockPaymentTimeout';
  }
}

export const mockPaymentAdapter: PaymentAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },

  async createRegistrationSession({ payerRef, returnUrl, method = 'ACCOUNT' }) {
    const tid = `MOCKREG${Date.now()}`;
    return {
      ok: true,
      data: {
        // Mock 결제창. 실제 헥토 결제창을 대체하는 내부 화면
        redirectUrl: `/mock/pg/register?tid=${tid}&ref=${encodeURIComponent(payerRef)}&method=${method}&return=${encodeURIComponent(returnUrl)}`,
        providerTid: tid,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    };
  },

  async completeRegistration(payload) {
    const tid = String(payload.tid ?? `MOCKREG${Date.now()}`);
    const method: PaymentMethodKind = payload.method === 'CARD' ? 'CARD' : 'ACCOUNT';

    if (method === 'CARD') {
      const card = String(payload.card ?? '1234567812349876');
      return {
        ok: true,
        data: {
          providerTid: tid,
          method,
          billKey: `MOCKCARDBILL-${tid}-${card.slice(-4)}`,
          cardIssuer: String(payload.cardIssuer ?? '테스트카드'),
          cardTail4: card.slice(-4),
        },
      };
    }

    const bank = String(payload.bankCode ?? '004');
    const account = String(payload.account ?? '11122233344455');
    return {
      ok: true,
      data: {
        providerTid: tid,
        method,
        billKey: `MOCKBILL-${tid}-${account.slice(-4)}`,
        bankCode: bank,
        bankName: String(payload.bankName ?? 'KB국민은행'),
        accountTail4: account.slice(-4),
      },
    };
  },

  /**
   * Mock PIN 링크 발급.
   * 실제 결제사에 아무것도 보내지 않으며, 기브싸인 내부의 모의 PIN 화면 주소를 돌려준다.
   */
  async requestPinLink(chargeId, amount, _phone, method = 'ACCOUNT') {
    if (Number(amount % 1000n) === 555) {
      return { ok: false, code: 'M0555', message: 'PIN 인증창을 생성하지 못했습니다.' };
    }
    mockPinSeq += 1;
    const sessionId = `MOCKPIN-${chargeId}-${mockPinSeq}`;
    return {
      ok: true,
      data: {
        pinUrl: mockPinUrl(sessionId),
        sessionId,
        expiresAt: new Date(Date.now() + env.payment.pinTtlSec * 1000),
        mock: true,
      },
      raw: { method } as Record<string, unknown>,
    };
  },

  async approve(req) {
    const tail = Number(req.amount % 1000n);
    if (tail === 999) {
      return { ok: false, code: 'M0001', message: '잔액 부족 또는 출금 불가 계좌입니다.' };
    }
    if (tail === 888 || tail === 777 || tail === 666) {
      timeoutOrders.set(req.orderNo, tail === 888 ? 'APPROVED' : tail === 777 ? 'FAILED' : 'UNKNOWN');
      if (tail === 888 || tail === 666) {
        // 실제로는 승인되었으나 응답만 유실된 상황을 재현.
        // 666 은 조회까지 실패해 "출금 여부를 모르는" 상태로 남는다(가장 위험한 경우다).
        approvedOrders.set(req.orderNo, { tid: `MOCKTID-${req.orderNo}`, amount: req.amount, at: new Date() });
      }
      throw new MockPaymentTimeout(req.orderNo);
    }
    if (approvedOrders.has(req.orderNo)) {
      // 동일 주문번호 재요청은 기존 승인 결과를 그대로 반환한다(멱등).
      const prev = approvedOrders.get(req.orderNo)!;
      return { ok: true, data: { providerTid: prev.tid, approvedAt: prev.at, amount: prev.amount } };
    }
    const tid = `MOCKTID-${req.orderNo}`;
    const at = new Date();
    approvedOrders.set(req.orderNo, { tid, amount: req.amount, at });
    return { ok: true, data: { providerTid: tid, approvedAt: at, amount: req.amount }, latencyMs: 30 };
  },

  async inquire(orderNo) {
    const forced = timeoutOrders.get(orderNo);
    if (forced === 'UNKNOWN') {
      // 조회 자체가 실패한다. 상위 흐름은 결과를 단정하지 말고 UNKNOWN 으로 남겨야 한다.
      return { ok: false, code: 'M0999', message: '[MOCK] 거래결과조회에 실패했습니다.' };
    }
    if (forced === 'FAILED') return { ok: true, data: { status: 'FAILED' } };
    const rec = approvedOrders.get(orderNo);
    if (!rec) return { ok: true, data: { status: 'NOT_FOUND' } };
    if (rec.canceled) return { ok: true, data: { status: 'CANCELED', providerTid: rec.tid, amount: rec.amount } };
    return { ok: true, data: { status: 'APPROVED', providerTid: rec.tid, amount: rec.amount } };
  },

  async cancel({ orderNo }) {
    const rec = approvedOrders.get(orderNo);
    if (!rec) return { ok: false, code: 'M0404', message: '취소할 거래를 찾을 수 없습니다.' };
    // 결제사가 취소를 거절하는 경우. 이 분기가 없으면 "PG 는 취소를 거절했는데
    // 원장에는 환불 반대분개가 쌓이는" 회귀를 테스트가 잡지 못한다.
    if (Number(rec.amount % 1000n) === 444) {
      return { ok: false, code: 'M0444', message: '[MOCK] 취소할 수 없는 거래입니다.' };
    }
    rec.canceled = true;
    return { ok: true, data: { canceledAt: new Date() } };
  },

  async revokeBillKey() {
    return { ok: true, data: { revokedAt: new Date() } };
  },
};

export function getPaymentAdapter(): PaymentAdapter {
  if (env.safety.safeMode && env.payment.provider !== 'mock') {
    logger.warn('SAFE_MODE 가 켜져 있어 실제 결제를 차단하고 mock 으로 대체합니다.');
    return mockPaymentAdapter;
  }
  switch (env.payment.provider) {
    case 'mock':
      return mockPaymentAdapter;
    case 'hecto': {
      // 키가 하나라도 없으면 mock 으로 조용히 대체하지 않고 즉시 실패시킨다.
      // (실결제로 착각한 채 운영되는 상황이 가장 위험하다)
      const adapter = hectoPaymentAdapter;
      const missing = adapter.info().missingCredentials;
      if (missing.length > 0) throw new AdapterNotConfiguredError('hecto', missing);
      return adapter;
    }
    default:
      throw new Error(`PAYMENT_PROVIDER=${env.payment.provider} 어댑터가 구현되지 않았습니다.`);
  }
}
