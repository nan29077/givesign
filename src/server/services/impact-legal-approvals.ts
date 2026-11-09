import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { newId } from '@/lib/id';
import { kstDateKey } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import type { SampleKind } from '@/lib/document-preflight';
import type { MergeValues } from '@/lib/merge-fields';
import { APPROVAL_KIND_LABEL, ApprovalError, registerApprovalHandler, requestApproval, type ApprovalRow } from './approvals';
import { issuePurposeDocument, type DocumentPurpose, type MergeContext } from './purpose-documents';
import { mergeValuesFromContext, resolvePurposeTemplate } from './purpose-templates';
import { tplDocumentIssued } from './mt-templates';
import { sendMtForPayer } from './charge-flow';
import { coordinatorEnabled, sendRelational } from './outbound/coordinator';
import type { RelationalKind } from './outbound/classify';
import {
  ImpactError,
  RECIPIENT_EXCLUDE_LABEL,
  filterRecipients,
  impactRecipients,
  participationText,
  type RecipientExcludeReason,
} from './impact-reports';
import {
  LegalReportError,
  annualNoticeParticipants,
  annualParticipationText,
  incomeStatement,
  usageStatement,
  usageSummaryText,
} from './legal-reports';

/**
 * 대량 정보성 문서 발송 승인 — 2026-11-09 3차 H.
 *
 *  - IMPACT_REPORT_SEND : 승인된 사업 진행 기록의 결과 보고를 참여 후원자에게(용도 IMPACT_REPORT).
 *  - ANNUAL_NOTICE_SEND : 후원금 수입·사용 연 1회 통보(용도 ANNUAL_DONATION_NOTICE, (기관, 연도, 후원자) 1회 — legal_notice_delivery 유니크).
 *
 * 승인 대기함 확인 화면(대상 수·표본 3건·비용)을 거쳐 승인하면 QUEUED 로만 기록되고 `/api/cron/events` 의
 * runQueuedApprovals 가 시간 상한 안에서 나눠 보낸다(기존 RECEIPT_BATCH 방식). 문서는 issuePurposeDocument(발송 전 점검 자동 적용),
 * 안내 문자는 통합 발송 대기열(sendRelational — 7일 상한·묶음·야간 보류). 같은 후원자에게는 dedupeKey 로 한 번만.
 */

export const INFO_SEND_KINDS = ['IMPACT_REPORT_SEND', 'ANNUAL_NOTICE_SEND'] as const;
export function isInfoSendKind(kind: string): boolean {
  return (INFO_SEND_KINDS as readonly string[]).includes(kind);
}

type SendStatus = 'SENT' | 'SKIPPED' | 'FAILED';

/** 발급된 열람 문서의 첫 안내 — 관계·정보형이라 대기열로(상한을 센다: precounted=false). */
async function notifyIssued(input: { issuedId: string; merchantId: string; payerId: string; title: string; link: string; kind: RelationalKind }) {
  const merchant = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: input.merchantId }, select: { displayName: true } });
  const template = tplDocumentIssued({ merchantName: merchant.displayName, title: input.title, link: input.link });
  if (coordinatorEnabled()) {
    const r = await sendRelational({
      merchantId: input.merchantId, payerId: input.payerId, kind: input.kind, template,
      sendKey: `issued:${input.issuedId}`, source: 'issued_document', sourceId: input.issuedId, precounted: false,
    });
    if (r.mode !== 'direct') return; // 대기열이 결과를 발급 문서에 적는다
    await recordNotice(input.issuedId, r.ok);
    return;
  }
  await recordNotice(input.issuedId, await sendMtForPayer(input.payerId, template, null, input.merchantId));
}

async function recordNotice(issuedId: string, ok: boolean) {
  await prisma.issuedDocument.update({
    where: { id: issuedId },
    data: ok ? { sentAt: new Date(), sendCount: { increment: 1 }, sendError: null } : { sendError: '문자 발송 실패' },
  });
}

