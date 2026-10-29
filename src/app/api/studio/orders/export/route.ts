import { requireMerchant, writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { decrypt } from '@/lib/crypto';
import { formatKst } from '@/lib/datetime';
import { DELIVERY_SHIPMENT_STATUSES, RETURN_SHIPMENT_STATUSES, shipmentStatusLabel } from '@/lib/labels';
import {
  ORDER_CHARGE_STATUSES,
  ORDER_PERIODS,
  normalizePeriod,
  periodStart,
} from '@/components/studio/shared';
import type { Prisma } from '@/generated/prisma/client';
import type { ShipmentStatus } from '@/generated/prisma/enums';

/**
 * 실물 주문서 CSV (택배 발주용).
 *
 * 후원 내역 CSV 와 달리 **배송지 원문**이 들어간다. 마스킹된 주소로는 택배를 보낼 수 없다.
 * 대신 내려받을 때마다 감사로그를 남기고, 화면 필터와 같은 조건만 허용한다.
 *
 * 이 파일을 받은 뒤에는 사회복지기관이 개인정보 보관·파기 의무를 진다.
 */

export const dynamic = 'force-dynamic';

/** 한 번에 내려받을 수 있는 최대 건수. 그 이상은 기간을 좁혀서 받는다. */
const MAX_ROWS = 3000;

function csvCell(v: string | null | undefined): string {
  const s = (v ?? '').replace(/\r?\n/g, ' ');
  // 엑셀에서 수식으로 해석되는 문자로 시작하면 앞에 작은따옴표를 붙여 무력화한다.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function GET(req: Request) {
  const session = await requireMerchant().catch(() => null);
  if (!session) return new Response('사회복지기관 로그인이 필요합니다.', { status: 401 });
  const { merchantId, id: userId } = session;
  const url = new URL(req.url);

  const tab = url.searchParams.get('tab') === 'return' ? 'return' : 'delivery';
  const period = normalizePeriod(url.searchParams.get('period') || '30d', ORDER_PERIODS, '30d');
  const statusParam = url.searchParams.get('status') || '';
  const q = (url.searchParams.get('q') || '').trim();

  const scope = tab === 'return' ? RETURN_SHIPMENT_STATUSES : DELIVERY_SHIPMENT_STATUSES;
  const status = scope.includes(statusParam as ShipmentStatus) ? (statusParam as ShipmentStatus) : undefined;

  const gte = periodStart(period);

  const where: Prisma.ChargeShipmentWhereInput = {
    merchantId,
    status: status ? status : { in: scope },
    // 화면 목록과 같은 모집단을 쓴다(환불 요청·완료 건 포함).
    charge: { status: { in: ORDER_CHARGE_STATUSES }, ...(gte ? { paidAt: { gte } } : {}) },
  };
  if (q) {
    where.OR = [
      { trackingNo: { contains: q, mode: 'insensitive' } },
      { receiverMasked: { contains: q } },
      { phoneMasked: { contains: q } },
      { charge: { transactionNo: { contains: q, mode: 'insensitive' } } },
      { charge: { product: { name: { contains: q, mode: 'insensitive' } } } },
      { charge: { product: { sku: { contains: q, mode: 'insensitive' } } } },
    ];
  }

  const rows = await prisma.chargeShipment.findMany({
    where,
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    take: MAX_ROWS,
    include: {
      charge: {
        select: {
          transactionNo: true, amount: true, shippingFee: true, quantity: true,
          optionText: true, paidAt: true,
          product: { select: { name: true, sku: true } },
        },
      },
    },
  });

  // 배송지 원문을 내보내는 행위 자체를 기록한다.
  await writeAudit({
    adminUserId: userId,
    action: 'SHIPMENT_EXPORT',
    targetType: 'charge_shipment',
    // 열람자 계정을 함께 남긴다(사회복지기관 단위로만 남기면 담당자가 여럿일 때 추적이 안 된다).
    after: { merchantId, userId, tab, period, status: statusParam, q, count: rows.length, by: 'merchant' },
  });

  const header = [
    '거래번호',
    '결제시각',
    '배송상태',
    '상품명',
    'SKU',
    '옵션',
    '수량',
    '상품금액',
    '배송비',
    '결제금액',
    '받는분',
    '연락처',
    '우편번호',
    '주소',
    '후원자배송요청',
    '사회복지기관내부메모',
    '도서산간',
    '택배사',
    '송장번호',
    '발송시각',
    '배송완료시각',
    '반품·교환사유',
    '회수송장번호',
  ];

  const lines = [header.map(csvCell).join(',')];
  for (const s of rows) {
    lines.push(
      [
        csvCell(s.charge.transactionNo),
        csvCell(s.charge.paidAt ? formatKst(s.charge.paidAt) : ''),
        csvCell(shipmentStatusLabel[s.status].text),
        csvCell(s.charge.product?.name ?? '(보관된 상품)'),
        csvCell(s.charge.product?.sku ?? ''),
        csvCell(s.charge.optionText ?? ''),
        csvCell(String(s.charge.quantity)),
        csvCell((s.charge.amount - s.charge.shippingFee).toString()),
        csvCell(s.charge.shippingFee.toString()),
        csvCell(s.charge.amount.toString()),
        csvCell(decrypt(s.receiverEnc)),
        csvCell(decrypt(s.phoneEnc)),
        csvCell(s.zipCode),
        csvCell(decrypt(s.addressEnc)),
        csvCell(s.memo ?? ''),
        csvCell(s.merchantMemo ?? ''),
        csvCell(s.remote ? 'Y' : 'N'),
        csvCell(s.carrier ?? ''),
        csvCell(s.trackingNo ?? ''),
        csvCell(s.shippedAt ? formatKst(s.shippedAt) : ''),
        csvCell(s.deliveredAt ? formatKst(s.deliveredAt) : ''),
        csvCell(s.returnReason ?? ''),
        csvCell(s.returnTrackingNo ?? ''),
      ].join(','),
    );
  }

  // 엑셀이 UTF-8 로 열도록 BOM 을 붙인다.
  const body = `﻿${lines.join('\r\n')}\r\n`;
  const name = `givesign-orders-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
}
