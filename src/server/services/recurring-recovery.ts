import { prisma } from '@/server/db';
import { kstDateKey, kstStartOfMonth } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { registerConsumer, type StoredDomainEvent } from './events';
import { issueSecureLink } from './secure-link';
import { resolveRecoveryLink } from './recurring-recovery-link';
import {
  FAILURE_CLASS_GUIDE,
  FAILURE_CLASS_LABEL,
  isRecurringFailureClass,
  needsPayerAction,
  type RecurringFailureClass,
} from './recurring-failure';
import {
  PAUSE_MAX_DAYS,
  RECURRING_DAY_MAX,
  RECURRING_DAY_MIN,
  pauseRecurringUntil,
  recurringAmountRange,
  setRecurringStatus,
  updateRecurringDonation,
} from './recurring';
import { recordRecurringChange, termsSnapshot } from './recurring-change-log';

/**
 * 정기후원 실패 복구 (2026-11-09 1차 과제 A1) — 후원자 복구 화면·기관 현황·조치 필요 묶음·결제수단 등록 소비자.
 *
 *  - 후원자 복구 화면(/r/recover/[토큰])은 로그인 없이 개인 링크로만 연다. 링크는 그 약정 1건만 다룬다.
 *    버튼은 기존 업무 함수(updateRecurringDonation·pauseRecurringUntil·setRecurringStatus)를 그대로 부른다.
 *    결제수단 다시 등록은 기존 등록 흐름(REGISTER_ACCOUNT 보안 링크 → /r/[토큰])으로 보낸다.
 *  - 결제수단을 새로 등록하면 payment_method.registered 이벤트 → 이 파일의 소비자가 조치 필요 약정의 다음 출금일을 오늘로 당긴다.
 *  - 기관 승인 대기함 연결은 총괄이 한다(recurringRecoveryInboxGroup 은 export 만).
 */

// ---------------------------------------------------------------------------
// 후원자 복구 화면
// ---------------------------------------------------------------------------

export class RecoveryError extends Error {}

/** 'YYYY-MM-DD' → '12월 5일' (해가 다르면 '2027년 1월 5일') */
export function koDate(key: string, todayKey = kstDateKey()): string {
  const [y, m, d] = key.split('-').map(Number);
  const sameYear = key.slice(0, 4) === todayKey.slice(0, 4);
  return `${sameYear ? '' : `${y}년 `}${m}월 ${d}일`;
}

const LINK_REASON: Record<'NOT_FOUND' | 'EXPIRED' | 'REVOKED', string> = {
  NOT_FOUND: '주소가 잘못되었거나 더 이상 쓸 수 없는 링크입니다.',
  EXPIRED: '링크 유효 기간이 지났습니다. 기브싸인 마이페이지의 정기후원 메뉴에서 같은 일을 할 수 있습니다.',
  REVOKED: '더 최근에 보내 드린 안내 문자의 링크를 이용해 주세요. 이 링크는 더 이상 쓰지 않습니다.',
};

/** 링크 → 그 링크가 다루는 약정(본인 것만). 탈퇴·약정 없음은 열지 않는다. */
async function loadLinkedRecurring(token: string) {
  const res = await resolveRecoveryLink(token);
  if (!res.ok) throw new RecoveryError(LINK_REASON[res.reason]);
  const r = await prisma.recurringDonation.findFirst({
    where: { id: res.link.recurringId, payerId: res.link.payerId },
    include: {
      merchant: { select: { id: true, displayName: true, code: true } },
      payer: { select: { id: true, phoneHash: true, onboardingStatus: true, blockedAt: true } },
    },
  });
  if (!r) throw new RecoveryError(LINK_REASON.NOT_FOUND);
  if (r.payer.onboardingStatus === 'WITHDRAWN') throw new RecoveryError('탈퇴한 계정의 정기후원은 이 화면에서 다룰 수 없습니다.');
  return { link: res.link, r };
}

