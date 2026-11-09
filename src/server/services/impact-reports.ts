import { prisma } from '@/server/db';
import type { Prisma } from '@/generated/prisma/client';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { kstDateKey } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { llmConfig } from '@/lib/env';
import { allowedNumberSet, numbersOutside, personalAllocationHit, solicitationHit } from '@/lib/solicitation';
import { PAID_STATUSES } from '@/components/studio/shared';
import { isOwnMediaUrl } from '@/server/uploads';
import { consumeRateLimit } from '@/server/rate-limit';
import { completeJson, getLlmAdapter, llmUsable, type LlmAdapter } from '@/server/adapters/llm';
import { recordAiUsage } from './ai-usage';
import { draftTextViolation } from './ai-drafts';

/**
 * 후원금 사용 결과(사업 진행 기록) 보고 — 2026-11-09 3차 H1.
 *
 *  - 진행 기록 `impact_update`(캠페인, 비우면 기관 일반 후원) + 집행 내역 `fund_expense`(법정 서류 사용 명세와 같은 표).
 *  - 후원자용 보고서는 **캠페인 전체 결과**다. 개인별 사용처("당신의 3만 원이 ○○에 쓰였습니다")를 만들지 않는다.
 *    본인 참여(후원 N회·합계 M원)는 발송할 때 머지 필드 `{{참여내역}}` 으로 따로 채운다.
 *  - AI 초안은 숫자를 만들지 않는다. 입력 = 기관이 적은 본문·집행 내역 표·캠페인 모금 합계(원천 계산 — 결제 건 + 계좌이체 확정분).
 *    초안 속 숫자가 입력 숫자 집합에 없으면 거절 → 1회 재요청(completeJson) → 그래도 실패면 규칙 문안. mock 이면 처음부터 규칙 문안.
 *  - 상태: DRAFT → (담당자 승인, 항상) APPROVED → (승인 대기함 확인 후 배치 발송) SENT. 고칠 때는 DRAFT 로 되돌린다(발송 대기 중이면 거절).
 *  - 발송 대상: 그 캠페인 결제(PAID)·약정(진행·일시정지)·계좌이체 확정분이 있는 후원자. 탈퇴·차단·월간 안내 수신 거부 제외.
 */

export class ImpactError extends Error {}

export const IMPACT_STATUS_LABEL: Record<string, { text: string; tone: 'neutral' | 'brand' | 'success' | 'warning' }> = {
  DRAFT: { text: '작성 중', tone: 'neutral' },
  APPROVED: { text: '승인됨(발송 전)', tone: 'brand' },
  SENT: { text: '발송 완료', tone: 'success' },
};

export const IMPACT_MAX_PHOTOS = 3;
export const IMPACT_MAX_EXPENSES = 60;
export const IMPACT_TITLE_MAX = 80;
export const IMPACT_BODY_MAX = 4000;
export const IMPACT_REPORT_MAX = 5000;

const DAY = 86_400_000;

