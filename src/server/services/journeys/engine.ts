import { prisma } from '@/server/db';
import type { Prisma } from '@/generated/prisma/client';
import { newId } from '@/lib/id';
import { generateToken } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { registerConsumer, type StoredDomainEvent } from '../events';
import { registerApprovalHandler, requestApproval, cancelApproval, ApprovalError, type ApprovalRow } from '../approvals';
import { JOURNEYS, journeyDef, defaultParams } from './definitions';
import type { JourneyContext, JourneyDef, ParamValue, StepDef, StepEnv, StepOutcome } from './types';

/**
 * 저니 엔진.
 *
 *  - 이벤트 소비자('journeys')가 켜진 저니마다 실행(journey_run)을 만든다. (저니, 이벤트) 유일.
 *  - 실행은 단계를 순서대로 돈다. 대기(wait)·보류(retry)·승인 대기에서 멈추고, /api/cron/events 가
 *    기한이 된 실행을 다시 집는다. 선점은 조건부 갱신(locked_at)이라 겹친 배치가 같은 실행을 함께 돌지 않는다.
 *  - 발송 단계 공통 보호:
 *      탈퇴·기관 차단 → 끝냄 / 후원자가 그 기관 안내 수신을 껐으면 → 끝냄
 *      야간(21시~8시 KST) → 다음 날 9시로 보류 / 후원자당 7일 발송 상한 → 하루 보류(최대 14번 보류 후 건너뜀)
 *      기관이 '승인 후 보내기' 로 둔 단계 → 승인 요청(approval_request)을 쌓고 승인 대기
 *  - 단계 예외는 실행만 재시도(최대 5회) — 업무(결제·약정) 결과는 바뀌지 않는다.
 */

export const JOURNEY_MAX_ATTEMPTS = 5;
export const JOURNEY_LEASE_MS = 5 * 60_000;
export const JOURNEY_WEEKLY_SEND_CAP = 3;
export const JOURNEY_MAX_DEFERRALS = 14;
const QUIET_START = 21; // 21시부터
const QUIET_END = 9; // 9시 전까지
/** JOURNEY_QUIET_HOURS=off 이면 야간 보류를 끈다(테스트·특수 운영용). 기본은 켜짐. */
const quietEnabled = () => (process.env.JOURNEY_QUIET_HOURS ?? 'on') !== 'off';

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

export interface ResolvedJourneySetting {
  def: JourneyDef;
  enabled: boolean;
  approvals: Record<string, boolean>;
  params: Record<string, ParamValue>;
  saved: boolean;
}

function resolve(def: JourneyDef, row?: { enabled: boolean; approvals: unknown; params: unknown } | null): ResolvedJourneySetting {
  const approvals: Record<string, boolean> = {};
  for (const s of def.steps) if (s.approvable) approvals[s.key] = Boolean(s.defaultApproval);
  const savedApprovals = (row?.approvals ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(approvals)) if (typeof savedApprovals[k] === 'boolean') approvals[k] = savedApprovals[k] as boolean;
  const params = defaultParams(def);
  const savedParams = (row?.params ?? {}) as Record<string, unknown>;
  for (const p of def.params) {
    const v = savedParams[p.key];
    if (p.type === 'number' && typeof v === 'number' && Number.isFinite(v)) params[p.key] = v;
    if (p.type === 'boolean' && typeof v === 'boolean') params[p.key] = v;
    if (p.type === 'numberList' && Array.isArray(v) && v.every((x) => typeof x === 'number')) params[p.key] = v as number[];
  }
  return { def, enabled: row ? row.enabled : def.defaultEnabled, approvals, params, saved: Boolean(row) };
}

export async function journeySettings(merchantId: string): Promise<ResolvedJourneySetting[]> {
  const rows = await prisma.journeySetting.findMany({ where: { merchantId } });
  const byKey = new Map(rows.map((r) => [r.journeyKey, r]));
  return JOURNEYS.map((d) => resolve(d, byKey.get(d.key)));
}

