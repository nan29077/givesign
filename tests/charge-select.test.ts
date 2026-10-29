import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { mockMoAdapter } from '@/server/adapters/mo';
import { readMockOutbox } from '@/server/adapters/mt';
import { handleMoInbound } from '@/server/services/charge-flow';
import { confirmChargeAmount, loadSelectAmountContext } from '@/server/services/charge-select';
import { completePinAuthorization } from '@/server/services/pin-authorization';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, lastSelectAmountToken, type Fixture } from './helpers';

/**
 * 후원 금액 선택 흐름 (문자PG 핵심 경로).
 *
 *   MO 수신 → 금액 0 · PENDING_AMOUNT + 선택 링크 1통
 *   → 후원자가 상품 선택 → 금액 확정 → 결제사 PIN → 콜백 → 승인
 *
 * 이 파일이 지키는 것
 *  1) 문자를 보내는 것만으로는 금액도, 출금도 정해지지 않는다.
 *  2) 링크는 1회용이다. 두 번 눌러도 결제는 한 건이다.
 *  3) 사회복지기관이 허용한 금액 밖으로는 절대 확정되지 않는다.
 *  4) 다른 사회복지기관의 상품은 고를 수 없다.
 */

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => handleMoInbound(mockMoAdapter.parse(p));

