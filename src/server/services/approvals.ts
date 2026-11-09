import { prisma } from '@/server/db';
import type { Prisma } from '@/generated/prisma/client';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { generateToken } from '@/lib/crypto';

/**
 * 승인 요청 — "시스템이 준비하고 사람이 확인하는" 일의 공용 기구.
 *
 *  - 요청은 `dedupeKey` 유니크라 같은 일을 두 번 쌓지 않는다.
 *  - 결정은 조건부 선점(PENDING → PROCESSING)이라 두 담당자가 동시에 눌러도 한 번만 처리된다.
 *  - 승인 처리기(onApprove)가 실패하면 요청을 PENDING 으로 되돌리고 오류를 남긴다(다시 누를 수 있다).
 *  - 처리기는 kind 별로 registerApprovalHandler 로 등록한다(저니 승인 단계, 영수증 일괄 발급 …).
 *  - 기관 소유 확인은 decideApproval 이 merchantId 로 한다(다른 기관 요청은 찾지 못한 것으로 본다).
 *  - 오래 걸리는 일(영수증 일괄 발급 등)은 처리기를 `deferred` 로 등록한다. 승인은 QUEUED 로 기록만 하고
 *    /api/cron/events 의 runQueuedApprovals 가 시간 상한 안에서 나눠 실행한다(재시작·시간 초과에도 이어서 한다).
 *  - PROCESSING 이 오래 남은 요청(서버 액션이 끊김)은 recoverStaleApprovals 가 PENDING 으로 되돌린다(2026-11-06 점검 A-1).
 *    처리기는 다시 불러도 같은 결과여야 한다(이미 반영된 승인은 성공으로 본다).
 */

export type ApprovalKind =
  | 'JOURNEY_STEP'
  | 'RECEIPT_BATCH'
  | 'DOCUMENT_SEND'
  | 'CONTENT_CALENDAR'
  | 'VOLUNTEER_CERTIFICATE'
  | 'SUPPORTER_MERGE'
  | 'AI_DRAFT'
  // 2026-11-11 G: 주간 운영 계획 제안 — 승인해도 캘린더 설정·검토 대기 콘텐츠만 만든다(게시·발송 없음)
  | 'WEEKLY_PLAN_SLOT'
  | 'WEEKLY_PLAN_TOPIC';

export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  JOURNEY_STEP: '자동 안내 승인',
  RECEIPT_BATCH: '기부금영수증 일괄 발급',
  DOCUMENT_SEND: '전자문서 발송',
  CONTENT_CALENDAR: '콘텐츠 자동 게시',
  VOLUNTEER_CERTIFICATE: '봉사활동 확인서 발급',
  SUPPORTER_MERGE: '후원자 병합',
  AI_DRAFT: 'AI 초안 검토',
  WEEKLY_PLAN_SLOT: '주간 계획 — 콘텐츠 슬롯 추가',
  WEEKLY_PLAN_TOPIC: '주간 계획 — 콘텐츠 주제 제안',
};

export interface ApprovalRow {
  id: string;
  merchantId: string;
  kind: string;
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  subjectType: string | null;
  subjectId: string | null;
  payerId: string | null;
}

export interface ApprovalHandler {
  /** 승인됐을 때 실행. 반환 문자열은 담당자에게 보여 줄 결과 문구. 다시 불러도 안전해야 한다. */
  onApprove(req: ApprovalRow, userId: string): Promise<string | void>;
  onReject?(req: ApprovalRow, userId: string): Promise<void>;
  /**
   * 오래 걸리는 일. 있으면 승인 때 onApprove 대신 QUEUED 로만 기록하고 배치가 이 함수를 부른다.
   * deadline 까지만 일하고 남은 일이 있으면 done=false 로 돌려준다(다음 배치가 이어서 한다).
   * state 는 실행 사이에 이어지는 값(payload.progress 에 저장)이다.
   */
  execute?(req: ApprovalRow, ctx: { userId: string; deadline: Date; now: () => Date; state: Record<string, unknown> }): Promise<{
    done: boolean;
    message: string;
    state: Record<string, unknown>;
  }>;
  /** 승인 직후 담당자에게 보여 줄 문구(deferred 일 때) */
  queuedMessage?(req: ApprovalRow): string;
}

const handlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(kind: ApprovalKind, handler: ApprovalHandler) {
  handlers.set(kind, handler);
}

export class ApprovalError extends Error {}

function jsonSafe(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v ?? {}, (_k, val) => (typeof val === 'bigint' ? val.toString() : val))) as Prisma.InputJsonValue;
}

export interface RequestApprovalInput {
  merchantId: string;
  kind: ApprovalKind;
  title: string;
  summary?: string;
  payload?: Record<string, unknown>;
  subjectType?: string;
  subjectId?: string;
  payerId?: string | null;
  dedupeKey: string;
  expiresAt?: Date;
}

/** 승인 요청을 쌓는다. 이미 같은 키가 있으면 그 행을 돌려준다(created=false). */
export async function requestApproval(input: RequestApprovalInput, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const r = await tx.approvalRequest.createMany({
    data: [
      {
        id: newId(),
        merchantId: input.merchantId,
        kind: input.kind,
        title: input.title.slice(0, 120),
        summary: input.summary?.slice(0, 500) ?? null,
        payload: jsonSafe(input.payload),
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        payerId: input.payerId ?? null,
        dedupeKey: input.dedupeKey,
        expiresAt: input.expiresAt ?? null,
      },
    ],
    skipDuplicates: true,
  });
  const row = await tx.approvalRequest.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey } });
  return { created: r.count > 0, request: row };
}

