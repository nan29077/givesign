import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { deliverOnce } from '@/server/services/webhooks';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/partner/v1/webhooks/deliveries/{id}/retry
 * 실패한 전송을 지금 다시 보낸다. 재시도 한도를 다 쓴 건(DEAD)도 여기서 되살릴 수 있다.
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
  const delivery = await prisma.webhookDelivery.findFirst({
    where: { id, merchantId: auth.merchantId },
    select: { id: true, status: true },
  });
  if (!delivery) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '해당 전송 건을 찾을 수 없습니다.');
  }
  if (delivery.status === 'SENT') {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 409, errorCode: 'ALREADY_SENT' });
    return jsonError(409, 'ALREADY_SENT', '이미 전송에 성공한 건입니다.');
  }

  // DEAD 였던 건도 다시 보낼 수 있게 상태를 되돌린 뒤 시도한다.
  // 이때 다음 시도 시각을 뒤로 밀어 크론이 같은 건을 동시에 집어가지 않게 선점한다.
  // (밀지 않으면 수동 재시도와 크론이 겹쳐 같은 이벤트가 두 번 나간다)
  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: { status: 'PENDING', nextAttemptAt: new Date(Date.now() + 60_000) },
  });
  const ok = await deliverOnce(delivery.id);
  const after = await prisma.webhookDelivery.findUnique({
    where: { id: delivery.id },
    select: { status: true, responseStatus: true, error: true, attempts: true },
  });

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({ delivered: ok, status: after?.status, attempts: after?.attempts, responseStatus: after?.responseStatus, error: after?.error });
}