function dateOnly(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** KST 날짜(양끝 포함) → UTC 구간 */
export function kstRange(fromKey: string, toKey: string) {
  return { gte: new Date(`${fromKey}T00:00:00+09:00`), lt: new Date(new Date(`${toKey}T00:00:00+09:00`).getTime() + DAY) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateKeyOf(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

// ---------------------------------------------------------------------------
// 진행 기록 저장
// ---------------------------------------------------------------------------

export interface ImpactUpdateInput {
  campaignId: string | null;
  title: string;
  body: string;
  photos: string[];
  /** 수혜자 실사진·실명을 쓰지 않았다는 확인(사진이 있으면 필수) */
  photoRuleAck: boolean;
  periodFrom?: string | null;
  periodTo?: string | null;
}

async function assertCampaign(merchantId: string, campaignId: string | null) {
  if (!campaignId) return null;
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, merchantId }, select: { id: true, title: true } });
  if (!c) throw new ImpactError('캠페인을 찾을 수 없습니다.');
  return c;
}

function checkText(label: string, text: string) {
  const bad = draftTextViolation(text);
  if (bad) throw new ImpactError(`${label}에 ${bad}. 수혜자 실명·연락처·계좌·링크는 쓰지 않습니다.`);
}

export async function saveImpactUpdate(merchantId: string, userId: string, input: ImpactUpdateInput, id?: string) {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || title.length > IMPACT_TITLE_MAX) throw new ImpactError(`제목은 1~${IMPACT_TITLE_MAX}자로 적어 주세요.`);
  if (!body || body.length > IMPACT_BODY_MAX) throw new ImpactError(`진행 내용은 1~${IMPACT_BODY_MAX}자로 적어 주세요.`);
  checkText('제목', title);
  checkText('진행 내용', body);
  const photos = [...new Set(input.photos.map((p) => p.trim()).filter(Boolean))];
  if (photos.length > IMPACT_MAX_PHOTOS) throw new ImpactError(`사진은 ${IMPACT_MAX_PHOTOS}장까지 올릴 수 있습니다.`);
  if (photos.some((p) => !isOwnMediaUrl(p))) throw new ImpactError('사진은 이 화면에서 직접 올린 파일만 쓸 수 있습니다.');
  if (photos.length && !input.photoRuleAck) throw new ImpactError('사진을 올리려면 수혜자 실사진·실명을 쓰지 않았다는 확인에 체크해 주세요.');
  await assertCampaign(merchantId, input.campaignId);

  let periodFrom: Date | null = null;
  let periodTo: Date | null = null;
  if (!input.campaignId) {
    const today = kstDateKey();
    const from = (input.periodFrom ?? '').trim() || kstDateKey(new Date(Date.now() - 365 * DAY));
    const to = (input.periodTo ?? '').trim() || today;
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new ImpactError('대상 기간을 바르게 적어 주세요(시작일 ≤ 종료일).');
    periodFrom = dateOnly(from);
    periodTo = dateOnly(to);
  }

  const data = {
    campaignId: input.campaignId,
    title,
    body,
    photos,
    photoRuleAckAt: photos.length ? new Date() : null,
    periodFrom,
    periodTo,
  };
  if (!id) {
    const row = await prisma.impactUpdate.create({ data: { id: newId(), merchantId, createdBy: userId, ...data }, select: { id: true } });
    return row.id;
  }
  const r = await prisma.impactUpdate.updateMany({ where: { id, merchantId, status: 'DRAFT', archivedAt: null }, data });
  if (r.count !== 1) throw new ImpactError('작성 중인 기록만 고칠 수 있습니다. 승인된 기록은 먼저 "다시 고치기" 를 눌러 주세요.');
  // 캠페인이 바뀌면 이 기록에 붙은 집행 내역의 지정 용도도 함께 옮긴다(같은 표 — 중복 입력 없음).
  await prisma.fundExpense.updateMany({ where: { impactUpdateId: id, merchantId }, data: { campaignId: input.campaignId } });
  return id;
}

export async function getImpactUpdate(merchantId: string, id: string) {
  return prisma.impactUpdate.findFirst({
    where: { id, merchantId },
    include: { expenses: { where: { archivedAt: null }, orderBy: [{ usedOn: 'asc' }, { createdAt: 'asc' }] } },
  });
}

export async function listImpactUpdates(merchantId: string, opts: { includeArchived?: boolean } = {}) {
  const rows = await prisma.impactUpdate.findMany({
    where: { merchantId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { expenses: { where: { archivedAt: null }, select: { amount: true } } },
  });
  const campaignIds = [...new Set(rows.map((r) => r.campaignId).filter((v): v is string => Boolean(v)))];
  const campaigns = campaignIds.length ? await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, title: true } }) : [];
  const title = new Map(campaigns.map((c) => [c.id, c.title]));
  return rows.map((r) => ({
    ...r,
    campaignTitle: r.campaignId ? (title.get(r.campaignId) ?? '(지운 캠페인)') : '기관 일반 후원',
    expenseTotal: r.expenses.reduce((a, e) => a + e.amount, 0n),
  }));
}

// ---------------------------------------------------------------------------
// 집행 내역(사용 명세) — 진행 기록 화면·법정 서류 화면 공용
// ---------------------------------------------------------------------------

export interface ExpenseInput {
  impactUpdateId?: string | null;
  campaignId?: string | null;
  usedOn: string;
  description: string;
  amount: bigint;
}

