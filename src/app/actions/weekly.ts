'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import type { StudioActionState } from '@/app/actions/studio';
import { ApprovalError, decideApproval } from '@/server/services/approvals';
import { archiveGoal, GoalError, saveGoal } from '@/server/services/goals';
import { ackWeeklyPlan, setWeeklyReportEnabled } from '@/server/services/weekly-plan';
import {
  archiveContentAsset,
  attachAssetToContent,
  ContentAssetError,
  detachAssetFromContent,
  linkPortraitConsent,
  updateContentAssetMeta,
  uploadContentAsset,
  ASSET_MAX_VIDEO_BYTES,
} from '@/server/services/content-assets';
import { ContentError } from '@/server/services/content';

/**
 * 주간 운영 보고·기관 목표·콘텐츠 소재(2026-11-11 G). 대상은 서비스에서 세션 기관 소유인지 다시 확인한다.
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
    if (e instanceof GoalError || e instanceof ApprovalError || e instanceof ContentAssetError || e instanceof ContentError) return { ok: false, message: e.message };
    logger.error('주간 운영 액션 처리 오류', { message: (e as Error)?.message ?? '' });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const list = (f: FormData, k: string) => f.getAll(k).filter((v): v is string => typeof v === 'string');

// ---------------------------------------------------------------------------
// 목표
// ---------------------------------------------------------------------------

export async function saveGoalAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = text(f, 'id') || undefined;
    await saveGoal(merchantId, userId, { kind: text(f, 'kind'), title: text(f, 'title'), target: text(f, 'target'), campaignId: text(f, 'campaignId') || null, dueOn: text(f, 'dueOn') || null }, id);
    revalidatePath('/studio/goals');
    revalidatePath('/studio/weekly');
    return { ok: true, message: id ? '목표를 고쳤습니다.' : '목표를 등록했습니다.' };
  });
}

export async function archiveGoalAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    await archiveGoal(merchantId, text(f, 'id'));
    revalidatePath('/studio/goals');
    return { ok: true, message: '목표를 보관했습니다.' };
  });
}

// ---------------------------------------------------------------------------
// 주간 보고
// ---------------------------------------------------------------------------

export async function ackWeeklyPlanAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = text(f, 'id');
    const ok = await ackWeeklyPlan(merchantId, id, userId);
    revalidatePath('/studio/weekly');
    revalidatePath(`/studio/weekly/${id}`);
    return ok ? { ok: true, message: '확인했습니다.' } : { ok: false, message: '이미 확인했거나 찾을 수 없는 보고입니다.' };
  });
}

export async function weeklyReportSettingAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const enabled = Boolean(f.get('enabled'));
    await setWeeklyReportEnabled(merchantId, enabled);
    await writeAudit({ actorUserId: userId, action: 'WEEKLY_REPORT_SETTING', targetType: 'merchant', targetId: merchantId, after: { enabled } }).catch(() => undefined);
    revalidatePath('/studio/weekly');
    return { ok: true, message: enabled ? '월요일 보고를 받습니다.' : '월요일 보고 문자를 받지 않습니다(콘솔에서는 계속 볼 수 있습니다).' };
  });
}

/** 계획 제안 승인·반려 — 기존 승인 요청 결정 함수 그대로(게시·발송을 만들지 않는 처리기) */
export async function decideWeeklySuggestionAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = text(f, 'approvalId');
    const decision = text(f, 'decision') === 'REJECT' ? 'REJECT' : 'APPROVE';
    const r = await decideApproval({ merchantId, id, decision, userId });
    await writeAudit({ actorUserId: userId, action: decision === 'APPROVE' ? 'APPROVAL_APPROVE' : 'APPROVAL_REJECT', targetType: 'approval_request', targetId: id, after: { merchantId, ok: r.ok, source: 'weekly' } }).catch(() => undefined);
    revalidatePath('/studio/weekly');
    revalidatePath('/studio/inbox');
    const planId = text(f, 'planId');
    if (planId) revalidatePath(`/studio/weekly/${planId}`);
    return r;
  });
}

// ---------------------------------------------------------------------------
// 콘텐츠 소재
// ---------------------------------------------------------------------------

function assetMeta(f: FormData) {
  const blur = text(f, 'blurRequired');
  return {
    tags: list(f, 'tag'),
    people: text(f, 'people'),
    hasFace: Boolean(f.get('hasFace')),
    blurRequired: blur === '' ? null : blur === '1',
    note: text(f, 'note'),
  };
}

export async function uploadContentAssetAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const file = f.get('file');
    if (!(file instanceof File) || file.size === 0) return { ok: false, message: '올릴 사진이나 영상을 골라 주세요.' };
    if (file.size > ASSET_MAX_VIDEO_BYTES) return { ok: false, message: '파일이 너무 큽니다(영상 25MB · 사진 10MB 이하).' };
    const asset = await uploadContentAsset(merchantId, userId, { bytes: Buffer.from(await file.arrayBuffer()), ...assetMeta(f) });
    revalidatePath('/studio/content/assets');
    return { ok: true, message: asset.hasFace && !asset.consentEnvelopeId ? '올렸습니다. 얼굴이 나온 소재라 초상권 동의서를 연결해야 콘텐츠에 쓸 수 있습니다.' : '올렸습니다.' };
  });
}

export async function updateContentAssetAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    await updateContentAssetMeta(merchantId, text(f, 'id'), assetMeta(f));
    revalidatePath('/studio/content/assets');
    return { ok: true, message: '소재 정보를 고쳤습니다.' };
  });
}

export async function archiveContentAssetAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const restore = text(f, 'restore') === '1';
    await archiveContentAsset(merchantId, text(f, 'id'), restore);
    revalidatePath('/studio/content/assets');
    return { ok: true, message: restore ? '되살렸습니다.' : '보관했습니다.' };
  });
}

export async function linkPortraitConsentAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const assetId = text(f, 'id');
    const envelopeId = text(f, 'envelopeId') || null;
    await linkPortraitConsent(merchantId, assetId, envelopeId);
    await writeAudit({ actorUserId: userId, action: 'CONTENT_ASSET_CONSENT', targetType: 'content_asset', targetId: assetId, after: { envelopeId } }).catch(() => undefined);
    revalidatePath('/studio/content/assets');
    return { ok: true, message: envelopeId ? '초상권 동의서를 연결했습니다.' : '동의서 연결을 풀었습니다.' };
  });
}

export async function attachContentAssetAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const itemId = text(f, 'itemId');
    const assetId = text(f, 'assetId');
    if (text(f, 'intent') === 'detach') await detachAssetFromContent(merchantId, itemId, assetId);
    else await attachAssetToContent(merchantId, itemId, assetId);
    revalidatePath(`/studio/content/${itemId}`);
    revalidatePath('/studio/content/review');
    return { ok: true, message: text(f, 'intent') === 'detach' ? '소재 연결을 풀었습니다.' : '소재를 연결했습니다.' };
  });
}
