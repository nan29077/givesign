import { prisma } from '@/server/db';
import { featureGoodsEnabled } from '@/lib/env';
import { formatWon } from '@/lib/money';
import { resolvePolicy } from '@/server/services/limits';
import { MAX_CHARGE_PRODUCTS } from '@/components/studio/shared';

/**
 * 후원 항목(상품) 공통 규칙.
 *
 * 기관 콘솔(서버 액션)과 파트너 API 가 같은 규칙을 보도록 한 곳에 둔다.
 * 두 경로가 각각 검사하면 한쪽이 느슨해져 다른 쪽 제한을 우회하는 통로가 된다
 * (2026-11-05 점검 E H-10).
 */

/** 기관 1곳이 종류별로 쓸 수 있는(보관되지 않은) 항목 수 상한. 콘솔·API 공통. */
export const PRODUCT_LIMIT_PER_KIND = MAX_CHARGE_PRODUCTS;

/** 항목 이름 최대 길이. 콘솔·API 공통. */
export const PRODUCT_NAME_MAX = 40;

/**
 * 기관이 고를 수 있는 유효 금액 범위.
 * 관리자 지정 기관 범위 ∩ 한도 정책 범위 — 여기를 벗어난 금액은 결제 접수 시 AMOUNT_RANGE 로
 * 전부 실패하므로, 항목을 만드는 단계에서 미리 막는다.
 */
export async function effectiveAmountRange(merchantId: string): Promise<{ min: bigint; max: bigint } | null> {
  const [merchant, policy] = await Promise.all([
    prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { minAmount: true, maxAmount: true },
    }),
    resolvePolicy(merchantId, null),
  ]);
  if (!merchant) return null;
  const min = merchant.minAmount > policy.minAmount ? merchant.minAmount : policy.minAmount;
  const max = merchant.maxAmount < policy.maxAmount ? merchant.maxAmount : policy.maxAmount;
  return { min, max };
}

/** 금액 검사. 0원 이하·범위 밖이면 안내문을 돌려준다. 통과하면 null. */
export function amountRangeError(
  amount: bigint,
  range: { min: bigint; max: bigint } | null,
  kind: string = 'DIGITAL',
): string | null {
  if (amount <= 0n) return '금액은 1원 이상이어야 합니다.';
  if (!range) return '기관 정보를 찾을 수 없습니다.';
  if (range.min > range.max) {
    return '관리자 설정과 한도 정책이 충돌해 만들 수 있는 금액이 없습니다. 고객센터로 문의해 주세요.';
  }
  if (amount < range.min || amount > range.max) {
    return kind === 'PHYSICAL'
      ? `실물 상품 가격은 ${formatWon(range.min)} ~ ${formatWon(range.max)} 사이여야 합니다. (결제 시 배송비가 더해지므로 한도를 꽉 채우지 마세요)`
      : `금액은 ${formatWon(range.min)} ~ ${formatWon(range.max)} 사이여야 합니다.`;
  }
  return null;
}

/**
 * 실물·문서 상품 기능이 꺼져 있으면 DIGITAL(후원 항목) 외 종류를 다룰 수 없다.
 * 생성뿐 아니라 복제·복원·수정·노출 전환에도 같은 판단을 쓴다.
 */
export function goodsKindError(kind: string): string | null {
  if (kind === 'DIGITAL' || featureGoodsEnabled()) return null;
  return '실물·문서 상품 기능이 꺼져 있습니다. 후원 항목만 다룰 수 있습니다.';
}