export async function decideApproval(input: {
  merchantId: string;
  id: string;
  decision: 'APPROVE' | 'REJECT';
  userId: string;
  note?: string;
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const req = await prisma.approvalRequest.findFirst({ where: { id: input.id, merchantId: input.merchantId } });
  if (!req) throw new ApprovalError('승인 요청을 찾을 수 없습니다.');
  if (req.expiresAt && req.expiresAt < new Date() && req.status === 'PENDING') {
    await prisma.approvalRequest.updateMany({ where: { id: req.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    throw new ApprovalError('기한이 지난 요청입니다.');
  }
  const claim = await prisma.approvalRequest.updateMany({
    where: { id: req.id, status: 'PENDING' },
    data: { status: 'PROCESSING', decidedBy: input.userId, note: input.note?.slice(0, 300) ?? null },
  });
  if (claim.count === 0) throw new ApprovalError('이미 처리된 요청입니다.');

  const row = toRow(req);
  const handler = await handlerFor(req.kind);

  // 오래 걸리는 일: 승인만 기록하고 배치가 실행한다(서버 액션이 끊겨도 일이 멈추지 않는다).
  if (input.decision === 'APPROVE' && handler?.execute) {
    await prisma.approvalRequest.updateMany({
      where: { id: req.id, status: 'PROCESSING' },
      data: { status: 'QUEUED', decidedAt: new Date(), error: null, lockedAt: null, lockedBy: null, attempts: 0, result: '실행 대기' },
    });
    return { ok: true, message: handler.queuedMessage?.(row) ?? '승인했습니다. 몇 분 안에 자동으로 처리됩니다(진행 상황은 승인 대기함).' };
  }

  let message: string;
  try {
    if (input.decision === 'APPROVE') {
      if (!handler) throw new ApprovalError('이 요청을 처리할 수 있는 기능이 아직 연결되지 않았습니다.');
      message = (await handler.onApprove(row, input.userId)) || '승인했습니다.';
    } else {
      await handler?.onReject?.(row, input.userId);
      message = '반려했습니다.';
    }
  } catch (e) {
    const msg = e instanceof ApprovalError ? e.message : '처리 중 오류가 발생했습니다.';
    logger.warn('승인 처리 실패', { id: req.id, kind: req.kind, message: (e as Error).message });
    await prisma.approvalRequest
      .updateMany({ where: { id: req.id, status: 'PROCESSING' }, data: { status: 'PENDING', error: (e as Error).message.slice(0, 300) } })
      .catch((err) => logger.error('승인 요청 되돌리기 실패 — 정리 배치가 되돌립니다', { id: req.id, message: (err as Error).message }));
    return { ok: false, message: msg };
  }
  // 처리기는 끝났다. 결과 기록이 실패해도 PENDING 으로 되돌리지 않는다(처리기를 다시 돌리면 이미 반영된 일을
  // "처리할 수 없음" 으로 거절해 영구히 대기에 남는다 — 점검 A 낮음). PROCESSING 으로 남으면 정리 배치가 되돌리고,
  // 처리기는 다시 불러도 이미 반영된 승인을 성공으로 본다.
  await prisma.approvalRequest
    .updateMany({
      where: { id: req.id, status: 'PROCESSING' },
      data: { status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedAt: new Date(), error: null },
    })
    .catch((e) => logger.error('승인 결과 기록 실패 — 처리는 끝났습니다', { id: req.id, message: (e as Error).message }));
  return { ok: true, message };
}

function toRow(req: { id: string; merchantId: string; kind: string; title: string; summary: string | null; payload: unknown; subjectType: string | null; subjectId: string | null; payerId: string | null }): ApprovalRow {
  return {
    id: req.id, merchantId: req.merchantId, kind: req.kind, title: req.title, summary: req.summary,
    payload: (req.payload ?? {}) as Record<string, unknown>, subjectType: req.subjectType, subjectId: req.subjectId, payerId: req.payerId,
  };
}

async function handlerFor(kind: string) {
  // 처리기는 기본 소비자 등록 때 함께 등록된다(서버 액션 프로세스에서도 보장).
  if (!handlers.has(kind)) {
    const { registerDefaultConsumers } = await import('./event-consumers');
    registerDefaultConsumers();
  }
  return handlers.get(kind);
}

// ---------------------------------------------------------------------------
// 정체 복구 · 배치 실행 (2026-11-06 점검 A-1)
// ---------------------------------------------------------------------------

/** PROCESSING 이 이보다 오래 갱신되지 않으면 끊긴 처리로 보고 PENDING 으로 되돌린다. */
export const APPROVAL_STALE_PROCESSING_MS = 15 * 60_000;
/** QUEUED 실행 선점 유지 시간. 한 번 실행 시간 상한(APPROVAL_RUN_BUDGET_MS)보다 넉넉히 길다. */
export const APPROVAL_RUN_LEASE_MS = 10 * 60_000;
/** 배치 한 번에 승인 실행에 쓰는 시간 상한 */
export const APPROVAL_RUN_BUDGET_MS = 90_000;
/** 실행 예외가 이만큼 쌓이면 FAILED (담당자 화면에 표시) */
export const APPROVAL_RUN_MAX_ATTEMPTS = 5;

export async function recoverStaleApprovals(now = new Date()) {
  const r = await prisma.approvalRequest.updateMany({
    where: { status: 'PROCESSING', updatedAt: { lt: new Date(now.getTime() - APPROVAL_STALE_PROCESSING_MS) } },
    data: { status: 'PENDING', error: '처리 도중 중단되어 다시 승인을 기다립니다. 이미 반영된 부분은 다시 하지 않습니다.' },
  });
  if (r.count > 0) logger.warn('멈춘 승인 처리를 승인 대기로 되돌림', { count: r.count });
  return r.count;
}

/**
 * 승인된(QUEUED) 오래 걸리는 일을 실행한다. 선점은 조건부 갱신(locked_at 이 비었거나 임대 만료) + 선점 시각은
 * 잡는 순간의 시각이다. 시간 상한까지만 일하고, 남으면 선점을 풀어 다음 배치가 이어 간다.
 */
export async function runQueuedApprovals(opts: { now?: () => Date; budgetMs?: number; limit?: number } = {}) {
  const clock = opts.now ?? (() => new Date());
  const started = clock();
  const deadline = new Date(started.getTime() + (opts.budgetMs ?? APPROVAL_RUN_BUDGET_MS));
  const result = { picked: 0, done: 0, partial: 0, failed: 0 };
  const queued = await prisma.approvalRequest.findMany({
    where: { status: 'QUEUED', OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(started.getTime() - APPROVAL_RUN_LEASE_MS) } }] },
    orderBy: { decidedAt: 'asc' },
    take: opts.limit ?? 20,
  });
  for (const q of queued) {
    if (clock() >= deadline) break;
    const owner = `${clock().getTime()}:${generateToken(6)}`;
    const claimAt = clock();
    const claim = await prisma.approvalRequest.updateMany({
      where: { id: q.id, status: 'QUEUED', OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(claimAt.getTime() - APPROVAL_RUN_LEASE_MS) } }] },
      data: { lockedAt: claimAt, lockedBy: owner },
    });
    if (claim.count === 0) continue;
    result.picked += 1;
    const handler = await handlerFor(q.kind);
    const payload = (q.payload ?? {}) as Record<string, unknown>;
    const state = (payload.progress ?? {}) as Record<string, unknown>;
    try {
      if (!handler?.execute) throw new ApprovalError('이 요청을 처리할 수 있는 기능이 연결되지 않았습니다.');
      const out = await handler.execute(toRow(q), { userId: q.decidedBy ?? 'SYSTEM', deadline, now: clock, state });
      const nextPayload = { ...payload, progress: out.state } as Prisma.InputJsonValue;
      if (out.done) {
        await prisma.approvalRequest.updateMany({
          where: { id: q.id, lockedBy: owner },
          data: { status: 'APPROVED', result: out.message.slice(0, 500), payload: nextPayload, lockedAt: null, lockedBy: null, error: null },
        });
        result.done += 1;
      } else {
        await prisma.approvalRequest.updateMany({
          where: { id: q.id, lockedBy: owner },
          data: { result: out.message.slice(0, 500), payload: nextPayload, lockedAt: null, lockedBy: null },
        });
        result.partial += 1;
      }
    } catch (e) {
      const attempts = q.attempts + 1;
      const failed = attempts >= APPROVAL_RUN_MAX_ATTEMPTS;
      logger.error('승인된 일 실행 실패', { id: q.id, kind: q.kind, attempts, message: (e as Error).message });
      await prisma.approvalRequest
        .updateMany({
          where: { id: q.id, lockedBy: owner },
          data: { attempts, error: (e as Error).message.slice(0, 300), lockedAt: null, lockedBy: null, ...(failed ? { status: 'FAILED' } : {}) },
        })
        .catch(() => undefined);
      if (failed) result.failed += 1;
    }
  }
  return result;
}

