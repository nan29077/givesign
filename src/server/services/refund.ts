import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { voidReceiptForRefundedCharge } from './receipts';
import { newId } from '@/lib/id';
import { getPaymentAdapter } from '@/server/adapters/payment';
import { calculateFees, postRefundSettlement } from './settlement';
import { rollbackCounters } from './limits';
import { sendMtForPayer } from './charge-flow';
import * as tpl from './mt-templates';

/**
 * 환불 처리.
 * - 정산 원장은 수정하지 않고 반대 분개를 추가한다.
 * - 이미 정산 지급된 건의 환불은 마이너스 잔액으로 남아 다음 정산에서 차감된다.
 */

export async function requestRefund(input: {
  chargeId: string;
  reason: string;
  requestedBy?: string;
}) {
  const charge = await prisma.charge.findUnique({ where: { id: input.chargeId } });
  if (!charge) throw new Error('결제 거래를 찾을 수 없습니다.');
  if (!['PAYMENT_SUCCESS', 'BROADCAST_PENDING', 'BROADCASTED', 'PARTIAL_DELIVERY_FAILED', 'SETTLEMENT_PENDING', 'SETTLED'].includes(charge.status)) {
    throw new Error('결제가 완료된 거래만 환불할 수 있습니다.');
  }
  const existing = await prisma.refund.findFirst({
    where: { chargeId: input.chargeId, status: { in: ['REQUESTED', 'APPROVED', 'DONE'] } },
  });
  if (existing) throw new Error('이미 환불이 요청된 거래입니다.');

  // 선점과 요청 생성은 한 트랜잭션이어야 한다.
  // 나누면 선점만 되고 요청 행이 안 생기는 경우가 있고, 그때 결제는 REFUND_REQUESTED 로
  // 잠긴 채 승인할 환불 요청이 없어 아무도 풀 수 없다.
  return prisma.$transaction(async (tx) => {
    // 더블클릭·동시 요청으로 REQUESTED 가 두 건 생기지 않도록, 결제 상태 전이를 조건부 UPDATE 로 선점한다.
    const claimed = await tx.charge.updateMany({
      where: { id: charge.id, status: charge.status },
      data: { status: 'REFUND_REQUESTED' },
    });
    if (claimed.count !== 1) throw new Error('이미 환불이 요청된 거래입니다.');

    const refund = await tx.refund.create({
      data: {
        id: newId(),
        chargeId: charge.id,
        amount: charge.amount,
        reason: input.reason,
        requestedBy: input.requestedBy ?? null,
      },
    });
    // 거절 시 이전 상태로 되돌릴 수 있도록 전이 이력을 남긴다.
    await tx.chargeStatusLog.create({
      data: {
        id: newId(),
        chargeId: charge.id,
        fromStatus: charge.status,
        toStatus: 'REFUND_REQUESTED',
        actor: input.requestedBy ?? 'system',
        reason: input.reason.slice(0, 200),
      },
    });
    return refund;
  });
}

/**
 * 승인 선점 후 이만큼 지나도 끝나지 않은 건만 "멈춘 것" 으로 보고 되돌릴 수 있다.
 * PG 취소 호출은 타임아웃까지 잡아도 이 시간 안에 끝난다.
 */
const REOPEN_STALE_MS = 5 * 60_000;

