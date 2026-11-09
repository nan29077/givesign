import { prisma } from '@/server/db';
import type { Prisma } from '@/generated/prisma/client';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { decrypt } from '@/lib/crypto';
import { env, featureContentEnabled } from '@/lib/env';
import { formatNumber } from '@/lib/money';
import {
  ACTIONABLE_SUGGESTION_TYPES,
  addDaysKey,
  dateColumn,
  dateKeyOf,
  kstDayStart,
  kstWeekStartKey,
  KST_MS,
  seasonalHints,
  WEEKDAY_KO,
  type WeeklySuggestion,
} from '@/lib/weekly-plan';
import { PAID_STATUSES } from '@/components/studio/shared';
import { completeJson, getLlmAdapter, llmUsable, LlmError } from '@/server/adapters/llm';
import { recordAiUsage } from './ai-usage';
import { draftTextViolation } from './ai-drafts';
import { requestApproval, registerApprovalHandler, ApprovalError, type ApprovalRow } from './approvals';
import { funnelReport } from './funnel-report';
import { goalProgress, type GoalProgress } from './goals';
import { notifyUser } from './notifications';
import { contentOutcomes, outcomeBreakdown, bestBucket, CONTENT_WIN_MIN_PUBLISHED } from './content-performance';
import { ContentError, getContentSetting, monthlyUsage, requestContent } from './content';
import { calendarSlots, effectiveDays, runningCampaigns, DEFAULT_CALENDAR_KINDS } from './content-calendar';
import { campaignStats } from './fundraising';
import * as tpl from './mt-templates';
import type { InboxExceptionGroup } from './inbox-groups';

/**
 * 주간 운영 계획·월요일 보고 (2026-11-11 G1).
 *
 *  - 매주 월요일 07:00(KST) 이후 첫 배치가 (기관, 주) 1건을 만든다 — `weekly_plan (merchant_id, week_start)` 유니크(겹친 배치도 1건).
 *  - 숫자는 모두 원천(결제 건·약정·출금 실행·단계 측정·게시 행·서명 요청·승인 요청)에서 계산한다. AI 는 숫자를 만들지 않는다 —
 *    LLM 이 실연동이면 규칙 문장을 다듬기만 하고, 응답에 입력에 없던 숫자가 있으면 버리고 규칙 문장을 쓴다(mock 은 규칙 문장 그대로).
 *  - 제안 중 실행이 필요한 것(콘텐츠 슬롯 추가·주제 제안)은 모두 승인 요청(approval_request)이다. 승인하면 캘린더 설정에 반영되거나
 *    콘텐츠가 **검토 대기**로 만들어질 뿐, 게시·발송은 생기지 않는다(콘텐츠는 다시 개별 승인). 안내 발송 제안은 기존 저니·승인 대기함 화면 링크만 준다.
 *  - 월요일 09:00(KST) 이후(21시 전) 기관 대표 담당자에게 정보성 안내 1통(WEEKLY_REPORT — 알림톡 승인 전이면 문자 대체 규칙 그대로).
 *    `report_claimed_at` 조건부 선점으로 1회만. 기관이 보고 수신을 끄면 보내지 않는다(계획은 만든다).
 *  - 저장 값에 후원자 이름·연락처가 없다(수치·라벨·캠페인 이름만).
 */

const DAY = 86_400_000;
export const WEEKLY_PLAN_HOUR = 7;
export const WEEKLY_REPORT_HOUR = 9;
export const WEEKLY_REPORT_END_HOUR = 21;
/** 배치 1회 시간 상한 */
const RUN_BUDGET_MS = 50_000;

export type WeeklyApprovalKind = 'WEEKLY_PLAN_SLOT' | 'WEEKLY_PLAN_TOPIC';

// ---------------------------------------------------------------------------
// 지난주 평가(원천 계산)
// ---------------------------------------------------------------------------

export interface WeeklyMetrics {
  from: string;
  to: string;
  donations: { count: number; amount: string; oneOffCount: number; oneOffAmount: string; recurringCount: number; recurringAmount: string };
  previous: { count: number; amount: string };
  newDonors: number;
  recurring: { newPledges: number; canceled: number; suspended: number; recovered: number; actionRequired: number };
  funnel: { started: number; paid: number; rate: number | null };
  content: { published: number; clicks: number; donations: number; amount: string };
  documents: { sent: number; completed: number; rate: number | null };
  pendingApprovals: number;
}

function pct(n: number, d: number) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