export async function addExpense(merchantId: string, userId: string, input: ExpenseInput) {
  const description = input.description.trim();
  if (!description || description.length > 120) throw new ImpactError('사용 내역은 1~120자로 적어 주세요.');
  checkText('사용 내역', description);
  if (!DATE_RE.test(input.usedOn)) throw new ImpactError('사용일을 바르게 적어 주세요.');
  if (input.usedOn > kstDateKey()) throw new ImpactError('사용일은 오늘 이후로 적을 수 없습니다.');
  if (input.amount <= 0n || input.amount > 100_000_000_000n) throw new ImpactError('금액을 바르게 적어 주세요.');
  let campaignId = input.campaignId ?? null;
  if (input.impactUpdateId) {
    const u = await prisma.impactUpdate.findFirst({ where: { id: input.impactUpdateId, merchantId, archivedAt: null }, select: { status: true, campaignId: true } });
    if (!u) throw new ImpactError('진행 기록을 찾을 수 없습니다.');
    if (u.status !== 'DRAFT') throw new ImpactError('승인된 기록의 집행 내역은 바꿀 수 없습니다. 먼저 "다시 고치기" 를 눌러 주세요.');
    const n = await prisma.fundExpense.count({ where: { impactUpdateId: input.impactUpdateId, archivedAt: null } });
    if (n >= IMPACT_MAX_EXPENSES) throw new ImpactError(`집행 내역은 기록당 ${IMPACT_MAX_EXPENSES}줄까지입니다.`);
    campaignId = u.campaignId;
  }
  await assertCampaign(merchantId, campaignId);
  const row = await prisma.fundExpense.create({
    data: { id: newId(), merchantId, campaignId, impactUpdateId: input.impactUpdateId ?? null, usedOn: dateOnly(input.usedOn), description, amount: input.amount, createdBy: userId },
    select: { id: true },
  });
  return row.id;
}

/** 보관(되살릴 수 있음). 승인된 진행 기록에 붙은 줄은 바꾸지 않는다(보고서 숫자 근거). */
export async function archiveExpense(merchantId: string, id: string) {
  const e = await prisma.fundExpense.findFirst({ where: { id, merchantId, archivedAt: null }, select: { impactUpdate: { select: { status: true } } } });
  if (!e) throw new ImpactError('사용 내역을 찾을 수 없습니다.');
  if (e.impactUpdate && e.impactUpdate.status !== 'DRAFT') throw new ImpactError('승인된 진행 기록의 집행 내역은 바꿀 수 없습니다.');
  await prisma.fundExpense.updateMany({ where: { id, merchantId, archivedAt: null }, data: { archivedAt: new Date() } });
}

export async function restoreExpense(merchantId: string, id: string) {
  const r = await prisma.fundExpense.updateMany({ where: { id, merchantId, archivedAt: { not: null } }, data: { archivedAt: null } });
  if (r.count !== 1) throw new ImpactError('보관된 사용 내역을 찾을 수 없습니다.');
}

// ---------------------------------------------------------------------------
// 숫자 근거(원천 계산)
// ---------------------------------------------------------------------------

type UpdateScope = { merchantId: string; campaignId: string | null; periodFrom: Date | null; periodTo: Date | null };

function scopeWhere(u: UpdateScope) {
  const range = !u.campaignId && u.periodFrom && u.periodTo ? kstRange(dateKeyOf(u.periodFrom)!, dateKeyOf(u.periodTo)!) : null;
  return {
    charge: { merchantId: u.merchantId, campaignId: u.campaignId, isTest: false, status: { in: PAID_STATUSES }, ...(range ? { paidAt: range } : {}) } satisfies Prisma.ChargeWhereInput,
    offline: { merchantId: u.merchantId, campaignId: u.campaignId, status: 'CONFIRMED' as const, ...(range ? { donatedAt: range } : {}) } satisfies Prisma.OfflineDonationWhereInput,
  };
}

export interface ImpactFacts {
  /** 기브싸인 결제(PAID, 환불 제외) 합계·건수 */
  chargeTotal: bigint;
  chargeCount: number;
  /** 계좌이체 확정분 합계·건수(기브싸인이 받은 돈이 아니어서 따로 센다) */
  offlineTotal: bigint;
  offlineCount: number;
  expenseTotal: bigint;
  expenseCount: number;
  expenses: Array<{ usedOn: string; description: string; amount: bigint }>;
}

export async function impactFacts(u: UpdateScope & { id: string }): Promise<ImpactFacts> {
  const w = scopeWhere(u);
  const [c, o, ex] = await Promise.all([
    prisma.charge.aggregate({ where: w.charge, _sum: { amount: true }, _count: { _all: true } }),
    prisma.offlineDonation.aggregate({ where: w.offline, _sum: { amount: true }, _count: { _all: true } }),
    prisma.fundExpense.findMany({ where: { impactUpdateId: u.id, archivedAt: null }, orderBy: [{ usedOn: 'asc' }, { createdAt: 'asc' }], select: { usedOn: true, description: true, amount: true } }),
  ]);
  return {
    chargeTotal: c._sum.amount ?? 0n,
    chargeCount: c._count._all,
    offlineTotal: o._sum.amount ?? 0n,
    offlineCount: o._count._all,
    expenseTotal: ex.reduce((a, e) => a + e.amount, 0n),
    expenseCount: ex.length,
    expenses: ex.map((e) => ({ usedOn: dateKeyOf(e.usedOn)!, description: e.description, amount: e.amount })),
  };
}

