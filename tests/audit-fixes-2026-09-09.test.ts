import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/server/db';
import { inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import { issueMerchantApiKey, signPartnerRequest } from '@/server/services/partner-auth';
import { merchantPayerRef } from '@/lib/crypto';
import { isAllowedIp } from '@/server/rate-limit';
import { validateWebhookUrl, WEBHOOK_EVENT_META, drainWebhookQueue } from '@/server/services/webhooks';
import { reviewVariableValues, MERCHANT_MT_VARIABLE_MAX_LENGTH } from '@/server/services/merchant-mt';
import { markSettlementPaid } from '@/server/services/settlement';
import { POST as productCreate, GET as productList } from '@/app/api/partner/v1/products/route';
import { POST as hookCreate } from '@/app/api/partner/v1/webhooks/route';
import { GET as settlementList } from '@/app/api/partner/v1/settlements/route';
import { GET as statsDaily } from '@/app/api/partner/v1/stats/daily/route';
import { GET as feesGet } from '@/app/api/partner/v1/fees/route';
import { POST as sandboxFire } from '@/app/api/partner/v1/sandbox/webhooks/fire/route';
import { POST as mtSend } from '@/app/api/partner/v1/mt/messages/route';
import { POST as tplSave } from '@/app/api/partner/v1/mt/templates/route';

/**
 * 2026-09-09 전수 점검에서 나온 결함의 회귀 테스트.
 *
 * 각 테스트는 "고치기 전에는 통과하지 못했을 것" 을 확인한다.
 * 보고서의 항목 번호(H-1 …)를 제목에 남겨 두어, 왜 이 검사가 있는지 추적할 수 있게 한다.
 */

const BASE = 'https://pay.example.com';
let fx: Fixture;

type Key = { apiKey: string; signingSecret: string };

function get(key: Key, path: string) {
  return new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${key.apiKey}` } });
}

function signed(key: Key, method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown, extra: Record<string, string> = {}) {
  const raw = JSON.stringify(body ?? {});
  const stamp = Math.floor(Date.now() / 1000).toString();
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key.apiKey}`,
      'content-type': 'application/json',
      'x-givesign-timestamp': stamp,
      'x-givesign-signature': signPartnerRequest(key.signingSecret, stamp, method, path, raw),
      ...extra,
    },
    body: raw,
  });
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { status: 'APPROVED' } });
});

// ─────────────────────────────────────────────────────── H-1 테스트 키 격리

