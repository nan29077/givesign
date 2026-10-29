import crypto from 'node:crypto';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { decrypt, encrypt, generateToken } from '@/lib/crypto';
import { logger } from '@/lib/logger';

/**
 * 사회복지기관 웹훅.
 *
 * 사회복지기관이 주기적으로 가져가는(pull) 대신, 일이 생긴 순간 밀어 준다.
 *
 * 설계에서 지키는 두 가지
 *  1. **발행이 본 흐름을 막지 않는다.** 결제 성공 처리가 사회복지기관 서버 사정 때문에
 *     실패하면 안 된다. 그래서 `emitMerchantEvent` 는 적재만 하고 전송은 따로 돈다.
 *     이 함수는 어떤 경우에도 예외를 밖으로 던지지 않는다.
 *  2. **중복 도착을 전제로 한다.** 실패하면 재전송하므로 같은 이벤트가 두 번 갈 수 있다.
 *     받는 쪽이 eventId 로 걸러야 하며, 문서에도 그렇게 적어 두었다.
 */

/**
 * 이벤트 목록과 실제 발생 여부.
 *
 * `live: false` 는 아직 어디서도 발행하지 않는 이벤트다. 구독은 걸어 둘 수 있지만
 * 실제로 오지는 않는다. 문서·화면이 이 값을 그대로 읽어 "준비 중"으로 표시하므로,
 * 발행 지점을 붙일 때 여기 값도 함께 바꿔야 한다.
 */
export const WEBHOOK_EVENT_META = [
  { type: 'charge.succeeded', live: true, label: '결제가 완료되었습니다' },
  { type: 'charge.failed', live: true, label: '결제가 실패했습니다' },
  { type: 'mo.received', live: true, label: '후원자가 문자를 보냈습니다' },
  { type: 'shipment.updated', live: true, label: '배송 상태가 바뀌었습니다' },
  { type: 'payer.linked', live: true, label: '후원자 연결이 만들어졌습니다' },
  { type: 'product.stock_low', live: true, label: '재고가 기준 아래로 떨어졌습니다' },
  { type: 'charge.refunded', live: false, label: '결제가 환불되었습니다' },
  { type: 'mt.delivered', live: false, label: '보낸 문자가 도달했습니다' },
  { type: 'mt.failed', live: false, label: '보낸 문자가 실패했습니다' },
  { type: 'settlement.paid', live: false, label: '정산금이 지급되었습니다' },
] as const;

/** 사회복지기관이 구독할 수 있는 이벤트. 문서와 검증이 같은 목록을 쓴다. */
export const WEBHOOK_EVENTS = WEBHOOK_EVENT_META.map((e) => e.type);

export type WebhookEvent = (typeof WEBHOOK_EVENT_META)[number]['type'];

/** 재시도 간격(초). 앞은 촘촘하고 뒤로 갈수록 벌린다. 다 쓰면 DEAD 가 된다. */
const RETRY_DELAYS_SEC = [30, 120, 600, 3600, 21600];

/** 전송 타임아웃. 받는 쪽이 느리면 재시도가 쌓이므로 짧게 끊는다. */
const TIMEOUT_MS = 10_000;

/**
 * 큐에서 집어 온 건을 붙잡아 두는 시간.
 *
 * 전송이 타임아웃까지 걸려도 이 안에 끝난다. 처리 중에 프로세스가 죽어도 이 시간이 지나면
 * 다음 크론이 다시 집어가므로 건이 영원히 묻히지 않는다.
 */
const CLAIM_LEASE_MS = 60_000;

export const WEBHOOK_HEADERS = {
  id: 'x-givesign-event-id',
  type: 'x-givesign-event-type',
  timestamp: 'x-givesign-timestamp',
  signature: 'x-givesign-signature',
} as const;

/** 서명 원문: `{timestamp}.{eventId}.{본문 원문}` — 사회복지기관 API 서명과 같은 형태로 맞췄다. */
export function webhookSignaturePayload(timestamp: string, eventId: string, rawBody: string): string {
  return `${timestamp}.${eventId}.${rawBody}`;
}

export function signWebhook(secret: string, timestamp: string, eventId: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(webhookSignaturePayload(timestamp, eventId, rawBody)).digest('hex');
}

/**
 * 이 IP 로는 절대 요청을 보내지 않는다.
 *
 * 문자열 패턴만 보면 `127.0.0.2`·`0.0.0.0`·`[::1]`·`169.254.169.254`(클라우드 메타데이터)가
 * 전부 빠져나간다. 실제 주소로 파싱해서 대역으로 판정한다.
 */