export interface RecoveryView {
  merchantName: string;
  merchantCode: string;
  amount: bigint;
  dayOfMonth: number;
  status: 'ACTIVE' | 'PAUSED' | 'SUSPENDED' | 'CANCELED';
  recoveryState: 'NONE' | 'RETRYING' | 'ACTION_REQUIRED';
  failureClass: RecurringFailureClass | null;
  failureLabel: string | null;
  why: string;
  todo: string;
  /** 다음 출금 예정 안내 한 줄 */
  nextLine: string;
  /** 조치 필요 기한(KST 날짜) */
  deadline: string | null;
  resumeOn: string | null;
  hasActiveToken: boolean;
  canRegister: boolean;
  canChange: boolean;
  canPause: boolean;
  canCancel: boolean;
  amountMin: bigint;
  amountMax: bigint;
  pauseDefault: string;
  pauseMin: string;
  pauseMax: string;
}

function addDays(key: string, n: number) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function nextMonthDay(day: number, base: string) {
  const [y, m] = base.split('-').map(Number);
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
}

export async function loadRecoveryView(token: string): Promise<{ ok: true; view: RecoveryView } | { ok: false; reason: string }> {
  let loaded: Awaited<ReturnType<typeof loadLinkedRecurring>>;
  try {
    loaded = await loadLinkedRecurring(token);
  } catch (e) {
    if (e instanceof RecoveryError) return { ok: false, reason: e.message };
    throw e;
  }
  const { link, r } = loaded;
  await prisma.recurringRecoveryLink.update({ where: { id: link.id }, data: { lastOpenedAt: new Date() } }).catch(() => undefined);

  const today = kstDateKey();
  const cls = isRecurringFailureClass(r.lastFailureClass) ? r.lastFailureClass : null;
  const guide = cls ? FAILURE_CLASS_GUIDE[cls] : null;
  const [token_, range] = await Promise.all([
    prisma.paymentMethodToken.findFirst({ where: { payerId: r.payerId, status: 'ACTIVE' }, select: { id: true } }),
    recurringAmountRange(r.merchantId, r.payerId),
  ]);
  const deadline = r.recoveryState === 'ACTION_REQUIRED' && r.actionDeadlineOn ? r.actionDeadlineOn.toISOString().slice(0, 10) : null;
  const resumeOn = r.resumeOn ? r.resumeOn.toISOString().slice(0, 10) : null;
  const next = r.nextChargeOn.toISOString().slice(0, 10);

  let nextLine: string;
  if (r.status === 'CANCELED') nextLine = '해지된 정기후원입니다. 더 이상 출금되지 않습니다.';
  else if (r.status === 'SUSPENDED') nextLine = '출금 실패가 이어져 정기후원이 멈춰 있습니다. 결제수단을 확인한 뒤 마이페이지에서 다시 시작할 수 있습니다.';
  else if (r.status === 'PAUSED') nextLine = resumeOn ? `${koDate(resumeOn, today)}에 다시 시작합니다. 그 전까지는 출금되지 않습니다.` : '쉬고 있는 정기후원입니다. 다시 시작할 때까지 출금되지 않습니다.';
  else if (deadline) nextLine = `${koDate(deadline, today)}까지 결제수단을 다시 등록하지 않으면 정기후원이 멈춥니다. 등록하면 바로 다음 출금 때 다시 출금합니다.`;
  else nextLine = `다음 출금 예정일은 ${koDate(next, today)}입니다. (${formatNumber(r.amount)}원)`;

  const live = r.status === 'ACTIVE' || r.status === 'PAUSED';
  return {
    ok: true,
    view: {
      merchantName: r.merchant.displayName,
      merchantCode: r.merchant.code,
      amount: r.amount,
      dayOfMonth: r.dayOfMonth,
      status: r.status,
      recoveryState: r.recoveryState,
      failureClass: cls,
      failureLabel: cls ? FAILURE_CLASS_LABEL[cls] : null,
      why: guide?.why ?? (r.status === 'ACTIVE' ? '최근 출금은 정상입니다.' : '정기후원 상태를 확인해 주세요.'),
      todo: guide?.todo ?? '아래에서 출금일을 바꾸거나, 쉬어 가거나, 해지할 수 있습니다.',
      nextLine,
      deadline,
      resumeOn,
      hasActiveToken: Boolean(token_),
      canRegister: r.status !== 'CANCELED' && !r.payer.blockedAt,
      canChange: r.status !== 'CANCELED',
      canPause: live,
      canCancel: r.status !== 'CANCELED',
      amountMin: range.min,
      amountMax: range.max,
      pauseDefault: nextMonthDay(r.dayOfMonth, today),
      pauseMin: addDays(today, 1),
      pauseMax: addDays(today, PAUSE_MAX_DAYS),
    },
  };
}

