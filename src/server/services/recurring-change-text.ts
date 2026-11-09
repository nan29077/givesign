import { kstDateKey } from '@/lib/datetime';
import { formatWon } from '@/lib/money';

/**
 * 정기후원 변경 결과를 문장으로 (2026-11-09 2차 F).
 *
 * 후원자 셀프서비스 화면의 "저장 전 미리보기" 와 "저장 후 확인" 이 같은 문장을 쓰도록 계산은 이 한 곳에서만 한다.
 * DB 를 읽지 않는 순수 함수다 — 읽기는 호출하는 쪽(donor-self-service.ts)이 해서 `before` 로 넘긴다.
 * 날짜 계산은 recurring.ts 의 실제 갱신 규칙과 같다:
 *  - 출금일 변경: 오늘보다 뒤인 이번 달 출금일이면 이번 달, 아니면 다음 달(오늘과 같은 날도 다음 달). 이번 달 주기를 이미
 *    출금했으면 다음 달로 넘긴다(nextScheduleFor).
 *  - 금액만 변경: 다음 출금 예정일(next_charge_on) 그대로, 그 출금부터 새 금액.
 *  - 재개 예정일: 그 달 출금일이 재개일과 같거나 뒤면 그 달, 지났으면 다음 달(scheduleFromDate).
 *  - 결과 미확인(PENDING) 실행이 있으면 금액·출금일 변경은 보류한다(확정 전 주기 계산이 바뀌지 않게).
 */

export type RecurringStatusValue = 'ACTIVE' | 'PAUSED' | 'SUSPENDED' | 'CANCELED';

export interface RecurringBefore {
  status: RecurringStatusValue;
  amount: bigint;
  dayOfMonth: number;
  /** 다음 출금 예정일(KST 'YYYY-MM-DD') */
  nextChargeOn: string;
  /** 재개 예정일(KST 'YYYY-MM-DD') */
  resumeOn: string | null;
  /** 이번 달(KST) 주기 출금이 성공한 날. 없으면 null */
  chargedThisMonthOn: string | null;
  /** 결과를 아직 모르는(PENDING) 출금 실행이 있다 */
  pending: boolean;
  /** 결제수단 조치 필요(ACTION_REQUIRED) */
  actionRequired?: boolean;
}

export type RecurringAfter =
  | { action: 'CHANGE'; amount?: bigint; dayOfMonth?: number }
  | { action: 'PAUSE' }
  | { action: 'PAUSE_UNTIL'; resumeOn: string }
  | { action: 'RESUME' }
  | { action: 'CANCEL' };

export type RecurringChangeBlock = 'PENDING' | 'CANCELED' | 'NO_CHANGE' | 'INVALID_STATE' | 'INVALID_DATE' | 'INVALID_DAY';

export interface RecurringChangeDescription {
  allowed: boolean;
  blocked?: RecurringChangeBlock;
  /** 한 줄씩 */
  lines: string[];
  /** lines 를 이어 붙인 문장 */
  text: string;
  /** 바뀐 내용이 처음 적용되는 출금일(없으면 null) */
  effectiveOn: string | null;
  /** 이번 달 출금이 이 변경으로 건너뛰어진다 */
  skipsThisMonth: boolean;
}

/** 재개 예정일은 오늘부터 이 날 수 안에서만(recurring.ts PAUSE_MAX_DAYS 와 같다) */
const PAUSE_MAX_DAYS = 180;
const DAY_MIN = 1;
const DAY_MAX = 28;

const PENDING_HOLD =
  '지난 출금 결과를 확인하는 중이라 금액·출금일 변경은 잠시 보류됩니다. 결과가 확인되면(보통 1~2일) 다시 바꿔 주세요. 그동안 같은 달에 두 번 출금되지는 않습니다.';
const PENDING_NOTE = '지난 출금 결과를 확인하는 중입니다. 그 출금이 성공으로 확인되면 그 후원은 그대로 처리됩니다.';

