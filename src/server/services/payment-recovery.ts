import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { markPaymentUnknown } from './charge-flow';
import { recordFunnelStep } from './funnel';

/**
 * 고착된 결제의 정리 (정리 배치 /api/cron/cleanup 에서 1분마다 호출).
 *
 * executePayment·startPinAuthorization 은 예외를 막아 두었지만, 프로세스가 죽거나 DB 쓰기가
 * 연속으로 실패하면 여전히 중간 상태에 남을 수 있다. 그런 건을 시간이 지난 뒤 닫는다.
 *
 * 원칙
 *  - **돈이 빠졌을 수 있는 건(결제사에 승인 요청이 나갔을 수 있는 건)은 실패로 확정하지 않는다.**
 *    결제 거래가 REQUESTED·TIMEOUT 으로 남았으면 UNKNOWN 으로 올려 관리자 대사 큐로 보낸다.
 *  - 결제 거래가 하나도 없는 건(승인 요청 전 단계)만 출금 없는 실패로 닫는다.
 */

/** 승인 요청부터 결과 기록까지 걸릴 수 있는 시간(승인·조회 타임아웃 포함)보다 넉넉하게 잡는다. */
export const STALE_TXN_MS = 15 * 60 * 1000;
/** 승인 요청 전 단계에 머무를 수 있는 시간. PIN 세션 TTL 보다 길게 잡는다. */
export const ORPHAN_PREPARED_MS = 30 * 60 * 1000;

/**
 * 오래된 REQUESTED·TIMEOUT 결제 거래를 결과 미확인(UNKNOWN)으로 올린다.
 *
 * 수동 대사(payment-reconcile)는 UNKNOWN·TIMEOUT 만 받고, 정기후원은 REQUESTED 를 결과 대기로 보아
 * 하루씩 미루기만 하므로, 올리지 않으면 아무도 이 건을 확정하지 못한다. 알림도 함께 올린다.
 */
export async function escalateStalePaymentTransactions(now = new Date(), olderThanMs = STALE_TXN_MS): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const stale = await prisma.paymentTransaction.findMany({
    where: { status: { in: ['REQUESTED', 'TIMEOUT'] }, requestedAt: { lt: cutoff } },
    select: { id: true, orderNo: true, chargeId: true, amount: true, status: true },
    orderBy: { requestedAt: 'asc' },
    take: 200,
  });
  let count = 0;
  for (const t of stale) {
    await markPaymentUnknown(
      t.chargeId,
      t,
      t.amount,
      `STALE_${t.status}`,
      `승인 결과가 기록되지 않은 채 ${Math.round(olderThanMs / 60000)}분이 지났습니다. 결제사 원장과 대사해 주세요.`,
    );
    logger.error('결과가 기록되지 않은 결제 거래를 대사 큐로 올림', { chargeId: t.chargeId, transactionId: t.id, from: t.status });
    count += 1;
  }
  return count;
}

/**
 * 승인 요청 전 단계(RECEIVED, 진행 중 세션이 없는 PENDING_PIN)에 고아로 남은 결제를 실패로 닫는다.
 *
 * 금액을 확정한 뒤 PIN 발급이 예외로 끝났거나, PIN 세션 저장이 실패한 경우다. 결제 거래가 없으므로
 * 결제사 승인이 일어나지 않았고(세션이 없으면 PIN 콜백도 승인으로 이어지지 않는다) 한도 예약도 없다.
 * 결제 거래가 있는 건은 여기서 건드리지 않는다(escalateStalePaymentTransactions 의 몫).
 * 진행 중(PENDING) 세션이 있는 건은 만료 배치(expireStalePinSessions)가 닫는다.
 */
export async function closeOrphanPreparedCharges(now = new Date(), olderThanMs = ORPHAN_PREPARED_MS): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const orphans = await prisma.charge.findMany({
    where: {
      status: { in: ['RECEIVED', 'PENDING_PIN'] },
      updatedAt: { lt: cutoff },
      transactions: { none: {} },
      OR: [{ pinSession: null }, { pinSession: { status: { not: 'PENDING' } } }],
    },
    select: { id: true, status: true },
    take: 200,
  });
  let count = 0;
  for (const c of orphans) {
    const reason =
      c.status === 'RECEIVED'
        ? '결제 인증 준비 중 중단되어 자동 취소(출금 없음)'
        : 'PIN 인증 세션 없이 남은 결제 자동 취소(출금 없음)';
    // 조건부 갱신으로 선점한다. 그사이 결제가 진행됐으면(상태 변경·거래 생성) 건드리지 않는다.
    const claimed = await prisma.charge.updateMany({
      where: { id: c.id, status: c.status, transactions: { none: {} } },
      data: { status: 'PAYMENT_FAILED', statusReason: reason },
    });
    if (claimed.count !== 1) continue;
    await recordFunnelStep({ step: 'FAILED', chargeId: c.id, reason: 'PAYMENT_FAILED' }); // 단계 측정
    await prisma.chargeStatusLog
      .create({ data: { id: newId(), chargeId: c.id, fromStatus: c.status, toStatus: 'PAYMENT_FAILED', reason, actor: 'system' } })
      .catch(() => undefined);
    count += 1;
  }
  return count;
}

/**
 * 승인 요청 전 단계(RECEIVED·PENDING_PIN, 결제 거래 없음)의 결제를 실패로 닫는다.
 * 결제 거래가 이미 있으면 결제사에 요청이 나갔을 수 있으므로 건드리지 않는다.
 */
export async function failPreparedCharge(chargeId: string, reason: string): Promise<boolean> {
  const cur = await prisma.charge.findUnique({ where: { id: chargeId }, select: { status: true } });
  if (!cur || (cur.status !== 'RECEIVED' && cur.status !== 'PENDING_PIN')) return false;
  const claimed = await prisma.charge.updateMany({
    where: { id: chargeId, status: cur.status, transactions: { none: {} } },
    data: { status: 'PAYMENT_FAILED', statusReason: reason },
  });
  if (claimed.count !== 1) return false;
  await recordFunnelStep({ step: 'FAILED', chargeId, reason: 'PAYMENT_FAILED' }); // 단계 측정
  await prisma.paymentPinSession
    .updateMany({ where: { chargeId, status: 'PENDING' }, data: { status: 'FAILED', resultNote: reason } })
    .catch(() => undefined);
  await prisma.chargeStatusLog
    .create({ data: { id: newId(), chargeId, fromStatus: cur.status, toStatus: 'PAYMENT_FAILED', reason, actor: 'system' } })
    .catch(() => undefined);
  return true;
}
