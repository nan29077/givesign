import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { authError, jsonError, jsonOk, logPartnerCall } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/partner/v1/mt/messages/{id}
 * 발송 상태 조회. 접수 / 발송 / 실패와 실패 사유를 돌려준다.
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

  const { id } = await ctx.params;

  if (auth.mode === 'TEST') {
    const row = await prisma.sandboxMessage.findFirst({ where: { id, merchantId: auth.merchantId } });
    if (!row) {
      await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
      return jsonError(404, 'NOT_FOUND', '해당 발송 건을 찾을 수 없습니다.');
    }
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
    return jsonOk({
      id: row.id,
      templateCode: row.templateCode?.replace(/^MERCHANT:/, '') ?? null,
      phoneMasked: row.phoneMasked,
      body: row.body,
      status: 'SENT',
      resultCode: null,
      resultMessage: null,
      sentAt: row.createdAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      sandbox: true,
    });
  }

  // 사회복지기관이 API 로 보낸 건만 조회할 수 있다. 시스템이 보낸 문자는 대상이 아니다.
  const row = await prisma.mtOutboundMessage.findFirst({
    where: { id, merchantId: auth.merchantId, merchantSent: true },
    select: {
      id: true, templateCode: true, phoneMasked: true, bodyMasked: true,
      status: true, resultCode: true, resultMessage: true, sentAt: true, createdAt: true,
    },
  });
  if (!row) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '해당 발송 건을 찾을 수 없습니다.');
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({
    id: row.id,
    templateCode: row.templateCode?.replace(/^MERCHANT:/, '') ?? null,
    phoneMasked: row.phoneMasked,
    body: row.bodyMasked,
    status: row.status,
    resultCode: row.resultCode,
    resultMessage: row.resultMessage,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    sandbox: false,
  });
}