function factsJson(f: ImpactFacts) {
  return {
    chargeTotal: f.chargeTotal.toString(), chargeCount: f.chargeCount, offlineTotal: f.offlineTotal.toString(), offlineCount: f.offlineCount,
    expenseTotal: f.expenseTotal.toString(), expenseCount: f.expenseCount,
  };
}

/** 집행 내역 표(글) — 규칙 문안·AI 초안 모두 시스템이 붙인다(AI 가 표 숫자를 다시 쓰지 않게). */
export function expenseTableText(f: ImpactFacts): string {
  if (!f.expenses.length) return '';
  const lines = f.expenses.map((e) => `- ${e.usedOn} ${e.description}: ${formatWon(e.amount)}`);
  return ['[집행 내역]', ...lines, `집행 합계 ${formatWon(f.expenseTotal)} (${formatNumber(f.expenseCount)}건)`].join('\n');
}

function raisedLine(f: ImpactFacts, scopeLabel: string): string {
  const parts = [`기브싸인 후원 ${formatNumber(f.chargeCount)}건 ${formatWon(f.chargeTotal)}`];
  if (f.offlineCount > 0) parts.push(`계좌이체 ${formatNumber(f.offlineCount)}건 ${formatWon(f.offlineTotal)}`);
  return `${scopeLabel}에 모인 후원: ${parts.join(' · ')}${f.offlineCount > 0 ? ` (모두 ${formatWon(f.chargeTotal + f.offlineTotal)})` : ''}`;
}

/** 규칙 문안 — AI 를 쓰지 않거나 AI 초안이 검증에 실패했을 때. 기관이 적은 본문 + 원천 숫자만 쓴다. */
export function ruleReport(input: { title: string; body: string; scopeLabel: string; facts: ImpactFacts }): string {
  const out = [input.body.trim(), '', raisedLine(input.facts, input.scopeLabel)];
  const table = expenseTableText(input.facts);
  if (table) out.push('', table);
  out.push('', '위 내용은 캠페인 전체의 진행 결과입니다.');
  return out.join('\n');
}

/** AI 초안 검증: 링크·개인정보·실명 + 권유 문구 + 개인별 사용처 + 입력에 없는 숫자. 통과하면 null. */
export function impactDraftViolation(text: string, allowed: Set<string>): string | null {
  if (!text) return '빈 초안';
  if (text.length > 2000) return '2000자 이내';
  const base = draftTextViolation(text);
  if (base) return base;
  const sol = solicitationHit(text);
  if (sol) return `후원 권유 문구("${sol}")`;
  const per = personalAllocationHit(text);
  if (per) return `개인별 사용처 문구("${per}")`;
  const bad = numbersOutside(text, allowed);
  if (bad.length) return `입력 자료에 없는 숫자(${bad.slice(0, 3).join(', ')})`;
  return null;
}

async function scopeLabelOf(u: UpdateScope): Promise<string> {
  if (u.campaignId) {
    const c = await prisma.campaign.findUnique({ where: { id: u.campaignId }, select: { title: true } });
    return `「${c?.title ?? '캠페인'}」`;
  }
  return `기관 일반 후원(${dateKeyOf(u.periodFrom)} ~ ${dateKeyOf(u.periodTo)})`;
}

export type ImpactDraftSource = 'AI' | 'RULE';

/**
 * 후원자용 보고서 초안을 만들어 작성 중인 기록(report)에 넣는다. 보내지 않는다(담당자 승인 → 승인 대기함 확인 후 발송).
 * @param adapter 테스트용(기본 LLM_PROVIDER)
 */
