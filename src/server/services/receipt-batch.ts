import { prisma } from '@/server/db';
import { kstDateKey } from '@/lib/datetime';
import { formatWon } from '@/lib/money';
import { logger } from '@/lib/logger';
import { PAID_STATUSES } from '@/components/studio/shared';
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
 * 매월 발급(MONTHLY) 기관은 월간 안내 배치가 그대로 발급한다. 그 기관 후원자에게는 지난해 결제 건이 모두 영수증에
 * 묶인 뒤 `receipt.year_closed`(사람당 한 해 1회)를 내어 연말 감사장을 한 번만 보낸다(점검 A-4). 월별 영수증
 * 발급(receipt.issued)으로는 연말 감사장을 시작하지 않는다.
 *
 * 승인된 일괄 발급은 승인 처리(서버 액션)에서 하지 않는다. 승인은 QUEUED 로만 기록하고 /api/cron/events 의
 * runQueuedApprovals 가 시간 상한 안에서 나눠 발급한다(재시작·시간 초과에도 이어서, 같은 건은 다시 묶이지 않음 — 점검 A-1).
 */

export const RECEIPT_SEASON_MONTHS = [1, 2];

function weekIndex(d: Date) {
  return Math.floor((d.getTime() + 9 * 3_600_000) / (7 * 86_400_000));
}

export async function runAnnualReceiptPrep(now = new Date()) {
  const key = kstDateKey(now);
  const month = Number(key.slice(5, 7));
  const result = { season: RECEIPT_SEASON_MONTHS.includes(month), merchants: 0, notReady: 0, infoNeeded: 0, requested: 0, yearClosed: 0 };
  if (!result.season) return result;
  const taxYear = Number(key.slice(0, 4)) - 1;
  result.yearClosed = await emitYearClosedForMonthly(taxYear).catch((e) => {
    logger.error('매월 발급 기관 연말 마감 이벤트 실패', { message: (e as Error).message });
    return 0;
  });

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
      const pending = await prisma.approvalRequest.count({ where: { merchantId: m.id, kind: 'RECEIPT_BATCH', status: { in: ['PENDING', 'PROCESSING', 'QUEUED'] } } });
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

/**
 * 매월 발급(MONTHLY) 기관: 지난해 결제 건이 모두 영수증에 묶인 후원자마다 receipt.year_closed 를 낸다(사람당 한 해 1회).
 * 12월분이 아직 발급되지 않았으면(묶이지 않은 결제 건이 남아 있으면) 내지 않는다 — 다음 날 다시 본다.
 */
export async function emitYearClosedForMonthly(taxYear: number) {
  const { start, end } = { start: new Date(Date.UTC(taxYear, 0, 1, -9)), end: new Date(Date.UTC(taxYear + 1, 0, 1, -9)) };
  const merchants = await prisma.merchantProfile.findMany({ where: { receiptCycle: 'MONTHLY', status: 'APPROVED' }, select: { id: true } });
  let emitted = 0;
  for (const m of merchants) {
    const receipts = await prisma.donationReceipt.findMany({
      where: { merchantId: m.id, taxYear, status: 'ISSUED' },
      select: { payerId: true, receiptNo: true, totalAmount: true, chargeCount: true, issuedAt: true },
      orderBy: { issuedAt: 'asc' },
    });
    if (receipts.length === 0) continue;
    const open = await prisma.charge.groupBy({
      by: ['payerId'],
      where: { merchantId: m.id, isTest: false, status: { in: PAID_STATUSES }, receiptId: null, paidAt: { gte: start, lt: end }, payerId: { not: null } },
    });
    const unfinished = new Set(open.map((o) => o.payerId));
    const byPayer = new Map<string, typeof receipts>();
    for (const r of receipts) byPayer.set(r.payerId, [...(byPayer.get(r.payerId) ?? []), r]);
    for (const [payerId, list] of byPayer) {
      if (unfinished.has(payerId)) continue;
      const totalAmount = list.reduce((a, r) => a + r.totalAmount, 0n);
      const chargeCount = list.reduce((a, r) => a + r.chargeCount, 0);
      const receiptNo = list.length === 1 ? list[0]!.receiptNo : `${list[list.length - 1]!.receiptNo} 외 ${list.length - 1}건`;
      await emitDomainEventSafe({
        merchantId: m.id,
        type: 'receipt.year_closed',
        subjectType: 'payer',
        subjectId: payerId,
        payerId,
        dedupeKey: `receipt.year_closed:${m.id}:${payerId}:${taxYear}`,
        payload: { taxYear, totalAmount, chargeCount, receiptNo, receiptCount: list.length },
      });
      emitted += 1;
    }
  }
  return emitted;
}

interface BatchProgress {
  /** 이미 처리(발급·건너뜀·실패)한 후원자 */
  done?: string[];
  issued?: number;
  skipped?: number;
  failed?: number;
}

let registered = false;
export function registerReceiptBatchHandler() {
  if (registered) return;
  registered = true;
  registerApprovalHandler('RECEIPT_BATCH', {
    // 승인 즉시 발급하는 경로(배치가 없는 호출부 호환). 기본은 아래 execute 로 배치가 나눠 발급한다.
    async onApprove(req, userId) {
      const taxYear = Number(req.payload.taxYear);
      if (!Number.isInteger(taxYear)) throw new ApprovalError('귀속 연도가 올바르지 않습니다.');
      const r = await issueReceiptsBulk(req.merchantId, taxYear, userId);
      return `${taxYear}년 영수증 ${r.issued}건 발급, 건너뜀 ${r.skipped}건, 실패 ${r.failed}건`;
    },
    queuedMessage(req) {
      return `승인했습니다. ${String(req.payload.taxYear ?? '')}년 영수증을 몇 분 안에 차례로 발급합니다. 진행 상황은 승인 대기함에서 볼 수 있습니다.`;
    },
    async execute(req, ctx) {
      const taxYear = Number(req.payload.taxYear);
      if (!Number.isInteger(taxYear)) throw new ApprovalError('귀속 연도가 올바르지 않습니다.');
      const prev = ctx.state as BatchProgress;
      const doneSet = new Set(prev.done ?? []);
      const r = await issueReceiptsBulk(req.merchantId, taxYear, ctx.userId, { deadline: ctx.deadline, skipPayers: doneSet });
      for (const d of r.details) doneSet.add(d.payerId);
      const state: BatchProgress = {
        done: [...doneSet],
        issued: (prev.issued ?? 0) + r.issued,
        skipped: (prev.skipped ?? 0) + r.skipped,
        failed: (prev.failed ?? 0) + r.failed,
      };
      const finished = r.remaining === 0;
      const message = `${taxYear}년 영수증 ${state.issued}건 발급, 건너뜀 ${state.skipped}건, 실패 ${state.failed}건${finished ? '' : ` · 남은 ${r.remaining}명 발급 중`}`;
      return { done: finished, message, state: state as Record<string, unknown> };
    },
  });
}
