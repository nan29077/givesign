import { env } from '@/lib/env';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { kstMonthKey } from '@/lib/datetime';
import { prisma } from '@/server/db';
import { PAID_STATUSES } from '@/components/studio/shared';
import { issueReceiptsBulk, issuerReadiness, doneeVerified } from './receipts';
import { sendMtDetailed } from './charge-flow';
import { coordinatorEnabled, sendRelational } from './outbound/coordinator';
import { decrypt } from '@/lib/crypto';
import * as tpl from './mt-templates';

/**
 * 월간 후원 안내 배치 (/api/cron/monthly-notice, 매월 1일).
 *
 *  - 전월에 후원한 분께 "전월 후원 횟수·금액 + 올해 누적 + 내역·영수증 링크" 를 보낸다.
 *    기관 채널이 알림톡 사용 중이면 알림톡, 아니면 문자(발송 계층이 결정·대체).
 *  - 기관별 영수증 주기가 MONTHLY 이면 안내 전에 발급되지 않은 올해 후원 건으로 영수증을 먼저 발급한다.
 *  - 멱등: (기관, 월) 실행 1행 + (실행, 후원자) 발송 1행. 중간에 멈춘 실행을 다시 돌려도 같은 사람에게 두 번 가지 않는다.
 *  - 동시성: 실행은 lockedAt/lockedBy 조건부 갱신으로 한 곳만 선점하고(TTL 10분), 발송 전에 발송 행(SENDING)을
 *    먼저 만들어 유니크 위반이면 건너뛴다. 수동 실행·배치·더블클릭이 겹쳐도 한 사람에 한 번만 나간다.
 *  - 후원자가 이 기관의 월간 안내를 거부(noticeOptOutAt)했으면 보내지 않는다.
 *  - 발송 실패는 다른 후원자·다른 기관 처리를 막지 않는다.
 */

export function previousMonthKey(now = new Date()): string {
  const [y, m] = kstMonthKey(now).split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** KST 월 경계 [start, end) */
export function monthRange(monthKey: string): { start: Date; end: Date } {
  const [y, m] = monthKey.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1, -9));
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, -9));
  return { start, end };
}

export interface MonthlyNoticeSummary {
  monthKey: string;
  merchants: number;
  sent: number;
  alimtalk: number;
  fallback: number;
  failed: number;
  skipped: number;
  receiptsIssued: number;
}

export async function runMonthlyNotices(now = new Date(), opts: { merchantId?: string; monthKey?: string } = {}): Promise<MonthlyNoticeSummary> {
  const monthKey = opts.monthKey ?? previousMonthKey(now);
  // 매월 발급 기관의 영수증을 먼저(월간 안내 스위치와 무관 — 2026-11-13 점검 A-H2). 실패가 안내를 막지 않는다.
  const receipts = await runMonthlyReceipts(now, { merchantId: opts.merchantId }).catch((e) => {
    logger.error('매월 영수증 발급 단계 실패 — 안내는 계속합니다', { message: (e as Error).message });
    return null;
  });
  const merchants = await prisma.merchantProfile.findMany({
    where: {
      status: 'APPROVED',
      monthlyNoticeEnabled: true,
      user: { status: 'ACTIVE', deletedAt: null },
      ...(opts.merchantId ? { id: opts.merchantId } : {}),
    },
    select: { id: true },
  });
  const summary: MonthlyNoticeSummary = { monthKey, merchants: 0, sent: 0, alimtalk: 0, fallback: 0, failed: 0, skipped: 0, receiptsIssued: receipts?.issued ?? 0 };
  for (const m of merchants) {
    try {
      const r = await runMerchantNotice(m.id, monthKey);
      if (!r) continue;
      summary.merchants += 1;
      summary.sent += r.sentCount;
      summary.alimtalk += r.alimtalkCount;
      summary.fallback += r.fallbackCount;
      summary.failed += r.failedCount;
      summary.skipped += r.skippedCount;
      // 안내 기록 화면의 "영수증" 칸: 이번 실행에서 그 기관에 발급한 장수를 함께 남긴다.
      const issuedHere = receipts?.byMerchant.get(m.id) ?? 0;
      if (issuedHere > 0) {
        await prisma.noticeRun.update({ where: { id: r.id }, data: { receiptsIssued: { increment: issuedHere } } }).catch(() => undefined);
      }
    } catch (e) {
      logger.error('월간 안내 기관 처리 실패', { merchantId: m.id, message: (e as Error).message });
    }
  }
  return summary;
}

