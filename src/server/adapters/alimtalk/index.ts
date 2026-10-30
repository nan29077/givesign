import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';

/**
 * 카카오 알림톡 어댑터.
 *
 * 알림톡은 기관(발신프로필)마다, 템플릿마다 카카오의 사전 승인을 받아야 보낼 수 있다.
 * 이 어댑터는 "승인된 템플릿 코드 + 치환된 본문" 을 받아 보내기만 한다.
 * 어떤 기관·어떤 문자를 알림톡으로 보낼지는 서비스(alimtalk.ts)가 정하고,
 * 실패하면 호출부가 같은 본문을 문자로 대체 발송한다.
 *
 * 실연동(coolsms·emma)은 사업자 계약 뒤에 붙인다. 그 전에는 mock 만 동작하고,
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
}

export interface AlimtalkAdapter {
  info(): AdapterInfo;
  send(req: AlimtalkSendRequest): Promise<ProviderResult<AlimtalkSendResult>>;
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
    return { ok: true, data: { providerMessageId: id }, latencyMs: 5 };
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
      return notConfigured('coolsms', ['COOLSMS_ALIMTALK_PFID 연동 구현']);
    case 'emma':
      return notConfigured('emma', ['EMMA 알림톡 큐(em_kko_tran) 연동 구현']);
    default:
      return notConfigured(env.automation.alimtalkProvider, ['ALIMTALK_PROVIDER 구현']);
  }
}

export function alimtalkIsMock(): boolean {
  return getAlimtalkAdapter().info().mode === 'mock';
}
