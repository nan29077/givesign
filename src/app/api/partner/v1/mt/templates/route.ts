import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { MERCHANT_MT_MAX_LENGTH, upsertMerchantTemplate } from '@/server/services/merchant-mt';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TemplateBody {
  code?: string;
  name?: string;
  body?: string;
}

/**
 * GET /api/partner/v1/mt/templates
 * 등록된 템플릿과 상태, 그리고 발송 때 채워야 하는 치환자 목록.
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

  // 템플릿은 운영·테스트가 같은 것을 쓴다. 테스트로 검증한 문구를 그대로 운영에 쓰기 위해서다.
  const rows = await prisma.merchantMtTemplate.findMany({
    where: { merchantId: auth.merchantId },
    orderBy: { createdAt: 'desc' },
  });

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `items=${rows.length}` });
  return jsonOk({
    items: rows.map((t) => ({
      code: t.code,
      name: t.name,
      body: t.body,
      variables: t.variables ? t.variables.split(',').filter(Boolean) : [],
      status: t.status,
      reviewNote: t.reviewNote,
      sentCount: t.sentCount,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
  });
}

/**
 * POST /api/partner/v1/mt/templates
 *
 * 템플릿을 등록하거나 본문을 바꾼다. 검수는 이때 한 번만 한다.
 * 자동 검사를 통과하면 바로 승인되고, 광고성 표현이나 금칙어가 걸리면
 * 검수 대기(PENDING)로 저장되어 사람이 본다.
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

  // 목록 조회는 테스트 키도 되지만(샌드박스 발송에 같은 템플릿을 쓴다) 등록·수정은 운영 키만.
  // 템플릿은 승인되면 운영 발송에 그대로 쓰이는 설정이므로, 테스트 키로 바꿀 수 있으면 안 된다.
  const testDenied = await denyTestKey(req, auth);
  if (testDenied) return testDenied;

  let body: TemplateBody;
  try {
    body = JSON.parse(rawBody || '{}') as TemplateBody;
  } catch {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_JSON',
    }).then(() => jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.'));
  }

  const code = String(body.code ?? '').trim();
  const text = String(body.body ?? '');
  if (!code || !text) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_ITEMS',
    }).then(() => jsonError(400, 'INVALID_ITEMS', `code 와 body 가 필요합니다. body 는 ${MERCHANT_MT_MAX_LENGTH}자 이내입니다.`));
  }

  const result = await upsertMerchantTemplate({
    merchantId: auth.merchantId,
    code,
    name: String(body.name ?? code),
    body: text,
  });

  if (!result.ok) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'TEMPLATE_REJECTED' });
    return jsonError(400, 'TEMPLATE_REJECTED', result.message);
  }

  await logPartnerCall({
    req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200,
    message: `template ${code} ${result.template.status}`,
  });
  return jsonOk({
    code: result.template.code,
    name: result.template.name,
    status: result.template.status,
    variables: result.template.variables ? result.template.variables.split(',').filter(Boolean) : [],
    reviewNote: result.template.reviewNote,
    // 승인되지 않았으면 아직 발송에 쓸 수 없다는 것을 분명히 알려 준다.
    usable: result.template.status === 'APPROVED',
  });
}
