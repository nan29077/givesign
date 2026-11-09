'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import type { StudioActionState } from '@/app/actions/studio';
import { AUTO_ANSWER_CATEGORIES, InquiryAutoError, closeAsMerchant, replyAsMerchant, saveInquiryAutoSetting } from '@/server/services/inquiry-auto';
import { AiDraftError, draftInquiryReply } from '@/server/services/ai-drafts';
import { prisma } from '@/server/db';

/**
 * 기관 문의 응대 (2026-11-12 4차 K4). 기관 콘솔 /studio/inquiries.
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
    if (e instanceof InquiryAutoError) return { ok: false, message: e.message };
    logger.error('기관 문의 응대 처리 오류', { message: (e as Error).message });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

export async function saveInquiryAutoSettingAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const templates: Record<string, string> = {};
    for (const c of AUTO_ANSWER_CATEGORIES) templates[c] = text(f, `template_${c}`);
    const autoCategories = AUTO_ANSWER_CATEGORIES.filter((c) => f.get(`auto_${c}`) === 'on');
    await saveInquiryAutoSetting(merchantId, { autoCategories, templates, dueBusinessDays: Number(text(f, 'dueBusinessDays') || '2') }, userId);
    await writeAudit({ actorUserId: userId, action: 'INQUIRY_AUTO_SETTING', targetType: 'MerchantProfile', targetId: merchantId, after: { autoCategories } });
    revalidatePath('/studio/inquiries');
    return { ok: true, message: autoCategories.length ? `자동 답변을 ${autoCategories.length}개 분류에 켰습니다.` : '자동 답변이 모두 꺼져 있습니다. 모든 문의를 담당자가 답합니다.' };
  });
}

export async function replyInquiryAsMerchantAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const inquiryId = text(f, 'inquiryId');
    await replyAsMerchant({ merchantId, inquiryId, body: text(f, 'body'), userId });
    await writeAudit({ actorUserId: userId, action: 'INQUIRY_MERCHANT_REPLY', targetType: 'SupportInquiry', targetId: inquiryId, after: { bodyLength: text(f, 'body').length } });
    revalidatePath('/studio/inquiries');
    revalidatePath(`/studio/inquiries/${inquiryId}`);
    return { ok: true, message: '답변을 보냈습니다. 후원자에게 문자로 알렸습니다.' };
  });
}

export async function closeInquiryAsMerchantAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId) => {
    const inquiryId = text(f, 'inquiryId');
    await closeAsMerchant(merchantId, inquiryId);
    revalidatePath('/studio/inquiries');
    revalidatePath(`/studio/inquiries/${inquiryId}`);
    return { ok: true, message: '문의를 닫았습니다. 후원자가 다시 쓰면 다시 열립니다.' };
  });
}

export interface InquiryDraftState {
  ok: boolean;
  message?: string;
  reply?: string;
}

/** AI 답변 초안 — 입력칸을 채우기만 한다(저장·발송하지 않음). 기존 draftInquiryReply 규칙(가리기·속도 제한) 그대로. */
export async function inquiryDraftAction(_prev: InquiryDraftState, f: FormData): Promise<InquiryDraftState> {
  let merchantId: string;
  try {
    merchantId = (await requireMerchant()).merchantId;
  } catch {
    return { ok: false, message: '기관 권한이 필요합니다.' };
  }
  const inquiryId = text(f, 'inquiryId');
  const owned = await prisma.supportInquiry.findFirst({ where: { id: inquiryId, merchantId, handledBy: 'MERCHANT' }, select: { id: true } });
  if (!owned) return { ok: false, message: '문의를 찾을 수 없습니다.' };
  try {
    const d = await draftInquiryReply(inquiryId, `merchant-${merchantId}`);
    return { ok: true, reply: d.reply, message: 'AI 초안을 넣었습니다. 확인하고 고친 뒤 보내 주세요.' };
  } catch (e) {
    if (e instanceof AiDraftError) return { ok: false, message: e.message };
    logger.error('문의 AI 초안 오류', { message: (e as Error).message });
    return { ok: false, message: 'AI 초안을 만들지 못했습니다.' };
  }
}
