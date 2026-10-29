import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import { issueMerchantApiKey, signPartnerRequest } from '@/server/services/partner-auth';
import { GET as chargesGet } from '@/app/api/partner/v1/charges/route';
import { POST as ackPost } from '@/app/api/partner/v1/charges/ack/route';
import { GET as pingGet } from '@/app/api/partner/v1/ping/route';
import { POST as sandboxMoPost } from '@/app/api/partner/v1/sandbox/mo/route';
import { POST as sandboxSucceedPost } from '@/app/api/partner/v1/sandbox/charges/[transactionNo]/succeed/route';
import { POST as sandboxFailPost } from '@/app/api/partner/v1/sandbox/charges/[transactionNo]/fail/route';
import { GET as outboxGet } from '@/app/api/partner/v1/sandbox/outbox/route';
import { POST as resetPost } from '@/app/api/partner/v1/sandbox/reset/route';

/**
 * 샌드박스(테스트 키).
 *
 * 지켜야 하는 것은 하나다 — **테스트 호출은 실제 세계에 아무 영향이 없다.**
 * 그래서 확인할 것도 명확하다.
 *  - 테스트 키로 만든 데이터가 운영 charge 테이블에 한 줄도 들어가지 않는다
 *  - 테스트 키 조회에 운영 결제 건이 섞이지 않는다 (그 반대도)
 *  - 운영 키로는 샌드박스를 부를 수 없다
 *  - 초기화가 운영 데이터를 지우지 않는다
 */

const BASE = 'https://pay.example.com';
let fx: Fixture;
let liveKey: Awaited<ReturnType<typeof issueMerchantApiKey>>;
let testKey: Awaited<ReturnType<typeof issueMerchantApiKey>>;

function get(path: string, apiKey: string) {
  return new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
}

function signedPost(path: string, body: unknown, k: { apiKey: string; signingSecret: string }) {
  const raw = JSON.stringify(body);
  const stamp = Math.floor(Date.now() / 1000).toString();
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${k.apiKey}`,
      'content-type': 'application/json',
      'x-givesign-timestamp': stamp,
      'x-givesign-signature': signPartnerRequest(k.signingSecret, stamp, 'POST', path, raw),
    },
    body: raw,
  });
}

/**
 * 샌드박스 결제 1건을 성공까지 만든다.
 *
 * 본문을 매번 다르게 둔다. 같은 초에 같은 본문으로 두 번 보내면 서명이 같아져
 * 재전송 방어(REPLAYED)에 걸린다 — 실제 API 동작이 맞지만 여기서는 방해가 된다.
 */
let sandboxSeq = 0;
async function makeSandboxCharge(amount = 10000, text = '테스트 충전') {
  sandboxSeq += 1;
  const created = await sandboxMoPost(
    signedPost('/api/partner/v1/sandbox/mo', { from: '01011112222', text: `${text} #${sandboxSeq}`, amount }, testKey),
  );
  const body = await created.json();
  const no = body.charge.transactionNo as string;
  const path = `/api/partner/v1/sandbox/charges/${no}/succeed`;
  await sandboxSucceedPost(signedPost(path, {}, testKey), { params: Promise.resolve({ transactionNo: no }) });
  return no;
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { status: 'APPROVED' } });
  liveKey = await issueMerchantApiKey(fx.merchantId, '운영 키', 'LIVE');
  testKey = await issueMerchantApiKey(fx.merchantId, '테스트 키', 'TEST');
});

