import { env, isLocal } from '@/lib/env';
import { verifySignature } from '@/lib/crypto';
import { isAllowedIp } from '@/server/rate-limit';
import type { AdapterInfo } from '../types';
// mtonet.ts 는 이 파일에서 타입과 verifyMoRequest 만 가져온다 (아래에서 정의됨 → 함수 호출 시점에 해석).
import { mtonetMoAdapter } from './mtonet';

/**
 * MO 웹훅 공통 검증 (fail-closed).
 *
 * - IP 허용목록: 로컬에서만 "비어 있으면 검사 생략"을 허용한다.
 * - 서명 시크릿: 로컬에서만 "없으면 통과"를 허용한다.
 *   운영/스테이징에서 시크릿이 없으면 누구나 결제 거래를 만들 수 있으므로 반드시 거절한다.
 */
export function verifyMoRequest(
  rawBody: string,
  headers: Record<string, string>,
  ip: string | undefined,
  signatureHeaderNames: string[],
): { ok: boolean; reason?: string } {
  if (env.mo.allowedIps.length > 0) {
    if (!ip) return { ok: false, reason: '발신 IP 를 확인할 수 없습니다.' };
    // 문자열 그대로 비교하면 `::ffff:203.0.113.10` 처럼 IPv6 로 감싸 도착한 같은 주소를
    // 거절해 MO 가 전건 401 이 된다. 양쪽을 같은 규칙으로 정규화한 뒤 비교한다.
    if (!isAllowedIp(ip, env.mo.allowedIps)) return { ok: false, reason: `허용되지 않은 IP: ${ip}` };
  } else if (!isLocal) {
    return { ok: false, reason: 'MO_ALLOWED_IPS 미설정 (운영 환경에서는 IP 허용목록이 필수입니다)' };
  }

  if (!env.mo.webhookSecret) {
    if (!isLocal) return { ok: false, reason: 'MO_WEBHOOK_SECRET 미설정 (서명 검증 불가)' };
    return { ok: true };
  }

  const sig = signatureHeaderNames.map((n) => headers[n]).find((v) => v) ?? '';
  if (!sig) return { ok: false, reason: '서명 헤더 없음' };
  return verifySignature(rawBody, sig, env.mo.webhookSecret)
    ? { ok: true }
    : { ok: false, reason: '서명 불일치' };
}

/** MO 사업자로부터 수신하는 정규화된 인바운드 메시지 */
export interface MoInbound {
  /** 사업자 메시지 ID. 중복 수신 차단의 1차 키 */
  providerMessageId: string;
  providerCode: string;
  /** 수신 MO 번호 */
  receivedNumber: string;
  /** 발신 휴대전화번호 (원문. 즉시 해시/암호화 후 폐기) */
  fromNumber: string;
  messageType: 'SMS' | 'LMS' | 'MMS';
  content: string;
  attachments?: Array<{ name: string; url?: string; size?: number }>;
  receivedAt: Date;
}

export interface MoAdapter {
  info(): AdapterInfo;
  /** Webhook 서명/발신 검증 */
  verify(rawBody: string, headers: Record<string, string>, ip?: string): { ok: boolean; reason?: string };
  /** 사업자별 payload → 정규화 */
  parse(body: unknown): MoInbound;
}

/** 개발/테스트용 Mock MO 사업자 */
export const mockMoAdapter: MoAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },

  verify(rawBody, headers, ip) {
    return verifyMoRequest(rawBody, headers, ip, ['x-givesign-signature', 'x-signature']);
  },

  parse(body) {
    const b = body as Record<string, unknown>;
    const required = ['messageId', 'to', 'from', 'text'];
    for (const key of required) {
      if (b[key] === undefined || b[key] === null || b[key] === '') {
        throw new Error(`MO payload 필수값 누락: ${key}`);
      }
    }
    return {
      providerMessageId: String(b.messageId),
      providerCode: 'mock',
      receivedNumber: String(b.to),
      fromNumber: String(b.from),
      messageType: (String(b.type || 'SMS').toUpperCase() as MoInbound['messageType']) || 'SMS',
      content: String(b.text),
      attachments: Array.isArray(b.attachments) ? (b.attachments as MoInbound['attachments']) : undefined,
      receivedAt: b.receivedAt ? new Date(String(b.receivedAt)) : new Date(),
    };
  },
};

export function getMoAdapter(): MoAdapter {
  switch (env.mo.provider) {
    case 'mock':
      return mockMoAdapter;
    case 'mtonet':
      return mtonetMoAdapter;
    default:
      // 실 사업자 어댑터는 계약 확정 후 이 위치에 추가한다.
      // 미구현 사업자를 mock 으로 대체해 "성공 처리"하지 않는다.
      throw new Error(
        `MO_PROVIDER=${env.mo.provider} 어댑터가 구현되지 않았습니다. 사업자 계약 확정 후 추가하십시오.`,
      );
  }
}