async function sendInformational(input: {
  merchantId: string;
  payerId: string;
  purpose: DocumentPurpose;
  context: MergeContext;
  subject: { type: string; id: string };
  dedupeKey: string;
  kind: RelationalKind;
}): Promise<{ status: SendStatus; reason?: string; issuedId?: string }> {
  const r = await issuePurposeDocument({ ...input, notify: false });
  if (!r.ok) return { status: r.blocked === 'WITHDRAWN' ? 'SKIPPED' : 'FAILED', reason: r.reason };
  if (!r.already && r.link) {
    try {
      const doc = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.issuedId }, select: { title: true } });
      await notifyIssued({ issuedId: r.issuedId, merchantId: input.merchantId, payerId: input.payerId, title: doc.title, link: r.link, kind: input.kind });
    } catch (e) {
      // 문서는 발급됐다. 안내 실패는 발급을 되돌리지 않는다(사후 처리 실패 분리) — 발급 목록에서 다시 보낼 수 있다.
      logger.warn('정보성 문서 안내 실패', { issuedId: r.issuedId, message: (e as Error).message });
      await prisma.issuedDocument.update({ where: { id: r.issuedId }, data: { sendError: '안내 문자 오류' } }).catch(() => undefined);
    }
  }
  // already: 같은 발송 키로 이미 발급됐다(재시도). 안내가 대기열에도 없고 보낸 적도 없을 때만(중단 뒤 재실행) 다시 안내한다.
  if (r.already) {
    const [doc, queued] = await Promise.all([
      prisma.issuedDocument.findUnique({ where: { id: r.issuedId }, select: { sentAt: true, sendError: true } }),
      prisma.outboundQueue.count({ where: { sendKey: `issued:${r.issuedId}` } }),
    ]);
    if (doc && !doc.sentAt && !doc.sendError && queued === 0) {
      const { resendIssuedDocument } = await import('./issued-documents');
      await resendIssuedDocument({ merchantId: input.merchantId, id: r.issuedId }).catch((e) => logger.warn('정보성 문서 재안내 실패', { issuedId: r.issuedId, message: (e as Error).message }));
    }
  }
  return { status: 'SENT', issuedId: r.issuedId };
}

async function assertTemplateSendable(merchantId: string, purpose: DocumentPurpose) {
  const t = await resolvePurposeTemplate(merchantId, purpose);
  if (!t) throw new ApprovalError('보낼 서식이 없습니다. 서식·제출 문서 화면에서 확인해 주세요.');
  if (!t.active || !t.autoSend) throw new ApprovalError('이 용도의 서식이 중지(또는 자동 발송 끔) 상태입니다. 서식을 켠 뒤 "다시 실행" 해 주세요.');
  return t;
}

interface Progress {
  done?: string[];
  sent?: number;
  skipped?: number;
  failed?: number;
}

function progressMessage(label: string, p: Required<Progress>, remaining: number) {
  return `${label} ${formatNumber(p.sent)}명 발송, 건너뜀 ${formatNumber(p.skipped)}명, 실패 ${formatNumber(p.failed)}명${remaining ? ` · 남은 ${formatNumber(remaining)}명 발송 중` : ''}`;
}

// ---------------------------------------------------------------------------
// 사업 결과 보고 발송
// ---------------------------------------------------------------------------

export async function requestImpactSend(merchantId: string, id: string) {
  const u = await prisma.impactUpdate.findFirst({ where: { id, merchantId, archivedAt: null } });
  if (!u) throw new ImpactError('진행 기록을 찾을 수 없습니다.');
  if (u.status !== 'APPROVED' && u.status !== 'SENT') throw new ImpactError('담당자가 승인한 기록만 보낼 수 있습니다.');
  if (!u.report?.trim()) throw new ImpactError('후원자용 보고서가 비어 있습니다.');
  const open = await prisma.approvalRequest.count({ where: { merchantId, kind: 'IMPACT_REPORT_SEND', subjectId: id, status: { in: ['PENDING', 'PROCESSING', 'QUEUED'] } } });
  if (open) throw new ImpactError('이미 승인 대기함에 발송 요청이 있습니다.');
  const { recipients, excluded } = await impactRecipients(u);
  const already = await prisma.issuedDocument.count({ where: { merchantId, purpose: 'IMPACT_REPORT', subjectType: 'impact_update', subjectId: id } });
  const target = Math.max(0, recipients.length - already);
  if (recipients.length === 0) throw new ImpactError('보낼 참여 후원자가 없습니다(탈퇴·차단·수신 거부 제외).');
  if (u.status === 'SENT' && target === 0) throw new ImpactError('새로 참여한 후원자가 없습니다. 이미 받은 분께는 다시 보내지 않습니다.');
  const n = await prisma.approvalRequest.count({ where: { merchantId, kind: 'IMPACT_REPORT_SEND', subjectId: id } });
  const excludedCount = Object.values(excluded).reduce((a, b) => a + b, 0);
  const { request, created } = await requestApproval({
    merchantId,
    kind: 'IMPACT_REPORT_SEND',
    title: `사업 결과 보고 발송 — ${u.title}`.slice(0, 120),
    summary: `대상 ${formatNumber(recipients.length)}명${already ? `(이미 받은 ${formatNumber(already)}명은 다시 보내지 않음)` : ''} · 제외 ${formatNumber(excludedCount)}명`,
    payload: { updateId: id, targetCount: recipients.length },
    subjectType: 'impact_update',
    subjectId: id,
    dedupeKey: `impact-send:${id}:${n + 1}`,
  });
  return { approvalId: request.id, created, targetCount: recipients.length };
}