export async function approveRefund(refundId: string, adminUserId?: string) {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: { charge: { include: { merchant: true, transactions: true } } },
  });
  if (!refund) throw new Error('환불 요청을 찾을 수 없습니다.');
  if (refund.status === 'DONE') return refund;

  // 이중 승인 방어.
  // (1) 요청 상태가 아닌 건(거절·실패)을 되살려 다시 취소·반대분개하지 않는다.
  // (2) 동시에 두 관리자가 승인해도 조건부 UPDATE 로 한쪽만 선점하게 한다.
  //     append-only 원장에 환불 분개가 두 번 쌓이면 되돌릴 수 없으므로 PG 취소 호출 전에 APPROVED 로 선점한다.
  if (refund.status !== 'REQUESTED') {
    throw new Error('요청 상태의 환불만 승인할 수 있습니다. 목록을 새로고침해 현재 상태를 확인해 주세요.');
  }

  // 선점(APPROVED)보다 먼저 검사한다.
  // 선점한 뒤에 여기서 실패하면 환불은 APPROVED, 결제는 REFUND_REQUESTED 로 남아
  // 승인·거절 버튼이 모두 사라지고 신규 환불 요청도 막힌 채 고착된다.
  const txn = refund.charge.transactions.find((t) => t.status === 'APPROVED');
  if (!txn) throw new Error('승인된 결제 거래가 없습니다.');

  // 선점 시각을 함께 남긴다. reopenRefund 가 "지금 처리 중인 건" 과
  // "멈춘 지 오래된 건" 을 구분하는 근거가 된다. (DONE 으로 넘어갈 때 완료 시각으로 덮인다)
  const claimedAt = new Date();
  const claimed = await prisma.refund.updateMany({
    where: { id: refundId, status: 'REQUESTED' },
    data: { status: 'APPROVED', processedAt: claimedAt },
  });
  if (claimed.count === 0) {
    throw new Error('이미 다른 처리가 진행 중인 환불입니다. 잠시 후 상태를 다시 확인해 주세요.');
  }

  const adapter = getPaymentAdapter();
  const res = await adapter.cancel({
    orderNo: txn.orderNo,
    providerTid: txn.providerTid ?? '',
    amount: refund.amount,
    reason: refund.reason ?? '고객 요청',
  });

  if (!res.ok) {
    // 선점(APPROVED)했다가 PG 취소에 실패한 건은 FAILED 로 확정한다.
    // 취소가 실제로는 성공했는데 응답만 실패했을 수 있으므로 자동으로 되돌리지 않는다.
    // 관리자가 PG 내역을 확인한 뒤 reopenRefund 로 요청 상태로 되돌려 재시도하거나 거절한다.
    await prisma.refund.update({
      where: { id: refundId },
      data: { status: 'FAILED', resultCode: res.code ?? null, resultMessage: res.message ?? null },
    });
    throw new Error(res.message ?? '환불 처리에 실패했습니다.');
  }

  const fees = await calculateFees(refund.charge.merchantId, refund.amount);
  const now = new Date();

  // 환불 확정 기록과 정산 원장 반대 분개는 반드시 같은 트랜잭션이어야 한다.
  // 분리하면 커밋 사이에 프로세스가 죽었을 때 "환불은 완료인데 원장에는 없는" 상태가 된다.
  await prisma.$transaction(async (tx) => {
    // 선점한 그 건이 아직 그대로인지 다시 확인한다.
    // PG 취소를 기다리는 사이 관리자가 reopenRefund 로 되돌리고 다른 관리자가 또 승인하면,
    // 여기까지 두 흐름이 도달해 append-only 원장에 반대분개가 두 번 쌓인다. 되돌릴 수 없다.
    const stillMine = await tx.refund.updateMany({
      where: { id: refundId, status: 'APPROVED', processedAt: claimedAt },
      data: { status: 'DONE', approvedBy: adminUserId ?? null, processedAt: now, providerTid: txn.providerTid },
    });
    if (stillMine.count === 0) {
      throw new Error(
        '처리 중에 환불 상태가 바뀌었습니다. PG 취소는 이미 요청되었을 수 있으니 결제대행 내역을 확인한 뒤 다시 처리해 주세요.',
      );
    }
    await tx.paymentTransaction.update({ where: { id: txn.id }, data: { status: 'CANCELED', canceledAt: now } });
    await tx.charge.update({
      where: { id: refund.chargeId },
      data: { status: 'REFUNDED', refundedAt: now },
    });
    await tx.chargeStatusLog.create({
      data: { id: newId(), chargeId: refund.chargeId, toStatus: 'REFUNDED', actor: adminUserId ?? 'admin', reason: refund.reason },
    });

    // 실물 주문을 환불하면 잡아둔 재고를 돌려놓는다.
    // 다만 이미 발송했다면 물건은 나간 상태이므로 되돌리지 않는다(사회복지기관이 회수 후 직접 조정한다).
    if (refund.charge.productId && refund.charge.quantity > 0) {
      const shipment = await tx.chargeShipment.findUnique({
        where: { chargeId: refund.chargeId },
        select: { status: true },
      });
      const shippedOut = shipment ? shipment.status === 'SHIPPED' || shipment.status === 'DELIVERED' : false;
      if (!shippedOut) {
        await tx.chargeProduct.updateMany({
          where: { id: refund.charge.productId, kind: 'PHYSICAL', stock: { not: null } },
          data: { stock: { increment: refund.charge.quantity } },
        });
      }
      if (shipment) {
        await tx.chargeShipment.update({
          where: { chargeId: refund.chargeId },
          data: shippedOut
            ? { merchantMemo: '환불 처리됨 — 발송분 회수 필요' }
            : { status: 'CANCELED' },
        });
      }
    }
    await postRefundSettlement(
      {
        merchantId: refund.charge.merchantId,
        chargeId: refund.chargeId,
        refundId: refund.id,
        amount: refund.amount,
        fees,
        occurredAt: now,
      },
      tx,
    );
  });

  if (refund.charge.payerId && refund.charge.paidAt) {
    // 한도 집계는 결제를 "예약" 한 시각(paymentTransaction.requestedAt)으로 키가 잡힌다.
    // charge.paidAt 은 결과 미확인 건을 관리자가 나중에 확정하면 그 시점으로 덮이므로,
    // 그 값으로 되돌리면 다른 달 카운터에서 빼게 된다.
    //
    // 위 트랜잭션에서 이 거래를 이미 CANCELED 로 바꿨으므로 여기서 status:'APPROVED' 로
    // 다시 찾으면 **항상 null** 이고, 결국 쓰면 안 된다고 적어 둔 paidAt 으로 되돌아간다.
    // 승인 거래는 선점 전에 잡아 둔 txn 이 그대로 들고 있다.
    const counterBasis = txn.requestedAt ?? refund.charge.paidAt;
    await rollbackCounters(refund.charge.payerId, refund.charge.merchantId, refund.amount, counterBasis);
    await prisma.payerMerchantLink.updateMany({
      where: { payerId: refund.charge.payerId, merchantId: refund.charge.merchantId },
      data: { totalAmount: { decrement: refund.amount }, totalCount: { decrement: 1 } },
    });
    await sendMtForPayer(
      refund.charge.payerId,
      tpl.tplRefundDone(refund.charge.merchant.displayName, refund.amount),
      refund.chargeId,
      refund.charge.merchantId,
    );
  }

  // 환불된 건이 기부금영수증에 묶여 있으면 그 영수증을 무효화한다(절대 규칙 9).
  // 영수증 처리 실패가 환불 결과를 바꾸지 않도록 오류는 기록만 한다.
  await voidReceiptForRefundedCharge(refund.chargeId, adminUserId ?? 'admin').catch((e) =>
    logger.error('환불 후 기부금영수증 무효화 실패', { chargeId: refund.chargeId, message: (e as Error).message }),
  );

  return prisma.refund.findUnique({ where: { id: refundId } });
}

