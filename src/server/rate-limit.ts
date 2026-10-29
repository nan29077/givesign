import { headers } from 'next/headers';
import { kv } from '@/server/redis';
import { logger } from '@/lib/logger';

/**
 * IP 단위 속도 제한 공용 유틸.
 *
 * 대상은 "인증 없이 계정/자원을 만들 수 있는" 입구다.
 *  - 회원가입 / 사회복지기관 신청 : 계정 대량 생성 방지
 *  - 비밀번호 재설정 요청       : 메일 폭탄 · 계정 존재 여부 탐색 방지
 *
 * 규칙
 *  - 프록시가 붙인 주소를 알 수 없으면 공용 버킷 하나로 묶어 센다(헤더를 빼는 것으로 우회할 수 없게).
 *    모든 클라이언트가 한 버킷을 공유해 서로를 잠그는 쪽이 더 위험하다.
 *  - 카운터는 Redis(없으면 인메모리)를 쓴다. 다중 인스턴스에서는 Redis 가 필요하다.
 *  - 실패해도 예외를 밖으로 던지지 않는다. 속도 제한 저장소 장애가 가입 자체를 막으면 안 된다.
 */

/**
 * 앞단 프록시 개수. X-Forwarded-For 는 클라이언트가 임의로 붙일 수 있으므로
 * "우리가 신뢰하는 프록시가 덧붙인 홉" 만 세어 그 앞의 값을 클라이언트 주소로 본다.
 *
 * ALB 한 대면 1(기본), CloudFront+ALB 처럼 2단이면 2 로 둔다.
 * 값이 실제 구성보다 크면 헤더 위조로 제한을 우회할 수 있다.
 */
const TRUSTED_PROXY_HOPS = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS ?? '1') || 1);

/** 신뢰 프록시가 붙인 홉의 주소만 사용한다. 헤더가 없으면 null. */
export function clientIpFrom(get: (name: string) => string | null): string | null {
  const xff = get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length === 0) return null;
    // 뒤에서 TRUSTED_PROXY_HOPS 번째가 우리가 믿을 수 있는 마지막 값이다.
    // 그보다 앞쪽은 클라이언트가 임의로 채워 넣을 수 있다.
    const idx = Math.max(0, hops.length - TRUSTED_PROXY_HOPS);
    return hops[idx] ?? null;
  }
  return get('x-real-ip') ?? get('cf-connecting-ip');
}

export function clientIpFromRequest(req: Request): string | null {
  return clientIpFrom((name) => req.headers.get(name));
}

/**
 * 허용목록 비교를 위한 IP 정규화.
 *
 * 같은 주소가 여러 표기로 도착한다. 문자열을 그대로 비교하면 허용목록에 적어 둔 주소인데도
 * 거절되어 결제 콜백·MO 웹훅이 전건 401 이 된다(반대로 느슨하게 비교하면 우회를 허용한다).
 *
 *  - IPv4-mapped IPv6 : `::ffff:203.0.113.10` → `203.0.113.10`
 *  - 대괄호 표기       : `[2001:db8::1]`       → `2001:db8::1`
 *  - 포트 동반         : `203.0.113.10:51514`  → `203.0.113.10`
 *                       `[2001:db8::1]:51514`  → `2001:db8::1`
 *  - IPv6 대소문자     : 소문자로 접는다
 *
 * IPv6 축약형(`2001:0db8::1` vs `2001:db8::1`)까지 같게 보지는 않는다. 그 정규화는
 * 주소 파서가 필요하고, 허용목록은 운영자가 적는 값이므로 표기를 맞추는 편이 안전하다.
 */
export function normalizeIp(value: string | null | undefined): string {
  let v = (value ?? '').trim().toLowerCase();
  if (!v) return '';

  // [2001:db8::1]:51514 / [2001:db8::1]
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracketed) {
    v = bracketed[1]!;
  } else if (v.split(':').length === 2) {
    // 콜론이 하나면 IPv4:port 다 (IPv6 는 콜론이 둘 이상).
    v = v.slice(0, v.lastIndexOf(':'));
  }

  // IPv4-mapped IPv6 (::ffff:203.0.113.10, 0:0:0:0:0:ffff:203.0.113.10)
  const mapped = /^(?:0*:)*(?:0*f{4}:)?((?:\d{1,3}\.){3}\d{1,3})$/.exec(v);
  if (mapped) return mapped[1]!;

  return v;
}