export async function generateImpactReport(merchantId: string, id: string, opts: { adapter?: LlmAdapter } = {}): Promise<{ source: ImpactDraftSource; report: string; reason?: string }> {
  const u = await prisma.impactUpdate.findFirst({ where: { id, merchantId, archivedAt: null } });
  if (!u) throw new ImpactError('진행 기록을 찾을 수 없습니다.');
  if (u.status !== 'DRAFT') throw new ImpactError('작성 중인 기록에서만 초안을 만들 수 있습니다.');
  const facts = await impactFacts(u);
  const scopeLabel = await scopeLabelOf(u);
  const rule = ruleReport({ title: u.title, body: u.body, scopeLabel, facts });
  const adapter = opts.adapter ?? getLlmAdapter();
  let source: ImpactDraftSource = 'RULE';
  let report = rule;
  let reason: string | undefined;

  if (adapter.info().mode !== 'mock' && llmUsable(adapter)) {
    const rl = await consumeRateLimit('ai-draft', merchantId, llmConfig().draftPerMinute, 60, { failClosed: true });
    if (!rl.ok) throw new ImpactError('AI 초안 요청이 너무 잦습니다. 1분 뒤에 다시 시도해 주세요.');
    const allowed = allowedNumberSet([
      u.title, u.body, scopeLabel,
      facts.chargeTotal, facts.chargeCount, facts.offlineTotal, facts.offlineCount, facts.expenseTotal, facts.expenseCount,
      facts.chargeTotal + facts.offlineTotal, facts.chargeCount + facts.offlineCount,
      ...facts.expenses.flatMap((e) => [e.usedOn, e.description, e.amount]),
    ]);
    const user = [
      `[사업] ${scopeLabel} — ${u.title}`,
      `[기관이 적은 진행 내용]\n${u.body}`,
      `[모금 합계(원천)] 기브싸인 후원 ${facts.chargeCount}건 ${facts.chargeTotal.toString()}원, 계좌이체 ${facts.offlineCount}건 ${facts.offlineTotal.toString()}원, 모두 ${facts.chargeCount + facts.offlineCount}건 ${(facts.chargeTotal + facts.offlineTotal).toString()}원`,
      facts.expenses.length ? `[집행 내역(기관 입력)]\n${facts.expenses.map((e) => `- ${e.usedOn} ${e.description} ${e.amount.toString()}원`).join('\n')}\n합계 ${facts.expenseTotal.toString()}원` : '[집행 내역] 없음',
      '',
      '후원자께 보낼 "사업 결과 보고" 본문을 3~6문단으로 써라. 캠페인 전체 결과만 쓴다.',
      '규칙: 위 자료에 나온 숫자만 그대로 쓴다(새 숫자·추정·환산 금지). 개인별 사용처("보내 주신 ○원이 ○○에 쓰였습니다") 금지.',
      '후원 권유("더 후원해 주세요"·정기후원 권유·참여 요청)·링크·전화번호 금지. 수혜자 실명·나이·사연 특정 금지. 집행 내역 표는 시스템이 따로 붙이므로 요약만.',
      '출력 JSON: {"report": "본문"}',
    ].join('\n');
    try {
      const { value } = await completeJson(
        adapter,
        { system: '당신은 사회복지기관의 후원금 사용 결과 보고 문안 도우미다. 결과는 담당자가 확인한 뒤에만 쓰인다. 존댓말, 이모지 금지.', user, json: true, maxTokens: 1500 },
        (d) => {
          const text = typeof d.report === 'string' ? d.report.trim() : '';
          const bad = impactDraftViolation(text, allowed);
          return bad ? { ok: false, reason: bad } : { ok: true, value: text };
        },
        (a) => recordAiUsage({ merchantId, feature: 'impact_report', provider: adapter.info().provider, model: adapter.info().model, usage: a.usage, ok: a.ok }).then(() => undefined),
      );
      const table = expenseTableText(facts);
      report = [value, '', raisedLine(facts, scopeLabel), ...(table ? ['', table] : [])].join('\n');
      source = 'AI';
    } catch (e) {
      reason = (e as Error).message.slice(0, 200);
      logger.warn('사업 결과 보고 AI 초안 실패 — 규칙 문안 사용', { merchantId, id, message: reason });
    }
  }

  const r = await prisma.impactUpdate.updateMany({
    where: { id, merchantId, status: 'DRAFT' },
    data: { report: report.slice(0, IMPACT_REPORT_MAX), reportSource: source, reportFacts: factsJson(facts) },
  });
  if (r.count !== 1) throw new ImpactError('작성 중인 기록에서만 초안을 만들 수 있습니다.');
  return { source, report, reason };
}