/** 실행 선점 유지 시간. 이보다 오래 갱신이 없으면 멈춘 실행으로 보고 다른 실행이 이어받는다. */
export const NOTICE_RUN_LOCK_TTL_MS = 10 * 60_000;
/** 이만큼 보낼 때마다 선점 시각을 갱신한다. */
const HEARTBEAT_EVERY = 20;

async function openRun(merchantId: string, monthKey: string) {
  try {
    return await prisma.noticeRun.create({ data: { id: newId(), merchantId, monthKey } });
  } catch (e) {
    if ((e as { code?: string })?.code !== 'P2002') throw e;
    const existing = await prisma.noticeRun.findUniqueOrThrow({ where: { merchantId_monthKey: { merchantId, monthKey } } });
    // 끝난 실행은 다시 돌리지 않는다. 도중에 멈춘 실행(RUNNING)만 이어서 처리한다.
    return existing.status === 'DONE' ? null : existing;
  }
}

/**
 * 실행 선점. RUNNING 이면서 아무도 잡지 않았거나 선점이 TTL 을 넘긴 경우에만 조건부 갱신으로 잡는다.
 * 수동 "지금 보내기"·더블클릭·배치가 겹쳐도 한 실행만 발송 단계로 들어간다.
 */
async function claimRun(runId: string, owner: string, now = new Date()): Promise<boolean> {
  const r = await prisma.noticeRun.updateMany({
    where: {
      id: runId,
      status: 'RUNNING',
      OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - NOTICE_RUN_LOCK_TTL_MS) } }],
    },
    data: { lockedAt: now, lockedBy: owner },
  });
  return r.count === 1;
}

export type MerchantNoticeOutcome =
  | { outcome: 'ALREADY_DONE'; run: null }
  | { outcome: 'BUSY'; run: null }
  | { outcome: 'RAN'; run: Awaited<ReturnType<typeof prisma.noticeRun.update>> };

/** 기관 한 곳의 월간 안내. 이미 끝났으면 null, 다른 실행이 진행 중이어도 null. */
export async function runMerchantNotice(merchantId: string, monthKey: string) {
  return (await runMerchantNoticeDetailed(merchantId, monthKey)).run;
}

export async function runMerchantNoticeDetailed(merchantId: string, monthKey: string): Promise<MerchantNoticeOutcome> {
  const opened = await openRun(merchantId, monthKey);
  if (!opened) return { outcome: 'ALREADY_DONE', run: null };
  const owner = `${process.pid}:${newId()}`;
  if (!(await claimRun(opened.id, owner))) {
    const cur = await prisma.noticeRun.findUnique({ where: { id: opened.id }, select: { status: true } });
    return cur?.status === 'DONE' ? { outcome: 'ALREADY_DONE', run: null } : { outcome: 'BUSY', run: null };
  }
  try {
    const run = await processRun(opened.id, merchantId, monthKey, owner);
    return { outcome: 'RAN', run };
  } finally {
    // 끝났든 실패했든 내 선점일 때만 푼다(다른 실행이 TTL 뒤 이어받았으면 건드리지 않는다).
    await prisma.noticeRun
      .updateMany({ where: { id: opened.id, lockedBy: owner }, data: { lockedAt: null, lockedBy: null } })
      .catch(() => undefined);
  }
}