export async function rejectRefund(refundId: string, adminUserId?: string, memo?: string) {
  const refund = await prisma.refund.findUnique({ where: { id: refundId } });
  if (!refund) throw new Error('환불 요청을 찾을 수 없습니다.');
  // 동시 승인·거절 경합 방어: 요청(REQUESTED) 상태만 조건부 UPDATE 로 선점한다.
  // 무조건 REJECTED 로 덮으면 승인 흐름이 먼저 선점한 건(APPROVED·DONE)까지 되돌려 원장과 어긋난다.
  // 환불 상태 변경과 결제 상태 복원은 한 트랜잭션이어야 한다.
  // 나누면 커밋 사이에 죽었을 때 "환불은 거절인데 결제는 환불 요청 중" 인 고착 상태가 된다.
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.refund.updateMany({
      where: { id: refundId, status: 'REQUESTED' },
      data: { status: 'REJECTED', approvedBy: adminUserId ?? null, resultMessage: memo ?? null, processedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new Error('이미 처리된 환불입니다. 목록을 새로고침해 현재 상태를 확인해 주세요.');
    }
    // 환불 요청 직전 상태(BROADCASTED·SETTLED 등)로 되돌린다. 이력이 없는 예전 건은 정산대기로 둔다.
    const transition = await tx.chargeStatusLog.findFirst({
      where: { chargeId: refund.chargeId, toStatus: 'REFUND_REQUESTED' },
      orderBy: { createdAt: 'desc' },
      select: { fromStatus: true },
    });
    await tx.charge.update({
      where: { id: refund.chargeId },
      data: { status: transition?.fromStatus ?? 'SETTLEMENT_PENDING', statusReason: '환불 거절' },
    });
  });
  return refund;
}

