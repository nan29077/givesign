import { prisma } from '@/server/db';
import { emitMerchantEvent } from './webhooks';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { calculateFees, postChargeSettlement } from './settlement';
import { rollbackCounters } from './limits';
import { restoreStock } from './charge-flow';
import { sendMtForPayer, setStatus } from './charge-flow';
import * as tpl from './mt-templates';

/**
 * 결과 미확인(UNKNOWN / TIMEOUT) 결제의 수동 대사.
 *
 * 왜 사람이 판단하는가
 *  결제사 응답이 끊긴 건은 **실제로 출금이 되었는지 시스템이 알 수 없다.**
 *  자동으로 실패 처리하면 출금된 돈이 정산되지 않고, 자동으로 성공 처리하면
 *  받지도 않은 돈을 사회복지기관에 지급한다. 그래서 관리자가 PG 관리자 화면에서
 *  대사한 뒤 이 함수로 결론만 반영한다.
 *
 * 절대 원칙
 *  1) UNKNOWN / TIMEOUT 상태의 결제 거래에만 적용한다. 이미 확정된 건은 건드리지 않는다.
 *  2) 승인 확정은 executePayment 의 승인 경로와 **같은 장부 처리**를 한다.
 *     (수수료 계산 + 정산 원장 분개 + 후원자-사회복지기관 누적)
 *  3) 후원 반영은 다시 하지 않는다. 대사는 보통 몇 시간 뒤에 이루어지므로
 *     그때 알림이 다시 나가면 후원자에게 잘못된 시점의 결제가 보인다.
 *  4) 취소 확정은 예약해 둔 한도 집계를 되돌린다(출금이 없었으므로 한도를 쓰지 않는다).
 */

export type ReconcileDecision = 'APPROVE' | 'CANCEL';

export interface ReconcileResult {
  ok: boolean;
  message: string;
  transactionNo?: string;
}

/** 대사 가능한 결제 거래 상태 */
const RECONCILABLE = ['UNKNOWN', 'TIMEOUT'] as const;

/** 다른 요청이 먼저 확정한 경우의 안내 문구. */
const ALREADY_HANDLED = '이미 다른 요청이 이 건을 확정했습니다. 목록을 새로고침해 결과를 확인해 주세요.';

export async function reconcileUnknownPayment(
  transactionId: string,
  decision: ReconcileDecision,
  memo: string,
): Promise<ReconcileResult> {
  const txn = await prisma.paymentTransaction.findUnique({
    where: { id: transactionId },
    select: {
      id: true,
      status: true,
      orderNo: true,
      providerTid: true,
      amount: true,
      requestedAt: true,
      chargeId: true,
    },
  });
  if (!txn) throw new Error('결제 거래를 찾을 수 없습니다.');
  if (!RECONCILABLE.includes(txn.status as (typeof RECONCILABLE)[number])) {
    throw new Error('결과 확인이 필요한(UNKNOWN·TIMEOUT) 결제만 수동으로 확정할 수 있습니다.');
  }

  const charge = await prisma.charge.findUnique({
    where: { id: txn.chargeId },
    select: {
      id: true,
      status: true,
      transactionNo: true,
      amount: true,
      message: true,
      displayName: true,
      merchantId: true,
      payerId: true,
      productId: true,
      quantity: true,
      merchant: { select: { displayName: true, thanksMtMessage: true } },
    },
  });
  if (!charge) throw new Error('결제 거래를 찾을 수 없습니다.');

  return decision === 'APPROVE'
    ? confirmApproved(txn, charge, memo)
    : confirmCanceled(txn, charge, memo);
}

type TxnRow = {
  id: string;
  orderNo: string;
  providerTid: string | null;
  amount: bigint;
  requestedAt: Date;
  chargeId: string;
};

type ChargeRow = {
  id: string;
  status: string;
  transactionNo: string;
  amount: bigint;
  message: string;
  displayName: string;
  merchantId: string;
  payerId: string | null;
  productId: string | null;
  quantity: number;
  merchant: { displayName: string; thanksMtMessage: string | null };
};

