import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { executePayment, setStatus } from './charge-flow';
import type { ChargeStatus } from '@/generated/prisma/enums';

/**
 * PIN 인증 완료 처리 / 만료 정리.
 *
 * 흐름상 위치
 *   MO 수신 → 결제 생성 → (charge-flow) startPinAuthorization → 후원자 PIN 입력
 *   → 결제사 콜백 → **이 파일** → executePayment → 결제 완료
 *
 * 절대 원칙
 *  1) 콜백이 몇 번 들어와도 결제는 한 번만 일어난다.
 *     세션 행을 `PENDING → COMPLETED` 로 **원자적으로 선점**한 요청만 승인 단계로 넘어간다.
 *  2) 만료된 인증은 승인하지 않는다. 시간이 지난 링크로는 결제되지 않는다.
 *  3) 인증 세션이 없거나 결제 상태가 PIN 대기가 아니면 아무것도 하지 않는다.
 */

export interface PinCallbackInput {
  /** 결제사 인증 세션 ID. 있으면 이 값을 우선 사용한다. */
  sessionId?: string | null;
  /** 결제 거래 ID. Mock 수동 테스트에서는 이 값만으로도 처리할 수 있다. */
  chargeId?: string | null;
  /** 결제사가 보낸 결과 코드/메시지 (감사 기록용) */
  resultCode?: string | null;
  resultMessage?: string | null;
}

export type PinCallbackCode =
  | 'OK'
  | 'DUPLICATE'
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'INVALID_STATE'
  /** 결제사가 PIN 인증 실패를 통지한 경우(결과코드가 성공이 아님) */
  | 'AUTH_FAILED'
  | 'PAYMENT_FAILED';

export interface PinCallbackResult {
  ok: boolean;
  code: PinCallbackCode;
  chargeId?: string;
  status?: ChargeStatus;
  message: string;
}

async function findSession(input: PinCallbackInput) {
  if (input.sessionId) {
    return prisma.paymentPinSession.findUnique({ where: { sessionId: input.sessionId } });
  }
  if (input.chargeId) {
    return prisma.paymentPinSession.findUnique({ where: { chargeId: input.chargeId } });
  }
  return null;
}

/**
 * 결제사 PIN 완료 통지를 받아 결제를 승인한다.
 *
 * 성공/실패와 무관하게 콜백 수신 횟수는 세션에 누적 기록한다(중복 통지 추적용).
 */
