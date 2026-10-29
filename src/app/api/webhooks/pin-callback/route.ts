import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env, isLocal } from '@/lib/env';
import { safeEqual } from '@/lib/crypto';
import { logger, scrub } from '@/lib/logger';
import { completePinAuthorization, failPinAuthorization } from '@/server/services/pin-authorization';
import { isMockPaymentAllowed } from '@/server/mock-guard';
import { clientIpFromRequest, consumeRateLimit, isAllowedIp } from '@/server/rate-limit';
import { readTextWithLimit } from '@/server/request-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PIN 인증 완료 콜백 (결제사 → 기브싸인).
 *
 * 후원자가 결제사 화면에서 PIN 을 입력하면 결제사가 이 엔드후원금를 호출하고,
 * 그때 비로소 승인(출금)이 실행된다. 브라우저 리턴이 오지 않아도
 * 이 서버 통지만으로 결제가 마무리되어야 한다.
 *
 * 처리 순서
 *  1) 본문 크기 제한 → 원문 보존(WebhookLog)
 *  2) 서명 검증 (현재는 X-Pin-Secret 공유 비밀. TODO: 실연동 시 결제사 서명으로 교체)
 *  3) 결과코드 검증 → 성공 코드가 아니면 인증 실패로 확정(승인하지 않는다)
 *  4) 인증 세션 확인 + 멱등 처리 → executePayment
 *  5) 재전송 폭주를 막기 위해 처리 결과는 200 으로 응답한다.
 *     (서명 실패만 401 로 명확히 거절한다)
 *
 * Mock 단계에서는 모의 PIN 화면(/mock/pg/pin)과 수동 테스트가 이 엔드후원금를 사용한다.
 */

/** 콜백 본문은 아무리 커도 수 KB 다. 인증 전 단계이므로 과도한 본문은 기록 없이 거절한다. */
const MAX_BODY_BYTES = 16 * 1024;

interface PinCallbackBody {
  sessionId?: unknown;
  chargeId?: unknown;
  resultCode?: unknown;
  resultMessage?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * 콜백 인증.
 *
 * TODO(계약 후): 결제사 규격의 서명(해시) 검증으로 교체한다.
 *                지금은 공유 비밀(X-Pin-Secret) 대조만 수행하는 mock 단계다.
 *
 * 2중 방어
 *  1) 발신 IP 허용목록(PIN_CALLBACK_IPS) — 비밀이 유출돼도 아무 데서나 통지할 수 없게 한다.
 *  2) 공유 비밀(X-Pin-Secret) — 같은 망 안에서의 위조를 막는다.
 *
 * 두 값 모두 비어 있으면 로컬에서만 통과시킨다.
 * 운영/스테이징에서 설정이 없으면 어떤 콜백도 받지 않는다(fail-closed).
 */
function verifyCallback(headerSecret: string | null, ip: string | undefined): { ok: boolean; reason?: string } {
  // (1) 발신 IP
  if (env.payment.pinCallbackIps.length > 0) {
    if (!ip) return { ok: false, reason: '발신 IP 를 확인할 수 없습니다.' };
    if (!isAllowedIp(ip, env.payment.pinCallbackIps)) {
      return { ok: false, reason: `허용되지 않은 IP: ${ip}` };
    }
  } else if (!isLocal) {
    return { ok: false, reason: 'PIN_CALLBACK_IPS 미설정 (운영 환경에서는 IP 허용목록이 필수입니다)' };
  }

  // (2) 공유 비밀
  const expected = env.payment.pinCallbackSecret;
  if (!expected) {
    if (isLocal) return { ok: true };
    return { ok: false, reason: 'PAYMENT_PIN_CALLBACK_SECRET 미설정' };
  }
  if (!headerSecret) return { ok: false, reason: 'X-Pin-Secret 헤더 없음' };
  return safeEqual(expected, headerSecret) ? { ok: true } : { ok: false, reason: '공유 비밀 불일치' };
}

/**
 * 결과코드 판정.
 *
 * PAYMENT_PIN_SUCCESS_CODES 에 없는 코드는 인증 실패로 본다. 결제사가 실패를 통지했는데
 * 승인으로 넘어가면 인증되지 않은 출금이 일어난다.
 *
 * 결과코드가 아예 없는 요청은 mock 어댑터 환경(모의 PIN 화면, 수동 테스트)에서만 성공으로
 * 인정한다. 실제 결제사가 연결된 환경에서는 코드 없는 통지를 신뢰하지 않는다(fail-closed).
 */