describe('키 모드', () => {
  it('[1] 접두사가 모드별로 갈린다', () => {
    expect(liveKey.apiKey.startsWith('gs_live_')).toBe(true);
    expect(testKey.apiKey.startsWith('gs_test_')).toBe(true);
  });

  it('[2] ping 이 지금 붙은 키의 모드를 알려준다', async () => {
    const live = await (await pingGet(get('/api/partner/v1/ping', liveKey.apiKey))).json();
    expect(live.mode).toBe('LIVE');
    expect(live.sandbox).toBe(false);

    const test = await (await pingGet(get('/api/partner/v1/ping', testKey.apiKey))).json();
    expect(test.mode).toBe('TEST');
    expect(test.sandbox).toBe(true);
  });

  it('[3] 운영 키로는 샌드박스를 호출할 수 없다', async () => {
    const res = await sandboxMoPost(
      signedPost('/api/partner/v1/sandbox/mo', { from: '01011112222', text: '테스트' }, liveKey),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('TEST_KEY_REQUIRED');
  });
});

describe('샌드박스 결제 흐름', () => {
  it('[4] MO 를 주입하면 아직 결제 전 상태로 만들어진다', async () => {
    const res = await sandboxMoPost(
      signedPost('/api/partner/v1/sandbox/mo', { from: '01011112222', text: '응원합니다', amount: 30000 }, testKey),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.charge.chargeStatus).toBe('PENDING_PAYMENT');
    expect(body.charge.amount).toBe(30000);
    expect(body.charge.test).toBe(true);
    // 아직 결제 전이므로 조회 목록에는 나오지 않는다.
    const list = await (await chargesGet(get('/api/partner/v1/charges', testKey.apiKey))).json();
    expect(list.items).toHaveLength(0);
  });

  it('[5] 성공으로 확정하면 조회 목록에 나온다', async () => {
    const no = await makeSandboxCharge(12000);
    const list = await (await chargesGet(get('/api/partner/v1/charges?status=pending', testKey.apiKey))).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].transactionNo).toBe(no);
    expect(list.items[0].points).toBe(12000);
    expect(list.items[0].payerPhoneMasked).toMatch(/^\d{3}-\*{4}-\d{4}$/);
    expect(list.items[0].payerRef).toBeTruthy();
  });

  it('[6] 실패로 확정한 건은 조회 목록에 나오지 않는다', async () => {
    const created = await sandboxMoPost(
      signedPost('/api/partner/v1/sandbox/mo', { from: '01011112222', text: '실패 시험' }, testKey),
    );
    const no = (await created.json()).charge.transactionNo as string;
    const path = `/api/partner/v1/sandbox/charges/${no}/fail`;
    const failed = await sandboxFailPost(signedPost(path, { reason: '한도 초과' }, testKey), {
      params: Promise.resolve({ transactionNo: no }),
    });
    expect((await failed.json()).charge.chargeStatus).toBe('PAYMENT_FAILED');

    const list = await (await chargesGet(get('/api/partner/v1/charges', testKey.apiKey))).json();
    expect(list.items).toHaveLength(0);
  });

  it('[7] ack 로 지급 처리하면 pending 조회에서 빠진다', async () => {
    const no = await makeSandboxCharge();
    const res = await ackPost(
      signedPost('/api/partner/v1/charges/ack', { transactionNos: [no], status: 'SENT' }, testKey),
    );
    expect((await res.json()).updated).toBe(1);

    const pending = await (await chargesGet(get('/api/partner/v1/charges?status=pending', testKey.apiKey))).json();
    expect(pending.items).toHaveLength(0);

    const all = await (await chargesGet(get('/api/partner/v1/charges?status=all', testKey.apiKey))).json();
    expect(all.items).toHaveLength(1);
    expect(all.items[0].pointStatus).toBe('SENT');
  });

  it('[8] 이미 확정된 건은 다시 바뀌지 않는다(멱등)', async () => {
    const no = await makeSandboxCharge();
    const path = `/api/partner/v1/sandbox/charges/${no}/fail`;
    // 성공으로 확정된 건에 실패를 보내도 상태가 뒤집히지 않는다.
    const res = await sandboxFailPost(signedPost(path, { reason: '뒤집기 시도' }, testKey), {
      params: Promise.resolve({ transactionNo: no }),
    });
    expect((await res.json()).charge.chargeStatus).toBe('PAYMENT_SUCCESS');
  });

  it('[9] 문자함에 나갔을 문자가 남는다 (실제 발송은 없다)', async () => {
    await makeSandboxCharge();
    const outbox = await (await outboxGet(get('/api/partner/v1/sandbox/outbox', testKey.apiKey))).json();
    const codes = outbox.items.map((m: { templateCode: string | null }) => m.templateCode);
    expect(codes).toContain('SELECT_AMOUNT');
    expect(codes).toContain('CHARGE_SUCCESS');
    // 실제 발송 이력은 한 건도 없어야 한다.
    expect(await prisma.mtOutboundMessage.count()).toBe(0);
  });
});