/**
 * 실제로 출금된 것으로 확인된 경우.
 * 승인 기록과 정산 원장 분개는 반드시 같은 트랜잭션이어야 한다(executePayment 와 동일).
 */
async function confirmApproved(txn: TxnRow, charge: ChargeRow, memo: string): Promise<ReconcileResult> {
  if (charge.status !== 'PENDING_PAYMENT') {
    throw new Error(`결제 상태가 결제 진행중(PENDING_PAYMENT)이 아닙니다. 현재 상태: ${charge.status}`);
  }

  const approvedAt = new Date();
  const fees = await calculateFees(charge.merchantId, charge.amount);

  await prisma.$transaction(async (tx) => {
    // 조건부 갱신으로 이 건을 **선점**한다.
    //
    // 위의 상태 확인은 트랜잭션 밖에서 읽은 값이라, 관리자 두 명이 같은 건을 동시에
    // 확정하거나 요청이 중복 도달하면 둘 다 통과한 뒤 아래 장부 처리가 두 번 돌 수 있다.
    // 그러면 후원자-사회복지기관 누적 금액·건수가 실제보다 부풀고 완료 문자도 두 번 나간다.
    // PIN 세션·환불·보안링크가 쓰는 것과 같은 방식으로 맞춘다.
    const claimedTxn = await tx.paymentTransaction.updateMany({
      where: { id: txn.id, status: { in: [...RECONCILABLE] } },
      data: {
        status: 'APPROVED',
        providerTid: txn.providerTid ?? txn.orderNo,
        approvedAt,
        resultCode: 'ADMIN_CONFIRMED',
        resultMessage: `관리자 수동 확정: ${memo}`.slice(0, 500),
      },
    });
    if (claimedTxn.count === 0) throw new Error(ALREADY_HANDLED);

    const claimedCharge = await tx.charge.updateMany({
      where: { id: charge.id, status: 'PENDING_PAYMENT' },
      data: {
        status: 'SETTLEMENT_PENDING',
        statusReason: '관리자 수동 확정 후 정산 대기',
        paidAt: approvedAt,
        pgFee: fees.pgFee,
        platformFee: fees.platformFee,
        feeVat: fees.vat,
        netAmount: fees.net,
      },
    });
    if (claimedCharge.count === 0) throw new Error(ALREADY_HANDLED);
    await tx.chargeStatusLog.createMany({
      data: [
        {
          id: newId(),
          chargeId: charge.id,
          fromStatus: 'PENDING_PAYMENT',
          toStatus: 'PAYMENT_SUCCESS',
          reason: `관리자 수동 확정: ${memo}`,
          actor: 'admin',
        },
        {
          id: newId(),
          chargeId: charge.id,
          fromStatus: 'PAYMENT_SUCCESS',
          toStatus: 'SETTLEMENT_PENDING',
          reason: '정산 대기',
          actor: 'admin',
        },
      ],
    });
    if (charge.payerId) {
      await tx.payerMerchantLink.upsert({
        where: { payerId_merchantId: { payerId: charge.payerId, merchantId: charge.merchantId } },
        create: {
          id: newId(),
          payerId: charge.payerId,
          merchantId: charge.merchantId,
          consentedAt: approvedAt,
          totalAmount: charge.amount,
          totalCount: 1,
          lastDonatedAt: approvedAt,
        },
        update: {
          totalAmount: { increment: charge.amount },
          totalCount: { increment: 1 },
          lastDonatedAt: approvedAt,
        },
      });
    }
    await postChargeSettlement(
      {
        merchantId: charge.merchantId,
        chargeId: charge.id,
        amount: charge.amount,
        fees,
        occurredAt: approvedAt,
      },
      tx,
    );
  });

  // 한도 집계는 결제 판정 시점에 이미 예약(반영)되어 있으므로 다시 더하지 않는다.
  if (charge.payerId) {
    const link = await prisma.payerMerchantLink.findUnique({
      where: { payerId_merchantId: { payerId: charge.payerId, merchantId: charge.merchantId } },
      select: { totalAmount: true },
    });
    await sendMtForPayer(
      charge.payerId,
      tpl.tplChargeSuccess({
        payerName: charge.displayName,
        merchantName: charge.merchant.displayName,
        amount: charge.amount,
        message: charge.message,
        cumulative: link?.totalAmount ?? charge.amount,
        custom: charge.merchant.thanksMtMessage,
      }),
      charge.id,
      charge.merchantId,
    );
  }

  await emitMerchantEvent(charge.merchantId, 'charge.succeeded', {
    transactionNo: charge.transactionNo,
    amount: Number(charge.amount),
    points: Number(charge.amount),
    message: charge.message,
    paidAt: new Date().toISOString(),
    reconciled: true,
  });

  logger.info('결과 미확인 결제를 승인으로 확정', {
    chargeId: charge.id,
    transactionId: txn.id,
    orderNo: txn.orderNo,
  });

  return {
    ok: true,
    message: `${charge.transactionNo} 건을 결제 승인으로 확정했습니다. 정산 원장에 분개가 추가되었습니다. 후원 반영은 다시 수행하지 않습니다.`,
    transactionNo: charge.transactionNo,
  };
}

