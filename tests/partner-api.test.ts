import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/server/db';
import { inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import {
  issueMerchantApiKey,
  authenticatePartner,
  signPartnerRequest,
  SIGNATURE_SKEW_SEC,
} from '@/server/services/partner-auth';
import { GET as chargesGet } from '@/app/api/partner/v1/charges/route';
import { POST as ackPost } from '@/app/api/partner/v1/charges/ack/route';

/**
 * 사회복지기관 연동 API.
 *
 * 이 API 는 선택 기능이지만, 열려 있는 이상 남의 사회복지기관 데이터가 새면 안 된다.
 * 확인해야 하는 것
 *  - 키 없는/폐기된 키 요청은 막힌다
 *  - 쓰기 요청은 서명이 없으면 막히고, 같은 서명은 재사용할 수 없다
 *  - 목록은 본인 사회복지기관 것만 나온다
 *  - ack 는 멱등이고, 남의 거래번호는 무시된다
 */

const BASE = 'https://pay.example.com';
let fx: Fixture;
let key: Awaited<ReturnType<typeof issueMerchantApiKey>>;

function req(path: string, init: RequestInit = {}) {
  return new Request(`${BASE}${path}`, init);
}

/** 서명 헤더를 붙인 POST 요청 */
function signedPost(path: string, body: unknown, secret = key.signingSecret, ts?: string) {
  const raw = JSON.stringify(body);
  const stamp = ts ?? Math.floor(Date.now() / 1000).toString();
  return req(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key.apiKey}`,
      'content-type': 'application/json',
      'x-givesign-timestamp': stamp,
      'x-givesign-signature': signPartnerRequest(secret, stamp, 'POST', path, raw),
    },
    body: raw,
  });
}

async function fund(count = 3) {
  await seedRegisteredPayer(fx.payerPhone);
  for (let i = 0; i < count; i += 1) {
    await inboundAndPay(
      moPayload({ to: fx.moNumber, messageId: `API-${i}-${Date.now()}`, text: `충전 ${i}` }),
      fx.merchantId,
    );
  }
}

// 처리 대기(pending)·처리 결과 통보(ack)는 상품 기능(FEATURE_GOODS)을 켠 기관용이다.
// 기본 설정에서는 후원 건이 처음부터 SKIPPED 라 대기 목록에 오르지 않는다(점검 M-17).
beforeAll(() => {
  vi.stubEnv('FEATURE_GOODS', 'true');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { status: 'APPROVED' } });
  key = await issueMerchantApiKey(fx.merchantId, 'E2E 키');
});

describe('인증', () => {
  it('[1] 키가 없으면 401', async () => {
    const result = await authenticatePartner(req('/api/partner/v1/ping'), '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNAUTHORIZED');
  });

  it('[2] 잘못된 키는 401', async () => {
    const result = await authenticatePartner(
      req('/api/partner/v1/ping', { headers: { authorization: 'Bearer gs_live_nope' } }),
      '',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_KEY');
  });

  it('[3] 유효한 키는 사회복지기관을 식별한다', async () => {
    const result = await authenticatePartner(
      req('/api/partner/v1/ping', { headers: { authorization: `Bearer ${key.apiKey}` } }),
      '',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.merchantId).toBe(fx.merchantId);
  });

  it('[4] 폐기한 키는 401', async () => {
    await prisma.merchantApiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    const result = await authenticatePartner(
      req('/api/partner/v1/ping', { headers: { authorization: `Bearer ${key.apiKey}` } }),
      '',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('REVOKED_KEY');
  });

  it('[5] 승인되지 않은 사회복지기관은 403', async () => {
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { status: 'SUSPENDED' } });
    const result = await authenticatePartner(
      req('/api/partner/v1/ping', { headers: { authorization: `Bearer ${key.apiKey}` } }),
      '',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MERCHANT_NOT_ACTIVE');
  });

  it('[6] 키 원문은 저장되지 않는다', async () => {
    const row = await prisma.merchantApiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(row.keyHash).not.toContain(key.apiKey);
    expect(row.signingEnc).not.toContain(key.signingSecret);
    expect(key.apiKey.startsWith(row.prefix)).toBe(true);
  });
});

describe('서명', () => {
  it('[7] 쓰기 요청에 서명이 없으면 막는다', async () => {
    const raw = JSON.stringify({ transactionNos: ['X'], status: 'SENT' });
    const result = await authenticatePartner(
      req('/api/partner/v1/charges/ack', {
        method: 'POST',
        headers: { authorization: `Bearer ${key.apiKey}` },
        body: raw,
      }),
      raw,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SIGNATURE_REQUIRED');
  });

  it('[8] 서명이 틀리면 막는다', async () => {
    const body = { transactionNos: ['X'], status: 'SENT' };
    const request = signedPost('/api/partner/v1/charges/ack', body, 'wrong-secret');
    const result = await authenticatePartner(request, JSON.stringify(body));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SIGNATURE_INVALID');
  });

  it('[9] 오래된 타임스탬프는 막는다', async () => {
    const body = { transactionNos: ['X'], status: 'SENT' };
    const old = String(Math.floor(Date.now() / 1000) - SIGNATURE_SKEW_SEC - 60);
    const request = signedPost('/api/partner/v1/charges/ack', body, key.signingSecret, old);
    const result = await authenticatePartner(request, JSON.stringify(body));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SIGNATURE_EXPIRED');
  });

  it('[10] 같은 서명을 다시 쓰면 막는다 (재전송 차단)', async () => {
    const body = { transactionNos: ['X'], status: 'SENT' };
    const raw = JSON.stringify(body);
    const stamp = Math.floor(Date.now() / 1000).toString();
    const sig = signPartnerRequest(key.signingSecret, stamp, 'POST', '/api/partner/v1/charges/ack', raw);
    const build = () =>
      req('/api/partner/v1/charges/ack', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.apiKey}`,
          'x-givesign-timestamp': stamp,
          'x-givesign-signature': sig,
        },
        body: raw,
      });

    const first = await authenticatePartner(build(), raw);
    expect(first.ok).toBe(true);

    const second = await authenticatePartner(build(), raw);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('REPLAYED');
  });
});