/** 결제수단 다시 등록: 기존 등록 흐름의 1회용 보안 링크를 만들어 그 주소를 돌려준다. */
export async function startRecoveryRegistration(token: string): Promise<string> {
  const { r } = await loadLinkedRecurring(token);
  if (r.status === 'CANCELED') throw new RecoveryError('해지된 정기후원입니다.');
  if (r.payer.blockedAt) throw new RecoveryError('이용이 제한된 계정입니다. 고객센터로 문의해 주세요.');
  const link = await issueSecureLink({
    purpose: 'REGISTER_ACCOUNT',
    phoneHash: r.payer.phoneHash,
    merchantId: r.merchantId,
    payload: { channel: 'RECURRING_RECOVERY', recurringId: r.id },
  });
  return `/r/${link.token}`;
}

/** 출금일·금액 바꾸기 → 바뀐 결과 문장 */
export async function changeFromRecovery(token: string, input: { dayOfMonth?: number; amount?: bigint }, meta?: { ip?: string; userAgent?: string }): Promise<string> {
  const { r } = await loadLinkedRecurring(token);
  const patch: { dayOfMonth?: number; amount?: bigint } = {};
  if (input.dayOfMonth !== undefined && input.dayOfMonth !== r.dayOfMonth) {
    if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < RECURRING_DAY_MIN || input.dayOfMonth > RECURRING_DAY_MAX) {
      throw new RecoveryError(`출금일은 ${RECURRING_DAY_MIN}~${RECURRING_DAY_MAX}일 사이로 골라 주세요.`);
    }
    patch.dayOfMonth = input.dayOfMonth;
  }
  if (input.amount !== undefined && input.amount !== r.amount) patch.amount = input.amount;
  if (patch.dayOfMonth === undefined && patch.amount === undefined) throw new RecoveryError('바꿀 내용이 없습니다. 출금일이나 금액을 바꿔 주세요.');
  const updated = await updateRecurringDonation(r.payerId, r.id, patch, meta);
  const today = kstDateKey();
  const next = updated.nextChargeOn.toISOString().slice(0, 10);
  let sentence = `${koDate(next, today)} 출금부터 매월 ${updated.dayOfMonth}일 ${formatNumber(updated.amount)}원이 적용됩니다.`;
  if (updated.status === 'PAUSED') sentence = `다시 시작하면 매월 ${updated.dayOfMonth}일 ${formatNumber(updated.amount)}원이 적용됩니다.`;
  if (updated.recoveryState === 'ACTION_REQUIRED') sentence += ' 다만 결제수단을 다시 등록해야 출금할 수 있습니다.';
  await recordRecurringChange({ recurringId: r.id, merchantId: r.merchantId, payerId: r.payerId, actor: 'DONOR', via: 'RECOVER_LINK', kind: 'CHANGE', before: termsSnapshot(r), after: termsSnapshot(updated), summary: sentence });
  return sentence;
}

