'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { AiDraftError, draftThanksMessage } from '@/server/services/ai-drafts';
import { CampaignCodeTakenError } from '@/server/services/fundraising';
import {
  AFTER_END_LABEL,
  CampaignSetupError,
  applyCampaignChange,
  campaignChangeImpact,
  campaignPlanFromForm,
  createCampaignFromPlan,
  isAfterEndPolicy,
  previewCampaignPlan,
  type CampaignChange,
} from '@/server/services/campaign-setup';
import { thanksDraftViolation } from '@/server/services/ai-drafts';
import type { AiDraftState } from '@/app/actions/ai-drafts';
import type { StudioActionState } from '@/app/actions/studio';

/**
 * 캠페인 개설 마법사 · 변경 영향 미리보기 (2026-11-12 4차 I1). 콘텐츠는 만들어도 검토 대기 — 게시는 담당자 승인 뒤.
 */

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const checked = (f: FormData, k: string) => f.get(k) != null;

function friendly(e: unknown): string {
  const message = (e as Error)?.message ?? '';
  if (e instanceof CampaignSetupError || e instanceof CampaignCodeTakenError) return message;
  logger.error('캠페인 마법사 처리 오류', { message });
  return '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
}

function revalidateCampaigns(id?: string) {
  revalidatePath('/studio');
  revalidatePath('/studio/campaigns');
  if (id) revalidatePath(`/studio/campaigns/${id}`);
  revalidatePath('/studio/content');
  revalidatePath('/donate', 'layout');
}

export interface WizardPreviewView {
  keyword: { code: string; ok: boolean; message: string };
  qrNote: string;
  page: string[];
  content: { slots: Array<{ label: string; taken: boolean }>; willCreate: number; taken: number; blockers: string[] } | null;
  thanks: { ok: boolean; message: string } | null;
  resultReportDueOn: string | null;
  afterEnd: { label: string; text: string };
  problems: string[];
}

export interface WizardState {
  ok: boolean;
  message?: string;
  preview?: WizardPreviewView;
  redirectTo?: string;
}

function formInput(f: FormData) {
  return campaignPlanFromForm({
    setupKey: text(f, 'setupKey'),
    code: text(f, 'code'),
    title: text(f, 'title'),
    summary: text(f, 'summary'),
    usagePlan: text(f, 'usagePlan'),
    imageUrl: text(f, 'imageUrl'),
    goalAmount: text(f, 'goalAmount'),
    startsOn: text(f, 'startsOn'),
    endsOn: text(f, 'endsOn'),
    startNow: checked(f, 'startNow'),
    featured: checked(f, 'featured'),
    afterEndPolicy: text(f, 'afterEndPolicy'),
    includeContent: checked(f, 'includeContent'),
    weeklyCount: text(f, 'weeklyCount'),
    postHour: text(f, 'postHour'),
    includeThanks: checked(f, 'includeThanks'),
    thanksMessage: text(f, 'thanksMessage'),
    includeReport: checked(f, 'includeReport'),
    resultReportDueOn: text(f, 'resultReportDueOn'),
  });
}

export async function campaignWizardAction(_prev: WizardState, f: FormData): Promise<WizardState> {
  let merchantId: string;
  try {
    ({ merchantId } = await requireMerchant());
  } catch (e) {
    return { ok: false, message: (e as Error).message || '기관 권한이 필요합니다.' };
  }
  const parsed = formInput(f);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  try {
    if (text(f, 'intent') !== 'commit') {
      const p = await previewCampaignPlan(merchantId, parsed.input);
      return {
        ok: p.problems.length === 0,
        message: p.problems.length ? p.problems[0] : '아래 내용으로 만듭니다. 확인한 뒤 [저장] 을 눌러 주세요.',
        preview: {
          keyword: p.keyword,
          qrNote: p.qr.note,
          page: p.page,
          content: p.content ? { ...p.content, slots: p.content.slots.map((s) => ({ label: s.label, taken: s.taken })) } : null,
          thanks: p.thanks,
          resultReportDueOn: p.resultReportDueOn,
          afterEnd: { label: AFTER_END_LABEL[p.afterEnd.policy], text: p.afterEnd.text },
          problems: p.problems,
        },
      };
    }
    const r = await createCampaignFromPlan(merchantId, parsed.input);
    if (r.created) {
      await writeAudit({ action: 'CAMPAIGN_WIZARD_CREATE', targetType: 'campaign', targetId: r.campaignId, after: { slotsCreated: r.slotsCreated, slotsSkipped: r.slotsSkipped, startNow: parsed.input.startNow, afterEndPolicy: parsed.input.afterEndPolicy } }).catch(() => undefined);
    }
    revalidateCampaigns(r.campaignId);
    return {
      ok: true,
      message: r.created
        ? `캠페인을 만들었습니다.${r.slotsCreated ? ` 콘텐츠 일정 ${r.slotsCreated}건을 잡았습니다(콘텐츠는 슬롯 7일 전부터 검토 대기로 올라옵니다).` : ''}${r.slotsSkipped ? ` 이미 다른 콘텐츠가 있는 시각 ${r.slotsSkipped}건은 뺐습니다.` : ''}`
        : '이미 저장한 캠페인입니다.',
      redirectTo: `/studio/campaigns/${r.campaignId}`,
    };
  } catch (e) {
    return { ok: false, message: friendly(e) };
  }
}