export async function journeySetting(merchantId: string, key: string): Promise<ResolvedJourneySetting | null> {
  const def = journeyDef(key);
  if (!def) return null;
  const row = await prisma.journeySetting.findUnique({ where: { merchantId_journeyKey: { merchantId, journeyKey: key } } });
  return resolve(def, row);
}

export class JourneyError extends Error {}

/** 설정 저장. 정의에 있는 단계·값만 받고 범위를 검사한다. */
export async function saveJourneySetting(
  merchantId: string,
  key: string,
  input: { enabled: boolean; approvals: Record<string, boolean>; params: Record<string, unknown> },
  userId: string,
) {
  const def = journeyDef(key);
  if (!def) throw new JourneyError('알 수 없는 자동 안내입니다.');
  const approvals: Record<string, boolean> = {};
  for (const s of def.steps) if (s.approvable) approvals[s.key] = Boolean(input.approvals[s.key]);
  const params: Record<string, ParamValue> = {};
  const current = (await journeySetting(merchantId, key))!.params;
  for (const p of def.params) {
    const raw = input.params[p.key];
    // 값을 보내지 않은 항목은 지금 값(없으면 기본값)을 그대로 둔다.
    if (raw === undefined || (p.type !== 'boolean' && raw === '')) {
      params[p.key] = current[p.key] ?? p.default;
      continue;
    }
    if (p.type === 'boolean') params[p.key] = Boolean(raw);
    else if (p.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new JourneyError(`${p.label} 값을 확인해 주세요.`);
      if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) throw new JourneyError(`${p.label}은(는) ${p.min ?? ''}~${p.max ?? ''} 사이로 입력해 주세요.`);
      params[p.key] = Math.round(n);
    } else {
      const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\s]+/))
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0 && n <= 1000);
      if (list.length > 12) throw new JourneyError(`${p.label}은(는) 12개까지 입력할 수 있습니다.`);
      params[p.key] = [...new Set(list)].sort((a, b) => a - b);
    }
  }
  return prisma.journeySetting.upsert({
    where: { merchantId_journeyKey: { merchantId, journeyKey: key } },
    create: { id: newId(), merchantId, journeyKey: key, enabled: input.enabled, approvals, params: params as Prisma.InputJsonValue, updatedBy: userId },
    update: { enabled: input.enabled, approvals, params: params as Prisma.InputJsonValue, updatedBy: userId },
  });
}

// ---------------------------------------------------------------------------
// 실행 만들기 (이벤트 소비자)
// ---------------------------------------------------------------------------

export async function startJourneysForEvent(ev: StoredDomainEvent): Promise<string[]> {
  const defs = JOURNEYS.filter((d) => (d.triggers as readonly string[]).includes(ev.type));
  if (defs.length === 0) return [];
  const created: string[] = [];
  for (const def of defs) {
    const setting = await journeySetting(ev.merchantId, def.key);
    if (!setting?.enabled) continue;
    if (def.accept && !def.accept(ev)) continue;
    const triggerKey = `${def.key}:${ev.id}`;
    const r = await prisma.journeyRun.createMany({
      data: [
        {
          id: newId(),
          merchantId: ev.merchantId,
          journeyKey: def.key,
          triggerKey,
          eventId: ev.id,
          payerId: ev.payerId,
          subjectType: ev.subjectType,
          subjectId: ev.subjectId,
          context: def.buildContext(ev) as Prisma.InputJsonValue,
          startedAt: ev.occurredAt,
        },
      ],
      skipDuplicates: true,
    });
    const row = await prisma.journeyRun.findUnique({ where: { triggerKey }, select: { id: true } });
    if (r.count > 0 && row) created.push(row.id);
  }
  return created;
}

// ---------------------------------------------------------------------------
// 실행 진행
// ---------------------------------------------------------------------------

