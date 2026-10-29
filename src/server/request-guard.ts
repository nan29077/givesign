import { env } from '@/lib/env';

/**
 * 상태를 바꾸는 라우트 핸들러용 동일 출처 검사 (CSRF 방어).
 *
 * 세션 쿠키가 SameSite=Lax 라 폼 POST 는 기본적으로 막히지 않는다.
 * 로그인/로그아웃처럼 외부 사이트에서 강제로 트리거되면 곤란한 라우트는
 * Origin(없으면 Referer)이 우리 호스트인지 반드시 확인한다.
 */

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

export function allowedHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  const base = hostOf(env.baseUrl);
  if (base) hosts.add(base);
  // 리버스 프록시 뒤에서도 동작하도록 실제 요청 호스트를 함께 허용한다.
  const forwarded = req.headers.get('x-forwarded-host');
  if (forwarded) hosts.add(forwarded.split(',')[0]!.trim());
  const hostHeader = req.headers.get('host');
  if (hostHeader) hosts.add(hostHeader);
  const self = hostOf(req.url);
  if (self) hosts.add(self);
  return hosts;
}

/** 동일 출처 요청이면 true. Origin·Referer 가 모두 없으면 거절한다(fail-closed). */
export function isSameOrigin(req: Request): boolean {
  const hosts = allowedHosts(req);
  const origin = hostOf(req.headers.get('origin'));
  if (origin) return hosts.has(origin);
  const referer = hostOf(req.headers.get('referer'));
  if (referer) return hosts.has(referer);
  return false;
}

/**
 * 본문을 상한까지만 읽는다.
 *
 * `Content-Length` 만 보고 판단하면 chunked 전송(길이 헤더 없음)을 막지 못한다.
 * `req.text()` 로 먼저 다 읽은 뒤 크기를 재는 것도 마찬가지다 — 검사 시점에는 이미
 * 전부 메모리에 올라가 있다. 인증 이전 단계인 웹훅에서는 그 자체가 공격 표면이 된다.
 *
 * 스트림을 읽으면서 누적 바이트가 상한을 넘는 순간 중단한다.
 */
export async function readTextWithLimit(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false };

  const body = req.body;
  if (!body) {
    const text = await req.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? { ok: false } : { ok: true, text };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}
