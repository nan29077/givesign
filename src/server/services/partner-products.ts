import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import type { ChargeProduct, Prisma } from '@/generated/prisma/client';
import type { DigitalProductType, FulfillmentMode, ProductKind } from '@/generated/prisma/enums';
import {
  PRODUCT_LIMIT_PER_KIND, PRODUCT_NAME_MAX, amountRangeError, effectiveAmountRange, goodsKindError,
} from '@/server/services/product-rules';

/**
 * 사회복지기관 상품 동기화 API 의 검증·직렬화.
 *
 * 왜 있는가 — 지금까지 사회복지기관은 자기 사이트에 있는 상품을 기브싸인 콘솔에 한 번 더
 * 손으로 등록해야 했다. 파는 물건이 바뀔 때마다 두 곳을 맞춰야 하니 반드시 어긋난다.
 *
 * 규칙
 *  - 상품은 지난 결제가 참조하므로 삭제하지 않고 보관 처리(archive)한다.
 *  - 재고는 결제 승인 시점에 상품 단위 잠금 안에서 차감된다. 여기서는 값만 바꾼다.
 *  - 기관 콘솔과 같은 규칙을 쓴다(`product-rules.ts`): FEATURE_GOODS 가 꺼지면 DIGITAL 만,
 *    금액은 1원 이상 + 기관 범위 ∩ 한도 정책, 종류별 상한 PRODUCT_LIMIT_PER_KIND,
 *    보관되지 않은 항목끼리 이름 중복 금지, 등록 후 종류 변경 금지, 보관된 항목은 수정 불가.
 */

/** 종류별 상한. 콘솔(MAX_CHARGE_PRODUCTS)과 같은 값이다. */
export const PRODUCT_MAX = PRODUCT_LIMIT_PER_KIND;

export interface ProductInput {
  kind?: string;
  digitalType?: string | null;
  name?: string;
  amount?: number | string;
  sku?: string | null;
  description?: string | null;
  stock?: number | null;
  active?: boolean;
  sortOrder?: number;
  fulfillment?: string | null;
  fulfillmentNote?: string | null;
  giveAmount?: number | string | null;
  giveUnit?: string | null;
  validDays?: number | null;
}

const KINDS = ['DIGITAL', 'PHYSICAL'];
const DIGITAL_TYPES = ['POINT', 'VOUCHER', 'PASS', 'CONTENT'];
const FULFILLMENTS = ['MANUAL', 'API', 'INSTANT'];

