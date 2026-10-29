import crypto from 'node:crypto';
import { prisma } from '@/server/db';
import type { ApiKeyMode } from '@/generated/prisma/client';
import { decrypt, encrypt, generateToken, safeEqual, tokenHash } from '@/lib/crypto';
import { newId } from '@/lib/id';
import { kv } from '@/server/redis';
import { logger } from '@/lib/logger';
import { clientIpFromRequest, normalizeIp } from '@/server/rate-limit';

/**
 * 사회복지기관 연동 API 인증.
 *
 * 기브싸인은 사회복지기관에 API 연동을 **요구하지 않는다.** 사회복지기관은 기브싸인 관리자
 * 화면에서 후원 내역을 확인하고 처리 상태를 표시할 수 있다.
 * 이 API 는 자기 시스템(후원자 관리 프로그램 등)에 후원 내역을 자동으로 가져가려는 사회복지기관을 위한 선택 기능이다.
 *
 * 인증 규칙
 *  - 모든 요청: Authorization: Bearer <API 키>
 *  - 상태를 바꾸는 요청(POST): HMAC-SHA256 서명 필수 (재전송 공격 차단)
 *  - 조회 요청(GET): 서명이 있으면 검증하고, 없으면 Bearer 만으로 통과
 *  - 키는 해시로만 저장한다. 원문은 발급 시 1회만 노출하고 다시 볼 수 없다.
 */

/** 키 앞부분 길이(식별·조회용). 원문 전체를 저장하지 않으므로 이 값만 화면에 남는다. */
const PREFIX_LEN = 12;
/** 서명 타임스탬프 허용 오차 (초). 시계 오차를 감안해 5분. */
export const SIGNATURE_SKEW_SEC = 300;
/** 분당 요청 허용치 (키 단위) */
const RATE_LIMIT_PER_MIN = 300;

export const PARTNER_HEADERS = {
  timestamp: 'x-givesign-timestamp',
  signature: 'x-givesign-signature',
} as const;

export interface PartnerAuthOk {
  ok: true;
  merchantId: string;
  keyId: string;
  /**
   * 키 모드. TEST 키로 온 요청은 샌드박스 데이터만 보고 바꾼다.
   * 라우트가 이 값을 보고 갈라야 하며, 확인하지 않으면 테스트 호출이 운영 데이터를 건드린다.
   */
  mode: ApiKeyMode;
}

export interface PartnerAuthFail {
  ok: false;
  status: number;
  code: string;
  message: string;
  /**
   * 키까지는 확인됐지만 그 다음 단계에서 막힌 경우의 소속 사회복지기관.
   * 이 값이 있어야 실패한 호출도 사회복지기관의 연동 로그에 남길 수 있다.
   */
  merchantId?: string;
  keyId?: string;
}

export type PartnerAuthResult = PartnerAuthOk | PartnerAuthFail;

function fail(
  status: number,
  code: string,
  message: string,
  owner?: { merchantId: string; keyId: string },
): PartnerAuthFail {
  return { ok: false, status, code, message, ...owner };
}

/** 점 4개짜리 IPv4 를 32비트 정수로. 형식이 아니면 null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/**
 * 요청 IP 가 허용목록(쉼표 구분, IPv4 또는 CIDR)에 드는지.
 * IPv6 로 들어오는 요청은 허용목록을 쓴 순간 막힌다 — 허용목록은 명시적 opt-in 이므로 그게 맞다.
 */
export function ipAllowed(ip: string, allowed: string): boolean {
  const target = ipv4ToInt(ip);
  if (target === null) return false;
  for (const entry of allowed.split(',').map((v) => v.trim()).filter(Boolean)) {
    const [addr, bitsRaw] = entry.split('/');
    const base = ipv4ToInt(addr ?? '');
    if (base === null) continue;
    if (bitsRaw === undefined) {
      if (base === target) return true;
      continue;
    }
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((base & mask) === (target & mask)) return true;
  }
  return false;
}

/** 서명 원문: `{timestamp}.{METHOD}.{path}.{rawBody}` */
export function signaturePayload(timestamp: string, method: string, path: string, rawBody: string): string {
  return `${timestamp}.${method.toUpperCase()}.${path}.${rawBody}`;
}

export function signPartnerRequest(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  rawBody: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(signaturePayload(timestamp, method, path, rawBody))
    .digest('hex');
}

/**
 * 새 API 키 발급.
 * 반환한 apiKey / signingSecret 은 저장하지 않는다. 호출자가 화면에 1회 노출한 뒤 버려야 한다.
 */
export async function issueMerchantApiKey(merchantId: string, name: string, mode: ApiKeyMode = 'LIVE') {
  // 접두사를 모드별로 갈라 둔다. 운영 키를 테스트 코드에 붙여 놓고 실제 결제가
  // 나가는 사고가 가장 흔한데, 눈으로 바로 구분되면 대부분 걸러진다.
  const apiKey = `${mode === 'TEST' ? 'gs_test_' : 'gs_live_'}${generateToken(24)}`;
  const signingSecret = generateToken(32);

  const row = await prisma.merchantApiKey.create({
    data: {
      id: newId(),
      merchantId,
      name: name.slice(0, 40) || '연동 키',
      prefix: apiKey.slice(0, PREFIX_LEN),
      keyHash: tokenHash(apiKey),
      signingEnc: encrypt(signingSecret),
      mode,
    },
    select: { id: true, prefix: true, name: true, mode: true, createdAt: true },
  });

  return { ...row, apiKey, signingSecret };
}

/**
 * 요청 인증.
 *
 * @param rawBody POST 본문 원문. 서명 검증에 쓰므로 JSON.parse 전의 문자열이어야 한다.
 */
