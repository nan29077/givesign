'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin, requireMerchant } from '@/server/auth';
import { logger } from '@/lib/logger';
import {
  AiDraftError,
  contentInsight,
  draftCampaign,
  draftInquiryReply,
  draftThanksMessage,
  INQUIRY_AI_CATEGORY_LABEL,
} from '@/server/services/ai-drafts';

/**
 * AI 초안 액션. 어느 것도 저장·발송하지 않는다 — 돌려준 값은 화면 입력칸에 채워지고,
 * 담당자가 확인·수정한 뒤 원래 저장(발송) 버튼을 눌러야 반영된다.
 */

export interface AiDraftState {
  ok: boolean;
  message?: string;
  /** 입력칸 이름 → 초안 값 */
  fields?: Record<string, string>;
}

async function guard(fn: () => Promise<AiDraftState>): Promise<AiDraftState> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AiDraftError) return { ok: false, message: e.message };
    logger.error('AI 초안 처리 오류', { message: (e as Error).message });
    return { ok: false, message: (e as Error).message?.includes('권한') ? (e as Error).message : 'AI 초안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

export async function draftCampaignAction(input: Record<string, string>): Promise<AiDraftState> {
  return guard(async () => {
    const { merchantId } = await requireMerchant();
    const d = await draftCampaign(merchantId, { title: typeof input?.title === 'string' ? input.title : undefined });
    return { ok: true, message: '초안을 채웠습니다. 사실과 맞는지 확인하고 고친 뒤 저장해 주세요.', fields: { title: d.title, summary: d.summary, story: d.story, usagePlan: d.usagePlan } };
  });
}

export async function draftThanksAction(): Promise<AiDraftState> {
  return guard(async () => {
    const { merchantId } = await requireMerchant();
    const d = await draftThanksMessage(merchantId);
    return { ok: true, message: '초안을 채웠습니다. 확인 후 저장해 주세요.', fields: { thanksMtMessage: d.message } };
  });
}

export async function draftInquiryReplyAction(input: Record<string, string>): Promise<AiDraftState> {
  return guard(async () => {
    const admin = await requireAdmin();
    if (admin.adminPermission !== 'SUPER_ADMIN') throw new AiDraftError('1:1 문의 관리는 최고관리자 권한에서만 가능합니다.');
    const d = await draftInquiryReply(String(input?.inquiryId ?? ''), admin.id);
    return { ok: true, message: `AI 분류: ${INQUIRY_AI_CATEGORY_LABEL[d.category]} — 답변 초안을 채웠습니다. 고친 뒤 등록해 주세요.`, fields: { body: d.reply } };
  });
}

export async function contentInsightAction(): Promise<AiDraftState> {
  return guard(async () => {
    const { merchantId } = await requireMerchant();
    const r = await contentInsight(merchantId);
    revalidatePath('/studio/content');
    return { ok: true, message: r.cached ? '오늘 만든 요약입니다(하루 1회).' : '최근 30일 성과 요약을 만들었습니다.' };
  });
}

/** 폼(ActionForm) 용 — (이전 상태, 폼 데이터) 형태 */
export async function contentInsightFormAction(_prev: AiDraftState, _f: FormData): Promise<AiDraftState> {
  void _prev;
  void _f;
  return contentInsightAction();
}
