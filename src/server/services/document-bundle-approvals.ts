import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { kstDateKey } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { forecastEDocCost, type EDocForecast } from '@/lib/edoc-forecast';
import { APPROVAL_KIND_LABEL, registerApprovalHandler, requestApproval, type ApprovalRow } from './approvals';
import { registerConsumer } from './events';
import {
  BundleError,
  handleRecurringPledgedBundle,
  refreshBundlesForEnvelope,
  retryBalanceBlocked,
  sendBundle,
  type SendBundleInput,
} from './document-bundles';

/**
 * 문서 묶음 — 대량 발송 승인(BUNDLE_SEND) · 이벤트 소비자 등록 (2026-11-12 4차 J2·J3).
 *
 *  - 대상: 진행 중(일시정지 포함) 정기후원자(정기후원 신청 묶음) / 승인된 봉사 신청자(봉사 신청 묶음).
 *    이미 이 묶음을 받았거나(보냄·완료) 탈퇴·차단된 후원자는 뺀다.
 *  - 승인 대기함 확인 화면에 이용요금 예측(예상 문서 건수 × 현재 요금, 정액 → 시범 → 충전 순)을 보인다.
 *  - 승인하면 QUEUED → runQueuedApprovals 가 나눠 보낸다. 잔액이 모자란 후원자 발송은 BLOCKED 로 남고, 충전되면 소비자가 이어서 보낸다.
 *
 * 소비자
 *  - edoc-balance-retry (edoc.balance_added) : 멈춘 서명 문서 발송을 오래된 것부터 지금 잔액만큼 다시 시도
 *  - bundle-status (document.signed / document.closed) : 묶음 상태(완료·닫힘) 맞추기
 *  - recurring-bundle (recurring.pledged) : 기관이 켰을 때만 정기후원 신청 묶음 발송(기본 꺼짐)
 */

export type BundleTarget = 'RECURRING_ACTIVE' | 'VOLUNTEER_APPROVED';

export const BUNDLE_TARGET_LABEL: Record<BundleTarget, string> = {
  RECURRING_ACTIVE: '진행 중인 정기후원자',
  VOLUNTEER_APPROVED: '승인된 자원봉사 신청자',
};

interface TargetRow {
  payerId: string;
  context: SendBundleInput['context'];
}

async function bundleTargets(merchantId: string, bundleId: string, target: BundleTarget): Promise<{ rows: TargetRow[]; already: number; excluded: number }> {
  let rows: TargetRow[] = [];
  if (target === 'RECURRING_ACTIVE') {
    const rs = await prisma.recurringDonation.findMany({
      where: { merchantId, status: { in: ['ACTIVE', 'PAUSED'] } },
      select: { id: true, payerId: true, amount: true, dayOfMonth: true, campaign: { select: { title: true } } },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    });
    rows = rs.map((r) => ({ payerId: r.payerId, context: { amount: r.amount, dayOfMonth: r.dayOfMonth, campaignTitle: r.campaign?.title ?? null, recurringId: r.id } }));
  } else {
    const vs = await prisma.volunteerApplication.findMany({
      where: { merchantId, status: 'APPROVED' },
      select: { payerId: true, assignment: true },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    });
    const seen = new Set<string>();
    for (const v of vs) {
      if (seen.has(v.payerId)) continue;
      seen.add(v.payerId);
      rows.push({ payerId: v.payerId, context: { assignment: v.assignment ?? null } });
    }
  }
  const ids = rows.map((r) => r.payerId);
  const [got, payers, blocked] = await Promise.all([
    prisma.documentBundleSend.findMany({ where: { merchantId, bundleId, payerId: { in: ids }, status: { in: ['SENT', 'COMPLETED'] } }, select: { payerId: true } }),
    prisma.payerProfile.findMany({ where: { id: { in: ids } }, select: { id: true, onboardingStatus: true } }),
    prisma.blockedPayer.findMany({ where: { merchantId, payerId: { in: ids } }, select: { payerId: true } }),
  ]);
  const gotSet = new Set(got.map((g) => g.payerId));
  const withdrawn = new Set(payers.filter((p) => p.onboardingStatus === 'WITHDRAWN').map((p) => p.id));
  const blockedSet = new Set(blocked.map((b) => b.payerId));
  const out = rows.filter((r) => !gotSet.has(r.payerId) && !withdrawn.has(r.payerId) && !blockedSet.has(r.payerId));
  return { rows: out, already: rows.filter((r) => gotSet.has(r.payerId)).length, excluded: rows.filter((r) => withdrawn.has(r.payerId) || blockedSet.has(r.payerId)).length };
}

