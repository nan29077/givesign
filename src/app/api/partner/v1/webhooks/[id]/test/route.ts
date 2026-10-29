import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { deliverOnce } from '@/server/services/webhooks';
import { newId } from '@/lib/id';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/partner/v1/webhooks/{id}/test
 * 테스트 이벤트를 한 건 보낸다. 수신 처리와 서명 검증이 되는지 확인하는 용도다.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rawBody = await req.text();
  const auth = await authenticatePartner(req, rawBody);
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
  const hook = await prisma.merchantWebhook.findFirst({ where: { id, merchantId: auth.merchantId } });
  if (!hook) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '해당 수신 URL 을 찾을 수 없습니다.');
  }

  const eventId = newId();
  const delivery = await prisma.webhookDelivery.create({
    data: {
      id: newId(),
      merchantId: auth.merchantId,
      webhookId: hook.id,
      eventId,
      eventType: 'webhook.test',
      payload: JSON.stringify({
        eventId,
        type: 'webhook.test',
        occurredAt: new Date().toISOString(),
        merchantId: auth.merchantId,
        data: { message: '기브싸인 웹훅 테스트입니다. 이 요청에 200 을 돌려주면 연동이 정상입니다.' },
      }),
      nextAttemptAt: new Date(),
    },
  });

  const ok = await deliverOnce(delivery.id);
  const after = await prisma.webhookDelivery.findUnique({
    where: { id: delivery.id },
    select: { status: true, responseStatus: true, error: true },
  });

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `webhook test ${ok}` });
  return jsonOk({
    deliveryId: delivery.id,
    eventId,
    delivered: ok,
    responseStatus: after?.responseStatus ?? null,
    error: after?.error ?? null,
  });
}
