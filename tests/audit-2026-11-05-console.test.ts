import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 감사로그·세션은 요청 헤더·쿠키를 읽는다. 테스트에서는 빈 요청으로 대체한다.
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
// 서버 전용 표시 모듈. 테스트(노드)에서는 빈 모듈로 둔다.
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: () => undefined, notFound: () => undefined }));
const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/server/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/auth')>();
  return {
    ...real,
    getSessionUser: async () => session.user,
    requireMerchant: async () => {
      if (!session.user?.merchantId) throw new Error('사회복지기관 권한이 필요합니다.');
      return session.user;
    },
    requireAdmin: async () => {
      if (!session.user?.adminPermission) throw new Error('관리자 권한이 필요합니다.');
      return session.user;
    },
  };
});

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { issueMerchantApiKey, signPartnerRequest } from '@/server/services/partner-auth';
import { POST as productCreate } from '@/app/api/partner/v1/products/route';
import { PATCH as productPatch, DELETE as productArchive } from '@/app/api/partner/v1/products/[id]/route';
import { POST as productBulk } from '@/app/api/partner/v1/products/bulk/route';
import { POST as shipmentPost } from '@/app/api/partner/v1/charges/shipment/route';
import { GET as ordersExport } from '@/app/api/studio/orders/export/route';
import {
  createApiKeyAction, revokeApiKeyAction, updateApiKeyIpsAction,
  createWebhookAction, deleteWebhookAction, restoreWebhookAction,
  duplicateChargeProductAction, restoreChargeProductAction, toggleChargeProductActiveAction,
  createChargeProductAction, createBannedWordAction, deleteBannedWordAction, deleteMtTemplateAction,
  bulkShipAction,
} from '@/app/actions/studio';
import { saveLimitPolicy, toggleLimitPolicy } from '@/app/actions/admin/policy';
import { applyGlobalAmountBounds } from '@/app/actions/admin/accounts';
import { assignMoNumber } from '@/app/actions/admin/transactions';
import { createHolidayAction, deleteHolidayAction } from '@/app/actions/admin/holidays';
import { resolveSeedTier, seedAccountPassword, LOCAL_SEED_PASSWORD } from '../prisma/seed-env';
import { seedBaseData } from '../prisma/seed-base';
import { checkBaseData } from '@/server/services/base-data-check';
import { campaignSchema } from '@/lib/fundraising';
import { monthlyTrend, saveCampaign, setCampaignStatus } from '@/server/services/fundraising';
import { resolveQrTarget } from '@/server/services/qr';
import { GET as qrGet } from '@/app/api/qr/[code]/route';
import { getOrgVisuals } from '@/server/services/visual-settings';
import { emitMerchantEvent } from '@/server/services/webhooks';
import { loadBannedWords } from '@/server/services/charge-flow';
import { sendMerchantMt, upsertMerchantTemplate } from '@/server/services/merchant-mt';
import { PRODUCT_LIMIT_PER_KIND } from '@/server/services/product-rules';
import type { PrismaClient } from '@/generated/prisma/client';

/**
 * 2026-11-05 점검 E(관리자 콘솔·기관 콘솔·파트너 API·시드) 조치 회귀 테스트.
 */

const BASE = 'https://pay.example.com';
let fx: Fixture;
let key: Awaited<ReturnType<typeof issueMerchantApiKey>>;

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

async function create(body: Record<string, unknown>) {
  const res = await productCreate(signed('POST', '/api/partner/v1/products', body));
  return { status: res.status, body: await res.json() };
}