/** 후원자 1명에게 새로 만들어질(이용요금이 드는) 문서 수. 약정서는 약정 흐름 서명 요청을 잇기만 하므로 빼고 센다. */
export async function bundleUnitsPerRecipient(bundleId: string): Promise<number> {
  const items = await prisma.documentBundleItem.findMany({ where: { bundleId } });
  return items.filter((i) => i.purpose !== 'SUPPORT_AGREEMENT').length;
}

/** 지금 지갑으로 N건을 보내면(정액 → 시범 → 충전 순) */
export async function edocForecastFor(merchantId: string, count: number): Promise<EDocForecast> {
  const { walletOverview } = await import('./edoc-billing');
  const w = await walletOverview(merchantId);
  return forecastEDocCost({ monthlyLeft: w.monthlyLeft, trialLeft: w.wallet.trialRemaining, balance: w.wallet.balance, perDocument: w.plan.perDocument }, count);
}

export async function requestBundleSend(merchantId: string, bundleId: string, target: BundleTarget) {
  const bundle = await prisma.documentBundle.findFirst({ where: { id: bundleId, merchantId, archivedAt: null } });
  if (!bundle) throw new BundleError('묶음을 찾을 수 없습니다.');
  if (target === 'RECURRING_ACTIVE' && bundle.kind !== 'RECURRING_SIGNUP') throw new BundleError('정기후원자에게는 정기후원 신청 묶음만 보낼 수 있습니다.');
  if (target === 'VOLUNTEER_APPROVED' && bundle.kind !== 'VOLUNTEER_SIGNUP') throw new BundleError('봉사 신청자에게는 자원봉사 신청 묶음만 보낼 수 있습니다.');
  const open = await prisma.approvalRequest.count({ where: { merchantId, kind: 'BUNDLE_SEND', subjectId: bundleId, status: { in: ['PENDING', 'PROCESSING', 'QUEUED'] } } });
  if (open) throw new BundleError('이미 승인 대기함에 이 묶음 발송 요청이 있습니다.');
  const { rows, already } = await bundleTargets(merchantId, bundleId, target);
  if (!rows.length) throw new BundleError(already ? '모든 대상이 이미 이 묶음을 받았습니다.' : '보낼 대상이 없습니다.');
  const units = await bundleUnitsPerRecipient(bundleId);
  const n = await prisma.approvalRequest.count({ where: { merchantId, kind: 'BUNDLE_SEND', subjectId: bundleId } });
  const { request, created } = await requestApproval({
    merchantId,
    kind: 'BUNDLE_SEND',
    title: `문서 묶음 발송 — ${bundle.name}`.slice(0, 120),
    summary: `${BUNDLE_TARGET_LABEL[target]} ${formatNumber(rows.length)}명 · 1명당 서명 문서 ${units}건`,
    payload: { bundleId, target, targetCount: rows.length, units },
    subjectType: 'document_bundle',
    subjectId: bundleId,
    dedupeKey: `bundle-send:${bundleId}:${kstDateKey()}:${n + 1}`,
  });
  return { approvalId: request.id, created, targetCount: rows.length };
}

interface Progress {
  done?: string[];
  sent?: number;
  blocked?: number;
  failed?: number;
}

