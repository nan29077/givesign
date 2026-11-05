import { prisma } from '@/server/db';
import { kstDateKey } from '@/lib/datetime';
import { formatWon } from '@/lib/money';
import { logger } from '@/lib/logger';
import { emitDomainEventSafe } from './events';
import { registerApprovalHandler, requestApproval, ApprovalError } from './approvals';
import { issueReceiptsBulk, issuerReadiness, receiptCandidates } from './receipts';

/**
 * 연 1회 기부금영수증 준비 (영수증 주기 YEARLY 기관).
 *
 * 1~2월(KST) 매일 /api/cron/receipts 가 부른다.
 *  1) 지난해 후원자 중 영수증 정보를 등록하지 않은 사람 → receipt.info_needed 이벤트(사람당 한 해 1회)
 *     → 저니 'receipt-info-yearend' 가 등록 방법을 안내한다(야간·상한·수신 거부 보호 적용).
 *  2) 발급 가능한 후원자가 있으면 승인 대기함에 "N년 영수증 M건 발급" 요청(주 1회까지, 대기 중이면 새로 쌓지 않음).
 *     담당자가 승인하면 issueReceiptsBulk 로 발급한다. 발급은 법적 문서라 사람의 승인을 거친다.
 * 매월 발급(MONTHLY) 기관은 월간 안내 배치가 그대로 발급한다.
 */

export const RECEIPT_SEASON_MONTHS = [1, 2];

function weekIndex(d: Date) {
  return Math.floor((d.getTime() + 9 * 3_600_000) / (7 * 86_400_000));
}

export async function runAnnualReceiptPrep(now = new Date()) {
  const key = kstDateKey(now);
  const month = Number(key.slice(5, 7));
  const result = { season: RECEIPT_SEASON_MONTHS.includes(month), merchants: 0, notReady: 0, infoNeeded: 0, requested: 0 };
  if (!result.season) return result;
  const taxYear = Number(key.slice(0, 4)) - 1;

  const merchants = await prisma.merchantProfile.findMany({
    where: { receiptCycle: 'YEARLY', status: 'APPROVED' },
    select: { id: true, displayName: true, businessNo: true, representativeName: true, address: true, designatedDonee: true, designatedDoneeVerifiedAt: true, designatedDoneeUntil: true },
  });
  for (const m of merchants) {
    result.merchants += 1;
    if (!issuerReadiness(m).ok) {
      result.notReady += 1;
      continue;
    }
    try {
      const candidates = await receiptCandidates(m.id, taxYear);
      const ready = candidates.filter((c) => c.ready);
      const missing = candidates.filter((c) => !c.ready && !c.withdrawn && !c.conflict);
      for (const c of missing) {
        await emitDomainEventSafe({
          merchantId: m.id,
          type: 'receipt.info_needed',
          subjectType: 'payer',
          subjectId: c.payerId,
          payerId: c.payerId,
          dedupeKey: `receipt.info_needed:${m.id}:${c.payerId}:${taxYear}`,
          payload: { taxYear, amount: c.amount, count: c.count },
        });
        result.infoNeeded += 1;
      }
      if (ready.length === 0) continue;
      const pending = await prisma.approvalRequest.count({ where: { merchantId: m.id, kind: 'RECEIPT_BATCH', status: { in: ['PENDING', 'PROCESSING'] } } });
      if (pending > 0) continue;
      const total = ready.reduce((a, c) => a + c.amount, 0n);
      const dedupeKey = `receipt-batch:${m.id}:${taxYear}:${weekIndex(now)}`;
      const { created } = await requestApproval({
        merchantId: m.id,
        kind: 'RECEIPT_BATCH',
        title: `${taxYear}년 기부금영수증 ${ready.length}건 발급`,
        summary: `합계 ${formatWon(total)} · 정보 미등록 ${missing.length}명은 제외(등록 안내 발송)`,
        payload: { taxYear, readyCount: ready.length, total },
        dedupeKey,
      });
      if (created) {
        result.requested += 1;
        await emitDomainEventSafe({
          merchantId: m.id, type: 'receipt.batch_ready', subjectType: 'merchant', subjectId: m.id, dedupeKey: `receipt.batch_ready:${dedupeKey}`,
          payload: { taxYear, readyCount: ready.length, total },
        });
      }
    } catch (e) {
      logger.error('연간 영수증 준비 실패', { merchantId: m.id, message: (e as Error).message });
    }
  }
  return result;
}

let registered = false;
export function registerReceiptBatchHandler() {
  if (registered) return;
  registered = true;
  registerApprovalHandler('RECEIPT_BATCH', {
    async onApprove(req, userId) {
      const taxYear = Number(req.payload.taxYear);
      if (!Number.isInteger(taxYear)) throw new ApprovalError('귀속 연도가 올바르지 않습니다.');
      const r = await issueReceiptsBulk(req.merchantId, taxYear, userId);
      return `${taxYear}년 영수증 ${r.issued}건 발급, 건너뜀 ${r.skipped}건, 실패 ${r.failed}건`;
    },
  });
}
