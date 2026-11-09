'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import { LegalReportError, saveLegalSetting } from '@/server/services/legal-reports';
import { requestAnnualNotice } from '@/server/services/impact-legal-approvals';
import type { StudioActionState } from '@/app/actions/studio';

/** 법정 서류(/studio/reports/legal) 액션 — 2026-11-09 3차 H2. 권한: 기관 콘솔 계정. 설정 변경·통보 요청은 감사로그. */

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
    if (e instanceof LegalReportError) return { ok: false, message: e.message };
    logger.error('법정 서류 처리 오류', { message: (e as Error).message });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

export async function saveLegalSettingAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const start = Number(f.get('seasonStartMonth'));
    const end = Number(f.get('seasonEndMonth'));
    await saveLegalSetting(merchantId, userId, start, end);
    await writeAudit({ actorUserId: userId, action: 'LEGAL_SETTING_CHANGE', targetType: 'legal_report_setting', targetId: merchantId, after: { start, end } });
    revalidatePath('/studio/reports/legal');
    revalidatePath('/studio/inbox');
    return { ok: true, message: `결산 시기를 ${start}월~${end}월로 저장했습니다.` };
  });
}

export async function requestAnnualNoticeAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return run(async (merchantId, userId) => {
    const year = Number(f.get('year'));
    const r = await requestAnnualNotice(merchantId, year);
    await writeAudit({ actorUserId: userId, action: 'ANNUAL_NOTICE_REQUEST', targetType: 'merchant', targetId: merchantId, after: { year, approvalId: r.approvalId, targetCount: r.targetCount } });
    revalidatePath('/studio/reports/legal');
    revalidatePath('/studio/inbox');
    return { ok: true, message: `승인 대기함에 올렸습니다(대상 ${r.targetCount}명). 표본을 확인하고 승인하면 보냅니다.`, redirectTo: `/studio/inbox/approvals/${r.approvalId}` };
  });
}