/**
 * 처리가 멈춘 환불(FAILED · APPROVED)을 다시 요청(REQUESTED) 상태로 되돌린다.
 *
 * 승인 도중 PG 취소가 실패하면 환불은 FAILED, 결제는 REFUND_REQUESTED 로 남는다.
 * 그 상태에서는 승인·거절 버튼이 모두 사라지고(요청 상태가 아니므로),
 * 신규 환불 요청도 막혀(결제가 이미 REFUND_REQUESTED) 관리자 화면에서 되살릴 방법이 없었다.
 *
 * 자동으로 되돌리지 않는 이유: PG 취소가 실제로는 성공했는데 응답만 실패했을 수 있다.
 * 관리자가 PG 내역을 확인한 뒤 명시적으로 되돌려 재시도하거나 거절하도록 한다.
 */
export async function reopenRefund(refundId: string, adminUserId?: string, memo?: string) {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    select: { id: true, status: true, chargeId: true, resultMessage: true, processedAt: true },
  });
  if (!refund) throw new Error('환불 요청을 찾을 수 없습니다.');
  if (refund.status !== 'FAILED' && refund.status !== 'APPROVED') {
    throw new Error('처리가 멈춘 환불(실패·승인)만 요청 상태로 되돌릴 수 있습니다.');
  }
  // APPROVED 는 "선점하고 PG 취소를 기다리는 중" 일 수도 있다. 그 사이에 되돌리면
  // 다른 관리자가 다시 승인해 PG 취소와 원장 반대분개가 두 번 일어난다.
  // 충분히 오래 멈춰 있는 건만 되돌린다(진행 중인 승인은 이 시간 안에 끝난다).
  if (refund.status === 'APPROVED') {
    const claimedAt = refund.processedAt?.getTime() ?? 0;
    if (Date.now() - claimedAt < REOPEN_STALE_MS) {
      throw new Error(
        '방금 승인 처리가 시작된 환불입니다. 결제대행 응답을 기다리는 중일 수 있으니 몇 분 뒤에 다시 시도해 주세요.',
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.refund.updateMany({
      where: { id: refundId, status: refund.status },
      data: {
        status: 'REQUESTED',
        approvedBy: adminUserId ?? null,
        processedAt: null,
        resultMessage: memo ? `요청 상태로 되돌림: ${memo}`.slice(0, 200) : refund.resultMessage,
      },
    });
    if (claimed.count === 0) {
      throw new Error('이미 다른 처리가 진행 중인 환불입니다. 목록을 새로고침해 주세요.');
    }
    // 승인·거절 흐름이 이어지려면 결제도 환불 요청 중이어야 한다.
    // 이미 환불이 끝난 건(REFUNDED)은 건드리지 않는다.
    await tx.charge.updateMany({
      where: { id: refund.chargeId, status: { not: 'REFUNDED' } },
      data: { status: 'REFUND_REQUESTED', statusReason: '환불 재검토' },
    });
  });

  return prisma.refund.findUnique({ where: { id: refundId } });
}