function kstHour(d: Date) {
  return new Date(d.getTime() + 9 * 3_600_000).getUTCHours();
}

/** 다음 9시(KST) */
export function nextMorning(d: Date): Date {
  const k = new Date(d.getTime() + 9 * 3_600_000);
  const day = k.getUTCHours() >= QUIET_END ? 1 : 0;
  const target = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() + day, QUIET_END, 0, 0) - 9 * 3_600_000;
  return new Date(target);
}

export function isQuietHour(d: Date, force = false) {
  if (!force && !quietEnabled()) return false;
  const h = kstHour(d);
  return h >= QUIET_START || h < QUIET_END;
}

type RunRow = Awaited<ReturnType<typeof prisma.journeyRun.findUniqueOrThrow>>;

/** 발송 단계 공통 보호. null 이면 보내도 된다. */
async function sendGuard(run: RunRow, now: Date): Promise<StepOutcome | null> {
  if (!run.payerId) return { type: 'stop', detail: '후원자 없음' };
  const [payer, link, blocked] = await Promise.all([
    prisma.payerProfile.findUnique({ where: { id: run.payerId }, select: { onboardingStatus: true } }),
    prisma.payerMerchantLink.findUnique({
      where: { payerId_merchantId: { payerId: run.payerId, merchantId: run.merchantId } },
      select: { payerBlockedAt: true, noticeOptOutAt: true },
    }),
    prisma.blockedPayer.findFirst({ where: { merchantId: run.merchantId, payerId: run.payerId }, select: { id: true } }),
  ]);
  if (!payer || payer.onboardingStatus === 'WITHDRAWN') return { type: 'stop', detail: '탈퇴한 후원자' };
  if (blocked || link?.payerBlockedAt) return { type: 'stop', detail: '차단 관계' };
  if (link?.noticeOptOutAt) return { type: 'stop', detail: '후원자가 이 기관 안내 수신을 끔' };
  if (isQuietHour(now)) return { type: 'retry', until: nextMorning(now), detail: '야간 발송 보류' };
  const sent = await prisma.journeyStepLog.count({
    where: { merchantId: run.merchantId, payerId: run.payerId, sent: true, at: { gte: new Date(now.getTime() - 7 * 86_400_000) } },
  });
  if (sent >= JOURNEY_WEEKLY_SEND_CAP) return { type: 'retry', until: new Date(now.getTime() + 86_400_000), detail: `후원자당 7일 ${JOURNEY_WEEKLY_SEND_CAP}건 상한` };
  return null;
}

async function log(run: RunRow, stepIndex: number, step: StepDef | null, outcome: string, detail?: string, sent = false) {
  await prisma.journeyStepLog.create({
    data: {
      id: newId(), runId: run.id, stepIndex, stepKey: step?.key ?? '-', outcome, sent, detail: detail?.slice(0, 300) ?? null,
      merchantId: run.merchantId, payerId: run.payerId,
    },
  });
}

