'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import type { StudioActionState } from '@/app/actions/studio';
import { cancelJourneyRun, JourneyError, journeyDef, saveJourneySetting } from '@/server/services/journeys';
import { ApprovalError, decideApproval } from '@/server/services/approvals';

/**
 * 기관 콘솔 — 자동 안내(저니) 설정 · 승인 대기함 결정.
 * 모든 대상은 세션 기관 소유인지 서비스에서 다시 확인한다.
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
    if (e instanceof JourneyError || e instanceof ApprovalError) return { ok: false, message: e.message };
    logger.error('기관 콘솔(자동 안내) 액션 오류', { message: (e as Error).message });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

export async function saveJourneyAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const key = String(f.get('key') ?? '');
    const def = journeyDef(key);
    if (!def) return { ok: false, message: '알 수 없는 자동 안내입니다.' };
    const approvals: Record<string, boolean> = {};
    for (const s of def.steps) if (s.approvable) approvals[s.key] = f.get(`approval_${s.key}`) === 'on';
    const params: Record<string, unknown> = {};
    for (const p of def.params) {
      if (p.type === 'boolean') params[p.key] = f.get(`param_${p.key}`) === 'on';
      else params[p.key] = String(f.get(`param_${p.key}`) ?? '');
    }
    const enabled = f.get('enabled') === 'on';
    await saveJourneySetting(merchantId, key, { enabled, approvals, params }, userId);
    await writeAudit({ actorUserId: userId, action: 'JOURNEY_SETTING_SAVE', targetType: 'journey_setting', targetId: key, after: { merchantId, enabled, approvals, params } });
    revalidatePath('/studio/journeys');
    return { ok: true, message: enabled ? `「${def.label}」 설정을 저장했습니다.` : `「${def.label}」 을(를) 껐습니다. 진행 중인 안내도 다음 단계에서 멈춥니다.` };
  });
}

export async function cancelJourneyRunAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = String(f.get('id') ?? '');
    await cancelJourneyRun(merchantId, id);
    await writeAudit({ actorUserId: userId, action: 'JOURNEY_RUN_CANCEL', targetType: 'journey_run', targetId: id, after: { merchantId } });
    revalidatePath('/studio/journeys');
    revalidatePath('/studio/inbox');
    return { ok: true, message: '이 안내를 멈췄습니다.' };
  });
}

/** 승인 대기함: 시스템이 준비한 일(저니 승인 단계·영수증 일괄 발급 등)을 승인·반려한다. */
export async function decideApprovalAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = String(f.get('id') ?? '');
    const decision = f.get('decision') === 'REJECT' ? 'REJECT' : 'APPROVE';
    const note = String(f.get('note') ?? '').trim() || undefined;
    const r = await decideApproval({ merchantId, id, decision, userId, note });
    await writeAudit({ actorUserId: userId, action: decision === 'APPROVE' ? 'APPROVAL_APPROVE' : 'APPROVAL_REJECT', targetType: 'approval_request', targetId: id, after: { merchantId, ok: r.ok } });
    revalidatePath('/studio/inbox');
    revalidatePath('/studio/journeys');
    return r;
  });
}
