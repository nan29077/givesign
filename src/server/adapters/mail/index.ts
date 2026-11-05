import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type { AdapterInfo, ProviderResult } from '../types';
import { signRequest } from './sigv4';

/**
 * 메일 발송 어댑터 (2026-11-06 7단계). MAIL_PROVIDER = mock | ses
 *
 * - ses: Amazon SES v2 HTTP API 를 SigV4 로 직접 서명해 부른다(@aws-sdk/client-sesv2 미설치).
 *     POST https://email.<region>.amazonaws.com/v2/email/outbound-emails
 *     { FromEmailAddress, Destination: { ToAddresses }, Content: { Simple: { Subject, Body: { Text, Html? } } } } → { MessageId }
 *   자격 증명은 SES_ACCESS_KEY_ID/SES_SECRET_ACCESS_KEY, 비우면 AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY(+AWS_SESSION_TOKEN).
 *   역할 자격 증명(EC2/ECS 메타데이터)은 읽지 않는다 — 없으면 missingCredentials 로 알리고 보내지 않는다.
 * - mock: 아무 데도 보내지 않는다. 메모리 outbox 에만 쌓는다(테스트·로컬 확인용).
 *
 * 호출부는 `mailIsLive()` 일 때만 "메일로 보냈습니다" 라고 말한다(절대 규칙 2).
 * 본문에 일회용 링크가 들어가므로 본문·수신 주소를 로그에 남기지 않는다.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** 로그·통계용 분류 (PASSWORD_RESET · DONOR_EMAIL_VERIFY · DOCUMENT) */
  tag: string;
}

export interface MailSendResult {
  providerMessageId: string;
}

export interface MailAdapter {
  info(): AdapterInfo;
  send(msg: MailMessage): Promise<ProviderResult<MailSendResult>>;
}

const globalForMail = globalThis as unknown as { mailMockOutbox?: Array<MailMessage & { at: Date; id: string }> };
const outbox = globalForMail.mailMockOutbox ?? [];
globalForMail.mailMockOutbox = outbox;

export function readMockMailOutbox(limit = 50) {
  return outbox.slice(-limit).reverse();
}

export function clearMockMailOutbox() {
  outbox.length = 0;
}

export const mockMailAdapter: MailAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async send(msg) {
    const id = `MAILMOCK${Date.now()}${Math.floor(Math.random() * 1000)}`;
    outbox.push({ ...msg, at: new Date(), id });
    if (outbox.length > 200) outbox.splice(0, outbox.length - 200);
    logger.info('메일(mock) — 실제로 보내지 않음', { tag: msg.tag });
    return { ok: true, data: { providerMessageId: id }, latencyMs: 1 };
  },
};

function sesMissing(): string[] {
  const m = env.integrations.mail;
  const missing: string[] = [];
  if (!m.from) missing.push('MAIL_FROM');
  if (!m.sesRegion) missing.push('SES_REGION');
  if (!m.sesAccessKeyId) missing.push('SES_ACCESS_KEY_ID(또는 AWS_ACCESS_KEY_ID)');
  if (!m.sesSecretAccessKey) missing.push('SES_SECRET_ACCESS_KEY(또는 AWS_SECRET_ACCESS_KEY)');
  return missing;
}

export function sesEndpoint(region = env.integrations.mail.sesRegion) {
  return `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
}

export const sesMailAdapter: MailAdapter = {
  info() {
    return { provider: 'ses', mode: 'live', missingCredentials: sesMissing() };
  },
  async send(msg) {
    const missing = sesMissing();
    if (missing.length) return { ok: false, code: 'NOT_CONFIGURED', message: `SES 설정이 없습니다: ${missing.join(', ')}` };
    const m = env.integrations.mail;
    const url = sesEndpoint();
    const body = JSON.stringify({
      FromEmailAddress: m.from,
      Destination: { ToAddresses: [msg.to] },
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: msg.text, Charset: 'UTF-8' }, ...(msg.html ? { Html: { Data: msg.html, Charset: 'UTF-8' } } : {}) },
        },
      },
      EmailTags: [{ Name: 'tag', Value: msg.tag.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) }],
    });
    const headers = signRequest({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      body,
      region: m.sesRegion,
      service: 'ses',
      credentials: { accessKeyId: m.sesAccessKeyId, secretAccessKey: m.sesSecretAccessKey, sessionToken: m.sesSessionToken || null },
    });
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      logger.error('SES 요청 실패', { tag: msg.tag, message: (e as Error).message });
      return { ok: false, code: 'NETWORK_ERROR', message: `메일 사업자에 연결하지 못했습니다: ${(e as Error).message}` };
    }
    let b: Record<string, unknown> = {};
    try {
      b = (await res.json()) as Record<string, unknown>;
    } catch {
      b = {};
    }
    const latencyMs = Date.now() - started;
    if (!res.ok || typeof b.MessageId !== 'string') {
      const code = String(res.headers.get('x-amzn-errortype') ?? b.__type ?? `HTTP_${res.status}`).split(':')[0]!;
      const message = String(b.message ?? b.Message ?? `HTTP ${res.status}`);
      logger.warn('SES 발송 거절', { tag: msg.tag, status: res.status, code });
      return { ok: false, code, message: `메일 발송 실패(${code}): ${message}`.slice(0, 300), latencyMs };
    }
    return { ok: true, data: { providerMessageId: b.MessageId }, latencyMs };
  },
};

export function getMailAdapter(): MailAdapter {
  return env.integrations.mail.provider === 'ses' ? sesMailAdapter : mockMailAdapter;
}

/** 실제로 메일이 나가는 구성인지(ses + 필수 설정). 이때만 화면에 "메일로 보냈습니다" 를 쓴다. */
export function mailIsLive(): boolean {
  const info = getMailAdapter().info();
  return info.mode === 'live' && info.missingCredentials.length === 0;
}

export async function sendMail(msg: MailMessage) {
  const adapter = getMailAdapter();
  try {
    return await adapter.send(msg);
  } catch (e) {
    return { ok: false, code: 'EXCEPTION', message: (e as Error).message } as ProviderResult<MailSendResult>;
  }
}