function fd(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

const prev = { ok: false } as never;

async function physical(name = '실물 상품', archived = false) {
  return prisma.chargeProduct.create({
    data: {
      id: newId(), merchantId: fx.merchantId, kind: 'PHYSICAL', name, amount: 10000n, active: false,
      archivedAt: archived ? new Date() : null,
    },
  });
}

/** 두 번째 기관(seedBasics 는 전역 정책·약관까지 만들어 한 번만 부를 수 있다). */
async function secondMerchant() {
  const user = await prisma.user.create({ data: { id: newId(), email: `m2-${newId()}@test.kr`, role: 'MERCHANT', name: '둘째 기관' } });
  const m = await prisma.merchantProfile.create({
    data: { id: newId(), userId: user.id, code: `GIV-${newId().slice(-4)}`, displayName: '둘째 기관', status: 'APPROVED' },
  });
  await prisma.chargeProduct.create({ data: { id: newId(), merchantId: m.id, name: '만 원', amount: 10000n } });
  return { merchantId: m.id };
}

async function adminSession() {
  const user = await prisma.user.create({ data: { id: newId(), email: `a-${newId()}@test.kr`, role: 'ADMIN', name: '관리자' } });
  session.user = { id: user.id, email: user.email, name: user.name, role: 'ADMIN', avatarIndex: 0, adminPermission: 'SUPER_ADMIN' };
  return user;
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  key = await issueMerchantApiKey(fx.merchantId, '점검 E 키', 'LIVE');
  session.user = {
    id: fx.merchantUserId, email: null, name: '담당자', role: 'MERCHANT', avatarIndex: 0,
    merchantId: fx.merchantId, merchantStatus: 'APPROVED',
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('H-10 파트너 API 상품 — 콘솔과 같은 규칙', () => {
  it('FEATURE_GOODS 가 꺼져 있으면 PHYSICAL 을 거절한다', async () => {
    const r = await create({ name: '머그컵', amount: 15000, kind: 'PHYSICAL' });
    expect(r.status).toBe(400);
    expect(r.body.error?.message ?? JSON.stringify(r.body)).toContain('실물');
  });

  it('0원·기관 범위 밖 금액을 거절한다', async () => {
    expect((await create({ name: '영원', amount: 0 })).status).toBe(400);
    // 기관 기본 범위 1,000 ~ 50,000
    expect((await create({ name: '너무 큼', amount: 60000 })).status).toBe(400);
    expect((await create({ name: '너무 작음', amount: 500 })).status).toBe(400);
    expect((await create({ name: '적정', amount: 5000 })).status).toBe(200);
  });

  it('사용 중 항목끼리 같은 이름을 거절한다', async () => {
    expect((await create({ name: '같은 이름', amount: 5000 })).status).toBe(200);
    expect((await create({ name: '같은 이름', amount: 6000 })).status).toBe(400);
  });

  it('PATCH 는 종류 변경·보관 상품 수정을 거절하고, 금액 범위를 검사한다', async () => {
    const made = await create({ name: '항목', amount: 5000, sku: 'A-1' });
    const id = made.body.product.id as string;
    const patch = (body: Record<string, unknown>) =>
      productPatch(signed('PATCH', `/api/partner/v1/products/${id}`, body), { params: Promise.resolve({ id }) });

    vi.stubEnv('FEATURE_GOODS', 'true');
    expect((await patch({ kind: 'PHYSICAL' })).status).toBe(400);
    vi.unstubAllEnvs();
    expect((await patch({ amount: 0 })).status).toBe(400);
    expect((await patch({ amount: 999999 })).status).toBe(400);
    expect((await patch({ amount: 7000 })).status).toBe(200);

    await productArchive(signed('DELETE', `/api/partner/v1/products/${id}`, {}), { params: Promise.resolve({ id }) });
    const res = await patch({ amount: 8000 });
    expect(res.status).toBe(409);
    expect(Number((await prisma.chargeProduct.findUniqueOrThrow({ where: { id } })).amount)).toBe(7000);
  });

  it('종류별 상한(콘솔과 같은 값)을 넘기면 거절하고, 일괄 동기화는 전부 되돌린다', async () => {
    const already = await prisma.chargeProduct.count({ where: { merchantId: fx.merchantId, kind: 'DIGITAL', archivedAt: null } });
    for (let i = already; i < PRODUCT_LIMIT_PER_KIND; i += 1) {
      expect((await create({ name: `항목 ${i}`, amount: 1000 + i })).status).toBe(200);
    }
    expect((await create({ name: '하나 더', amount: 2000 })).status).toBe(400);

    const before = await prisma.chargeProduct.count({ where: { merchantId: fx.merchantId } });
    const res = await productBulk(
      signed('POST', '/api/partner/v1/products/bulk', { items: [{ sku: 'B-1', name: '일괄 1', amount: 3000 }] }),
    );
    expect(res.status).toBe(400);
    expect(await prisma.chargeProduct.count({ where: { merchantId: fx.merchantId } })).toBe(before);
  });

  it('배송 등록 API 는 FEATURE_GOODS 가 꺼져 있으면 404', async () => {
    const res = await shipmentPost(signed('POST', '/api/partner/v1/charges/shipment', { transactionNo: 'X', status: 'SHIPPED' }));
    expect(res.status).toBe(404);
  });
});

describe('콘솔 상품 액션 — FEATURE_GOODS 가드', () => {
  it('꺼져 있으면 실물 상품 복제·복원·노출을 거절한다', async () => {
    const live = await physical('실물 A');
    const archived = await physical('실물 B', true);
    expect((await duplicateChargeProductAction(prev, fd({ productId: live.id }))).ok).toBe(false);
    expect((await restoreChargeProductAction(prev, fd({ productId: archived.id }))).ok).toBe(false);
    expect((await toggleChargeProductActiveAction(prev, fd({ productId: live.id }))).ok).toBe(false);
    expect(await prisma.chargeProduct.count({ where: { merchantId: fx.merchantId, kind: 'PHYSICAL' } })).toBe(2);
    expect((await prisma.chargeProduct.findUniqueOrThrow({ where: { id: archived.id } })).archivedAt).not.toBeNull();
  });

  it('켜져 있으면 실물 상품 복제가 된다', async () => {
    vi.stubEnv('FEATURE_GOODS', 'true');
    const live = await physical('실물 C');
    expect((await duplicateChargeProductAction(prev, fd({ productId: live.id }))).ok).toBe(true);
  });

  it('콘솔 생성도 공용 금액 범위 함수를 쓴다', async () => {
    const r = await createChargeProductAction(prev, fd({ kind: 'DIGITAL', name: '범위 밖', amount: '70000' }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('사이여야');
  });

  it('주문 CSV·일괄 발송은 FEATURE_GOODS 가 꺼져 있으면 열리지 않는다', async () => {
    const res = await ordersExport(new Request(`${BASE}/api/studio/orders/export`));
    expect(res.status).toBe(404);
    expect((await bulkShipAction(prev, fd({ carrier: 'CJ', rows: 'TRD-1,123' }))).ok).toBe(false);
  });
});

describe('H-10 시드 분리', () => {
  it('실행 환경 판정과 샘플 계정 비밀번호 규칙', () => {
    expect(resolveSeedTier({ APP_ENV: 'prod' })).toBe('prod');
    expect(resolveSeedTier({ NODE_ENV: 'production', APP_ENV: 'local' })).toBe('prod');
    expect(resolveSeedTier({ APP_ENV: 'stage' })).toBe('staging');
    expect(resolveSeedTier({})).toBe('local');

    expect(seedAccountPassword('local', {})).toEqual({ ok: true, password: LOCAL_SEED_PASSWORD });
    expect(seedAccountPassword('staging', {}).ok).toBe(false);
    expect(seedAccountPassword('staging', { SEED_ADMIN_PASSWORD: LOCAL_SEED_PASSWORD }).ok).toBe(false);
    expect(seedAccountPassword('staging', { SEED_ADMIN_PASSWORD: 'long-enough-secret!' })).toEqual({ ok: true, password: 'long-enough-secret!' });
    expect(seedAccountPassword('prod', { SEED_ADMIN_PASSWORD: 'long-enough-secret!' }).ok).toBe(false);
  });

  it('기준 데이터 시드는 비어 있으면 채우고, 운영 모드에서는 있는 값을 건드리지 않는다', async () => {
    await resetDb();
    expect((await checkBaseData()).length).toBeGreaterThan(0);

    const db = prisma as unknown as PrismaClient;
    const first = await seedBaseData(db, { overwrite: false });
    expect(first.created).toContain('policy:fee:GLOBAL');
    expect(await checkBaseData()).toEqual([]);

    // 관리자가 바꾼 값은 운영 재실행에서 유지된다.
    await prisma.systemSetting.update({ where: { key: 'charge.defaultAmount' }, data: { value: 5000 } });
    const terms = await prisma.termsVersion.findFirstOrThrow();
    await prisma.termsVersion.update({ where: { id: terms.id }, data: { title: '관리자가 바꾼 제목' } });
    const again = await seedBaseData(db, { overwrite: false });
    expect(again.created).toEqual([]);
    expect((await prisma.systemSetting.findUniqueOrThrow({ where: { key: 'charge.defaultAmount' } })).value).toBe(5000);
    expect((await prisma.termsVersion.findUniqueOrThrow({ where: { id: terms.id } })).title).toBe('관리자가 바꾼 제목');
    expect(await prisma.feePolicy.count({ where: { scope: 'GLOBAL' } })).toBe(1);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe('보안 민감 변경 감사로그', () => {
  it('API 키 발급·IP 변경·폐기를 남기고 원문 키는 남기지 않는다', async () => {
    const r = await createApiKeyAction(prev, fd({ name: '운영 키', mode: 'LIVE', allowedIps: '203.0.113.10' }));
    expect(r.ok).toBe(true);
    const row = await prisma.merchantApiKey.findFirstOrThrow({ where: { merchantId: fx.merchantId, name: '운영 키' } });
    expect((await updateApiKeyIpsAction(prev, fd({ keyId: row.id, allowedIps: '203.0.113.0/24' }))).ok).toBe(true);
    expect((await revokeApiKeyAction(prev, fd({ keyId: row.id }))).ok).toBe(true);

    const logs = await prisma.adminAuditLog.findMany({ where: { targetId: row.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['API_KEY_ISSUE', 'API_KEY_IP_UPDATE', 'API_KEY_REVOKE']);
    expect(logs.every((l) => l.actorUserId === fx.merchantUserId)).toBe(true);
    const dump = JSON.stringify(logs);
    const secretLine = r.secret!.split('\n')[1];
    expect(dump).not.toContain(secretLine);
  });

  it('웹훅 해제는 보관이며 전송 이력이 남고, 되살릴 수 있다', async () => {
    const r = await createWebhookAction(prev, fd({ url: 'https://hooks.example.com/gs' }));
    expect(r.ok).toBe(true);
    const hook = await prisma.merchantWebhook.findFirstOrThrow({ where: { merchantId: fx.merchantId } });
    vi.stubGlobal('fetch', async () => new Response('err', { status: 500 }));
    await emitMerchantEvent(fx.merchantId, 'charge.succeeded', {});
    await new Promise((res) => setTimeout(res, 150));

    expect((await deleteWebhookAction(prev, fd({ webhookId: hook.id }))).ok).toBe(true);
    const after = await prisma.merchantWebhook.findUniqueOrThrow({ where: { id: hook.id } });
    expect(after.archivedAt).not.toBeNull();
    const deliveries = await prisma.webhookDelivery.findMany({ where: { webhookId: hook.id } });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('DEAD');

    // 보관된 URL 로는 새 이벤트를 적재하지 않는다.
    await emitMerchantEvent(fx.merchantId, 'charge.succeeded', {});
    expect(await prisma.webhookDelivery.count({ where: { webhookId: hook.id } })).toBe(1);

    expect((await restoreWebhookAction(prev, fd({ webhookId: hook.id }))).ok).toBe(true);
    expect((await prisma.merchantWebhook.findUniqueOrThrow({ where: { id: hook.id } })).archivedAt).toBeNull();
    const actions = (await prisma.adminAuditLog.findMany({ where: { targetId: hook.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['WEBHOOK_REGISTER', 'WEBHOOK_ARCHIVE', 'WEBHOOK_RESTORE']);
  });
});

describe('금칙어·발송 템플릿·공휴일 — 하드 삭제 대신 보관', () => {
  it('금칙어를 지우면 적용에서 빠지고, 다시 등록하면 같은 행이 되살아난다', async () => {
    expect((await createBannedWordAction(prev, fd({ word: '나쁜말', action: 'MASK' }))).ok).toBe(true);
    const row = await prisma.bannedWord.findFirstOrThrow({ where: { merchantId: fx.merchantId, word: '나쁜말' } });
    expect((await deleteBannedWordAction(prev, fd({ id: row.id }))).ok).toBe(true);
    expect((await loadBannedWords(fx.merchantId)).some((w) => w.word === '나쁜말')).toBe(false);
    expect(await prisma.bannedWord.count({ where: { id: row.id } })).toBe(1);

    expect((await createBannedWordAction(prev, fd({ word: '나쁜말', action: 'MASK' }))).ok).toBe(true);
    expect(await prisma.bannedWord.count({ where: { merchantId: fx.merchantId, word: '나쁜말' } })).toBe(1);
    expect((await loadBannedWords(fx.merchantId)).some((w) => w.word === '나쁜말')).toBe(true);
  });

  it('발송 템플릿을 지우면 발송에 쓸 수 없고, 같은 코드로 다시 저장하면 되살아난다', async () => {
    const saved = await upsertMerchantTemplate({ merchantId: fx.merchantId, code: 'NOTICE_1', name: '안내', body: '안녕하세요 #{name}님' });
    expect(saved.ok).toBe(true);
    const id = saved.ok ? saved.template.id : '';
    expect((await deleteMtTemplateAction(prev, fd({ templateId: id }))).ok).toBe(true);
    expect(await prisma.merchantMtTemplate.count({ where: { id } })).toBe(1);
    const sent = await sendMerchantMt({
      merchantId: fx.merchantId, merchantName: '기관', templateCode: 'NOTICE_1', variables: { name: '홍' },
      recipient: { phone: '01012345678' }, idempotencyKey: 'k1',
    } as never);
    expect(sent.ok).toBe(false);
    expect((sent as { code?: string }).code).toBe('TEMPLATE_NOT_FOUND');

    const again = await upsertMerchantTemplate({ merchantId: fx.merchantId, code: 'NOTICE_1', name: '안내', body: '안녕하세요 #{name}님' });
    expect(again.ok && again.template.id).toBe(id);
    expect((await prisma.merchantMtTemplate.findUniqueOrThrow({ where: { id } })).archivedAt).toBeNull();
  });

  it('공휴일 삭제는 보관이며 같은 날짜를 다시 등록하면 되살아난다', async () => {
    await adminSession();
    // resetDb 는 공휴일 표(마이그레이션 기준 데이터)를 비우지 않는다. 이 테스트용 날짜만 정리한다.
    await prisma.publicHoliday.deleteMany({ where: { date: '2031-03-03' } });
    const made = await createHolidayAction(prev, fd({ date: '2031-03-03', name: '시험 휴일', kind: 'TEMPORARY' }));
    expect(made.ok).toBe(true);
    const h = await prisma.publicHoliday.findUniqueOrThrow({ where: { date: '2031-03-03' } });
    expect((await deleteHolidayAction(prev, fd({ id: h.id }))).ok).toBe(true);
    const archived = await prisma.publicHoliday.findUniqueOrThrow({ where: { id: h.id } });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.active).toBe(false);
    expect((await createHolidayAction(prev, fd({ date: '2031-03-03', name: '시험 휴일', kind: 'TEMPORARY' }))).ok).toBe(true);
    const back = await prisma.publicHoliday.findUniqueOrThrow({ where: { id: h.id } });
    expect(back.archivedAt).toBeNull();
    expect(back.active).toBe(true);
    await prisma.publicHoliday.delete({ where: { id: h.id } });
  });
});

describe('한도 정책 기간 정합', () => {
  const LIMIT_FIELDS = {
    defaultAmount: '3000', minAmount: '1000', maxAmount: '50000', payerDailyLimit: '100000', payerMonthlyLimit: '500000',
    perMerchantDailyLimit: '10000000', newPayerFirstDayLimit: '50000', manualReviewAmount: '50000',
    payerDailyMaxCount: '20', velocityWindowSec: '60', velocityMaxCount: '5', cooldownAfterCount: '3', cooldownSec: '60',
    failureLockThreshold: '5', active: 'on',
  };

  it('과거 시작일을 거절하고, 기관 범위도 같은 대상의 열린 정책을 마감한다', async () => {
    await adminSession();
    const past = await saveLimitPolicy(prev, fd({ ...LIMIT_FIELDS, scope: 'MERCHANT', merchantId: fx.merchantId, effectiveFrom: '2020-01-01' }));
    expect(past.ok).toBe(false);

    expect((await saveLimitPolicy(prev, fd({ ...LIMIT_FIELDS, scope: 'MERCHANT', merchantId: fx.merchantId }))).ok).toBe(true);
    expect((await saveLimitPolicy(prev, fd({ ...LIMIT_FIELDS, scope: 'MERCHANT', merchantId: fx.merchantId, effectiveFrom: '2099-01-01' }))).ok).toBe(true);
    const open = await prisma.chargeLimitPolicy.count({ where: { scope: 'MERCHANT', merchantId: fx.merchantId, effectiveTo: null } });
    expect(open).toBe(1);
  });

  it('마감한 정책을 다시 켤 때 같은 범위 정책과 기간이 겹치면 거절한다', async () => {
    await adminSession();
    const old = await prisma.chargeLimitPolicy.findFirstOrThrow({ where: { scope: 'GLOBAL' } });
    expect((await toggleLimitPolicy(prev, fd({ id: old.id }))).ok).toBe(true); // 끄기
    await prisma.chargeLimitPolicy.create({ data: { id: newId(), scope: 'GLOBAL' } });
    const back = await toggleLimitPolicy(prev, fd({ id: old.id }));
    expect(back.ok).toBe(false);
    expect((await prisma.chargeLimitPolicy.findUniqueOrThrow({ where: { id: old.id } })).active).toBe(false);
  });
});

describe('전체 금액 범위 일괄 적용 — 되돌림 자료', () => {
  it('모든 기관의 이전 값과 꺼뜨린 항목 id 를 남긴다', async () => {
    await adminSession();
    const extra = await secondMerchant();
    const big = await prisma.chargeProduct.findFirstOrThrow({ where: { merchantId: extra.merchantId, amount: 10000n } });
    const r = await applyGlobalAmountBounds(prev, fd({ minAmount: '1000', maxAmount: '5000' }));
    expect(r.ok).toBe(true);
    const snaps = await prisma.adminAuditLog.findMany({ where: { action: 'MERCHANT_AMOUNT_BOUNDS_SNAPSHOT' } });
    const ids = snaps.flatMap((s) => ((s.beforeValue as { merchants: { id: string }[] }).merchants ?? []).map((m) => m.id));
    expect(ids.sort()).toEqual([fx.merchantId, extra.merchantId].sort());
    const off = await prisma.adminAuditLog.findMany({ where: { action: 'MERCHANT_AMOUNT_BOUNDS_PRODUCTS_OFF' } });
    const offIds = off.flatMap((s) => (s.afterValue as { productIds: string[] }).productIds);
    expect(offIds).toContain(big.id);
  });
});

describe('MO 번호 배정 조건부 갱신', () => {
  it('이미 배정된 번호를 다시 배정하지 못한다', async () => {
    await adminSession();
    const n = await prisma.merchantMoNumber.create({
      data: { id: newId(), phoneNumber: '158899990000', mode: 'DEDICATED', status: 'AVAILABLE', providerId: 'mock' },
    });
    const other = await secondMerchant();
    expect((await assignMoNumber(prev, fd({ id: n.id, merchantId: fx.merchantId }))).ok).toBe(true);
    expect((await assignMoNumber(prev, fd({ id: n.id, merchantId: other.merchantId }))).ok).toBe(false);
    expect((await prisma.merchantMoNumber.findUniqueOrThrow({ where: { id: n.id } })).merchantId).toBe(fx.merchantId);
  });
});

describe('QR · 읽기 경로', () => {
  it('작성 중(DRAFT) 캠페인은 QR 을 내주지 않고, 반복 요청은 429', async () => {
    const code = (await prisma.merchantProfile.findUniqueOrThrow({ where: { id: fx.merchantId } })).code;
    const c = await saveCampaign(fx.merchantId, campaignSchema.parse({ code: 'DRAFTQR', title: '비공개 캠페인', summary: '요약', goalAmount: 100000, startsOn: '2026-01-01', endsOn: '2099-12-31' }));
    expect(await resolveQrTarget(code, c.id)).toBeNull();
    await setCampaignStatus(fx.merchantId, c.id, 'ACTIVE');
    expect(await resolveQrTarget(code, c.id)).not.toBeNull();

    const req = () => new Request(`${BASE}/api/qr/${code}?format=svg`, { headers: { 'x-forwarded-for': '198.51.100.77' } });
    let last = 200;
    for (let i = 0; i < 61; i += 1) last = (await qrGet(req(), { params: Promise.resolve({ code }) })).status;
    expect(last).toBe(429);
  });

  it('getOrgVisuals 는 두 번째 읽기부터 쓰지 않는다', async () => {
    const a = await getOrgVisuals(fx.merchantId);
    const row1 = await prisma.systemSetting.findFirstOrThrow({ where: { key: { contains: fx.merchantId } } });
    await new Promise((r) => setTimeout(r, 10));
    const b = await getOrgVisuals(fx.merchantId);
    const row2 = await prisma.systemSetting.findFirstOrThrow({ where: { key: row1.key } });
    expect(b.bannerIndex).toBe(a.bannerIndex);
    expect(row2.updatedAt.getTime()).toBe(row1.updatedAt.getTime());
  });

  it('monthlyTrend 는 DB 합산으로 KST 월별 금액을 낸다', async () => {
    const now = new Date();
    const base = { merchantId: fx.merchantId, status: 'PAYMENT_SUCCESS' as const, paidAt: now, receivedAt: now, displayName: '후원자', message: '' };
    for (const [amount, isTest] of [[3000n, false], [7000n, false], [99000n, true]] as const) {
      await prisma.charge.create({
        data: { id: newId(), transactionNo: `TRD-${newId()}`, amount, isTest, ...base } as never,
      });
    }
    const trend = await monthlyTrend(fx.merchantId, 2, now);
    const last = trend[trend.length - 1];
    expect(last.total).toBe(10000n);
    expect(last.count).toBe(2);
  });
});
