import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { authError, denyTestKey, jsonError, logPartnerCall } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** CSV 한 칸. 쉼표·따옴표·줄바꿈이 들어가도 칸이 밀리지 않게 감싼다. */
function cell(value: string | number | null): string {
  const v = value === null ? '' : String(value);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * GET /api/partner/v1/settlements/{id}/export
 * 정산 명세 CSV. 엑셀에서 바로 열리도록 UTF-8 BOM 을 붙인다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticatePartner(req, '');
  if (!auth.ok) {
    await logPartnerCall({
      req, merchantId: auth.merchantId ?? null, keyId: auth.keyId,
      status: auth.status, errorCode: auth.code, message: auth.message,
    });
    return authError(auth);
  }

  // 테스트 키는 운영 데이터에 닿지 않는다. (_shared.liveOnly 주석 참고)
  const testDenied = await denyTestKey(req, auth);
  if (testDenied) return testDenied;

  const { id } = await ctx.params;
  const row = await prisma.settlementRequest.findFirst({
    where: { id, merchantId: auth.merchantId },
    include: {
      entries: {
        orderBy: { occurredAt: 'asc' },
        select: { entryType: true, amount: true, memo: true, occurredAt: true, charge: { select: { transactionNo: true } } },
      },
    },
  });
  if (!row) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '해당 정산 회차를 찾을 수 없습니다.');
  }

  const lines = [
    ['발생일시', '항목', '금액', '거래번호', '메모'].join(','),
    ...row.entries.map((e) =>
      [
        cell(e.occurredAt.toISOString()),
        cell(e.entryType),
        cell(Number(e.amount)),
        cell(e.charge?.transactionNo ?? null),
        cell(e.memo),
      ].join(','),
    ),
  ];

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `csv rows=${row.entries.length}` });
  return new NextResponse(`﻿${lines.join('\n')}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="settlement-${id}.csv"`,
    },
  });
}
