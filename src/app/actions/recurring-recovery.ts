'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { clientIpFrom, consumeIpRateLimit } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import {
  RecoveryError,
  cancelFromRecovery,
  changeFromRecovery,
  pauseFromRecovery,
  startRecoveryRegistration,
} from '@/server/services/recurring-recovery';
import type { DonorActionState } from '@/app/actions/donor';

/**
 * 정기후원 복구 화면(/r/recover/[토큰]) 액션 — 로그인 없이 개인 링크 토큰으로만 동작한다(2026-11-09).
 * 토큰이 가리키는 약정 1건만 바꾸며, 실제 변경은 기존 업무 함수가 한다(services/recurring-recovery.ts).
 */

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

function fail(e: unknown): DonorActionState {
  const message = (e as Error)?.message ?? '';
  if (e instanceof RecoveryError) return { ok: false, message };
  if (message && /[가-힣]/.test(message) && !/prisma|invocation/i.test(message)) return { ok: false, message };
  logger.error('정기후원 복구 화면 처리 오류', { message });
  return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
}

async function guard(): Promise<DonorActionState | null> {
  const limited = await consumeIpRateLimit('recurring-recover', 30, 600);
  return limited.ok ? null : { ok: false, message: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' };
}

function refresh() {
  revalidatePath('/r/recover/[token]', 'page');
}

export async function recoveryRegisterAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    const href = await startRecoveryRegistration(text(f, 'token'));
    return { ok: true, message: '결제수단 등록 화면으로 이동합니다. 등록을 마치면 다음 출금 때 바로 다시 출금합니다.', redirectTo: href };
  } catch (e) {
    return fail(e);
  }
}

export async function recoveryChangeAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const blocked = await guard();
  if (blocked) return blocked;
  const amountRaw = text(f, 'amount').replace(/[,\s원]/g, '');
  if (amountRaw && !/^\d{1,9}$/.test(amountRaw)) return { ok: false, message: '후원 금액을 숫자로 입력해 주세요.' };
  const dayRaw = text(f, 'dayOfMonth');
  const h = await headers();
  try {
    const sentence = await changeFromRecovery(
      text(f, 'token'),
      { dayOfMonth: dayRaw ? Number(dayRaw) : undefined, amount: amountRaw ? BigInt(amountRaw) : undefined },
      { ip: clientIpFrom((n) => h.get(n)) ?? undefined, userAgent: h.get('user-agent') ?? undefined },
    );
    refresh();
    return { ok: true, message: sentence };
  } catch (e) {
    return fail(e);
  }
}

export async function recoveryPauseAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    const sentence = await pauseFromRecovery(text(f, 'token'), text(f, 'resumeOn'));
    refresh();
    return { ok: true, message: sentence };
  } catch (e) {
    return fail(e);
  }
}

export async function recoveryCancelAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    const sentence = await cancelFromRecovery(text(f, 'token'), text(f, 'reason') || undefined);
    refresh();
    return { ok: true, message: sentence };
  } catch (e) {
    return fail(e);
  }
}
