import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { WEBHOOK_EVENTS, registerWebhook } from '@/server/services/webhooks';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 사회복지기관당 등록할 수 있는 수신 URL 수. */
const MAX_WEBHOOKS = 5;

/**
 * GET /api/partner/v1/webhooks — 등록된 수신 URL 목록
 * POST /api/partner/v1/webhooks — 수신 URL 등록
 *
 * 서명 비밀키는 등록 응답에서 한 번만 돌려준다. 저장하지 않으므로 다시 볼 수 없다.
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

  const rows = await prisma.merchantWebhook.findMany({
    where: { merchantId: auth.merchantId },
    orderBy: { createdAt: 'desc' },
  });
  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({
    items: rows.map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events ? w.events.split(',').filter(Boolean) : WEBHOOK_EVENTS.slice(),
      description: w.description,
      active: w.active,
      lastStatus: w.lastStatus,
      lastAt: w.lastAt ? w.lastAt.toISOString() : null,
      createdAt: w.createdAt.toISOString(),
    })),
    availableEvents: WEBHOOK_EVENTS,
  });
}

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

  // 테스트 키는 운영 데이터에 닿지 않는다. (_shared.liveOnly 주석 참고)
  const testDenied = await denyTestKey(req, auth);
  if (testDenied) return testDenied;

  let body: { url?: string; events?: string[]; description?: string };
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_JSON',
    }).then(() => jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.'));
  }

  const count = await prisma.merchantWebhook.count({ where: { merchantId: auth.merchantId } });
  if (count >= MAX_WEBHOOKS) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'TOO_MANY_WEBHOOKS' });
    return jsonError(400, 'TOO_MANY_WEBHOOKS', `수신 URL 은 ${MAX_WEBHOOKS}개까지 등록할 수 있습니다.`);
  }

  const result = await registerWebhook({
    merchantId: auth.merchantId,
    url: String(body.url ?? ''),
    events: Array.isArray(body.events) ? body.events.map(String) : [],
    description: body.description ?? null,
  });
  if (!result.ok) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_WEBHOOK' });
    return jsonError(400, 'INVALID_WEBHOOK', result.message);
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: 'webhook registered' });
  return jsonOk({
    id: result.webhook.id,
    url: result.webhook.url,
    events: result.webhook.events ? result.webhook.events.split(',').filter(Boolean) : WEBHOOK_EVENTS.slice(),
    // 이 값은 지금만 볼 수 있다. 저장하지 않으므로 다시 조회할 수 없다.
    secret: result.secret,
    secretHint: '이 서명 비밀키는 지금만 확인할 수 있습니다. 안전한 곳에 보관하세요.',
  });
}
