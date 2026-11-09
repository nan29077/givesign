'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import { BundleError, continueBundleSend, resendBundleLink, setBundleForRecurring, setBundleItemRequired } from '@/server/services/document-bundles';
import { BUNDLE_TARGET_LABEL, requestBundleSend, type BundleTarget } from '@/server/services/document-bundle-approvals';
import type { StudioActionState } from '@/app/actions/studio';

/**
 * 업무별 문서 묶음(/studio/agreements/bundles) — 2026-11-12 4차 J2.
 * 권한: 기관 콘솔 계정(requireMerchant). 설정 변경·대량 발송 요청·재발송은 감사로그.
 */

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

async function run(fn: (merchantId: string, userId: string) => Promise<StudioActionState>): Promise<StudioActionState> {
  let m: { merchantId: string; id: string };
  try {
    m = await requireMerchant();
  } catch (e) {
    return { ok: false, message: (e as Error).message || '기관 권한이 필요합니다.' };
  }
  try {
    return await fn(m.merchantId, m.id);
  } catch (e) {
    if (e instanceof BundleError) return { ok: false, message: e.message };
    logger.error('문서 묶음 처리 오류', { message: (e as Error).message });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

const refresh = () => revalidatePath('/studio/agreements/bundles');

export async function setBundleForRecurringAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const id = text(f, 'bundleId');
    const on = text(f, 'on') === '1';
    await setBundleForRecurring(merchantId, id, on);
    await writeAudit({ actorUserId: userId, action: 'DOCUMENT_BUNDLE_RECURRING', targetType: 'document_bundle', targetId: id, after: { merchantId, useForRecurring: on } });
    refresh();
    return { ok: true, message: on ? '새 정기후원 약정이 생기면 이 묶음을 함께 보냅니다.' : '정기후원 약정에는 예전처럼 약정서만 보냅니다.' };
  });
}

export async function setBundleItemRequiredAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const id = text(f, 'bundleId');
    const purpose = text(f, 'purpose');
    const required = text(f, 'required') === '1';
    await setBundleItemRequired(merchantId, id, purpose, required);
    await writeAudit({ actorUserId: userId, action: 'DOCUMENT_BUNDLE_ITEM', targetType: 'document_bundle', targetId: id, after: { merchantId, purpose, required } });
    refresh();
    return { ok: true, message: required ? '필수 문서로 바꿨습니다.' : '선택 문서로 바꿨습니다(후원자가 건너뛸 수 있습니다).' };
  });
}

export async function requestBundleSendAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const id = text(f, 'bundleId');
    const target = text(f, 'target') as BundleTarget;
    if (!(target in BUNDLE_TARGET_LABEL)) return { ok: false, message: '보낼 대상을 골라 주세요.' };
    const r = await requestBundleSend(merchantId, id, target);
    await writeAudit({ actorUserId: userId, action: 'DOCUMENT_BUNDLE_SEND_REQUEST', targetType: 'document_bundle', targetId: id, after: { merchantId, target, approvalId: r.approvalId, targetCount: r.targetCount } });
    refresh();
    revalidatePath('/studio/inbox');
    return { ok: true, message: `승인 대기함에 올렸습니다(대상 ${r.targetCount}명). 이용요금 예측을 확인하고 승인하면 보냅니다.`, redirectTo: `/studio/inbox/approvals/${r.approvalId}` };
  });
}

export async function resendBundleLinkAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const id = text(f, 'sendId');
    await resendBundleLink(merchantId, id);
    await writeAudit({ actorUserId: userId, action: 'DOCUMENT_BUNDLE_RESEND', targetType: 'document_bundle_send', targetId: id, after: { merchantId } });
    refresh();
    return { ok: true, message: '새 서명 링크를 보냈습니다. 이전 링크는 더 이상 열리지 않습니다.' };
  });
}

export async function retryBundleSendAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const id = text(f, 'sendId');
    const { prisma } = await import('@/server/db');
    const own = await prisma.documentBundleSend.findFirst({ where: { id, merchantId }, select: { id: true } });
    if (!own) return { ok: false, message: '묶음 발송을 찾을 수 없습니다.' };
    const r = await continueBundleSend(id);
    await writeAudit({ actorUserId: userId, action: 'DOCUMENT_BUNDLE_RETRY', targetType: 'document_bundle_send', targetId: id, after: { merchantId, ok: r.ok } });
    refresh();
    return r.ok ? { ok: true, message: '서명 링크를 보냈습니다.' } : { ok: false, message: r.reason };
  });
}