/** 담당자가 고친 보고서 저장. 권유 문구·개인별 사용처는 거절한다(정보성 안내). */
export async function saveImpactReportText(merchantId: string, id: string, text: string) {
  const report = text.trim();
  if (!report || report.length > IMPACT_REPORT_MAX) throw new ImpactError(`보고서는 1~${IMPACT_REPORT_MAX}자로 적어 주세요.`);
  checkText('보고서', report);
  const sol = solicitationHit(report);
  if (sol) throw new ImpactError(`정보성 안내라 후원 권유 문구·링크를 넣을 수 없습니다: 「${sol}」`);
  const per = personalAllocationHit(report);
  if (per) throw new ImpactError(`개인별 사용처로 읽히는 문장은 쓸 수 없습니다(캠페인 전체 결과로 써 주세요): 「${per}」`);
  const u = await prisma.impactUpdate.findFirst({ where: { id, merchantId, archivedAt: null }, select: { report: true, reportSource: true } });
  if (!u) throw new ImpactError('진행 기록을 찾을 수 없습니다.');
  const changed = (u.report ?? '').trim() !== report;
  const r = await prisma.impactUpdate.updateMany({
    where: { id, merchantId, status: 'DRAFT' },
    data: { report, reportSource: changed ? 'EDITED' : (u.reportSource ?? 'EDITED') },
  });
  if (r.count !== 1) throw new ImpactError('작성 중인 기록만 고칠 수 있습니다.');
}

// ---------------------------------------------------------------------------
// 승인 · 되돌리기 · 공개 · 보관
// ---------------------------------------------------------------------------

export async function approveImpactUpdate(merchantId: string, id: string, userId: string) {
  const u = await prisma.impactUpdate.findFirst({ where: { id, merchantId, archivedAt: null } });
  if (!u) throw new ImpactError('진행 기록을 찾을 수 없습니다.');
  if (u.status !== 'DRAFT') throw new ImpactError('이미 승인된 기록입니다.');
  if (!u.report?.trim()) throw new ImpactError('후원자용 보고서를 먼저 만들어 주세요("보고서 초안 만들기").');
  if (u.photos.length && !u.photoRuleAckAt) throw new ImpactError('사진의 수혜자 실사진·실명 금지 확인이 필요합니다.');
  const r = await prisma.impactUpdate.updateMany({ where: { id, merchantId, status: 'DRAFT', archivedAt: null }, data: { status: 'APPROVED', approvedBy: userId, approvedAt: new Date() } });
  if (r.count !== 1) throw new ImpactError('방금 다른 요청으로 처리되었습니다. 새로 고쳐 주세요.');
}

async function openSendRequests(merchantId: string, id: string) {
  return prisma.approvalRequest.count({ where: { merchantId, kind: 'IMPACT_REPORT_SEND', subjectId: id, status: { in: ['PENDING', 'PROCESSING', 'QUEUED'] } } });
}

export async function reopenImpactUpdate(merchantId: string, id: string) {
  if (await openSendRequests(merchantId, id)) throw new ImpactError('발송 승인 대기·발송 중인 기록은 고칠 수 없습니다. 승인 대기함에서 반려한 뒤 고쳐 주세요.');
  const r = await prisma.impactUpdate.updateMany({ where: { id, merchantId, status: 'APPROVED', archivedAt: null }, data: { status: 'DRAFT', approvedBy: null, approvedAt: null } });
  if (r.count !== 1) throw new ImpactError('승인됐지만 아직 보내지 않은 기록만 다시 고칠 수 있습니다.');
}

export async function setImpactPublic(merchantId: string, id: string, visible: boolean) {
  const r = await prisma.impactUpdate.updateMany({ where: { id, merchantId, archivedAt: null }, data: { publicVisible: visible } });
  if (r.count !== 1) throw new ImpactError('진행 기록을 찾을 수 없습니다.');
}

export async function archiveImpactUpdate(merchantId: string, id: string) {
  if (await openSendRequests(merchantId, id)) throw new ImpactError('발송 승인 대기·발송 중인 기록은 보관할 수 없습니다.');
  const r = await prisma.impactUpdate.updateMany({ where: { id, merchantId, archivedAt: null }, data: { archivedAt: new Date(), publicVisible: false } });
  if (r.count !== 1) throw new ImpactError('진행 기록을 찾을 수 없습니다.');
}

export async function restoreImpactUpdate(merchantId: string, id: string) {
  const r = await prisma.impactUpdate.updateMany({ where: { id, merchantId, archivedAt: { not: null } }, data: { archivedAt: null } });
  if (r.count !== 1) throw new ImpactError('보관된 진행 기록을 찾을 수 없습니다.');
}

// ---------------------------------------------------------------------------
// 발송 대상(참여 후원자) · 본인 참여 합계
// ---------------------------------------------------------------------------

export interface ImpactRecipient {
  payerId: string;
  count: number;
  amount: bigint;
  /** 약정만 있고 이 범위 결제·계좌이체가 없음 */
  pledgeOnly: boolean;
}