async function executeBundleSend(req: ApprovalRow, ctx: { deadline: Date; now: () => Date; state: Record<string, unknown> }) {
  const bundleId = String(req.payload.bundleId ?? req.subjectId ?? '');
  const target = String(req.payload.target ?? '') as BundleTarget;
  const bundle = await prisma.documentBundle.findFirst({ where: { id: bundleId, merchantId: req.merchantId, archivedAt: null } });
  if (!bundle || !(target in BUNDLE_TARGET_LABEL)) return { done: true, message: '묶음이 보관되어 발송을 멈췄습니다.', state: ctx.state };
  const prev = ctx.state as Progress;
  const done = new Set(prev.done ?? []);
  const p = { sent: prev.sent ?? 0, blocked: prev.blocked ?? 0, failed: prev.failed ?? 0 };
  const { rows } = await bundleTargets(req.merchantId, bundleId, target);
  let remaining = 0;
  for (const r of rows) {
    if (done.has(r.payerId)) continue;
    if (ctx.now() >= ctx.deadline) {
      remaining += 1;
      continue;
    }
    const out = await sendBundle({
      merchantId: req.merchantId,
      bundleId,
      payerId: r.payerId,
      context: r.context,
      dedupeKey: `bundle:approval:${req.id}:${r.payerId}`,
      subject: { type: 'approval_request', id: req.id },
    });
    if (out.ok) p.sent += 1;
    else if (out.status === 'BLOCKED') p.blocked += 1;
    else p.failed += 1;
    done.add(r.payerId);
  }
  const message = `문서 묶음 ${formatNumber(p.sent)}명 발송 · 멈춤 ${formatNumber(p.blocked)}명(잔액·점검 — 충전되면 이어서 보냅니다) · 실패 ${formatNumber(p.failed)}명${remaining ? ` · 남은 ${formatNumber(remaining)}명 발송 중` : ''}`;
  return { done: remaining === 0, message, state: { ...p, done: [...done] } as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// 승인 전 확인 화면 — 저장·발송하지 않음
// ---------------------------------------------------------------------------

export interface BundleSendPreview {
  approval: { id: string; kindLabel: string; title: string; summary: string | null; status: string; createdAt: Date; result: string | null };
  bundleName: string;
  targetLabel: string;
  targetCount: number;
  alreadySent: number;
  excluded: number;
  units: number;
  forecast: EDocForecast;
  samples: string[];
}

export async function bundleSendPreview(merchantId: string, approvalId: string): Promise<BundleSendPreview | null> {
  const a = await prisma.approvalRequest.findFirst({ where: { id: approvalId, merchantId, kind: 'BUNDLE_SEND' } });
  if (!a) return null;
  const payload = (a.payload ?? {}) as Record<string, unknown>;
  const bundleId = String(payload.bundleId ?? a.subjectId ?? '');
  const target = String(payload.target ?? '') as BundleTarget;
  const bundle = await prisma.documentBundle.findFirst({ where: { id: bundleId, merchantId } });
  if (!bundle || !(target in BUNDLE_TARGET_LABEL)) return null;
  const { rows, already, excluded } = await bundleTargets(merchantId, bundleId, target);
  const units = await bundleUnitsPerRecipient(bundleId);
  const forecast = await edocForecastFor(merchantId, rows.length * units);
  const payers = await prisma.payerProfile.findMany({ where: { id: { in: rows.slice(0, 3).map((r) => r.payerId) } }, select: { displayName: true, phoneMasked: true } });
  return {
    approval: { id: a.id, kindLabel: APPROVAL_KIND_LABEL.BUNDLE_SEND, title: a.title, summary: a.summary, status: a.status, createdAt: a.createdAt, result: a.result },
    bundleName: bundle.name,
    targetLabel: BUNDLE_TARGET_LABEL[target],
    targetCount: rows.length,
    alreadySent: already,
    excluded,
    units,
    forecast,
    samples: payers.map((p) => (p.displayName ? `${p.displayName} (${p.phoneMasked})` : p.phoneMasked)),
  };
}

// ---------------------------------------------------------------------------
// 등록
// ---------------------------------------------------------------------------

let registered = false;
export function registerDocumentBundleHandlers() {
  if (registered) return;
  registered = true;
  registerApprovalHandler('BUNDLE_SEND', {
    async onApprove(req) {
      const r = await executeBundleSend(req, { deadline: new Date(Date.now() + 60_000), now: () => new Date(), state: (req.payload.progress ?? {}) as Record<string, unknown> });
      return r.message;
    },
    queuedMessage: () => '승인했습니다. 몇 분 안에 차례로 묶음 서명 링크를 보냅니다. 잔액이 모자라면 멈춘 곳부터 충전 뒤 이어서 보냅니다.',
    execute: (req, ctx) => executeBundleSend(req, ctx),
  });
  registerConsumer({
    name: 'edoc-balance-retry',
    types: ['edoc.balance_added'],
    async handle(ev) {
      const r = await retryBalanceBlocked(ev.merchantId);
      if (r.journeys || r.bundles) logger.info('충전 뒤 멈춘 서명 문서 다시 시도', { merchantId: ev.merchantId, ...r });
      return r.journeys || r.bundles ? undefined : ('SKIPPED' as const);
    },
  });
  registerConsumer({ name: 'bundle-status', types: ['document.signed', 'document.closed'], handle: (ev) => refreshBundlesForEnvelope(ev.subjectId) });
  registerConsumer({ name: 'recurring-bundle', types: ['recurring.pledged'], handle: (ev) => handleRecurringPledgedBundle(ev) });
}
