import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { formatKst } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import { notifyUser } from './notifications';

/**
 * 승인 대기함 담당자 배정·처리 기한·상위 알림 (2026-11-09 과제 C1).
 *
 *  - (기관, 항목 키) 1행(`inbox_assignment`). 항목 키는 대기함 항목 key(`approval:{id}` 등) 또는 묶음 key(`group:{kind}`).
 *  - 담당자는 그 기관 담당자 계정이어야 한다. 지금 구조는 기관당 담당자 계정이 하나(소유자 = merchant_profile.user_id)라
 *    화면은 기한·메모만 받는다(계정이 늘면 같은 표에 담당자를 넣는다).
 *  - 기한을 넘기면 inbox 배치가 기관 소유자 계정에 콘솔 알림을 **한 번** 보낸다(`overdue_notified_at IS NULL` 조건부 선점).
 *    기한을 바꾸면 알림 표시를 비워 새 기한에 다시 알린다.
 */

export class InboxAssignmentError extends Error {}

const KEY_RE = /^(approval|approval-run|approval-failed|content|volunteer|document|report|edoc|refund|run|publish|group):[A-Za-z0-9._:-]{1,120}$/;

export function isInboxItemKey(v: string) {
  return KEY_RE.test(v);
}

/** 기관 담당자 계정 목록. 지금은 소유자 1명. */
export async function merchantStaffAccounts(merchantId: string): Promise<Array<{ userId: string; label: string; owner: boolean }>> {
  const m = await prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { userId: true, user: { select: { name: true, email: true } } } });
  if (!m) return [];
  return [{ userId: m.userId, label: m.user.name || m.user.email || '기관 대표 담당자', owner: true }];
}

export async function saveInboxAssignment(input: {
  merchantId: string;
  userId: string;
  itemKey: string;
  assigneeUserId?: string | null;
  dueAt?: Date | null;
  memo?: string | null;
}) {
  if (!isInboxItemKey(input.itemKey)) throw new InboxAssignmentError('대기함 항목을 찾을 수 없습니다.');
  if (input.dueAt && Number.isNaN(input.dueAt.getTime())) throw new InboxAssignmentError('처리 기한을 확인해 주세요.');
  const assignee = input.assigneeUserId?.trim() || null;
  if (assignee) {
    const staff = await merchantStaffAccounts(input.merchantId);
    if (!staff.some((s) => s.userId === assignee)) throw new InboxAssignmentError('이 기관의 담당자 계정만 고를 수 있습니다.');
  }
  const memo = input.memo?.trim().slice(0, 300) || null;
  const existing = await prisma.inboxAssignment.findUnique({ where: { merchantId_itemKey: { merchantId: input.merchantId, itemKey: input.itemKey } } });
  const dueChanged = (existing?.dueAt?.getTime() ?? null) !== (input.dueAt?.getTime() ?? null);
  return prisma.inboxAssignment.upsert({
    where: { merchantId_itemKey: { merchantId: input.merchantId, itemKey: input.itemKey } },
    create: {
      id: newId(), merchantId: input.merchantId, itemKey: input.itemKey, assigneeUserId: assignee, dueAt: input.dueAt ?? null, memo, createdBy: input.userId,
    },
    update: {
      assigneeUserId: assignee,
      dueAt: input.dueAt ?? null,
      memo,
      resolvedAt: null,
      ...(dueChanged ? { overdueNotifiedAt: null } : {}),
    },
  });
}

/** 처리 완료 표시(담당자). 다시 나타나면 새로 배정한다. */
export async function resolveInboxAssignment(merchantId: string, itemKey: string) {
  const r = await prisma.inboxAssignment.updateMany({ where: { merchantId, itemKey, resolvedAt: null }, data: { resolvedAt: new Date() } });
  if (r.count !== 1) throw new InboxAssignmentError('처리할 배정이 없습니다.');
}

export async function inboxAssignmentsFor(merchantId: string) {
  const rows = await prisma.inboxAssignment.findMany({ where: { merchantId, resolvedAt: null } });
  return new Map(rows.map((r) => [r.itemKey, r]));
}