function isBlockedIp(ip: string): boolean {
  // IPv4
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0) return true; // 0.0.0.0/8 — "이 호스트"
    if (a === 10) return true; // 사설
    if (a === 127) return true; // 루프백 전체(127.0.0.2 포함)
    if (a === 169 && b === 254) return true; // 링크로컬 · 클라우드 메타데이터(169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // 사설
    if (a === 192 && b === 168) return true; // 사설
    if (a === 100 && b >= 64 && b <= 127) return true; // 통신사 대규모 NAT
    if (a >= 224) return true; // 멀티캐스트 · 예약
    return false;
  }
  // IPv6 (대괄호는 벗겨서 들어온다)
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true; // 미지정 · 루프백
  if (v6.startsWith('fe80:')) return true; // 링크로컬
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // 유니크 로컬 (fc00::/7)
  // IPv4 사상 주소(::ffff:127.0.0.1)는 안쪽 주소로 다시 판정한다.
  const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v6);
  if (mapped) return isBlockedIp(mapped[1]!);
  return false;
}

/** 호스트 이름이 곧 IP 인지(도메인이 아니라) 본다. */
function hostAsIp(host: string): string | null {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return bare;
  if (bare.includes(':')) return bare;
  return null;
}

/** 수신 URL 형식 검사. 평문 http 와 사설망 주소는 받지 않는다. */
export function validateWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, message: 'URL 형식이 올바르지 않습니다.' };
  }
  if (parsed.protocol !== 'https:') {
    // 평문으로 보내면 결제 정보가 중간에서 그대로 읽힌다.
    return { ok: false, message: '수신 URL 은 https 여야 합니다.' };
  }
  const host = parsed.hostname.toLowerCase();
  const ip = hostAsIp(host);
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    (ip !== null && isBlockedIp(ip));
  if (isPrivate) {
    // 사설망 주소를 받아 두면 우리 서버가 내부망을 긁는 통로가 된다(SSRF).
    return { ok: false, message: '내부망 주소는 수신 URL 로 등록할 수 없습니다.' };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * 전송 직전 최종 확인.
 *
 * 등록 시점 검사만으로는 두 가지를 못 막는다.
 *  1) DNS 리바인딩 — 등록할 때는 공인 IP 를 주고, 보낼 때 내부 IP 를 준다.
 *  2) 리다이렉트 — 공인 주소가 302 로 내부 주소를 가리킨다.
 * 그래서 보낼 때마다 이름을 직접 풀어 보고, 리다이렉트는 따라가지 않는다(redirect: 'manual').
 *
 * 이름 풀이 자체가 실패하면 막지 않고 그대로 보낸다. 막아야 할 것은 "**풀렸는데** 내부망인
 * 주소" 이고, 풀리지 않는 이름은 fetch 도 똑같이 실패하므로 여기서 따로 거절할 이유가 없다.
 * (조회 실패를 차단으로 다루면 사내 DNS 가 잠깐 흔들릴 때 전 사회복지기관 웹훅이 함께 멈춘다)
 */
async function assertSafeTarget(rawUrl: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const checked = validateWebhookUrl(rawUrl);
  if (!checked.ok) return { ok: false, reason: checked.message };

  const host = new URL(checked.url).hostname.toLowerCase();
  if (hostAsIp(host)) return { ok: true }; // 위에서 이미 대역을 봤다

  try {
    const { lookup } = await import('node:dns/promises');
    const records = await lookup(host, { all: true });
    const bad = records.find((r) => isBlockedIp(r.address));
    if (bad) return { ok: false, reason: `내부망 주소로 연결됩니다(${bad.address}).` };
  } catch {
    // 조회 실패 — 아래 fetch 가 같은 이유로 실패하며 오류를 기록한다.
  }
  return { ok: true };
}

/** 수신 URL 등록. 서명 비밀키는 이때 한 번만 돌려준다. */
export async function registerWebhook(input: {
  merchantId: string;
  url: string;
  events: string[];
  description?: string | null;
}) {
  const checked = validateWebhookUrl(input.url);
  if (!checked.ok) return { ok: false as const, message: checked.message };

  const unknown = input.events.filter((e) => !WEBHOOK_EVENTS.includes(e as WebhookEvent));
  if (unknown.length > 0) {
    return { ok: false as const, message: `알 수 없는 이벤트입니다: ${unknown.join(', ')}` };
  }

  const secret = generateToken(32);
  const row = await prisma.merchantWebhook.create({
    data: {
      id: newId(),
      merchantId: input.merchantId,
      url: checked.url,
      secretEnc: encrypt(secret),
      events: input.events.join(','),
      description: input.description?.slice(0, 100) ?? null,
    },
  });
  return { ok: true as const, webhook: row, secret };
}

