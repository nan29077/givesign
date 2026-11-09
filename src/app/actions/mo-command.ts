'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { consumeRateLimit } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import { decrypt } from '@/lib/crypto';
import { prisma } from '@/server/db';
import { resolveReplyLink, replyLinkPayer } from '@/server/services/mo-commands';
import { bindReplyLinkCookie, replyLinkBound } from '@/server/services/mo-link-cookie';
import { StepUpError, confirmStepUp, hasStepUp, requestStepUp } from '@/server/services/self-service-stepup';
import { InquiryAutoError, submitMerchantInquiry } from '@/server/services/inquiry-auto';
import { INQUIRY_GUEST_COOKIE } from '@/server/services/inquiry';

/**
 * 문자 명령 링크(/mo/[토큰]) 액션 (2026-11-12 4차 K3).
 * 본인 확인은 2차 F 재확인 기구(대상 SMS_LINK — 링크를 받은 번호로만 인증번호 발송)를 그대로 쓰고,
 * 확인을 마친 브라우저에 짧은 표시 쿠키(10분)를 둔다.
 */

export interface MoCommandState {
  ok: boolean;
  message?: string;
  codeSent?: boolean;
  devCode?: string;
  verified?: boolean;
  done?: boolean;
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

const EXPIRED = '링크 유효 시간이 지났습니다. 기관 번호로 문자를 다시 보내 주세요.';

async function commandLink(token: string) {
  const r = await resolveReplyLink(token);
  if (!r.ok || r.link.kind === 'INTENT') return null;
  return r.link;
}

export async function moStepUpRequestAction(_prev: MoCommandState, f: FormData): Promise<MoCommandState> {
  const link = await commandLink(text(f, 'token'));
  if (!link) return { ok: false, message: EXPIRED };
  try {
    const sent = await requestStepUp({ kind: 'SMS_LINK', linkId: link.id });
    return { ok: true, codeSent: true, devCode: sent.devCode, message: `${sent.phoneMasked} 번호로 인증번호를 보냈습니다.` };
  } catch (e) {
    if (e instanceof StepUpError) return { ok: false, message: e.message };
    logger.error('문자 명령 링크 인증번호 발송 오류', { message: (e as Error).message });
    return { ok: false, message: '인증번호를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

export async function moStepUpConfirmAction(_prev: MoCommandState, f: FormData): Promise<MoCommandState> {
  const token = text(f, 'token');
  const link = await commandLink(token);
  if (!link) return { ok: false, message: EXPIRED };
  try {
    await confirmStepUp({ kind: 'SMS_LINK', linkId: link.id }, text(f, 'otp'));
    await bindReplyLinkCookie(link.id);
    revalidatePath(`/mo/${token}`);
    return { ok: true, verified: true, message: '본인 확인이 끝났습니다.' };
  } catch (e) {
    if (e instanceof StepUpError) return { ok: false, codeSent: true, message: e.message };
    logger.error('문자 명령 링크 인증 확인 오류', { message: (e as Error).message });
    return { ok: false, codeSent: true, message: '확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

/** 문의 남기기(INQUIRY 링크). 본인 확인을 마친 브라우저에서만. */
export async function moInquirySubmitAction(_prev: MoCommandState, f: FormData): Promise<MoCommandState> {
  const token = text(f, 'token');
  const link = await commandLink(token);
  if (!link || link.kind !== 'INQUIRY' || !link.merchantId) return { ok: false, message: EXPIRED };
  if (!(await replyLinkBound(link.id)) || !(await hasStepUp({ kind: 'SMS_LINK', linkId: link.id }))) {
    return { ok: false, message: '본인 확인을 다시 해 주세요.' };
  }
  const limited = await consumeRateLimit('mo-inquiry', link.id, 5, 600);
  if (!limited.ok) return { ok: false, message: '문의를 너무 자주 보내고 있습니다. 잠시 후 다시 시도해 주세요.' };
  const payer = await replyLinkPayer(link);
  const row = payer ? await prisma.payerProfile.findUnique({ where: { id: payer.id }, select: { phoneEnc: true } }) : null;
  if (!payer || !row?.phoneEnc) return { ok: false, message: '후원자 정보를 찾을 수 없습니다.' };
  try {
    const r = await submitMerchantInquiry({ merchantId: link.merchantId, payerId: payer.id, phone: decrypt(row.phoneEnc), body: text(f, 'body') });
    (await cookies()).set(INQUIRY_GUEST_COOKIE, r.guestToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.APP_BASE_URL?.startsWith('https') ?? false,
      maxAge: 60 * 60 * 24 * 365,
      path: '/',
    });
    revalidatePath(`/mo/${token}`);
    return { ok: true, done: true, message: '문의를 접수했습니다. 답변은 이 번호로 문자로 알려 드립니다.' };
  } catch (e) {
    if (e instanceof InquiryAutoError) return { ok: false, message: e.message };
    logger.error('문자 명령 링크 문의 접수 오류', { message: (e as Error).message });
    return { ok: false, message: '접수하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