export function serializeProduct(p: ChargeProduct) {
  return {
    id: p.id,
    kind: p.kind,
    digitalType: p.digitalType,
    name: p.name,
    amount: Number(p.amount),
    sku: p.sku,
    description: p.description,
    stock: p.stock,
    active: p.active,
    archived: p.archivedAt !== null,
    sortOrder: p.sortOrder,
    fulfillment: p.fulfillment,
    giveAmount: p.giveAmount != null ? Number(p.giveAmount) : null,
    giveUnit: p.giveUnit,
    validDays: p.validDays,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** 입력 검증. 통과하면 Prisma 에 그대로 넘길 수 있는 값만 남는다. */
export function validateProduct(
  input: ProductInput,
  { partial }: { partial: boolean },
): { ok: false; message: string } | { ok: true; data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};

  if (input.kind !== undefined) {
    const kind = String(input.kind).toUpperCase();
    if (!KINDS.includes(kind)) return { ok: false, message: 'kind 는 DIGITAL 또는 PHYSICAL 이어야 합니다.' };
    const kindErr = goodsKindError(kind);
    if (kindErr) return { ok: false, message: kindErr };
    data.kind = kind as ProductKind;
  } else if (!partial) {
    data.kind = 'DIGITAL' as ProductKind;
  }

  if (input.digitalType !== undefined) {
    if (input.digitalType === null) data.digitalType = null;
    else {
      const t = String(input.digitalType).toUpperCase();
      if (!DIGITAL_TYPES.includes(t)) {
        return { ok: false, message: `digitalType 은 ${DIGITAL_TYPES.join(' / ')} 중 하나여야 합니다.` };
      }
      data.digitalType = t as DigitalProductType;
    }
  }

  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) return { ok: false, message: 'name 이 필요합니다.' };
    data.name = name.slice(0, PRODUCT_NAME_MAX);
  } else if (!partial) {
    return { ok: false, message: 'name 이 필요합니다.' };
  }

  if (input.amount !== undefined) {
    const amount = Number(input.amount);
    // 0원 항목은 결제할 수 없다(콘솔도 1원 이상만 받는다).
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return { ok: false, message: 'amount 는 1 이상의 정수(원)여야 합니다.' };
    }
    data.amount = BigInt(amount);
  } else if (!partial) {
    return { ok: false, message: 'amount 가 필요합니다.' };
  }

  if (input.sku !== undefined) data.sku = input.sku === null ? null : String(input.sku).slice(0, 40);
  if (input.description !== undefined) {
    data.description = input.description === null ? null : String(input.description).slice(0, 500);
  }
  if (input.stock !== undefined) {
    if (input.stock === null) data.stock = null;
    else {
      const stock = Number(input.stock);
      if (!Number.isInteger(stock) || stock < 0) return { ok: false, message: 'stock 은 0 이상의 정수이거나 null 이어야 합니다.' };
      data.stock = stock;
    }
  }
  if (input.active !== undefined) data.active = Boolean(input.active);
  if (input.sortOrder !== undefined) {
    const order = Number(input.sortOrder);
    if (!Number.isInteger(order)) return { ok: false, message: 'sortOrder 는 정수여야 합니다.' };
    data.sortOrder = order;
  }
  if (input.fulfillment !== undefined && input.fulfillment !== null) {
    const f = String(input.fulfillment).toUpperCase();
    if (!FULFILLMENTS.includes(f)) return { ok: false, message: `fulfillment 는 ${FULFILLMENTS.join(' / ')} 중 하나여야 합니다.` };
    data.fulfillment = f as FulfillmentMode;
  }
  if (input.fulfillmentNote !== undefined) {
    data.fulfillmentNote = input.fulfillmentNote === null ? null : String(input.fulfillmentNote).slice(0, 300);
  }
  if (input.giveAmount !== undefined) {
    if (input.giveAmount === null) data.giveAmount = null;
    else {
      const give = Number(input.giveAmount);
      if (!Number.isInteger(give) || give < 0) return { ok: false, message: 'giveAmount 는 0 이상의 정수이거나 null 이어야 합니다.' };
      data.giveAmount = BigInt(give);
    }
  }
  if (input.giveUnit !== undefined) data.giveUnit = input.giveUnit === null ? null : String(input.giveUnit).slice(0, 10);
  if (input.validDays !== undefined) {
    if (input.validDays === null) data.validDays = null;
    else {
      const days = Number(input.validDays);
      if (!Number.isInteger(days) || days <= 0) return { ok: false, message: 'validDays 는 1 이상의 정수이거나 null 이어야 합니다.' };
      data.validDays = days;
    }
  }

  return { ok: true, data };
}

type ExistingRow = Pick<ChargeProduct, 'id' | 'kind' | 'archivedAt'>;

/**
 * 검증된 값이 기존 행(있으면)과 합쳐졌을 때 콘솔 규칙을 지키는지 본다.
 * - 종류 변경 금지(과거 주문의 배송 유무가 뒤집힌다)
 * - 기존 행이 DIGITAL 이 아니면 기능이 꺼진 동안 수정 불가
 * - 금액 범위(콘솔과 같은 함수)
 */
function checkAgainstRules(
  data: Record<string, unknown>,
  found: ExistingRow | undefined,
  range: { min: bigint; max: bigint } | null,
): string | null {
  if (found) {
    if (data.kind !== undefined && data.kind !== found.kind) {
      return 'kind 는 등록 후 바꿀 수 없습니다. 새 상품으로 등록해 주세요.';
    }
    const kindErr = goodsKindError(found.kind);
    if (kindErr) return kindErr;
    // 종류는 저장된 값으로 고정한다.
    delete data.kind;
  }
  const kind = String(data.kind ?? found?.kind ?? 'DIGITAL');
  if (data.amount !== undefined) {
    const err = amountRangeError(data.amount as bigint, range, kind);
    if (err) return err;
  }
  return null;
}