/** 이번 달 쉬기(재개 예정일 선택) → 결과 문장 */
export async function pauseFromRecovery(token: string, resumeOn: string): Promise<string> {
  const { r } = await loadLinkedRecurring(token);
  const res = await pauseRecurringUntil(r.payerId, r.id, resumeOn);
  const today = kstDateKey();
  const sentence = `${koDate(res.resumeOn, today)}까지 쉬고 그날 다시 시작합니다. 다음 출금 예정일은 ${koDate(res.nextDate, today)}이고, 다시 시작하기 하루 전에 문자로 알려 드립니다.`;
  await recordRecurringChange({ recurringId: r.id, merchantId: r.merchantId, payerId: r.payerId, actor: 'DONOR', via: 'RECOVER_LINK', kind: 'PAUSE_UNTIL', before: termsSnapshot(r), after: { ...termsSnapshot(r), status: 'PAUSED', resumeOn: res.resumeOn }, summary: sentence });
  return sentence;
}

/** 해지(사유 선택) → 결과 문장 */
export async function cancelFromRecovery(token: string, reason?: string): Promise<string> {
  const { r } = await loadLinkedRecurring(token);
  await setRecurringStatus(r.payerId, r.id, 'CANCEL', reason);
  const sentence = `${r.merchant.displayName} 정기후원을 해지했습니다. 이후 출금은 일어나지 않습니다. 그동안 함께해 주셔서 감사합니다.`;
  await recordRecurringChange({ recurringId: r.id, merchantId: r.merchantId, payerId: r.payerId, actor: 'DONOR', via: 'RECOVER_LINK', kind: 'CANCEL', before: termsSnapshot(r), after: { ...termsSnapshot(r), status: 'CANCELED', resumeOn: null }, summary: sentence, reason: reason ?? null });
  return sentence;
}

// ---------------------------------------------------------------------------
// 소비자: 결제수단 새로 등록 → 조치 필요 약정 바로 재시도
// ---------------------------------------------------------------------------

/**
 * 조치 필요(ACTION_REQUIRED) 상태인 그 후원자의 진행 중 약정을 다음 배치(당일)에 재시도하도록 다음 출금일을 오늘로 당긴다.
 * 이미 오늘 이전이면 그대로 둔다(조건부 갱신이라 다시 돌아도 같다). 실패 횟수 초기화는 배치가 결제수단을 다시 확인한 뒤 한다.
 */
export async function handlePaymentMethodRegistered(ev: StoredDomainEvent, now = new Date()) {
  if (!ev.payerId) return 'SKIPPED' as const;
  const today = new Date(`${kstDateKey(now)}T00:00:00Z`);
  const r = await prisma.recurringDonation.updateMany({
    where: { payerId: ev.payerId, status: 'ACTIVE', recoveryState: 'ACTION_REQUIRED', nextChargeOn: { gt: today } },
    data: { nextChargeOn: today },
  });
  return r.count > 0 ? undefined : ('SKIPPED' as const);
}

let registered = false;
export function registerRecurringRecoveryConsumer() {
  if (registered) return;
  registered = true;
  registerConsumer({ name: 'recurring-recovery', types: ['payment_method.registered'], handle: (ev) => handlePaymentMethodRegistered(ev) });
}

// ---------------------------------------------------------------------------
// 기관 콘솔: 복구 현황 · 조치 필요 묶음
// ---------------------------------------------------------------------------

export interface RecoveryPeriodStats {
  /** 이 기간에 출금 실패가 있었던 약정 수 */
  failed: number;
  /** 이 기간에 실패 뒤 복구(같은 주기 성공)된 약정 수 */
  recovered: number;
  recoveredAmount: bigint;
  /** 이 기간에 정지된 약정 수 */
  suspended: number;
}

