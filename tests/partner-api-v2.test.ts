import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/server/db';
import { inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import { issueMerchantApiKey, signPartnerRequest } from '@/server/services/partner-auth';
import { merchantPayerRef } from '@/lib/crypto';
import { emitMerchantEvent, signWebhook, validateWebhookUrl } from '@/server/services/webhooks';
import { buildOpenApiDocument } from '@/server/api-docs/openapi';
import { allEndpoints } from '@/server/api-docs';
import { GET as hookList, POST as hookCreate } from '@/app/api/partner/v1/webhooks/route';
import { DELETE as hookDelete } from '@/app/api/partner/v1/webhooks/[id]/route';
import { GET as deliveryList } from '@/app/api/partner/v1/webhooks/deliveries/route';
import { POST as deliveryRetry } from '@/app/api/partner/v1/webhooks/deliveries/[id]/retry/route';
import { GET as productList, POST as productCreate } from '@/app/api/partner/v1/products/route';
import { PATCH as productPatch, DELETE as productArchive } from '@/app/api/partner/v1/products/[id]/route';
import { PATCH as stockPatch } from '@/app/api/partner/v1/products/[id]/stock/route';
import { POST as productBulk } from '@/app/api/partner/v1/products/bulk/route';
import { GET as payerGet } from '@/app/api/partner/v1/payers/[payerRef]/route';
import { POST as payerLink } from '@/app/api/partner/v1/payers/link/route';
import { DELETE as payerUnlink } from '@/app/api/partner/v1/payers/link/[payerRef]/route';
import { GET as payerCharges } from '@/app/api/partner/v1/payers/[payerRef]/charges/route';
import { GET as statsDaily } from '@/app/api/partner/v1/stats/daily/route';
import { GET as statsMessages } from '@/app/api/partner/v1/stats/messages/route';
import { GET as feesGet } from '@/app/api/partner/v1/fees/route';
import { GET as settlementList } from '@/app/api/partner/v1/settlements/route';

/**
 * 4~6단계 (웹훅 · 상품·후원자 · 정산·통계·도구).
 *
 * 웹훅은 실제 네트워크를 쓰지 않고 fetch 를 갈아 끼워 검증한다.
 * 확인할 것은 "서명이 제대로 붙는가"와 "실패했을 때 재시도가 잡히는가" 두 가지다.
 */

const BASE = 'https://pay.example.com';
let fx: Fixture;
let key: Awaited<ReturnType<typeof issueMerchantApiKey>>;

function get(path: string) {
  return new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${key.apiKey}` } });
}

function signed(method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown) {
  const raw = JSON.stringify(body ?? {});
  const stamp = Math.floor(Date.now() / 1000).toString();
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key.apiKey}`,
      'content-type': 'application/json',
      'x-givesign-timestamp': stamp,
      'x-givesign-signature': signPartnerRequest(key.signingSecret, stamp, method, path, raw),
    },
    body: raw,
  });
}

async function registerHook(events: string[] = []) {
  const res = await hookCreate(
    signed('POST', '/api/partner/v1/webhooks', { url: 'https://hooks.example.com/mp', events }),
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { status: 'APPROVED' } });
  key = await issueMerchantApiKey(fx.merchantId, 'v2 키', 'LIVE');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('웹훅 — 등록', () => {
  it('[1] http 주소는 거부한다', () => {
    const r = validateWebhookUrl('http://example.com/hook');
    expect(r.ok).toBe(false);
  });

  it('[2] 내부망 주소는 거부한다', () => {
    for (const url of ['https://localhost/h', 'https://127.0.0.1/h', 'https://10.0.0.5/h', 'https://192.168.0.2/h']) {
      expect(validateWebhookUrl(url).ok, url).toBe(false);
    }
  });

  it('[3] 등록하면 서명 비밀키를 한 번 돌려준다', async () => {
    const r = await registerHook(['charge.succeeded']);
    expect(r.status).toBe(200);
    expect(r.body.secret).toBeTruthy();
    expect(r.body.events).toEqual(['charge.succeeded']);

    // 목록 조회에는 비밀키가 없다.
    const list = await (await hookList(get('/api/partner/v1/webhooks'))).json();
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list.items[0])).not.toContain(r.body.secret);
  });

  it('[4] 알 수 없는 이벤트는 거부한다', async () => {
    const res = await hookCreate(
      signed('POST', '/api/partner/v1/webhooks', { url: 'https://hooks.example.com/mp', events: ['nope'] }),
    );
    expect(res.status).toBe(400);
  });
});

