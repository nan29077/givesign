import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { decrypt } from '@/lib/crypto';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, lastSelectAmountToken, type Fixture } from './helpers';
import { handleMoInbound } from '@/server/services/charge-flow';
import { mockMoAdapter } from '@/server/adapters/mo';
import { confirmChargeAmount, loadSelectAmountContext, isRemoteZip, maskAddress } from '@/server/services/charge-select';
import { completePinAuthorization } from '@/server/services/pin-authorization';
import {
  quoteShipping, parseOptionLines, parseOptions, parseOptionsJson, optionsToLines, buildOptionText,
  optionAddPrice, optionsToStorage, parseNoticeInfo, noticeMissing, parseImages, effectiveDelivery,
  shippingPolicyOf, giveText, stockText, DEFAULT_SHIPPING,
} from '@/server/services/products';
import { requestRefund, approveRefund } from '@/server/services/refund';

/**
 * 상품(비실물·실물)과 배송.
 *
 * 돈과 재고가 걸린 곳이라 확인해야 하는 것
 *  - 배송비 계산이 화면·서버에서 같은 규칙으로 나온다
 *  - 조건부 무료가 수량에 따라 제대로 걸린다
 *  - 재고는 결제 승인 시점에만 줄고, 결제가 실패하면 되돌아온다
 *  - 품절·수량 초과·옵션 조작을 서버가 막는다
 *  - 배송지는 암호화 저장되고 화면 값은 마스킹된다
 */

let fx: Fixture;

const POLICY = shippingPolicyOf(null);

/** 실물 상품 하나를 만든다. */
async function physicalProduct(over: Partial<{
  amount: bigint; stock: number | null; shippingFee: bigint | null;
  freeShipOver: bigint | null; freeShipping: boolean; maxPerOrder: number | null; options: object | null;
}> = {}) {
  return prisma.chargeProduct.create({
    data: {
      id: newId(),
      merchantId: fx.merchantId,
      kind: 'PHYSICAL',
      name: '굿즈 티셔츠',
      sku: 'TS-001',
      amount: over.amount ?? 19000n,
      stock: over.stock === undefined ? 10 : over.stock,
      maxPerOrder: over.maxPerOrder === undefined ? 2 : over.maxPerOrder,
      shippingFee: over.shippingFee === undefined ? 3000n : over.shippingFee,
      freeShipOver: over.freeShipOver === undefined ? null : over.freeShipOver,
      freeShipping: over.freeShipping ?? false,
      options: (over.options === undefined
        ? [{ name: '사이즈', values: ['S', 'M', 'L'] }]
        : over.options) as object,
      sortOrder: 10,
    },
  });
}

const ADDRESS = {
  receiver: '홍길동',
  phone: '01098765432',
  zipCode: '06236',
  address1: '서울특별시 강남구 테헤란로 1',
  address2: '101동 1001호',
  memo: '부재 시 경비실',
};

/** MO 를 받아 상품 선택 링크 토큰까지 만든다. */
async function inboundToken(seq = 1): Promise<string> {
  await seedRegisteredPayer(fx.payerPhone);
  await handleMoInbound(
    mockMoAdapter.parse(moPayload({ to: fx.moNumber, messageId: `PROD-${seq}-${Date.now()}`, text: '주문합니다' })),
  );
  const token = lastSelectAmountToken();
  if (!token) throw new Error('상품 선택 링크를 찾지 못했습니다.');
  return token;
}

/** 결제까지 끝낸다(PIN 인증 완료). */
async function payThrough(chargeId: string) {
  const session = await prisma.paymentPinSession.findUnique({ where: { chargeId } });
  if (!session) throw new Error('PIN 세션이 없습니다.');
  return completePinAuthorization({ sessionId: session.sessionId });
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  // 실물 상품 가격 + 배송비가 한도에 걸리지 않게 상한을 올린다.
  // 신규 후원자 첫날 한도(기본 30,000원)도 함께 올려야 2개 주문이 통과한다.
  await prisma.chargeLimitPolicy.updateMany({
    where: { scope: 'GLOBAL' },
    data: {
      maxAmount: 200000n,
      newPayerFirstDayLimit: 500000n,
      payerDailyLimit: 500000n,
      perMerchantDailyLimit: 500000n,
    },
  });
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { maxAmount: 200000n } });
});

