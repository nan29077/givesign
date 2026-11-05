import { archiveWebhook } from '@/server/services/webhooks';
import { authenticatePartner } from '@/server/services/partner-auth';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerAudit, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DELETE /api/partner/v1/webhooks/{id} — 수신 URL 해제(보관). 행과 전송 이력은 남기고 더 보내지 않는다. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
  // 본인 기관 것인지 조건에 함께 넣는다. 하드 삭제 대신 보관해 전달 증적(전송 이력)을 남긴다.
  const archived = await archiveWebhook(auth.merchantId, id);
  if (!archived) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '해당 수신 URL 을 찾을 수 없습니다.');
  }

  await logPartnerAudit({
    req, merchantId: auth.merchantId, keyId: auth.keyId,
    action: 'WEBHOOK_ARCHIVE', targetType: 'merchant_webhook', targetId: id, after: { url: archived.url },
  });
  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({ deleted: true, archived: true });
}
