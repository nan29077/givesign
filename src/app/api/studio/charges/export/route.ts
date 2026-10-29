import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatKst } from '@/lib/datetime';
import { SELECTABLE_CHARGE_STATUSES, chargeStatusLabel, pointStatusLabel } from '@/lib/labels';
import {
  CHARGE_PERIODS,
  PAID_STATUSES,
  normalizePeriod,
  periodStart,
} from '@/components/studio/shared';
import { productKindLabel } from '@/server/services/products';
import type { ChargeStatus, Prisma } from '@/generated/prisma/client';

/**
 * 사회복지기관 후원 내역 CSV.
 *
 * 사회복지기관이 자기 시스템에 후원금를 일괄 반영할 때 쓴다.
 * 화면의 필터(기간·상태·지급 상태·거래번호)를 그대로 받아 같은 결과를 내려준다.
 *
 * 개인정보는 마스킹된 값만 담는다. 원문 전화번호는 어떤 경우에도 내보내지 않는다.
 */

export const dynamic = 'force-dynamic';

/** 한 번에 내려받을 수 있는 최대 건수. 그 이상은 기간을 좁혀서 받는다. */
const MAX_ROWS = 5000;

function csvCell(v: string | null | undefined): string {
  const s = (v ?? '').replace(/\r?\n/g, ' ');
  // 엑셀에서 수식으로 해석되는 문자로 시작하면 앞에 작은따옴표를 붙여 무력화한다.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function GET(req: Request) {
  // 미인증 요청이 500 으로 떨어지지 않도록 401 로 정리한다(관리자 라우트와 같은 규약).
  const session = await requireMerchant().catch(() => null);
  if (!session) return new Response('사회복지기관 로그인이 필요합니다.', { status: 401 });
  const { merchantId } = session;
  const url = new URL(req.url);

  const period = normalizePeriod(url.searchParams.get('period') || '30d', CHARGE_PERIODS, '30d');
  const status = url.searchParams.get('status') || '';
  const point = url.searchParams.get('point') || '';
  const q = (url.searchParams.get('q') || '').trim();

  const where: Prisma.ChargeWhereInput = { merchantId };
  // 화면 목록과 같은 함수를 쓴다(예전에는 서버 로컬 자정 기준이라 KST 새벽 결제가 빠졌다).
  const gte = periodStart(period);
  if (gte) where.receivedAt = { gte };

  // 화면 드롭다운과 같은 목록만 허용한다(코드가 기록하지 않는 상태를 URL 로 넣지 못하게).
  if (status && (SELECTABLE_CHARGE_STATUSES as string[]).includes(status)) where.status = status as ChargeStatus;
  if (q) where.transactionNo = { contains: q, mode: 'insensitive' };
  if (point === 'pending') where.pointStatus = 'PENDING';
  if (point === 'given') where.pointStatus = 'SENT';
  if (point === 'held') where.pointStatus = 'FAILED';

  const rows = await prisma.charge.findMany({
    where,
    orderBy: { receivedAt: 'desc' },
    take: MAX_ROWS,
    select: {
      transactionNo: true,
      receivedAt: true,
      paidAt: true,
      amount: true,
      status: true,
      displayName: true,
      message: true,
      pointStatus: true,
      pointGivenAt: true,
      pointNote: true,
      quantity: true,
      optionText: true,
      shippingFee: true,
      payer: { select: { phoneMasked: true } },
      product: { select: { name: true, sku: true, kind: true } },
    },
  });

  const header = [
    '거래번호',
    '수신시각',
    '결제시각',
    '금액',
    '결제상태',
    '상품종류',
    '상품명',
    'SKU',
    '옵션',
    '수량',
    '배송비',
    '표시이름',
    '연락처(마스킹)',
    '메모',
    '지급상태',
    '지급시각',
    '지급메모',
    '정산대상여부',
  ];

  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.transactionNo),
        csvCell(formatKst(r.receivedAt)),
        csvCell(r.paidAt ? formatKst(r.paidAt) : ''),
        csvCell(r.amount.toString()),
        csvCell(chargeStatusLabel[r.status].text),
        csvCell(r.product ? productKindLabel[r.product.kind] : '직접입력'),
        csvCell(r.product?.name ?? ''),
        csvCell(r.product?.sku ?? ''),
        csvCell(r.optionText ?? ''),
        csvCell(String(r.quantity)),
        csvCell(r.shippingFee.toString()),
        csvCell(r.displayName),
        csvCell(r.payer?.phoneMasked ?? ''),
        csvCell(r.message),
        // 화면과 같은 문구를 쓴다. deliveryStatusLabel(대기/성공/실패)을 쓰면
        // 같은 값이 화면에서는 "지급 대기", 엑셀에서는 "대기" 로 갈린다.
        csvCell(pointStatusLabel[r.pointStatus].text),
        csvCell(r.pointGivenAt ? formatKst(r.pointGivenAt) : ''),
        csvCell(r.pointNote ?? ''),
        csvCell(PAID_STATUSES.includes(r.status) ? 'Y' : 'N'),
      ].join(','),
    );
  }

  // 엑셀이 UTF-8 로 열도록 BOM 을 붙인다.
  const body = `﻿${lines.join('\r\n')}\r\n`;
  const today = formatKst(new Date(), false).replace(/[^0-9]/g, '').slice(0, 8);

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="givesign-charges-${today}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
