import crypto from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';
import type {
  ApproveRequest,
  ApproveResult,
  InquiryStatus,
  PaymentAdapter,
  PaymentMethodKind,
  PinLinkSession,
  RegistrationResult,
  RegistrationSession,
} from './index';
import { mockPinUrl } from './mock-pin';

/**
 * 헥토파이낸셜 내통장결제(EzAuth) 어댑터.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 계약 진행 중(구두 계약 완료) 상태에서 미리 구현한 것이다.
 * 서명·암호화·상태 매핑 로직은 완성되어 있고 단위 테스트로 검증한다.
 * **연동규격서 수령 후 반드시 대조할 것**: 아래 SPEC 블록의 엔드후원금 경로와
 * 필드명은 공개 문서 기준 값이므로, 상점별 규격서와 다르면 이 블록만 고치면 된다.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 호스트가 두 개인 점에 특히 주의한다.
 *  - 결제창(UI):  https://ezauth.settlebank.co.kr        (SettlePay.js 로드 / 인증창)
 *  - 서버 API:    https://ezauthapi.settlebank.co.kr:8081 (승인·조회·취소·빌키)
 * 하나로 합치면 승인 요청이 결제창 호스트로 나가 전건 실패한다.
 */

/** 연동규격서와 대조해야 하는 값 모음. 규격서 수령 시 여기만 수정한다. */
export const HECTO_SPEC = {
  /** 결제창(계좌 인증 + 출금이체 등록) */
  authWindowPath: '/auth/main.do',
  scriptPath: '/js/SettlePay.js',
  /** 승인 (빌키 결제) */
  approvePath: '/v3/APIPayApprov.do',
  /** 거래결과조회 */
  inquirePath: '/v3/APIPayInquiry.do',
  /** 취소/환불 */
  cancelPath: '/v3/APIPayCancel.do',
  /** 빌키 발급/해지 */
  billKeyPath: '/v3/APIRegularpayKey.do',
  /**
   * 결제 PIN 인증창 발급.
   * TODO(계약 후): 연동규격서를 받아 실제 경로·필드명으로 교체한다.
   * 지금 값은 추정이며, 실제 호출에는 사용하지 않는다(아래 requestPinLink 참고).
   */
  pinAuthPath: '/v3/APIPayAuth.do',
  /** 성공 응답 코드 */
  successCode: '0000',
} as const;

const TIMEOUT_MS = 20_000;

function requiredCredentials(): string[] {
  const missing: string[] = [];
  if (!env.payment.hectoMid) missing.push('HECTO_MID');
  if (!env.payment.hectoHashKey) missing.push('HECTO_HASH_KEY');
  if (!env.payment.hectoAesKey) missing.push('HECTO_AES_KEY');
  if (!env.payment.hectoCallbackUrl) missing.push('HECTO_CALLBACK_URL');
  return missing;
}

function assertConfigured(): void {
  const missing = requiredCredentials();
  if (missing.length > 0) throw new AdapterNotConfiguredError('hecto', missing);
}

// ---------------------------------------------------------------------------
// 서명 / 암호화
// ---------------------------------------------------------------------------

/** yyyyMMdd (KST) */
export function hectoDay(at: Date): string {
  const kst = new Date(at.getTime() + 9 * 3600_000);
  return kst.toISOString().slice(0, 10).replace(/-/g, '');
}

