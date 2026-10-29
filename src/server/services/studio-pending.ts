import { cache } from 'react';
import { prisma } from '@/server/db';
import { featureGoodsEnabled } from '@/lib/env';
import { PAID_STATUSES } from '@/components/studio/shared';

/**
 * 사회복지기관 콘솔의 "밀린 일" 집계.
 *
 * 사이드바 배지(layout)와 대시보드(page)가 같은 집계를 각각 돌려, 대시보드 한 번 렌더에
 * 같은 쿼리가 두 번씩 나갔다. 두 화면 모두 force-dynamic 이라 캐시도 없다.
 * react 의 `cache` 로 묶어 요청 단위에 한 번만 실행한다.
 *
 * 조건을 한 곳에 모으는 것도 목적이다. 예전에는 대시보드만 비실물 조건이
 * `product.kind = DIGITAL` 단독이라 직접 입력 결제를 세지 않아, 사이드바 배지와 수치가 달랐다.
 */
export const getStudioPendingCounts = cache(async (merchantId: string) => {
  const [orders, points, reports, documents] = await Promise.all([
    prisma.chargeShipment.count({
      where: { merchantId, status: 'PREPARING', charge: { status: { in: PAID_STATUSES } } },
    }),
    // 지급 대기는 상품 기능을 켠 기관에만 있다. 기본 설정에서는 세지 않는다(점검 M-17).
    !featureGoodsEnabled() ? Promise.resolve(0) : prisma.charge.count({
      where: {
        merchantId,
        status: { in: PAID_STATUSES },
        pointStatus: 'PENDING',
        // 직접 입력 결제(상품 없음)도 지급 대상이다. 실물만 SKIPPED 로 빠진다.
        OR: [{ product: { kind: 'DIGITAL' } }, { productId: null }],
      },
    }),
    prisma.report.count({ where: { merchantId, status: 'OPEN' } }),
    // 제출됐지만 아직 확인하지 않은 문서. 작성 대기(DRAFT)는 후원자 차례라 세지 않는다.
    prisma.documentSubmission.count({ where: { merchantId, status: 'SUBMITTED' } }),
  ]);

  return { orders, points, reports, documents };
});