describe('후원 금액 선택', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
    await seedRegisteredPayer(fx.payerPhone);
  });

  it('[1] MO 만으로는 금액이 정해지지 않고 선택 링크 1통만 나간다', async () => {
    const res = await inbound(moPayload({ to: fx.moNumber, text: '충전합니다' }));

    expect(res.status).toBe('PENDING_AMOUNT');
    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: res.chargeId! } });
    expect(charge.amount).toBe(0n);
    expect(charge.paidAt).toBeNull();

    // 출금·PIN 은 아직 없다
    expect(await prisma.paymentTransaction.count()).toBe(0);
    expect(await prisma.paymentPinSession.count()).toBe(0);

    // 문자는 선택 링크 한 통뿐이다
    expect(await prisma.secureLink.count({ where: { purpose: 'SELECT_AMOUNT' } })).toBe(1);
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'SELECT_AMOUNT' } })).toBe(1);
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'PIN_REQUEST' } })).toBe(0);

    const mt = readMockOutbox(3)[0];
    expect(mt.text).toContain('아직 결제되지 않았습니다');
  });

  it('[2] 선택 화면에는 사회복지기관이 등록한 상품과 허용 범위가 내려온다', async () => {
    await inbound(moPayload({ to: fx.moNumber }));
    const token = lastSelectAmountToken()!;

    const loaded = await loadSelectAmountContext(token);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.ctx.products.map((p) => p.amount)).toEqual([3000n, 10000n]);
    expect(loaded.ctx.allowCustomAmount).toBe(true);
    expect(loaded.ctx.minAmount).toBeLessThanOrEqual(3000n);
    expect(loaded.ctx.maxAmount).toBeGreaterThanOrEqual(10000n);
  });

  it('[3] 상품을 고르면 금액이 확정되고 PIN 입력 주소가 돌아온다 (문자 추가 발송 없음)', async () => {
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const token = lastSelectAmountToken()!;
    const product = await prisma.chargeProduct.findFirstOrThrow({ where: { amount: 10000n } });

    const sel = await confirmChargeAmount({ token, productId: product.id });
    expect(sel.ok).toBe(true);
    expect(sel.pinUrl).toBeTruthy();

    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: res.chargeId! } });
    expect(charge.amount).toBe(10000n);
    expect(charge.status).toBe('PENDING_PIN');
    // 아직 출금 전이다
    expect(await prisma.paymentTransaction.count()).toBe(0);
    // PIN 은 화면에서 이어지므로 문자를 한 번 더 보내지 않는다
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'PIN_REQUEST' } })).toBe(0);

    // PIN 콜백까지 오면 결제가 완료된다
    const session = await prisma.paymentPinSession.findFirstOrThrow();
    expect(session.amount).toBe(10000n);
    const done = await completePinAuthorization({ sessionId: session.sessionId });
    expect(done.ok).toBe(true);

    const paid = await prisma.charge.findUniqueOrThrow({ where: { id: res.chargeId! } });
    expect(paid.paidAt).not.toBeNull();
    expect(paid.amount).toBe(10000n);
    expect(await prisma.settlementLedger.count({ where: { chargeId: paid.id } })).toBeGreaterThan(0);
  });

  it('[4] 같은 링크로 두 번 확정해도 결제는 한 건이다', async () => {
    await inbound(moPayload({ to: fx.moNumber }));
    const token = lastSelectAmountToken()!;
    const product = await prisma.chargeProduct.findFirstOrThrow({ where: { amount: 3000n } });

    const first = await confirmChargeAmount({ token, productId: product.id });
    const second = await confirmChargeAmount({ token, productId: product.id });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(await prisma.paymentPinSession.count()).toBe(1);
  });

  it('[5] 동시에 두 번 눌러도 한 번만 확정된다', async () => {
    await inbound(moPayload({ to: fx.moNumber }));
    const token = lastSelectAmountToken()!;
    const product = await prisma.chargeProduct.findFirstOrThrow({ where: { amount: 3000n } });

    const [a, b] = await Promise.all([
      confirmChargeAmount({ token, productId: product.id }),
      confirmChargeAmount({ token, productId: product.id }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await prisma.paymentPinSession.count()).toBe(1);
  });

  it('[6] 허용 범위 밖 직접 입력은 거절한다', async () => {
    await inbound(moPayload({ to: fx.moNumber }));
    const token = lastSelectAmountToken()!;

    const tooBig = await confirmChargeAmount({ token, customAmount: 99_999_999n });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.message).toContain('사이여야');

    // 거절된 뒤에도 링크는 살아 있어 정상 금액으로 다시 시도할 수 있다
    const ok = await confirmChargeAmount({ token, customAmount: 5000n });
    expect(ok.ok).toBe(true);
    const charge = await prisma.charge.findFirstOrThrow();
    expect(charge.amount).toBe(5000n);
  });

  it('[7] 직접 입력을 끈 사회복지기관에서는 직접 입력이 거절된다', async () => {
    await prisma.merchantProfile.update({
      where: { id: fx.merchantId },
      data: { allowCustomAmount: false },
    });
    await inbound(moPayload({ to: fx.moNumber }));
    const token = lastSelectAmountToken()!;

    const res = await confirmChargeAmount({ token, customAmount: 5000n });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('직접 입력');
  });

  it('[8] 다른 사회복지기관의 상품은 고를 수 없다', async () => {
    const otherUser = await prisma.user.create({
      data: { id: `u-${Date.now()}`, email: `other-${Date.now()}@test.kr`, name: '다른사회복지기관', role: 'MERCHANT' },
    });
    const other = await prisma.merchantProfile.create({
      data: {
        id: `c-${Date.now()}`,
        userId: otherUser.id,
        code: `GIV-${Date.now().toString().slice(-4)}`,
        displayName: '다른사회복지기관',
        status: 'APPROVED',
      },
    });
    const otherProduct = await prisma.chargeProduct.create({
      data: { id: `p-${Date.now()}`, merchantId: other.id, name: '남의 상품', amount: 7000n },
    });

    await inbound(moPayload({ to: fx.moNumber }));
    const token = lastSelectAmountToken()!;

    const res = await confirmChargeAmount({ token, productId: otherProduct.id });
    expect(res.ok).toBe(false);
    expect(await prisma.paymentPinSession.count()).toBe(0);
  });

  it('[9] 사용 중지한 상품은 선택지에 없고 고를 수도 없다', async () => {
    const product = await prisma.chargeProduct.findFirstOrThrow({ where: { amount: 10000n } });
    await prisma.chargeProduct.update({ where: { id: product.id }, data: { active: false } });

    await inbound(moPayload({ to: fx.moNumber }));
    const token = lastSelectAmountToken()!;

    const loaded = await loadSelectAmountContext(token);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.ctx.products.map((p) => p.amount)).toEqual([3000n]);

    const res = await confirmChargeAmount({ token, productId: product.id });
    expect(res.ok).toBe(false);
  });

  it('[10] 만료된 링크로는 확정할 수 없다', async () => {
    await inbound(moPayload({ to: fx.moNumber }));
    const token = lastSelectAmountToken()!;
    await prisma.secureLink.updateMany({
      where: { purpose: 'SELECT_AMOUNT' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const product = await prisma.chargeProduct.findFirstOrThrow({ where: { amount: 3000n } });
    const res = await confirmChargeAmount({ token, productId: product.id });
    expect(res.ok).toBe(false);
    expect(await prisma.paymentPinSession.count()).toBe(0);
  });

  it('[11] 고를 수 있는 금액이 하나도 없으면 링크를 보내지 않고 실패로 안내한다', async () => {
    await prisma.chargeProduct.updateMany({ where: { merchantId: fx.merchantId }, data: { active: false } });
    await prisma.merchantProfile.update({
      where: { id: fx.merchantId },
      data: { allowCustomAmount: false },
    });

    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.status).toBe('PAYMENT_FAILED');
    expect(await prisma.secureLink.count({ where: { purpose: 'SELECT_AMOUNT' } })).toBe(0);
    expect(await prisma.paymentTransaction.count()).toBe(0);
  });

  it('[12] 차단된 후원자는 링크를 받지 못한다', async () => {
    const payer = await prisma.payerProfile.findFirstOrThrow();
    await prisma.blockedPayer.create({
      data: { id: `b-${Date.now()}`, merchantId: fx.merchantId, payerId: payer.id, reason: '테스트' },
    });

    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.status).toBe('LIMIT_BLOCKED');
    expect(await prisma.secureLink.count({ where: { purpose: 'SELECT_AMOUNT' } })).toBe(0);
  });

  async function payWithProduct() {
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const token = lastSelectAmountToken()!;
    const product = await prisma.chargeProduct.findFirstOrThrow({ where: { amount: 3000n } });
    await confirmChargeAmount({ token, productId: product.id });
    const session = await prisma.paymentPinSession.findFirstOrThrow();
    await completePinAuthorization({ sessionId: session.sessionId });
    return prisma.charge.findUniqueOrThrow({ where: { id: res.chargeId! } });
  }

  it('[13] 후원은 기관이 따로 지급할 것이 없어 결제가 승인되면 처리 상태가 "해당 없음(SKIPPED)"이다', async () => {
    const paid = await payWithProduct();
    expect(paid.paidAt).not.toBeNull();
    // "지급 대기"로 쌓이지 않는다(점검 M-17).
    expect(paid.pointStatus).toBe('SKIPPED');
  });

  it('[13-1] 상품 기능(FEATURE_GOODS)을 켜면 디지털 항목은 예전처럼 지급 대기로 남는다', async () => {
    vi.stubEnv('FEATURE_GOODS', 'true');
    try {
      const paid = await payWithProduct();
      expect(paid.paidAt).not.toBeNull();
      // 기브싸인은 기관 서버를 호출하지 않는다. 지급 여부는 기관이 콘솔·연동 API 로 표시한다.
      expect(paid.pointStatus).toBe('PENDING');
      expect(paid.pointGivenAt).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

});
