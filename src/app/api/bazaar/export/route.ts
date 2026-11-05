import { getSessionUser, writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { getBazaarConfig, isLiveBazaarEnabled } from '@/server/services/bazaar-settings';
import { toCsv, donorTypeLabel, donationStatusLabel, formatBizNo, unsoldActionLabel, type DonorType, type DonationStatus } from '@/lib/bazaar';
import { formatKst } from '@/lib/datetime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 라이브 바자회 CSV 내려받기.
 *  - kind=sellerbricks : 셀러브릭스 등록 정보(관리자) — 등록 대기 상품
 *  - kind=givers       : 기부자 대장(관리자)
 *  - kind=ledger       : 현물 기부 대장(기관 = 자기 기관만, 관리자 = merchantId 지정)
 *  - kind=sale-template: 판매 결과 업로드 양식(관리자)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') ?? '';
  const user = await getSessionUser().catch(() => null);
  const nf = () => new Response('Not Found', { status: 404 });
  if (!user || !(await isLiveBazaarEnabled())) return nf();
  const isAdmin = user.role === 'ADMIN';
  // 개인정보·대량 반출 파일(기부자 대장·셀러브릭스 등록 정보·전 기관 대장)은 금전·쓰기 권한 화이트리스트만(점검 B-M8).
  // 읽기 전용(READ_ONLY)·고객지원(SUPPORT)·권한 미지정 관리자는 받지 못한다. actions/admin/shared.ts MONEY_PERMISSIONS 와 같다.
  const exportAdmin = isAdmin && ['SUPER_ADMIN', 'OPERATION', 'FINANCE'].includes(String(user.adminPermission));
  const file = (name: string, rows: Array<Array<string | number | bigint | null | undefined>>) =>
    new Response(toCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  const today = new Date().toISOString().slice(0, 10);

  if (kind === 'sellerbricks' && exportAdmin) {
    const cfg = await getBazaarConfig();
    const status = url.searchParams.get('status') === 'all' ? undefined : 'DRAFT';
    await writeAudit({ adminUserId: user.id, action: 'BAZAAR_SELLERBRICKS_EXPORT', targetType: 'bazaar_product', after: { status: status ?? 'all' } });
    const products = await prisma.bazaarProduct.findMany({
      where: status ? { status } : {},
      include: { merchant: { select: { displayName: true } }, item: { select: { category: true, condition: true } }, donation: { select: { brandPublic: true } } },
      orderBy: { trackingCode: 'asc' },
    });
    return file(`셀러브릭스_등록정보_${today}.csv`, [
      ['상품명(추적코드 포함)', '판매가', '배송비', '수량', '1인 구매 제한', '카테고리', '판매자(위탁자)', '상품 설명(위탁판매 표기)', '추적코드'],
      ...products.map((p) => [
        `[${p.trackingCode}] ${p.name}`,
        p.salePrice,
        p.shippingFee,
        p.quantity,
        p.perPersonLimit,
        p.item.category,
        p.merchant.displayName,
        cfg.consignmentNotice.replaceAll('{기관명}', p.merchant.displayName),
        p.trackingCode,
      ]),
    ]);
  }

  if (kind === 'sale-template' && isAdmin) {
    const products = await prisma.bazaarProduct.findMany({ where: { status: 'LISTED' }, orderBy: { trackingCode: 'asc' }, select: { trackingCode: true, name: true } });
    return file(`판매결과_양식_${today}.csv`, [
      ['추적코드', '판매수량', '판매금액', '환불수량', '환불금액', '반송비', '반송비부담', '메모'],
      ...products.map((p) => [p.trackingCode, 0, 0, 0, 0, 0, '없음', p.name]),
    ]);
  }

  if (kind === 'givers' && exportAdmin) {
    const donors = await prisma.inKindDonor.findMany({
      include: { user: { select: { email: true, status: true } }, donations: { select: { status: true, confirmedTotal: true } }, receipts: { where: { status: 'ISSUED' }, select: { totalAmount: true } } },
      orderBy: { createdAt: 'asc' },
    });
    await writeAudit({ adminUserId: user.id, action: 'BAZAAR_GIVERS_EXPORT', targetType: 'in_kind_donor', after: { rows: donors.length } });
    return file(`기부자대장_${today}.csv`, [
      ['구분', '이름(상호)', '사업자등록번호', '담당자', '연락처', '이메일', '가입일', '기부 건수', '영수증 발급 합계(원)', '상태'],
      ...donors.map((d) => [
        donorTypeLabel[d.donorType as DonorType] ?? d.donorType,
        d.displayName,
        d.businessNo ? formatBizNo(d.businessNo) : '',
        d.contactName,
        d.phoneMasked,
        d.user.email ?? '',
        formatKst(d.createdAt, false),
        d.donations.filter((x) => x.status !== 'CANCELED').length,
        d.receipts.reduce((s, r) => s + r.totalAmount, 0n),
        d.user.status === 'ACTIVE' ? '정상' : '정지',
      ]),
    ]);
  }

  if (kind === 'ledger') {
    if (isAdmin && !exportAdmin) return nf();
    const merchantId = isAdmin ? url.searchParams.get('merchantId') ?? undefined : user.merchantId;
    if (!merchantId) return nf();
    // 기관 담당자는 승인된 기관이어야 한다(정지 기관 반출 방지).
    if (!isAdmin && user.merchantStatus !== 'APPROVED') return nf();
    const donations = await prisma.inKindDonation.findMany({
      where: { merchantId },
      include: {
        donor: { select: { donorType: true, displayName: true } },
        items: { orderBy: { seq: 'asc' } },
        receipts: { where: { status: 'ISSUED' }, select: { receiptNo: true, totalAmount: true } },
        inbound: { select: { receivedAt: true } },
        products: { select: { id: true, itemId: true, quantity: true, status: true, remainingAction: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const productIds = donations.flatMap((d) => d.products.map((p) => p.id));
    const sales = await prisma.bazaarSaleLine.groupBy({
      by: ['productId'],
      where: { productId: { in: productIds }, batch: { status: 'APPROVED' } },
      _sum: { soldQty: true, grossAmount: true, refundAmount: true, refundQty: true },
    });
    const byP = new Map(sales.map((s) => [s.productId, s._sum]));
    const rows: Array<Array<string | number | bigint | null>> = [
      ['기부번호', '접수일', '기부자 구분', '기부자', '품목', '약정 수량', '합격 수량', '확정 단가', '영수증 가액', '영수증 번호', '입고일', '판매 수량', '순판매액(판매-환불)', '잔여 수량', '잔여 처리', '상태'],
    ];
    for (const d of donations) {
      for (const it of d.items) {
        const prod = d.products.find((x) => x.itemId === it.id);
        const s = prod ? byP.get(prod.id) : undefined;
        const sold = (s?.soldQty ?? 0) - (s?.refundQty ?? 0);
        rows.push([
          d.donationNo,
          formatKst(d.createdAt, false),
          donorTypeLabel[d.donor.donorType as DonorType] ?? d.donor.donorType,
          d.donor.displayName,
          it.name,
          it.quantity,
          it.acceptedQty ?? '',
          it.unitValue ?? '',
          it.unitValue != null && it.acceptedQty != null ? it.unitValue * BigInt(it.acceptedQty) : '',
          d.receipts.map((r) => r.receiptNo).join(' '),
          d.inbound ? formatKst(d.inbound.receivedAt, false) : '',
          prod ? sold : '',
          prod ? (s?.grossAmount ?? 0n) - (s?.refundAmount ?? 0n) : '',
          prod ? Math.max(prod.quantity - sold, 0) : '',
          prod?.remainingAction ? unsoldActionLabel[prod.remainingAction] ?? prod.remainingAction : '',
          donationStatusLabel[d.status as DonationStatus]?.text ?? d.status,
        ]);
      }
    }
    await writeAudit({
      ...(isAdmin ? { adminUserId: user.id } : { actorUserId: user.id }),
      action: 'BAZAAR_LEDGER_EXPORT',
      targetType: 'merchant_profile',
      targetId: merchantId,
      after: { rows: rows.length - 1 },
    });
    return file(`현물기부대장_${today}.csv`, rows);
  }
  return nf();
}
