import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import { issueMerchantApiKey, signPartnerRequest } from '@/server/services/partner-auth';
import { merchantPayerRef } from '@/lib/crypto';
import { reviewTemplateBody, extractVariables, renderMerchantTemplate } from '@/server/services/merchant-mt';
import { POST as mtSend, GET as mtList } from '@/app/api/partner/v1/mt/messages/route';
import { GET as mtOne } from '@/app/api/partner/v1/mt/messages/[id]/route';
import { POST as tplSave, GET as tplList } from '@/app/api/partner/v1/mt/templates/route';
import { GET as quotaGet } from '@/app/api/partner/v1/mt/quota/route';

/**
 * 사회복지기관 MT 발송 v1.
 *
 * 확인해야 하는 것은 "무엇을 막는가" 다.
 *  - 광고성 문구는 자동 승인되지 않는다
 *  - 승인되지 않은 템플릿으로는 보낼 수 없다
 *  - 거래 이력이 없는 사람에게는 보낼 수 없다 (임의 번호 지정 불가)
 *  - 같은 멱등키로 두 번 보내도 문자는 한 번만 나간다
 */

const BASE = 'https://pay.example.com';
let fx: Fixture;
let key: Awaited<ReturnType<typeof issueMerchantApiKey>>;
let seq = 0;

function get(path: string, apiKey = key.apiKey) {
  return new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
}