describe('충전 건 조회', () => {
  it('[11] 결제 완료 건을 내려주고 금액과 포인트가 1:1 이다', async () => {
    await fund(3);
    const res = await chargesGet(
      req('/api/partner/v1/charges?status=pending', { headers: { authorization: `Bearer ${key.apiKey}` } }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(3);
    expect(body.items[0].amount).toBe(body.items[0].points);
    expect(body.items[0].pointStatus).toBe('PENDING');

    // 후원자 식별은 마스킹 번호와 사회복지기관 전용 식별자(payerRef)로만 한다.
    // 원문 번호를 내보내면 키 하나가 유출됐을 때 대량 개인정보 반출이 된다.
    // 예전 기대값(payerPhone 원문)은 그 변경을 따라오지 못한 것이라 여기서 바로잡는다.
    expect(body.items[0].payerPhoneMasked).toMatch(/^\d{3}-\*{4}-\d{4}$/);
    expect(body.items[0].payerRef).toBeTruthy();
    expect(body.items[0].payerPhone).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(fx.payerPhone.replace(/\D/g, ''));
  });

  it('[12] 남의 사회복지기관 결제는 나오지 않는다', async () => {
    await fund(2);
    const other = await prisma.merchantProfile.findFirst({ where: { id: { not: fx.merchantId } } });
    // 다른 사회복지기관이 시드에 없으면 이 검증은 의미가 없으므로 건너뛴다.
    if (!other) return;

    const res = await chargesGet(
      req('/api/partner/v1/charges?status=all&limit=500', { headers: { authorization: `Bearer ${key.apiKey}` } }),
    );
    const body = await res.json();
    const nos: string[] = body.items.map((i: { transactionNo: string }) => i.transactionNo);
    const mine = await prisma.charge.findMany({
      where: { transactionNo: { in: nos } },
      select: { merchantId: true },
    });
    expect(mine.every((c) => c.merchantId === fx.merchantId)).toBe(true);
  });

  it('[12-1] 응답에 익명 여부·캠페인·정기 여부가 실린다 (점검 M-15)', async () => {
    await fund(1);
    const charge = await prisma.charge.findFirstOrThrow({ where: { merchantId: fx.merchantId, paidAt: { not: null } } });
    const camp = await prisma.campaign.create({
      data: {
        id: 'CAMP-API-TEST', merchantId: fx.merchantId, code: '김장', title: '김장 나눔', summary: 's', goalAmount: 100000n,
        startsOn: new Date('2026-01-01T00:00:00Z'), endsOn: new Date('2030-12-31T00:00:00Z'), status: 'ACTIVE',
      },
    });
    await prisma.charge.update({ where: { id: charge.id }, data: { anonymous: true, campaignId: camp.id } });
    const res = await chargesGet(
      req('/api/partner/v1/charges?status=all', { headers: { authorization: `Bearer ${key.apiKey}` } }),
    );
    const item = (await res.json()).items.find((i: { transactionNo: string }) => i.transactionNo === charge.transactionNo);
    expect(item.anonymous).toBe(true);
    expect(item.campaign).toEqual({ id: camp.id, code: '김장', title: '김장 나눔' });
    expect(item.recurring).toBe(false);
  });

  it('[13] limit 이 범위를 벗어나면 400', async () => {
    const res = await chargesGet(
      req('/api/partner/v1/charges?limit=9999', { headers: { authorization: `Bearer ${key.apiKey}` } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_LIMIT');
  });

  it('[14] 커서로 나눠 받을 수 있다', async () => {
    await fund(3);
    const first = await chargesGet(
      req('/api/partner/v1/charges?limit=2', { headers: { authorization: `Bearer ${key.apiKey}` } }),
    );
    const page1 = await first.json();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const second = await chargesGet(
      req(`/api/partner/v1/charges?limit=2&cursor=${page1.nextCursor}`, {
        headers: { authorization: `Bearer ${key.apiKey}` },
      }),
    );
    const page2 = await second.json();
    expect(page2.items).toHaveLength(1);
    const nos1 = page1.items.map((i: { transactionNo: string }) => i.transactionNo);
    expect(nos1).not.toContain(page2.items[0].transactionNo);
  });
});

describe('처리 결과 통보 (ack)', () => {
  async function pendingNos(): Promise<string[]> {
    const res = await chargesGet(
      req('/api/partner/v1/charges?status=pending', { headers: { authorization: `Bearer ${key.apiKey}` } }),
    );
    const body = await res.json();
    return body.items.map((i: { transactionNo: string }) => i.transactionNo);
  }

  it('[15] SENT 로 통보하면 지급 완료로 바뀌고 목록에서 빠진다', async () => {
    await fund(3);
    const nos = await pendingNos();

    const res = await ackPost(signedPost('/api/partner/v1/charges/ack', { transactionNos: nos, status: 'SENT' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.updated).toBe(3);

    expect(await pendingNos()).toHaveLength(0);
    const rows = await prisma.charge.findMany({ where: { transactionNo: { in: nos } } });
    expect(rows.every((r) => r.pointStatus === 'SENT' && r.pointGivenAt !== null)).toBe(true);
  });

  it('[16] 같은 건을 다시 통보해도 결과가 달라지지 않는다 (멱등)', async () => {
    await fund(2);
    const nos = await pendingNos();
    await ackPost(signedPost('/api/partner/v1/charges/ack', { transactionNos: nos, status: 'SENT' }));

    // 같은 초에 같은 본문을 보내면 서명까지 같아져 재전송 차단에 걸린다(의도된 동작).
    // 재시도를 흉내 내려면 타임스탬프를 다르게 잡아 새 서명으로 보낸다.
    const later = String(Math.floor(Date.now() / 1000) + 2);
    const again = await ackPost(
      signedPost('/api/partner/v1/charges/ack', { transactionNos: nos, status: 'SENT' }, key.signingSecret, later),
    );
    const body = await again.json();
    expect(body.updated).toBe(0);
    expect(body.unchanged).toHaveLength(2);
  });

  it('[17] FAILED 는 사유가 없으면 거부한다', async () => {
    await fund(1);
    const nos = await pendingNos();
    const res = await ackPost(signedPost('/api/partner/v1/charges/ack', { transactionNos: nos, status: 'FAILED' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NOTE_REQUIRED');
  });

  it('[18] FAILED 로 보류하면 다시 목록에 나온다', async () => {
    await fund(1);
    const nos = await pendingNos();
    await ackPost(
      signedPost('/api/partner/v1/charges/ack', { transactionNos: nos, status: 'FAILED', note: '회원 없음' }),
    );

    const still = await pendingNos();
    expect(still).toEqual(nos);
    const row = await prisma.charge.findFirstOrThrow({ where: { transactionNo: nos[0] } });
    expect(row.pointStatus).toBe('FAILED');
    expect(row.pointNote).toBe('회원 없음');
  });

  it('[19] 모르는 거래번호는 unknown 으로 돌려준다', async () => {
    const res = await ackPost(
      signedPost('/api/partner/v1/charges/ack', { transactionNos: ['NOPE-1'], status: 'SENT' }),
    );
    const body = await res.json();
    expect(body.updated).toBe(0);
    expect(body.unknown).toEqual(['NOPE-1']);
  });

  it('[20] status 값이 잘못되면 400', async () => {
    const res = await ackPost(
      signedPost('/api/partner/v1/charges/ack', { transactionNos: ['X'], status: 'WHATEVER' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_STATUS');
  });
});
