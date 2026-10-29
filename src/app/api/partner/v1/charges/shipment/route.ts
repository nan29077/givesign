import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { PAID_STATUSES } from '@/components/studio/shared';
import { sandboxShipment } from '@/server/services/sandbox';
import { emitMerchantEvent } from '@/server/services/webhooks';
import { authError, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = ['PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELED'] as const;
type Status = (typeof STATUSES)[number];

interface ShipBody {
  transactionNo?: unknown;
  status?: unknown;
  carrier?: unknown;
  trackingNo?: unknown;
  memo?: unknown;
}

/**
 * POST /api/partner/v1/charges/shipment
 *
 * 실물 주문의 배송 상태와 송장번호를 등록한다.
 * 사회복지기관이 자기 물류 시스템에서 출고 처리한 결과를 기브싸인에 반영하는 용도다.
 *
 * body
 *  { "transactionNo": "MP...", "status": "SHIPPED", "carrier": "CJ대한통운", "trackingNo": "123456789012" }
 *
 * - 서명 헤더 필수(쓰기 요청).
 * - SHIPPED 로 바꾸려면 carrier 와 trackingNo 가 있어야 한다.
 *   송장 없이 발송 처리하면 후원자가 조회할 수 없고 분쟁 시 발송 사실을 증명하지 못한다.
 * - 같은 값을 다시 보내도 결과가 같다(멱등).
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

  let body: ShipBody;
  try {
    body = JSON.parse(rawBody || '{}') as ShipBody;
  } catch {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId,
      status: 400, errorCode: 'INVALID_JSON',
    }).then(() => jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.'));
  }

  const transactionNo = String(body.transactionNo ?? '').trim();
  if (!transactionNo) return logPartnerCall({
   req, merchantId: auth.merchantId, keyId: auth.keyId,
   status: 400, errorCode: 'INVALID_ITEMS',
 }).then(() => jsonError(400, 'INVALID_ITEMS', 'transactionNo 가 필요합니다.'));

  const status = String(body.status ?? '').toUpperCase();
  if (!STATUSES.includes(status as Status)) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId,
      status: 400, errorCode: 'INVALID_STATUS',
    }).then(() => jsonError(400, 'INVALID_STATUS', `status 는 ${STATUSES.join(' / ')} 중 하나여야 합니다.`));
  }

  // 본문에 없는 필드는 "지우라는 뜻" 이 아니라 "건드리지 말라는 뜻" 이다.
  // 예전에는 없으면 null 로 덮어써서, 상태만 바꾸는 호출 한 번에 송장번호·택배사와
  // 후원자가 남긴 배송 요청 메모까지 사라졌다(주석의 "멱등" 계약과도 어긋났다).
  const carrier = body.carrier === undefined ? undefined : body.carrier === null ? null : String(body.carrier).slice(0, 30).trim() || null;
  const trackingNo =
    body.trackingNo === undefined
      ? undefined
      : body.trackingNo === null
        ? null
        : String(body.trackingNo).replace(/[^0-9A-Za-z-]/g, '').slice(0, 40) || null;
  const memo = body.memo === undefined ? undefined : body.memo === null ? null : String(body.memo).slice(0, 100) || null;

  // ── 테스트 키 ────────────────────────────────────────────────
  // 샌드박스 건만 갱신한다. 운영 주문·배송 데이터는 건드리지 않는다.
  if (auth.mode === 'TEST') {
    if (status === 'SHIPPED' && (!carrier || !trackingNo)) {
      return logPartnerCall({
        req, merchantId: auth.merchantId, keyId: auth.keyId,
        status: 400, errorCode: 'TRACKING_REQUIRED',
      }).then(() => jsonError(400, 'TRACKING_REQUIRED', '발송(SHIPPED) 처리에는 carrier 와 trackingNo 가 필요합니다.'));
    }
    const updated = await sandboxShipment({
      merchantId: auth.merchantId,
      transactionNo,
      status,
      carrier: carrier ?? null,
      trackingNo: trackingNo ?? null,
    });
    if (!updated) {
      return logPartnerCall({
        req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND',
      }).then(() => jsonError(404, 'NOT_FOUND', '해당 테스트 거래를 찾을 수 없습니다.'));
    }
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: 'sandbox shipment' });
    return jsonOk({
      transactionNo,
      status,
      carrier: updated.carrier,
      trackingNo: updated.trackingNo,
    });
  }

  // 본인 사회복지기관의 결제 완료 실물 주문인지 확인한다.
  const charge = await prisma.charge.findFirst({
    where: { transactionNo, merchantId: auth.merchantId, status: { in: PAID_STATUSES } },
    select: { id: true, shipment: { select: { shippedAt: true, deliveredAt: true, carrier: true, trackingNo: true } } },
  });
  if (!charge) return logPartnerCall({
   req, merchantId: auth.merchantId, keyId: auth.keyId,
   status: 404, errorCode: 'NOT_FOUND',
 }).then(() => jsonError(404, 'NOT_FOUND', '해당 거래번호의 결제 완료 주문을 찾을 수 없습니다.'));
  if (!charge.shipment) return logPartnerCall({
   req, merchantId: auth.merchantId, keyId: auth.keyId,
   status: 400, errorCode: 'NOT_PHYSICAL',
 }).then(() => jsonError(400, 'NOT_PHYSICAL', '배송 정보가 없는 주문입니다(실물 상품이 아닙니다).'));

  // 발송 처리에 필요한 값은 이번 요청 또는 이미 저장된 값 중 하나로 채워져 있어야 한다.
  const effectiveCarrier = carrier === undefined ? charge.shipment.carrier : carrier;
  const effectiveTrackingNo = trackingNo === undefined ? charge.shipment.trackingNo : trackingNo;
  if (status === 'SHIPPED' && (!effectiveCarrier || !effectiveTrackingNo)) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId,
      status: 400, errorCode: 'TRACKING_REQUIRED',
    }).then(() => jsonError(400, 'TRACKING_REQUIRED', '발송(SHIPPED) 처리에는 carrier 와 trackingNo 가 필요합니다.'));
  }

  const now = new Date();
  await prisma.chargeShipment.update({
    where: { chargeId: charge.id },
    data: {
      status: status as Status,
      ...(carrier === undefined ? {} : { carrier }),
      ...(trackingNo === undefined ? {} : { trackingNo }),
      ...(memo === undefined ? {} : { memo }),
      // 발송 시각은 처음 발송으로 바꾼 때만 기록한다(수정할 때마다 갱신하면 배송 지연을 못 본다).
      shippedAt:
        status === 'SHIPPED'
          ? charge.shipment.shippedAt ?? now
          : status === 'PREPARING'
            ? null
            : charge.shipment.shippedAt,
      // 배송 완료 시각도 최초 1회만 기록한다. 같은 상태로 다시 보내도 값이 바뀌지 않아야
      // 주석이 약속한 "같은 값을 다시 보내도 결과가 같다(멱등)" 가 성립한다.
      deliveredAt:
        status === 'DELIVERED'
          ? charge.shipment.deliveredAt ?? now
          : status === 'PREPARING'
            ? null
            : charge.shipment.deliveredAt,
    },
  });

  await emitMerchantEvent(auth.merchantId, 'shipment.updated', {
    transactionNo,
    status,
    carrier: effectiveCarrier,
    trackingNo: effectiveTrackingNo,
  });

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({ transactionNo, status, carrier: effectiveCarrier, trackingNo: effectiveTrackingNo });
}
