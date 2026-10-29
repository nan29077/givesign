import { prisma } from '@/server/db';
import { resolveSecureLink, consumeSecureLink } from './secure-link';
import { checkLimits, resolvePolicy } from './limits';
import { startPinAuthorization, setStatus } from './charge-flow';
import {
  buildOptionText, effectiveDelivery, giveText, loadShippingPolicy, optionAddPrice, parseImages,
  parseOptions, quoteShipping,
  type ProductOption, type ShippingPolicyView,
} from './products';
import { encrypt, maskName, maskPhone, normalizePhone } from '@/lib/crypto';
import { newId } from '@/lib/id';
import type { DigitalProductType, ProductKind } from '@/generated/prisma/enums';

/**
 * 상품·금액 선택.
 *
 * MO 문자에는 금액이 없다. 문자를 받으면 금액 0 · PENDING_AMOUNT 로 결제 건을 만들고
 * SELECT_AMOUNT 링크를 보낸다. 후원자가 이 화면에서 상품을 고르면 그때 금액이 정해지고,
 * 한도를 확인한 뒤 곧바로 결제사 PIN 인증으로 이어진다(문자를 한 번 더 보내지 않는다).
 *
 * 상품은 두 종류다.
 *  - 비실물 : 금액만 고르면 끝난다.
 *  - 실물   : 수량·옵션·배송지를 함께 받고, 배송비를 더해 결제 금액을 만든다.
 *             재고는 여기서 줄이지 않는다. **결제가 승인된 순간에만** 줄인다(charge-flow).
 *             선택 단계에서 줄이면 결제를 포기한 사람들 때문에 재고가 잠겨 팔지 못한다.
 *
 * 이중 결제 방어
 *  - 링크는 1회용이다. 금액을 확정하는 순간 consumeSecureLink 로 선점한다.
 *  - 선점에 실패하면(중복 클릭·뒤로가기 후 재제출) 아무 것도 하지 않고 거절한다.
 *  - 금액 확정은 PENDING_AMOUNT 상태에서만 가능하다(updateMany 의 조건으로 못박는다).
 */

export interface ChargeProductOption {
  id: string;
  kind: ProductKind;
  digitalType: DigitalProductType | null;
  name: string;
  amount: bigint;
  description: string | null;
  imageUrl: string | null;
  /** 대표 이미지 외 추가 이미지 */
  images: string[];
  /** 지급 안내 문구 (비실물만) */
  give: string | null;
  /** 청약철회 제한 안내(디지털 콘텐츠 특례). 비실물에만 쓴다. */
  withdrawalNotice: string | null;
  /** 결제 뒤 작성할 문서 서식 이름 (문서 상품만). */
  documentName: string | null;
  // ── 실물 전용 ──
  /** 남은 재고. null 이면 무제한 */
  stock: number | null;
  soldOut: boolean;
  maxPerOrder: number | null;
  options: ProductOption[];
  /** 1개 주문 시 배송비 (도서산간 제외) */
  shippingFee: bigint;
  /** 배송비가 무료가 되는 이유. 없으면 null */
  freeReason: string | null;
  /** 조건부 무료까지 남은 금액 */
  freeShortfall: bigint | null;
  /** 결제 후 출고까지 걸리는 영업일 */
  dispatchDays: number;
  /** 반품 배송비(편도) */
  returnFee: bigint;
  /** 교환 배송비(왕복) */
  exchangeFee: bigint;
  /** 이 상품을 1개라도 살 수 있는지 (한도 안에 들어오는지) */
  payable: boolean;
}

export interface SelectAmountContext {
  linkId: string;
  chargeId: string;
  merchantName: string;
  /** 후원자가 보낸 문자 내용(필터링 완료본). 참고용으로만 보여준다. */
  message: string;
  products: ChargeProductOption[];
  allowCustomAmount: boolean;
  minAmount: bigint;
  maxAmount: bigint;
  /**
   * 직접 입력 전용 범위·단위.
   * 사회복지기관이 후원 설정에서 좁혀 둔 값과 유효 범위(사회복지기관 ∩ 한도 정책)의 교집합이다.
   * 설정 화면이 "지금 적용되는 직접 입력 범위" 라고 안내하므로 결제도 같은 값을 써야 한다.
   */
  customMin: bigint;
  customMax: bigint;
  /** null 이면 단위 제한 없음. 1 은 제한 없는 것과 같으므로 null 로 정규화한다. */
  customStep: number | null;
  expiresAt: Date;
  shipping: ShippingPolicyView;
}