describe('H-1 · 테스트 키는 운영 데이터에 닿지 않는다', () => {
  it('[1] 테스트 키로 상품을 등록할 수 없고, 운영 상품이 생기지 않는다', async () => {
    const test = await issueMerchantApiKey(fx.merchantId, '테스트', 'TEST');
    const res = await productCreate(
      signed(test, 'POST', '/api/partner/v1/products', { name: '테스트키상품', kind: 'DIGITAL', amount: 5000, sku: 'T-1' }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('LIVE_KEY_REQUIRED');

    const leaked = await prisma.chargeProduct.findFirst({ where: { merchantId: fx.merchantId, name: '테스트키상품' } });
    expect(leaked).toBeNull();
  });

  it('[2] 테스트 키로 운영 웹훅을 등록할 수 없다', async () => {
    const test = await issueMerchantApiKey(fx.merchantId, '테스트', 'TEST');
    const res = await hookCreate(
      signed(test, 'POST', '/api/partner/v1/webhooks', { url: 'https://hooks.example.com/x', events: [] }),
    );
    expect(res.status).toBe(403);
    expect(await prisma.merchantWebhook.count({ where: { merchantId: fx.merchantId } })).toBe(0);
  });

  it('[3] 조회도 막는다 — 정산·통계·수수료·상품목록', async () => {
    const test = await issueMerchantApiKey(fx.merchantId, '테스트', 'TEST');
    const responses = await Promise.all([
      settlementList(get(test, '/api/partner/v1/settlements')),
      statsDaily(get(test, '/api/partner/v1/stats/daily')),
      feesGet(get(test, '/api/partner/v1/fees')),
      productList(get(test, '/api/partner/v1/products')),
    ]);
    for (const res of responses) expect(res.status).toBe(403);
  });

  it('[4] 운영 키는 그대로 동작한다 (가드가 과하게 걸리지 않았는지)', async () => {
    const live = await issueMerchantApiKey(fx.merchantId, '운영', 'LIVE');
    const res = await productCreate(
      signed(live, 'POST', '/api/partner/v1/products', { name: '운영상품', kind: 'DIGITAL', amount: 5000, sku: 'L-1' }),
    );
    expect(res.status).toBe(200);
    expect(await prisma.chargeProduct.count({ where: { merchantId: fx.merchantId, name: '운영상품' } })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────── H-2 샌드박스 위조

describe('H-2 · 샌드박스 이벤트는 sandbox 표식을 덮어쓸 수 없다', () => {
  it('[5] data.sandbox=false 를 보내도 전송 본문은 sandbox=true 다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const live = await issueMerchantApiKey(fx.merchantId, '운영', 'LIVE');
    await hookCreate(signed(live, 'POST', '/api/partner/v1/webhooks', { url: 'https://hooks.example.com/x', events: [] }));

    const test = await issueMerchantApiKey(fx.merchantId, '테스트', 'TEST');
    const res = await sandboxFire(
      signed(test, 'POST', '/api/partner/v1/sandbox/webhooks/fire', {
        type: 'charge.succeeded',
        data: { sandbox: false, transactionNo: 'MP-FAKE', amount: 999_999 },
      }),
    );
    expect(res.status).toBe(200);

    const delivery = await prisma.webhookDelivery.findFirst({ where: { merchantId: fx.merchantId } });
    const payload = JSON.parse(String(delivery?.payload)) as { data: { sandbox: boolean } };
    expect(payload.data.sandbox).toBe(true);
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────── H-3 문자 치환값 검수

describe('H-3 · 치환값도 검수한다', () => {
  async function approvedTemplateAndPayer() {
    const live = await issueMerchantApiKey(fx.merchantId, '운영', 'LIVE');
    await tplSave(
      signed(live, 'POST', '/api/partner/v1/mt/templates', {
        code: 'V1',
        name: '발송 안내',
        body: '{사회복지기관} 주문하신 {상품} 이(가) 발송되었습니다.',
      }),
    );
    await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, messageId: `MT-${Date.now()}`, text: '충전' }), fx.merchantId);
    const charge = await prisma.charge.findFirst({
      where: { merchantId: fx.merchantId },
      orderBy: { createdAt: 'desc' },
      select: { payer: { select: { phoneHash: true } } },
    });
    return { live, payerRef: merchantPayerRef(fx.merchantId, charge!.payer!.phoneHash) };
  }

  it('[6] 승인된 템플릿이라도 치환값에 광고·링크가 있으면 발송되지 않는다', async () => {
    const { live, payerRef } = await approvedTemplateAndPayer();
    const res = await mtSend(
      signed(
        live,
        'POST',
        '/api/partner/v1/mt/messages',
        { templateCode: 'V1', payerRef, variables: { 상품: '(광고) 지금 http://bit.ly/x 접속시 50% 할인!' } },
        { 'idempotency-key': 'ad-1' },
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_VARIABLES');
    expect(await prisma.mtOutboundMessage.count({ where: { merchantId: fx.merchantId, merchantSent: true } })).toBe(0);
  });

  it('[7] 평범한 상품명은 그대로 나간다', async () => {
    const { live, payerRef } = await approvedTemplateAndPayer();
    const res = await mtSend(
      signed(
        live,
        'POST',
        '/api/partner/v1/mt/messages',
        { templateCode: 'V1', payerRef, variables: { 상품: '머그컵 2개' } },
        { 'idempotency-key': 'ok-1' },
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).body).toContain('머그컵 2개');
  });

  it('[8] 링크·줄바꿈·중괄호·개인정보·길이를 각각 막는다', async () => {
    const cases: Record<string, string> = {
      링크: 'evil.example.com 확인',
      줄바꿈: '정상\n[다른가게] 광고',
      중괄호: '{사회복지기관}',
      개인정보: '연락처 010-1234-5678',
      길이초과: 'ㄱ'.repeat(MERCHANT_MT_VARIABLE_MAX_LENGTH + 1),
    };
    for (const [label, value] of Object.entries(cases)) {
      const r = await reviewVariableValues(fx.merchantId, { 상품: value });
      expect(r.ok, `${label} 은 거부되어야 한다`).toBe(false);
    }
    expect((await reviewVariableValues(fx.merchantId, { 상품: '머그컵' })).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────── H-4 SSRF

describe('H-4 · 웹훅 수신 주소 검사', () => {
  it('[9] 루프백·링크로컬·메타데이터·IPv6 내부 주소를 모두 막는다', () => {
    const blocked = [
      'https://127.0.0.2/hook',
      'https://0.0.0.0/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/hook',
      'https://[fd00::1]/hook',
      'https://100.64.0.1/hook',
      'https://metadata.google.internal/x',
      'https://api.internal/x',
    ];
    for (const url of blocked) {
      expect(validateWebhookUrl(url).ok, `${url} 은 막혀야 한다`).toBe(false);
    }
  });

  it('[10] 정상적인 공인 주소는 통과한다', () => {
    expect(validateWebhookUrl('https://hooks.example.com/mp').ok).toBe(true);
    expect(validateWebhookUrl('https://203.0.113.10/mp').ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────── M-2 웹훅 선점

describe('M-2 · 재전송 큐는 집어 온 건을 선점한다', () => {
  it('[11] 크론이 두 번 겹쳐 돌아도 같은 건을 두 번 보내지 않는다', async () => {
    const sent = vi.fn(async () => new Response('', { status: 500 }));
    vi.stubGlobal('fetch', sent);

    const live = await issueMerchantApiKey(fx.merchantId, '운영', 'LIVE');
    await hookCreate(signed(live, 'POST', '/api/partner/v1/webhooks', { url: 'https://hooks.example.com/x', events: [] }));
    await sandboxFire(
      signed(await issueMerchantApiKey(fx.merchantId, '테스트', 'TEST'), 'POST', '/api/partner/v1/sandbox/webhooks/fire', {
        type: 'charge.succeeded',
        data: {},
      }),
    );
    // 발행은 첫 전송을 기다리지 않고 돌아온다(결제 흐름을 막지 않기 위해서다).
    // 그 첫 시도가 끝나기 전에 시각을 당기면, 뒤늦게 끝난 시도가 다시 30초 뒤로 밀어 버린다.
    // 시도가 한 번 기록될 때까지 기다린 뒤에 당긴다.
    for (let i = 0; i < 50; i += 1) {
      const row = await prisma.webhookDelivery.findFirst({ where: { merchantId: fx.merchantId } });
      if (row && row.attempts >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // 첫 시도가 실패해 재시도 대기로 들어가 있다. 지금 보내도록 시각을 당긴다.
    const readied = await prisma.webhookDelivery.updateMany({
      where: { merchantId: fx.merchantId },
      data: { status: 'PENDING', nextAttemptAt: new Date(Date.now() - 1000) },
    });
    expect(readied.count).toBe(1);

    const [a, b] = await Promise.all([drainWebhookQueue(), drainWebhookQueue()]);
    // 두 실행이 같은 건을 집어가지 않는다 — 합쳐서 한 건만 처리된다.
    expect(a.tried + b.tried).toBe(1);
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────── M-3 문서·발행 일치

describe('M-3 · 이벤트 목록의 live 표시가 실제 발행과 맞는다', () => {
  it('[12] 실제로 발행하는 이벤트는 준비 중으로 표시하지 않는다', () => {
    const byType = Object.fromEntries(WEBHOOK_EVENT_META.map((e) => [e.type, e.live]));
    for (const type of ['payer.linked', 'product.stock_low', 'charge.succeeded', 'charge.failed', 'mo.received', 'shipment.updated']) {
      expect(byType[type], `${type} 는 실제로 발행되므로 live 여야 한다`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────── H-5 · M-7 정산

describe('H-5 · M-7 정산 확정', () => {
  /** 지급 대상 결제 한 건과 그 회차를 만든다. */
  async function seedRequest(chargeStatus: 'SETTLEMENT_PENDING' | 'REFUNDED') {
    await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, messageId: `S-${Date.now()}`, text: '충전' }), fx.merchantId);
    const charge = await prisma.charge.findFirstOrThrow({
      where: { merchantId: fx.merchantId },
      orderBy: { createdAt: 'desc' },
    });
    const request = await prisma.settlementRequest.create({
      data: {
        id: `req-${Date.now()}`,
        merchantId: fx.merchantId,
        amount: charge.amount,
        payoutAmount: charge.amount,
        withholding: 0n,
        status: 'APPROVED',
      },
    });
    await prisma.charge.update({
      where: { id: charge.id },
      data: { settlementRequestId: request.id, settledAt: null, status: chargeStatus },
    });
    return { chargeId: charge.id, requestId: request.id };
  }

  it('[13] 지급 완료 처리는 회차에 묶인 결제 건을 SETTLED 로 확정한다', async () => {
    const { chargeId, requestId } = await seedRequest('SETTLEMENT_PENDING');
    await markSettlementPaid(requestId);
    const after = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(after.status).toBe('SETTLED');
    expect(after.settledAt).not.toBeNull();
  });

  it('[14] 이미 환불된 건은 지급 완료 처리로 되살아나지 않는다', async () => {
    const { chargeId, requestId } = await seedRequest('REFUNDED');
    await markSettlementPaid(requestId);
    const after = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(after.status).toBe('REFUNDED');
    expect(after.settledAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────── L-25 통계

describe('L-25 · 일별 통계의 환불 건수', () => {
  it('[15] 환불된 건이 refundedCount 에 잡힌다', async () => {
    const live = await issueMerchantApiKey(fx.merchantId, '운영', 'LIVE');
    await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, messageId: `R-${Date.now()}`, text: '충전' }), fx.merchantId);
    const charge = await prisma.charge.findFirstOrThrow({
      where: { merchantId: fx.merchantId },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.charge.update({
      where: { id: charge.id },
      data: { status: 'REFUNDED', refundedAt: new Date() },
    });

    const res = await statsDaily(get(live, '/api/partner/v1/stats/daily?days=7'));
    const body = (await res.json()) as { items: { refundedCount: number }[] };
    const total = body.items.reduce((sum, i) => sum + i.refundedCount, 0);
    expect(total).toBe(1);
  });
});

// ─────────────────────────────────────────────────────── L-27 IP 허용목록

describe('L-27 · IP 허용목록', () => {
  it('[16] CIDR 로 적어 둔 대역이 실제로 맞는다', () => {
    expect(isAllowedIp('203.0.113.10', ['203.0.113.0/24'])).toBe(true);
    expect(isAllowedIp('203.0.114.10', ['203.0.113.0/24'])).toBe(false);
  });

  it('[17] 프록시가 붙인 형태(IPv4 사상·포트)도 같은 주소로 본다', () => {
    expect(isAllowedIp('::ffff:203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(isAllowedIp('203.0.113.10:51514', ['203.0.113.0/24'])).toBe(true);
  });
});
