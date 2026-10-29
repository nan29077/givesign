import { env, isLocal } from '@/lib/env';
import { safeEqual } from '@/lib/crypto';
import type { AdapterInfo } from '../types';
import { verifyMoRequest, type MoAdapter, type MoInbound } from './index';

/**
 * MTONET 050 MO 수신 어댑터.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 계약 진행 중(구두 계약 완료) 상태에서 미리 구현한 것이다.
 * 국내 050 MO 서비스의 표준 방식인 **"URL 방식"(수신 즉시 고객사 URL 로 HTTP 푸시)** 을 전제로 한다.
 * **연동규격서 수령 후 반드시 대조할 것**: 필드명 후보는 FIELD_ALIASES 에 모아 두었으므로
 * 규격서와 다르면 그 목록만 고치면 된다.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 안전 원칙
 *  - 서명/IP 검증은 공용 verifyMoRequest 를 그대로 쓴다 (운영에서 fail-closed).
 *  - 필수값이 하나라도 없으면 파싱을 실패시킨다. 임의 기본값으로 결제를 만들지 않는다.
 *  - 수신번호는 050 형식만 허용한다. 형식이 다르면 라우팅 사고이므로 즉시 거절한다.
 */

/** 규격서 수령 시 이 표만 맞추면 된다. 앞에 있는 이름부터 우선 사용한다. */
export const FIELD_ALIASES = {
  messageId: ['msgId', 'messageId', 'msg_id', 'seqNo', 'trId'],
  to: ['callee', 'recvNo', 'to', 'rcvNumber', 'svcNo', 'destNo'],
  from: ['caller', 'sendNo', 'from', 'callerNo', 'srcNo'],
  text: ['msg', 'message', 'text', 'content', 'smsMsg'],
  type: ['msgType', 'type', 'kind'],
  receivedAt: ['recvDate', 'receivedAt', 'regDate', 'sendDate', 'trDate'],
  subject: ['subject', 'title'],
} as const;

function firstOf(body: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = body[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/** 숫자만 남긴다 (하이픈·공백·국가번호 표기 제거). */
function digitsOnly(v: string): string {
  return v.replace(/[^\d]/g, '');
}

/**
 * MTONET 이 보내는 시각 표기를 Date 로 바꾼다.
 * 'yyyyMMddHHmmss' / 'yyyy-MM-dd HH:mm:ss' / ISO 를 모두 받아들이고,
 * 타임존 표기가 없으면 KST 로 해석한다 (사업자 서버가 KST 기준이므로).
 */
export function parseMtonetDate(raw: string | null, fallback: Date = new Date()): Date {
  if (!raw) return fallback;

  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`);
  }

  const spaced = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (spaced) {
    const [, y, mo, d, h, mi, s] = spaced;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`);
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function normalizeType(raw: string | null, text: string): MoInbound['messageType'] {
  const v = (raw ?? '').toUpperCase();
  if (v.includes('MMS')) return 'MMS';
  if (v.includes('LMS')) return 'LMS';
  if (v.includes('SMS')) return 'SMS';
  // 표기가 없으면 길이로 추정한다 (SMS 는 EUC-KR 90바이트 기준).
  return Buffer.byteLength(text, 'utf8') > 90 ? 'LMS' : 'SMS';
}

export const mtonetMoAdapter: MoAdapter = {
  info(): AdapterInfo {
    const missing: string[] = [];
    if (!env.mo.webhookSecret && !isLocal) missing.push('MO_WEBHOOK_SECRET');
    if (env.mo.allowedIps.length === 0 && !isLocal) missing.push('MO_ALLOWED_IPS');
    return { provider: 'mtonet', mode: missing.length > 0 ? 'mock' : 'live', missingCredentials: missing };
  },

  verify(rawBody, headers, ip) {
    // 사업자가 별도 서명 헤더를 쓰는 경우를 위해 후보를 모두 받아 준다.
    const base = verifyMoRequest(rawBody, headers, ip, [
      'x-mtonet-signature',
      'x-signature',
      'x-givesign-signature',
    ]);
    if (!base.ok) return base;

    // 규격서에 사업자 계정(userId) 확인이 있으면 함께 검사한다.
    if (env.mo.mtonetApiKey) {
      const key = headers['x-mtonet-apikey'] ?? headers['x-api-key'] ?? '';
      if (!key) return { ok: false, reason: 'API 키 헤더 없음' };
      if (!safeEqual(key, env.mo.mtonetApiKey)) {
        return { ok: false, reason: 'API 키 불일치' };
      }
    }

    return { ok: true };
  },

  parse(body): MoInbound {
    const b = (body ?? {}) as Record<string, unknown>;
    // 사업자에 따라 payload 를 한 겹 감싸는 경우가 있다.
    const inner =
      typeof b.data === 'object' && b.data !== null
        ? (b.data as Record<string, unknown>)
        : typeof b.result === 'object' && b.result !== null
          ? (b.result as Record<string, unknown>)
          : b;

    const messageId = firstOf(inner, FIELD_ALIASES.messageId);
    const to = firstOf(inner, FIELD_ALIASES.to);
    const from = firstOf(inner, FIELD_ALIASES.from);
    const text = firstOf(inner, FIELD_ALIASES.text);

    // 필수값이 없으면 임의 기본값으로 채우지 않고 실패시킨다.
    // (여기서 관대하게 처리하면 잘못된 사회복지기관에 결제가 꽂힌다)
    const missing = [
      messageId ? null : 'messageId',
      to ? null : 'to(수신 050 번호)',
      from ? null : 'from(발신번호)',
      text ? null : 'text(본문)',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`MTONET MO payload 필수값 누락: ${missing.join(', ')}`);
    }

    const receivedNumber = digitsOnly(to!);
    if (!/^050\d{7,10}$/.test(receivedNumber)) {
      throw new Error(`MTONET MO 수신번호 형식 오류(050 번호가 아님): ${receivedNumber}`);
    }

    const fromNumber = digitsOnly(from!);
    if (!/^0\d{8,10}$/.test(fromNumber)) {
      throw new Error('MTONET MO 발신번호 형식 오류');
    }

    // LMS/MMS 는 제목이 따로 오므로 본문 앞에 붙여 사회복지기관이 전체 맥락을 보게 한다.
    const subject = firstOf(inner, FIELD_ALIASES.subject);
    const content = subject ? `${subject} ${text!}` : text!;

    return {
      providerMessageId: messageId!,
      providerCode: 'mtonet',
      receivedNumber,
      fromNumber,
      messageType: normalizeType(firstOf(inner, FIELD_ALIASES.type), content),
      content,
      receivedAt: parseMtonetDate(firstOf(inner, FIELD_ALIASES.receivedAt)),
    };
  },
};