export type RecipientExcludeReason = 'WITHDRAWN' | 'BLOCKED' | 'OPTED_OUT';
export const RECIPIENT_EXCLUDE_LABEL: Record<RecipientExcludeReason, string> = {
  WITHDRAWN: '탈퇴한 후원자',
  BLOCKED: '차단 관계(기관·후원자)',
  OPTED_OUT: '기관 안내 수신 거부',
};

/** 같은 규칙의 수신 제외(탈퇴·차단·월간 안내 수신 거부) — 연 1회 통보도 같이 쓴다. */
export async function filterRecipients<T extends { payerId: string }>(merchantId: string, list: T[]) {
  const ids = list.map((r) => r.payerId);
  const excluded: Record<RecipientExcludeReason, number> = { WITHDRAWN: 0, BLOCKED: 0, OPTED_OUT: 0 };
  if (!ids.length) return { recipients: [] as T[], excluded };
  const [payers, links, blocked] = await Promise.all([
    prisma.payerProfile.findMany({ where: { id: { in: ids } }, select: { id: true, onboardingStatus: true, blockedAt: true } }),
    prisma.payerMerchantLink.findMany({ where: { merchantId, payerId: { in: ids } }, select: { payerId: true, noticeOptOutAt: true, payerBlockedAt: true } }),
    prisma.blockedPayer.findMany({ where: { merchantId, payerId: { in: ids } }, select: { payerId: true } }),
  ]);
  const pm = new Map(payers.map((p) => [p.id, p]));
  const lm = new Map(links.map((l) => [l.payerId, l]));
  const bs = new Set(blocked.map((b) => b.payerId));
  const recipients: T[] = [];
  for (const r of list) {
    const p = pm.get(r.payerId);
    const l = lm.get(r.payerId);
    if (!p || p.onboardingStatus === 'WITHDRAWN') excluded.WITHDRAWN += 1;
    else if (p.blockedAt || bs.has(r.payerId) || l?.payerBlockedAt) excluded.BLOCKED += 1;
    else if (l?.noticeOptOutAt) excluded.OPTED_OUT += 1;
    else recipients.push(r);
  }
  return { recipients, excluded };
}

