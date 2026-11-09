'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import type { StudioActionState } from '@/app/actions/studio';
import { resendUnknownAsSms, UnknownResendError } from '@/server/services/outbound/unknown-resend';

/**
 * 기관 콘솔 — 통합 발송 관리(2026-11-09 D).
 * 알림톡 결과 미확인(UNKNOWN) 건을 담당자가 문자로 한 번 다시 보낸다(자동 재발송 없음). 대상은 세션 기관 소유인지 서비스가 다시 본다.
 */
export async function resendUnknownAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  let merchantId: string;
  try {
    merchantId = (await requireMerchant()).merchantId;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '기관 권한이 필요합니다.' };
  }
  const id = String(f.get('id') ?? '');
  try {
    const r = await resendUnknownAsSms(merchantId, id);
    await writeAudit({ action: 'MT_UNKNOWN_MANUAL_RESEND', targetType: 'mt_outbound_message', targetId: id, after: { newId: r.newId, ok: r.ok } }).catch(() => undefined);
    revalidatePath('/studio/journeys');
    return r.ok ? { ok: true, message: '문자로 다시 보냈습니다.' } : { ok: false, message: '문자 발송에 실패했습니다. 다시 보내기는 한 번만 할 수 있어 관리자에게 문의해 주세요.' };
  } catch (e) {
    if (e instanceof UnknownResendError) return { ok: false, message: e.message };
    logger.error('결과 미확인 건 문자 재발송 오류', { message: (e as Error).message });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
