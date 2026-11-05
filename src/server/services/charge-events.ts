import type { Prisma } from '@/generated/prisma/client';
import { emitDomainEvent } from './events';

/**
 * 결제 성공 도메인 이벤트(`charge.paid`) — 정상 결제 경로(charge-flow)와 관리자 수동 확정(payment-reconcile)이
 * 같은 payload 로 같은 트랜잭션 안에서 남긴다(2026-11-06 점검 A-2).
 *
 * payload 에는 개인정보를 넣지 않는다 — 표시 이름도 넣지 않는다(익명 후원 노출 방지, 점검 A-M5).
 * 이름이 필요한 소비자는 결제 건(charge.displayName · anonymous)을 직접 읽는다.
 * dedupe 키가 `charge.paid:{chargeId}` 라 두 경로가 모두 불러도 한 건이다.
 */
export interface ChargePaidSource {
  id: string;
  merchantId: string;
  payerId: string | null;
  amount: bigint;
  channel: string;
  campaignId: string | null;
  source: string | null;
  contentItemId: string | null;
  isTest: boolean;
  paymentMode: string;
}

export function chargePaidPayload(charge: ChargePaidSource): Record<string, unknown> {
  return {
    amount: charge.amount,
    channel: charge.channel,
    campaignId: charge.campaignId,
    source: charge.source,
    contentItemId: charge.contentItemId,
    isTest: charge.isTest,
    recurring: charge.paymentMode === 'RECURRING',
  };
}

export async function emitChargePaid(tx: Prisma.TransactionClient, charge: ChargePaidSource, occurredAt: Date, extra: Record<string, unknown> = {}) {
  await emitDomainEvent(
    {
      merchantId: charge.merchantId,
      type: 'charge.paid',
      subjectType: 'charge',
      subjectId: charge.id,
      payerId: charge.payerId,
      occurredAt,
      payload: { ...chargePaidPayload(charge), ...extra },
    },
    tx,
  );
}

/** 기관 알림 등에 쓰는 후원자 표시 — 익명 후원이면 이름 대신 "익명의 후원자". */
export function chargeDonorLabel(c: { anonymous: boolean; displayName: string | null }): string {
  if (c.anonymous) return '익명의 후원자';
  return c.displayName?.trim() || '후원자';
}