/** 참여 후원자(제외 전). payerId 순으로 정렬 — 배치가 이어서 보낼 때 순서가 같다. */
export async function impactParticipants(u: UpdateScope): Promise<ImpactRecipient[]> {
  const w = scopeWhere(u);
  const [charges, offline, pledges] = await Promise.all([
    prisma.charge.groupBy({ by: ['payerId'], where: { ...w.charge, payerId: { not: null } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.offlineDonation.groupBy({ by: ['payerId'], where: w.offline, _sum: { amount: true }, _count: { _all: true } }),
    u.campaignId
      ? prisma.recurringDonation.findMany({ where: { merchantId: u.merchantId, campaignId: u.campaignId, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { payerId: true } })
      : Promise.resolve([] as Array<{ payerId: string }>),
  ]);
  const map = new Map<string, ImpactRecipient>();
  const add = (payerId: string, count: number, amount: bigint) => {
    const cur = map.get(payerId) ?? { payerId, count: 0, amount: 0n, pledgeOnly: false };
    cur.count += count;
    cur.amount += amount;
    map.set(payerId, cur);
  };
  for (const c of charges) if (c.payerId) add(c.payerId, c._count._all, c._sum.amount ?? 0n);
  for (const o of offline) add(o.payerId, o._count._all, o._sum.amount ?? 0n);
  for (const p of pledges) if (!map.has(p.payerId)) map.set(p.payerId, { payerId: p.payerId, count: 0, amount: 0n, pledgeOnly: true });
  return [...map.values()].sort((a, b) => (a.payerId < b.payerId ? -1 : a.payerId > b.payerId ? 1 : 0));
}

export async function impactRecipients(u: UpdateScope) {
  return filterRecipients(u.merchantId, await impactParticipants(u));
}

/** 본인 참여 문장(머지 필드 {{참여내역}}) — 개인별 사용처가 아니라 본인 후원 기록만. */
export function participationText(r: Pick<ImpactRecipient, 'count' | 'amount' | 'pledgeOnly'>): string {
  if (r.pledgeOnly || r.count === 0) return '정기후원 약정으로 함께하고 계십니다(아직 이 사업에 출금된 후원은 없습니다).';
  return `이 사업에 함께하신 후원 ${formatNumber(r.count)}회 · 합계 ${formatWon(r.amount)}`;
}

// ---------------------------------------------------------------------------
// 후원자 화면 · 공개 화면
// ---------------------------------------------------------------------------

export interface DonorImpactEntry {
  id: string;
  merchantName: string;
  merchantCode: string;
  campaignTitle: string;
  title: string;
  report: string;
  photos: string[];
  at: Date;
  status: string;
  participation: string;
}

/**
 * "내가 함께한 사업": 참여한 캠페인의 승인·발송된 진행 기록 + 내가 받은 일반 후원 결과 보고.
 * @param merchantId 주면 그 기관만(기관 후원 회원 화면)
 */
export async function donorImpactEntries(payerId: string, opts: { merchantId?: string; take?: number } = {}): Promise<DonorImpactEntry[]> {
  const mw = opts.merchantId ? { merchantId: opts.merchantId } : {};
  const [charges, offline, pledges, issued] = await Promise.all([
    prisma.charge.groupBy({ by: ['campaignId'], where: { ...mw, payerId, isTest: false, status: { in: PAID_STATUSES }, campaignId: { not: null } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.offlineDonation.groupBy({ by: ['campaignId'], where: { ...mw, payerId, status: 'CONFIRMED', campaignId: { not: null } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.recurringDonation.findMany({ where: { ...mw, payerId, campaignId: { not: null }, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { campaignId: true } }),
    prisma.issuedDocument.findMany({ where: { ...mw, payerId, purpose: 'IMPACT_REPORT', subjectType: 'impact_update', archivedAt: null }, select: { subjectId: true } }),
  ]);
  const own = new Map<string, { count: number; amount: bigint }>();
  for (const g of [...charges, ...offline]) {
    if (!g.campaignId) continue;
    const cur = own.get(g.campaignId) ?? { count: 0, amount: 0n };
    cur.count += g._count._all;
    cur.amount += g._sum.amount ?? 0n;
    own.set(g.campaignId, cur);
  }
  const campaignIds = [...new Set([...own.keys(), ...pledges.map((p) => p.campaignId!).filter(Boolean)])];
  const issuedIds = issued.map((i) => i.subjectId).filter((v): v is string => Boolean(v));
  if (!campaignIds.length && !issuedIds.length) return [];
  const rows = await prisma.impactUpdate.findMany({
    where: { ...mw, archivedAt: null, status: { in: ['APPROVED', 'SENT'] }, OR: [{ campaignId: { in: campaignIds } }, { id: { in: issuedIds } }] },
    orderBy: [{ sentAt: 'desc' }, { approvedAt: 'desc' }],
    take: opts.take ?? 30,
  });
  if (!rows.length) return [];
  const [merchants, campaigns] = await Promise.all([
    prisma.merchantProfile.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.merchantId))] }, status: 'APPROVED' }, select: { id: true, displayName: true, code: true } }),
    prisma.campaign.findMany({ where: { id: { in: rows.map((r) => r.campaignId).filter((v): v is string => Boolean(v)) } }, select: { id: true, title: true } }),
  ]);
  const mm = new Map(merchants.map((m) => [m.id, m]));
  const cm = new Map(campaigns.map((c) => [c.id, c.title]));
  return rows
    .filter((r) => mm.has(r.merchantId))
    .map((r) => {
      const m = mm.get(r.merchantId)!;
      const o = r.campaignId ? own.get(r.campaignId) : null;
      return {
        id: r.id,
        merchantName: m.displayName,
        merchantCode: m.code,
        campaignTitle: r.campaignId ? (cm.get(r.campaignId) ?? '캠페인') : '기관 일반 후원',
        title: r.title,
        report: r.report ?? r.body,
        photos: r.photos,
        at: r.sentAt ?? r.approvedAt ?? r.createdAt,
        status: r.status,
        participation: r.campaignId ? participationText({ count: o?.count ?? 0, amount: o?.amount ?? 0n, pledgeOnly: !o }) : '이 기간 기관 일반 후원에 함께하셨습니다.',
      };
    });
}

/** 공개 후원페이지 캠페인 상세: 기관이 공개로 둔 승인·발송 기록만(개인 정보 없음). */
export async function publicImpactUpdates(merchantId: string, campaignId: string) {
  const rows = await prisma.impactUpdate.findMany({
    where: { merchantId, campaignId, publicVisible: true, archivedAt: null, status: { in: ['APPROVED', 'SENT'] } },
    orderBy: [{ approvedAt: 'desc' }],
    take: 10,
    select: { id: true, title: true, report: true, body: true, photos: true, approvedAt: true, sentAt: true },
  });
  return rows.map((r) => ({ id: r.id, title: r.title, text: r.report ?? r.body, photos: r.photos, at: r.sentAt ?? r.approvedAt }));
}
