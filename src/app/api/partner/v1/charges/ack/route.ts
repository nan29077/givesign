import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { PAID_STATUSES } from '@/components/studio/shared';
import { sandboxAck } from '@/server/services/sandbox';
import { authError, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 한 번에 처리할 수 있는 최대 건수 */
const MAX_ITEMS = 200;

interface AckBody {
  transactionNos?: unknown;
  status?: unknown;
  note?: unknown;
}

/**
 * POST /api/partner/v1/charges/ack
 *
 * 사회복지기관이 후원금 적립을 끝냈다고(또는 보류했다고) 알린다.
 * 알린 건은 다음 /charges?status=pending 조회에서 빠진다.
 *
 * body
 *  { "transactionNos": ["MP...", ...], "status": "SENT" | "FAILED", "note": "보류 사유" }
 *
 * - 서명 헤더 필수(쓰기 요청).
 * - 같은 건을 여러 번 보내도 결과가 같다(멱등).
 * - 이미 SENT 인 건은 다시 바꾸지 않는다. 되돌려야 하면 기브싸인 관리자에게 문의한다.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const auth = await authenticatePartner(req, rawBody);
  if (!auth.ok) {
    await logPartnerCall({
      req, merchantId: auth.merchantId ?? null, keyId: auth.keyId,
      status: auth.status, errorCode: auth.code, message: auth.message,
    });
    return authError(auth);
  }

  let body: AckBody;
  try {
    body = JSON.parse(rawBody || '{}') as AckBody;
  } catch {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId,
      status: 400, errorCode: 'INVALID_JSON',
    }).then(() => jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.'));
  }

  const status = String(body.status ?? '').toUpperCase();
  if (status !== 'SENT' && status !== 'FAILED') {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId,
      status: 400, errorCode: 'INVALID_STATUS',
    }).then(() => jsonError(400, 'INVALID_STATUS', 'status 는 SENT 또는 FAILED 여야 합니다.'));
  }

  if (!Array.isArray(body.transactionNos) || body.transactionNos.length === 0) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId,
      status: 400, errorCode: 'INVALID_ITEMS',
    }).then(() => jsonError(400, 'INVALID_ITEMS', 'transactionNos 배열이 필요합니다.'));
  }
  if (body.transactionNos.length > MAX_ITEMS) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId,
      status: 400, errorCode: 'TOO_MANY_ITEMS',
    }).then(() => jsonError(400, 'TOO_MANY_ITEMS', `한 번에 최대 ${MAX_ITEMS}건까지 보낼 수 있습니다.`));
  }

  const nos = [...new Set(body.transactionNos.map((v) => String(v).trim()).filter(Boolean))];
  if (nos.length === 0) return logPartnerCall({
   req, merchantId: auth.merchantId, keyId: auth.keyId,
   status: 400, errorCode: 'INVALID_ITEMS',
 }).then(() => jsonError(400, 'INVALID_ITEMS', 'transactionNos 배열이 비어 있습니다.'));

  const note = body.note == null ? null : String(body.note).slice(0, 200);
  if (status === 'FAILED' && !note) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId,
      status: 400, errorCode: 'NOTE_REQUIRED',
    }).then(() => jsonError(400, 'NOTE_REQUIRED', '보류(FAILED) 처리에는 note 가 필요합니다.'));
  }

  // ── 테스트 키 ────────────────────────────────────────────────
  // 샌드박스 건만 갱신한다. 운영 charge 는 한 줄도 건드리지 않는다.
  if (auth.mode === 'TEST') {
    const sandbox = await sandboxAck({
      merchantId: auth.merchantId,
      transactionNos: nos,
      status,
      note,
      keyId: auth.keyId,
    });
    await logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200,
      message: `sandbox ack updated=${sandbox.updated}`,
    });
    return jsonOk(sandbox);
  }

  // 변경 전 상태를 먼저 읽는다.
  // 갱신 후에 읽으면 방금 바꾼 건과 원래 SENT 였던 건을 구분할 수 없어
  // 응답의 unchanged 가 전부를 뱉는다(사회복지기관이 원인을 못 찾는다).
  const before = await prisma.charge.findMany({
    where: { transactionNo: { in: nos }, merchantId: auth.merchantId },
    select: { transactionNo: true, status: true, pointStatus: true, refundedAt: true },
  });
  const known = new Set(before.map((b) => b.transactionNo));
  const targets = new Set(
    before
      .filter(
        (b) =>
          PAID_STATUSES.includes(b.status) &&
          b.refundedAt === null &&
          (b.pointStatus === 'PENDING' || b.pointStatus === 'FAILED'),
      )
      .map((b) => b.transactionNo),
  );

  // 소유·상태 확인은 updateMany 조건에 함께 넣는다.
  // 남의 사회복지기관 거래번호를 섞어 보내도 조건에서 걸러진다.
  const now = new Date();
  const result = await prisma.charge.updateMany({
    where: {
      transactionNo: { in: nos },
      merchantId: auth.merchantId,
      status: { in: PAID_STATUSES },
      refundedAt: null,
      // 이미 지급 완료로 확정된 건은 다시 바꾸지 않는다.
      pointStatus: { in: ['PENDING', 'FAILED'] },
    },
    data:
      status === 'SENT'
        ? { pointStatus: 'SENT', pointGivenAt: now, pointNote: note, pointBy: `api:${auth.keyId}` }
        : { pointStatus: 'FAILED', pointGivenAt: null, pointNote: note, pointBy: `api:${auth.keyId}` },
  });

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({
    updated: result.count,
    // 이미 지급 완료로 확정됐거나(SENT) 결제·환불 상태 때문에 대상이 아니어서 변경되지 않은 건
    unchanged: nos.filter((n) => known.has(n) && !targets.has(n)),
    // 이 사회복지기관 거래가 아니거나 존재하지 않는 거래번호
    unknown: nos.filter((n) => !known.has(n)),
  });
}
