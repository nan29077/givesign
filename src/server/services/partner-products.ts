import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import type { ChargeProduct, Prisma } from '@/generated/prisma/client';
import type { DigitalProductType, FulfillmentMode, ProductKind } from '@/generated/prisma/enums';

/**
 * 사회복지기관 상품 동기화 API 의 검증·직렬화.
 *
 * 왜 있는가 — 지금까지 사회복지기관은 자기 사이트에 있는 상품을 기브싸인 콘솔에 한 번 더
 * 손으로 등록해야 했다. 파는 물건이 바뀔 때마다 두 곳을 맞춰야 하니 반드시 어긋난다.
 *
 * 규칙
 *  - 상품은 지난 결제가 참조하므로 삭제하지 않고 보관 처리(archive)한다.
 *  - 재고는 결제 승인 시점에 상품 단위 잠금 안에서 차감된다. 여기서는 값만 바꾼다.
 */

export const PRODUCT_MAX = 200;

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
    data.name = name.slice(0, 60);
  } else if (!partial) {
    return { ok: false, message: 'name 이 필요합니다.' };
  }

  if (input.amount !== undefined) {
    const amount = Number(input.amount);
    if (!Number.isInteger(amount) || amount < 0) {
      return { ok: false, message: 'amount 는 0 이상의 정수(원)여야 합니다.' };
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

/** 상품 1건 생성. 개수 상한을 넘으면 거절한다. */
export async function createPartnerProduct(merchantId: string, input: ProductInput) {
  const count = await prisma.chargeProduct.count({ where: { merchantId, archivedAt: null } });
  if (count >= PRODUCT_MAX) {
    return { ok: false as const, message: `상품은 ${PRODUCT_MAX}개까지 등록할 수 있습니다.` };
  }
  const checked = validateProduct(input, { partial: false });
  if (!checked.ok) return { ok: false as const, message: checked.message };

  // 검증을 통과한 값만 담겨 있으므로 여기서 한 번만 Prisma 입력 타입으로 좁힌다.
  const row = await prisma.chargeProduct.create({
    data: { id: newId(), merchantId, ...checked.data } as Prisma.ChargeProductUncheckedCreateInput,
  });
  return { ok: true as const, product: row };
}

/**
 * 일괄 동기화.
 *
 * sku 를 열쇠로 삼는다. 이미 있는 sku 는 내용을 맞추고, 없는 sku 는 새로 만든다.
 * `archiveMissing` 이 true 면 목록에 없는 상품을 보관 처리한다 — 사회복지기관 사이트에서
 * 내린 상품이 기브싸인에는 계속 팔리는 상태로 남는 것을 막기 위한 것이다.
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

  // 쓰기를 시작하기 전에 전부 검사한다.
  // 100건 중 50번째에서 형식 오류가 나면 앞 49건만 반영된 채 400 이 돌아가고,
  // 사회복지기관은 어디까지 반영됐는지 모른 채 같은 요청을 다시 보낸다.
  const plan: { sku: string; found: (typeof existing)[number] | undefined; data: Record<string, unknown> }[] = [];
  for (const item of withSku) {
    const sku = String(item.sku).trim();
    const found = bySku.get(sku);
    const checked = validateProduct(item, { partial: Boolean(found) });
    if (!checked.ok) return { ok: false as const, message: `${sku}: ${checked.message}` };
    plan.push({ sku, found, data: checked.data as Record<string, unknown> });
  }

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

      return { ok: true as const, created, updated, archived };
    });
  } catch (e) {
    // (merchantId, sku) 유니크 위반 — 같은 요청이 동시에 두 번 들어와 둘 다 "없음" 으로
    // 판단한 경우다. 재시도하면 뒤 요청은 갱신 경로를 타므로 그대로 다시 보내면 된다.
    if ((e as { code?: string }).code === 'P2002') {
      return {
        ok: false as const,
        message: '같은 sku 로 동시에 처리 중인 요청이 있습니다. 잠시 후 다시 보내 주세요.',
      };
    }
    throw e;
  }
}
