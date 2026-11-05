import { createHmac, randomBytes } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type { AdapterInfo, ProviderResult } from '../types';
import type { AlimtalkAdapter, AlimtalkReport, AlimtalkSendRequest, AlimtalkSendResult } from './index';

/**
 * 솔라피(coolsms) 카카오 알림톡 어댑터 (2026-11-06 7단계).
 *
 * 규격 (SOLAPI 메시지 발송 API — https://solapi.com/developers/api/messages · messages-ata)
 *  - POST https://api.solapi.com/messages/v4/send-many/detail   (문서상 현재 권장 단건·다건 발송 엔드포인트)
 *  - 인증: Authorization: HMAC-SHA256 apiKey=<key>, date=<ISO8601>, salt=<랜덤>, signature=<hex(HMAC-SHA256(secret, date+salt))>
 *  - 본문: { messages: [{ to, from?, type: 'ATA', text, kakaoOptions: { pfId, templateId, disableSms: true } }], showMessageList: true }
 *    · pfId     = 기관 발신프로필(솔라피에 연동한 카카오 채널) — 기관 알림톡 설정의 "발신프로필 키"
 *    · templateId = 카카오 승인 템플릿 코드
 *    · text     = 템플릿 변수를 이미 치환한 본문(템플릿과 다르면 솔라피·카카오가 거절한다)
 *    · disableSms: true — 공급자 대체 문자를 끈다. 실패하면 우리 쪽 sendMtDetailed 가 같은 본문을 문자로 보낸다
 *      (대체 문자가 두 번 나가지 않게).
 *  - 응답(200): { groupInfo, failedMessageList: [{ to, statusCode, statusMessage }], messageList?: [{ messageId, statusCode, statusMessage }] }
 *    오류(4xx/5xx): { errorCode, errorMessage }
 *  - 키: ALIMTALK_API_KEY/ALIMTALK_API_SECRET, 비우면 문자 발송 키 MT_API_KEY/MT_API_SECRET(같은 솔라피 계정)를 쓴다.
 *
 * 접수(2000)는 카카오 전달 성공이 아니다. 최종 결과(리포트)는 따로 받아야 하고 그 값으로 결제 결과를 바꾸지 않는다.
 *
 * 전달 결과 조회 (2026-11-06 점검 A-5 — https://solapi.com/developers/api/msg-getList · message-status-codes)
 *  - GET https://api.solapi.com/messages/v4/list?messageId=<id>&limit=1   (그룹 ID 로 받았으면 groupId=<id>)
 *  - 응답: { messageList: { <messageId>: { messageId, status: PENDING|SENDING|COMPLETE, statusCode, reason, dateReceived } }, ... }
 *  - 상태 코드: 2000 정상 접수(이통사 접수 예정) · 3000 이통사 접수(리포트 대기) · 4000 수신 완료.
 *    그 밖의 1xxx(접수 오류)·2xxx(내부 오류)·3xxx(전달 실패 — 3104 카카오톡 미사용, 3107 72시간 미사용·차단 등)는 실패.
 *  - 실패로 보는 조건(보수적): 2000/3000/4000 이 아닌 4자리 코드이고 status 가 COMPLETE(또는 없음)일 때만.
 *    그 밖(빈 코드·처리 중)은 PENDING — 중복 발송을 막기 위해 "명시적 실패" 일 때만 문자로 대체한다.
 */

export const SOLAPI_SEND_URL = 'https://api.solapi.com/messages/v4/send-many/detail';
export const SOLAPI_LIST_URL = 'https://api.solapi.com/messages/v4/list';
const TIMEOUT_MS = 10_000;