describe('배송비 계산', () => {
  const base = { kind: 'PHYSICAL' as const, amount: 10000n, shippingFee: null, freeShipOver: null, freeShipping: false };

  it('[1] 상품 배송비가 없으면 사회복지기관 기본 배송비를 쓴다', () => {
    const q = quoteShipping(base, 1, POLICY);
    expect(q.fee).toBe(DEFAULT_SHIPPING.baseFee);
    expect(q.total).toBe(10000n + DEFAULT_SHIPPING.baseFee);
  });

  it('[2] 상품 배송비가 있으면 그 값이 우선한다', () => {
    const q = quoteShipping({ ...base, shippingFee: 500n }, 1, POLICY);
    expect(q.fee).toBe(500n);
  });

  it('[3] 항상 무료배송은 조건부 무료보다 우선한다', () => {
    const q = quoteShipping({ ...base, shippingFee: 5000n, freeShipOver: 999_999n, freeShipping: true }, 1, POLICY);
    expect(q.fee).toBe(0n);
    expect(q.freeReason).toBe('무료배송 상품');
  });

  it('[4] 조건부 무료 기준을 넘으면 배송비가 0 이 된다', () => {
    const p = { ...base, shippingFee: 3000n, freeShipOver: 30000n };
    expect(quoteShipping(p, 2, POLICY).fee).toBe(3000n); // 20,000원 — 아직 미달
    const q3 = quoteShipping(p, 3, POLICY); // 30,000원 — 달성
    expect(q3.fee).toBe(0n);
    expect(q3.freeReason).toBe('조건부 무료');
  });

  it('[5] 조건부 무료까지 남은 금액을 알려준다', () => {
    const q = quoteShipping({ ...base, shippingFee: 3000n, freeShipOver: 30000n }, 1, POLICY);
    expect(q.freeShortfall).toBe(20000n);
  });

  it('[6] 도서산간 추가배송비는 무료배송이어도 붙는다', () => {
    const policy = { ...POLICY, remoteFee: 3000n };
    const q = quoteShipping({ ...base, freeShipping: true }, 1, policy, true);
    expect(q.fee).toBe(3000n);
    expect(q.remoteExtra).toBe(3000n);
  });

  it('[7] 비실물 상품에는 배송비가 붙지 않는다', () => {
    const q = quoteShipping({ ...base, kind: 'DIGITAL' }, 3, { ...POLICY, remoteFee: 5000n }, true);
    expect(q.fee).toBe(0n);
    expect(q.total).toBe(30000n);
  });
});