export async function completePinAuthorization(input: PinCallbackInput): Promise<PinCallbackResult> {
  const session = await findSession(input);
  if (!session) {
    return { ok: false, code: 'NOT_FOUND', message: '인증 세션을 찾을 수 없습니다.' };
  }

  const charge = await prisma.charge.findUnique({
    where: { id: session.chargeId },
    select: { id: true, status: true },
  });
  if (!charge) {
    return { ok: false, code: 'NOT_FOUND', message: '결제 거래를 찾을 수 없습니다.' };
  }

  // (1) 이미 끝난 세션 — 결제를 다시 실행하지 않는다.
  //     어느 사유로 끝났는지 구분해서 돌려줘야 결제사·운영자가 원인을 알 수 있다.
  if (session.status !== 'PENDING') {
    await prisma.paymentPinSession.update({
      where: { id: session.id },
      data: { callbackCount: { increment: 1 }, lastCallbackAt: new Date() },
    });
    logger.info('PIN 콜백 재수신 — 결제는 재실행하지 않습니다.', {
      chargeId: session.chargeId,
      sessionStatus: session.status,
    });

    if (session.status === 'EXPIRED') {
      return {
        ok: false,
        code: 'EXPIRED',
        chargeId: session.chargeId,
        status: charge.status,
        message: 'PIN 입력 시간이 지나 결제가 취소되었습니다. 결제는 진행되지 않았습니다.',
      };
    }
    if (session.status === 'FAILED') {
      return {
        ok: false,
        code: 'INVALID_STATE',
        chargeId: session.chargeId,
        status: charge.status,
        message: '진행할 수 없는 인증 요청입니다. 결제는 진행되지 않았습니다.',
      };
    }
    return {
      ok: true,
      code: 'DUPLICATE',
      chargeId: session.chargeId,
      status: charge.status,
      message: '이미 처리된 인증입니다. 결제는 한 번만 이루어집니다.',
    };
  }

  // (2) 만료 — 시간이 지난 인증으로는 출금하지 않는다.
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.paymentPinSession.updateMany({
      where: { id: session.id, status: 'PENDING' },
      data: {
        status: 'EXPIRED',
        callbackCount: { increment: 1 },
        lastCallbackAt: new Date(),
        resultNote: '유효시간 경과 후 도착한 콜백',
      },
    });
    if (charge.status === 'PENDING_PIN') {
      await setStatus(session.chargeId, 'PAYMENT_FAILED', 'PIN 입력 시간 초과로 자동 취소');
    }
    return {
      ok: false,
      code: 'EXPIRED',
      chargeId: session.chargeId,
      status: 'PAYMENT_FAILED',
      message: 'PIN 입력 시간이 지나 결제가 취소되었습니다. 결제는 진행되지 않았습니다.',
    };
  }

  // (3) 결제 상태 확인 — PIN 대기 상태가 아니면 승인하지 않는다.
  if (charge.status !== 'PENDING_PIN') {
    await prisma.paymentPinSession.update({
      where: { id: session.id },
      data: { callbackCount: { increment: 1 }, lastCallbackAt: new Date() },
    });
    return {
      ok: false,
      code: 'INVALID_STATE',
      chargeId: session.chargeId,
      status: charge.status,
      message: '결제를 진행할 수 없는 상태의 결제입니다.',
    };
  }

  // (4) 선점 — 동시에 두 개의 콜백이 들어와도 여기서 한쪽만 통과한다.
  //     이 갱신에 성공한 요청만 executePayment 를 호출하므로 이중 출금이 생기지 않는다.
  const claimed = await prisma.paymentPinSession.updateMany({
    where: { id: session.id, status: 'PENDING' },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      lastCallbackAt: new Date(),
      callbackCount: { increment: 1 },
      resultNote: input.resultMessage ?? null,
    },
  });
  if (claimed.count !== 1) {
    return {
      ok: true,
      code: 'DUPLICATE',
      chargeId: session.chargeId,
      status: charge.status,
      message: '이미 처리된 인증입니다. 결제는 한 번만 이루어집니다.',
    };
  }

  // (5) 승인. 한도 재검사·멱등·정산 분개는 모두 executePayment 안에서 처리된다.
  //
  // executePayment 가 값으로 실패를 돌려주지 않고 **예외를 던지면**(DB 장애 등) 세션은
  // 이미 COMPLETED 로 선점돼 있고 결제는 PENDING_PIN 에 남는다. 후원자는 다시 인증할 수 없고
  // (선점 때문에 재통지가 DUPLICATE 로 걸린다) 관리자 대사도 닿지 않아 영영 멈춘다.
  // 승인 자체가 시작되지 않았으므로 세션을 되돌려 다시 시도할 수 있게 만든다.
  let paid: Awaited<ReturnType<typeof executePayment>>;
  try {
    paid = await executePayment(session.chargeId);
  } catch (e) {
    await prisma.paymentPinSession
      .updateMany({
        where: { id: session.id, status: 'COMPLETED' },
        data: {
          status: 'PENDING',
          completedAt: null,
          resultNote: `승인 처리 중 오류: ${(e as Error).message}`.slice(0, 500),
        },
      })
      .catch(() => undefined);
    logger.error('PIN 승인 처리 중 예외 — 인증 세션을 되돌립니다', {
      sessionId: session.id, chargeId: session.chargeId, message: (e as Error).message,
    });
    return {
      ok: false,
      code: 'PAYMENT_FAILED',
      chargeId: session.chargeId,
      status: charge.status,
      message: '결제를 처리하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    };
  }

  if (!paid.ok) {
    await prisma.paymentPinSession.update({
      where: { id: session.id },
      data: { resultNote: `승인 실패: ${paid.message}`.slice(0, 500) },
    });
    return {
      ok: false,
      code: 'PAYMENT_FAILED',
      chargeId: session.chargeId,
      status: paid.status,
      message: paid.message,
    };
  }

  return {
    ok: true,
    code: 'OK',
    chargeId: session.chargeId,
    status: paid.status,
    message: paid.message,
  };
}

/**
 * 결제사가 **PIN 인증 실패**를 통지한 경우.
 *
 * 성공 통지(completePinAuthorization)와 대칭되는 경로다. 승인(출금)은 절대 실행하지 않고
 * 인증 세션과 결제를 실패로 확정한다. 후원자에게는 별도 문자를 보내지 않는다
 * (결제사 화면에서 이미 실패를 봤고, 문자가 또 가면 이중 청구로 오해할 수 있다).
 *
 * 선점(updateMany)에 성공한 요청만 상태를 바꾸므로 중복 통지에도 안전하다.
 */
