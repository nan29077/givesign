import { featureGoodsEnabled } from '@/lib/env';
import type { DeliveryStatus, ProductKind } from '@/generated/prisma/enums';

/**
 * 후원 건의 처리 상태(pointStatus) 초깃값.
 *
 * 메시지페이에서 물려받은 "결제 후 가맹점이 포인트를 지급한다" 상태 기계다. 기브싸인의 후원에는
 * 기관이 따로 지급할 것이 없으므로 기본은 SKIPPED(처리할 것 없음)다. 이걸 PENDING 으로 두면
 * 모든 후원이 "지급 대기"로 쌓이고 후원자에게 "기관이 지급한다"는 사실과 다른 안내가 나간다.
 *
 * FEATURE_GOODS=true 로 상품 기능을 다시 켠 경우에만 예전 규칙을 따른다:
 * 디지털(지급형) 항목은 PENDING, 실물·문서 항목은 배송·문서 흐름이 따로 있으므로 SKIPPED.
 */
export function initialPointStatus(kind?: ProductKind | null): DeliveryStatus {
  if (!featureGoodsEnabled()) return 'SKIPPED';
  return kind && kind !== 'DIGITAL' ? 'SKIPPED' : 'PENDING';
}
