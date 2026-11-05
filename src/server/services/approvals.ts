import { prisma } from '@/server/db';
import type { Prisma } from '@/generated/prisma/client';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';

/**
 * 승인 요청 — "시스템이 준비하고 사람이 확인하는" 일의 공용 기구.
 *
 *  - 요청은 `dedupeKey` 유니크라 같은 일을 두 번 쌓지 않는다.
 *  - 결정은 조건부 선점(PENDING → PROCESSING)이라 두 담당자가 동시에 눌러도 한 번만 처리된다.
 *  - 승인 처리기(onApprove)가 실패하면 요청을 PENDING 으로 되돌리고 오류를 남긴다(다시 누를 수 있다).
 *  - 처리기는 kind 별로 registerApprovalHandler 로 등록한다(저니 승인 단계, 영수증 일괄 발급 …).
 *  - 기관 소유 확인은 decideApproval 이 merchantId 로 한다(다른 기관 요청은 찾지 못한 것으로 본다).
 */

export type ApprovalKind =
  | 'JOURNEY_STEP'
  | 'RECEIPT_BATCH'
  | 'DOCUMENT_SEND'
  | 'CONTENT_CALENDAR'
  | 'VOLUNTEER_CERTIFICATE'
  | 'SUPPORTER_MERGE'
  | 'AI_DRAFT';

export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  JOURNEY_STEP: '자동 안내 승인',
  RECEIPT_BATCH: '기부금영수증 일괄 발급',
  DOCUMENT_SEND: '전자문서 발송',
  CONTENT_CALENDAR: '콘텐츠 자동 게시',
  VOLUNTEER_CERTIFICATE: '봉사활동 확인서 발급',
  SUPPORTER_MERGE: '후원자 병합',
  AI_DRAFT: 'AI 초안 검토',
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
  /** 승인됐을 때 실행. 반환 문자열은 담당자에게 보여 줄 결과 문구. */
  onApprove(req: ApprovalRow, userId: string): Promise<string | void>;
  onReject?(req: ApprovalRow, userId: string): Promise<void>;
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

  const row: ApprovalRow = {
    id: req.id, merchantId: req.merchantId, kind: req.kind, title: req.title, summary: req.summary,
    payload: (req.payload ?? {}) as Record<string, unknown>, subjectType: req.subjectType, subjectId: req.subjectId, payerId: req.payerId,
  };
  // 처리기는 기본 소비자 등록 때 함께 등록된다(서버 액션 프로세스에서도 보장).
  if (!handlers.has(req.kind)) {
    const { registerDefaultConsumers } = await import('./event-consumers');
    registerDefaultConsumers();
  }
  const handler = handlers.get(req.kind);
  try {
    if (input.decision === 'APPROVE') {
      if (!handler) throw new ApprovalError('이 요청을 처리할 수 있는 기능이 아직 연결되지 않았습니다.');
      const message = await handler.onApprove(row, input.userId);
      await prisma.approvalRequest.update({ where: { id: req.id }, data: { status: 'APPROVED', decidedAt: new Date(), error: null } });
      return { ok: true, message: message || '승인했습니다.' };
    }
    await handler?.onReject?.(row, input.userId);
    await prisma.approvalRequest.update({ where: { id: req.id }, data: { status: 'REJECTED', decidedAt: new Date(), error: null } });
    return { ok: true, message: '반려했습니다.' };
  } catch (e) {
    const message = e instanceof ApprovalError ? e.message : '처리 중 오류가 발생했습니다.';
    logger.warn('승인 처리 실패', { id: req.id, kind: req.kind, message: (e as Error).message });
    await prisma.approvalRequest.update({ where: { id: req.id }, data: { status: 'PENDING', error: (e as Error).message.slice(0, 300) } });
    return { ok: false, message };
  }
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