/** 출금이 없었던 것으로 확인된 경우. */
async function confirmCanceled(txn: TxnRow, charge: ChargeRow, memo: string): Promise<ReconcileResult> {
  if (charge.status !== 'PENDING_PAYMENT') {
    throw new Error(`결제 상태가 결제 진행중(PENDING_PAYMENT)이 아닙니다. 현재 상태: ${charge.status}`);
  }

  // 승인 경로와 같은 이유로 선점한다.
  // 취소가 두 번 돌면 rollbackCounters 가 두 번 실행되어 일·월 한도 집계가
  // 실제보다 더 깎이고, 그만큼 후원자가 정책 한도를 넘겨 결제할 수 있게 된다.
  const claimed = await prisma.paymentTransaction.updateMany({
    where: { id: txn.id, status: { in: [...RECONCILABLE] } },
    data: {
      status: 'CANCELED',
      canceledAt: new Date(),
      resultCode: 'ADMIN_CANCELED',
      resultMessage: `관리자 수동 취소: ${memo}`.slice(0, 500),
    },
  });
  if (claimed.count === 0) throw new Error(ALREADY_HANDLED);

  await setStatus(charge.id, 'PAYMENT_FAILED', `관리자 수동 취소: ${memo}`, 'admin');

  // 결제 판정 때 선점한 재고도 함께 돌려놓는다.
  // 승인 실패 경로(charge-flow)와 환불 경로는 모두 복구하는데 이 경로만 빠져 있었다.
  // 빠뜨리면 결과 미확인 건을 취소로 확정할 때마다 팔 수 있는 물건이 영구히 줄어든다.
  await restoreStock(charge.productId, charge.quantity);

  // 출금이 없었으므로 결제 판정 때 잡아 둔 한도 예약을 되돌린다.
  if (charge.payerId) {
    await rollbackCounters(charge.payerId, charge.merchantId, charge.amount, txn.requestedAt);
    await sendMtForPayer(
      charge.payerId,
      tpl.tplChargeFailed(charge.merchant.displayName, '결제가 완료되지 않아 취소되었습니다.'),
      charge.id,
      charge.merchantId,
    );
  }

  logger.warn('결과 미확인 결제를 취소로 확정', {
    chargeId: charge.id,
    transactionId: txn.id,
    orderNo: txn.orderNo,
  });

  return {
    ok: true,
    message: `${charge.transactionNo} 건을 결제 취소로 확정했습니다. 출금이 없었던 건으로 처리되어 한도 집계도 되돌렸습니다.`,
    transactionNo: charge.transactionNo,
  };
}