async function periodStats(merchantId: string, from: Date, to: Date): Promise<RecoveryPeriodStats> {
  const ranAt = { gte: from, lte: to };
  const [failedGroups, recoveredRuns, suspended] = await Promise.all([
    prisma.recurringRun.groupBy({ by: ['recurringId'], where: { status: 'FAILED', ranAt, recurring: { merchantId } } }),
    prisma.recurringRun.findMany({ where: { status: 'SUCCESS', recovered: true, ranAt, recurring: { merchantId } }, select: { recurringId: true, chargeId: true } }),
    prisma.recurringDonation.count({ where: { merchantId, suspendedAt: { gte: from, lte: to } } }),
  ]);
  const chargeIds = recoveredRuns.map((x) => x.chargeId).filter((x): x is string => Boolean(x));
  const sum = chargeIds.length
    ? await prisma.charge.aggregate({ where: { id: { in: chargeIds }, merchantId }, _sum: { amount: true } })
    : null;
  return {
    failed: failedGroups.length,
    recovered: new Set(recoveredRuns.map((x) => x.recurringId)).size,
    recoveredAmount: sum?._sum.amount ?? 0n,
    suspended,
  };
}

export async function recurringRecoveryStats(merchantId: string, now = new Date()) {
  const [thisMonth, last30, actionRequired] = await Promise.all([
    periodStats(merchantId, kstStartOfMonth(now), now),
    periodStats(merchantId, new Date(now.getTime() - 30 * 86_400_000), now),
    prisma.recurringDonation.count({ where: { merchantId, status: 'ACTIVE', recoveryState: 'ACTION_REQUIRED' } }),
  ]);
  return { thisMonth, last30, actionRequired };
}

export const RECOVERY_STATE_LABEL: Record<'NONE' | 'RETRYING' | 'ACTION_REQUIRED', { text: string; tone: 'neutral' | 'warning' | 'danger' }> = {
  NONE: { text: '-', tone: 'neutral' },
  RETRYING: { text: '자동 재시도 중', tone: 'warning' },
  ACTION_REQUIRED: { text: '후원자 조치 필요', tone: 'danger' },
};

export interface RecurringRecoveryInboxGroup {
  kind: 'RECURRING_ACTION_REQUIRED';
  title: string;
  reason: string;
  affectedCount: number;
  amount: bigint;
  oldestAt: Date;
  href: string;
  recommendedAction: string;
}

/**
 * 승인 대기함용 묶음 — 조치 필요(ACTION_REQUIRED) 진행 중 약정. 없으면 null.
 * (대기함 연결은 총괄이 한다. 원천은 recurring_donation 이고 복사하지 않는다.)
 */
export async function recurringRecoveryInboxGroup(merchantId: string): Promise<RecurringRecoveryInboxGroup | null> {
  const rows = await prisma.recurringDonation.findMany({
    where: { merchantId, status: 'ACTIVE', recoveryState: 'ACTION_REQUIRED' },
    select: { amount: true, lastFailureClass: true, recoveryStartedAt: true, updatedAt: true },
  });
  if (rows.length === 0) return null;
  const byClass = new Map<string, number>();
  for (const r of rows) {
    const label = isRecurringFailureClass(r.lastFailureClass) && needsPayerAction(r.lastFailureClass) ? FAILURE_CLASS_LABEL[r.lastFailureClass] : '기타';
    byClass.set(label, (byClass.get(label) ?? 0) + 1);
  }
  const oldestAt = rows.reduce((min, r) => {
    const at = r.recoveryStartedAt ?? r.updatedAt;
    return at < min ? at : min;
  }, rows[0].recoveryStartedAt ?? rows[0].updatedAt);
  return {
    kind: 'RECURRING_ACTION_REQUIRED',
    title: `정기후원 결제수단 조치 필요 ${rows.length}건`,
    reason: [...byClass.entries()].map(([k, n]) => `${k} ${n}건`).join(' · '),
    affectedCount: rows.length,
    amount: rows.reduce((s, r) => s + r.amount, 0n),
    oldestAt,
    href: '/studio/recurring?recovery=ACTION_REQUIRED',
    recommendedAction:
      '후원자에게 결제수단을 다시 등록하는 개인 링크를 문자로 이미 보냈습니다. 기한까지 등록이 없으면 자동으로 정지됩니다. 필요하면 후원자에게 직접 연락해 재등록을 안내해 주세요.',
  };
}