describe('운영 데이터 격리', () => {
  it('[10] 테스트 키로 만든 건은 운영 charge 테이블에 들어가지 않는다', async () => {
    const before = await prisma.charge.count();
    await makeSandboxCharge();
    await makeSandboxCharge();
    expect(await prisma.charge.count()).toBe(before);
    expect(await prisma.sandboxCharge.count()).toBe(2);
  });

  it('[11] 테스트 키 조회에 운영 결제 건이 섞이지 않는다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, messageId: `LIVE-${Date.now()}`, text: '실제 충전' }), fx.merchantId);
    const no = await makeSandboxCharge();

    const testList = await (await chargesGet(get('/api/partner/v1/charges?status=all', testKey.apiKey))).json();
    expect(testList.items).toHaveLength(1);
    expect(testList.items[0].transactionNo).toBe(no);

    const liveList = await (await chargesGet(get('/api/partner/v1/charges?status=all', liveKey.apiKey))).json();
    expect(liveList.items.length).toBeGreaterThan(0);
    for (const item of liveList.items) {
      expect(item.transactionNo.startsWith('TEST')).toBe(false);
    }
  });

  it('[12] 테스트 키 ack 는 운영 결제 건을 건드리지 않는다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, messageId: `LIVE2-${Date.now()}`, text: '실제 충전' }), fx.merchantId);
    const real = await prisma.charge.findFirst({ where: { merchantId: fx.merchantId }, select: { transactionNo: true, pointStatus: true } });
    expect(real).not.toBeNull();

    const res = await ackPost(
      signedPost('/api/partner/v1/charges/ack', { transactionNos: [real!.transactionNo], status: 'SENT' }, testKey),
    );
    const body = await res.json();
    expect(body.updated).toBe(0);
    expect(body.unknown).toContain(real!.transactionNo);

    const after = await prisma.charge.findFirst({ where: { transactionNo: real!.transactionNo }, select: { pointStatus: true } });
    expect(after?.pointStatus).toBe(real!.pointStatus);
  });

  it('[13] 초기화는 테스트 데이터만 지운다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, messageId: `LIVE3-${Date.now()}`, text: '실제 충전' }), fx.merchantId);
    const realBefore = await prisma.charge.count();
    await makeSandboxCharge();

    const res = await resetPost(signedPost('/api/partner/v1/sandbox/reset', {}, testKey));
    expect(res.status).toBe(200);

    expect(await prisma.sandboxCharge.count()).toBe(0);
    expect(await prisma.sandboxMessage.count()).toBe(0);
    expect(await prisma.charge.count()).toBe(realBefore);
  });
});

describe('입력 검증', () => {
  it('[14] 휴대폰 번호 형식이 아니면 거절한다', async () => {
    const res = await sandboxMoPost(
      signedPost('/api/partner/v1/sandbox/mo', { from: '02-123-4567', text: '테스트' }, testKey),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_PHONE');
  });

  it('[15] 금액이 정수가 아니면 거절한다', async () => {
    const res = await sandboxMoPost(
      signedPost('/api/partner/v1/sandbox/mo', { from: '01011112222', text: '테스트', amount: -5 }, testKey),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_AMOUNT');
  });

  it('[16] 없는 거래번호를 확정하려 하면 404', async () => {
    const path = '/api/partner/v1/sandbox/charges/TESTNOPE/succeed';
    const res = await sandboxSucceedPost(signedPost(path, {}, testKey), {
      params: Promise.resolve({ transactionNo: 'TESTNOPE' }),
    });
    expect(res.status).toBe(404);
  });
});