describe('웹훅 — 전송', () => {
  it('[5] 이벤트가 나가면 서명 헤더가 붙는다', async () => {
    const created = await registerHook(['charge.succeeded']);
    const secret = created.body.secret as string;

    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      return new Response('ok', { status: 200 });
    });

    await emitMerchantEvent(fx.merchantId, 'charge.succeeded', { transactionNo: 'MP-TEST', amount: 1000 });
    // 전송은 비동기로 시작된다. 짧게 기다린다.
    await new Promise((r) => setTimeout(r, 200));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const ts = call.headers['x-givesign-timestamp']!;
    const eventId = call.headers['x-givesign-event-id']!;
    expect(call.headers['x-givesign-signature']).toBe(signWebhook(secret, ts, eventId, call.body));

    const parsed = JSON.parse(call.body);
    expect(parsed.type).toBe('charge.succeeded');
    expect(parsed.eventId).toBe(eventId);
    expect(parsed.data.transactionNo).toBe('MP-TEST');
  });

  it('[6] 구독하지 않은 이벤트는 보내지 않는다', async () => {
    await registerHook(['mo.received']);
    const calls: string[] = [];
    vi.stubGlobal('fetch', async () => {
      calls.push('x');
      return new Response('ok', { status: 200 });
    });

    await emitMerchantEvent(fx.merchantId, 'charge.succeeded', {});
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toHaveLength(0);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it('[7] 실패하면 재시도 일정이 잡힌다', async () => {
    await registerHook([]);
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));

    await emitMerchantEvent(fx.merchantId, 'charge.succeeded', {});
    await new Promise((r) => setTimeout(r, 200));

    const row = await prisma.webhookDelivery.findFirst();
    expect(row?.status).toBe('PENDING');
    expect(row?.attempts).toBe(1);
    expect(row?.responseStatus).toBe(500);
    expect(row?.nextAttemptAt).not.toBeNull();
  });

  it('[8] 재시도를 다 쓰면 중단(DEAD)되고 수동 재전송으로 되살릴 수 있다', async () => {
    await registerHook([]);
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));
    await emitMerchantEvent(fx.merchantId, 'charge.succeeded', {});
    await new Promise((r) => setTimeout(r, 200));

    const row = await prisma.webhookDelivery.findFirst();
    // 재시도 간격 5개를 다 쓸 때까지 강제로 돌린다.
    // 본문을 매번 다르게 둔다 — 같은 초에 같은 본문이면 서명이 같아져 재전송 방어에 걸린다.
    for (let i = 0; i < 6; i += 1) {
      await deliveryRetry(signed('POST', `/api/partner/v1/webhooks/deliveries/${row!.id}/retry`, { n: i }), {
        params: Promise.resolve({ id: row!.id }),
      });
    }
    const dead = await prisma.webhookDelivery.findUnique({ where: { id: row!.id } });
    expect(dead?.status).toBe('DEAD');

    // 이제 성공하도록 바꾸고 다시 보내면 살아난다.
    vi.stubGlobal('fetch', async () => new Response('ok', { status: 200 }));
    const res = await deliveryRetry(signed('POST', `/api/partner/v1/webhooks/deliveries/${row!.id}/retry`, { n: 99 }), {
      params: Promise.resolve({ id: row!.id }),
    });
    expect((await res.json()).delivered).toBe(true);
  });

  it('[9] 전송 이력을 조회하고 수신 URL 을 해제할 수 있다', async () => {
    const created = await registerHook([]);
    vi.stubGlobal('fetch', async () => new Response('ok', { status: 200 }));
    await emitMerchantEvent(fx.merchantId, 'charge.succeeded', {});
    await new Promise((r) => setTimeout(r, 200));

    const list = await (await deliveryList(get('/api/partner/v1/webhooks/deliveries'))).json();
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items[0].status).toBe('SENT');

    const id = created.body.id as string;
    const del = await hookDelete(signed('DELETE', `/api/partner/v1/webhooks/${id}`, {}), {
      params: Promise.resolve({ id }),
    });
    expect(del.status).toBe(200);
    expect(await prisma.merchantWebhook.count()).toBe(0);
  });
});