export function isOverdue(a: { dueAt: Date | null; resolvedAt?: Date | null } | undefined | null, now = new Date()) {
  return !!a && !a.resolvedAt && !!a.dueAt && a.dueAt.getTime() < now.getTime();
}

/**
 * 배치: 기한 넘긴 배정마다 기관 소유자에게 콘솔 알림 한 번. 항목이 대기함에서 사라졌으면(처리됨) 닫는다.
 * 선점은 `overdue_notified_at IS NULL` 조건부 갱신이라 겹친 배치도 한 번만 알린다.
 */
export async function notifyOverdueInboxAssignments(now = new Date(), opts: { stillOpen?: (merchantId: string, itemKey: string) => Promise<boolean> } = {}) {
  const due = await prisma.inboxAssignment.findMany({
    where: { resolvedAt: null, overdueNotifiedAt: null, dueAt: { lt: now } },
    orderBy: { dueAt: 'asc' },
    take: 500,
  });
  const result = { checked: due.length, notified: 0, closed: 0 };
  const stillOpen = opts.stillOpen ?? itemStillOpen;
  for (const a of due) {
    try {
      if (!(await stillOpen(a.merchantId, a.itemKey))) {
        const r = await prisma.inboxAssignment.updateMany({ where: { id: a.id, resolvedAt: null }, data: { resolvedAt: now } });
        result.closed += r.count;
        continue;
      }
      const claim = await prisma.inboxAssignment.updateMany({ where: { id: a.id, overdueNotifiedAt: null, resolvedAt: null }, data: { overdueNotifiedAt: now } });
      if (claim.count !== 1) continue;
      const m = await prisma.merchantProfile.findUnique({ where: { id: a.merchantId }, select: { userId: true } });
      if (!m) continue;
      await notifyUser({
        userId: m.userId,
        title: '승인 대기함: 처리 기한이 지났습니다',
        body: `기한 ${formatKst(a.dueAt!, false)} 이 지난 일이 있습니다.${a.memo ? ` 메모: ${a.memo}` : ''} 승인 대기함에서 확인해 주세요.`,
        linkUrl: '/studio/inbox',
      });
      result.notified += 1;
    } catch (e) {
      logger.warn('승인 대기함 기한 알림 실패', { id: a.id, message: (e as Error).message });
    }
  }
  return result;
}

/** 항목이 아직 대기함에 있는가(원천 상태로 판단). 모르는 종류는 열려 있다고 본다(알림을 놓치지 않게). */
export async function itemStillOpen(merchantId: string, itemKey: string): Promise<boolean> {
  const [type, ...rest] = itemKey.split(':');
  const id = rest.join(':');
  switch (type) {
    case 'approval':
      return (await prisma.approvalRequest.count({ where: { id, merchantId, status: 'PENDING' } })) > 0;
    case 'approval-run':
      return (await prisma.approvalRequest.count({ where: { id, merchantId, status: { in: ['PROCESSING', 'QUEUED'] } } })) > 0;
    case 'approval-failed':
      return (await prisma.approvalRequest.count({ where: { id, merchantId, status: 'FAILED' } })) > 0;
    case 'run':
      return (await prisma.journeyRun.count({ where: { id, merchantId, status: 'FAILED' } })) > 0;
    case 'publish':
      return (await prisma.contentPublish.count({ where: { id, item: { merchantId }, status: { in: ['FAILED', 'UNKNOWN'] } } })) > 0;
    case 'edoc':
      return (await prisma.eDocEnvelope.count({ where: { id, merchantId, status: { in: ['SENT', 'IN_PROGRESS'] } } })) > 0;
    case 'group': {
      const { loadInboxGroups, groupKey } = await import('./inbox-groups');
      const groups = await loadInboxGroups(merchantId);
      return groups.some((g) => g.key === groupKey(id) && (g.group || g.error));
    }
    default:
      return true;
  }
}