/** 'YYYY-MM-DD' → '12월 5일' (올해가 아니면 '2027년 1월 5일') */
export function koDay(key: string, todayKey: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${key.slice(0, 4) === todayKey.slice(0, 4) ? '' : `${y}년 `}${m}월 ${d}일`;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function dayIn(monthKey: string, day: number) {
  return `${monthKey}-${pad(day)}`;
}

function nextMonthOf(dateKey: string, day: number) {
  const [y, m] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
}

function addDays(key: string, n: number) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function validDateKey(key: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && !Number.isNaN(new Date(`${key}T00:00:00Z`).getTime()) && new Date(`${key}T00:00:00Z`).toISOString().slice(0, 10) === key;
}

/** 지금 기준 첫 출금일(출금일 변경·재개). 이번 달을 이미 출금했으면 다음 달. */
function firstFrom(day: number, today: string, chargedThisMonth: boolean) {
  const thisMonth = dayIn(today.slice(0, 7), day);
  let next = thisMonth > today ? thisMonth : nextMonthOf(today, day);
  if (chargedThisMonth && next.slice(0, 7) === today.slice(0, 7)) next = nextMonthOf(next, day);
  return next;
}

/** 재개일 기준 첫 출금일 */
function firstAfterResume(day: number, resumeOn: string, today: string, chargedThisMonth: boolean) {
  let next = dayIn(resumeOn.slice(0, 7), day);
  if (next < resumeOn) next = nextMonthOf(resumeOn, day);
  if (chargedThisMonth && next.slice(0, 7) === today.slice(0, 7)) next = nextMonthOf(next, day);
  return next;
}

function done(lines: string[], effectiveOn: string | null, skipsThisMonth = false): RecurringChangeDescription {
  return { allowed: true, lines, text: lines.join(' '), effectiveOn, skipsThisMonth };
}

function blocked(code: RecurringChangeBlock, line: string): RecurringChangeDescription {
  return { allowed: false, blocked: code, lines: [line], text: line, effectiveOn: null, skipsThisMonth: false };
}

export function describeRecurringChange(before: RecurringBefore, after: RecurringAfter, now = new Date()): RecurringChangeDescription {
  const today = kstDateKey(now);
  const thisMonth = today.slice(0, 7);
  const charged = Boolean(before.chargedThisMonthOn && before.chargedThisMonthOn.slice(0, 7) === thisMonth);
  const chargedLine = charged ? `이번 달 출금(${koDay(before.chargedThisMonthOn!, today)})은 이미 끝났습니다.` : null;

  if (before.status === 'CANCELED') return blocked('CANCELED', '해지된 정기후원은 바꿀 수 없습니다. 다시 후원하려면 새로 신청해 주세요.');

  switch (after.action) {
    case 'CHANGE': {
      const amount = after.amount !== undefined && after.amount !== before.amount ? after.amount : undefined;
      const day = after.dayOfMonth !== undefined && after.dayOfMonth !== before.dayOfMonth ? after.dayOfMonth : undefined;
      if (day !== undefined && (!Number.isInteger(day) || day < DAY_MIN || day > DAY_MAX)) {
        return blocked('INVALID_DAY', `출금일은 ${DAY_MIN}~${DAY_MAX}일 사이로 골라 주세요.`);
      }
      if (amount === undefined && day === undefined) return blocked('NO_CHANGE', '바뀐 내용이 없습니다. 금액이나 출금일을 바꿔 주세요.');
      if (before.pending) return blocked('PENDING', PENDING_HOLD);

      const newDay = day ?? before.dayOfMonth;
      const newAmount = amount ?? before.amount;
      const what =
        amount !== undefined && day !== undefined
          ? `바꾼 금액 ${formatWon(newAmount)}과 출금일(매월 ${newDay}일)은`
          : amount !== undefined
            ? `바꾼 금액 ${formatWon(newAmount)}은`
            : `바꾼 출금일(매월 ${newDay}일)은`;

      if (before.status === 'PAUSED') {
        const lines = ['지금은 쉬고 있어 출금되지 않습니다.'];
        if (before.resumeOn) {
          const first = firstAfterResume(newDay, before.resumeOn, today, charged);
          lines.push(`${koDay(before.resumeOn, today)}에 다시 시작하면 ${what} ${koDay(first, today)} 출금부터 적용됩니다.`);
          return done(lines, first);
        }
        lines.push(`${what} 다시 시작한 뒤 첫 출금부터 적용됩니다.`);
        return done(lines, null);
      }
      if (before.status === 'SUSPENDED') {
        return done(['출금 실패로 정기후원이 멈춰 있습니다.', `${what} 다시 시작한 뒤 첫 출금부터 적용됩니다.`], null);
      }

      // ACTIVE
      const next = day !== undefined ? firstFrom(newDay, today, charged) : before.nextChargeOn;
      const lines: string[] = [];
      if (chargedLine) lines.push(chargedLine);
      const outstanding = !charged && before.nextChargeOn.slice(0, 7) <= thisMonth;
      const skips = day !== undefined && outstanding && next.slice(0, 7) > thisMonth;
      if (skips) lines.push(`새 출금일(매월 ${newDay}일)이 이번 달에는 이미 지나서 ${Number(thisMonth.slice(5, 7))}월에는 출금되지 않습니다.`);
      else if (!charged && outstanding && day !== undefined && next.slice(0, 7) === thisMonth) {
        lines.push(`이번 달 출금은 아직 전입니다.`);
      }
      lines.push(`${what} ${koDay(next < today ? today : next, today)} 출금부터 적용됩니다.`);
      if (before.actionRequired) lines.push('다만 결제수단을 다시 등록해야 출금할 수 있습니다.');
      return done(lines, next, skips);
    }

    case 'PAUSE': {
      if (before.status !== 'ACTIVE') return blocked('INVALID_STATE', '진행 중인 정기후원만 일시정지할 수 있습니다.');
      const lines: string[] = [];
      if (chargedLine) lines.push(`${chargedLine} 이미 낸 후원은 그대로입니다.`);
      if (before.pending) lines.push(PENDING_NOTE);
      const from = charged && before.nextChargeOn.slice(0, 7) === thisMonth ? nextMonthOf(before.nextChargeOn, before.dayOfMonth) : before.nextChargeOn;
      lines.push(`${koDay(from < today ? today : from, today)} 출금부터 쉽니다. 다시 시작 버튼을 누를 때까지 출금하지 않습니다.`);
      return done(lines, from);
    }

    case 'PAUSE_UNTIL': {
      if (before.status !== 'ACTIVE' && before.status !== 'PAUSED') return blocked('INVALID_STATE', '진행 중이거나 쉬고 있는 정기후원만 쉬어 갈 수 있습니다.');
      if (!validDateKey(after.resumeOn)) return blocked('INVALID_DATE', '다시 시작할 날짜를 확인해 주세요.');
      if (after.resumeOn <= today) return blocked('INVALID_DATE', '다시 시작할 날짜는 내일 이후로 골라 주세요.');
      if (after.resumeOn > addDays(today, PAUSE_MAX_DAYS)) return blocked('INVALID_DATE', `다시 시작할 날짜는 오늘부터 ${PAUSE_MAX_DAYS}일 안으로 골라 주세요.`);
      const first = firstAfterResume(before.dayOfMonth, after.resumeOn, today, charged);
      const lines: string[] = [];
      if (chargedLine) lines.push(`${chargedLine} 이미 낸 후원은 그대로입니다.`);
      if (before.pending) lines.push(PENDING_NOTE);
      lines.push(
        `${koDay(after.resumeOn, today)}까지 쉬고 그날 다시 시작합니다. 다시 시작한 뒤 첫 출금은 ${koDay(first, today)}(${formatWon(before.amount)})입니다.`,
      );
      lines.push('다시 시작하기 하루 전에 문자로 알려 드립니다.');
      return done(lines, first);
    }

    case 'RESUME': {
      if (before.status !== 'PAUSED' && before.status !== 'SUSPENDED') return blocked('INVALID_STATE', '쉬고 있거나 멈춘 정기후원만 다시 시작할 수 있습니다.');
      const next = firstFrom(before.dayOfMonth, today, charged);
      const lines: string[] = [];
      if (charged) lines.push(`${chargedLine} 그래서 다음 달부터 출금합니다.`);
      else if (next.slice(0, 7) > thisMonth) lines.push(`이번 달 출금일(${koDay(dayIn(thisMonth, before.dayOfMonth), today)})이 지나 다음 달부터 출금합니다.`);
      lines.push(`다시 시작하면 첫 출금은 ${koDay(next, today)}(${formatWon(before.amount)})입니다.`);
      return done(lines, next);
    }

    case 'CANCEL': {
      const lines: string[] = [];
      if (chargedLine) lines.push(`${chargedLine} 이미 낸 후원은 그대로 남습니다.`);
      if (before.pending) lines.push(PENDING_NOTE);
      if (before.status === 'ACTIVE') {
        const from = charged && before.nextChargeOn.slice(0, 7) === thisMonth ? nextMonthOf(before.nextChargeOn, before.dayOfMonth) : before.nextChargeOn;
        lines.push(`해지하면 ${koDay(from < today ? today : from, today)} 출금부터 더 이상 출금되지 않습니다.`);
      } else {
        lines.push('해지하면 다시 시작할 수 없고, 더 이상 출금되지 않습니다.');
      }
      return done(lines, null);
    }
  }
}