describe('옵션', () => {
  it('[8] 여러 줄 입력을 옵션 정의로 바꾼다', () => {
    const parsed = parseOptionLines('사이즈: S, M, L\n색상: 블랙, 화이트');
    expect(parsed).toEqual([
      {
        name: '사이즈',
        values: [
          { label: 'S', addPrice: 0n, soldOut: false },
          { label: 'M', addPrice: 0n, soldOut: false },
          { label: 'L', addPrice: 0n, soldOut: false },
        ],
      },
      {
        name: '색상',
        values: [
          { label: '블랙', addPrice: 0n, soldOut: false },
          { label: '화이트', addPrice: 0n, soldOut: false },
        ],
      },
    ]);
    expect(optionsToLines(parsed)).toBe('사이즈: S, M, L\n색상: 블랙, 화이트');
  });

  it('[8-1] 옛 형식(문자열 배열)도 그대로 읽는다', () => {
    // 개편 전에 저장된 상품이 있으므로 두 형식을 모두 읽어야 한다.
    expect(parseOptions([{ name: '사이즈', values: ['S', 'M'] }])).toEqual([
      {
        name: '사이즈',
        values: [
          { label: 'S', addPrice: 0n, soldOut: false },
          { label: 'M', addPrice: 0n, soldOut: false },
        ],
      },
    ]);
  });

  it('[8-2] 편집기 JSON 을 읽고 저장 형태로 되돌린다', () => {
    const defs = parseOptionsJson(
      JSON.stringify([
        { name: '사이즈', values: [{ label: 'L', addPrice: '2000', soldOut: false }, { label: 'XL', addPrice: '3000', soldOut: true }] },
      ]),
    );
    expect(defs[0].values[0].addPrice).toBe(2000n);
    expect(defs[0].values[1].soldOut).toBe(true);
    expect(optionsToStorage(defs)).toEqual([
      { name: '사이즈', values: [{ label: 'L', addPrice: '2000', soldOut: false }, { label: 'XL', addPrice: '3000', soldOut: true }] },
    ]);
    // 형식이 깨진 JSON 은 예외 대신 빈 배열
    expect(parseOptionsJson('{not json')).toEqual([]);
  });

  it('[9] 모양이 깨진 값은 예외 대신 빈 배열로 떨어진다', () => {
    expect(parseOptions('이상한 값')).toEqual([]);
    expect(parseOptions([{ name: '', values: [] }, { nope: 1 }])).toEqual([]);
    expect(parseOptions(null)).toEqual([]);
  });

  it('[10] 정의에 없는 선택값은 거절한다', () => {
    const defs = [{ name: '사이즈', values: ['S', 'M'] }];
    expect(buildOptionText(defs, { 사이즈: 'M' })).toEqual({ ok: true, text: '사이즈: M' });
    const bad = buildOptionText(defs, { 사이즈: 'XXL' });
    expect(bad.ok).toBe(false);
    const missing = buildOptionText(defs, {});
    expect(missing.ok).toBe(false);
  });

  it('[10-1] 품절 처리된 옵션값은 폼을 고쳐도 통과하지 못한다', () => {
    const defs = [
      { name: '색상', values: [{ label: '블랙', addPrice: '0', soldOut: false }, { label: '화이트', addPrice: '0', soldOut: true }] },
    ];
    expect(buildOptionText(defs, { 색상: '블랙' }).ok).toBe(true);
    expect(buildOptionText(defs, { 색상: '화이트' }).ok).toBe(false);
  });

  it('[10-2] 옵션 추가금은 서버가 다시 계산한다', () => {
    const defs = [
      { name: '사이즈', values: [{ label: 'L', addPrice: '2000', soldOut: false }] },
      { name: '각인', values: [{ label: '있음', addPrice: '5000', soldOut: false }] },
    ];
    expect(optionAddPrice(defs, { 사이즈: 'L', 각인: '있음' })).toBe(7000n);
    // 정의에 없는 값은 0원으로 본다(금액을 부풀리지 못한다)
    expect(optionAddPrice(defs, { 사이즈: 'XXL' })).toBe(0n);
  });

  it('[10-3] 옵션 추가금이 결제 금액에 반영된다', () => {
    const p = { kind: 'PHYSICAL' as const, amount: 10_000n, shippingFee: null, freeShipOver: null, freeShipping: false };
    const q = quoteShipping(p, 2, POLICY, false, 2_000n);
    expect(q.goods).toBe(24_000n); // (10,000 + 2,000) × 2
    expect(q.total).toBe(27_000n); // + 기본 배송비 3,000
  });
});

