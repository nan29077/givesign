import { createHmac, randomBytes } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type { AdapterInfo, ProviderResult } from '../types';
import { decideMessageType, type MtAdapter, type MtSendRequest, type MtSendResult } from './index';

/**
 * CoolSMS(SOLAPI) MT 발송 어댑터.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규격 (SOLAPI Messages v4)
 *
 *  1) 엔드포인트
 *     POST https://api.coolsms.co.kr/messages/v4/send
 *     Content-Type: application/json
 *
 *  2) 인증 헤더 (HMAC-SHA256)
 *     date      = new Date().toISOString()
 *     salt      = 랜덤 문자열(12~64자)
 *     signature = HMAC-SHA256(key = MT_API_SECRET, message = date + salt) 의 hex
 *     Authorization: HMAC-SHA256 apiKey=<MT_API_KEY>, date=<date>, salt=<salt>, signature=<signature>
 *
 *  3) 요청 본문
 *     { "message": { "to", "from", "text", "type": "SMS" | "LMS" } }
 *
 *  4) 응답 본문 (성공)
 *     { "messageId": "M4V2...", "statusCode": "2000", "statusMessage": "정상 접수(이통사로 접수 예정)" }
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 이 어댑터가 지키는 것
 *
 *  - **키가 없으면 성공을 돌려주지 않는다.** mock 으로 조용히 대체하면 문자가 나가지 않았는데
 *    "발송 완료"로 기록되고, 후원자는 결제 링크를 영영 못 받는다 (절대규칙 2).
 *    mock 이 필요하면 MT_PROVIDER=mock 으로 명시하거나 SAFE_MODE=true 를 쓴다.
 *  - **접수 성공(2000)은 "이통사 접수"이지 "단말 수신"이 아니다.** 최종 수신 결과는 리포트
 *    웹훅으로 따로 받아야 하며, 그 값으로 결제 결과를 바꾸지 않는다 (절대규칙 3).
 *  - 발신번호 사전등록(전기통신사업법)이 끝난 번호만 from 에 넣을 수 있다.
 */

const SOLAPI_SEND_URL = 'https://api.coolsms.co.kr/messages/v4/send';
/** 문자 사업자 응답이 늦어도 결제 흐름 전체를 붙잡지 않도록 상한을 둔다. */
const REQUEST_TIMEOUT_MS = 10_000;
/** SOLAPI 접수 성공 코드. 2000 계열만 접수로 인정한다. */
const ACCEPTED_STATUS_CODES = new Set(['2000']);

/** 실연동에 필요한데 아직 없는 설정 항목. */
function missingCredentials(): string[] {
  const missing: string[] = [];
  if (!env.mt.apiKey) missing.push('MT_API_KEY');
  if (!env.mt.apiSecret) missing.push('MT_API_SECRET');
  if (!env.mt.senderNumber) missing.push('MT_SENDER_NUMBER');
  return missing;
}

/** SOLAPI 인증 헤더를 만든다. */
function authorizationHeader(): string {
  const date = new Date().toISOString();
  const salt = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', env.mt.apiSecret).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${env.mt.apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function digitsOnly(value: string): string {
  return (value ?? '').replace(/\D/g, '');
}

/** 로그·감사에 남길 응답 요약. 본문·수신번호는 담지 않는다. */
function summarize(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    messageId: b.messageId ?? null,
    statusCode: b.statusCode ?? null,
    statusMessage: b.statusMessage ?? null,
    errorCode: b.errorCode ?? null,
    errorMessage: b.errorMessage ?? null,
  };
}

export const coolsmsMtAdapter: MtAdapter = {
  info(): AdapterInfo {
    const missing = missingCredentials();
    return { provider: 'coolsms', mode: missing.length > 0 ? 'mock' : 'live', missingCredentials: missing };
  },

  async send(req: MtSendRequest): Promise<ProviderResult<MtSendResult>> {
    const missing = missingCredentials();
    if (missing.length > 0) {
      // 설정 누락을 "성공"으로 덮지 않는다. 호출부(sendMt)가 실패로 기록하고 후속 처리를 되돌린다.
      logger.error('CoolSMS 설정 누락 — 문자를 발송하지 않습니다.', {
        missing,
        template: req.templateCode,
      });
      return {
        ok: false,
        code: 'MT_NOT_CONFIGURED',
        message:
          `CoolSMS(SOLAPI) 설정이 완료되지 않았습니다. (미설정: ${missing.join(', ')}) ` +
          '모의 발송이 필요하면 MT_PROVIDER=mock 으로 명시하십시오.',
      };
    }

    const started = Date.now();
    const messageType = decideMessageType(req.text, req.forceType);
    const to = digitsOnly(req.to);
    if (!to) {
      return { ok: false, code: 'MT_INVALID_TO', message: '수신번호가 비어 있습니다.' };
    }

    let res: Response;
    try {
      res = await fetch(SOLAPI_SEND_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorizationHeader(),
        },
        body: JSON.stringify({
          message: {
            to,
            from: digitsOnly(env.mt.senderNumber),
            text: req.text,
            type: messageType,
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const message = (e as Error).message;
      logger.error('CoolSMS 발송 요청 실패', { message, template: req.templateCode });
      return {
        ok: false,
        code: 'MT_NETWORK_ERROR',
        message: `문자 사업자에 연결하지 못했습니다: ${message}`,
        latencyMs: Date.now() - started,
      };
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const raw = summarize(body);
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      logger.error('CoolSMS 발송 거절', { status: res.status, ...raw, template: req.templateCode });
      return {
        ok: false,
        code: String(raw.errorCode ?? raw.statusCode ?? `HTTP_${res.status}`),
        message: String(raw.errorMessage ?? raw.statusMessage ?? `문자 발송이 거절되었습니다 (HTTP ${res.status})`),
        raw,
        latencyMs,
      };
    }

    const statusCode = raw.statusCode == null ? '' : String(raw.statusCode);
    const messageId = raw.messageId == null ? '' : String(raw.messageId);

    // 2000 계열이 아니면 접수되지 않은 것이다. 임의로 성공 처리하지 않는다.
    if (!ACCEPTED_STATUS_CODES.has(statusCode) || !messageId) {
      logger.error('CoolSMS 접수 실패', { ...raw, template: req.templateCode });
      return {
        ok: false,
        code: statusCode || 'MT_NOT_ACCEPTED',
        message: String(raw.statusMessage ?? '문자가 접수되지 않았습니다.'),
        raw,
        latencyMs,
      };
    }

    return {
      ok: true,
      data: { providerMessageId: messageId, messageType },
      raw,
      latencyMs,
    };
  },
};
