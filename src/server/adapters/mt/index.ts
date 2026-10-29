import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type { AdapterInfo, ProviderResult } from '../types';
// coolsms.ts / emma.ts 는 이 파일에서 타입과 decideMessageType 만 가져온다
// (아래에서 정의됨 → 함수 호출 시점에 해석).
import { coolsmsMtAdapter } from './coolsms';
import { emmaMtAdapter } from './emma';

export interface MtSendRequest {
  to: string;
  text: string;
  templateCode?: string;
  /** 90byte 초과 시 자동으로 LMS 로 전환 */
  forceType?: 'SMS' | 'LMS';
}

export interface MtSendResult {
  providerMessageId: string;
  messageType: 'SMS' | 'LMS';
}

export interface MtAdapter {
  info(): AdapterInfo;
  send(req: MtSendRequest): Promise<ProviderResult<MtSendResult>>;
}

export function decideMessageType(text: string, force?: 'SMS' | 'LMS'): 'SMS' | 'LMS' {
  if (force) return force;
  return Buffer.byteLength(text, 'utf8') > 90 ? 'LMS' : 'SMS';
}

/**
 * Mock 발송기. 실제 문자는 나가지 않으며 outbox 에 적재된다.
 *
 * globalThis 에 보관하는 이유:
 * 개발 서버(Turbopack)는 서버 액션과 라우트 핸들러를 서로 다른 모듈 그래프로 로드할 수 있다.
 * 모듈 스코프 배열로 두면 서버 액션이 적재한 문자를 /api/dev/outbox 가 못 보고 늘 빈 배열이 나온다.
 * (프로세스 단위 상태는 같은 이유로 globalThis 를 쓴다)
 */
const globalForMt = globalThis as unknown as {
  // template 을 함께 담는다. 문구가 바뀌어도 "어떤 문자인지"로 찾을 수 있어야
  // 테스트·시드가 본문 문자열에 묶이지 않는다.
  mtMockOutbox?: Array<{ to: string; text: string; at: Date; id: string; template?: string }>;
};
const outbox = globalForMt.mtMockOutbox ?? [];
globalForMt.mtMockOutbox = outbox;

export function readMockOutbox(limit = 50) {
  return outbox.slice(-limit).reverse();
}

export function clearMockOutbox() {
  outbox.length = 0;
}

/**
 * mock MT 발송을 실패시킨다(테스트 전용).
 *
 * 실제 어댑터는 문자 사업자 장애·잔액 소진으로 실패할 수 있는데,
 * mock 이 항상 성공하면 그 뒤 처리(가입 안내 발송권 반납, PIN 세션 닫고 결제 실패 확정)가
 * 어떤 테스트도 밟지 않는 죽은 코드가 된다.
 */
let mockSendFailure: string | null = null;
export function setMockMtFailure(message: string | null) {
  mockSendFailure = message;
}

export const mockMtAdapter: MtAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async send(req) {
    if (mockSendFailure) {
      return { ok: false, code: 'MOCK_MT_FAIL', message: mockSendFailure };
    }
    const id = `MTMOCK${Date.now()}${Math.floor(Math.random() * 1000)}`;
    outbox.push({ to: req.to, text: req.text, at: new Date(), id, template: req.templateCode });
    if (outbox.length > 500) outbox.splice(0, outbox.length - 500);
    logger.info('MT(mock) 발송', { to: req.to, template: req.templateCode, bytes: Buffer.byteLength(req.text) });
    return {
      ok: true,
      data: { providerMessageId: id, messageType: decideMessageType(req.text, req.forceType) },
      latencyMs: 5,
    };
  },
};

export function getMtAdapter(): MtAdapter {
  if (env.safety.safeMode && env.mt.provider !== 'mock') {
    logger.warn('SAFE_MODE 가 켜져 있어 실제 MT 발송을 차단하고 mock 으로 대체합니다.');
    return mockMtAdapter;
  }
  switch (env.mt.provider) {
    case 'mock':
      return mockMtAdapter;
    case 'coolsms':
      return coolsmsMtAdapter;
    case 'emma':
      // 인포뱅크 EMMA. HTTP 가 아니라 발송 큐 테이블(em_smt_tran)에 적재한다.
      return emmaMtAdapter;
    default:
      throw new Error(
        `MT_PROVIDER=${env.mt.provider} 어댑터가 구현되지 않았습니다. 사업자 계약 확정 후 추가하십시오.`,
      );
  }
}
