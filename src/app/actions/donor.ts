'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { clientIpFrom } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import {
  createRecurringDonation,
  setRecurringStatus,
  updateRecurringDonation,
} from '@/server/services/recurring';
import { deleteReceiptProfile, rotateReceiptToken, upsertReceiptProfile } from '@/server/services/receipts';
import { normalizeMerchantCode } from '@/lib/id';

/**
 * 후원자(마이페이지) — 정기후원 · 기부금영수증 액션.
 * 모든 대상은 로그인 계정에 연결된 payerId 소유인지 확인한 뒤에만 바꾼다.
 */

export interface DonorActionState {
  ok: boolean;
  message?: string;
  redirectTo?: string;
}

async function currentPayer() {
  const user = await getSessionUser();
  if (!user) return null;
  const payer = await prisma.payerProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
  return payer ? { user, payerId: payer.id } : null;
}

async function requestMeta() {
  const h = await headers();
  return { ip: clientIpFrom((name) => h.get(name)) ?? undefined, userAgent: h.get('user-agent') ?? undefined };
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

function fail(e: unknown): DonorActionState {
  const message = (e as Error)?.message ?? '';
  if (message && /[가-힣]/.test(message) && !/prisma|invocation/i.test(message)) return { ok: false, message };
  logger.error('후원자 액션 처리 오류', { message });
  return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
}

const NO_PAYER = '휴대폰 번호가 연결된 후원자 정보가 없습니다. 내 정보에서 휴대폰 번호를 먼저 연결해 주세요.';

// ---------------------------------------------------------------------------
// 정기후원
// ---------------------------------------------------------------------------

export async function createRecurringAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };
  const code = normalizeMerchantCode(text(f, 'merchantCode'));
  const merchant = await prisma.merchantProfile.findFirst({ where: { code, status: 'APPROVED' }, select: { id: true } });
  if (!merchant) return { ok: false, message: '후원할 기관을 찾을 수 없습니다.' };
  if (!f.get('agree')) return { ok: false, message: '정기후원 자동 출금 동의에 체크해 주세요.' };
  // 직접 입력이 있으면 그 값을, 없으면 고른 금액 버튼 값을 쓴다.
  const amountRaw = (text(f, 'amount') || text(f, 'preset')).replace(/[,\s원]/g, '');
  if (!/^\d{1,9}$/.test(amountRaw)) return { ok: false, message: '후원 금액을 숫자로 입력해 주세요.' };
  const day = Number(text(f, 'dayOfMonth'));
  const meta = await requestMeta();
  try {
    const r = await createRecurringDonation({
      payerId: ctx.payerId,
      merchantId: merchant.id,
      campaignId: text(f, 'campaignId') || null,
      amount: BigInt(amountRaw),
      dayOfMonth: day,
      message: text(f, 'message'),
      anonymous: Boolean(f.get('anonymous')),
      ...meta,
    });
    if (!r.ok) return { ok: false, message: r.message };
    revalidatePath('/my/recurring');
    return { ok: true, message: `정기후원이 등록되었습니다. 첫 출금은 ${r.firstDate} 입니다.`, redirectTo: '/my/recurring' };
  } catch (e) {
    return fail(e);
  }
}

export async function updateRecurringAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };
  const id = text(f, 'id');
  const amountRaw = text(f, 'amount').replace(/[,\s원]/g, '');
  if (!/^\d{1,9}$/.test(amountRaw)) return { ok: false, message: '후원 금액을 숫자로 입력해 주세요.' };
  try {
    await updateRecurringDonation(ctx.payerId, id, {
      amount: BigInt(amountRaw),
      dayOfMonth: Number(text(f, 'dayOfMonth')),
      message: text(f, 'message'),
      anonymous: Boolean(f.get('anonymous')),
    });
    revalidatePath('/my/recurring');
    return { ok: true, message: '정기후원 내용을 바꿨습니다.' };
  } catch (e) {
    return fail(e);
  }
}

export async function setRecurringStatusAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };
  const action = text(f, 'action') as 'PAUSE' | 'RESUME' | 'CANCEL';
  if (!['PAUSE', 'RESUME', 'CANCEL'].includes(action)) return { ok: false, message: '알 수 없는 요청입니다.' };
  try {
    await setRecurringStatus(ctx.payerId, text(f, 'id'), action, text(f, 'reason'));
    revalidatePath('/my/recurring');
    const msg = { PAUSE: '정기후원을 일시정지했습니다. 다시 시작할 때까지 출금되지 않습니다.', RESUME: '정기후원을 다시 시작했습니다.', CANCEL: '정기후원을 해지했습니다. 그동안 함께해 주셔서 감사합니다.' }[action];
    return { ok: true, message: msg };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// 기부금영수증
// ---------------------------------------------------------------------------

export async function saveReceiptProfileAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };
  if (!f.get('agree')) return { ok: false, message: '기부금영수증 발급을 위한 개인정보 수집·이용 동의에 체크해 주세요.' };
  const meta = await requestMeta();
  try {
    const r = await upsertReceiptProfile(ctx.payerId, {
      legalName: text(f, 'legalName'),
      residentNo: `${text(f, 'residentFront')}${text(f, 'residentBack')}`,
      address: text(f, 'address'),
      hometaxOptIn: Boolean(f.get('hometaxOptIn')),
      ...meta,
    });
    if (!r.ok) return { ok: false, message: r.message };
    revalidatePath('/my/receipts');
    return { ok: true, message: '기부금영수증 정보를 저장했습니다. 이제 후원한 기관이 영수증을 발급할 수 있습니다.' };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteReceiptProfileAction(_prev: DonorActionState, _f: FormData): Promise<DonorActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };
  try {
    await deleteReceiptProfile(ctx.payerId);
    revalidatePath('/my/receipts');
    return { ok: true, message: '영수증 정보를 삭제하고 동의를 철회했습니다. 이미 발급된 영수증 기록은 법정 보유 기간 동안 보관됩니다.' };
  } catch (e) {
    return fail(e);
  }
}

export async function openReceiptAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const ctx = await currentPayer();
  if (!ctx) return { ok: false, message: NO_PAYER };
  try {
    const token = await rotateReceiptToken(text(f, 'receiptId'), ctx.payerId);
    return { ok: true, message: '영수증을 엽니다.', redirectTo: `/receipt/${token}` };
  } catch (e) {
    return fail(e);
  }
}
