import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import {
  listMerchantMtMessages,
  merchantMtQuota,
  renderMerchantTemplate,
  reviewVariableValues,
  sendMerchantMt,
} from '@/server/services/merchant-mt';
import { sandboxResolveRecipient, sandboxSendMerchantMt } from '@/server/services/sandbox';
import { authError, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

interface SendBody {
  templateCode?: string;
  payerRef?: string;
  transactionNo?: string;
  variables?: Record<string, unknown>;
}

/**
 * GET /api/partner/v1/mt/messages
 * 사회복지기관이 API 로 보낸 문자 이력. 시스템이 보낸 문자는 포함하지 않는다.
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

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_LIMIT',
    }).then(() => jsonError(400, 'INVALID_LIMIT', `limit 은 1~${MAX_LIMIT} 사이 정수여야 합니다.`));
  }

  // 테스트 키는 실제 발송 이력을 보지 않는다. 테스트 문자함을 대신 쓴다.
  if (auth.mode === 'TEST') {
    const rows = await prisma.sandboxMessage.findMany({
      where: { merchantId: auth.merchantId, direction: 'MT' },
      orderBy: { createdAt: 'desc' },
      take: limitRaw,
    });
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `sandbox items=${rows.length}` });
    return jsonOk({
      items: rows.map((r) => ({
        id: r.id,
        templateCode: r.templateCode?.replace(/^MERCHANT:/, '') ?? null,
        phoneMasked: r.phoneMasked,
        body: r.body,
        status: 'SENT',
        resultCode: null,
        resultMessage: null,
        sentAt: r.createdAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: null,
    });
  }

  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (cursor) {
    const owned = await prisma.mtOutboundMessage.findFirst({
      where: { id: cursor, merchantId: auth.merchantId, merchantSent: true },
      select: { id: true },
    });
    if (!owned) {
      return logPartnerCall({
        req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_CURSOR',
      }).then(() => jsonError(400, 'INVALID_CURSOR', 'cursor 가 올바르지 않습니다.'));
    }
  }

  const result = await listMerchantMtMessages(auth.merchantId, limitRaw, cursor);
  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `items=${result.items.length}` });
  return jsonOk(result);
}

/**
 * POST /api/partner/v1/mt/messages
 *
 * 등록해 승인받은 템플릿으로 문자 1건을 보낸다.
 *
 * v1 의 제약
 *  - 발신번호는 기브싸인 번호 고정
 *  - 정보성 문자만 (광고성 문구는 템플릿 등록 단계에서 걸린다)
 *  - 수신자는 이 사회복지기관에 거래 이력이 있는 후원자만
 *  - 자유 본문 불가
 *
 * 멱등키(Idempotency-Key)가 필수다. 재시도로 같은 문자가 두 번 나가면
 * 후원자는 그것을 스팸으로 받아들인다.
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

  const idempotencyKey = (req.headers.get('idempotency-key') ?? '').trim();
  if (!idempotencyKey || idempotencyKey.length > 100) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'IDEMPOTENCY_KEY_REQUIRED',
    }).then(() =>
      jsonError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Idempotency-Key 헤더가 필요합니다(100자 이내). 재시도로 같은 문자가 두 번 나가는 것을 막기 위한 값입니다.',
      ),
    );
  }

  let body: SendBody;
  try {
    body = JSON.parse(rawBody || '{}') as SendBody;
  } catch {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_JSON',
    }).then(() => jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.'));
  }

  const templateCode = String(body.templateCode ?? '').trim();
  if (!templateCode) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'TEMPLATE_CODE_REQUIRED',
    }).then(() => jsonError(400, 'TEMPLATE_CODE_REQUIRED', 'templateCode 가 필요합니다.'));
  }

  if (!body.payerRef && !body.transactionNo) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'RECIPIENT_REQUIRED',
    }).then(() =>
      jsonError(400, 'RECIPIENT_REQUIRED', 'payerRef 또는 transactionNo 로 수신자를 지정해 주세요. 임의의 전화번호로는 보낼 수 없습니다.'),
    );
  }

  // 치환값은 문자열만 받는다. 객체를 그대로 넣으면 후원자에게 [object Object] 가 나간다.
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.variables ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      return logPartnerCall({
        req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_VARIABLES',
      }).then(() => jsonError(400, 'INVALID_VARIABLES', `치환값은 문자열이나 숫자여야 합니다: ${key}`));
    }
    variables[key] = String(value);
  }

  // 본문은 등록 때 검수했지만 치환값은 발송할 때 처음 들어온다.
  // 여기서 보지 않으면 승인된 정보성 템플릿의 빈칸으로 광고 문구가 그대로 나간다.
  const varReview = await reviewVariableValues(auth.merchantId, variables);
  if (!varReview.ok) {
    await logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_VARIABLES',
    });
    return jsonError(400, 'INVALID_VARIABLES', varReview.message);
  }

  const merchant = await prisma.merchantProfile.findUnique({
    where: { id: auth.merchantId },
    select: { displayName: true },
  });
  const merchantName = merchant?.displayName ?? '사회복지기관';

  // ── 테스트 키 ────────────────────────────────────────────────
  // 템플릿 규칙은 운영과 같게 검사하고, 실제 발송만 하지 않는다.
  if (auth.mode === 'TEST') {
    const template = await prisma.merchantMtTemplate.findUnique({
      where: { merchantId_code: { merchantId: auth.merchantId, code: templateCode } },
    });
    if (!template) {
      await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'TEMPLATE_NOT_FOUND' });
      return jsonError(404, 'TEMPLATE_NOT_FOUND', '등록되지 않은 템플릿 코드입니다.');
    }
    if (template.status !== 'APPROVED') {
      await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 409, errorCode: 'TEMPLATE_NOT_APPROVED' });
      return jsonError(409, 'TEMPLATE_NOT_APPROVED', '승인되지 않은 템플릿입니다. 승인 후 발송할 수 있습니다.');
    }
    const required = template.variables ? template.variables.split(',').filter(Boolean) : [];
    const missing = required.filter((name) => variables[name] === undefined);
    if (missing.length > 0) {
      await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'MISSING_VARIABLES' });
      return jsonError(400, 'MISSING_VARIABLES', `템플릿에 필요한 치환값이 빠졌습니다: ${missing.join(', ')}`);
    }

    const recipient = await sandboxResolveRecipient(auth.merchantId, {
      payerRef: body.payerRef ?? null,
      transactionNo: body.transactionNo ?? null,
    });
    if (!recipient) {
      await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'RECIPIENT_NOT_FOUND' });
      return jsonError(404, 'RECIPIENT_NOT_FOUND', '테스트 데이터에서 해당 후원자를 찾을 수 없습니다. 먼저 /sandbox/mo 로 거래를 만들어 주세요.');
    }

    const text = `[기브싸인] ${renderMerchantTemplate(template.body, variables, merchantName)}`;
    const row = await sandboxSendMerchantMt({
      merchantId: auth.merchantId,
      phoneMasked: recipient.payerPhoneMasked,
      templateCode,
      body: text,
      transactionNo: recipient.transactionNo,
    });
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: 'sandbox mt' });
    return jsonOk({
      id: row.id,
      status: 'SENT',
      reused: false,
      sandbox: true,
      phoneMasked: recipient.payerPhoneMasked,
      body: row.body,
    });
  }

  const result = await sendMerchantMt({
    merchantId: auth.merchantId,
    merchantName,
    templateCode,
    variables,
    recipient: { payerRef: body.payerRef ?? null, transactionNo: body.transactionNo ?? null },
    idempotencyKey,
  });

  if (!result.ok) {
    const status =
      result.code === 'TEMPLATE_NOT_FOUND' || result.code === 'RECIPIENT_NOT_FOUND'
        ? 404
        : result.code === 'QUOTA_EXCEEDED'
          ? 429
          : result.code === 'TEMPLATE_NOT_APPROVED' || result.code === 'RECIPIENT_BLOCKED'
            ? 409
            : 400;
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status, errorCode: result.code });
    return jsonError(
      status,
      result.code,
      result.detail ? `${result.message} (${result.detail.join(', ')})` : result.message,
    );
  }

  const quota = await merchantMtQuota(auth.merchantId);
  await logPartnerCall({
    req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200,
    message: `mt ${result.reused ? 'reused' : result.status}`,
  });
  return jsonOk({
    id: result.id,
    status: result.status,
    reused: result.reused,
    sandbox: false,
    phoneMasked: result.phoneMasked,
    body: result.bodyMasked,
    quota,
  });
}