function verifyResultCode(code: string | null): { ok: boolean; reason?: string } {
  if (!code) {
    return isMockPaymentAllowed()
      ? { ok: true }
      : { ok: false, reason: 'resultCode 가 없습니다.' };
  }
  return env.payment.pinSuccessCodes.includes(code.toUpperCase())
    ? { ok: true }
    : { ok: false, reason: `성공 코드가 아닙니다 (resultCode=${code})` };
}

export async function POST(req: Request) {
  const started = Date.now();
  // 길이 헤더가 없는 chunked 요청도 상한을 넘는 순간 끊는다(전부 읽은 뒤 재면 이미 늦다).
  const body = await readTextWithLimit(req, MAX_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ ok: false, message: '요청 본문이 너무 큽니다.' }, { status: 413 });
  }
  const raw = body.text;

  const headerMap: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headerMap[k.toLowerCase()] = v;
  });
  // 발신 IP 는 신뢰 프록시가 붙인 **마지막** 홉만 쓴다.
  // 첫 홉은 클라이언트가 직접 써 넣는 값이라, 허용 IP 를 헤더에 적기만 하면
  // 허용목록 검사를 그대로 통과한다(2중 방어가 시크릿 하나로 줄어든다).
  const ip = clientIpFromRequest(req) ?? undefined;

  const verified = verifyCallback(headerMap['x-pin-secret'] ?? null, ip);

  // 검증에 실패한 요청도 기록은 남긴다(누가 두드렸는지 봐야 한다).
  // 다만 인증 없이 로그 테이블을 채울 수 있으면 그 자체가 공격 통로가 되므로,
  // 실패 건은 발신 IP 당 횟수를 제한한다. 넘어선 요청은 기록 없이 그대로 거절한다.
  if (!verified.ok) {
    const quota = await consumeRateLimit('pin-callback-reject', ip, 20, 600);
    if (!quota.ok) {
      logger.warn('PIN 콜백 검증 실패 폭주 — 기록 없이 거절', { ip, count: quota.count });
      return NextResponse.json({ ok: false, message: '인증되지 않은 요청입니다.' }, { status: 401 });
    }
  }

  let parsed: PinCallbackBody = {};
  try {
    parsed = JSON.parse(raw) as PinCallbackBody;
  } catch {
    parsed = {};
  }

  const logRow = await prisma.webhookLog.create({
    data: {
      id: newId(),
      source: 'PIN_CALLBACK',
      endpoint: '/api/webhooks/pin-callback',
      headersMask: scrub(headerMap) as object,
      bodyMasked: scrub(parsed) as object,
      signatureOk: verified.ok,
      ip: ip ?? null,
    },
  });

  const finish = async (statusCode: number, note: string, body: Record<string, unknown>) => {
    await prisma.webhookLog.update({
      where: { id: logRow.id },
      data: { statusCode, responseNote: note.slice(0, 500), latencyMs: Date.now() - started },
    });
    return NextResponse.json(body, { status: statusCode });
  };

  if (!verified.ok) {
    logger.warn('PIN 콜백 서명 검증 실패', { reason: verified.reason, ip });
    return finish(401, verified.reason ?? '서명 검증 실패', { ok: false, message: '인증되지 않은 요청입니다.' });
  }

  const sessionId = str(parsed.sessionId);
  const chargeId = str(parsed.chargeId);
  if (!sessionId && !chargeId) {
    return finish(400, 'sessionId/chargeId 없음', {
      ok: false,
      message: 'sessionId 또는 chargeId 가 필요합니다.',
    });
  }

  const resultCode = str(parsed.resultCode);
  const resultMessage = str(parsed.resultMessage);

  try {
    // 결제사가 실패를 통지한 건은 절대 승인 단계로 넘기지 않는다.
    const verdict = verifyResultCode(resultCode);
    if (!verdict.ok) {
      const failed = await failPinAuthorization(
        { sessionId, chargeId },
        [verdict.reason, resultMessage].filter(Boolean).join(' / '),
      );
      logger.warn('PIN 콜백 - 인증 실패 통지', { reason: verdict.reason, code: failed.code });
      return finish(200, failed.code, {
        ok: false,
        code: failed.code,
        status: failed.status ?? null,
        message: failed.message,
      });
    }

    const result = await completePinAuthorization({
      sessionId,
      chargeId,
      resultCode,
      resultMessage,
    });
    return finish(200, result.code, {
      ok: result.ok,
      code: result.code,
      status: result.status ?? null,
      message: result.message,
    });
  } catch (e) {
    logger.error('PIN 콜백 처리 오류', { message: (e as Error).message });
    // 결제사에는 200 으로 응답하되 내부적으로 오류를 남긴다(재전송 폭주 방지).
    return finish(200, `ERROR: ${(e as Error).message}`, {
      ok: false,
      message: '수신은 되었으나 처리에 실패했습니다.',
    });
  }
}
