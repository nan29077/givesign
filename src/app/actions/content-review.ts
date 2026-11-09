'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import type { StudioActionState } from '@/app/actions/studio';
import { ContentError, type PastSlotChoice } from '@/server/services/content';
import { approveContentBatch, rejectContent, requestContentRevision } from '@/server/services/content-review';

/**
 * 콘텐츠 승인 편의(2026-11-09) — 주간 묶음 승인 · 반려 · 수정 요청. 대상은 서비스에서 세션 기관 소유인지 다시 확인한다.
 */

async function withMerchant(fn: (merchantId: string, userId: string) => Promise<StudioActionState>): Promise<StudioActionState> {
  let merchantId: string;
  let userId: string;
  try {
    const user = await requireMerchant();
    merchantId = user.merchantId;
    userId = user.id;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '기관 권한이 필요합니다.' };
  }
  try {
    return await fn(merchantId, userId);
  } catch (e) {
    if (e instanceof ContentError) return { ok: false, message: e.message };
    logger.error('콘텐츠 승인 액션 처리 오류', { message: (e as Error)?.message ?? '' });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

function pastChoice(v: string): PastSlotChoice {
  return v === 'NOW' || v === 'APPROVE_ONLY' ? v : 'NEXT_SLOT';
}

function refresh(ids: string[] = []) {
  revalidatePath('/studio/content');
  revalidatePath('/studio/content/review');
  revalidatePath('/studio/inbox');
  for (const id of ids) revalidatePath(`/studio/content/${id}`);
}

export async function bulkApproveContentAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const ids = f.getAll('ids').filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    const r = await approveContentBatch(merchantId, ids, userId, { whenPast: pastChoice(text(f, 'whenPast')) });
    for (const a of r.approved) {
      await writeAudit({ actorUserId: userId, action: 'CONTENT_APPROVE', targetType: 'content_item', targetId: a.id, after: { batch: true } }).catch(() => undefined);
    }
    refresh(r.approved.map((a) => a.id));
    const skipped = r.skipped.map((s) => `${s.title}: ${s.reason}`).join(' / ');
    return {
      ok: r.approved.length > 0,
      message: `${r.approved.length}건 승인${r.skipped.length ? ` · ${r.skipped.length}건 건너뜀 — ${skipped}` : ''}`,
    };
  });
}

export async function rejectContentAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = text(f, 'id');
    await rejectContent(merchantId, id, userId, { reasonCode: text(f, 'reasonCode'), note: text(f, 'note') });
    await writeAudit({ actorUserId: userId, action: 'CONTENT_REJECT', targetType: 'content_item', targetId: id, after: { reasonCode: text(f, 'reasonCode') } }).catch(() => undefined);
    refresh([id]);
    return { ok: true, message: '반려했습니다. 이유는 다음 콘텐츠를 만들 때 참고합니다.' };
  });
}

export async function reviseContentAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = text(f, 'id');
    const fresh = await requestContentRevision(merchantId, id, userId, text(f, 'request'));
    await writeAudit({ actorUserId: userId, action: 'CONTENT_REVISE', targetType: 'content_item', targetId: id, after: { revisionId: fresh.id } }).catch(() => undefined);
    refresh([id, fresh.id]);
    return {
      ok: true,
      message: fresh.status === 'FAILED' ? `새 판을 만들지 못했습니다: ${fresh.error ?? '생성 실패'}` : '수정 요청을 반영한 새 판을 만들었습니다. 다시 검토해 주세요.',
      redirectTo: `/studio/content/${fresh.id}`,
    };
  });
}
