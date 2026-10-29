import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DAYS = 92;

/**
 * GET /api/partner/v1/stats/messages
 * 문자 집계. MO 수신과 MT 발송 건수를 돌려준다.
 * 사회복지기관이 API 로 직접 보낸 문자는 따로 센다(한도 소진을 보기 위해서다).
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

  const days = Number(new URL(req.url).searchParams.get('days') ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return jsonError(400, 'INVALID_DAYS', `days 는 1~${MAX_DAYS} 사이 정수여야 합니다.`);
  }

  const since = new Date(Date.now() - days * 86400 * 1000);
  const [moCount, mtTotal, mtByMerchant, mtFailed] = await Promise.all([
    prisma.moInboundMessage.count({ where: { merchantId: auth.merchantId, createdAt: { gte: since } } }),
    prisma.mtOutboundMessage.count({ where: { merchantId: auth.merchantId, createdAt: { gte: since } } }),
    prisma.mtOutboundMessage.count({ where: { merchantId: auth.merchantId, merchantSent: true, createdAt: { gte: since } } }),
    prisma.mtOutboundMessage.count({ where: { merchantId: auth.merchantId, status: 'FAILED', createdAt: { gte: since } } }),
  ]);

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({
    days,
    moReceived: moCount,
    mtSent: mtTotal,
    mtSentByMerchant: mtByMerchant,
    mtFailed,
  });
}