/** 같은 이름의 사용 중(보관 안 됨) 항목이 있는지. */
async function nameTaken(merchantId: string, name: string, exceptId?: string) {
  const dup = await prisma.chargeProduct.findFirst({
    where: { merchantId, name, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return Boolean(dup);
}

function isUniqueViolation(e: unknown) {
  return (e as { code?: string }).code === 'P2002';
}

/** 상품 1건 생성. 종류별 상한을 넘으면 거절한다. */
export async function createPartnerProduct(merchantId: string, input: ProductInput) {
  const checked = validateProduct(input, { partial: false });
  if (!checked.ok) return { ok: false as const, message: checked.message };

  const rule = checkAgainstRules(checked.data, undefined, await effectiveAmountRange(merchantId));
  if (rule) return { ok: false as const, message: rule };

  const kind = checked.data.kind as ProductKind;
  const count = await prisma.chargeProduct.count({ where: { merchantId, kind, archivedAt: null } });
  if (count >= PRODUCT_MAX) {
    return { ok: false as const, message: `상품은 종류별로 ${PRODUCT_MAX}개까지 등록할 수 있습니다.` };
  }
  if (await nameTaken(merchantId, String(checked.data.name))) {
    return { ok: false as const, message: '같은 이름의 상품이 이미 있습니다.' };
  }

  try {
    // 검증을 통과한 값만 담겨 있으므로 여기서 한 번만 Prisma 입력 타입으로 좁힌다.
    const row = await prisma.chargeProduct.create({
      data: { id: newId(), merchantId, sortOrder: count, ...checked.data } as Prisma.ChargeProductUncheckedCreateInput,
    });
    return { ok: true as const, product: row };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false as const, message: '같은 이름 또는 sku 의 상품이 이미 있습니다.' };
    throw e;
  }
}

/**
 * 상품 1건 수정 (PATCH).
 * 보관된 상품은 고치지 않는다 — 되살리려면 일괄 동기화로 다시 보내거나 콘솔에서 복원한다.
 */
export async function updatePartnerProduct(merchantId: string, id: string, input: ProductInput) {
  const found = await prisma.chargeProduct.findFirst({
    where: { id, merchantId },
    select: { id: true, kind: true, name: true, amount: true, archivedAt: true },
  });
  if (!found) return { ok: false as const, status: 404, code: 'NOT_FOUND', message: '해당 상품을 찾을 수 없습니다.' };
  if (found.archivedAt) {
    return { ok: false as const, status: 409, code: 'ARCHIVED', message: '보관(판매 중지)된 상품은 수정할 수 없습니다.' };
  }

  const checked = validateProduct(input, { partial: true });
  if (!checked.ok) return { ok: false as const, status: 400, code: 'INVALID_PRODUCT', message: checked.message };
  const rule = checkAgainstRules(checked.data, found, await effectiveAmountRange(merchantId));
  if (rule) return { ok: false as const, status: 400, code: 'INVALID_PRODUCT', message: rule };
  if (checked.data.name !== undefined && (await nameTaken(merchantId, String(checked.data.name), id))) {
    return { ok: false as const, status: 400, code: 'INVALID_PRODUCT', message: '같은 이름의 상품이 이미 있습니다.' };
  }

  try {
    const row = await prisma.chargeProduct.update({
      where: { id },
      data: checked.data as Prisma.ChargeProductUncheckedUpdateInput,
    });
    return { ok: true as const, product: row };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { ok: false as const, status: 400, code: 'INVALID_PRODUCT', message: '같은 이름 또는 sku 의 상품이 이미 있습니다.' };
    }
    throw e;
  }
}

/**
 * 일괄 동기화.
 *
 * sku 를 열쇠로 삼는다. 이미 있는 sku 는 내용을 맞추고, 없는 sku 는 새로 만든다.
 * `archiveMissing` 이 true 면 목록에 없는 상품을 보관 처리한다 — 기관 사이트에서
 * 내린 상품이 기브싸인에는 계속 팔리는 상태로 남는 것을 막기 위한 것이다.
 * 반영 뒤 종류별 사용 중 개수가 상한을 넘거나 이름이 겹치면 전부 되돌린다.
 */
export async function syncPartnerProducts(
  merchantId: string,
  items: (ProductInput & { sku?: string | null })[],
  archiveMissing: boolean,
) {
  const withSku = items.filter((i) => i.sku && String(i.sku).trim());
  if (withSku.length !== items.length) {
    return { ok: false as const, message: '일괄 동기화에는 모든 상품에 sku 가 필요합니다. sku 로 기존 상품과 맞춥니다.' };
  }

  const skus = withSku.map((i) => String(i.sku).trim());
  if (new Set(skus).size !== skus.length) {
    return { ok: false as const, message: '같은 sku 가 두 번 들어 있습니다.' };
  }

  const existing = await prisma.chargeProduct.findMany({ where: { merchantId, sku: { in: skus } } });
  const bySku = new Map(existing.map((p) => [p.sku!, p]));
  const range = await effectiveAmountRange(merchantId);

  // 쓰기를 시작하기 전에 전부 검사한다.
  // 100건 중 50번째에서 형식 오류가 나면 앞 49건만 반영된 채 400 이 돌아가고,
  // 기관은 어디까지 반영됐는지 모른 채 같은 요청을 다시 보낸다.
  const plan: { sku: string; found: (typeof existing)[number] | undefined; data: Record<string, unknown> }[] = [];
  for (const item of withSku) {
    const sku = String(item.sku).trim();
    const found = bySku.get(sku);
    const checked = validateProduct(item, { partial: Boolean(found) });
    if (!checked.ok) return { ok: false as const, message: `${sku}: ${checked.message}` };
    const rule = checkAgainstRules(checked.data, found, range);
    if (rule) return { ok: false as const, message: `${sku}: ${rule}` };
    plan.push({ sku, found, data: checked.data as Record<string, unknown> });
  }

  class RuleError extends Error {}

  // 반영은 한 트랜잭션에서. 도중에 실패하면 아무것도 바뀌지 않은 상태로 되돌아간다.
  try {
    return await prisma.$transaction(async (tx) => {
      let created = 0;
      let updated = 0;
      for (const row of plan) {
        if (row.found) {
          await tx.chargeProduct.update({
            where: { id: row.found.id },
            // 되살리기: 보관 처리됐던 상품이 목록에 다시 오면 판매 상태로 돌린다.
            data: { ...row.data, archivedAt: null } as Prisma.ChargeProductUncheckedUpdateInput,
          });
          updated += 1;
        } else {
          await tx.chargeProduct.create({
            data: { id: newId(), merchantId, sku: row.sku, ...row.data } as Prisma.ChargeProductUncheckedCreateInput,
          });
          created += 1;
        }
      }

      let archived = 0;
      if (archiveMissing) {
        const result = await tx.chargeProduct.updateMany({
          where: { merchantId, archivedAt: null, sku: { notIn: skus } },
          data: { archivedAt: new Date(), active: false },
        });
        archived = result.count;
      }

      // 반영 결과가 콘솔 상한을 넘으면 전부 되돌린다.
      const perKind = await tx.chargeProduct.groupBy({
        by: ['kind'],
        where: { merchantId, archivedAt: null },
        _count: { _all: true },
      });
      const over = perKind.find((k) => k._count._all > PRODUCT_MAX);
      if (over) {
        throw new RuleError(`반영하면 ${over.kind} 상품이 ${over._count._all}개가 됩니다. 종류별로 ${PRODUCT_MAX}개까지 쓸 수 있습니다.`);
      }

      return { ok: true as const, created, updated, archived };
    });
  } catch (e) {
    if (e instanceof RuleError) return { ok: false as const, message: e.message };
    // (merchantId, sku) 또는 사용 중 이름 유니크 위반 — 같은 요청이 동시에 두 번 들어왔거나
    // 보낸 이름이 다른 사용 중 상품과 겹친 경우다.
    if (isUniqueViolation(e)) {
      return {
        ok: false as const,
        message: '같은 sku 로 동시에 처리 중인 요청이 있거나, 같은 이름의 사용 중 상품이 있습니다. 이름을 확인한 뒤 다시 보내 주세요.',
      };
    }
    throw e;
  }
}