/**
 * 이벤트 발행.
 *
 * 구독 중인 수신 URL 수만큼 전송 건을 적재하고, 즉시 한 번 보내 본다.
 * 실패하면 재시도 일정에 올라간다. **어떤 경우에도 예외를 밖으로 던지지 않는다.**
 */
export async function emitMerchantEvent(
  merchantId: string,
  type: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const hooks = await prisma.merchantWebhook.findMany({ where: { merchantId, active: true } });
    const targets = hooks.filter((h) => !h.events || h.events.split(',').filter(Boolean).includes(type));
    if (targets.length === 0) return;

    const eventId = newId();
    const payload = JSON.stringify({
      eventId,
      type,
      occurredAt: new Date().toISOString(),
      merchantId,
      data,
    });

    const created = await Promise.all(
      targets.map((hook) =>
        prisma.webhookDelivery.create({
          data: {
            id: newId(),
            merchantId,
            webhookId: hook.id,
            eventId,
            eventType: type,
            payload,
            nextAttemptAt: new Date(),
          },
        }),
      ),
    );

    // 즉시 한 번 시도한다. 여기서 실패해도 크론이 다시 집어간다.
    for (const delivery of created) {
      void deliverOnce(delivery.id).catch(() => undefined);
    }
  } catch (e) {
    // 웹훅 때문에 결제·정산 흐름이 멈추면 안 된다. 기록만 남기고 넘어간다.
    logger.warn('웹훅 발행 실패', { merchantId, type, message: (e as Error).message });
  }
}

/** 전송 1회 시도. 성공하면 SENT, 실패하면 다음 재시도 시각을 잡는다. */
export async function deliverOnce(deliveryId: string): Promise<boolean> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  });
  if (!delivery || delivery.status === 'SENT') return false;
  if (!delivery.webhook.active) return false;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhook(decrypt(delivery.webhook.secretEnc), timestamp, delivery.eventId, delivery.payload);

  let responseStatus: number | null = null;
  let error: string | null = null;

  const safe = await assertSafeTarget(delivery.webhook.url);
  if (!safe.ok) {
    error = `차단된 주소: ${safe.reason}`.slice(0, 200);
    logger.warn('웹훅 전송 차단', { deliveryId, webhookId: delivery.webhookId, reason: safe.reason });
  } else {
    try {
      const res = await fetch(delivery.webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_HEADERS.id]: delivery.eventId,
          [WEBHOOK_HEADERS.type]: delivery.eventType,
          [WEBHOOK_HEADERS.timestamp]: timestamp,
          [WEBHOOK_HEADERS.signature]: signature,
        },
        body: delivery.payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // 리다이렉트를 따라가면 공인 주소가 302 로 내부망을 가리키는 것을 막을 수 없다.
        // 3xx 는 그대로 "실패" 로 본다(정상 수신 서버라면 2xx 를 준다).
        redirect: 'manual',
      });
      responseStatus = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).message.slice(0, 200);
    }
  }

  const ok = responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
  const attempts = delivery.attempts + 1;
  const delay = RETRY_DELAYS_SEC[attempts - 1];

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts,
      responseStatus,
      error,
      status: ok ? 'SENT' : delay === undefined ? 'DEAD' : 'PENDING',
      deliveredAt: ok ? new Date() : null,
      nextAttemptAt: ok || delay === undefined ? null : new Date(Date.now() + delay * 1000),
    },
  });
  await prisma.merchantWebhook
    .update({ where: { id: delivery.webhookId }, data: { lastStatus: responseStatus, lastAt: new Date() } })
    .catch(() => undefined);

  return ok;
}

/**
 * 재시도 시각이 된 전송 건을 처리한다. 크론이 부른다.
 *
 * 집어 온 건은 곧바로 다음 시도 시각을 미뤄 **선점**한다.
 * 선점하지 않으면 크론이 겹쳐 돌거나 사회복지기관이 수동 재시도를 누를 때 같은 이벤트가
 * 두 번 나가고, 받는 쪽은 그것을 두 건의 결제로 처리한다.
 */
export async function drainWebhookQueue(limit = 50): Promise<{ tried: number; sent: number }> {
  const now = new Date();
  const rows = await prisma.webhookDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
    select: { id: true, nextAttemptAt: true },
  });

  const claimed: string[] = [];
  for (const row of rows) {
    // nextAttemptAt 을 조건에 함께 걸어, 그 사이 다른 실행이 집어간 건은 건너뛴다.
    const took = await prisma.webhookDelivery.updateMany({
      where: { id: row.id, status: 'PENDING', nextAttemptAt: row.nextAttemptAt },
      data: { nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
    });
    if (took.count === 1) claimed.push(row.id);
  }

  let sent = 0;
  for (const id of claimed) {
    if (await deliverOnce(id).catch(() => false)) sent += 1;
  }
  return { tried: claimed.length, sent };
}
