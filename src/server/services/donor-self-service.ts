import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { kstDateKey, kstMonthKey } from '@/lib/datetime';
import { AGREEMENT_CHANGES_PER_DAY } from './agreements';
import { issueSecureLink } from './secure-link';
import {
  pauseRecurringUntil,
  recurringAmountRange,
  setRecurringStatus,
  updateRecurringDonation,
} from './recurring';
import { describeRecurringChange, type RecurringAfter, type RecurringBefore, type RecurringChangeDescription } from './recurring-change-text';
import { recordRecurringChange, recurringChangeHistory, termsSnapshot, type RecurringChangeKind } from './recurring-change-log';
import { assertStepUp, type StepUpSubject } from './self-service-stepup';

/**
 * 후원자 셀프서비스 (2026-11-09 2차 F) — 정기후원 관리 한 화면.
 *
 * 두 화면이 같은 함수를 쓴다. 각 화면의 권한 범위(scope)를 넘지 않는다:
 *  - MY     : 통합 후원자(/my). 로그인 계정에 연결된 payer 의 모든 기관 약정.
 *  - MEMBER : 기관 후원 회원(/donate/[code]/my). 회원이 휴대폰 인증한 번호의 payer 중 **그 기관** 약정만.
 * 복구 링크(/r/recover/[토큰])는 1차 규칙대로 recurring-recovery.ts 가 맡는다(그 약정 1건, 재확인 없음).
 *
 * 바꾸는 일은 모두 기존 업무 함수(updateRecurringDonation · pauseRecurringUntil · setRecurringStatus)가 한다 —
 * 금액 범위·하루 3회(AGREEMENT_CHANGES_PER_DAY)·약정서 새 판·이벤트가 그대로 적용된다.
 * 여기서 더하는 것: 권한 범위 확인 → 휴대폰 재확인(10분) → 결과 미확인(PENDING) 중 금액·출금일 변경 보류 → 결과 문장 → 변경 이력.
 */

export class SelfServiceError extends Error {}

export type SelfServiceScope =
  | { via: 'MY'; userId: string; payerId: string }
  | { via: 'MEMBER'; memberId: string; merchantId: string; payerId: string };

export function stepUpSubjectOf(scope: SelfServiceScope): StepUpSubject {
  return scope.via === 'MY' ? { kind: 'USER', userId: scope.userId } : { kind: 'MEMBER', memberId: scope.memberId };
}

/** 통합 후원자 범위. 휴대폰이 연결된 payer 가 없으면 null. */
export async function myScope(userId: string): Promise<SelfServiceScope | null> {
  const p = await prisma.payerProfile.findUnique({ where: { userId }, select: { id: true, onboardingStatus: true } });
  if (!p || p.onboardingStatus === 'WITHDRAWN') return null;
  return { via: 'MY', userId, payerId: p.id };
}

/** 기관 후원 회원 범위. 회원이 인증한 번호의 payer 가 없으면 null. */
export async function memberScope(member: { id: string; merchantId: string }): Promise<SelfServiceScope | null> {
  const m = await prisma.donorMember.findUnique({ where: { id: member.id }, select: { phoneHash: true, phoneVerifiedAt: true, merchantId: true, status: true } });
  if (!m || m.status !== 'ACTIVE' || !m.phoneHash || !m.phoneVerifiedAt || m.merchantId !== member.merchantId) return null;
  const p = await prisma.payerProfile.findUnique({ where: { phoneHash: m.phoneHash }, select: { id: true, onboardingStatus: true } });
  if (!p || p.onboardingStatus === 'WITHDRAWN') return null;
  return { via: 'MEMBER', memberId: member.id, merchantId: m.merchantId, payerId: p.id };
}

function scopedWhere(scope: SelfServiceScope) {
  return { payerId: scope.payerId, ...(scope.via === 'MEMBER' ? { merchantId: scope.merchantId } : {}) };
}

const dateKey = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** 범위 안의 약정 1건. 다른 후원자·다른 기관(회원 화면) 약정은 없는 것으로 본다. */
async function scopedRecurring(scope: SelfServiceScope, id: string) {
  const r = await prisma.recurringDonation.findFirst({ where: { id, ...scopedWhere(scope) } });
  if (!r) throw new SelfServiceError('정기후원을 찾을 수 없습니다.');
  return r;
}