async function executeImpact(req: ApprovalRow, ctx: { deadline: Date; now: () => Date; state: Record<string, unknown> }) {
  const id = String(req.payload.updateId ?? req.subjectId ?? '');
  const u = await prisma.impactUpdate.findFirst({ where: { id, merchantId: req.merchantId } });
  if (!u || u.archivedAt || (u.status !== 'APPROVED' && u.status !== 'SENT') || !u.report) {
    return { done: true, message: '진행 기록이 수정·보관되어 발송을 멈췄습니다. 다시 승인한 뒤 보내 주세요.', state: ctx.state };
  }
  await assertTemplateSendable(req.merchantId, 'IMPACT_REPORT');
  const campaignTitle = u.campaignId ? (await prisma.campaign.findUnique({ where: { id: u.campaignId }, select: { title: true } }))?.title ?? null : null;
  const prev = ctx.state as Progress;
  const done = new Set(prev.done ?? []);
  const p: Required<Progress> = { done: [], sent: prev.sent ?? 0, skipped: prev.skipped ?? 0, failed: prev.failed ?? 0 };
  const { recipients } = await impactRecipients(u);
  let remaining = 0;
  for (const r of recipients) {
    if (done.has(r.payerId)) continue;
    if (ctx.now() >= ctx.deadline) {
      remaining += 1;
      continue;
    }
    const out = await sendInformational({
      merchantId: req.merchantId,
      payerId: r.payerId,
      purpose: 'IMPACT_REPORT',
      context: { reportTitle: u.title, reportBody: u.report, participation: participationText(r), campaignTitle },
      subject: { type: 'impact_update', id: u.id },
      dedupeKey: `impact:${u.id}:${r.payerId}`,
      kind: 'IMPACT_REPORT',
    });
    done.add(r.payerId);
    if (out.status === 'SENT') p.sent += 1;
    else if (out.status === 'SKIPPED') p.skipped += 1;
    else {
      p.failed += 1;
      logger.warn('사업 결과 보고 발송 실패', { updateId: u.id, reason: out.reason?.slice(0, 120) });
    }
  }
  p.done = [...done];
  const finished = remaining === 0;
  if (finished) await prisma.impactUpdate.updateMany({ where: { id: u.id, status: 'APPROVED' }, data: { status: 'SENT', sentAt: new Date() } });
  return { done: finished, message: progressMessage('사업 결과 보고', p, remaining), state: p as unknown as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// 연 1회 통보 발송
// ---------------------------------------------------------------------------

export async function annualNoticeTargets(merchantId: string, year: number) {
  const participants = await annualNoticeParticipants(merchantId, year);
  const { recipients, excluded } = await filterRecipients(merchantId, participants);
  const sent = await prisma.legalNoticeDelivery.findMany({ where: { merchantId, taxYear: year, status: 'SENT' }, select: { payerId: true } });
  const sentSet = new Set(sent.map((s) => s.payerId));
  return { recipients, pending: recipients.filter((r) => !sentSet.has(r.payerId)), alreadySent: sentSet.size, excluded };
}

export async function requestAnnualNotice(merchantId: string, year: number) {
  const nowYear = Number(kstDateKey().slice(0, 4));
  if (!Number.isInteger(year) || year < 2020 || year >= nowYear) throw new LegalReportError('연 1회 통보는 끝난 해(지난해까지)만 보낼 수 있습니다.');
  const open = await prisma.approvalRequest.count({ where: { merchantId, kind: 'ANNUAL_NOTICE_SEND', subjectId: String(year), status: { in: ['PENDING', 'PROCESSING', 'QUEUED'] } } });
  if (open) throw new LegalReportError('이미 승인 대기함에 그해 통보 요청이 있습니다.');
  const t = await annualNoticeTargets(merchantId, year);
  if (!t.pending.length) throw new LegalReportError(t.alreadySent ? `${year}년 통보를 받을 후원자 모두에게 이미 보냈습니다(연 1회).` : `${year}년 수입이 있는 후원자가 없습니다.`);
  const n = await prisma.approvalRequest.count({ where: { merchantId, kind: 'ANNUAL_NOTICE_SEND', subjectId: String(year) } });
  const excludedCount = Object.values(t.excluded).reduce((a, b) => a + b, 0);
  const { request, created } = await requestApproval({
    merchantId,
    kind: 'ANNUAL_NOTICE_SEND',
    title: `${year}년 후원금 수입·사용 연간 통보 ${formatNumber(t.pending.length)}명`,
    summary: `이미 받은 ${formatNumber(t.alreadySent)}명은 다시 보내지 않음 · 제외 ${formatNumber(excludedCount)}명`,
    payload: { taxYear: year, targetCount: t.pending.length },
    subjectType: 'annual_notice',
    subjectId: String(year),
    dedupeKey: `annual-notice:${merchantId}:${year}:${n + 1}`,
  });
  return { approvalId: request.id, created, targetCount: t.pending.length };
}

/** (기관, 연도, 후원자) 통보 행 선점. 이미 SENT 면 null. FAILED·멈춘 SENDING 은 다시 잡는다(문서 발송은 dedupeKey 로 한 번). */
async function claimNotice(merchantId: string, year: number, payerId: string, approvalId: string, amount: bigint, count: number) {
  const created = await prisma.legalNoticeDelivery.createMany({
    data: [{ id: newId(), merchantId, taxYear: year, payerId, approvalId, amount, count, status: 'SENDING' }],
    skipDuplicates: true,
  });
  if (created.count === 1) return true;
  const r = await prisma.legalNoticeDelivery.updateMany({
    where: { merchantId, taxYear: year, payerId, status: { in: ['FAILED', 'SENDING'] } },
    data: { status: 'SENDING', approvalId, amount, count, reason: null },
  });
  return r.count === 1;
}

async function executeAnnual(req: ApprovalRow, ctx: { deadline: Date; now: () => Date; state: Record<string, unknown> }) {
  const year = Number(req.payload.taxYear ?? req.subjectId);
  if (!Number.isInteger(year)) throw new ApprovalError('귀속 연도가 올바르지 않습니다.');
  await assertTemplateSendable(req.merchantId, 'ANNUAL_DONATION_NOTICE');
  const [income, usage, t] = await Promise.all([incomeStatement(req.merchantId, year, 'public'), usageStatement(req.merchantId, year), annualNoticeTargets(req.merchantId, year)]);
  const summary = usageSummaryText(income, usage);
  const prev = ctx.state as Progress;
  const done = new Set(prev.done ?? []);
  const p: Required<Progress> = { done: [], sent: prev.sent ?? 0, skipped: prev.skipped ?? 0, failed: prev.failed ?? 0 };
  let remaining = 0;
  for (const r of t.recipients) {
    if (done.has(r.payerId)) continue;
    if (ctx.now() >= ctx.deadline) {
      remaining += 1;
      continue;
    }
    done.add(r.payerId);
    if (!(await claimNotice(req.merchantId, year, r.payerId, req.id, r.amount, r.count))) {
      p.skipped += 1; // 이미 보냄(연 1회)
      continue;
    }
    const out = await sendInformational({
      merchantId: req.merchantId,
      payerId: r.payerId,
      purpose: 'ANNUAL_DONATION_NOTICE',
      context: { taxYear: year, participation: annualParticipationText(year, r), usageSummary: summary, totalAmount: r.amount, count: r.count },
      subject: { type: 'annual_notice', id: String(year) },
      dedupeKey: `annual-notice:${req.merchantId}:${year}:${r.payerId}`,
      kind: 'ANNUAL_NOTICE',
    });
    await prisma.legalNoticeDelivery.updateMany({
      where: { merchantId: req.merchantId, taxYear: year, payerId: r.payerId, status: 'SENDING' },
      data: { status: out.status === 'SENT' ? 'SENT' : 'FAILED', issuedDocumentId: out.issuedId ?? null, reason: out.reason?.slice(0, 300) ?? null },
    });
    if (out.status === 'SENT') p.sent += 1;
    else if (out.status === 'SKIPPED') p.skipped += 1;
    else p.failed += 1;
  }
  p.done = [...done];
  return { done: remaining === 0, message: progressMessage(`${year}년 연간 통보`, p, remaining), state: p as unknown as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// 등록
// ---------------------------------------------------------------------------

let registered = false;
export function registerImpactLegalHandlers() {
  if (registered) return;
  registered = true;
  registerApprovalHandler('IMPACT_REPORT_SEND', {
    async onApprove(req) {
      const r = await executeImpact(req, { deadline: new Date(Date.now() + 60_000), now: () => new Date(), state: (req.payload.progress ?? {}) as Record<string, unknown> });
      return r.message;
    },
    queuedMessage: () => '승인했습니다. 몇 분 안에 참여 후원자에게 차례로 보냅니다(야간·7일 상한은 통합 발송 대기열 규칙). 진행 상황은 승인 대기함에서 볼 수 있습니다.',
    execute: (req, ctx) => executeImpact(req, ctx),
  });
  registerApprovalHandler('ANNUAL_NOTICE_SEND', {
    async onApprove(req) {
      const r = await executeAnnual(req, { deadline: new Date(Date.now() + 60_000), now: () => new Date(), state: (req.payload.progress ?? {}) as Record<string, unknown> });
      return r.message;
    },
    queuedMessage: (req) => `승인했습니다. ${String(req.payload.taxYear ?? '')}년 연간 통보를 몇 분 안에 차례로 보냅니다. 같은 후원자에게는 한 해 한 번만 보냅니다.`,
    execute: (req, ctx) => executeAnnual(req, ctx),
  });
}

// ---------------------------------------------------------------------------
// 승인 전 확인(대상 수 · 표본 3건 · 비용) — 저장·발송하지 않음
// ---------------------------------------------------------------------------

export interface InfoSendPreview {
  approval: { id: string; kind: string; kindLabel: string; title: string; summary: string | null; status: string; createdAt: Date; result: string | null };
  purposeLabel: string;
  targetCount: number;
  alreadySent: number;
  requestedCount: number | null;
  excluded: Array<{ reason: RecipientExcludeReason; label: string; count: number }>;
  samples: Array<{ kind: SampleKind; label: string; html: string | null; level: string; issues: string[] }>;
  cost: { edocAmount: bigint; note: string };
  blocked: string | null;
}

async function sampleCandidates(merchantId: string, rows: Array<{ payerId: string; ctx: MergeContext }>) {
  const ids = rows.slice(0, 200).map((r) => r.payerId);
  const [payers, m] = await Promise.all([
    prisma.payerProfile.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, phoneMasked: true } }),
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { displayName: true, representativeName: true } }),
  ]);
  const pm = new Map(payers.map((p) => [p.id, p]));
  return rows.slice(0, 200).map((r) => {
    const p = pm.get(r.payerId);
    const values: MergeValues = mergeValuesFromContext({ ...r.ctx, donorName: p?.displayName || `후원자${(p?.phoneMasked ?? '').slice(-4)}` }, { merchantName: m.displayName, representative: m.representativeName ?? null });
    return { key: r.payerId, label: `${p?.displayName ?? '후원자'} ${p?.phoneMasked ?? ''}`.trim(), values, recipient: { hasContact: true } };
  });
}