describe('고시 · 이미지 · 배송 기본값', () => {
  it('[10-4] 고시 정보는 모양이 깨져도 예외를 던지지 않는다', () => {
    expect(parseNoticeInfo(null)).toBeNull();
    expect(parseNoticeInfo({ category: 'FASHION', items: [] })).toBeNull();
    const info = parseNoticeInfo({ category: 'FASHION', items: [{ label: '제품 소재', value: '면 100%' }] });
    expect(info?.category).toBe('FASHION');
    // 비어 있는 필수 항목은 경고 대상으로 남는다
    expect(noticeMissing(info)).toContain('색상');
    expect(noticeMissing(null).length).toBeGreaterThan(0);
  });

  it('[10-5] 추가 이미지는 장수 상한을 넘기지 않는다', () => {
    expect(parseImages(['/a.png', '/b.png'])).toEqual(['/a.png', '/b.png']);
    expect(parseImages(Array.from({ length: 12 }, (_, i) => `/x${i}.png`)).length).toBe(5);
    expect(parseImages('이상한 값')).toEqual([]);
  });

  it('[10-6] 출고일·반품비는 상품값이 없으면 사회복지기관 기본값을 따른다', () => {
    const policy = { ...POLICY, dispatchDays: 3, returnFee: 2_500n, exchangeFee: 5_000n };
    expect(effectiveDelivery({ dispatchDays: null, returnFee: null, exchangeFee: null }, policy)).toEqual({
      dispatchDays: 3,
      returnFee: 2_500n,
      exchangeFee: 5_000n,
    });
    expect(effectiveDelivery({ dispatchDays: 1, returnFee: 0n, exchangeFee: null }, policy)).toEqual({
      dispatchDays: 1,
      returnFee: 0n,
      exchangeFee: 5_000n,
    });
  });
});

describe('표기', () => {
  it('[11] 포인트는 금액과 1:1 로 안내한다', () => {
    expect(giveText({ kind: 'DIGITAL', digitalType: 'POINT', amount: 10000n, giveAmount: null, giveUnit: null, validDays: null }))
      .toBe('10,000포인트');
  });

  it('[12] 이용권은 유효기간을 함께 보여준다', () => {
    expect(giveText({ kind: 'DIGITAL', digitalType: 'PASS', amount: 9900n, giveAmount: 1n, giveUnit: '개월', validDays: 30 }))
      .toBe('1개월 (유효기간 30일)');
  });

  it('[13] 재고 표기는 무제한이면 만들지 않는다', () => {
    expect(stockText({ kind: 'PHYSICAL', stock: null })).toBeNull();
    expect(stockText({ kind: 'PHYSICAL', stock: 0 })).toBe('품절');
    expect(stockText({ kind: 'DIGITAL', stock: 3 })).toBeNull();
  });

  it('[14] 도서산간 우편번호를 가려낸다', () => {
    expect(isRemoteZip('63000')).toBe(true); // 제주
    expect(isRemoteZip('40240')).toBe(true); // 울릉
    expect(isRemoteZip('06236')).toBe(false); // 서울
  });

  it('[15] 주소는 시/군/구까지만 남긴다', () => {
    expect(maskAddress('서울특별시 강남구 테헤란로 1 101동')).toBe('서울특별시 강남구 ***');
  });
});

