'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import type { StudioActionState } from '@/app/actions/studio';
import { InboxActionError, isInboxGroupAction, runInboxGroupAction } from '@/server/services/inbox-actions';
import { InboxAssignmentError, resolveInboxAssignment, saveInboxAssignment } from '@/server/services/inbox-assignments';
import { JourneyError, retryJourneyRun } from '@/server/services/journeys';

/**
 * 승인 대기함(예외 해결 화면) 액션 — 묶음 바로 실행 · 담당자/기한 · 막힌 자동 안내 다시 실행 (2026-11-09 C1).
 * 대상은 모두 서비스에서 세션 기관 소유인지 다시 본다.
 */

async function withMerchant(fn: (merchantId: string, userId: string) => Promise<StudioActionState>): Promise<StudioActionState> {
  let merchantId: string;
  let userId: string;
  try {
    const u = await requireMerchant();
    merchantId = u.merchantId;
    userId = u.id;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '기관 권한이 필요합니다.' };
  }
  try {
    return await fn(merchantId, userId);
  } catch (e) {
    if (e instanceof InboxActionError || e instanceof InboxAssignmentError || e instanceof JourneyError) return { ok: false, message: e.message };
    logger.error('승인 대기함 액션 오류', { message: (e as Error).message });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

/** 묶음의 바로 실행 버튼(등록 안내 보내기·다시 실행·재안내) */
export async function runInboxGroupActionAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const action = String(f.get('action') ?? '');
    if (!isInboxGroupAction(action)) return { ok: false, message: '실행할 수 없는 동작입니다.' };
    const payload: Record<string, string> = {};
    for (const [k, v] of f.entries()) if (k.startsWith('p_') && typeof v === 'string') payload[k.slice(2)] = v.slice(0, 60);
    const r = await runInboxGroupAction({ merchantId, userId, action, payload });
    await writeAudit({ actorUserId: userId, action: 'INBOX_GROUP_ACTION', targetType: 'inbox_group', targetId: action, after: { merchantId, payload, done: r.done, skipped: r.skipped } });
    revalidatePath('/studio/inbox');
    return { ok: true, message: r.message };
  });
}

export async function retryJourneyRunAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = String(f.get('id') ?? '');
    const out = await retryJourneyRun(merchantId, id);
    await writeAudit({ actorUserId: userId, action: 'JOURNEY_RUN_RETRY', targetType: 'journey_run', targetId: id, after: { merchantId, status: out?.status ?? null } });
    revalidatePath('/studio/inbox');
    revalidatePath('/studio/journeys');
    return { ok: true, message: out?.status === 'FAILED' ? '다시 실행했지만 같은 이유로 막혔습니다. 원인을 고친 뒤 다시 실행해 주세요.' : '다시 실행했습니다.' };
  });
}

export async function saveInboxAssignmentAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const itemKey = String(f.get('itemKey') ?? '');
    const dueRaw = String(f.get('dueAt') ?? '').trim();
    const dueAt = dueRaw ? new Date(/T\d{2}:\d{2}$/.test(dueRaw) ? `${dueRaw}:00+09:00` : `${dueRaw}T18:00:00+09:00`) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) return { ok: false, message: '처리 기한을 확인해 주세요.' };
    const assigneeUserId = String(f.get('assigneeUserId') ?? '').trim() || null;
    const memo = String(f.get('memo') ?? '');
    await saveInboxAssignment({ merchantId, userId, itemKey, assigneeUserId, dueAt, memo });
    await writeAudit({ actorUserId: userId, action: 'INBOX_ASSIGN', targetType: 'inbox_assignment', targetId: itemKey, after: { merchantId, assigneeUserId, dueAt: dueAt?.toISOString() ?? null } });
    revalidatePath('/studio/inbox');
    return { ok: true, message: dueAt ? '담당·처리 기한을 저장했습니다. 기한이 지나면 대표 담당자에게 알립니다.' : '저장했습니다.' };
  });
}

export async function resolveInboxAssignmentAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const itemKey = String(f.get('itemKey') ?? '');
    await resolveInboxAssignment(merchantId, itemKey);
    await writeAudit({ actorUserId: userId, action: 'INBOX_ASSIGN_RESOLVE', targetType: 'inbox_assignment', targetId: itemKey, after: { merchantId } });
    revalidatePath('/studio/inbox');
    return { ok: true, message: '처리 완료로 표시했습니다.' };
  });
}
