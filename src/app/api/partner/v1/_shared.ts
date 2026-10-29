import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { clientIpFromRequest } from '@/server/rate-limit';
import type { PartnerAuthFail } from '@/server/services/partner-auth';

/**
 * 사회복지기관 연동 API 공통 응답 형식.
 *
 * 성공: { ok: true, ...data }
 * 실패: { ok: false, code, message }
 *
 * code 는 기계가 분기할 값이고 message 는 사람이 읽을 값이다.
 * 사회복지기관 서버가 code 로 분기할 수 있도록 문자열을 바꾸지 않는다.
 */

export function jsonOk(data: Record<string, unknown>, status = 200) {
  return NextResponse.json({ ok: true, ...data }, { status });
}

export function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, code, message }, { status });
}

export function authError(result: PartnerAuthFail) {
  return jsonError(result.status, result.code, result.message);
}

/**
 * 호출 기록.
 *
 * 연동을 붙이는 동안 무엇이 왜 실패했는지 사회복지기관이 스스로 봐야 한다.
 * 지금까지는 키의 마지막 사용 시각만 남아 있어서, 401 이 나면 원인을 물어볼 수밖에 없었다.
 *
 * 응답 본문은 남기지 않는다(개인정보). 상태 코드와 오류 코드만 남긴다.
 * 기록 실패가 API 응답을 막지 않도록 예외를 삼킨다.
 */
export async function logPartnerCall(input: {
  req: Request;
  merchantId: string | null;
  keyId?: string | null;
  status: number;
  errorCode?: string | null;
  message?: string | null;
}): Promise<void> {
  if (!input.merchantId) return;
  try {
    const url = new URL(input.req.url);
    await prisma.merchantApiCallLog.create({
      data: {
        id: newId(),
        merchantId: input.merchantId,
        keyId: input.keyId ?? null,
        method: input.req.method.toUpperCase(),
        path: `${url.pathname}${url.search}`.slice(0, 300),
        status: input.status,
        errorCode: input.errorCode ?? null,
        message: input.message?.slice(0, 300) ?? null,
        ip: clientIpFromRequest(input.req),
      },
    });
  } catch (e) {
    logger.warn('연동 API 호출 기록 실패', { message: (e as Error).message });
  }
}

/**
 * 배송지 원문 열람 기록.
 *
 * 콘솔은 배송지를 열어 볼 때마다 감사 로그(SHIPMENT_ADDRESS_VIEW)를 남긴다(CLAUDE.md 규칙).
 * API 로 내려주는 것도 같은 열람이므로 같은 기록을 남긴다. 호출 로그(merchantApiCallLog)는
 * "어떤 경로를 몇 번 불렀나"만 남아서, 유출 사고 때 어느 주문의 주소가 나갔는지 답할 수 없다.
 *
 * 기록 실패가 응답을 막지 않도록 예외를 삼킨다.
 */
export async function logShippingReveal(input: {
  req: Request;
  merchantId: string;
  keyId?: string | null;
  transactionNos: string[];
}): Promise<void> {
  if (input.transactionNos.length === 0) return;
  try {
    await prisma.adminAuditLog.create({
      data: {
        id: newId(),
        adminId: null,
        action: 'SHIPMENT_ADDRESS_VIEW',
        targetType: 'charge_shipment',
        targetId: null,
        beforeValue: null as unknown as object,
        afterValue: {
          by: 'partner-api',
          merchantId: input.merchantId,
          keyId: input.keyId ?? null,
          count: input.transactionNos.length,
          // 건수가 많을 수 있으므로 앞쪽만 남긴다. 어느 회차였는지 좁히는 데는 충분하다.
          transactionNos: input.transactionNos.slice(0, 50),
        } as object,
        ip: clientIpFromRequest(input.req),
        userAgent: input.req.headers.get('user-agent') ?? null,
      },
    });
  } catch (e) {
    logger.warn('배송지 열람 감사 기록 실패', { message: (e as Error).message });
  }
}

/**
 * 샌드박스 전용 라우트 가드.
 *
 * 운영 키로 샌드박스를 호출하면 막는다.
 */
export function sandboxOnly(mode: 'LIVE' | 'TEST') {
  if (mode === 'TEST') return null;
  return jsonError(
    403,
    'TEST_KEY_REQUIRED',
    '샌드박스는 테스트 키(gs_test_)로만 호출할 수 있습니다. 후원 설정 → 연동 탭에서 테스트 키를 발급해 주세요.',
  );
}

/**
 * 운영 전용 라우트 가드.
 *
 * 테스트 키(gs_test_)로는 운영 데이터를 **읽지도 쓰지도** 못한다.
 *
 * 이 가드가 없으면 "테스트 키니까 안전하겠지" 하고 돌린 연동 스크립트가 운영 상품을
 * 지우고 운영 웹훅을 갈아 끼운다. 샌드박스는 운영과 완전히 분리된 공간이어야 하고,
 * 그 경계는 라우트마다 기억하는 것이 아니라 이 한 줄로 강제한다.
 *
 * 테스트 키로 쓸 수 있는 것은 세 가지뿐이다.
 *  1) /sandbox/* — 샌드박스 전용 테이블(sandbox_charge · sandbox_message)만 쓴다.
 *  2) /charges, /mt/* — 라우트 안에서 mode 를 보고 샌드박스 쪽으로 갈라진다.
 *  3) /ping, /openapi.json, GET /mt/templates — 데이터가 아니라 설정·규격이다.
 */
export function liveOnly(mode: 'LIVE' | 'TEST') {
  if (mode === 'LIVE') return null;
  return jsonError(
    403,
    'LIVE_KEY_REQUIRED',
    '테스트 키(gs_test_)로는 호출할 수 없는 API 입니다. 운영 키(gs_live_)를 사용하시고, 테스트는 /sandbox/* 와 문자 발송 API 로 진행해 주세요.',
  );
}

/**
 * 운영 전용 가드 + 호출 기록을 한 번에 처리한다.
 *
 * 라우트마다 로그 남기는 것을 잊지 않도록 묶어 둔다.
 * 통과하면 null, 막히면 그대로 return 할 응답을 돌려준다.
 */
export async function denyTestKey(
  req: Request,
  auth: { mode: 'LIVE' | 'TEST'; merchantId: string; keyId?: string | null },
): Promise<NextResponse | null> {
  const denied = liveOnly(auth.mode);
  if (!denied) return null;
  await logPartnerCall({
    req,
    merchantId: auth.merchantId,
    keyId: auth.keyId ?? null,
    status: 403,
    errorCode: 'LIVE_KEY_REQUIRED',
  });
  return denied;
}
