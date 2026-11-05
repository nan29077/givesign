import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';
import { solapiAlimtalkAdapter } from './solapi';

/**
 * 카카오 알림톡 어댑터.
 *
 * 알림톡은 기관(발신프로필)마다, 템플릿마다 카카오의 사전 승인을 받아야 보낼 수 있다.
 * 이 어댑터는 "승인된 템플릿 코드 + 치환된 본문" 을 받아 보내기만 한다.
 * 어떤 기관·어떤 문자를 알림톡으로 보낼지는 서비스(alimtalk.ts)가 정하고,
 * 실패하면 호출부가 같은 본문을 문자로 대체 발송한다.
 *
 * 실연동: coolsms = 솔라피 알림톡(solapi.ts, 2026-11-06). emma 는 알림톡 테이블 규격 수령 전이라 notConfigured.
 * mock 은 실제로 카카오톡을 보내지 않는다(절대 규칙 2).
 */

export interface AlimtalkSendRequest {
  to: string;
  /** 기관 발신프로필 키 (복호화된 값. 로그에 남기지 않는다) */
  senderKey: string;
  /** 카카오 승인 템플릿 코드 */
  templateCode: string;
  text: string;
}

export interface AlimtalkSendResult {
  providerMessageId: string;
  /**
   * true 면 공급자가 **접수만** 했다(최종 전달 결과는 리포트로 따로 온다) → 이력은 ACCEPTED 로 두고
   * alimtalk-reports 배치가 결과를 조회한다. false(mock)면 그 자리에서 최종이다.
   */
  pendingReport: boolean;
}

/** 전달 결과 조회 한 건. DELIVERED = 수신 완료, FAILED = 공급자가 명시한 실패 코드, PENDING = 아직 모름. */
export interface AlimtalkReport {
  outcome: 'DELIVERED' | 'FAILED' | 'PENDING';
  statusCode: string | null;
  reason: string | null;
  /** 공급자가 알려 준 수신 시각(있으면) */
  receivedAt?: Date | null;
}

export interface AlimtalkAdapter {
  info(): AdapterInfo;
  send(req: AlimtalkSendRequest): Promise<ProviderResult<AlimtalkSendResult>>;
  /** 접수한 메시지의 전달 결과 조회. 접수만 하는 공급자(솔라피)만 구현한다. */
  report?(providerMessageId: string): Promise<ProviderResult<AlimtalkReport>>;
}

const globalForAlimtalk = globalThis as unknown as {
  alimtalkMockOutbox?: Array<{ to: string; text: string; templateCode: string; at: Date; id: string }>;
  alimtalkMockFailure?: string | null;
};
const outbox = globalForAlimtalk.alimtalkMockOutbox ?? [];
globalForAlimtalk.alimtalkMockOutbox = outbox;

export function readMockAlimtalkOutbox(limit = 50) {
  return outbox.slice(-limit).reverse();
}

export function clearMockAlimtalkOutbox() {
  outbox.length = 0;
  globalForAlimtalk.alimtalkMockFailure = null;
}

/** 테스트 전용: mock 알림톡을 실패시켜 문자 대체 경로를 밟는다. */
export function setMockAlimtalkFailure(message: string | null) {
  globalForAlimtalk.alimtalkMockFailure = message;
}

export const mockAlimtalkAdapter: AlimtalkAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async send(req) {
    const failure = globalForAlimtalk.alimtalkMockFailure;
    if (failure) return { ok: false, code: 'MOCK_ALIMTALK_FAIL', message: failure };
    const id = `ATMOCK${Date.now()}${Math.floor(Math.random() * 1000)}`;
    outbox.push({ to: req.to, text: req.text, templateCode: req.templateCode, at: new Date(), id });
    if (outbox.length > 500) outbox.splice(0, outbox.length - 500);
    logger.info('알림톡(mock) 발송', { template: req.templateCode, bytes: Buffer.byteLength(req.text) });
    // mock 은 리포트가 없다 — 그 자리에서 최종(전달 결과를 꾸미지 않고 mock 표시로 남는다).
    return { ok: true, data: { providerMessageId: id, pendingReport: false }, latencyMs: 5 };
  },
};

/** 계약 전 공급자. 성공을 꾸미지 않고 설정 누락으로 실패시킨다 → 호출부가 문자로 대체한다. */
function notConfigured(provider: string, missing: string[]): AlimtalkAdapter {
  return {
    info() {
      return { provider, mode: 'live', missingCredentials: missing };
    },
    async send() {
      const err = new AdapterNotConfiguredError(provider, missing);
      return { ok: false, code: 'NOT_CONFIGURED', message: err.message };
    },
  };
}

export function getAlimtalkAdapter(): AlimtalkAdapter {
  if (env.safety.safeMode && env.automation.alimtalkProvider !== 'mock') {
    logger.warn('SAFE_MODE 가 켜져 있어 실제 알림톡 발송을 차단하고 mock 으로 대체합니다.');
    return mockAlimtalkAdapter;
  }
  switch (env.automation.alimtalkProvider) {
    case 'mock':
      return mockAlimtalkAdapter;
    case 'coolsms':
      // 솔라피(coolsms) 알림톡 실연동 (solapi.ts). 키가 없으면 호출하지 않고 NOT_CONFIGURED → 문자 대체.
      return solapiAlimtalkAdapter;
    case 'emma':
      // EMMA 알림톡 큐 테이블 규격(em_kko_tran 등)을 받지 못했다. src/server/emma 는 문자 큐만 다룬다 → 규격 수령 후.
      return notConfigured('emma', ['EMMA 알림톡 큐(em_kko_tran) 규격 수령 후 구현']);
    default:
      return notConfigured(env.automation.alimtalkProvider, ['ALIMTALK_PROVIDER 구현']);
  }
}

export function alimtalkIsMock(): boolean {
  return getAlimtalkAdapter().info().mode === 'mock';
}