export async function failPinAuthorization(
  input: PinCallbackInput,
  note: string,
): Promise<PinCallbackResult> {
  const session = await findSession(input);
  if (!session) {
    return { ok: false, code: 'NOT_FOUND', message: '인증 세션을 찾을 수 없습니다.' };
  }

  const charge = await prisma.charge.findUnique({
    where: { id: session.chargeId },
    select: { id: true, status: true },
  });
  if (!charge) {
    return { ok: false, code: 'NOT_FOUND', message: '결제 거래를 찾을 수 없습니다.' };
  }

  // 이미 끝난 세션은 다시 건드리지 않는다. 특히 COMPLETED 는 이미 승인이 끝났을 수 있어
  // 여기서 실패로 덮으면 출금된 건이 실패로 기록된다.
  if (session.status !== 'PENDING') {
    await prisma.paymentPinSession.update({
      where: { id: session.id },
      data: { callbackCount: { increment: 1 }, lastCallbackAt: new Date() },
    });
    logger.warn('이미 종료된 인증 세션에 실패 통지가 도착했습니다.', {
      chargeId: session.chargeId,
      sessionStatus: session.status,
    });
    return {
      ok: false,
      code: 'INVALID_STATE',
      chargeId: session.chargeId,
      status: charge.status,
      message: '이미 처리된 인증 요청입니다.',
    };
  }

  const claimed = await prisma.paymentPinSession.updateMany({
    where: { id: session.id, status: 'PENDING' },
    data: {
      status: 'FAILED',
      lastCallbackAt: new Date(),
      callbackCount: { increment: 1 },
      resultNote: note.slice(0, 500),
    },
  });
  if (claimed.count !== 1) {
    return {
      ok: false,
      code: 'DUPLICATE',
      chargeId: session.chargeId,
      status: charge.status,
      message: '이미 처리된 인증입니다.',
    };
  }

  if (charge.status === 'PENDING_PIN') {
    // setStatus 를 거쳐야 ChargeStatusLog 감사 이력이 남는다
    await setStatus(session.chargeId, 'PAYMENT_FAILED', `PIN 인증 실패: ${note}`.slice(0, 500));
  }

  logger.warn('PIN 인증 실패 통지', { chargeId: session.chargeId, note });
  return {
    ok: false,
    code: 'AUTH_FAILED',
    chargeId: session.chargeId,
    status: 'PAYMENT_FAILED',
    message: 'PIN 인증에 실패했습니다. 결제는 진행되지 않았습니다.',
  };
}

/**
 * 인증 세션 한 건이 만료됐으면 그 자리에서 취소 처리한다.
 *
 * 배치가 돌기 전이라도 대기 화면(웹 결제 폴링)이 만료를 즉시 보여줄 수 있어야 한다.
 * 선점(updateMany)에 성공한 호출만 결제 상태를 바꾸므로 중복 실행돼도 안전하다.
 *
 * @returns 이 호출이 실제로 만료 처리했으면 true
 */
export async function expirePinSessionIfStale(chargeId: string, now = new Date()): Promise<boolean> {
  const session = await prisma.paymentPinSession.findUnique({
    where: { chargeId },
    select: { id: true, status: true, expiresAt: true },
  });
  if (!session || session.status !== 'PENDING' || session.expiresAt.getTime() >= now.getTime()) return false;

  const claimed = await prisma.paymentPinSession.updateMany({
    where: { id: session.id, status: 'PENDING' },
    data: { status: 'EXPIRED', resultNote: 'PIN 입력 시간 초과' },
  });
  if (claimed.count !== 1) return false;

  const d = await prisma.charge.findUnique({ where: { id: chargeId }, select: { status: true } });
  // 이미 결제로 넘어간 건(PENDING_PAYMENT 이후)은 건드리지 않는다.
  if (d?.status !== 'PENDING_PIN') return false;
  // setStatus 를 거쳐야 ChargeStatusLog 감사 이력이 남는다
  await setStatus(chargeId, 'PAYMENT_FAILED', 'PIN 입력 시간 초과로 자동 취소');
  return true;
}

/**
 * 만료된 PIN 인증 대기 건 정리 (배치).
 *
 * PIN 을 입력하지 않은 결제는 자동 취소한다. 출금이 없었으므로 원장 분개도 없고,
 * 이미 결제로 넘어간 건(PENDING_PAYMENT 이후)은 건드리지 않는다.
 * 취소 안내 문자는 보내지 않는다 — 일부러 입력하지 않은 사람에게 문자가 또 가면 스팸이 된다.
 */
export async function expireStalePinSessions(now = new Date()): Promise<number> {
  const stale = await prisma.paymentPinSession.findMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    select: { chargeId: true },
  });

  let count = 0;
  for (const s of stale) {
    if (await expirePinSessionIfStale(s.chargeId, now)) count += 1;
  }
  return count;
}