export async function authenticatePartner(
  req: Request,
  rawBody: string,
  now: Date = new Date(),
): Promise<PartnerAuthResult> {
  const header = req.headers.get('authorization') ?? '';
  const matched = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!matched) return fail(401, 'UNAUTHORIZED', 'Authorization: Bearer <API 키> 헤더가 필요합니다.');

  const presented = matched[1]!.trim();
  const key = await prisma.merchantApiKey.findUnique({
    where: { keyHash: tokenHash(presented) },
    select: {
      id: true, merchantId: true, revokedAt: true, signingEnc: true, allowedIps: true, mode: true,
      merchant: { select: { status: true } },
    },
  });
  if (!key) return fail(401, 'INVALID_KEY', 'API 키가 올바르지 않습니다.');
  const owner = { merchantId: key.merchantId, keyId: key.id };
  if (key.revokedAt) return fail(401, 'REVOKED_KEY', '폐기된 API 키입니다.', owner);
  if (key.merchant.status !== 'APPROVED') {
    return fail(403, 'MERCHANT_NOT_ACTIVE', '이용할 수 없는 사회복지기관 상태입니다.', owner);
  }

  // IP 허용목록. 키가 유출되어도 등록한 서버 밖에서는 쓸 수 없게 한다.
  // 값이 없으면 제한하지 않는다(기존 연동을 끊지 않기 위해서다).
  if (key.allowedIps) {
    // 프록시가 붙인 값은 `::ffff:203.0.113.10` 이나 `203.0.113.10:51514` 처럼 올 수 있다.
    // 정규화하지 않으면 ipv4ToInt 가 그대로 실패해, 허용목록에 제대로 적어 둔 사회복지기관이
    // 이유 없이 403 을 받는다.
    const ip = normalizeIp(clientIpFromRequest(req));
    if (!ip || !ipAllowed(ip, key.allowedIps)) {
      return fail(403, 'IP_NOT_ALLOWED', '허용되지 않은 IP 에서의 요청입니다.', owner);
    }
  }

  // 분당 요청 제한 (키 단위)
  const minuteBucket = Math.floor(now.getTime() / 60_000);
  let used: number;
  try {
    used = await kv.incr(`partner:rate:${key.id}:${minuteBucket}`, 90);
  } catch (e) {
    // 예전에는 .catch(() => 0) 으로 통과시켰다. 저장소가 죽으면 제한이 통째로 사라진다.
    logger.error('파트너 API 속도 제한 저장소 오류 — 요청을 거절합니다', { message: (e as Error).message });
    return fail(503, 'RATE_LIMIT_UNAVAILABLE', '요청 처리가 일시적으로 지연되고 있습니다. 잠시 후 다시 시도해 주세요.', owner);
  }
  if (used > RATE_LIMIT_PER_MIN) {
    return fail(429, 'RATE_LIMITED', `분당 요청 한도(${RATE_LIMIT_PER_MIN}회)를 초과했습니다.`, owner);
  }

  const method = req.method.toUpperCase();
  const path = new URL(req.url).pathname;
  const ts = req.headers.get(PARTNER_HEADERS.timestamp);
  const sig = req.headers.get(PARTNER_HEADERS.signature);
  const writeMethod = method !== 'GET' && method !== 'HEAD';

  if (writeMethod && (!ts || !sig)) {
    return fail(401, 'SIGNATURE_REQUIRED', '상태를 바꾸는 요청에는 서명 헤더가 필요합니다.', owner);
  }

  if (ts || sig) {
    if (!ts || !sig) return fail(401, 'SIGNATURE_INVALID', '타임스탬프와 서명을 함께 보내야 합니다.', owner);
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return fail(401, 'SIGNATURE_INVALID', '타임스탬프 형식이 올바르지 않습니다.', owner);
    // 초 단위 epoch 로 받는다. 밀리초로 보내면 오차 검사에서 걸린다.
    if (Math.abs(Math.floor(now.getTime() / 1000) - tsNum) > SIGNATURE_SKEW_SEC) {
      return fail(401, 'SIGNATURE_EXPIRED', `타임스탬프 오차가 ${SIGNATURE_SKEW_SEC}초를 넘습니다.`, owner);
    }

    const expected = signPartnerRequest(decrypt(key.signingEnc), ts, method, path, rawBody);
    if (!safeEqual(expected, sig.trim().toLowerCase())) {
      return fail(401, 'SIGNATURE_INVALID', '서명이 올바르지 않습니다.', owner);
    }

    // 같은 서명 재사용(재전송) 차단. 쓰기 요청에만 적용한다.
    if (writeMethod) {
      let fresh: boolean;
      try {
        fresh = await kv.setnx(`partner:nonce:${key.id}:${sig}`, '1', SIGNATURE_SKEW_SEC * 2);
      } catch (e) {
        // 예전에는 .catch(() => true) 로 "새 서명" 취급했다. 저장소 장애 중에는
        // 재전송 방어가 통째로 사라져 같은 서명을 반복 실행할 수 있었다.
        logger.error('파트너 API 재전송 방어 저장소 오류 — 요청을 거절합니다', { message: (e as Error).message });
        return fail(503, 'REPLAY_GUARD_UNAVAILABLE', '요청 처리가 일시적으로 지연되고 있습니다. 잠시 후 다시 시도해 주세요.', owner);
      }
      if (!fresh) return fail(409, 'REPLAYED', '이미 처리된 요청입니다(서명 재사용).', owner);
    }
  }

  // 마지막 사용 시각은 실패해도 요청을 막지 않는다.
  prisma.merchantApiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: now } })
    .catch((e) => logger.warn('API 키 사용 시각 기록 실패', { message: (e as Error).message }));

  return { ok: true, merchantId: key.merchantId, keyId: key.id, mode: key.mode };
}
