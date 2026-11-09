'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import type { StudioActionState } from '@/app/actions/studio';
import { PromoError, archivePromo, createPromo, restorePromo, setCampaignAliases, updatePromo } from '@/server/services/promo-codes';

/**
 * 캠페인 홍보물 코드·별칭 (2026-11-12 4차 K1·K2). 기관 콘솔 캠페인 상세에서 쓴다.
 */

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

async function run(fn: (merchantId: string, userId: string) => Promise<StudioActionState>): Promise<StudioActionState> {
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
    if (e instanceof PromoError) return { ok: false, message: e.message };
    logger.error('홍보물 처리 오류', { message: (e as Error).message });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

function refresh(campaignId: string) {
  revalidatePath(`/studio/campaigns/${campaignId}`);
  revalidatePath('/studio/qr');
}

export async function createPromoAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const campaignId = text(f, 'campaignId');
    const p = await createPromo(merchantId, campaignId, { name: text(f, 'name'), keyword: text(f, 'keyword'), expiresOn: text(f, 'expiresOn') }, userId);
    await writeAudit({ actorUserId: userId, action: 'PROMO_CREATE', targetType: 'CampaignPromo', targetId: p.id, after: { campaignId, keyword: p.keyword } });
    refresh(campaignId);
    return { ok: true, message: `홍보물 "${p.name}" 을 만들었습니다.` };
  });
}

export async function updatePromoAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId) => {
    const p = await updatePromo(merchantId, text(f, 'id'), { name: text(f, 'name'), keyword: text(f, 'keyword'), expiresOn: text(f, 'expiresOn') });
    refresh(p.campaignId);
    return { ok: true, message: '홍보물을 저장했습니다.' };
  });
}

export async function archivePromoAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId) => {
    await archivePromo(merchantId, text(f, 'id'));
    refresh(text(f, 'campaignId'));
    return { ok: true, message: '홍보물을 보관했습니다. 문자 키워드와 QR 이 더 이상 홍보물로 집계되지 않습니다.' };
  });
}

export async function restorePromoAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId) => {
    await restorePromo(merchantId, text(f, 'id'));
    refresh(text(f, 'campaignId'));
    return { ok: true, message: '홍보물을 되살렸습니다.' };
  });
}

export async function saveCampaignAliasesAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId) => {
    const campaignId = text(f, 'campaignId');
    const list = text(f, 'aliases').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const saved = await setCampaignAliases(merchantId, campaignId, list);
    refresh(campaignId);
    return { ok: true, message: saved.length ? `별칭 ${saved.length}개를 저장했습니다.` : '별칭을 비웠습니다.' };
  });
}