function signedPost(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  const stamp = Math.floor(Date.now() / 1000).toString();
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key.apiKey}`,
      'content-type': 'application/json',
      'x-givesign-timestamp': stamp,
      'x-givesign-signature': signPartnerRequest(key.signingSecret, stamp, 'POST', path, raw),
      ...extraHeaders,
    },
    body: raw,
  });
}

async function saveTemplate(code: string, body: string) {
  seq += 1;
  const res = await tplSave(signedPost('/api/partner/v1/mt/templates', { code, name: `${code} ${seq}`, body }));
  return { status: res.status, body: await res.json() };
}

/** 실제 결제를 한 건 만들어 거래 이력이 있는 후원자를 준비한다. */
async function fundedPayer() {
  await seedRegisteredPayer(fx.payerPhone);
  await inboundAndPay(moPayload({ to: fx.moNumber, messageId: `MT-${Date.now()}`, text: '충전' }), fx.merchantId);
  const charge = await prisma.charge.findFirst({
    where: { merchantId: fx.merchantId },
    orderBy: { createdAt: 'desc' },
    select: { transactionNo: true, payer: { select: { phoneHash: true } } },
  });
  return {
    transactionNo: charge!.transactionNo,
    payerRef: merchantPayerRef(fx.merchantId, charge!.payer!.phoneHash),
  };
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { status: 'APPROVED' } });
  key = await issueMerchantApiKey(fx.merchantId, '발송 키', 'LIVE');
  seq = 0;
});

describe('템플릿 검수', () => {
  it('[1] 거래 안내 문구는 자동 승인된다', async () => {
    const r = await saveTemplate('ORDER_DELAY', '{사회복지기관} 주문하신 {상품} 출고가 {일수}일 늦어집니다.');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('APPROVED');
    expect(r.body.usable).toBe(true);
    // {사회복지기관} 은 시스템이 채우므로 넘겨야 하는 값에서 빠진다.
    expect(r.body.variables.sort()).toEqual(['상품', '일수']);
  });

  it('[2] 광고 문구는 자동 승인되지 않고 검수 대기로 남는다', async () => {
    const r = await saveTemplate('SALE', '{사회복지기관} 이번 주말 30% 할인 이벤트를 진행합니다.');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('PENDING');
    expect(r.body.usable).toBe(false);
    expect(r.body.reviewNote).toBeTruthy();
  });

  it('[3] 링크가 들어가면 저장 자체를 막는다', async () => {
    const r = await saveTemplate('LINK', '{사회복지기관} 자세한 내용은 https://example.com 에서 확인하세요.');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('TEMPLATE_REJECTED');
  });

  it('[4] 전화번호 같은 개인정보가 들어가면 막는다', async () => {
    const r = await saveTemplate('PHONE', '{사회복지기관} 문의는 010-1234-5678 로 연락 주세요.');
    expect(r.status).toBe(400);
  });

  it('[5] 중괄호 짝이 맞지 않으면 막는다', async () => {
    const r = await saveTemplate('BROKEN', '{사회복지기관} 주문하신 {상품 이(가) 발송되었습니다.');
    expect(r.status).toBe(400);
  });

  it('[6] 치환자 추출과 렌더링이 맞물린다', () => {
    const body = '{사회복지기관} 주문하신 {상품} 이(가) {일수}일 뒤 도착합니다.';
    expect(extractVariables(body).sort()).toEqual(['상품', '일수']);
    expect(renderMerchantTemplate(body, { 상품: '머그컵', 일수: '3' }, '바람소리')).toBe(
      '바람소리 주문하신 머그컵 이(가) 3일 뒤 도착합니다.',
    );
  });

  it('[7] 치환값에 $& 가 있어도 본문이 깨지지 않는다', () => {
    expect(renderMerchantTemplate('{사회복지기관} {메모}', { 메모: '$& 특수문자' }, '바람소리')).toBe('바람소리 $& 특수문자');
  });

  it('[8] 200자를 넘으면 막는다', async () => {
    const r = await reviewTemplateBody(fx.merchantId, 'ㄱ'.repeat(201));
    expect(r.ok).toBe(false);
  });
});

describe('발송', () => {
  it('[9] 승인된 템플릿으로 거래 이력이 있는 후원자에게 보낸다', async () => {
    await saveTemplate('OK1', '{사회복지기관} 주문하신 {상품} 이(가) 발송되었습니다.');
    const target = await fundedPayer();

    const res = await mtSend(
      signedPost(
        '/api/partner/v1/mt/messages',
        { templateCode: 'OK1', payerRef: target.payerRef, variables: { 상품: '머그컵' } },
        { 'idempotency-key': 'send-1' },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('SENT');
    expect(body.reused).toBe(false);
    expect(body.body).toContain('[기브싸인]');
    expect(body.body).toContain('머그컵');

    const row = await prisma.mtOutboundMessage.findFirst({ where: { id: body.id } });
    expect(row?.merchantSent).toBe(true);
    expect(row?.templateCode).toBe('MERCHANT:OK1');
  });

  it('[10] 거래번호로도 수신자를 지정할 수 있다', async () => {
    await saveTemplate('OK2', '{사회복지기관} 배송이 시작되었습니다.');
    const target = await fundedPayer();

    const res = await mtSend(
      signedPost(
        '/api/partner/v1/mt/messages',
        { templateCode: 'OK2', transactionNo: target.transactionNo },
        { 'idempotency-key': 'send-2' },
      ),
    );
    expect(res.status).toBe(200);
  });

  it('[11] 같은 멱등키로 두 번 보내도 문자는 한 번만 나간다', async () => {
    await saveTemplate('OK3', '{사회복지기관} 안내드립니다.');
    const target = await fundedPayer();
    const payload = { templateCode: 'OK3', payerRef: target.payerRef };

    const first = await (await mtSend(signedPost('/api/partner/v1/mt/messages', payload, { 'idempotency-key': 'dup' }))).json();
    const second = await (await mtSend(signedPost('/api/partner/v1/mt/messages', { ...payload, variables: {} }, { 'idempotency-key': 'dup' }))).json();

    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await prisma.mtOutboundMessage.count({ where: { merchantSent: true } })).toBe(1);
  });

  it('[12] 멱등키가 없으면 거절한다', async () => {
    await saveTemplate('OK4', '{사회복지기관} 안내드립니다.');
    const target = await fundedPayer();
    const res = await mtSend(
      signedPost('/api/partner/v1/mt/messages', { templateCode: 'OK4', payerRef: target.payerRef }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('[13] 승인되지 않은 템플릿으로는 보낼 수 없다', async () => {
    await saveTemplate('AD', '{사회복지기관} 할인 이벤트 안내입니다.');
    const target = await fundedPayer();
    const res = await mtSend(
      signedPost(
        '/api/partner/v1/mt/messages',
        { templateCode: 'AD', payerRef: target.payerRef },
        { 'idempotency-key': 'ad-1' },
      ),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('TEMPLATE_NOT_APPROVED');
  });

  it('[14] 거래 이력이 없는 사람에게는 보낼 수 없다', async () => {
    await saveTemplate('OK5', '{사회복지기관} 안내드립니다.');
    const res = await mtSend(
      signedPost(
        '/api/partner/v1/mt/messages',
        { templateCode: 'OK5', payerRef: 'not-a-real-ref' },
        { 'idempotency-key': 'nobody' },
      ),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('RECIPIENT_NOT_FOUND');
  });

  it('[15] 수신자를 지정하지 않으면 거절한다 (임의 번호 발송 차단)', async () => {
    await saveTemplate('OK6', '{사회복지기관} 안내드립니다.');
    const res = await mtSend(
      signedPost('/api/partner/v1/mt/messages', { templateCode: 'OK6' }, { 'idempotency-key': 'nodest' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('RECIPIENT_REQUIRED');
  });

  it('[16] 치환값이 빠지면 발송하지 않는다', async () => {
    await saveTemplate('NEEDVAR', '{사회복지기관} 주문하신 {상품} 안내입니다.');
    const target = await fundedPayer();
    const res = await mtSend(
      signedPost(
        '/api/partner/v1/mt/messages',
        { templateCode: 'NEEDVAR', payerRef: target.payerRef },
        { 'idempotency-key': 'missing-var' },
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('MISSING_VARIABLES');
    expect(await prisma.mtOutboundMessage.count({ where: { merchantSent: true } })).toBe(0);
  });

  it('[17] 차단된 후원자에게는 보내지 않는다', async () => {
    await saveTemplate('OK7', '{사회복지기관} 안내드립니다.');
    const target = await fundedPayer();
    const link = await prisma.payerMerchantLink.findFirst({ where: { merchantId: fx.merchantId } });
    await prisma.payerMerchantLink.update({ where: { id: link!.id }, data: { payerBlockedAt: new Date() } });

    const res = await mtSend(
      signedPost(
        '/api/partner/v1/mt/messages',
        { templateCode: 'OK7', payerRef: target.payerRef },
        { 'idempotency-key': 'blocked' },
      ),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RECIPIENT_BLOCKED');
  });
});

describe('조회', () => {
  it('[18] 발송 이력과 단건 조회가 동작한다', async () => {
    await saveTemplate('OK8', '{사회복지기관} 안내드립니다.');
    const target = await fundedPayer();
    const sent = await (
      await mtSend(
        signedPost(
          '/api/partner/v1/mt/messages',
          { templateCode: 'OK8', payerRef: target.payerRef },
          { 'idempotency-key': 'list-1' },
        ),
      )
    ).json();

    const list = await (await mtList(get('/api/partner/v1/mt/messages'))).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].templateCode).toBe('OK8');

    const one = await (await mtOne(get(`/api/partner/v1/mt/messages/${sent.id}`), { params: Promise.resolve({ id: sent.id }) })).json();
    expect(one.id).toBe(sent.id);
    expect(one.sandbox).toBe(false);
  });

  it('[19] 시스템이 보낸 문자는 사회복지기관 발송 이력에 섞이지 않는다', async () => {
    await fundedPayer(); // 결제 흐름에서 시스템 MT 가 여러 건 나간다
    expect(await prisma.mtOutboundMessage.count()).toBeGreaterThan(0);

    const list = await (await mtList(get('/api/partner/v1/mt/messages'))).json();
    expect(list.items).toHaveLength(0);
  });

  it('[20] 템플릿 목록과 남은 한도를 조회할 수 있다', async () => {
    await saveTemplate('OK9', '{사회복지기관} 안내드립니다.');
    const templates = await (await tplList(get('/api/partner/v1/mt/templates'))).json();
    expect(templates.items).toHaveLength(1);

    const quota = await (await quotaGet(get('/api/partner/v1/mt/quota'))).json();
    expect(quota.limit).toBeGreaterThan(0);
    expect(quota.remaining).toBe(quota.limit - quota.used);
  });
});

describe('테스트 키', () => {
  it('[21] 테스트 키로 보내면 실제 발송 이력이 생기지 않는다', async () => {
    await saveTemplate('OKT', '{사회복지기관} 안내드립니다.');
    const testKey = await issueMerchantApiKey(fx.merchantId, '테스트', 'TEST');

    // 샌드박스 거래를 하나 만든다.
    const moPath = '/api/partner/v1/sandbox/mo';
    const moRaw = JSON.stringify({ from: '01055556666', text: '테스트' });
    const stamp = Math.floor(Date.now() / 1000).toString();
    const { POST: sandboxMo } = await import('@/app/api/partner/v1/sandbox/mo/route');
    const created = await sandboxMo(
      new Request(`${BASE}${moPath}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${testKey.apiKey}`,
          'content-type': 'application/json',
          'x-givesign-timestamp': stamp,
          'x-givesign-signature': signPartnerRequest(testKey.signingSecret, stamp, 'POST', moPath, moRaw),
        },
        body: moRaw,
      }),
    );
    const no = (await created.json()).charge.transactionNo as string;

    const path = '/api/partner/v1/mt/messages';
    const raw = JSON.stringify({ templateCode: 'OKT', transactionNo: no });
    const ts2 = Math.floor(Date.now() / 1000).toString();
    const res = await mtSend(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${testKey.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': 'sandbox-send',
          'x-givesign-timestamp': ts2,
          'x-givesign-signature': signPartnerRequest(testKey.signingSecret, ts2, 'POST', path, raw),
        },
        body: raw,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sandbox).toBe(true);
    expect(body.body).toContain('샌드박스');

    expect(await prisma.mtOutboundMessage.count({ where: { merchantSent: true } })).toBe(0);
  });
});
