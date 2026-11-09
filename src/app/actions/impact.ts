'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import {
  ImpactError,
  addExpense,
  approveImpactUpdate,
  archiveExpense,
  archiveImpactUpdate,
  generateImpactReport,
  reopenImpactUpdate,
  restoreExpense,
  restoreImpactUpdate,
  saveImpactReportText,
  saveImpactUpdate,
  setImpactPublic,
} from '@/server/services/impact-reports';
import { requestImpactSend } from '@/server/services/impact-legal-approvals';
import { LegalReportError } from '@/server/services/legal-reports';
import { AiDraftError } from '@/server/services/ai-drafts';
import type { StudioActionState } from '@/app/actions/studio';

/**
 * 사업 진행 기록·결과 보고(/studio/impact) + 사용 명세 입력(/studio/reports/legal 공용) — 2026-11-09 3차 H.
 * 권한: 기관 콘솔 계정(requireMerchant — 기관당 계정 1개). 승인·발송 요청·공개 전환은 감사로그.
 */

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

function fail(e: unknown): StudioActionState {
  const message = (e as Error)?.message ?? '';
  if (e instanceof ImpactError || e instanceof LegalReportError || e instanceof AiDraftError) return { ok: false, message };
  logger.error('사업 진행 기록 처리 오류', { message });
  return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
}

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
    return fail(e);
  }
}

function refresh(id?: string) {
  revalidatePath('/studio/impact');
  if (id) revalidatePath(`/studio/impact/${id}`);
  revalidatePath('/studio/reports/legal');
}

function wonOf(raw: string): bigint | null {
  const v = raw.replace(/[,\s원]/g, '');
  return /^\d{1,12}$/.test(v) ? BigInt(v) : null;
}

export async function saveImpactUpdateAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const id = text(f, 'id') || undefined;
    const photos = [text(f, 'photo1'), text(f, 'photo2'), text(f, 'photo3')].filter(Boolean);
    const saved = await saveImpactUpdate(merchantId, userId, {
      campaignId: text(f, 'campaignId') || null,
      title: text(f, 'title'),
      body: text(f, 'body'),
      photos,
      photoRuleAck: f.get('photoRuleAck') === 'on',
      periodFrom: text(f, 'periodFrom') || null,
      periodTo: text(f, 'periodTo') || null,
    }, id);
    refresh(saved);
    return { ok: true, message: id ? '저장했습니다.' : '진행 기록을 만들었습니다. 집행 내역을 넣고 보고서 초안을 만들어 보세요.', redirectTo: id ? undefined : `/studio/impact/${saved}` };
  });
}

export async function addExpenseAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const amount = wonOf(text(f, 'amount'));
    if (amount === null) return { ok: false, message: '금액은 숫자로 적어 주세요.' };
    const impactUpdateId = text(f, 'impactUpdateId') || null;
    await addExpense(merchantId, userId, { impactUpdateId, campaignId: text(f, 'campaignId') || null, usedOn: text(f, 'usedOn'), description: text(f, 'description'), amount });
    refresh(impactUpdateId ?? undefined);
    return { ok: true, message: '사용 내역을 넣었습니다.' };
  });
}

export async function archiveExpenseAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId) => {
    await archiveExpense(merchantId, text(f, 'id'));
    refresh(text(f, 'impactUpdateId') || undefined);
    return { ok: true, message: '보관했습니다(되살릴 수 있습니다).' };
  });
}

export async function restoreExpenseAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId) => {
    await restoreExpense(merchantId, text(f, 'id'));
    refresh();
    return { ok: true, message: '되살렸습니다.' };
  });
}

export async function generateImpactReportAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId) => {
    const id = text(f, 'id');
    const r = await generateImpactReport(merchantId, id);
    refresh(id);
    return {
      ok: true,
      message: r.source === 'AI'
        ? 'AI 초안을 넣었습니다. 숫자는 입력한 값·원천 합계만 썼습니다. 읽어 보고 고친 뒤 승인해 주세요.'
        : r.reason
          ? `AI 초안이 규칙(숫자·권유 문구)을 지키지 못해 규칙 문안으로 넣었습니다. 읽어 보고 고친 뒤 승인해 주세요.`
          : '규칙 문안(기관이 적은 내용 + 원천 합계 + 집행 내역)으로 초안을 넣었습니다. 읽어 보고 고친 뒤 승인해 주세요.',
    };
  });
}

export async function saveImpactReportAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId) => {
    const id = text(f, 'id');
    await saveImpactReportText(merchantId, id, text(f, 'report'));
    refresh(id);
    return { ok: true, message: '보고서를 저장했습니다.' };
  });
}

export async function approveImpactAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const id = text(f, 'id');
    await approveImpactUpdate(merchantId, id, userId);
    await writeAudit({ actorUserId: userId, action: 'IMPACT_APPROVE', targetType: 'impact_update', targetId: id, after: { merchantId } });
    refresh(id);
    return { ok: true, message: '승인했습니다. 이제 공개 여부를 정하거나 참여 후원자에게 보낼 수 있습니다.' };
  });
}

export async function reopenImpactAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const id = text(f, 'id');
    await reopenImpactUpdate(merchantId, id);
    await writeAudit({ actorUserId: userId, action: 'IMPACT_REOPEN', targetType: 'impact_update', targetId: id, after: { merchantId } });
    refresh(id);
    return { ok: true, message: '다시 작성 중으로 돌렸습니다. 고친 뒤 다시 승인해 주세요.' };
  });
}

export async function setImpactPublicAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const id = text(f, 'id');
    const visible = text(f, 'visible') === '1';
    await setImpactPublic(merchantId, id, visible);
    await writeAudit({ actorUserId: userId, action: 'IMPACT_PUBLIC_CHANGE', targetType: 'impact_update', targetId: id, after: { merchantId, visible } });
    refresh(id);
    return { ok: true, message: visible ? '후원페이지 캠페인 상세에 공개합니다(승인된 기록만 보입니다).' : '공개하지 않습니다.' };
  });
}

export async function archiveImpactAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId) => {
    const id = text(f, 'id');
    await archiveImpactUpdate(merchantId, id);
    refresh(id);
    return { ok: true, message: '보관했습니다(되살릴 수 있습니다).' };
  });
}

export async function restoreImpactAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId) => {
    const id = text(f, 'id');
    await restoreImpactUpdate(merchantId, id);
    refresh(id);
    return { ok: true, message: '되살렸습니다.' };
  });
}

export async function requestImpactSendAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const id = text(f, 'id');
    const r = await requestImpactSend(merchantId, id);
    await writeAudit({ actorUserId: userId, action: 'IMPACT_SEND_REQUEST', targetType: 'impact_update', targetId: id, after: { merchantId, approvalId: r.approvalId, targetCount: r.targetCount } });
    refresh(id);
    revalidatePath('/studio/inbox');
    return { ok: true, message: `승인 대기함에 올렸습니다(대상 ${r.targetCount}명). 표본을 확인하고 승인하면 보냅니다.`, redirectTo: `/studio/inbox/approvals/${r.approvalId}` };
  });
}