/** 한 실행을 가능한 데까지 진행한다. 다른 실행이 잡고 있으면 아무것도 하지 않는다. */
export async function advanceRun(runId: string, now = new Date()): Promise<{ status: string } | null> {
  const owner = `${now.getTime()}:${generateToken(6)}`;
  const leaseCut = new Date(now.getTime() - JOURNEY_LEASE_MS);
  const claim = await prisma.journeyRun.updateMany({
    where: {
      id: runId,
      dueAt: { lte: now },
      OR: [
        { status: 'WAITING', OR: [{ lockedAt: null }, { lockedAt: { lt: leaseCut } }] },
        { status: 'RUNNING', lockedAt: { lt: leaseCut } },
      ],
    },
    data: { status: 'RUNNING', lockedAt: now, lockedBy: owner },
  });
  if (claim.count === 0) return null;

  let run = await prisma.journeyRun.findUniqueOrThrow({ where: { id: runId } });
  const def = journeyDef(run.journeyKey);
  const finish = async (status: string, data: Prisma.JourneyRunUpdateManyMutationInput = {}) => {
    await prisma.journeyRun.updateMany({ where: { id: runId, lockedBy: owner }, data: { status, lockedAt: null, lockedBy: null, ...data } });
    return { status };
  };
  if (!def) return finish('STOPPED', { lastError: '정의가 없는 저니', finishedAt: now });
  const setting = await journeySetting(run.merchantId, run.journeyKey);
  if (!setting?.enabled) {
    await log(run, run.stepIndex, null, 'STOPPED', '기관이 자동 안내를 껐음');
    return finish('STOPPED', { finishedAt: now });
  }
  const merchant = await prisma.merchantProfile.findUnique({ where: { id: run.merchantId }, select: { id: true, displayName: true } });
  if (!merchant) return finish('STOPPED', { finishedAt: now, lastError: '기관 없음' });

  for (let guard = 0; guard < 20; guard += 1) {
    const idx = run.stepIndex;
    const step = def.steps[idx];
    if (!step) return finish('DONE', { finishedAt: now });
    const ctx = (run.context ?? {}) as JourneyContext;
    const env: StepEnv = {
      run: { id: run.id, merchantId: run.merchantId, payerId: run.payerId, journeyKey: run.journeyKey, triggerKey: run.triggerKey, startedAt: run.startedAt, context: ctx },
      params: setting.params,
      merchant,
      now,
    };
    let outcome: StepOutcome;
    try {
      // 1) 반려된 단계는 건너뛴다
      if (ctx.rejected?.[step.key]) outcome = { type: 'skip', detail: '담당자가 반려함' };
      else {
        // 2) 조건
        const ok = step.when ? await step.when(env) : true;
        if (ok !== true) outcome = { type: 'skip', detail: ok };
        else {
          // 3) 발송 보호
          const blocked = step.sends ? await sendGuard(run, now) : null;
          if (blocked) outcome = blocked;
          // 4) 승인
          else if (step.approvable && setting.approvals[step.key] && !ctx.approved?.[step.key]) {
            const title = (await step.approvalTitle?.(env)) ?? step.label;
            await requestApproval({
              merchantId: run.merchantId,
              kind: 'JOURNEY_STEP',
              title,
              summary: `${def.label} · ${step.label}`,
              payload: { runId: run.id, stepKey: step.key, stepIndex: idx, journeyKey: def.key },
              subjectType: run.subjectType ?? undefined,
              subjectId: run.subjectId ?? undefined,
              payerId: run.payerId,
              dedupeKey: `journey:${run.id}:${step.key}`,
            });
            await log(run, idx, step, 'AWAITING_APPROVAL', '승인 대기함에 올림');
            return finish('AWAITING_APPROVAL');
          } else outcome = await step.run(env);
        }
      }
    } catch (e) {
      const message = (e as Error).message;
      const attempts = run.attempts + 1;
      logger.warn('저니 단계 실패', { runId, step: step.key, message });
      await log(run, idx, step, 'FAILED', message);
      if (attempts >= JOURNEY_MAX_ATTEMPTS) return finish('FAILED', { attempts, lastError: message.slice(0, 500), finishedAt: now });
      return finish('WAITING', { attempts, lastError: message.slice(0, 500), dueAt: new Date(now.getTime() + attempts * 10 * 60_000) });
    }

    switch (outcome.type) {
      case 'done':
      case 'skip': {
        await log(run, idx, step, outcome.type === 'done' ? 'DONE' : 'SKIPPED', outcome.detail, outcome.type === 'done' && Boolean(outcome.sent));
        run = await prisma.journeyRun.update({ where: { id: runId }, data: { stepIndex: idx + 1, attempts: 0, lastError: null } });
        continue;
      }
      case 'stop': {
        await log(run, idx, step, 'STOPPED', outcome.detail);
        return finish('STOPPED', { finishedAt: now });
      }
      case 'wait': {
        await log(run, idx, step, 'WAIT', outcome.detail);
        if (outcome.until <= now) {
          run = await prisma.journeyRun.update({ where: { id: runId }, data: { stepIndex: idx + 1 } });
          continue;
        }
        return finish('WAITING', { stepIndex: idx + 1, dueAt: outcome.until });
      }
      case 'retry': {
        const deferrals = (ctx.deferrals ?? 0) + 1;
        await log(run, idx, step, 'BLOCKED', outcome.detail);
        if (deferrals > JOURNEY_MAX_DEFERRALS) {
          await log(run, idx, step, 'SKIPPED', '보류가 길어져 건너뜀');
          run = await prisma.journeyRun.update({ where: { id: runId }, data: { stepIndex: idx + 1, context: { ...ctx, deferrals: 0 } as Prisma.InputJsonValue } });
          continue;
        }
        return finish('WAITING', { dueAt: outcome.until, context: { ...ctx, deferrals } as Prisma.InputJsonValue });
      }
    }
  }
  return finish('WAITING', { dueAt: new Date(now.getTime() + 60_000) });
}