/** 마법사의 감사 문구 AI 초안 — 입력칸만 채운다(저장·발송 없음). */
export async function draftCampaignThanksAction(): Promise<AiDraftState> {
  try {
    const { merchantId } = await requireMerchant();
    const d = await draftThanksMessage(merchantId);
    return { ok: true, message: '초안을 채웠습니다. 확인 후 저장해 주세요.', fields: { thanksMessage: d.message } };
  } catch (e) {
    if (e instanceof AiDraftError) return { ok: false, message: e.message };
    logger.error('감사 문구 초안 오류', { message: (e as Error).message });
    return { ok: false, message: 'AI 초안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

// ---------------------------------------------------------------------------
// 변경 영향 미리보기 · 반영
// ---------------------------------------------------------------------------

export interface ChangeImpactView {
  page: string[];
  keyword: string[];
  content: { upcoming: number; review: number; hold: number; holdReview: number; restore: number; add: number };
  resultReport: string;
  problems: string[];
  /** 반영할 때 보낼 판(캠페인 updatedAt) */
  version: string;
}

export interface ChangeState {
  ok: boolean;
  message?: string;
  impact?: ChangeImpactView;
  applied?: boolean;
}

function readChangeForm(f: FormData): CampaignChange {
  const goal = text(f, 'goalAmount').replace(/,/g, '');
  return {
    endsOn: text(f, 'endsOn') || null,
    goalAmount: goal ? Number(goal) : null,
    close: checked(f, 'close'),
  };
}

export async function campaignChangeAction(_prev: ChangeState, f: FormData): Promise<ChangeState> {
  let merchantId: string;
  try {
    ({ merchantId } = await requireMerchant());
  } catch (e) {
    return { ok: false, message: (e as Error).message || '기관 권한이 필요합니다.' };
  }
  const id = text(f, 'id');
  const change = readChangeForm(f);
  if (change.goalAmount != null && !Number.isFinite(change.goalAmount)) return { ok: false, message: '목표 금액을 숫자로 적어 주세요.' };
  try {
    if (text(f, 'intent') !== 'apply') {
      const impact = await campaignChangeImpact(merchantId, id, change);
      const c = await prisma.campaign.findFirstOrThrow({ where: { id, merchantId }, select: { updatedAt: true } });
      return {
        ok: impact.problems.length === 0,
        message: impact.problems[0] ?? '아래 영향을 확인한 뒤 [반영] 을 눌러 주세요.',
        impact: { page: impact.page, keyword: impact.keyword, content: impact.content, resultReport: impact.resultReport, problems: impact.problems, version: c.updatedAt.toISOString() },
      };
    }
    const { impact, added } = await applyCampaignChange(merchantId, id, change, text(f, 'version') || null);
    await writeAudit({ action: 'CAMPAIGN_CHANGE', targetType: 'campaign', targetId: id, before: { ...impact.before, goalAmount: impact.before.goalAmount.toString() }, after: { ...impact.after, goalAmount: impact.after.goalAmount.toString(), held: impact.content.hold, restored: impact.content.restore, added } }).catch(() => undefined);
    revalidateCampaigns(id);
    return { ok: true, applied: true, message: `반영했습니다.${impact.content.hold ? ` 기간 밖 콘텐츠 ${impact.content.hold}건은 보류했습니다(지우지 않음).` : ''}${impact.content.restore ? ` 보류를 푼 콘텐츠 ${impact.content.restore}건.` : ''}${added ? ` 콘텐츠 일정 ${added}건을 더했습니다.` : ''}` };
  } catch (e) {
    return { ok: false, message: friendly(e) };
  }
}

/** 종료 후 처리 방침·감사 문구·결과 보고 예정일 바꾸기 */
export async function saveCampaignFollowupAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  let merchantId: string;
  try {
    ({ merchantId } = await requireMerchant());
  } catch (e) {
    return { ok: false, message: (e as Error).message || '기관 권한이 필요합니다.' };
  }
  const id = text(f, 'id');
  const policy = text(f, 'afterEndPolicy');
  if (!isAfterEndPolicy(policy)) return { ok: false, message: '종료 후 처리 방침을 골라 주세요.' };
  const thanks = text(f, 'thanksMessage');
  if (thanks) {
    const bad = thanksDraftViolation(thanks);
    if (bad) return { ok: false, message: `감사 문구: ${bad}` };
  }
  const due = text(f, 'resultReportDueOn');
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, message: '결과 보고 예정일을 확인해 주세요.' };
  const c = await prisma.campaign.findFirst({ where: { id, merchantId }, select: { id: true, endsOn: true, afterEndPolicy: true } });
  if (!c) return { ok: false, message: '캠페인을 찾을 수 없습니다.' };
  if (due && due < c.endsOn.toISOString().slice(0, 10)) return { ok: false, message: '결과 보고 예정일은 종료일 이후로 정해 주세요.' };
  await prisma.campaign.update({ where: { id }, data: { afterEndPolicy: policy, thanksMessage: thanks || null, resultReportDueOn: due ? new Date(`${due}T00:00:00Z`) : null } });
  if (c.afterEndPolicy !== policy) await writeAudit({ action: 'CAMPAIGN_AFTER_END_POLICY', targetType: 'campaign', targetId: id, before: { policy: c.afterEndPolicy }, after: { policy } }).catch(() => undefined);
  revalidateCampaigns(id);
  return { ok: true, message: '저장했습니다.' };
}