describe('실물 상품 주문', () => {
  it('[16] 상품 목록에 실물 상품이 배송비와 함께 나온다', async () => {
    await physicalProduct();
    const token = await inboundToken();
    const ctx = await loadSelectAmountContext(token);
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) return;

    const item = ctx.ctx.products.find((p) => p.kind === 'PHYSICAL');
    expect(item).toBeDefined();
    expect(item!.shippingFee).toBe(3000n);
    expect(item!.options).toEqual([
      {
        name: '사이즈',
        values: [
          { label: 'S', addPrice: 0n, soldOut: false },
          { label: 'M', addPrice: 0n, soldOut: false },
          { label: 'L', addPrice: 0n, soldOut: false },
        ],
      },
    ]);
    expect(item!.stock).toBe(10);
    expect(item!.soldOut).toBe(false);
  });

  it('[17] 배송비를 더한 금액으로 결제가 확정되고 배송지가 암호화 저장된다', async () => {
    const product = await physicalProduct();
    const token = await inboundToken();

    const res = await confirmChargeAmount({
      token,
      productId: product.id,
      quantity: 2,
      optionValues: { 사이즈: 'L' },
      address: ADDRESS,
    });
    expect(res.ok).toBe(true);

    const charge = await prisma.charge.findFirstOrThrow({
      where: { merchantId: fx.merchantId, productId: product.id },
      include: { shipment: true },
    });
    expect(charge.amount).toBe(19000n * 2n + 3000n);
    expect(charge.shippingFee).toBe(3000n);
    expect(charge.quantity).toBe(2);
    expect(charge.optionText).toBe('사이즈: L');

    // 배송지 원문은 저장되지 않고, 복호화해야 나온다.
    const s = charge.shipment!;
    expect(s.receiverMasked).not.toBe(ADDRESS.receiver);
    expect(decrypt(s.receiverEnc)).toBe(ADDRESS.receiver);
    expect(decrypt(s.phoneEnc)).toBe(ADDRESS.phone);
    expect(decrypt(s.addressEnc)).toContain('테헤란로');
    expect(s.addressMasked).toBe('서울특별시 강남구 ***');
    expect(s.status).toBe('PREPARING');
  });

  it('[18] 배송지가 없으면 확정하지 않는다', async () => {
    const product = await physicalProduct();
    const token = await inboundToken();
    const res = await confirmChargeAmount({ token, productId: product.id, quantity: 1, optionValues: { 사이즈: 'S' } });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/배송지/);
  });

  it('[19] 옵션을 고르지 않으면 확정하지 않는다', async () => {
    const product = await physicalProduct();
    const token = await inboundToken();
    const res = await confirmChargeAmount({ token, productId: product.id, quantity: 1, address: ADDRESS });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/사이즈/);
  });

  it('[20] 1회 주문 최대 수량을 넘기면 거절한다', async () => {
    const product = await physicalProduct({ maxPerOrder: 2 });
    const token = await inboundToken();
    const res = await confirmChargeAmount({
      token, productId: product.id, quantity: 3, optionValues: { 사이즈: 'S' }, address: ADDRESS,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/최대 2개/);
  });

  it('[21] 재고보다 많이 주문하면 거절한다', async () => {
    const product = await physicalProduct({ stock: 1, maxPerOrder: 5 });
    const token = await inboundToken();
    const res = await confirmChargeAmount({
      token, productId: product.id, quantity: 2, optionValues: { 사이즈: 'S' }, address: ADDRESS,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/재고/);
  });

  it('[22] 품절 상품은 고를 수 없다', async () => {
    const product = await physicalProduct({ stock: 0 });
    const token = await inboundToken();
    const res = await confirmChargeAmount({
      token, productId: product.id, quantity: 1, optionValues: { 사이즈: 'S' }, address: ADDRESS,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/품절/);
  });

  it('[23] 도서산간 주소는 추가 배송비가 붙는다', async () => {
    await prisma.merchantShippingPolicy.create({
      data: { id: newId(), merchantId: fx.merchantId, baseFee: 3000n, remoteFee: 3000n },
    });
    const product = await physicalProduct();
    const token = await inboundToken();
    const res = await confirmChargeAmount({
      token,
      productId: product.id,
      quantity: 1,
      optionValues: { 사이즈: 'S' },
      address: { ...ADDRESS, zipCode: '63000' }, // 제주
    });
    expect(res.ok).toBe(true);

    const charge = await prisma.charge.findFirstOrThrow({
      where: { productId: product.id },
      include: { shipment: true },
    });
    expect(charge.shippingFee).toBe(6000n);
    expect(charge.amount).toBe(19000n + 6000n);
    expect(charge.shipment!.remote).toBe(true);
  });
});

describe('재고 차감', () => {
  it('[24] 결제가 승인되면 재고가 줄어든다', async () => {
    const product = await physicalProduct({ stock: 10 });
    const token = await inboundToken();
    const sel = await confirmChargeAmount({
      token, productId: product.id, quantity: 2, optionValues: { 사이즈: 'S' }, address: ADDRESS,
    });
    expect(sel.ok).toBe(true);

    const charge = await prisma.charge.findFirstOrThrow({ where: { productId: product.id } });
    // 선택 단계에서는 아직 줄지 않는다.
    expect((await prisma.chargeProduct.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(10);

    await payThrough(charge.id);
    expect((await prisma.chargeProduct.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(8);
  });

  it('[25] 결제가 실패하면 잡아둔 재고가 돌아온다', async () => {
    // mock 결제 어댑터는 금액 끝자리 999 를 거절한다.
    const product = await physicalProduct({ stock: 5, amount: 15999n, shippingFee: 0n, maxPerOrder: 1 });
    const token = await inboundToken();
    const sel = await confirmChargeAmount({
      token, productId: product.id, quantity: 1, optionValues: { 사이즈: 'S' }, address: ADDRESS,
    });
    expect(sel.ok).toBe(true);

    const charge = await prisma.charge.findFirstOrThrow({ where: { productId: product.id } });
    await payThrough(charge.id);

    const after = await prisma.charge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(after.status).toBe('PAYMENT_FAILED');
    expect((await prisma.chargeProduct.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(5);
  });

  it('[26] 재고 무제한 상품은 차감하지 않는다', async () => {
    const product = await physicalProduct({ stock: null });
    const token = await inboundToken();
    await confirmChargeAmount({
      token, productId: product.id, quantity: 1, optionValues: { 사이즈: 'S' }, address: ADDRESS,
    });
    const charge = await prisma.charge.findFirstOrThrow({ where: { productId: product.id } });
    await payThrough(charge.id);
    expect((await prisma.chargeProduct.findUniqueOrThrow({ where: { id: product.id } })).stock).toBeNull();
  });
});

describe('환불과 재고', () => {
  it('[27] 발송 전 환불이면 재고가 복구되고 배송이 취소된다', async () => {
    const product = await physicalProduct({ stock: 10, maxPerOrder: 1 });
    const token = await inboundToken();
    await confirmChargeAmount({
      token, productId: product.id, quantity: 1, optionValues: { 사이즈: 'S' }, address: ADDRESS,
    });
    const charge = await prisma.charge.findFirstOrThrow({ where: { productId: product.id } });
    await payThrough(charge.id);
    expect((await prisma.chargeProduct.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(9);

    const refund = await requestRefund({ chargeId: charge.id, reason: '단순 변심', requestedBy: 'payer' });
    await approveRefund(refund.id);

    expect((await prisma.chargeProduct.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(10);
    const shipment = await prisma.chargeShipment.findUniqueOrThrow({ where: { chargeId: charge.id } });
    expect(shipment.status).toBe('CANCELED');
  });

  it('[28] 이미 발송한 뒤 환불하면 재고를 되돌리지 않는다', async () => {
    const product = await physicalProduct({ stock: 10, maxPerOrder: 1 });
    const token = await inboundToken();
    await confirmChargeAmount({
      token, productId: product.id, quantity: 1, optionValues: { 사이즈: 'S' }, address: ADDRESS,
    });
    const charge = await prisma.charge.findFirstOrThrow({ where: { productId: product.id } });
    await payThrough(charge.id);

    await prisma.chargeShipment.update({
      where: { chargeId: charge.id },
      data: { status: 'SHIPPED', carrier: 'CJ대한통운', trackingNo: '123456789012', shippedAt: new Date() },
    });

    const refund = await requestRefund({ chargeId: charge.id, reason: '파손', requestedBy: 'payer' });
    await approveRefund(refund.id);

    // 물건이 이미 나갔으므로 재고는 그대로다. 회수는 사회복지기관이 한다.
    expect((await prisma.chargeProduct.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(9);
    const shipment = await prisma.chargeShipment.findUniqueOrThrow({ where: { chargeId: charge.id } });
    expect(shipment.status).toBe('SHIPPED');
    // 회수 안내는 사회복지기관 내부 메모에 남긴다.
    // 후원자가 결제 화면에서 남긴 배송 요청(memo)을 덮어쓰면 오배송 분쟁 근거가 사라진다.
    expect(shipment.merchantMemo).toMatch(/회수/);
    expect(shipment.memo).toBe('부재 시 경비실');
  });
});