/** HHmmss (KST) */
export function hectoTime(at: Date): string {
  const kst = new Date(at.getTime() + 9 * 3600_000);
  return kst.toISOString().slice(11, 19).replace(/:/g, '');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 서버 API 서명.
 * signature = SHA256(mercntId + authNo + reqDay + reqTime + hashKey)
 */
export function apiSignature(input: {
  mercntId: string;
  authNo: string;
  reqDay: string;
  reqTime: string;
  hashKey: string;
}): string {
  return sha256Hex(`${input.mercntId}${input.authNo}${input.reqDay}${input.reqTime}${input.hashKey}`);
}

/**
 * 결제창 위변조 검증 해시.
 * hash = SHA256(mercntId + ordNo + trDay + trTime + 평문금액 + callbackUrl호스트 + hashKey)
 * 금액은 **암호화 전 평문**을 넣어야 한다. 암호문을 넣으면 검증에 실패한다.
 */
export function authWindowHash(input: {
  mercntId: string;
  ordNo: string;
  trDay: string;
  trTime: string;
  trPricePlain: string;
  callbackUrlHost: string;
  hashKey: string;
}): string {
  return sha256Hex(
    `${input.mercntId}${input.ordNo}${input.trDay}${input.trTime}${input.trPricePlain}${input.callbackUrlHost}${input.hashKey}`,
  );
}

/** 호스트만 뽑는다(스킴·경로 제외). 해시 재료 규격이 호스트만 요구한다. */
export function callbackHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** AES-256-ECB / PKCS#7 / Base64 — custCi, trPrice 등 민감 필드에 적용한다. */
export function hectoEncrypt(plain: string, key = env.payment.hectoAesKey): string {
  const keyBuf = Buffer.from(key, 'utf8');
  if (keyBuf.length !== 32) {
    throw new Error(`HECTO_AES_KEY 는 32바이트여야 합니다. (현재 ${keyBuf.length}바이트)`);
  }
  const cipher = crypto.createCipheriv('aes-256-ecb', keyBuf, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}

export function hectoDecrypt(encoded: string, key = env.payment.hectoAesKey): string {
  const keyBuf = Buffer.from(key, 'utf8');
  const decipher = crypto.createDecipheriv('aes-256-ecb', keyBuf, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HectoResponse {
  outStatCd?: string;
  outRsltCd?: string;
  outRsltMsg?: string;
  [key: string]: unknown;
}

async function postJson(path: string, body: Record<string, unknown>): Promise<{
  ok: boolean;
  status: number;
  json: HectoResponse;
  latencyMs: number;
}> {
  const url = `${env.payment.hectoAuthApiBase}${path}`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: HectoResponse = {};
    try {
      json = JSON.parse(text) as HectoResponse;
    } catch {
      json = { outRsltMsg: text.slice(0, 500) };
    }
    return { ok: res.ok, status: res.status, json, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** 헥토 응답이 성공인지 판정한다. 성공 코드가 아니면 절대 성공으로 취급하지 않는다. */
function isSuccess(json: HectoResponse): boolean {
  const code = json.outRsltCd ?? json.outStatCd;
  return code === HECTO_SPEC.successCode;
}

function failure(json: HectoResponse, fallback: string): ProviderResult<never> {
  return {
    ok: false,
    code: String(json.outRsltCd ?? json.outStatCd ?? 'UNKNOWN'),
    message: String(json.outRsltMsg ?? fallback),
    raw: json as Record<string, unknown>,
  };
}

/**
 * 승인 응답이 "확정 실패" 인지 "결과 불확실" 인지 가른다.
 *
 * 5xx·502/504 같은 게이트웨이 오류는 승인이 원장에 올라간 뒤 응답만 유실된 경우일 수 있다.
 * 이걸 확정 실패로 처리하면 후원자 통장에서는 돈이 빠졌는데 결제는 FAILED 로 닫히고
 * 관리자 대사 큐(UNKNOWN·TIMEOUT)에도 잡히지 않아 회수 경로가 사라진다.
 */
function isIndeterminate(status: number, json: HectoResponse): boolean {
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  // 본문을 파싱하지 못해 결과 코드 자체가 없는 경우도 판단 불가로 본다.
  return json.outRsltCd == null && json.outStatCd == null;
}

function indeterminate(json: HectoResponse, status: number): ProviderResult<never> {
  return {
    ok: false,
    code: 'UNKNOWN',
    message: `결제 결과를 확인하지 못했습니다. (HTTP ${status}) ${String(json.outRsltMsg ?? '')}`.trim(),
    raw: json as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// 어댑터
// ---------------------------------------------------------------------------

export const hectoPaymentAdapter: PaymentAdapter = {
  info(): AdapterInfo {
    const missing = requiredCredentials();
    return { provider: 'hecto', mode: missing.length > 0 ? 'mock' : 'live', missingCredentials: missing };
  },

  /**
   * 내통장결제 가입(계좌 인증 + 출금이체 동의) 결제창 URL 을 만든다.
   * 결제창 인증 유효시간은 10분이므로 expiresAt 을 그에 맞춘다.
   */
  async createRegistrationSession({ payerRef, returnUrl, method = 'ACCOUNT' }): Promise<ProviderResult<RegistrationSession>> {
    assertConfigured();

    // 카드 빌링키는 결제창 경로·필드 규격이 내통장결제와 다르다.
    // 규격서를 받기 전까지는 성공으로 처리하지 않는다(계약 없는 연동을 성공 처리하지 않는다는 규칙).
    if (method === 'CARD') {
      return { ok: false, code: 'CARD_NOT_SUPPORTED', message: '카드 빌링키는 아직 연동되지 않았습니다.' };
    }

    const now = new Date();
    const trDay = hectoDay(now);
    const trTime = hectoTime(now);
    // 등록(빌키 발급) 단계는 실제 출금이 없으므로 금액 0 으로 요청한다.
    const trPricePlain = '0';
    const ordNo = `REG${trDay}${trTime}${payerRef.slice(-8)}`;
    const callbackUrl = env.payment.hectoCallbackUrl || returnUrl;

    const hash = authWindowHash({
      mercntId: env.payment.hectoMid,
      ordNo,
      trDay,
      trTime,
      trPricePlain,
      callbackUrlHost: callbackHost(callbackUrl),
      hashKey: env.payment.hectoHashKey,
    });

    const qs = new URLSearchParams({
      mercntId: env.payment.hectoMid,
      ordNo,
      trDay,
      trTime,
      trPrice: hectoEncrypt(trPricePlain),
      callbackUrl,
      hash,
    });

    return {
      ok: true,
      data: {
        redirectUrl: `${env.payment.hectoAuthUiBase}${HECTO_SPEC.authWindowPath}?${qs.toString()}`,
        providerTid: ordNo,
        // 헥토 결제인증 유효시간 10분
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      },
    };
  },

  /**
   * 결제창 콜백을 받아 빌키를 발급한다.
   * 콜백 payload 를 그대로 신뢰하지 않고, 빌키 발급 API 응답만을 성공 근거로 삼는다.
   */
  async completeRegistration(payload): Promise<ProviderResult<RegistrationResult>> {
    assertConfigured();

    const authNo = String(payload.authNo ?? payload.outAuthNo ?? '');
    if (!authNo) return { ok: false, code: 'NO_AUTH_NO', message: '결제창 인증번호(authNo)가 없습니다.' };

    const now = new Date();
    const reqDay = hectoDay(now);
    const reqTime = hectoTime(now);

    const res = await postJson(HECTO_SPEC.billKeyPath, {
      mercntId: env.payment.hectoMid,
      authNo,
      reqDay,
      reqTime,
      signature: apiSignature({
        mercntId: env.payment.hectoMid,
        authNo,
        reqDay,
        reqTime,
        hashKey: env.payment.hectoHashKey,
      }),
    });

    if (!isSuccess(res.json)) return failure(res.json, '빌키 발급에 실패했습니다.');

    const billKey = String(res.json.outBillKey ?? res.json.billKey ?? '');
    if (!billKey) return { ok: false, code: 'NO_BILLKEY', message: '빌키가 응답에 없습니다.' };

    const account = String(res.json.outAcntNo ?? payload.account ?? '');
    return {
      ok: true,
      data: {
        providerTid: String(res.json.outTrNo ?? authNo),
        billKey,
        // 이 경로는 내통장결제(계좌) 전용이다. 카드 빌링키는 별도 규격을 받은 뒤 분기한다.
        method: 'ACCOUNT',
        bankCode: res.json.outBankCd ? String(res.json.outBankCd) : undefined,
        bankName: res.json.outBankNm ? String(res.json.outBankNm) : undefined,
        accountTail4: account ? account.slice(-4) : undefined,
      },
      latencyMs: res.latencyMs,
    };
  },

  /**
   * 결제 PIN 인증창 발급. **현재는 Mock 이다.**
   *
   * 헥토 PIN 인증창 연동규격서를 아직 받지 못했다. 규격 없이 추정 필드로 실 API 를 호출하면
   * 전건 실패하거나 최악의 경우 잘못된 승인으로 이어지므로, 실제 호출은 하지 않는다.
   * 대신 기브싸인 내부의 모의 PIN 화면 주소를 돌려주고 `mock: true` 를 세워
   * 상위 흐름이 문자·화면·로그에 [MOCK] 을 표시하게 한다.
   *
   * TODO(계약 후): HECTO_SPEC.pinAuthPath 로 실제 인증창 발급 API 를 호출하고
   *                응답의 인증 URL·세션ID·만료시각을 그대로 반환하도록 교체한다.
   *                교체 시 `mock: false` 로 바꾸는 것을 잊지 말 것.
   */
  async requestPinLink(
    chargeId: string,
    amount: bigint,
    _phone: string,
    method: PaymentMethodKind = 'ACCOUNT',
  ): Promise<ProviderResult<PinLinkSession>> {
    assertConfigured();

    const sessionId = `HECTOPIN-MOCK-${chargeId}`;
    logger.warn('[MOCK] 헥토 PIN 인증창 발급 — 실제 결제사 연동이 아닙니다.', {
      chargeId,
      amount: amount.toString(),
      method,
      note: '연동규격서 수령 후 실제 API 로 교체해야 합니다.',
    });

    return {
      ok: true,
      data: {
        pinUrl: mockPinUrl(sessionId),
        sessionId,
        // 헥토 결제인증 유효시간(10분)을 넘지 않게 앱 설정값을 따른다.
        expiresAt: new Date(Date.now() + env.payment.pinTtlSec * 1000),
        mock: true,
      },
    };
  },

  /**
   * 빌키 승인(즉시 출금).
   * 같은 orderNo 로 재요청하면 헥토가 기존 승인 결과를 돌려주므로 멱등하게 동작한다.
   * 네트워크 타임아웃은 승인 실패가 아니라 "불확실"이므로 예외를 던져
   * 상위 흐름이 inquire() 로 최종 상태를 확정하게 한다.
   */
  async approve(req: ApproveRequest): Promise<ProviderResult<ApproveResult>> {
    assertConfigured();

    const now = new Date();
    const reqDay = hectoDay(now);
    const reqTime = hectoTime(now);
    const amountPlain = req.amount.toString();

    const res = await postJson(HECTO_SPEC.approvePath, {
      mercntId: env.payment.hectoMid,
      ordNo: req.orderNo,
      billKey: req.billKey,
      // 금액은 암호화해서 보내고, 서명 재료에는 평문을 쓴다.
      trPrice: hectoEncrypt(amountPlain),
      productNm: req.productName,
      buyerNm: req.buyerName ?? '',
      reqDay,
      reqTime,
      signature: apiSignature({
        mercntId: env.payment.hectoMid,
        authNo: req.orderNo,
        reqDay,
        reqTime,
        hashKey: env.payment.hectoHashKey,
      }),
    });

    if (!isSuccess(res.json)) {
      // HTTP 상태를 버리고 본문 코드만 보면 "승인은 됐는데 응답만 깨진" 건이 확정 실패가 된다.
      if (isIndeterminate(res.status, res.json)) return indeterminate(res.json, res.status);
      return failure(res.json, '결제 승인에 실패했습니다.');
    }

    return {
      ok: true,
      data: {
        providerTid: String(res.json.outTrNo ?? res.json.outTid ?? req.orderNo),
        approvedAt: now,
        amount: req.amount,
      },
      latencyMs: res.latencyMs,
    };
  },

  async inquire(orderNo): Promise<ProviderResult<{ status: InquiryStatus; providerTid?: string; amount?: bigint }>> {
    assertConfigured();

    const now = new Date();
    const reqDay = hectoDay(now);
    const reqTime = hectoTime(now);

    const res = await postJson(HECTO_SPEC.inquirePath, {
      mercntId: env.payment.hectoMid,
      ordNo: orderNo,
      reqDay,
      reqTime,
      signature: apiSignature({
        mercntId: env.payment.hectoMid,
        authNo: orderNo,
        reqDay,
        reqTime,
        hashKey: env.payment.hectoHashKey,
      }),
    });

    // 조회 자체가 실패하면 상태를 단정하지 않는다 (PENDING 으로 남겨 재조회하게 한다).
    if (!isSuccess(res.json)) {
      const code = String(res.json.outRsltCd ?? '');
      if (code === 'NOT_FOUND' || code === '9999') {
        return { ok: true, data: { status: 'NOT_FOUND' }, raw: res.json as Record<string, unknown> };
      }
      return { ok: true, data: { status: 'PENDING' }, raw: res.json as Record<string, unknown> };
    }

    const stat = String(res.json.outStatCd ?? res.json.outTrStat ?? '');
    const status: InquiryStatus =
      stat === 'TS02' || stat === 'APPROVED' || stat === '0000'
        ? 'APPROVED'
        : stat === 'TS03' || stat === 'CANCELED'
          ? 'CANCELED'
          : stat === 'TS01' || stat === 'PENDING'
            ? 'PENDING'
            : 'FAILED';

    const amountRaw = res.json.outTrPrice ?? res.json.trPrice;
    let amount: bigint | undefined;
    if (amountRaw !== undefined && amountRaw !== null && String(amountRaw) !== '') {
      try {
        amount = BigInt(String(amountRaw).replace(/[^\d]/g, ''));
      } catch {
        amount = undefined;
      }
    }

    return {
      ok: true,
      data: { status, providerTid: res.json.outTrNo ? String(res.json.outTrNo) : undefined, amount },
      latencyMs: res.latencyMs,
    };
  },

  async cancel({ orderNo, providerTid, amount, reason }): Promise<ProviderResult<{ canceledAt: Date }>> {
    assertConfigured();

    const now = new Date();
    const reqDay = hectoDay(now);
    const reqTime = hectoTime(now);

    const res = await postJson(HECTO_SPEC.cancelPath, {
      mercntId: env.payment.hectoMid,
      ordNo: orderNo,
      trNo: providerTid,
      trPrice: hectoEncrypt(amount.toString()),
      cancelMsg: reason ?? '결제 환불',
      reqDay,
      reqTime,
      signature: apiSignature({
        mercntId: env.payment.hectoMid,
        authNo: orderNo,
        reqDay,
        reqTime,
        hashKey: env.payment.hectoHashKey,
      }),
    });

    if (!isSuccess(res.json)) return failure(res.json, '결제 취소에 실패했습니다.');
    return { ok: true, data: { canceledAt: now }, latencyMs: res.latencyMs };
  },

  async revokeBillKey(billKey): Promise<ProviderResult<{ revokedAt: Date }>> {
    assertConfigured();

    const now = new Date();
    const reqDay = hectoDay(now);
    const reqTime = hectoTime(now);

    const res = await postJson(HECTO_SPEC.billKeyPath, {
      mercntId: env.payment.hectoMid,
      billKey,
      // 해지 구분. 규격서 확인 필요.
      reqTp: 'DELETE',
      reqDay,
      reqTime,
      signature: apiSignature({
        mercntId: env.payment.hectoMid,
        authNo: billKey,
        reqDay,
        reqTime,
        hashKey: env.payment.hectoHashKey,
      }),
    });

    if (!isSuccess(res.json)) {
      logger.warn('헥토 빌키 해지 실패', { code: res.json.outRsltCd, message: res.json.outRsltMsg });
      return failure(res.json, '빌키 해지에 실패했습니다.');
    }
    return { ok: true, data: { revokedAt: now }, latencyMs: res.latencyMs };
  },
};