/** 솔라피 HMAC 서명 헤더. date·salt 를 넘기면 그 값으로 만든다(테스트). */
export function solapiAuthorization(apiKey: string, apiSecret: string, date = new Date().toISOString(), salt = randomBytes(16).toString('hex')) {
  const signature = createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function missingCredentials(): string[] {
  const m: string[] = [];
  if (!env.integrations.alimtalk.apiKey) m.push('ALIMTALK_API_KEY(또는 MT_API_KEY)');
  if (!env.integrations.alimtalk.apiSecret) m.push('ALIMTALK_API_SECRET(또는 MT_API_SECRET)');
  return m;
}

/** 자주 보는 실패를 담당자가 알아볼 문구로. 모르는 코드는 공급자 문구를 그대로 쓴다(추정 매핑 없음). */
function reason(code: string, message: string): string {
  if (/^HTTP_401|Unauthorized|InvalidApiKey|SignatureDoesNotMatch/i.test(code)) return `알림톡 인증 실패(키 확인 필요): ${message}`;
  if (/Balance|Point/i.test(code)) return `알림톡 잔액 부족: ${message}`;
  if (/template/i.test(message) || /템플릿/.test(message)) return `알림톡 템플릿 불일치·미승인: ${message}`;
  if (/pfId|발신프로필|채널/.test(message)) return `알림톡 발신프로필(채널) 문제: ${message}`;
  return `알림톡 발송 실패(${code}): ${message}`;
}

export const solapiAlimtalkAdapter: AlimtalkAdapter = {
  info(): AdapterInfo {
    return { provider: 'coolsms', mode: 'live', missingCredentials: missingCredentials() };
  },

  async send(req: AlimtalkSendRequest): Promise<ProviderResult<AlimtalkSendResult>> {
    const missing = missingCredentials();
    if (missing.length) return { ok: false, code: 'NOT_CONFIGURED', message: `솔라피 알림톡 설정이 없습니다: ${missing.join(', ')}` };
    const to = (req.to ?? '').replace(/\D/g, '');
    if (!to) return { ok: false, code: 'INVALID_TO', message: '수신번호가 비어 있습니다.' };
    const from = (env.mt.senderNumber ?? '').replace(/\D/g, '');
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(SOLAPI_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: solapiAuthorization(env.integrations.alimtalk.apiKey, env.integrations.alimtalk.apiSecret) },
        body: JSON.stringify({
          messages: [{ to, ...(from ? { from } : {}), type: 'ATA', text: req.text, kakaoOptions: { pfId: req.senderKey, templateId: req.templateCode, disableSms: true } }],
          showMessageList: true,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      logger.error('솔라피 알림톡 요청 실패', { template: req.templateCode, message: (e as Error).message });
      return { ok: false, code: 'NETWORK_ERROR', message: `알림톡 사업자에 연결하지 못했습니다: ${(e as Error).message}`, latencyMs: Date.now() - started };
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const code = String(body.errorCode ?? `HTTP_${res.status}`);
      const message = String(body.errorMessage ?? `HTTP ${res.status}`);
      logger.warn('솔라피 알림톡 거절', { status: res.status, code, template: req.templateCode });
      return { ok: false, code, message: reason(code, message), raw: { errorCode: code, errorMessage: message }, latencyMs };
    }
    const failed = (body.failedMessageList as Array<{ statusCode?: string; statusMessage?: string }> | undefined) ?? [];
    if (failed.length) {
      const code = String(failed[0]!.statusCode ?? 'FAILED');
      const message = String(failed[0]!.statusMessage ?? '접수되지 않았습니다.');
      logger.warn('솔라피 알림톡 접수 실패', { code, template: req.templateCode });
      return { ok: false, code, message: reason(code, message), raw: { statusCode: code, statusMessage: message }, latencyMs };
    }
    const first = (body.messageList as Array<{ messageId?: string; statusCode?: string; statusMessage?: string }> | undefined)?.[0];
    const groupId = (body.groupInfo as { groupId?: string; _id?: string } | undefined)?.groupId ?? (body.groupInfo as { _id?: string } | undefined)?._id;
    if (first && first.statusCode && first.statusCode !== '2000') {
      return { ok: false, code: first.statusCode, message: reason(first.statusCode, first.statusMessage ?? '접수되지 않았습니다.'), latencyMs };
    }
    const id = first?.messageId ?? groupId;
    if (!id) return { ok: false, code: 'NOT_ACCEPTED', message: '알림톡 접수 여부를 확인하지 못했습니다(메시지 ID 없음).', latencyMs };
    return { ok: true, data: { providerMessageId: String(id), pendingReport: true }, raw: { statusCode: first?.statusCode ?? null, groupId: groupId ?? null }, latencyMs };
  },

  async report(providerMessageId: string): Promise<ProviderResult<AlimtalkReport>> {
    const missing = missingCredentials();
    if (missing.length) return { ok: false, code: 'NOT_CONFIGURED', message: `솔라피 알림톡 설정이 없습니다: ${missing.join(', ')}` };
    const id = String(providerMessageId ?? '').trim();
    if (!id) return { ok: false, code: 'NO_ID', message: '메시지 ID 가 없습니다.' };
    // 그룹 ID(G…)로 접수 결과를 받은 경우(messageList 가 비었던 응답)는 그룹으로 조회한다.
    const q = new URLSearchParams({ [/^G/i.test(id) ? 'groupId' : 'messageId']: id, limit: '1' });
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${SOLAPI_LIST_URL}?${q.toString()}`, {
        method: 'GET',
        headers: { Authorization: solapiAuthorization(env.integrations.alimtalk.apiKey, env.integrations.alimtalk.apiSecret) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, code: 'NETWORK_ERROR', message: `알림톡 결과 조회 연결 실패: ${(e as Error).message}`, latencyMs: Date.now() - started };
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const code = String(body.errorCode ?? `HTTP_${res.status}`);
      return { ok: false, code, message: reason(code, String(body.errorMessage ?? `HTTP ${res.status}`)), latencyMs };
    }
    const list = body.messageList;
    const rows = (Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list as Record<string, unknown>) : []) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r && (r.messageId === id || r._id === id)) ?? rows[0];
    if (!row) return { ok: true, data: { outcome: 'PENDING', statusCode: null, reason: null }, latencyMs };
    return { ok: true, data: classifySolapiStatus(row), latencyMs };
  },
};

/** 솔라피 메시지 한 건 → 전달 결과. 명시적 실패 코드만 FAILED 다(그 밖은 PENDING). */
export function classifySolapiStatus(row: { status?: unknown; statusCode?: unknown; reason?: unknown; dateReceived?: unknown }): AlimtalkReport {
  const statusCode = row.statusCode == null || row.statusCode === '' ? null : String(row.statusCode);
  const status = row.status == null ? null : String(row.status).toUpperCase();
  const why = row.reason == null ? null : String(row.reason).slice(0, 200);
  if (statusCode === '4000') {
    const t = typeof row.dateReceived === 'string' ? new Date(row.dateReceived) : null;
    return { outcome: 'DELIVERED', statusCode, reason: why, receivedAt: t && !Number.isNaN(t.getTime()) ? t : null };
  }
  if (!statusCode || statusCode === '2000' || statusCode === '3000') return { outcome: 'PENDING', statusCode, reason: why };
  if (/^[1-3]\d{3}$/.test(statusCode) && (status === null || status === 'COMPLETE')) return { outcome: 'FAILED', statusCode, reason: why };
  return { outcome: 'PENDING', statusCode, reason: why };
}
