import { prisma } from '@/server/db';
import { isLiveBazaarEnabled } from './bazaar-settings';
import { expireMatches, productSalesSummary } from './bazaar';

/**
 * 라이브 바자회 조회 전용 모음(화면용). 변경은 bazaar.ts 가 맡는다.
 */

/** 기관 콘솔 메뉴 뱃지. 스위치가 꺼져 있으면 null(메뉴를 그리지 않는다). */
export async function studioBazaarPending(merchantId: string): Promise<number | null> {
  if (!(await isLiveBazaarEnabled())) return null;
  const now = new Date();
  const [matches, valuating, inspected, lives] = await Promise.all([
    prisma.inKindMatch.count({ where: { merchantId, status: 'PROPOSED', deadline: { gte: now } } }),
    prisma.inKindDonation.count({ where: { merchantId, status: 'VALUATING' } }),
    prisma.inKindDonation.count({ where: { merchantId, status: 'INSPECTED' } }),
    prisma.bazaarLive.count({ where: { merchantId, status: 'PROPOSED' } }),
  ]);
  return matches + valuating + inspected + lives;
}

/** 기관 판매·정산 요약 */
export async function merchantSalesOverview(merchantId: string) {
  const products = await prisma.bazaarProduct.findMany({
    where: { merchantId },
    orderBy: { trackingCode: 'desc' },
    include: { donation: { select: { donationNo: true, title: true } } },
    take: 300,
  });
  const sums = await productSalesSummary(products.map((p) => p.id));
  const settlements = await prisma.bazaarSettlement.findMany({ where: { merchantId }, orderBy: { month: 'desc' }, take: 24 });
  return { products, sums, settlements };
}

/** 관리자 대시보드 숫자 */
export async function adminBazaarCounts() {
  // 만료는 배치(/api/cron/bazaar)가 맡는다. 화면에서도 한 번 더 돌려 바로 보이게 한다.
  await expireMatches().catch(() => 0);
  const [submitted, proposed, valuating, waitingInbound, inspected, draftProducts, listed, draftBatches, unpaid, applied] = await Promise.all([
    prisma.inKindDonation.count({ where: { status: 'SUBMITTED' } }),
    prisma.inKindDonation.count({ where: { status: 'MATCH_PROPOSED' } }),
    prisma.inKindDonation.count({ where: { status: { in: ['VALUATING', 'VALUE_CONFIRMED'] } } }),
    prisma.inKindDonation.count({ where: { status: 'PLEDGED' } }),
    prisma.inKindDonation.count({ where: { status: 'INSPECTED' } }),
    prisma.bazaarProduct.count({ where: { status: 'DRAFT' } }),
    prisma.bazaarProduct.count({ where: { status: 'LISTED' } }),
    prisma.bazaarSaleBatch.count({ where: { status: 'DRAFT' } }),
    prisma.bazaarSettlement.count({ where: { status: { in: ['DRAFT', 'CONFIRMED'] }, payout: { gt: 0 } } }),
    prisma.merchantBazaar.count({ where: { status: 'APPLIED' } }),
  ]);
  return { submitted, proposed, valuating, waitingInbound, inspected, draftProducts, listed, draftBatches, unpaid, applied };
}

/**
 * 사이트 설정 화면의 미지급 정산 요약(스위치와 무관하게 보여 준다).
 * 지급할 돈이 있는 것(지급액 > 0)만 센다. 0원 이하는 확정 때 이월(CARRIED)되며, 예전에 확정만 된 건은 따로 센다.
 */
export async function unpaidSettlementSummary() {
  const rows = await prisma.bazaarSettlement.findMany({ where: { status: { in: ['DRAFT', 'CONFIRMED'] } }, select: { payout: true, status: true } });
  const payable = rows.filter((r) => r.payout > 0n);
  return {
    count: payable.length,
    confirmed: payable.filter((r) => r.status === 'CONFIRMED').length,
    total: payable.reduce((s, r) => s + r.payout, 0n),
    toCarry: rows.filter((r) => r.payout <= 0n).length,
  };
}

/** 메인·소개 페이지용 공개 정보: 다가오는 방송(승인된 편성만), 참여 기관 수, 지급 완료 귀속액 */
export async function publicBazaarInfo() {
  const [lives, merchants, paid] = await Promise.all([
    prisma.bazaarLive.findMany({
      where: { status: 'APPROVED', scheduledAt: { gte: new Date(Date.now() - 3 * 3600_000) } },
      orderBy: { scheduledAt: 'asc' },
      take: 3,
      select: { id: true, title: true, scheduledAt: true, broadcastUrl: true, merchantId: true },
    }),
    prisma.merchantBazaar.count({ where: { status: 'APPROVED' } }),
    prisma.bazaarSettlement.aggregate({ where: { status: 'PAID' }, _sum: { payout: true } }),
  ]);
  const orgs = await prisma.merchantProfile.findMany({ where: { id: { in: lives.map((l) => l.merchantId) } }, select: { id: true, displayName: true } });
  const nameOf = new Map(orgs.map((o) => [o.id, o.displayName]));
  return {
    lives: lives.map((l) => ({ ...l, merchantName: nameOf.get(l.merchantId) ?? '' })),
    merchants,
    paidTotal: paid._sum.payout ?? 0n,
  };
}