async function processRun(runId: string, merchantId: string, monthKey: string, owner: string) {
  const run = await prisma.noticeRun.findUniqueOrThrow({ where: { id: runId } });
  const merchant = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId } });
  const { start, end } = monthRange(monthKey);
  const taxYear = Number(monthKey.slice(0, 4));

  // 매월 영수증 발급은 runMonthlyReceipts 가 월간 안내 스위치와 무관하게 따로 한다(2026-11-13 점검 A-H2).
  // 같은 배치가 안내보다 먼저 부르므로 안내 문자의 "영수증 확인" 링크를 누르면 지난달분이 이미 보인다.
  const monthly = await prisma.charge.groupBy({
    by: ['payerId'],
    where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, payerId: { not: null }, paidAt: { gte: start, lt: end } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const payerIds = monthly.map((r) => r.payerId!);
  const yearStart = monthRange(`${taxYear}-01`).start;
  const [yearly, optOuts, done, payers] = await Promise.all([
    prisma.charge.groupBy({
      by: ['payerId'],
      where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, payerId: { in: payerIds }, paidAt: { gte: yearStart, lt: end } },
      _sum: { amount: true },
    }),
    prisma.payerMerchantLink.findMany({ where: { merchantId, payerId: { in: payerIds }, noticeOptOutAt: { not: null } }, select: { payerId: true } }),
    prisma.noticeDelivery.findMany({ where: { noticeRunId: run.id }, select: { payerId: true } }),
    prisma.payerProfile.findMany({ where: { id: { in: payerIds } }, select: { id: true, phoneEnc: true, blockedAt: true, onboardingStatus: true } }),
  ]);
  // 탈퇴·기관 차단도 발송 전에 뺀다(통합 발송을 끈 직접 발송 경로에는 대기열의 재확인이 없다 — 2026-11-13 점검 A-L6).
  const [blockedRows, blockedLinks] = await Promise.all([
    prisma.blockedPayer.findMany({ where: { merchantId, payerId: { in: payerIds } }, select: { payerId: true } }),
    prisma.payerMerchantLink.findMany({ where: { merchantId, payerId: { in: payerIds }, payerBlockedAt: { not: null } }, select: { payerId: true } }),
  ]);
  const blockedSet = new Set([...blockedRows.map((b) => b.payerId), ...blockedLinks.map((b) => b.payerId)]);
  const yearM = new Map(yearly.map((y) => [y.payerId!, y._sum.amount ?? 0n]));
  const optSet = new Set(optOuts.map((o) => o.payerId));
  const doneSet = new Set(done.map((d) => d.payerId));
  const payerM = new Map(payers.map((p) => [p.id, p]));
  const link = `${env.baseUrl}/my/receipts`;

  const counts = { recipients: 0, sent: 0, alimtalk: 0, fallback: 0, failed: 0, skipped: 0, queued: 0 };
  let handled = 0;
  for (const row of monthly) {
    const payerId = row.payerId!;
    if (doneSet.has(payerId)) continue;
    const payer = payerM.get(payerId);
    const amount = row._sum.amount ?? 0n;
    const skipReason = !payer
      ? '후원자 없음'
      : payer.onboardingStatus === 'WITHDRAWN'
        ? '탈퇴한 후원자'
        : payer.blockedAt || blockedSet.has(payerId)
          ? '이용 제한'
          : optSet.has(payerId)
            ? '월간 안내 수신 거부'
            : null;

    // 발송 전에 (실행, 후원자) 기록을 먼저 만든다. 유니크 위반이면 다른 실행이 이미 맡은 사람이라 건너뛴다.
    // 이 행이 SENDING 으로 남으면(발송 중 프로세스 종료) 다시 보내지 않는다 — 두 번 보내는 것보다 안전하다.
    const deliveryId = newId();
    try {
      await prisma.noticeDelivery.create({
        data: { id: deliveryId, noticeRunId: run.id, payerId, status: skipReason ? 'SKIPPED' : 'SENDING', amount, reason: skipReason },
      });
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') continue;
      logger.warn('월간 안내 발송 기록 실패 — 이 후원자는 건너뜁니다', { message: (e as Error).message });
      continue;
    }
    counts.recipients += 1;
    if (skipReason) {
      counts.skipped += 1;
      continue;
    }

    let status: 'SENT' | 'FAILED' | 'QUEUED' | 'SKIPPED' = 'FAILED';
    let channel: string | null = null;
    let mtId: string | null = null;
    let skipNote: string | null = null;
    try {
      const template = tpl.tplMonthlyNotice({
        merchantName: merchant.displayName,
        month: monthKey,
        amount,
        count: row._count._all,
        yearTotal: yearM.get(payerId) ?? amount,
        link,
      });
      // 통합 발송 관리(2026-11-09 D2): 켜져 있으면 발송 대기열로 — 같은 날 다른 정보성 안내와 묶고, 7일 상한·야간·담당자 확인 보류를 함께 적용한다.
      // 기록을 먼저 QUEUED 로 두고 쌓는다. 보낸 뒤 대기열이 SENT/FAILED/SKIPPED 와 실행 집계를 적는다(QUEUED 일 때만).
      let res: { ok: boolean; id: string | null; channel: string | null; fallback: boolean } | null = null;
      if (coordinatorEnabled()) {
        await prisma.noticeDelivery.update({ where: { id: deliveryId }, data: { status: 'QUEUED' } });
        const routed = await sendRelational({ merchantId, payerId, kind: 'MONTHLY_NOTICE', template, sendKey: `notice:${deliveryId}`, source: 'notice', sourceId: deliveryId, precounted: false });
        if (routed.mode === 'queued') status = 'QUEUED';
        else if (routed.mode === 'skipped') {
          status = 'SKIPPED';
          skipNote = routed.reason;
        } else res = { ok: routed.ok, id: routed.mtId, channel: routed.channel, fallback: routed.fallback };
      } else {
        res = await sendMtDetailed({ phone: decrypt(payer!.phoneEnc), template, merchantId });
      }
      if (status === 'QUEUED') counts.queued += 1;
      else if (status === 'SKIPPED') counts.skipped += 1;
      else if (res) {
        status = res.ok ? 'SENT' : 'FAILED';
        channel = res.channel;
        mtId = res.id;
        if (res.ok) {
          counts.sent += 1;
          if (res.channel === 'ALIMTALK') counts.alimtalk += 1;
        } else counts.failed += 1;
        if (res.fallback) counts.fallback += 1;
      }
    } catch (e) {
      counts.failed += 1;
      logger.warn('월간 안내 발송 예외', { message: (e as Error).message });
    }
    if (status !== 'QUEUED') {
      await prisma.noticeDelivery
        .update({ where: { id: deliveryId }, data: { status, channel, mtMessageId: mtId, ...(skipNote ? { reason: skipNote.slice(0, 200) } : {}) } })
        .catch((e) => logger.warn('월간 안내 발송 결과 기록 실패', { message: (e as Error).message }));
    }

    handled += 1;
    if (handled % HEARTBEAT_EVERY === 0) {
      await prisma.noticeRun.updateMany({ where: { id: run.id, lockedBy: owner }, data: { lockedAt: new Date() } }).catch(() => undefined);
    }
  }

  return prisma.noticeRun.update({
    where: { id: run.id },
    data: {
      status: 'DONE',
      finishedAt: new Date(),
      recipientCount: { increment: counts.recipients },
      sentCount: { increment: counts.sent },
      alimtalkCount: { increment: counts.alimtalk },
      fallbackCount: { increment: counts.fallback },
      failedCount: { increment: counts.failed },
      skippedCount: { increment: counts.skipped },
    },
  });
}