export async function loadSelectAmountContext(
  token: string,
): Promise<{ ok: true; ctx: SelectAmountContext } | { ok: false; reason: string }> {
  const res = await resolveSecureLink(token);
  if (!res.ok) {
    const reason =
      res.reason === 'EXPIRED'
        ? '유효 시간이 지난 링크입니다. 결제는 진행되지 않았습니다. 문자를 다시 보내 주세요.'
        : res.reason === 'USED'
          ? '이미 사용한 링크입니다.'
          : '유효하지 않은 링크입니다.';
    return { ok: false, reason };
  }

  const link = res.link!;
  if (link.purpose !== 'SELECT_AMOUNT' || !link.chargeId) {
    return { ok: false, reason: '용도가 다른 링크입니다.' };
  }

  const charge = await prisma.charge.findUnique({
    where: { id: link.chargeId },
    include: { merchant: true },
  });
  if (!charge) return { ok: false, reason: '결제 거래를 찾을 수 없습니다.' };
  if (charge.status !== 'PENDING_AMOUNT') {
    return { ok: false, reason: '이미 처리된 결제입니다.' };
  }

  const [rows, policy, shipping] = await Promise.all([
    prisma.chargeProduct.findMany({
      where: { merchantId: charge.merchantId, active: true, archivedAt: null },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { amount: 'asc' }],
      // 문서 상품은 결제 화면에서 "무엇을 작성하게 되는지" 를 미리 알려야 한다.
      include: { documentTemplate: { select: { name: true, active: true } } },
    }),
    resolvePolicy(charge.merchantId, charge.payerId),
    loadShippingPolicy(charge.merchantId),
  ]);

  // 유효 범위 = 사회복지기관 허용 범위 ∩ 한도 정책 범위.
  const minAmount =
    charge.merchant.minAmount > policy.minAmount ? charge.merchant.minAmount : policy.minAmount;
  const maxAmount =
    charge.merchant.maxAmount < policy.maxAmount ? charge.merchant.maxAmount : policy.maxAmount;

  // 직접 입력 범위는 사회복지기관이 따로 좁힐 수 있다. 유효 범위 밖으로 넓히지는 못한다.
  const customMinRaw = charge.merchant.customMinAmount ?? minAmount;
  const customMaxRaw = charge.merchant.customMaxAmount ?? maxAmount;
  const customMin = customMinRaw > minAmount ? customMinRaw : minAmount;
  const customMax = customMaxRaw < maxAmount ? customMaxRaw : maxAmount;
  const customStep =
    charge.merchant.customAmountStep != null && charge.merchant.customAmountStep > 1
      ? charge.merchant.customAmountStep
      : null;

  const products: ChargeProductOption[] = [];
  for (const p of rows) {
    // 문서 상품은 작성할 서식이 살아 있어야 판다. 서식이 없거나 중지 상태면 결제해도
    // 후원자에게 작성 화면을 그려 줄 수 없다 — 돈만 받고 끝나는 상품이 된다.
    if (p.kind === 'DOCUMENT' && !p.documentTemplate?.active) continue;

    const quote = quoteShipping(
      { kind: p.kind, amount: p.amount, shippingFee: p.shippingFee, freeShipOver: p.freeShipOver, freeShipping: p.freeShipping },
      1,
      shipping,
    );
    // 1개도 한도 안에 들어오지 않는 상품은 아예 고를 수 없다.
    const payable = quote.total >= minAmount && quote.total <= maxAmount;
    // 비실물·문서는 한도 밖이면 목록에서 뺀다(과거 동작 유지).
    // 실물은 목록에 남기되 고를 수 없게 표시한다 — 사라지면 사회복지기관이 원인을 못 찾는다.
    if (p.kind !== 'PHYSICAL' && !payable) continue;

    const delivery = effectiveDelivery(p, shipping);
    products.push({
      id: p.id,
      kind: p.kind,
      digitalType: p.digitalType,
      name: p.name,
      amount: p.amount,
      description: p.description,
      imageUrl: p.imageUrl,
      images: parseImages(p.images),
      give: giveText(p),
      withdrawalNotice: p.kind === 'DIGITAL' ? p.withdrawalNotice : null,
      documentName: p.kind === 'DOCUMENT' ? (p.documentTemplate?.name ?? null) : null,
      stock: p.stock,
      soldOut: p.kind === 'PHYSICAL' && p.stock !== null && p.stock <= 0,
      maxPerOrder: p.maxPerOrder,
      options: parseOptions(p.options),
      shippingFee: quote.fee,
      freeReason: quote.freeReason,
      freeShortfall: quote.freeShortfall,
      dispatchDays: delivery.dispatchDays,
      returnFee: delivery.returnFee,
      exchangeFee: delivery.exchangeFee,
      payable,
    });
  }

  return {
    ok: true,
    ctx: {
      linkId: link.id,
      chargeId: charge.id,
      merchantName: charge.merchant.displayName,
      message: charge.message,
      products,
      allowCustomAmount: charge.merchant.allowCustomAmount,
      minAmount,
      maxAmount,
      customMin,
      customMax,
      customStep,
      expiresAt: link.expiresAt,
      shipping,
    },
  };
}

