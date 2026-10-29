import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { isUsableTestPhone, sandboxInjectMo, serializeSandboxCharge } from '@/server/services/sandbox';
import { authError, jsonError, jsonOk, logPartnerCall, sandboxOnly } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 테스트 결제 1건의 최대 금액. 실제 한도와 무관하지만 터무니없는 값은 막는다. */
const MAX_TEST_AMOUNT = 10_000_000n;

interface MoBody {
  from?: string;
  text?: string;
  amount?: number | string;
  productName?: string;
  productKind?: string;
}

/**
 * POST /api/partner/v1/sandbox/mo
 *
 * 후원자가 수신번호로 문자를 보낸 상황을 만든다. 통신망을 거치지 않고,
 * 실제 결제·정산 데이터에는 한 줄도 들어가지 않는다.
 *
 * 이 호출로 만들어진 건은 아직 결제 전(PENDING_PAYMENT)이다.
 * succeed / fail 로 확정해야 `/charges` 조회에 나타난다.
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

  const denied = sandboxOnly(auth.mode);
  if (denied) {
    await logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId,
      status: 403, errorCode: 'TEST_KEY_REQUIRED',
    });
    return denied;
  }

  let body: MoBody;
  try {
    body = JSON.parse(rawBody || '{}') as MoBody;
  } catch {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_JSON',
    }).then(() => jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.'));
  }

  const from = String(body.from ?? '').trim();
  if (!isUsableTestPhone(from)) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_PHONE',
    }).then(() => jsonError(400, 'INVALID_PHONE', 'from 은 휴대폰 번호 형식이어야 합니다. (예: 01012345678)'));
  }

  const text = String(body.text ?? '').trim();
  if (!text) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_TEXT',
    }).then(() => jsonError(400, 'INVALID_TEXT', 'text 가 필요합니다.'));
  }

  // 금액은 실제 흐름에서 후원자가 링크에서 고르는 값이다.
  // 샌드박스에서는 사회복지기관이 시험하려는 금액을 그대로 넣게 한다.
  const amountRaw = body.amount ?? 10000;
  const amountNum = typeof amountRaw === 'string' ? Number(amountRaw) : amountRaw;
  if (!Number.isInteger(amountNum) || amountNum <= 0 || BigInt(amountNum) > MAX_TEST_AMOUNT) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_AMOUNT',
    }).then(() => jsonError(400, 'INVALID_AMOUNT', `amount 는 1 이상 ${MAX_TEST_AMOUNT} 이하의 정수여야 합니다.`));
  }

  const kindRaw = String(body.productKind ?? '').toUpperCase();
  const productKind = kindRaw === 'PHYSICAL' ? 'PHYSICAL' : kindRaw === 'DIGITAL' ? 'DIGITAL' : null;

  const merchant = await prisma.merchantProfile.findUnique({
    where: { id: auth.merchantId },
    select: { displayName: true },
  });

  const row = await sandboxInjectMo({
    merchantId: auth.merchantId,
    merchantName: merchant?.displayName ?? '사회복지기관',
    phone: from,
    text,
    amount: BigInt(amountNum),
    productName: body.productName ? String(body.productName).slice(0, 60) : null,
    productKind,
  });

  await logPartnerCall({
    req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200,
    message: `sandbox mo -> ${row.transactionNo}`,
  });

  return jsonOk({ charge: serializeSandboxCharge(row) });
}
