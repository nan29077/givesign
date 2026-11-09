import { logger } from '@/lib/logger';
import { runCronJob, CRON_HTTP_STATUS } from '@/server/cron';
import { expireStaleESignRequests } from '@/server/services/agreements';
import { expireStalePinSessions } from '@/server/services/pin-authorization';
import { expireStaleConfirmations, expireStaleAmountSelections } from '@/server/services/charge-confirm';
import { purgeExpiredIdempotencyKeys } from '@/server/services/idempotency';
import { purgeExpiredResetTokens } from '@/server/services/password-reset';
import { closeOrphanPreparedCharges, escalateStalePaymentTransactions } from '@/server/services/payment-recovery';
import { expireStaleCardSessions } from '@/server/services/card-payment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 정리 배치 (외부 스케줄러 → 기브싸인).
 *
 * AWS EventBridge Scheduler 등에서 **1분 간격**으로 호출한다.
 *   GET /api/cron/cleanup
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 하는 일
 *  1) expireStalePinSessions      — PIN 을 입력하지 않아 TTL 이 지난 결제를 자동 취소한다.
 *                                   (결제사 콜백이 오지 않은 PENDING_PIN 건의 보정 경로이기도 하다)
 *  2) expireStaleConfirmations    — 구 확인 링크(CONFIRM_LINK) 만료 건을 자동 취소한다.
 *  2-1) expireStaleAmountSelections — 금액선택 링크(SELECT_AMOUNT) 만료 건을 자동 취소한다.
 *  3) purgeExpiredIdempotencyKeys — 만료된 멱등키를 지운다.
 *  4) purgeExpiredResetTokens     — 만료된 비밀번호 재설정 토큰을 지운다.
 *  5) escalateStalePaymentTransactions — 결과가 기록되지 않은 채 오래된 결제 거래(REQUESTED·TIMEOUT)를
 *                                   UNKNOWN 으로 올려 관리자 대사 큐로 보낸다(실패로 확정하지 않는다).
 *  6) closeOrphanPreparedCharges  — 결제 거래 없이 RECEIVED·PENDING_PIN(진행 중 세션 없음)에 남은
 *                                   고아 결제를 출금 없는 실패로 닫는다.
 *  7) expireStaleESignRequests    — 오래 응답이 없는 약정서 전자서명 요청(REQUESTED)을 EXPIRED 로 닫는다.
 *
 * 원칙
 *  - 인증은 fail-closed. 비밀이 없으면 로컬에서만 통과한다.
 *  - 각 작업은 서로 독립이다. 하나가 실패해도 나머지는 계속 수행하고, 결과를 각각 돌려준다.
 *  - 출금을 일으키는 일은 하지 않는다. 만료 취소는 결제 이전 단계의 상태 전이일 뿐이다.
 *    출금이 있었을 수 있는 건은 실패로 닫지 않고 대사 큐로만 보낸다.
 *  - 겹쳐 도는 것을 막기 위해 짧은 실행 잠금을 잡는다(runCronJob — 소유자 확인 후 해제). setStatus 는
 *    원자적 선점이 아니라 동시에 두 번 돌면 같은 건에 상태 로그가 두 줄 남을 수 있기 때문이다.
 */

/** 잠금 유지 시간. 배치 1회는 수백 ms 안에 끝나지만 DB 지연을 감안해 넉넉히 잡는다. */
const LOCK_TTL_SEC = 55;

interface StepResult {
  ok: boolean;
  count: number;
  error?: string;
}

/** 한 단계 실행. 실패해도 예외를 밖으로 내보내지 않는다(다음 단계를 막지 않기 위함). */
async function step(name: string, fn: () => Promise<number>): Promise<StepResult> {
  const started = Date.now();
  try {
    const count = await fn();
    if (count > 0) logger.info(`정리 배치: ${name}`, { count, latencyMs: Date.now() - started });
    return { ok: true, count };
  } catch (e) {
    logger.error(`정리 배치 실패: ${name}`, { message: (e as Error).message });
    return { ok: false, count: 0, error: (e as Error).message };
  }
}

export async function GET(req: Request) {
  // 인증·잠금은 공용 runCronJob 으로 처리한다. 끝날 때 내 잠금일 때만 풀어서, TTL 을 넘긴 실행이
  // 다음 실행의 잠금을 지워 세 번째 실행이 겹치는 일을 막는다(점검 2026-11-05 C).
  return runCronJob(req, 'cleanup', LOCK_TTL_SEC, async () => {
    const started = Date.now();
    const pinSessions = await step('만료 PIN 인증 취소', () => expireStalePinSessions());
    const confirmations = await step('만료 확인 링크 취소', () => expireStaleConfirmations());
    const amountSelections = await step('만료 금액선택 링크 취소', () => expireStaleAmountSelections());
    const idempotencyKeys = await step('만료 멱등키 삭제', () => purgeExpiredIdempotencyKeys());
    const resetTokens = await step('만료 재설정 토큰 삭제', () => purgeExpiredResetTokens());
    const staleTransactions = await step('결과 미기록 결제 거래 대사 큐 이관', () => escalateStalePaymentTransactions());
    const orphanCharges = await step('고아 결제(승인 요청 전) 자동 취소', () => closeOrphanPreparedCharges());
    const staleESign = await step('오래된 전자서명 요청 만료', () => expireStaleESignRequests());
    const cardSessions = await step('만료 카드 결제창 취소', () => expireStaleCardSessions()); // 2026-11-13 5차 L2(카드 끔이면 0건)

    const steps = { pinSessions, confirmations, amountSelections, idempotencyKeys, resetTokens, staleTransactions, orphanCharges, staleESign, cardSessions };
    const allOk = Object.values(steps).every((s) => s.ok);
    // 본문의 ok:false 만으로는 스케줄러·알람이 실패를 알아채지 못한다.
    // 한 단계라도 실패하면 상태 코드로도 드러낸다(EventBridge/CloudWatch 가 본문을 보지 않는다).
    return { ok: allOk, at: new Date().toISOString(), latencyMs: Date.now() - started, steps, [CRON_HTTP_STATUS]: allOk ? 200 : 500 };
  });
}