/** 담당자 화면: 실패(FAILED)한 승인 실행을 다시 대기열에 올린다. */
export async function retryFailedApproval(merchantId: string, id: string) {
  const r = await prisma.approvalRequest.updateMany({
    where: { id, merchantId, status: 'FAILED' },
    data: { status: 'QUEUED', attempts: 0, error: null, lockedAt: null, lockedBy: null },
  });
  if (r.count !== 1) throw new ApprovalError('다시 실행할 수 있는 요청이 아닙니다.');
}

/** 원천이 사라졌거나(취소된 약정 등) 더는 필요 없는 요청을 닫는다. */
export async function cancelApproval(dedupeKey: string, reason: string) {
  return prisma.approvalRequest.updateMany({
    where: { dedupeKey, status: 'PENDING' },
    data: { status: 'CANCELED', note: reason.slice(0, 300), decidedAt: new Date() },
  });
}

export async function pendingApprovals(merchantId: string, take = 100) {
  return prisma.approvalRequest.findMany({
    where: { merchantId, status: 'PENDING', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    orderBy: { createdAt: 'asc' },
    take,
  });
}

export async function expireApprovals(now = new Date()) {
  const r = await prisma.approvalRequest.updateMany({ where: { status: 'PENDING', expiresAt: { lt: now } }, data: { status: 'EXPIRED' } });
  return r.count;
}