/** 기한이 된 실행을 진행한다(/api/cron/events). */
export async function advanceDueJourneyRuns(opts: { limit?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const leaseCut = new Date(now.getTime() - JOURNEY_LEASE_MS);
  const due = await prisma.journeyRun.findMany({
    where: {
      dueAt: { lte: now },
      OR: [
        { status: 'WAITING', OR: [{ lockedAt: null }, { lockedAt: { lt: leaseCut } }] },
        { status: 'RUNNING', lockedAt: { lt: leaseCut } },
      ],
    },
    orderBy: { dueAt: 'asc' },
    take: opts.limit ?? 300,
    select: { id: true },
  });
  const result = { picked: due.length, done: 0, waiting: 0, approval: 0, stopped: 0, failed: 0 };
  for (const r of due) {
    const out = await advanceRun(r.id, now).catch((e) => {
      logger.error('저니 실행 진행 실패', { runId: r.id, message: (e as Error).message });
      return null;
    });
    if (!out) continue;
    if (out.status === 'DONE') result.done += 1;
    else if (out.status === 'WAITING') result.waiting += 1;
    else if (out.status === 'AWAITING_APPROVAL') result.approval += 1;
    else if (out.status === 'FAILED') result.failed += 1;
    else result.stopped += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 승인 처리기
// ---------------------------------------------------------------------------

async function onDecision(req: ApprovalRow, decision: 'APPROVE' | 'REJECT') {
  const runId = String(req.payload.runId ?? '');
  const stepKey = String(req.payload.stepKey ?? '');
  const run = await prisma.journeyRun.findFirst({ where: { id: runId, merchantId: req.merchantId } });
  if (!run) throw new ApprovalError('자동 안내 실행을 찾을 수 없습니다.');
  if (run.status !== 'AWAITING_APPROVAL') throw new ApprovalError('이미 처리되었거나 취소된 안내입니다.');
  const ctx = (run.context ?? {}) as JourneyContext;
  const next: JourneyContext =
    decision === 'APPROVE'
      ? { ...ctx, approved: { ...(ctx.approved ?? {}), [stepKey]: true } }
      : { ...ctx, rejected: { ...(ctx.rejected ?? {}), [stepKey]: true } };
  const r = await prisma.journeyRun.updateMany({
    where: { id: run.id, status: 'AWAITING_APPROVAL' },
    data: { status: 'WAITING', dueAt: new Date(), context: next as Prisma.InputJsonValue },
  });
  if (r.count === 0) throw new ApprovalError('이미 처리된 안내입니다.');
  await prisma.journeyStepLog.create({
    data: {
      id: newId(), runId: run.id, stepIndex: run.stepIndex, stepKey, outcome: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      merchantId: run.merchantId, payerId: run.payerId,
    },
  });
  const out = await advanceRun(run.id).catch((e) => {
    logger.warn('승인 후 저니 진행 실패 — 다음 배치에서 이어 갑니다', { runId: run.id, message: (e as Error).message });
    return null;
  });
  if (decision === 'REJECT') return;
  const last = await prisma.journeyStepLog.findFirst({ where: { runId: run.id, stepKey, outcome: { in: ['DONE', 'SKIPPED', 'BLOCKED', 'STOPPED'] } }, orderBy: { at: 'desc' } });
  if (!out) return '승인했습니다. 곧 발송됩니다.';
  if (last?.outcome === 'DONE') return `승인하고 보냈습니다. (${last.detail ?? ''})`;
  if (last?.outcome === 'BLOCKED') return `승인했습니다. ${last.detail ?? '보류'} — 가능해지면 보냅니다.`;
  return `승인했습니다. ${last?.detail ?? ''}`.trim();
}

/** 실행 취소(담당자): 대기·승인 대기 중인 실행을 멈춘다. */
export async function cancelJourneyRun(merchantId: string, runId: string) {
  const run = await prisma.journeyRun.findFirst({ where: { id: runId, merchantId } });
  if (!run) throw new JourneyError('실행을 찾을 수 없습니다.');
  const r = await prisma.journeyRun.updateMany({ where: { id: runId, status: { in: ['WAITING', 'AWAITING_APPROVAL'] } }, data: { status: 'CANCELED', finishedAt: new Date(), lockedAt: null, lockedBy: null } });
  if (r.count === 0) throw new JourneyError('진행 중인 실행만 취소할 수 있습니다.');
  const step = journeyDef(run.journeyKey)?.steps[run.stepIndex];
  if (step) await cancelApproval(`journey:${run.id}:${step.key}`, '실행 취소');
  await prisma.journeyStepLog.create({ data: { id: newId(), runId, stepIndex: run.stepIndex, stepKey: step?.key ?? '-', outcome: 'STOPPED', detail: '담당자가 취소', merchantId, payerId: run.payerId } });
}

// ---------------------------------------------------------------------------
// 등록
// ---------------------------------------------------------------------------

let registered = false;
export function registerJourneyEngine() {
  if (registered) return;
  registered = true;
  const types = [...new Set(JOURNEYS.flatMap((j) => j.triggers))];
  registerConsumer({
    name: 'journeys',
    types,
    async handle(ev) {
      const ids = await startJourneysForEvent(ev);
      if (ids.length === 0) return 'SKIPPED';
      // 바로 첫 단계까지 진행한다. 진행 실패는 이벤트 처리 실패가 아니다(실행이 따로 재시도한다).
      for (const id of ids) {
        await advanceRun(id).catch((e) => logger.warn('저니 첫 진행 실패 — 배치가 이어 갑니다', { runId: id, message: (e as Error).message }));
      }
    },
  });
  registerApprovalHandler('JOURNEY_STEP', {
    onApprove: (req) => onDecision(req, 'APPROVE'),
    onReject: async (req) => {
      await onDecision(req, 'REJECT');
    },
  });
}

/** 기관 화면 집계: 최근 30일 저니별 상태 수 */
export async function journeyStats(merchantId: string, since = new Date(Date.now() - 30 * 86_400_000)) {
  const g = await prisma.journeyRun.groupBy({ by: ['journeyKey', 'status'], where: { merchantId, startedAt: { gte: since } }, _count: { _all: true } });
  const sent = await prisma.journeyStepLog.groupBy({ by: ['stepKey'], where: { merchantId, sent: true, at: { gte: since } }, _count: { _all: true } });
  return { runs: g, sent: new Map(sent.map((s) => [s.stepKey, s._count._all])) };
}
