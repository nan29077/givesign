'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/server/auth';
import { clientIpFrom, consumeIpRateLimit, consumeRateLimit } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import { findDonationOrg, getDonorMember } from '@/server/services/donor-members';
import {
  SelfServiceError,
  applyRecurringChange,
  memberScope,
  myScope,
  previewRecurringChange,
  startSelfServiceRegistration,
  stepUpSubjectOf,
  type SelfServiceScope,
} from '@/server/services/donor-self-service';
import { StepUpError, StepUpRequiredError, assertStepUp, confirmStepUp, requestStepUp } from '@/server/services/self-service-stepup';
import type { RecurringAfter } from '@/server/services/recurring-change-text';
import { setNoticeOptOut, setPreferredChannel } from '@/server/services/donor-preferences';
import { setDonorMemberMarketing, setMarketingConsent } from '@/server/services/marketing-consent';
import { rotateReceiptToken, upsertReceiptProfile } from '@/server/services/receipts';
import { prisma } from '@/server/db';

/**
 * 후원자 셀프서비스 액션 (2026-11-09 2차 F). 통합 후원자(/my)와 기관 후원 회원(/donate/[코드]/my)이 함께 쓴다.
 * 폼에 `code` 가 있으면 그 기관 후원 회원 범위, 없으면 통합 후원자 범위로 본다(services/donor-self-service.ts).
 * 정기후원 변경·정지·재개·해지는 휴대폰 재확인(10분) 뒤에만 받는다.
 */

