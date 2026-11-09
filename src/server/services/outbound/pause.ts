import { prisma } from '@/server/db';
import { Prisma } from '@/generated/prisma/client';

/**
 * 자동 안내 일시 멈춤 (2026-11-09 D1-2).
 *
 * 후원자에게 **열린 문의**(고객센터 OPEN) 또는 **진행 중 환불**(REQUESTED·APPROVED)이 있으면, 담당자가 확인하기 전까지
 * 관계·정보형 자동 안내(감사장·영수증 정보 안내·월간 안내 등)를 하루씩 보류한다(저니 보류 기구·대기열 보류 재사용).
 * 결제·인증·서명 요청·결제 실패/복구 안내처럼 후원자가 시작한 거래 안내는 멈추지 않는다(분류: outbound/classify.ts).
 */

/** "열린" 문의 상태. 답변(ANSWERED)은 후원자 응답 대기라 담당자 일이 아니다. */
export const OPEN_INQUIRY_STATUSES = ['OPEN'] as const;
/** 진행 중 환불 상태 */
export const ACTIVE_REFUND_STATUSES = ['REQUESTED', 'APPROVED'] as const;

export interface PauseFacts {
  openInquiry: boolean;
  refundInProgress: boolean;
}

/** 여러 후원자를 한 번에(목록·N+1 금지). */
export async function pauseFactsFor(merchantId: string, payerIds: string[]): Promise<Map<string, PauseFacts>> {
  const out = new Map<string, PauseFacts>();
  if (payerIds.length === 0) return out;
  const [inq, ref] = await Promise.all([
    prisma.$queryRaw<Array<{ payer_id: string }>>`
      SELECT DISTINCT p.id AS payer_id
        FROM support_inquiry i
        JOIN payer_profile p ON p.id IN (${Prisma.join(payerIds)})
       WHERE i.merchant_id = ${merchantId}
         AND i.status::text IN (${Prisma.join([...OPEN_INQUIRY_STATUSES])})
         AND ((p.user_id IS NOT NULL AND i.user_id = p.user_id)
              OR EXISTS (SELECT 1 FROM charge c WHERE c.id = i.charge_id AND c.payer_id = p.id))`,
    prisma.$queryRaw<Array<{ payer_id: string }>>`
      SELECT DISTINCT c.payer_id
        FROM refund r JOIN charge c ON c.id = r.charge_id
       WHERE c.merchant_id = ${merchantId}
         AND c.payer_id IN (${Prisma.join(payerIds)})
         AND r.status::text IN (${Prisma.join([...ACTIVE_REFUND_STATUSES])})`,
  ]);
  const inqSet = new Set(inq.map((r) => r.payer_id));
  const refSet = new Set(ref.map((r) => r.payer_id));
  for (const id of payerIds) out.set(id, { openInquiry: inqSet.has(id), refundInProgress: refSet.has(id) });
  return out;
}

/** 멈춤 사유(없으면 null). */
export async function autoPauseReason(merchantId: string, payerId: string | null | undefined): Promise<string | null> {
  if (!payerId) return null;
  const f = (await pauseFactsFor(merchantId, [payerId])).get(payerId);
  if (f?.refundInProgress) return '진행 중인 환불이 있음';
  if (f?.openInquiry) return '답변하지 않은 문의가 있음';
  return null;
}