export async function infoSendPreview(merchantId: string, approvalId: string): Promise<InfoSendPreview | null> {
  const a = await prisma.approvalRequest.findFirst({ where: { id: approvalId, merchantId } });
  if (!a || !isInfoSendKind(a.kind)) return null;
  const payload = (a.payload ?? {}) as Record<string, unknown>;
  const purpose: DocumentPurpose = a.kind === 'IMPACT_REPORT_SEND' ? 'IMPACT_REPORT' : 'ANNUAL_DONATION_NOTICE';
  const template = await resolvePurposeTemplate(merchantId, purpose);
  let targetCount = 0;
  let alreadySent = 0;
  let excluded: Record<RecipientExcludeReason, number> = { WITHDRAWN: 0, BLOCKED: 0, OPTED_OUT: 0 };
  let rows: Array<{ payerId: string; ctx: MergeContext }> = [];
  let blocked: string | null = null;
  if (a.kind === 'IMPACT_REPORT_SEND') {
    const u = await prisma.impactUpdate.findFirst({ where: { id: String(payload.updateId ?? a.subjectId), merchantId } });
    if (!u) return null;
    if (u.archivedAt || (u.status !== 'APPROVED' && u.status !== 'SENT')) blocked = '진행 기록이 수정·보관되어 지금 승인해도 보내지 않습니다.';
    const r = await impactRecipients(u);
    const got = await prisma.issuedDocument.findMany({ where: { merchantId, purpose: 'IMPACT_REPORT', subjectType: 'impact_update', subjectId: u.id }, select: { payerId: true } });
    const gotSet = new Set(got.map((g) => g.payerId));
    const pending = r.recipients.filter((x) => !gotSet.has(x.payerId));
    targetCount = pending.length;
    alreadySent = r.recipients.length - pending.length;
    excluded = r.excluded;
    const campaignTitle = u.campaignId ? (await prisma.campaign.findUnique({ where: { id: u.campaignId }, select: { title: true } }))?.title ?? null : null;
    rows = pending.map((x) => ({ payerId: x.payerId, ctx: { reportTitle: u.title, reportBody: u.report, participation: participationText(x), campaignTitle } }));
  } else {
    const year = Number(payload.taxYear ?? a.subjectId);
    if (!Number.isInteger(year)) return null;
    const [t, income, usage] = await Promise.all([annualNoticeTargets(merchantId, year), incomeStatement(merchantId, year, 'public'), usageStatement(merchantId, year)]);
    const summary = usageSummaryText(income, usage);
    targetCount = t.pending.length;
    alreadySent = t.alreadySent;
    excluded = t.excluded;
    rows = t.pending.map((x) => ({ payerId: x.payerId, ctx: { taxYear: year, participation: annualParticipationText(year, x), usageSummary: summary } }));
  }
  if (!template) blocked = blocked ?? '보낼 서식이 없습니다.';
  else if (!template.active || !template.autoSend) blocked = blocked ?? '이 용도의 서식이 중지(또는 자동 발송 끔) 상태입니다.';
  let samples: InfoSendPreview['samples'] = [];
  if (template && rows.length) {
    const { previewSamples } = await import('./document-preflight');
    const s = await previewSamples(merchantId, template, await sampleCandidates(merchantId, rows));
    samples = s.map((x) => ({ kind: x.kind, label: x.label, html: x.html, level: x.preflight.level, issues: x.preflight.issues.map((i) => i.message) }));
  }
  return {
    approval: { id: a.id, kind: a.kind, kindLabel: APPROVAL_KIND_LABEL[a.kind as keyof typeof APPROVAL_KIND_LABEL] ?? a.kind, title: a.title, summary: a.summary, status: a.status, createdAt: a.createdAt, result: a.result },
    purposeLabel: purpose === 'IMPACT_REPORT' ? '후원금 사용 결과 보고' : '후원금 수입·사용 연간 통보',
    targetCount,
    alreadySent,
    requestedCount: typeof payload.targetCount === 'number' ? payload.targetCount : null,
    excluded: (Object.keys(excluded) as RecipientExcludeReason[]).filter((k) => excluded[k] > 0).map((k) => ({ reason: k, label: RECIPIENT_EXCLUDE_LABEL[k], count: excluded[k] })),
    samples,
    cost: { edocAmount: 0n, note: '서명이 없는 열람 문서라 전자문서 이용요금은 0원입니다. 안내 문자(알림톡 → 문자 대체)는 기관 문자 요금 기준이며, 통합 발송 대기열에서 같은 날 안내와 묶일 수 있습니다.' },
    blocked,
  };
}