export interface SelfServiceState {
  ok: boolean;
  message?: string;
  redirectTo?: string;
  /** 재확인이 필요해 거절됨 */
  needStepUp?: boolean;
  codeSent?: boolean;
  devCode?: string;
  phoneMasked?: string;
  verified?: boolean;
  preview?: { allowed: boolean; text: string; lines: string[] };
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

async function meta() {
  const h = await headers();
  return { ip: clientIpFrom((n) => h.get(n)) ?? undefined, userAgent: h.get('user-agent') ?? undefined };
}

type Resolved = { ok: true; scope: SelfServiceScope; paths: string[] } | { ok: false; state: SelfServiceState };

async function resolveScope(f: FormData): Promise<Resolved> {
  const code = text(f, 'code');
  if (code) {
    const org = await findDonationOrg(code);
    const member = org ? await getDonorMember(org) : null;
    if (!org || !member) return { ok: false, state: { ok: false, message: '로그인이 필요합니다.' } };
    const scope = await memberScope(member);
    if (!scope) return { ok: false, state: { ok: false, message: '휴대폰 번호를 먼저 인증해 주세요. 인증한 번호의 후원만 관리할 수 있습니다.' } };
    return { ok: true, scope, paths: [`/donate/${org.code}/my`, `/donate/${org.code}/my/recurring`, `/donate/${org.code}/my/settings`, `/donate/${org.code}/my/receipts`] };
  }
  const user = await getSessionUser();
  if (!user) return { ok: false, state: { ok: false, message: '로그인이 필요합니다.' } };
  const scope = await myScope(user.id);
  if (!scope) return { ok: false, state: { ok: false, message: '휴대폰 번호가 연결된 후원자 정보가 없습니다. 내 정보에서 휴대폰 번호를 먼저 연결해 주세요.' } };
  return { ok: true, scope, paths: ['/my/recurring', '/my/notifications', '/my/agreements'] };
}

function refresh(paths: string[]) {
  for (const p of paths) revalidatePath(p);
}

function fail(e: unknown): SelfServiceState {
  if (e instanceof StepUpRequiredError) return { ok: false, needStepUp: true, message: e.message };
  if (e instanceof StepUpError || e instanceof SelfServiceError) return { ok: false, message: e.message };
  const message = (e as Error)?.message ?? '';
  if (message && /[가-힣]/.test(message) && !/prisma|invocation/i.test(message)) return { ok: false, message };
  logger.error('후원자 셀프서비스 처리 오류', { message });
  return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
}

// ---------------------------------------------------------------- 본인 재확인

export async function stepUpRequestAction(_prev: SelfServiceState, f: FormData): Promise<SelfServiceState> {
  const r = await resolveScope(f);
  if (!r.ok) return r.state;
  try {
    const sent = await requestStepUp(stepUpSubjectOf(r.scope));
    return { ok: true, codeSent: true, phoneMasked: sent.phoneMasked, devCode: sent.devCode, message: `${sent.phoneMasked} 번호로 인증번호를 보냈습니다.` };
  } catch (e) {
    return fail(e);
  }
}

export async function stepUpConfirmAction(_prev: SelfServiceState, f: FormData): Promise<SelfServiceState> {
  const r = await resolveScope(f);
  if (!r.ok) return r.state;
  try {
    await confirmStepUp(stepUpSubjectOf(r.scope), text(f, 'otp'));
    refresh(r.paths);
    return { ok: true, verified: true, message: '본인 확인이 끝났습니다. 10분 동안 정기후원을 바꿀 수 있습니다.' };
  } catch (e) {
    return { ...fail(e), codeSent: true };
  }
}

// ---------------------------------------------------------------- 정기후원

function parseAfter(f: FormData): RecurringAfter | string {
  const action = text(f, 'action');
  if (action === 'CHANGE') {
    const amountRaw = text(f, 'amount').replace(/[,\s원]/g, '');
    if (amountRaw && !/^\d{1,9}$/.test(amountRaw)) return '후원 금액을 숫자로 입력해 주세요.';
    const dayRaw = text(f, 'dayOfMonth');
    if (dayRaw && !/^\d{1,2}$/.test(dayRaw)) return '출금일을 확인해 주세요.';
    return { action: 'CHANGE', amount: amountRaw ? BigInt(amountRaw) : undefined, dayOfMonth: dayRaw ? Number(dayRaw) : undefined };
  }
  if (action === 'PAUSE_UNTIL') return { action: 'PAUSE_UNTIL', resumeOn: text(f, 'resumeOn') };
  if (action === 'PAUSE' || action === 'RESUME' || action === 'CANCEL') return { action };
  return '알 수 없는 요청입니다.';
}

/** 저장 전 미리보기(바꾸지 않는다) */
export async function recurringPreviewAction(_prev: SelfServiceState, f: FormData): Promise<SelfServiceState> {
  const limited = await consumeIpRateLimit('selfsvc-preview', 120, 600);
  if (!limited.ok) return { ok: false, message: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' };
  const r = await resolveScope(f);
  if (!r.ok) return r.state;
  const after = parseAfter(f);
  if (typeof after === 'string') return { ok: false, message: after };
  try {
    const d = await previewRecurringChange(r.scope, text(f, 'id'), after);
    return { ok: true, preview: { allowed: d.allowed, text: d.text, lines: d.lines } };
  } catch (e) {
    return fail(e);
  }
}

export async function recurringApplyAction(_prev: SelfServiceState, f: FormData): Promise<SelfServiceState> {
  const r = await resolveScope(f);
  if (!r.ok) return r.state;
  const after = parseAfter(f);
  if (typeof after === 'string') return { ok: false, message: after };
  const by = r.scope.via === 'MY' ? r.scope.userId : r.scope.memberId;
  const limited = await consumeRateLimit('selfsvc-apply', by, 30, 600);
  if (!limited.ok) return { ok: false, message: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' };
  try {
    const res = await applyRecurringChange(r.scope, text(f, 'id'), after, { ...(await meta()), reason: text(f, 'reason') });
    refresh(r.paths);
    return { ok: true, message: res.message };
  } catch (e) {
    return fail(e);
  }
}

export async function recurringRegisterAction(_prev: SelfServiceState, f: FormData): Promise<SelfServiceState> {
  const r = await resolveScope(f);
  if (!r.ok) return r.state;
  try {
    const href = await startSelfServiceRegistration(r.scope, text(f, 'id'));
    return { ok: true, message: '결제수단 등록 화면으로 이동합니다.', redirectTo: href };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------- 알림 설정

export async function preferredChannelAction(_prev: SelfServiceState, f: FormData): Promise<SelfServiceState> {
  const r = await resolveScope(f);
  if (!r.ok) return r.state;
  try {
    const res = await setPreferredChannel(r.scope.payerId, text(f, 'channel'));
    refresh(r.paths);
    return { ok: true, message: res.value === 'SMS' ? '앞으로 안내를 문자로만 보내 드립니다.' : '앞으로 안내를 카카오 알림톡으로 먼저 보내 드립니다.' };
  } catch (e) {
    return fail(e);
  }
}

/** 기관 범위 확인: 회원 화면이면 그 기관만 */
function merchantAllowed(scope: SelfServiceScope, merchantId: string) {
  return scope.via === 'MY' || scope.merchantId === merchantId;
}

export async function noticeOptOutAction(_prev: SelfServiceState, f: FormData): Promise<SelfServiceState> {
  const r = await resolveScope(f);
  if (!r.ok) return r.state;
  const merchantId = r.scope.via === 'MEMBER' ? r.scope.merchantId : text(f, 'merchantId');
  if (!merchantAllowed(r.scope, merchantId)) return { ok: false, message: '이 화면에서 바꿀 수 없는 기관입니다.' };
  const optOut = text(f, 'optOut') === '1';
  const ok = await setNoticeOptOut(r.scope.payerId, merchantId, optOut);
  if (!ok) return { ok: false, message: '후원한 기관이 아닙니다.' };
  refresh(r.paths);
  return { ok: true, message: optOut ? '이 기관의 월간 후원 안내를 받지 않습니다.' : '월간 후원 안내를 다시 받습니다.' };
}

export async function marketingConsentAction(_prev: SelfServiceState, f: FormData): Promise<SelfServiceState> {
  const r = await resolveScope(f);
  if (!r.ok) return r.state;
  const agree = text(f, 'agree') === '1';
  const m = await meta();
  try {
    if (r.scope.via === 'MEMBER') {
      // 회원 행의 값과 후원자 동의를 함께 바꾸는 1차 함수 그대로
      await setDonorMemberMarketing(r.scope.memberId, agree, { ip: m.ip ?? null, userAgent: m.userAgent ?? null });
    } else {
      const merchantId = text(f, 'merchantId');
      const link = await prisma.payerMerchantLink.findUnique({ where: { payerId_merchantId: { payerId: r.scope.payerId, merchantId } }, select: { id: true } });
      if (!link) return { ok: false, message: '후원·봉사로 이어진 기관이 아닙니다.' };
      await setMarketingConsent({ payerId: r.scope.payerId, merchantId, agree, source: 'MY', ip: m.ip ?? null, userAgent: m.userAgent ?? null });
    }
  } catch (e) {
    return fail(e);
  }
  refresh(r.paths);
  return { ok: true, message: agree ? '소식·후원 안내 수신에 동의했습니다.' : '소식·후원 안내 수신 동의를 철회했습니다.' };
}

// ---------------------------------------------------------------- 영수증(기관 후원 회원 화면)

/**
 * 기관 후원 회원 화면의 영수증 정보 저장. 영수증 정보는 후원자 단위(모든 기관 공통)라
 * 회원 화면에서는 휴대폰 재확인 뒤에만 받는다(통합 마이페이지 /my/receipts 는 기존 규칙 그대로).
 */
export async function memberReceiptSaveAction(_prev: SelfServiceState, f: FormData): Promise<SelfServiceState> {
  const r = await resolveScope(f);
  if (!r.ok) return r.state;
  if (r.scope.via !== 'MEMBER') return { ok: false, message: '잘못된 요청입니다.' };
  if (!f.get('agree')) return { ok: false, message: '기부금영수증 발급을 위한 개인정보 수집·이용 동의에 체크해 주세요.' };
  const m = await meta();
  const [byIp, byMember] = await Promise.all([
    consumeRateLimit('receipt-profile:ip', m.ip ?? null, 20, 3600, { failClosed: true }),
    consumeRateLimit('receipt-profile:member', r.scope.memberId, 10, 3600, { failClosed: true }),
  ]);
  if (!byIp.ok || !byMember.ok) return { ok: false, message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' };
  try {
    await assertStepUp(stepUpSubjectOf(r.scope));
    const res = await upsertReceiptProfile(r.scope.payerId, {
      legalName: text(f, 'legalName'),
      residentNo: `${text(f, 'residentFront')}${text(f, 'residentBack')}`,
      address: text(f, 'address'),
      hometaxOptIn: Boolean(f.get('hometaxOptIn')),
      ...m,
    });
    if (!res.ok) return { ok: false, message: res.message };
    refresh(r.paths);
    return { ok: true, message: '기부금영수증 정보를 저장했습니다.' };
  } catch (e) {
    return fail(e);
  }
}

/** 기관 후원 회원 화면: 그 기관이 발급한 영수증만 연다 */
export async function memberReceiptOpenAction(_prev: SelfServiceState, f: FormData): Promise<SelfServiceState> {
  const r = await resolveScope(f);
  if (!r.ok) return r.state;
  if (r.scope.via !== 'MEMBER') return { ok: false, message: '잘못된 요청입니다.' };
  const receiptId = text(f, 'receiptId');
  const own = await prisma.donationReceipt.findFirst({ where: { id: receiptId, payerId: r.scope.payerId, merchantId: r.scope.merchantId }, select: { id: true } });
  if (!own) return { ok: false, message: '영수증을 찾을 수 없습니다.' };
  try {
    const token = await rotateReceiptToken(own.id, r.scope.payerId);
    return { ok: true, message: '영수증을 엽니다.', redirectTo: `/receipt/${token}` };
  } catch (e) {
    return fail(e);
  }
}