/** 지난주 [weekStart-7, weekStart) 지표. pendingApprovals 는 계산 시점 값. */
export async function weeklyMetrics(merchantId: string, weekStartKey: string, now = new Date()): Promise<WeeklyMetrics> {
  const to = kstDayStart(weekStartKey);
  const from = new Date(to.getTime() - 7 * DAY);
  const prevFrom = new Date(from.getTime() - 7 * DAY);
  const paid = { merchantId, status: { in: PAID_STATUSES }, isTest: false };
  const [byKind, prev, firstPaid, newPledges, canceled, suspended, recovered, actionRequired, funnel, publishes, contentCharges, envSent, envDone, approvals, reviews] = await Promise.all([
    prisma.charge.groupBy({ by: ['paymentMode'], where: { ...paid, paidAt: { gte: from, lt: to } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.charge.aggregate({ where: { ...paid, paidAt: { gte: prevFrom, lt: from } }, _sum: { amount: true }, _count: { _all: true } }),
    // 신규 후원자 = 이 기관 첫 결제 성공이 지난주인 후원자
    prisma.charge.groupBy({ by: ['payerId'], where: { ...paid, payerId: { not: null } }, _min: { paidAt: true }, having: { paidAt: { _min: { gte: from, lt: to } } } }),
    prisma.recurringDonation.count({ where: { merchantId, createdAt: { gte: from, lt: to } } }),
    prisma.recurringDonation.count({ where: { merchantId, canceledAt: { gte: from, lt: to } } }),
    prisma.recurringDonation.count({ where: { merchantId, suspendedAt: { gte: from, lt: to } } }),
    prisma.recurringRun.count({ where: { recovered: true, ranAt: { gte: from, lt: to }, recurring: { merchantId } } }),
    prisma.recurringDonation.count({ where: { merchantId, status: 'ACTIVE', recoveryState: 'ACTION_REQUIRED' } }),
    funnelReport({ merchantId, channel: 'MO', since: from, until: to }).catch(() => null),
    prisma.contentPublish.findMany({ where: { item: { merchantId }, status: { in: ['PUBLISHED', 'PRIVATE_UPLOADED'] }, publishedAt: { gte: from, lt: to } }, select: { clicks: true } }),
    prisma.charge.aggregate({ where: { ...paid, recurringId: null, contentItemId: { not: null }, paidAt: { gte: from, lt: to } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.eDocEnvelope.count({ where: { merchantId, sentAt: { gte: from, lt: to } } }),
    prisma.eDocEnvelope.count({ where: { merchantId, sentAt: { gte: from, lt: to }, status: 'COMPLETED' } }),
    prisma.approvalRequest.count({ where: { merchantId, status: 'PENDING', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
    featureContentEnabled() ? prisma.contentItem.count({ where: { merchantId, status: 'REVIEW' } }) : Promise.resolve(0),
  ]);
  const rec = byKind.filter((r) => r.paymentMode === 'RECURRING');
  const one = byKind.filter((r) => r.paymentMode !== 'RECURRING');
  const sum = (list: typeof byKind) => list.reduce((a, r) => a + (r._sum.amount ?? 0n), 0n);
  const cnt = (list: typeof byKind) => list.reduce((a, r) => a + r._count._all, 0);
  const paidSteps = funnel?.steps.find((s) => s.step === 'PAID')?.count ?? 0;
  return {
    from: dateKeyOf(new Date(from.getTime() + KST_MS)),
    to: addDaysKey(weekStartKey, -1),
    donations: {
      count: cnt(byKind), amount: sum(byKind).toString(),
      oneOffCount: cnt(one), oneOffAmount: sum(one).toString(),
      recurringCount: cnt(rec), recurringAmount: sum(rec).toString(),
    },
    previous: { count: prev._count._all, amount: (prev._sum.amount ?? 0n).toString() },
    newDonors: firstPaid.length,
    recurring: { newPledges, canceled, suspended, recovered, actionRequired },
    funnel: { started: funnel?.total ?? 0, paid: paidSteps, rate: funnel ? pct(paidSteps, funnel.total) : null },
    content: { published: publishes.length, clicks: publishes.reduce((a, p) => a + p.clicks, 0), donations: contentCharges._count._all, amount: (contentCharges._sum.amount ?? 0n).toString() },
    documents: { sent: envSent, completed: envDone, rate: pct(envDone, envSent) },
    pendingApprovals: approvals + reviews,
  };
}

const won = (v: string | bigint) => `${formatNumber(BigInt(v))}원`;

/** 평가 문장(규칙). 숫자는 지표 그대로. */
export function evaluationLines(m: WeeklyMetrics): string[] {
  const diff = m.donations.count - m.previous.count;
  const lines = [
    `지난주 후원 ${formatNumber(m.donations.count)}건 · ${won(m.donations.amount)}${diff === 0 ? ' (전주와 같음)' : ` (전주보다 ${formatNumber(Math.abs(diff))}건 ${diff > 0 ? '많음' : '적음'})`}`,
    `일시 후원 ${formatNumber(m.donations.oneOffCount)}건 · 정기 출금 ${formatNumber(m.donations.recurringCount)}건`,
    `신규 후원자 ${formatNumber(m.newDonors)}명`,
    `정기후원 신규 ${m.recurring.newPledges} · 해지 ${m.recurring.canceled} · 정지 ${m.recurring.suspended} · 복구 ${m.recurring.recovered}`,
  ];
  if (m.funnel.started > 0) lines.push(`문자 후원 완료율 ${m.funnel.rate}% (시작 ${formatNumber(m.funnel.started)}건 중 ${formatNumber(m.funnel.paid)}건 완료)`);
  if (m.content.published > 0 || m.content.donations > 0) lines.push(`콘텐츠 게시 ${m.content.published}건 · 클릭 ${formatNumber(m.content.clicks)}회 · 콘텐츠로 들어온 후원 ${m.content.donations}건`);
  if (m.documents.sent > 0) lines.push(`전자문서 완료율 ${m.documents.rate}% (${m.documents.sent}건 중 ${m.documents.completed}건)`);
  lines.push(`지금 승인 대기 ${formatNumber(m.pendingApprovals)}건`);
  return lines;
}

// ---------------------------------------------------------------------------
// 이번 주 제안(규칙)
// ---------------------------------------------------------------------------

export async function buildSuggestions(merchantId: string, weekStartKey: string, m: WeeklyMetrics, goals: GoalProgress[], now = new Date()): Promise<WeeklySuggestion[]> {
  const out: WeeklySuggestion[] = [];
  for (const g of [...goals].sort((a, b) => (a.outlook === 'AT_RISK' ? -1 : 0) - (b.outlook === 'AT_RISK' ? -1 : 0))) {
    if (g.outlook === 'DONE') continue;
    out.push({ key: `goal:${g.id}`, type: 'INFO', title: g.sentence, detail: g.outlook === 'AT_RISK' ? '지금 속도로는 기한 안 달성이 어렵습니다. 캠페인 소식·감사 콘텐츠를 늘리거나 목표·기한을 다시 보세요.' : '현재 속도를 유지하면 됩니다.', href: '/studio/goals' });
  }

  if (featureContentEnabled()) {
    const setting = await getContentSetting(merchantId);
    const weekStart = kstDayStart(weekStartKey);
    if (setting.calendarEnabled) {
      const slots = calendarSlots(setting, new Date(weekStart.getTime() - 1), 7).filter((s) => s.getTime() < weekStart.getTime() + 7 * DAY);
      if (slots.length) {
        const rows = await prisma.contentSlot.findMany({ where: { merchantId, slotAt: { in: slots } }, select: { itemId: true } });
        const ids = rows.map((r) => r.itemId).filter((x): x is string => Boolean(x));
        const review = ids.length ? await prisma.contentItem.count({ where: { id: { in: ids }, status: 'REVIEW' } }) : 0;
        out.push({ key: 'content:slots', type: 'INFO', title: `이번 주 콘텐츠 슬롯 ${slots.length}개 중 승인 대기 ${review}개`, detail: review ? '주간 승인 화면에서 한 번에 확인할 수 있습니다. 승인하지 않은 콘텐츠는 게시되지 않습니다.' : '승인 대기 중인 슬롯 콘텐츠가 없습니다.', href: '/studio/content/review' });
      }
      // 클릭이 가장 높았던 요일이 캘린더에 없으면 슬롯 추가 제안(승인 → 캘린더 설정에만 반영)
      const outcomes = await contentOutcomes(merchantId, { now }).catch(() => null);
      if (outcomes && outcomes.items.length >= CONTENT_WIN_MIN_PUBLISHED) {
        const top = bestBucket(outcomeBreakdown(outcomes.items).byWeekday);
        const day = top ? Number(top.key) : NaN;
        if (top && Number.isInteger(day) && !effectiveDays(setting).includes(day)) {
          out.push({
            key: `content:slot-add:${day}`,
            type: 'CONTENT_SLOT_ADD',
            title: `${WEEKDAY_KO[day]}요일 게시 클릭이 가장 높았음 → 이번 주 ${WEEKDAY_KO[day]}요일 슬롯 추가 제안`,
            detail: `최근 90일 ${WEEKDAY_KO[day]}요일 게시물 평균 클릭 ${top.avgClicks}회. 승인하면 콘텐츠 캘린더 요일에 추가합니다(만든 콘텐츠는 다시 승인해야 게시).`,
            href: '/studio/content',
            params: { day },
          });
        }
      }
    }
    // 최근 2주 콘텐츠가 없는 진행 중 캠페인 → 주제 제안(승인 → 콘텐츠를 만들어 검토 대기로)
    const [merchant, usage] = await Promise.all([
      prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { fundraisingRegNo: true } }),
      monthlyUsage(merchantId, now),
    ]);
    if (merchant?.fundraisingRegNo && usage.count < setting.monthlyLimit) {
      const running = await runningCampaigns(merchantId, now);
      if (running.length) {
        const recent = await prisma.contentItem.groupBy({ by: ['campaignId'], where: { merchantId, campaignId: { in: running.map((c) => c.id) }, createdAt: { gte: new Date(now.getTime() - 14 * DAY) } } });
        const used = new Set(recent.map((r) => r.campaignId));
        const stats = await campaignStats(running.map((c) => c.id));
        const pick = running
          .filter((c) => !used.has(c.id))
          .map((c) => ({ c, ratio: c.goalAmount > 0n ? Number(((stats.get(c.id)?.raised ?? 0n) * 1000n) / c.goalAmount) / 1000 : 1 }))
          .sort((a, b) => a.ratio - b.ratio || a.c.endsOn.getTime() - b.c.endsOn.getTime())[0];
        if (pick) {
          out.push({
            key: `content:topic:${pick.c.id}`,
            type: 'CONTENT_TOPIC',
            title: `'${pick.c.title.slice(0, 30)}' 소식 콘텐츠 제안 — 최근 2주 콘텐츠 없음`,
            detail: `모금 진행률 ${Math.round(pick.ratio * 1000) / 10}%. 승인하면 콘텐츠를 만들어 검토 대기로 올립니다(자동 게시 없음 — 다시 승인해야 게시).`,
            href: '/studio/content',
            params: { campaignId: pick.c.id },
          });
        }
      }
    }
  }

  if (m.recurring.actionRequired > 0) {
    out.push({ key: 'recurring:action', type: 'INFO', title: `정기 출금 조치 필요 ${m.recurring.actionRequired}명`, detail: '결제수단 재등록 링크는 이미 자동으로 보냈습니다. 기한이 다가오는 후원자는 직접 연락해 주세요.', href: '/studio/recurring?recovery=ACTION_REQUIRED' });
  }
  if (m.pendingApprovals > 0) {
    out.push({ key: 'inbox:pending', type: 'INFO', title: `승인 대기 ${m.pendingApprovals}건`, detail: '승인 대기함에서 한 번에 처리할 수 있습니다.', href: '/studio/inbox' });
  }
  const holidays = await prisma.publicHoliday
    .findMany({ where: { name: { in: ['설날', '추석'] }, active: true, archivedAt: null, date: { gte: weekStartKey, lte: addDaysKey(weekStartKey, 30) } }, select: { date: true, name: true } })
    .catch(() => []);
  for (const h of seasonalHints(weekStartKey, { holidays, foundedOn: null })) {
    // 연말정산 안내는 기존 승인 대기함(연간 영수증 준비 묶음)·저니 경로로 — 계획은 링크만 준다
    out.push({ key: h.key, type: h.key.startsWith('season:tax-') ? 'NOTICE' : 'INFO', title: h.title, detail: h.detail, href: h.href ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM 문장 다듬기(선택)
// ---------------------------------------------------------------------------

function numberTokens(text: string): string[] {
  return [...text.matchAll(/\d[\d,.]*/g)].map((x) => x[0].replace(/,/g, '').replace(/\.$/, ''));
}

/** 응답 문장의 숫자가 모두 입력에 있던 숫자인가(AI 가 숫자를 만들지 않게) */
export function numbersPreserved(input: string[], output: string[]): boolean {
  const allowed = new Set(input.flatMap(numberTokens));
  return output.every((t) => numberTokens(t).every((n) => allowed.has(n)));
}

export interface PolishResult {
  by: 'RULES' | 'LLM';
  lines: string[] | null;
  suggestionTexts: Record<string, string> | null;
}

export async function polishWeeklyText(merchantId: string, lines: string[], suggestions: WeeklySuggestion[]): Promise<PolishResult> {
  const adapter = getLlmAdapter();
  if (!llmUsable(adapter)) return { by: 'RULES', lines: null, suggestionTexts: null };
  const info = adapter.info();
  const sugg = suggestions.map((s) => ({ key: s.key, text: s.title }));
  const inputTexts = [...lines, ...sugg.map((s) => s.text)];
  try {
    const { value } = await completeJson(
      adapter,
      {
        system: '사회복지기관 담당자에게 보내는 주간 운영 보고 문장을 쉬운 한국어로 다듬는다. 숫자는 입력에 있는 것만 그대로 쓰고 새 숫자를 만들지 않는다. 후원 권유·광고 문구, 링크, 개인정보를 쓰지 않는다.',
        user: [
          '[지난주 평가 — 문장 수를 그대로 유지]',
          ...lines.map((l, i) => `${i + 1}. ${l}`),
          '',
          '[이번 주 제안 — key 를 그대로 유지]',
          ...sugg.map((s) => `${s.key}: ${s.text}`),
          '',
          '출력 JSON: {"evaluation": ["문장"], "suggestions": [{"key": "키", "text": "문장"}]} — 각 문장 120자 이내',
        ].join('\n'),
        json: true,
        maxTokens: 1200,
      },
      (d) => {
        const ev = Array.isArray(d.evaluation) ? d.evaluation.map((x) => (typeof x === 'string' ? x.trim() : '')) : [];
        const sg = Array.isArray(d.suggestions) ? d.suggestions : [];
        if (ev.length !== lines.length || ev.some((x) => !x || x.length > 120)) return { ok: false, reason: `evaluation 은 ${lines.length}개, 각 1~120자` };
        const texts: Record<string, string> = {};
        for (const raw of sg) {
          const r = raw as { key?: unknown; text?: unknown };
          if (typeof r.key !== 'string' || typeof r.text !== 'string') continue;
          if (!sugg.some((s) => s.key === r.key)) continue;
          const t = r.text.trim();
          if (!t || t.length > 120) return { ok: false, reason: 'suggestions text 1~120자' };
          texts[r.key] = t;
        }
        const all = [...ev, ...Object.values(texts)];
        const bad = all.map((t) => draftTextViolation(t)).find(Boolean);
        if (bad) return { ok: false, reason: bad };
        if (!numbersPreserved(inputTexts, all)) return { ok: false, reason: '입력에 없는 숫자가 들어 있습니다' };
        return { ok: true, value: { ev, texts } };
      },
      (a) => recordAiUsage({ merchantId, feature: 'weekly_report', provider: info.provider, model: info.model, usage: a.usage, ok: a.ok }).then(() => undefined),
    );
    return { by: 'LLM', lines: value.ev, suggestionTexts: value.texts };
  } catch (e) {
    logger.warn('주간 보고 문장 다듬기 실패 — 규칙 문장을 씁니다', { merchantId, message: e instanceof LlmError ? e.message.slice(0, 120) : (e as Error).message });
    return { by: 'RULES', lines: null, suggestionTexts: null };
  }
}

// ---------------------------------------------------------------------------
// 계획 만들기
// ---------------------------------------------------------------------------

export interface StoredEvaluation {
  metrics: WeeklyMetrics;
  lines: string[];
  polished: string[] | null;
  goals: Array<{ id: string; title: string; label: string; percent: number; outlook: string | null; sentence: string }>;
}

export interface StoredSuggestion extends WeeklySuggestion {
  polished?: string | null;
}

function jsonValue(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val))) as Prisma.InputJsonValue;
}

export function weeklyApprovalKey(planId: string, key: string) {
  return `weekly-plan:${planId}:${key}`;
}

/**
 * (기관, 이번 주) 계획을 만든다. 이미 있으면 그대로 돌려준다(created=false).
 * 계산을 먼저 하고 유니크 insert 로 선점한다 — 겹친 실행은 승인 요청을 만들지 않는다(승인 요청도 dedupeKey 로 한 번).
 */
export async function generateWeeklyPlan(merchantId: string, now = new Date()) {
  const weekStartKey = kstWeekStartKey(now);
  const existing = await prisma.weeklyPlan.findUnique({ where: { merchantId_weekStart: { merchantId, weekStart: dateColumn(weekStartKey) } } });
  if (existing) return { created: false, plan: existing };
  const metrics = await weeklyMetrics(merchantId, weekStartKey, now);
  const goals = await goalProgress(merchantId, now);
  const lines = evaluationLines(metrics);
  const suggestions: StoredSuggestion[] = await buildSuggestions(merchantId, weekStartKey, metrics, goals, now);
  const polish = await polishWeeklyText(merchantId, lines, suggestions);
  for (const s of suggestions) s.polished = polish.suggestionTexts?.[s.key] ?? null;
  const evaluation: StoredEvaluation = {
    metrics,
    lines,
    polished: polish.lines,
    goals: goals.map((g) => ({ id: g.id, title: g.title, label: g.label, percent: g.percent, outlook: g.outlook, sentence: g.sentence })),
  };
  const id = newId();
  const ins = await prisma.weeklyPlan.createMany({
    data: [{ id, merchantId, weekStart: dateColumn(weekStartKey), evaluation: jsonValue(evaluation), suggestions: jsonValue(suggestions), generatedBy: polish.by }],
    skipDuplicates: true,
  });
  if (ins.count === 0) {
    return { created: false, plan: await prisma.weeklyPlan.findUniqueOrThrow({ where: { merchantId_weekStart: { merchantId, weekStart: dateColumn(weekStartKey) } } }) };
  }
  // 실행이 필요한 제안 → 승인 요청(그 주 끝까지). 승인 처리기는 캘린더 설정·검토 대기 콘텐츠만 만든다.
  const expiresAt = kstDayStart(addDaysKey(weekStartKey, 7));
  for (const s of suggestions) {
    if (!ACTIONABLE_SUGGESTION_TYPES.includes(s.type)) continue;
    const kind: WeeklyApprovalKind = s.type === 'CONTENT_SLOT_ADD' ? 'WEEKLY_PLAN_SLOT' : 'WEEKLY_PLAN_TOPIC';
    try {
      const r = await requestApproval({
        merchantId,
        kind,
        title: s.title,
        summary: s.detail,
        payload: { planId: id, key: s.key, type: s.type, params: s.params ?? {}, weekStart: weekStartKey },
        subjectType: 'weekly_plan',
        subjectId: id,
        dedupeKey: weeklyApprovalKey(id, s.key),
        expiresAt,
      });
      s.approvalId = r.request.id;
    } catch (e) {
      logger.error('주간 계획 승인 요청 생성 실패', { merchantId, key: s.key, message: (e as Error).message });
    }
  }
  await prisma.weeklyPlan.update({ where: { id }, data: { suggestions: jsonValue(suggestions) } }).catch(() => undefined);
  return { created: true, plan: await prisma.weeklyPlan.findUniqueOrThrow({ where: { id } }) };
}

// ---------------------------------------------------------------------------
// 승인 처리기 — 게시·발송을 만들지 않는다
// ---------------------------------------------------------------------------

/** 콘텐츠 캘린더 요일 추가. 이미 있으면 그대로 성공(다시 불러도 같은 결과). */
export async function applySlotAdd(merchantId: string, day: number): Promise<string> {
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new ApprovalError('요일 값이 올바르지 않습니다.');
  const setting = await getContentSetting(merchantId);
  const current = effectiveDays(setting);
  if (current.includes(day)) return `${WEEKDAY_KO[day]}요일은 이미 캘린더에 있습니다.`;
  const days = [...new Set([...current, day])].sort((a, b) => a - b);
  const weeklyCount = Math.min(7, Math.max(setting.weeklyCount, days.length));
  await prisma.merchantContentSetting.upsert({
    where: { merchantId },
    create: { merchantId, days, weeklyCount, bannedWords: [], hashtags: [], kinds: [], platforms: [] },
    update: { days, weeklyCount },
  });
  return `콘텐츠 캘린더에 ${WEEKDAY_KO[day]}요일을 추가했습니다(주 ${weeklyCount}건).${setting.calendarEnabled ? '' : ' 캘린더가 꺼져 있어 켜야 만들어집니다.'} 만든 콘텐츠는 승인해야 게시됩니다.`;
}

/** 주제 제안 실행 — 콘텐츠를 만들어 검토 대기로. 같은 승인으로는 한 번만(createdBy 표시로 확인). */
export async function runTopicSuggestion(req: ApprovalRow): Promise<string> {
  const campaignId = String((req.payload.params as Record<string, unknown> | undefined)?.campaignId ?? '');
  const marker = `WEEKLY_PLAN:${req.id}`;
  const done = await prisma.contentItem.findFirst({ where: { merchantId: req.merchantId, createdBy: marker }, select: { id: true, status: true } });
  if (done) return '이미 만든 콘텐츠가 있습니다. 콘텐츠 화면에서 확인 후 승인해 주세요.';
  const setting = await getContentSetting(req.merchantId);
  const kind = (setting.kinds.length ? setting.kinds : DEFAULT_CALENDAR_KINDS)[0]!;
  try {
    const item = await requestContent({ merchantId: req.merchantId, campaignId, kind, userId: marker });
    return item.status === 'REVIEW' ? '콘텐츠를 만들어 검토 대기로 올렸습니다. 승인해야 게시됩니다.' : `콘텐츠 생성 결과: ${item.status === 'FAILED' ? '실패' : item.status}`;
  } catch (e) {
    if (e instanceof ContentError) return `만들지 못했습니다: ${e.message}`;
    throw e;
  }
}

let handlersRegistered = false;
export function registerWeeklyPlanApprovalHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;
  registerApprovalHandler('WEEKLY_PLAN_SLOT', {
    async onApprove(req) {
      const day = Number((req.payload.params as Record<string, unknown> | undefined)?.day);
      return applySlotAdd(req.merchantId, day);
    },
  });
  registerApprovalHandler('WEEKLY_PLAN_TOPIC', {
    // 공급자 호출(콘텐츠 생성)은 배치가 실행한다 — 서버 액션 안에서 기다리지 않는다
    async onApprove() {
      return '승인했습니다.';
    },
    queuedMessage: () => '승인했습니다. 몇 분 안에 콘텐츠를 만들어 검토 대기로 올립니다(게시는 다시 승인해야 합니다).',
    async execute(req) {
      const message = await runTopicSuggestion(req);
      return { done: true, message, state: {} };
    },
  });
}

// ---------------------------------------------------------------------------
// 월요일 보고 발송
// ---------------------------------------------------------------------------

export async function weeklyReportEnabled(merchantId: string): Promise<boolean> {
  const row = await prisma.weeklyReportSetting.findUnique({ where: { merchantId } });
  return row?.enabled ?? true;
}

export async function setWeeklyReportEnabled(merchantId: string, enabled: boolean) {
  await prisma.weeklyReportSetting.upsert({ where: { merchantId }, create: { merchantId, enabled }, update: { enabled } });
}

/** 기관 대표 담당자 번호: 기관 소유 계정 휴대폰 → 없으면 기관 정보의 후원 담당자 연락처 */
async function reportRecipient(merchantId: string): Promise<{ phone: string | null; userId: string; name: string }> {
  const m = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { userId: true, displayName: true, contactPhone: true, user: { select: { phoneEnc: true } } } });
  let phone: string | null = null;
  if (m.user.phoneEnc) {
    try {
      phone = decrypt(m.user.phoneEnc);
    } catch {
      phone = null;
    }
  }
  if (!phone && m.contactPhone && /\d{9,}/.test(m.contactPhone.replace(/\D/g, ''))) phone = m.contactPhone.replace(/\D/g, '');
  return { phone, userId: m.userId, name: m.displayName };
}

export async function pendingApprovalCount(merchantId: string, now = new Date()) {
  const [a, c] = await Promise.all([
    prisma.approvalRequest.count({ where: { merchantId, status: 'PENDING', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
    featureContentEnabled() ? prisma.contentItem.count({ where: { merchantId, status: 'REVIEW' } }) : Promise.resolve(0),
  ]);
  return a + c;
}

/**
 * 보고 1통. report_claimed_at 이 비었을 때만 선점(동시 실행 1회). 꺼져 있으면 보내지 않고 기록만.
 * 콘솔 알림은 수신 설정과 관계없이 1회 남긴다(콘솔 안 알림 — 발송 아님).
 */
export async function sendWeeklyReport(planId: string, now = new Date()): Promise<'SENT' | 'SKIPPED' | 'DISABLED' | 'NO_PHONE' | 'FAILED'> {
  const claim = await prisma.weeklyPlan.updateMany({ where: { id: planId, reportClaimedAt: null }, data: { reportClaimedAt: now } });
  if (claim.count === 0) return 'SKIPPED';
  const plan = await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: planId } });
  const ev = plan.evaluation as unknown as StoredEvaluation;
  const donations = ev?.metrics?.donations?.count ?? 0;
  const approvals = await pendingApprovalCount(plan.merchantId, now);
  const recipient = await reportRecipient(plan.merchantId);
  const link = `${env.baseUrl}/studio/weekly/${plan.id}`;
  await notifyUser({ userId: recipient.userId, title: '이번 주 운영 보고가 준비되었습니다', body: `지난주 후원 ${formatNumber(donations)}건 · 이번 주 승인할 일 ${formatNumber(approvals)}건`, linkUrl: `/studio/weekly/${plan.id}` }).catch(() => undefined);
  if (!(await weeklyReportEnabled(plan.merchantId))) {
    await prisma.weeklyPlan.update({ where: { id: plan.id }, data: { reportChannel: 'NONE', reportNote: '보고 수신 꺼짐 — 콘솔 알림만' } });
    return 'DISABLED';
  }
  if (!recipient.phone) {
    await prisma.weeklyPlan.update({ where: { id: plan.id }, data: { reportChannel: 'NONE', reportNote: '받을 휴대폰 번호 없음(기관 정보의 담당자 연락처를 넣어 주세요) — 콘솔 알림만' } });
    return 'NO_PHONE';
  }
  const template = tpl.tplWeeklyReport({ merchantName: recipient.name, donationCount: donations, approvalCount: approvals, link });
  const { sendMtDetailed } = await import('./charge-flow');
  const r = await sendMtDetailed({ phone: recipient.phone, template, merchantId: plan.merchantId }).catch((e) => {
    logger.error('주간 보고 발송 실패', { planId, message: (e as Error).message });
    return null;
  });
  await prisma.weeklyPlan.update({
    where: { id: plan.id },
    data: r?.ok
      ? { status: plan.status === 'DRAFT' ? 'SENT' : plan.status, reportSentAt: now, reportChannel: r.channel, reportMtId: r.id, reportNote: r.fallback ? '알림톡 실패 — 문자로 대체' : null }
      : { reportChannel: r?.channel ?? 'SMS', reportMtId: r?.id ?? null, reportNote: '발송 실패(자동 재발송 없음)' },
  });
  return r?.ok ? 'SENT' : 'FAILED';
}

// ---------------------------------------------------------------------------
// 배치
// ---------------------------------------------------------------------------

export interface WeeklyJobResult {
  week: string;
  generated: number;
  existing: number;
  reports: number;
  reportSkipped: number;
  failed: number;
}

/** /api/cron/weekly-plan (1시간). 이번 주 월요일 07시 이후 계획, 09~21시 보고. */
export async function runWeeklyPlanJob(now = new Date(), opts: { budgetMs?: number } = {}): Promise<WeeklyJobResult> {
  const week = kstWeekStartKey(now);
  const monday = kstDayStart(week).getTime();
  const result: WeeklyJobResult = { week, generated: 0, existing: 0, reports: 0, reportSkipped: 0, failed: 0 };
  const deadline = Date.now() + (opts.budgetMs ?? RUN_BUDGET_MS);
  if (now.getTime() < monday + WEEKLY_PLAN_HOUR * 3600_000) return result;
  const merchants = await prisma.merchantProfile.findMany({
    where: { status: 'APPROVED', weeklyPlans: { none: { weekStart: dateColumn(week) } } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 500,
  });
  for (const m of merchants) {
    if (Date.now() > deadline) break;
    try {
      const r = await generateWeeklyPlan(m.id, now);
      if (r.created) result.generated += 1;
      else result.existing += 1;
    } catch (e) {
      result.failed += 1;
      logger.error('주간 계획 생성 실패', { merchantId: m.id, message: (e as Error).message });
    }
  }
  const kstHour = new Date(now.getTime() + KST_MS).getUTCHours();
  if (now.getTime() >= monday + WEEKLY_REPORT_HOUR * 3600_000 && kstHour >= WEEKLY_REPORT_HOUR && kstHour < WEEKLY_REPORT_END_HOUR) {
    const due = await prisma.weeklyPlan.findMany({ where: { weekStart: dateColumn(week), reportClaimedAt: null, merchant: { status: 'APPROVED' } }, select: { id: true }, take: 500 });
    for (const p of due) {
      if (Date.now() > deadline) break;
      const r = await sendWeeklyReport(p.id, now).catch((e) => {
        logger.error('주간 보고 처리 오류', { planId: p.id, message: (e as Error).message });
        return 'FAILED' as const;
      });
      if (r === 'SENT') result.reports += 1;
      else if (r === 'FAILED') result.failed += 1;
      else result.reportSkipped += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 화면 · 승인 대기함
// ---------------------------------------------------------------------------

export async function ackWeeklyPlan(merchantId: string, planId: string, userId: string) {
  const r = await prisma.weeklyPlan.updateMany({ where: { id: planId, merchantId, status: { in: ['DRAFT', 'SENT'] } }, data: { status: 'ACKED', ackedAt: new Date(), ackedBy: userId } });
  return r.count === 1;
}

/** 계획 제안별 승인 요청 상태(dedupeKey 로 원천을 읽는다) */
export async function planApprovalStates(planId: string, suggestions: StoredSuggestion[]) {
  const keys = suggestions.filter((s) => ACTIONABLE_SUGGESTION_TYPES.includes(s.type)).map((s) => weeklyApprovalKey(planId, s.key));
  if (keys.length === 0) return new Map<string, { id: string; status: string; result: string | null }>();
  const rows = await prisma.approvalRequest.findMany({ where: { dedupeKey: { in: keys } }, select: { id: true, dedupeKey: true, status: true, result: true } });
  return new Map(rows.map((r) => [r.dedupeKey.slice(`weekly-plan:${planId}:`.length), { id: r.id, status: r.status, result: r.result }]));
}

export async function weeklyPlanInboxGroup(merchantId: string, now = new Date()): Promise<InboxExceptionGroup | null> {
  const rows = await prisma.approvalRequest.findMany({
    where: { merchantId, status: 'PENDING', kind: { in: ['WEEKLY_PLAN_SLOT', 'WEEKLY_PLAN_TOPIC'] }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { createdAt: true, kind: true },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return null;
  const slot = rows.filter((r) => r.kind === 'WEEKLY_PLAN_SLOT').length;
  return {
    kind: 'WEEKLY_PLAN',
    title: `주간 운영 계획 제안 ${rows.length}건`,
    reason: [slot ? `콘텐츠 슬롯 추가 ${slot}건` : null, rows.length - slot ? `콘텐츠 주제 제안 ${rows.length - slot}건` : null].filter(Boolean).join(' · '),
    affectedCount: rows.length,
    oldestAt: rows[0]!.createdAt,
    href: '/studio/weekly',
    recommendedAction: '승인하면 캘린더 설정에 반영되거나 콘텐츠가 검토 대기로 만들어집니다. 게시·발송은 각 콘텐츠를 다시 승인해야 이루어집니다.',
    actions: [],
    severity: 'normal',
  };
}
