'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { clientIpFrom } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import { normalizeMerchantCode } from '@/lib/id';
import { currentAttribution } from '@/server/attribution';
import { applyVolunteer, withdrawVolunteer, VolunteerError } from '@/server/services/volunteers';
import { completeESign } from '@/server/services/agreements';
import { mockESignPageAllowed } from '@/server/adapters/esign';
import type { DonorActionState } from '@/app/actions/donor';

/**
 * 후원자(마이페이지) — 자원봉사 신청 · 철회 · 월간 안내 수신 설정.
 */

async function currentPayer() {
  const user = await getSessionUser();
  if (!user) return null;
  const payer = await prisma.payerProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
  return payer ? { user, payerId: payer.id } : null;
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

const NO_PAYER = '휴대폰 번호가 연결된 후원자 정보가 없습니다. 내 정보에서 휴대폰 번호를 먼저 연결해 주세요.';

export async function applyVolunteerAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };
  const merchant = await prisma.merchantProfile.findFirst({ where: { code: normalizeMerchantCode(text(f, 'merchantCode')), status: 'APPROVED' }, select: { id: true } });
  if (!merchant) return { ok: false, message: '신청할 기관을 찾을 수 없습니다.' };
  const h = await headers();
  const attribution = await currentAttribution();
  try {
    await applyVolunteer({
      payerId: ctx.payerId,
      merchantId: merchant.id,
      interests: f.getAll('interests').map(String),
      availableDays: f.getAll('days').map(String),
      timeSlot: text(f, 'timeSlot') || null,
      experience: text(f, 'experience'),
      emergencyName: text(f, 'emergencyName'),
      emergencyPhone: text(f, 'emergencyPhone'),
      wish: text(f, 'wish'),
      message: text(f, 'message'),
      safetyPledge: Boolean(f.get('safetyPledge')),
      agree: Boolean(f.get('agree')),
      source: attribution?.source ?? 'WEB',
      contentItemId: attribution?.contentItemId ?? null,
      meta: { ip: clientIpFrom((n) => h.get(n)) ?? undefined, userAgent: h.get('user-agent') ?? undefined },
    });
    revalidatePath('/my/volunteer');
    return { ok: true, message: '자원봉사 신청이 접수되었습니다. 기관이 확인한 뒤 일정을 안내해 드립니다.', redirectTo: '/my/volunteer' };
  } catch (e) {
    if (e instanceof VolunteerError) return { ok: false, message: e.message };
    logger.error('자원봉사 신청 실패', { message: (e as Error).message });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

export async function withdrawVolunteerAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };
  try {
    await withdrawVolunteer(ctx.payerId, text(f, 'id'));
    revalidatePath('/my/volunteer');
    return { ok: true, message: '신청을 철회했습니다.' };
  } catch (e) {
    return { ok: false, message: e instanceof VolunteerError ? e.message : '처리하지 못했습니다.' };
  }
}

/** 기관별 월간 후원 안내 수신 거부/재개. 결제·영수증 안내는 계속 나간다. */
export async function toggleNoticeOptOutAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };
  const merchantId = text(f, 'merchantId');
  const optOut = text(f, 'optOut') === '1';
  const r = await prisma.payerMerchantLink.updateMany({ where: { payerId: ctx.payerId, merchantId }, data: { noticeOptOutAt: optOut ? new Date() : null } });
  if (r.count === 0) return { ok: false, message: '후원한 기관이 아닙니다.' };
  revalidatePath('/my/agreements');
  return { ok: true, message: optOut ? '이 기관의 월간 안내를 받지 않습니다.' : '월간 안내를 다시 받습니다.' };
}

/** 로컬 모의 전자서명 화면 전용. 실연동에서는 공급자 콜백이 결과를 넣는다. */
export async function mockESignAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  if (!mockESignPageAllowed()) return { ok: false, message: '모의 서명은 로컬 환경에서만 쓸 수 있습니다.' };
  const outcome = text(f, 'outcome') === 'DECLINED' ? 'DECLINED' : 'SIGNED';
  const r = await completeESign(text(f, 'requestId'), outcome);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: outcome === 'SIGNED' ? '모의 서명을 완료했습니다. (실제 전자서명 아님)' : '서명을 거절했습니다.' };
}