/** 점 4개짜리 IPv4 를 32비트 정수로. 형식이 아니면 null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
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
 * 정규화한 뒤 허용목록에 있는지 확인한다. 허용목록 항목도 같은 규칙으로 정규화한다.
 *
 * 항목이 CIDR(203.0.113.0/24)이면 대역으로 판정한다. 예전에는 문자열이 같은지만 봐서,
 * 운영자가 결제사에게 받은 대역을 그대로 적어 두면 어떤 주소와도 맞지 않아
 * 콜백이 전건 거절되고 결제가 완료되지 않았다.
 */
export function isAllowedIp(ip: string | null | undefined, allowList: readonly string[]): boolean {
  const target = normalizeIp(ip);
  if (!target) return false;
  const targetInt = ipv4ToInt(target);

  return allowList.some((raw) => {
    const entry = raw.trim();
    if (!entry) return false;

    const slash = entry.indexOf('/');
    if (slash < 0) return normalizeIp(entry) === target;

    // CIDR 은 IPv4 만 지원한다(허용목록에 쓰이는 값이 사실상 IPv4 다).
    if (targetInt === null) return false;
    const base = ipv4ToInt(normalizeIp(entry.slice(0, slash)));
    const bits = Number(entry.slice(slash + 1));
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (base & mask) === (targetInt & mask);
  });
}

/**
 * 서버 액션에서 호출자의 IP 를 얻는다.
 *
 * 요청 헤더를 읽을 수 없는 실행 맥락(단위 테스트, 백그라운드 작업)에서도 예외를 던지지 않는다.
 * 주소를 모르면 null 을 돌려주고, 호출부는 공용 버킷으로 세어 제한 자체는 유지한다.
 */
export async function clientIpFromHeaders(): Promise<string | null> {
  try {
    const h = await headers();
    return clientIpFrom((name) => h.get(name));
  } catch {
    return null;
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** 현재 창에서의 시도 횟수. 제한을 적용하지 않은 경우 0. */
  count: number;
}

/**
 * 카운터를 1 증가시키고 상한을 넘었는지 판정한다.
 *
 * 주소를 알 수 없으면 공용 버킷 하나로 묶는다. 예전처럼 무조건 통과시키면
 * 헤더를 아예 보내지 않는 것만으로 모든 IP 제한을 우회할 수 있다.
 *
 * 저장소 장애 시 동작은 호출부가 정한다(failClosed).
 * - 기본(false): 통과시킨다. 저장소 장애가 일반 이용을 막지 않는다.
 * - true: 거절한다. 자격증명·토큰을 지키는 제한(로그인, 비밀번호 재설정 확인 등)은
 *   제한이 사라진 채로 열어 두는 것보다 잠시 막는 편이 낫다.
 */
export async function consumeRateLimit(
  scope: string,
  key: string | null | undefined,
  max: number,
  windowSec: number,
  options: { failClosed?: boolean } = {},
): Promise<RateLimitResult> {
  const bucket = key || 'unknown';
  try {
    const count = await kv.incr(`rl:${scope}:${bucket}`, windowSec);
    return { ok: count <= max, count };
  } catch (e) {
    logger.error('속도 제한 저장소 오류', { scope, failClosed: Boolean(options.failClosed), message: (e as Error).message });
    return { ok: !options.failClosed, count: 0 };
  }
}

/** 서버 액션용 축약형. IP 를 알 수 없으면 통과한다. */
export async function consumeIpRateLimit(
  scope: string,
  max: number,
  windowSec: number,
  options: { failClosed?: boolean } = {},
): Promise<RateLimitResult> {
  const ip = await clientIpFromHeaders();
  return consumeRateLimit(scope, ip, max, windowSec, options);
}