describe('상품 동기화', () => {
  async function create(body: Record<string, unknown>) {
    const res = await productCreate(signed('POST', '/api/partner/v1/products', body));
    return { status: res.status, body: await res.json() };
  }

  it('[10] 상품을 등록하고 목록에서 볼 수 있다', async () => {
    const r = await create({ name: '머그컵', amount: 15000, kind: 'PHYSICAL', sku: 'MUG-1', stock: 10 });
    expect(r.status).toBe(200);
    expect(r.body.product.name).toBe('머그컵');
    expect(r.body.product.stock).toBe(10);

    const list = await (await productList(get('/api/partner/v1/products'))).json();
    expect(list.items.some((p: { sku: string }) => p.sku === 'MUG-1')).toBe(true);
  });

  it('[11] 잘못된 값은 거부한다', async () => {
    expect((await create({ name: '', amount: 1000 })).status).toBe(400);
    expect((await create({ name: 'x', amount: -1 })).status).toBe(400);
    expect((await create({ name: 'x', amount: 1000, kind: 'NOPE' })).status).toBe(400);
  });

  it('[12] 수정은 보낸 항목만 바꾼다', async () => {
    const created = await create({ name: '머그컵', amount: 15000, sku: 'MUG-2', description: '원래 설명' });
    const id = created.body.product.id as string;

    const res = await productPatch(signed('PATCH', `/api/partner/v1/products/${id}`, { amount: 17000 }), {
      params: Promise.resolve({ id }),
    });
    const body = await res.json();
    expect(body.product.amount).toBe(17000);
    expect(body.product.description).toBe('원래 설명');
  });

  it('[13] 삭제는 실제 삭제가 아니라 판매 중지다', async () => {
    const created = await create({ name: '머그컵', amount: 15000, sku: 'MUG-3' });
    const id = created.body.product.id as string;

    await productArchive(signed('DELETE', `/api/partner/v1/products/${id}`, {}), { params: Promise.resolve({ id }) });
    const row = await prisma.chargeProduct.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row?.archivedAt).not.toBeNull();
    expect(row?.active).toBe(false);
  });

  it('[14] 재고를 갱신하고 기준 이하면 이벤트가 나간다', async () => {
    const created = await create({ name: '머그컵', amount: 15000, sku: 'MUG-4', stock: 100 });
    const id = created.body.product.id as string;
    await registerHook(['product.stock_low']);
    vi.stubGlobal('fetch', async () => new Response('ok', { status: 200 }));

    const res = await stockPatch(signed('PATCH', `/api/partner/v1/products/${id}/stock`, { stock: 2, stockAlert: 5 }), {
      params: Promise.resolve({ id }),
    });
    expect((await res.json()).product.stock).toBe(2);
    await new Promise((r) => setTimeout(r, 150));
    expect(await prisma.webhookDelivery.count({ where: { eventType: 'product.stock_low' } })).toBe(1);
  });

  it('[15] 일괄 동기화가 만들고·갱신하고·없는 것을 내린다', async () => {
    await create({ name: '옛 상품', amount: 1000, sku: 'OLD-1' });

    const first = await productBulk(
      signed('POST', '/api/partner/v1/products/bulk', {
        items: [
          { sku: 'NEW-1', name: '새 상품 1', amount: 5000 },
          { sku: 'NEW-2', name: '새 상품 2', amount: 6000 },
        ],
        archiveMissing: true,
      }),
    );
    const body = await first.json();
    expect(body.created).toBe(2);
    expect(body.archived).toBeGreaterThanOrEqual(1);

    // 같은 sku 로 다시 보내면 갱신된다.
    const second = await productBulk(
      signed('POST', '/api/partner/v1/products/bulk', {
        items: [{ sku: 'NEW-1', name: '이름 변경', amount: 7000 }],
      }),
    );
    expect((await second.json()).updated).toBe(1);
    const row = await prisma.chargeProduct.findFirst({ where: { sku: 'NEW-1' } });
    expect(row?.name).toBe('이름 변경');
    expect(Number(row?.amount)).toBe(7000);
  });

  it('[16] sku 가 없으면 일괄 동기화를 거부한다', async () => {
    const res = await productBulk(
      signed('POST', '/api/partner/v1/products/bulk', { items: [{ name: 'x', amount: 1000 }] }),
    );
    expect(res.status).toBe(400);
  });
});