export interface ConfirmAmountResult {
  ok: boolean;
  message: string;
  /** 결제사 PIN 입력 화면 주소 (성공했을 때만) */
  pinUrl?: string;
  expiresAt?: Date;
  /** 결제사 실연동이 아닌 mock 인지 */
  mock?: boolean;
}

/** 실물 상품 주문에 필요한 배송지 */
export interface ShippingAddressInput {
  receiver: string;
  phone: string;
  zipCode: string;
  address1: string;
  address2?: string;
  memo?: string;
  /** 도서산간 여부. 추가 배송비가 붙는다. */
  remote?: boolean;
}

/** 우편번호로 도서산간 여부를 판단한다(제주 63xxx, 울릉 40240 등 대표 구간). */
export function isRemoteZip(zip: string): boolean {
  const z = zip.replace(/[^\d]/g, '');
  if (z.length !== 5) return false;
  const n = Number(z);
  // 제주 63000~63644, 울릉 40200~40240, 백령 23004 등 통상적으로 도서산간으로 보는 구간.
  return (n >= 63000 && n <= 63644) || (n >= 40200 && n <= 40240) || n === 23004;
}

export async function confirmChargeAmount(input: {
  token: string;
  /** 상품을 고른 경우 */
  productId?: string | null;
  /** 직접 입력한 경우 (원) */
  customAmount?: bigint | null;
  /** 실물 상품 주문 수량 */
  quantity?: number | null;
  /** 실물 상품 옵션 선택값 { '사이즈': 'L' } */
  optionValues?: Record<string, string> | null;
  /** 실물 상품 배송지 */
  address?: ShippingAddressInput | null;
  ip?: string;
  userAgent?: string;
}): Promise<ConfirmAmountResult> {
  const loaded = await loadSelectAmountContext(input.token);
  if (!loaded.ok) return { ok: false, message: loaded.reason };
  const ctx = loaded.ctx;

  // ── 상품·수량·옵션·배송지 확정 ──────────────────────────────────
  let amount: bigint | null = null;
  let shippingFee = 0n;
  let quantity = 1;
  let optionText: string | null = null;
  let productId: string | null = null;
  let remote = false;
  let selected: ChargeProductOption | null = null;

  if (input.productId) {
    const product = ctx.products.find((p) => p.id === input.productId);
    if (!product) return { ok: false, message: '선택한 상품을 찾을 수 없습니다.' };
    if (!product.payable) return { ok: false, message: '이 상품은 결제 한도를 넘어 지금 구매할 수 없습니다.' };
    selected = product;
    productId = product.id;

    if (product.kind === 'PHYSICAL') {
      if (product.soldOut) return { ok: false, message: '품절된 상품입니다.' };

      quantity = Math.trunc(input.quantity ?? 1);
      if (!Number.isFinite(quantity) || quantity < 1) return { ok: false, message: '수량을 확인해 주세요.' };
      if (product.maxPerOrder !== null && quantity > product.maxPerOrder) {
        return { ok: false, message: `이 상품은 한 번에 최대 ${product.maxPerOrder}개까지 주문할 수 있습니다.` };
      }
      if (product.stock !== null && quantity > product.stock) {
        return { ok: false, message: `재고가 ${product.stock}개 남았습니다. 수량을 줄여 주세요.` };
      }

      const opt = buildOptionText(
        // 화면에 준 옵션 정의를 그대로 다시 쓴다(폼 조작 방지).
        product.options as unknown,
        input.optionValues ?? {},
      );
      if (!opt.ok) return { ok: false, message: opt.message };
      optionText = opt.text;

      const addr = input.address;
      if (!addr) return { ok: false, message: '배송지를 입력해 주세요.' };
      const receiver = addr.receiver.trim();
      const phone = normalizePhone(addr.phone ?? '');
      const zip = (addr.zipCode ?? '').replace(/[^\d]/g, '');
      const addr1 = addr.address1.trim();
      if (receiver.length < 2 || receiver.length > 30) return { ok: false, message: '받는 분 이름을 확인해 주세요.' };
      if (!/^01[016789]\d{7,8}$/.test(phone)) return { ok: false, message: '받는 분 연락처를 확인해 주세요.' };
      if (zip.length !== 5) return { ok: false, message: '우편번호 5자리를 입력해 주세요.' };
      if (addr1.length < 5 || addr1.length > 120) return { ok: false, message: '주소를 확인해 주세요.' };

      remote = addr.remote ?? isRemoteZip(zip);

      // 배송비는 화면과 서버가 같은 함수로 계산해야 금액 분쟁이 생기지 않는다.
      const row = await prisma.chargeProduct.findFirst({
        where: { id: product.id, merchantId: (await currentMerchantId(ctx.chargeId)) ?? '', active: true, archivedAt: null },
        select: { kind: true, amount: true, shippingFee: true, freeShipOver: true, freeShipping: true },
      });
      if (!row) return { ok: false, message: '선택한 상품을 찾을 수 없습니다.' };

      // 옵션 추가금도 화면 값을 믿지 않고 상품 정의로 다시 계산한다.
      const addPrice = optionAddPrice(product.options as unknown, input.optionValues ?? {});
      const quote = quoteShipping(row, quantity, ctx.shipping, remote, addPrice);
      amount = quote.total;
      shippingFee = quote.fee;
    } else {
      amount = product.amount;
    }
  } else if (input.customAmount != null) {
    if (!ctx.allowCustomAmount) {
      return { ok: false, message: '이 사회복지기관은 직접 입력을 받지 않습니다.' };
    }
    // 사회복지기관이 좁혀 둔 직접 입력 범위·단위를 화면 값과 무관하게 서버에서 다시 검사한다.
    if (input.customAmount < ctx.customMin || input.customAmount > ctx.customMax) {
      return {
        ok: false,
        message: `직접 입력 금액은 ${ctx.customMin.toString()}원 ~ ${ctx.customMax.toString()}원 사이여야 합니다.`,
      };
    }
    if (ctx.customStep !== null && input.customAmount % BigInt(ctx.customStep) !== 0n) {
      return {
        ok: false,
        message: `직접 입력 금액은 ${ctx.customStep.toLocaleString('ko-KR')}원 단위로 입력해 주세요.`,
      };
    }
    amount = input.customAmount;
  }

  if (amount === null) return { ok: false, message: '상품 또는 후원 금액을 선택해 주세요.' };
  if (amount < ctx.minAmount || amount > ctx.maxAmount) {
    return {
      ok: false,
      message:
        selected?.kind === 'PHYSICAL'
          ? `배송비를 포함한 결제 금액이 ${ctx.minAmount.toString()}원 ~ ${ctx.maxAmount.toString()}원 범위를 벗어났습니다. 수량을 줄여 주세요.`
          : `후원 금액은 ${ctx.minAmount.toString()}원 ~ ${ctx.maxAmount.toString()}원 사이여야 합니다.`,
    };
  }

  const charge = await prisma.charge.findUniqueOrThrow({
    where: { id: ctx.chargeId },
    select: { id: true, merchantId: true, payerId: true },
  });
  if (!charge.payerId) return { ok: false, message: '후원자 정보를 찾을 수 없습니다.' };

  const payer = await prisma.payerProfile.findUnique({ where: { id: charge.payerId } });
  if (!payer) return { ok: false, message: '후원자 정보를 찾을 수 없습니다.' };

  const blocked = await prisma.blockedPayer.findUnique({
    where: { merchantId_payerId: { merchantId: charge.merchantId, payerId: payer.id } },
  });
  const limit = await checkLimits({
    payer,
    merchantId: charge.merchantId,
    amount,
    blockedByMerchant: Boolean(blocked),
  });
  if (!limit.ok) {
    // 금액 범위 오류는 입력 실수라 이상거래로 기록하지 않는다.
    if (limit.code !== 'AMOUNT_RANGE') {
      await prisma.riskDetection.create({
        data: {
          id: newId(),
          payerId: payer.id,
          merchantId: charge.merchantId,
          chargeId: charge.id,
          type: limit.code === 'VELOCITY' || limit.code === 'COOLDOWN' ? 'VELOCITY' : 'DAILY_LIMIT',
          level: 'MEDIUM',
          detail: { code: limit.code, message: limit.message, channel: 'SELECT' } as object,
        },
      });
      await setStatus(charge.id, 'LIMIT_BLOCKED', `${limit.code}: ${limit.message}`);
      // 한도로 막힌 건은 링크를 태워 같은 링크로 다시 시도하지 못하게 한다.
      await consumeSecureLink(ctx.linkId, input.ip, input.userAgent);
    }
    return { ok: false, message: limit.message ?? '이용 한도를 초과했습니다.' };
  }

  // 링크 1회 사용 선점 — 여기부터는 되돌릴 수 없다.
  const consumed = await consumeSecureLink(ctx.linkId, input.ip, input.userAgent);
  if (!consumed) return { ok: false, message: '이미 처리된 요청입니다.' };

  // 금액 확정. PENDING_AMOUNT 일 때만 바뀌므로 동시 요청이 두 번 확정하지 못한다.
  //
  // pointStatus 는 여기서 정한다. 실물 주문과 문서 상품은 후원금·상품권을 주는 거래가
  // 아니므로 SKIPPED 로 둔다. 이걸 기본값(PENDING)으로 두면 그 주문이 "지급 대기" 목록과
  // 연동 API 의 pending 응답에 섞여 들어가 사회복지기관이 후원금를 또 준다.
  const claimed = await prisma.charge.updateMany({
    where: { id: charge.id, status: 'PENDING_AMOUNT' },
    data: {
      amount,
      status: 'RECEIVED',
      statusReason: null,
      productId,
      quantity,
      optionText,
      shippingFee,
      pointStatus: selected && selected.kind !== 'DIGITAL' ? 'SKIPPED' : 'PENDING',
    },
  });
  if (claimed.count === 0) return { ok: false, message: '이미 처리된 결제입니다.' };

  // 배송지는 결제 건과 1:1 로 붙인다. 원문은 암호화하고 화면에는 마스킹만 남긴다.
  if (selected?.kind === 'PHYSICAL' && input.address) {
    const addr = input.address;
    const phone = normalizePhone(addr.phone);
    const full = `${addr.address1.trim()}${addr.address2?.trim() ? ` ${addr.address2.trim()}` : ''}`;
    await prisma.chargeShipment.upsert({
      where: { chargeId: charge.id },
      create: {
        id: newId(),
        chargeId: charge.id,
        merchantId: charge.merchantId,
        receiverEnc: encrypt(addr.receiver.trim()),
        receiverMasked: maskName(addr.receiver.trim()),
        phoneEnc: encrypt(phone),
        phoneMasked: maskPhone(phone),
        zipCode: addr.zipCode.replace(/[^\d]/g, ''),
        addressEnc: encrypt(full),
        addressMasked: maskAddress(full),
        memo: addr.memo?.slice(0, 100) || null,
        remote,
      },
      update: {},
    });
  }

  await prisma.chargeStatusLog.create({
    data: {
      id: newId(),
      chargeId: charge.id,
      fromStatus: 'PENDING_AMOUNT',
      toStatus: 'RECEIVED',
      reason:
        selected?.kind === 'PHYSICAL'
          ? `${selected.name} ${quantity}개 주문 확정 ${amount.toString()}원 (배송비 ${shippingFee.toString()}원)`
          : `결제 금액 확정 ${amount.toString()}원`,
      actor: 'payer',
    },
  });

  // 문자를 한 번 더 보내지 않고, 이 화면에서 결제사 PIN 입력으로 그대로 넘어간다.
  // 여기까지 오면 1회용 링크는 이미 소진됐다(위 consumeSecureLink).
  // PIN 발급이 실패하면 같은 링크로는 다시 시도할 수 없으므로,
  // 후원자가 다음에 무엇을 해야 하는지 반드시 알려 준다.
  const pin = await startPinAuthorization(charge.id, { notify: false });
  if (!pin.ok || !pin.pinUrl) {
    const guide = '이 링크는 1회용이라 다시 쓸 수 없습니다. 사회복지기관 번호로 문자를 다시 보내 주세요.';
    const base = pin.message ?? 'PIN 인증창을 생성하지 못했습니다.';
    return { ok: false, message: base.includes('문자를 다시') ? base : `${base} ${guide}` };
  }

  return {
    ok: true,
    message: pin.message,
    pinUrl: pin.pinUrl,
    expiresAt: pin.expiresAt,
    mock: pin.mock,
  };
}

/** 결제 건의 사회복지기관 ID. 상품이 정말 그 사회복지기관 것인지 다시 확인할 때 쓴다. */
async function currentMerchantId(chargeId: string): Promise<string | null> {
  const row = await prisma.charge.findUnique({ where: { id: chargeId }, select: { merchantId: true } });
  return row?.merchantId ?? null;
}

/**
 * 주소 마스킹. 목록 화면에는 이 값만 쓴다.
 * 시/도 + 시/군/구까지만 남기고 나머지는 가린다.
 */
export function maskAddress(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length <= 2) return `${parts[0] ?? ''} ***`.trim();
  return `${parts[0]} ${parts[1]} ***`;
}