export interface MonthlyReceiptSummary {
  merchants: number;
  notReady: number;
  issued: number;
  skipped: number;
  failed: number;
}

/**
 * 매월 발급 기관의 영수증 자동 발급(2026-11-13 점검 A-H2).
 *
 *  - 예전에는 월간 안내 안에서만 발급해, 월간 안내를 끈 기관은 영수증이 자동 발급되지 않았다. 지금은 스위치와 무관하다.
 *  - 배치가 매월 1~5일 매일 돈다. issueReceiptsBulk 는 "아직 영수증에 묶이지 않은 결제 성공 건" 만 발급하므로 다시 돌아도 같은 결과다.
 *  - 귀속 연도: 지난달이 속한 해 + 1~2월이면 지난해도 함께(1월 1일 실행이 빠져 12월분이 영영 남던 문제).
 *  - 기관이 발급 요건(관리자 공익법인 확인·고유번호·대표자·소재지)을 갖추지 않았으면 건너뛴다(예전과 같다).
 */
export async function runMonthlyReceipts(now = new Date(), opts: { merchantId?: string } = {}): Promise<MonthlyReceiptSummary & { byMerchant: Map<string, number> }> {
  const out = { merchants: 0, notReady: 0, issued: 0, skipped: 0, failed: 0, byMerchant: new Map<string, number>() };
  const thisYear = Number(kstMonthKey(now).slice(0, 4));
  const month = Number(kstMonthKey(now).slice(5, 7));
  const years = [...new Set([Number(previousMonthKey(now).slice(0, 4)), ...(month <= 2 ? [thisYear - 1] : [])])].sort();
  const merchants = await prisma.merchantProfile.findMany({
    where: { status: 'APPROVED', receiptCycle: 'MONTHLY', user: { status: 'ACTIVE', deletedAt: null }, ...(opts.merchantId ? { id: opts.merchantId } : {}) },
  });
  for (const m of merchants) {
    out.merchants += 1;
    if (!(doneeVerified(m, now) && issuerReadiness(m).ok)) {
      out.notReady += 1;
      continue;
    }
    for (const year of years) {
      try {
        const r = await issueReceiptsBulk(m.id, year, 'SYSTEM');
        out.issued += r.issued;
        out.byMerchant.set(m.id, (out.byMerchant.get(m.id) ?? 0) + r.issued);
        out.skipped += r.skipped;
        out.failed += r.failed;
      } catch (e) {
        out.failed += 1;
        logger.error('월별 영수증 일괄 발급 실패 — 다음 실행에서 다시 시도합니다', { merchantId: m.id, year, message: (e as Error).message });
      }
    }
  }
  return out;
}