/** 문장 계산에 필요한 "바꾸기 전" 상태 */
export async function recurringBeforeOf(r: {
  id: string; status: RecurringBefore['status']; amount: bigint; dayOfMonth: number; nextChargeOn: Date; resumeOn: Date | null; recoveryState: string;
}, now = new Date()): Promise<RecurringBefore> {
  const month = kstMonthKey(now);
  const [success, pending] = await Promise.all([
    prisma.recurringRun.findFirst({ where: { recurringId: r.id, monthKey: month, status: 'SUCCESS' }, orderBy: { ranAt: 'asc' }, select: { ranAt: true } }),
    prisma.recurringRun.count({ where: { recurringId: r.id, status: 'PENDING' } }),
  ]);
  return {
    status: r.status,
    amount: r.amount,
    dayOfMonth: r.dayOfMonth,
    nextChargeOn: r.nextChargeOn.toISOString().slice(0, 10),
    resumeOn: dateKey(r.resumeOn),
    chargedThisMonthOn: success ? kstDateKey(success.ranAt) : null,
    pending: pending > 0,
    actionRequired: r.recoveryState === 'ACTION_REQUIRED',
  };
}

/** 오늘(최근 24시간) 남은 약정 조건 변경 횟수 — agreements.assertAgreementChangeAllowed 와 같은 기준 */
export async function agreementChangesLeft(recurringId: string, now = new Date()): Promise<number> {
  const n = await prisma.agreementDocument.count({
    where: { kind: 'RECURRING_PLEDGE', subjectId: recurringId, supersedesId: { not: null }, createdAt: { gte: new Date(now.getTime() - 86_400_000) } },
  });
  return Math.max(0, AGREEMENT_CHANGES_PER_DAY - n);
}

/** 저장 전 미리보기(바꾸지 않는다, 재확인 불필요) */
export async function previewRecurringChange(scope: SelfServiceScope, id: string, after: RecurringAfter, now = new Date()): Promise<RecurringChangeDescription> {
  const r = await scopedRecurring(scope, id);
  return describeRecurringChange(await recurringBeforeOf(r, now), after, now);
}

export interface ApplyMeta {
  ip?: string;
  userAgent?: string;
  reason?: string;
}

/**
 * 바꾸기. 순서: 범위 확인 → 재확인(10분) → 문장 계산(보류·불가면 거절) → 기존 업무 함수 → 이력.
 * 돌려주는 문장은 미리보기와 같은 함수로 계산한 것이다.
 */
export async function applyRecurringChange(scope: SelfServiceScope, id: string, after: RecurringAfter, meta: ApplyMeta = {}, now = new Date()): Promise<{ message: string; description: RecurringChangeDescription }> {
  const r = await scopedRecurring(scope, id);
  await assertStepUp(stepUpSubjectOf(scope));
  // 같은 약정에 동시에 들어온 변경(두 번 누름·두 화면)은 하나만 처리한다. 상태는 잡은 뒤 다시 읽는다.
  const lockKey = `selfsvc:lock:${r.id}`;
  if (!(await kv.setnx(lockKey, String(Date.now()), 30))) throw new SelfServiceError('같은 정기후원의 다른 변경을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');
  try {
    return await applyLocked(scope, await scopedRecurring(scope, id), after, meta, now);
  } finally {
    await kv.del(lockKey);
  }
}

async function applyLocked(scope: SelfServiceScope, r: Awaited<ReturnType<typeof scopedRecurring>>, after: RecurringAfter, meta: ApplyMeta, now: Date): Promise<{ message: string; description: RecurringChangeDescription }> {
  const description = describeRecurringChange(await recurringBeforeOf(r, now), after, now);
  if (!description.allowed) throw new SelfServiceError(description.text);

  let kind: RecurringChangeKind;
  let reason: string | null = null;
  switch (after.action) {
    case 'CHANGE': {
      kind = 'CHANGE';
      const patch: { amount?: bigint; dayOfMonth?: number } = {};
      if (after.amount !== undefined && after.amount !== r.amount) patch.amount = after.amount;
      if (after.dayOfMonth !== undefined && after.dayOfMonth !== r.dayOfMonth) patch.dayOfMonth = after.dayOfMonth;
      await updateRecurringDonation(r.payerId, r.id, patch, { ip: meta.ip, userAgent: meta.userAgent });
      break;
    }
    case 'PAUSE':
      kind = 'PAUSE';
      await setRecurringStatus(r.payerId, r.id, 'PAUSE');
      break;
    case 'PAUSE_UNTIL':
      kind = 'PAUSE_UNTIL';
      await pauseRecurringUntil(r.payerId, r.id, after.resumeOn, now);
      break;
    case 'RESUME':
      kind = 'RESUME';
      await setRecurringStatus(r.payerId, r.id, 'RESUME');
      break;
    case 'CANCEL':
      kind = 'CANCEL';
      reason = (meta.reason ?? '').trim().slice(0, 200) || null;
      await setRecurringStatus(r.payerId, r.id, 'CANCEL', reason ?? undefined);
      break;
  }

  const updated = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: r.id } });
  await recordRecurringChange({
    recurringId: r.id,
    merchantId: r.merchantId,
    payerId: r.payerId,
    actor: 'DONOR',
    via: scope.via,
    kind,
    before: termsSnapshot(r),
    after: termsSnapshot(updated),
    summary: description.text,
    reason,
  });
  const lead = { CHANGE: '바꿨습니다.', PAUSE: '일시정지했습니다.', PAUSE_UNTIL: '쉬어 가기로 했습니다.', RESUME: '다시 시작했습니다.', CANCEL: '해지했습니다. 그동안 함께해 주셔서 감사합니다.' }[kind];
  return { message: `${lead} ${description.text}`, description };
}

