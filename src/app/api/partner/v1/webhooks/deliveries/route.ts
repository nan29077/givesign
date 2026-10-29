import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * GET /api/partner/v1/webhooks/deliveries
 * 전송 이력과 실패 사유. 연동이 안 될 때 무엇이 왜 막혔는지 여기서 본다.
 */
export async function GET(req: Request) {
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

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_LIMIT',
    }).then(() => jsonError(400, 'INVALID_LIMIT', `limit 은 1~${MAX_LIMIT} 사이 정수여야 합니다.`));
  }
  const statusFilter = url.searchParams.get('status');

  const rows = await prisma.webhookDelivery.findMany({
    where: {
      merchantId: auth.merchantId,
      ...(statusFilter === 'PENDING' || statusFilter === 'SENT' || statusFilter === 'DEAD'
        ? { status: statusFilter }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limitRaw,
  });

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `items=${rows.length}` });
  return jsonOk({
    items: rows.map((d) => ({
      id: d.id,
      eventId: d.eventId,
      eventType: d.eventType,
      status: d.status,
      attempts: d.attempts,
      responseStatus: d.responseStatus,
      error: d.error,
      nextAttemptAt: d.nextAttemptAt ? d.nextAttemptAt.toISOString() : null,
      deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
    })),
  });
}