describe('후원자 연결', () => {
  async function fundedRef() {
    await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, messageId: `V2-${Date.now()}`, text: '충전' }), fx.merchantId);
    const charge = await prisma.charge.findFirst({
      where: { merchantId: fx.merchantId },
      orderBy: { createdAt: 'desc' },
      select: { payer: { select: { phoneHash: true } } },
    });
    return merchantPayerRef(fx.merchantId, charge!.payer!.phoneHash);
  }

  it('[17] payerRef 로 후원자 요약과 결제 이력을 조회한다', async () => {
    const ref = await fundedRef();

    const summary = await (
      await payerGet(get(`/api/partner/v1/payers/${ref}`), { params: Promise.resolve({ payerRef: ref }) })
    ).json();
    expect(summary.phoneMasked).toMatch(/^\d{3}-\*{4}-\d{4}$/);
    expect(summary.totalCount).toBeGreaterThan(0);
    // 원문 번호는 어떤 필드로도 나가지 않는다.
    expect(JSON.stringify(summary)).not.toContain(fx.payerPhone.replace(/\D/g, ''));

    const charges = await (
      await payerCharges(get(`/api/partner/v1/payers/${ref}/charges`), { params: Promise.resolve({ payerRef: ref }) })
    ).json();
    expect(charges.items.length).toBeGreaterThan(0);
  });

  it('[18] 회원 ID 를 연결하고 해제할 수 있다', async () => {
    const ref = await fundedRef();

    const res = await payerLink(
      signed('POST', '/api/partner/v1/payers/link', { payerRef: ref, merchantMemberId: 'member-42' }),
    );
    expect(res.status).toBe(200);
    let link = await prisma.payerMerchantLink.findFirst({ where: { merchantId: fx.merchantId } });
    expect(link?.merchantMemberId).toBe('member-42');

    await payerUnlink(signed('DELETE', `/api/partner/v1/payers/link/${ref}`, {}), {
      params: Promise.resolve({ payerRef: ref }),
    });
    link = await prisma.payerMerchantLink.findFirst({ where: { merchantId: fx.merchantId } });
    expect(link?.merchantMemberId).toBeNull();
    // 결제 이력은 남는다.
    expect(await prisma.charge.count({ where: { merchantId: fx.merchantId } })).toBeGreaterThan(0);
  });

  it('[19] 남의 payerRef 로는 찾을 수 없다', async () => {
    const res = await payerGet(get('/api/partner/v1/payers/stranger'), {
      params: Promise.resolve({ payerRef: 'stranger' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('정산·통계·도구', () => {
  it('[20] 일별·문자 집계가 나온다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, messageId: `ST-${Date.now()}`, text: '충전' }), fx.merchantId);

    const daily = await (await statsDaily(get('/api/partner/v1/stats/daily?days=7'))).json();
    expect(daily.items.length).toBeGreaterThan(0);
    expect(daily.items[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const messages = await (await statsMessages(get('/api/partner/v1/stats/messages?days=7'))).json();
    expect(messages.moReceived).toBeGreaterThan(0);
    expect(messages.mtSentByMerchant).toBe(0);
  });

  it('[21] 잘못된 기간은 거부한다', async () => {
    expect((await statsDaily(get('/api/partner/v1/stats/daily?days=0'))).status).toBe(400);
    expect((await statsDaily(get('/api/partner/v1/stats/daily?days=999'))).status).toBe(400);
  });

  it('[22] 수수료율과 정산 회차를 조회할 수 있다', async () => {
    const fees = await (await feesGet(get('/api/partner/v1/fees'))).json();
    expect(fees.ok).toBe(true);
    const settlements = await (await settlementList(get('/api/partner/v1/settlements'))).json();
    expect(Array.isArray(settlements.items)).toBe(true);
  });

  it('[23] OpenAPI 문서가 레지스트리의 모든 엔드포인트를 담는다', () => {
    const doc = buildOpenApiDocument('https://pay.example.com') as {
      paths: Record<string, Record<string, unknown>>;
    };
    const operations = Object.values(doc.paths).reduce((sum, ops) => sum + Object.keys(ops).length, 0);
    expect(operations).toBe(allEndpoints().length);
  });
});