/** 결제수단 다시 등록: 기존 등록 흐름(REGISTER_ACCOUNT 보안 링크)으로 보낸다. 범위 안 약정에서만. */
export async function startSelfServiceRegistration(scope: SelfServiceScope, id: string): Promise<string> {
  const r = await scopedRecurring(scope, id);
  if (r.status === 'CANCELED') throw new SelfServiceError('해지된 정기후원입니다.');
  const payer = await prisma.payerProfile.findUniqueOrThrow({ where: { id: r.payerId }, select: { phoneHash: true, blockedAt: true } });
  if (payer.blockedAt) throw new SelfServiceError('이용이 제한된 계정입니다. 고객센터로 문의해 주세요.');
  const link = await issueSecureLink({
    purpose: 'REGISTER_ACCOUNT',
    phoneHash: payer.phoneHash,
    merchantId: r.merchantId,
    payload: { channel: scope.via === 'MY' ? 'MY_RECURRING' : 'MEMBER_RECURRING', recurringId: r.id },
  });
  return `/r/${link.token}`;
}

export interface SelfServiceRecurringItem {
  id: string;
  merchantId: string;
  merchantName: string;
  merchantCode: string;
  campaignTitle: string | null;
  status: RecurringBefore['status'];
  amount: bigint;
  dayOfMonth: number;
  nextChargeOn: string;
  resumeOn: string | null;
  pausedAt: Date | null;
  canceledAt: Date | null;
  lastFailure: string | null;
  recoveryState: string;
  totalAmount: bigint;
  successCount: number;
  createdAt: Date;
  agreementDocId: string | null;
  before: RecurringBefore;
  changesLeft: number;
  amountMin: bigint;
  amountMax: bigint;
  runs: Array<{ id: string; monthKey: string; attempt: number; status: string; reason: string | null; ranAt: Date }>;
  history: Array<{ id: string; createdAt: Date; actor: string; via: string; kind: string; summary: string; reason: string | null }>;
}

/** 화면용 목록(범위 안 약정, 진행 중 먼저) */
export async function selfServiceRecurringList(scope: SelfServiceScope, now = new Date()): Promise<{ items: SelfServiceRecurringItem[]; hasActiveToken: boolean }> {
  const [rows, token] = await Promise.all([
    prisma.recurringDonation.findMany({
      where: scopedWhere(scope),
      include: {
        merchant: { select: { displayName: true, code: true } },
        campaign: { select: { title: true } },
        runs: { orderBy: { ranAt: 'desc' }, take: 6 },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 50,
    }),
    prisma.paymentMethodToken.count({ where: { payerId: scope.payerId, status: 'ACTIVE' } }),
  ]);
  const items = await Promise.all(
    rows.map(async (r) => {
      const [before, changesLeft, range, history] = await Promise.all([
        recurringBeforeOf(r, now),
        agreementChangesLeft(r.id, now),
        r.status === 'CANCELED' ? Promise.resolve({ min: 0n, max: 0n }) : recurringAmountRange(r.merchantId, r.payerId),
        recurringChangeHistory(r.id, 20),
      ]);
      return {
        id: r.id,
        merchantId: r.merchantId,
        merchantName: r.merchant.displayName,
        merchantCode: r.merchant.code,
        campaignTitle: r.campaign?.title ?? null,
        status: r.status,
        amount: r.amount,
        dayOfMonth: r.dayOfMonth,
        nextChargeOn: r.nextChargeOn.toISOString().slice(0, 10),
        resumeOn: dateKey(r.resumeOn),
        pausedAt: r.pausedAt,
        canceledAt: r.canceledAt,
        lastFailure: r.lastFailure,
        recoveryState: r.recoveryState,
        totalAmount: r.totalAmount,
        successCount: r.successCount,
        createdAt: r.createdAt,
        agreementDocId: r.agreementDocId,
        before,
        changesLeft,
        amountMin: range.min,
        amountMax: range.max,
        runs: r.runs.map((x) => ({ id: x.id, monthKey: x.monthKey, attempt: x.attempt, status: x.status, reason: x.reason, ranAt: x.ranAt })),
        history: history.map((h) => ({ id: h.id, createdAt: h.createdAt, actor: h.actor, via: h.via, kind: h.kind, summary: h.summary, reason: h.reason })),
      } satisfies SelfServiceRecurringItem;
    }),
  );
  return { items, hasActiveToken: token > 0 };
}
