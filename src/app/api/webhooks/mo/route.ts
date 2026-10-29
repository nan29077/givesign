import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger, scrub } from '@/lib/logger';
import { getMoAdapter } from '@/server/adapters/mo';
import { handleMoInbound } from '@/server/services/charge-flow';
import { clientIpFromRequest, consumeRateLimit } from '@/server/rate-limit';
import { readTextWithLimit } from '@/server/request-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * MO 사업자 Webhook 수신 엔드포인트.
 *
 * 처리 순서
 *  0) IP 단위 속도 제한 (인증 전 단계이므로 본문을 읽기 전에 센다)
 *  1) 서명/IP 검증 — **실패하면 DB 에 아무것도 남기지 않고 401**
 *  2) 검증을 통과한 요청만 원문 보존(WebhookLog)
 *  3) 사업자 payload 정규화
 *  4) 결제 흐름 실행 (중복/미등록/한도/금칙어 처리 포함)
 *  5) 항상 200 으로 응답해 사업자 재전송 폭주를 막고, 실패는 내부 상태로 관리한다.
 *
 * 검증 실패를 기록하지 않는 이유
 * -----------------------------
 * 이 엔드포인트는 인증 없이 누구나 두드릴 수 있다. 검증 결과와 무관하게 원문을 저장하면
 * 요청을 퍼붓는 것만으로 WebhookLog 가 무한히 커진다(저장 공격). 거절 사유는 로그로만 남긴다.
 */
/** MO 문자 본문은 길어야 수 KB 다. 인증 전 단계이므로 과도한 본문은 기록 없이 거절한다. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 인증 전 단계의 IP 단위 속도 제한.
 *
 * 예전에는 검증 결과와 무관하게 WebhookLog 를 먼저 만들었다. 그 구조에서는 아무나
 * 이 엔드포인트에 요청을 퍼부어 원문(headersMask/bodyMasked JSON)을 DB 에 무한히 쌓을 수 있다.
 * 인증되지 않은 요청은 **저장하지 않고**, 대신 여기서 횟수만 센다.
 *
 * 상한은 **정상 사업자가 절대 닿지 않는 값**으로 잡는다. 캠페인이 몰리는 시간대의 실제
 * MO 유입을 여기서 끊으면 결제 요청이 통째로 유실되고, 사업자 재전송으로 더 밀린다.
 * 이 값은 "정상 트래픽 조절"이 아니라 "저장 공격 차단"이 목적이다.
 */
const UNVERIFIED_MAX = 600;
const UNVERIFIED_WINDOW_SEC = 60;

export async function POST(req: Request) {
  const started = Date.now();
  // 발신 IP 는 신뢰 프록시가 붙인 **마지막** 홉만 쓴다.
  // 첫 홉은 클라이언트가 직접 써 넣는 값이라, 허용 IP 를 헤더에 적기만 하면
  // 허용목록 검사를 그대로 통과한다(2중 방어가 시크릿 하나로 줄어든다).
  const ip = clientIpFromRequest(req) ?? undefined;

  // (0) 인증 전 단계의 속도 제한. 본문을 읽기 전에 먼저 센다.
  const rate = await consumeRateLimit('mo-webhook', ip, UNVERIFIED_MAX, UNVERIFIED_WINDOW_SEC);
  if (!rate.ok) {
    logger.warn('MO Webhook 속도 제한 초과', { ip, count: rate.count });
    return NextResponse.json({ ok: false, message: '요청이 너무 많습니다.' }, { status: 429 });
  }

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

  const adapter = getMoAdapter();
  const verified = adapter.verify(raw, headerMap, ip);

  // (1) 검증 실패는 기록하지 않고 거절한다.
  //     거절 사유는 로그로만 남긴다(본문·헤더를 DB 에 남기면 그 자체가 저장 공격 통로가 된다).
  if (!verified.ok) {
    logger.warn('MO Webhook 서명 검증 실패 — 기록하지 않고 거절', { reason: verified.reason, ip });
    return NextResponse.json({ ok: false, message: '인증되지 않은 요청입니다.' }, { status: 401 });
  }

  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    parsedBody = { _raw: raw.slice(0, 2000) };
  }

  // (2) 검증을 통과한 요청만 원문을 보존한다.
  const logRow = await prisma.webhookLog.create({
    data: {
      id: newId(),
      source: 'MO',
      endpoint: '/api/webhooks/mo',
      headersMask: scrub(headerMap) as object,
      bodyMasked: scrub(parsedBody) as object,
      signatureOk: true,
      ip: ip ?? null,
    },
  });

  const finish = async (statusCode: number, note: string, body: Record<string, unknown>) => {
    await prisma.webhookLog.update({
      where: { id: logRow.id },
      data: { statusCode, responseNote: note, latencyMs: Date.now() - started },
    });
    return NextResponse.json(body, { status: statusCode });
  };

  try {
    const inbound = adapter.parse(parsedBody);
    const result = await handleMoInbound(inbound);
    return finish(200, result.result, {
      ok: true,
      result: result.result,
      status: result.status ?? null,
      message: result.message,
    });
  } catch (e) {
    logger.error('MO 처리 오류', { message: (e as Error).message });
    // 사업자에게는 200 으로 응답하되 내부적으로 오류를 남긴다(재전송 폭주 방지).
    return finish(200, `ERROR: ${(e as Error).message}`, { ok: false, message: '수신은 되었으나 처리에 실패했습니다.' });
  }
}
