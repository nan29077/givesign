import { prisma } from '@/server/db';
import type { ChargeStatus } from '@/generated/prisma/enums';

/**
 * 정기후원 출금 실패 원인 분류와 원인별 처리 정책 (2026-11-09 1차 과제 A1).
 *
 * 분류 근거는 결제 건 상태(우리 쪽 판정) + 그 결제 건의 가장 최근 결제 거래 결과 코드(결제사 판정)다.
 *  - 결제 건 LIMIT_BLOCKED → LIMIT_BLOCKED, UNREGISTERED → NO_PAYMENT_METHOD (우리가 내린 판정이라 코드표와 무관)
 *  - 그 밖의 실패는 결제사 결과 코드를 코드표로 찾는다. 모르는 코드는 UNKNOWN_REASON(= 예전과 같은 처리).
 *
 * 코드표
 *  - 헥토 실코드 규격을 아직 받지 못했다. 운영 코드표는 환경변수로만 받는다(콤마 구분, 대소문자 무관):
 *      RECURRING_CODES_INSUFFICIENT · RECURRING_CODES_ACCOUNT · RECURRING_CODES_AUTH · RECURRING_CODES_TEMPORARY
 *  - mock 결제사가 처리한 거래(payment_transaction.provider = 'mock')에만 mock 기본표를 더한다.
 *  - 운영에서 환경변수가 비어 있으면 결제사 코드 실패는 모두 UNKNOWN_REASON 이 되어 예전과 똑같이 동작한다(안전).
 *
 * 결과 미확인(PENDING)은 분류하지 않는다 — 결제 결과 확인 흐름(recurring.ts (3))이 먼저 확정한다.
 */

export const RECURRING_FAILURE_CLASSES = [
  'INSUFFICIENT_FUNDS',
  'ACCOUNT_PROBLEM',
  'AUTH_REQUIRED',
  'PROVIDER_TEMPORARY',
  'LIMIT_BLOCKED',
  'NO_PAYMENT_METHOD',
  'UNKNOWN_REASON',
] as const;
export type RecurringFailureClass = (typeof RECURRING_FAILURE_CLASSES)[number];

export function isRecurringFailureClass(v: unknown): v is RecurringFailureClass {
  return typeof v === 'string' && (RECURRING_FAILURE_CLASSES as readonly string[]).includes(v);
}

/** mock 결제사 코드표 (adapters/payment mock: 금액 끝자리 999→M0001, 991→M0002, 992→M0003, 993→M0004) */
export const MOCK_FAILURE_CODES = {
  INSUFFICIENT: ['M0001'],
  ACCOUNT: ['M0002'],
  AUTH: ['M0003'],
  TEMPORARY: ['M0004'],
} as const;

type CodeKind = keyof typeof MOCK_FAILURE_CODES;
const ENV_KEYS: Record<CodeKind, string> = {
  INSUFFICIENT: 'RECURRING_CODES_INSUFFICIENT',
  ACCOUNT: 'RECURRING_CODES_ACCOUNT',
  AUTH: 'RECURRING_CODES_AUTH',
  TEMPORARY: 'RECURRING_CODES_TEMPORARY',
};
/** 같은 코드가 여러 표에 있으면 앞쪽이 이긴다(계좌 문제를 잔액 부족으로 오인해 재시도만 반복하지 않게). */
const KIND_ORDER: CodeKind[] = ['ACCOUNT', 'AUTH', 'INSUFFICIENT', 'TEMPORARY'];
const KIND_CLASS: Record<CodeKind, RecurringFailureClass> = {
  INSUFFICIENT: 'INSUFFICIENT_FUNDS',
  ACCOUNT: 'ACCOUNT_PROBLEM',
  AUTH: 'AUTH_REQUIRED',
  TEMPORARY: 'PROVIDER_TEMPORARY',
};

function parseCodes(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/** 코드표. mock 거래면 mock 기본표 + 환경변수, 아니면 환경변수만. */
export function failureCodeTable(opts: { mockProvider: boolean; env?: Record<string, string | undefined> }): Record<CodeKind, Set<string>> {
  const e = opts.env ?? process.env;
  const out = {} as Record<CodeKind, Set<string>>;
  for (const k of KIND_ORDER) {
    const codes = new Set(parseCodes(e[ENV_KEYS[k]]));
    if (opts.mockProvider) for (const c of MOCK_FAILURE_CODES[k]) codes.add(c);
    out[k] = codes;
  }
  return out;
}

/** 순수 함수: 결제 건 상태 + 결과 코드 → 분류 */
export function classifyRecurringFailure(input: {
  chargeStatus: ChargeStatus | string | null | undefined;
  resultCode?: string | null;
  provider?: string | null;
  env?: Record<string, string | undefined>;
}): RecurringFailureClass {
  if (input.chargeStatus === 'LIMIT_BLOCKED') return 'LIMIT_BLOCKED';
  if (input.chargeStatus === 'UNREGISTERED') return 'NO_PAYMENT_METHOD';
  const code = (input.resultCode ?? '').trim().toUpperCase();
  if (!code) return 'UNKNOWN_REASON';
  const table = failureCodeTable({ mockProvider: (input.provider ?? '').toLowerCase() === 'mock', env: input.env });
  for (const k of KIND_ORDER) if (table[k].has(code)) return KIND_CLASS[k];
  return 'UNKNOWN_REASON';
}

/** DB 에서 결제 건과 가장 최근 결제 거래를 읽어 분류한다. */
export async function classifyChargeFailure(chargeId: string): Promise<{ failureClass: RecurringFailureClass; resultCode: string | null }> {
  const charge = await prisma.charge.findUnique({
    where: { id: chargeId },
    select: {
      status: true,
      transactions: { orderBy: { requestedAt: 'desc' }, take: 1, select: { resultCode: true, provider: true } },
    },
  });
  const txn = charge?.transactions[0];
  const resultCode = txn?.resultCode ?? null;
  return {
    failureClass: classifyRecurringFailure({ chargeStatus: charge?.status, resultCode, provider: txn?.provider }),
    resultCode,
  };
}

// ---------------------------------------------------------------------------
// 처리 정책 (한 곳의 표)
// ---------------------------------------------------------------------------

export type RetryRule = 'NEXT_DAY' | 'PAYDAY' | 'THREE_DAYS' | 'NONE';
export type PayerNotice = 'NONE' | 'INSUFFICIENT' | 'ACCOUNT' | 'AUTH' | 'NO_METHOD' | 'GENERIC';

export interface FailurePolicy {
  /** 다음 시도일 규칙. NONE = 자동 재시도하지 않고 후원자 조치를 기다린다(ACTION_REQUIRED) */
  retry: RetryRule;
  /**
   * 정지 판정 횟수(failCount)에 넣는가.
   * PROVIDER_TEMPORARY 는 주기 안 연속 TEMPORARY_FREE_STREAK 회까지 넣지 않는다(그다음부터 센다).
   */
  counts: boolean | 'AFTER_FREE_STREAK';
  /** 후원자 문자. NONE = 보내지 않는다 */
  notice: PayerNotice;
}

/** 일시 오류는 주기 안에서 연속 이 횟수까지는 정지 판정 횟수에 넣지 않는다. */
export const TEMPORARY_FREE_STREAK = 2;
/** 조치 필요 상태에서 기다리는 날 수(이번 주기의 다음 출금일 전날을 넘기지 않는다) */
export const ACTION_WAIT_DAYS = 14;

export const RECURRING_FAILURE_POLICY: Record<RecurringFailureClass, FailurePolicy> = {
  // 결제사 일시 오류·점검: 후원자 잘못이 아니다. 다음 날 다시, 문자도 기관 개별 알림도 없음.
  PROVIDER_TEMPORARY: { retry: 'NEXT_DAY', counts: 'AFTER_FREE_STREAK', notice: 'NONE' },
  // 잔액 부족: 급여일 근처로 미룬다.
  INSUFFICIENT_FUNDS: { retry: 'PAYDAY', counts: true, notice: 'INSUFFICIENT' },
  // 자동 재시도해도 소용없다 → 후원자 조치 대기(최대 14일, 이번 주기 안)
  ACCOUNT_PROBLEM: { retry: 'NONE', counts: true, notice: 'ACCOUNT' },
  AUTH_REQUIRED: { retry: 'NONE', counts: true, notice: 'AUTH' },
  NO_PAYMENT_METHOD: { retry: 'NONE', counts: true, notice: 'NO_METHOD' },
  // 우리 한도: 다음 날(횟수 포함, 안내 문자는 예전 실패 문자)
  LIMIT_BLOCKED: { retry: 'NEXT_DAY', counts: true, notice: 'GENERIC' },
  // 모름: 예전과 완전히 같게(3일 뒤, 3회면 정지, 예전 실패 문자)
  UNKNOWN_REASON: { retry: 'THREE_DAYS', counts: true, notice: 'GENERIC' },
};

/** 조치 필요(자동 재시도 없음) 분류인가 */
export function needsPayerAction(cls: RecurringFailureClass | string | null | undefined): boolean {
  return isRecurringFailureClass(cls) && RECURRING_FAILURE_POLICY[cls].retry === 'NONE';
}

export function addDaysKey(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 잔액 부족 재시도일: 오늘+2 ~ 오늘+7 안에서 10일·25일·말일 "다음 날"(11일·26일·다음 달 1일) 중 가장 이른 날.
 * 없으면 오늘+3(예전 간격). 그 날이 다음 주기 출금일 이후면 예전 3일로 돌아간다.
 */
export function paydayRetryDate(today: string, nextCycleDate: string): string {
  let pick: string | null = null;
  for (let i = 2; i <= 7; i += 1) {
    const d = addDaysKey(today, i);
    const day = Number(d.slice(8, 10));
    if (day === 11 || day === 26 || day === 1) {
      pick = d;
      break;
    }
  }
  const fallback = addDaysKey(today, 3);
  if (!pick) return fallback;
  if (pick >= nextCycleDate) return fallback;
  return pick;
}

/** 조치 필요 기한: 오늘+14 와 다음 주기 출금일 전날 중 이른 날(최소 내일). */
export function actionDeadline(today: string, nextCycleDate: string): string {
  const byWait = addDaysKey(today, ACTION_WAIT_DAYS);
  const beforeNext = addDaysKey(nextCycleDate, -1);
  const d = byWait < beforeNext ? byWait : beforeNext;
  const tomorrow = addDaysKey(today, 1);
  return d < tomorrow ? tomorrow : d;
}

/** 재시도 규칙에 따른 다음 시도일(재시도 없는 분류는 null) */
export function retryDateFor(cls: RecurringFailureClass, today: string, nextCycleDate: string): string | null {
  const rule = RECURRING_FAILURE_POLICY[cls].retry;
  if (rule === 'NEXT_DAY') return addDaysKey(today, 1);
  if (rule === 'PAYDAY') return paydayRetryDate(today, nextCycleDate);
  if (rule === 'THREE_DAYS') return addDaysKey(today, 3);
  return null;
}

// ---------------------------------------------------------------------------
// 화면 문구
// ---------------------------------------------------------------------------

/** 기관 콘솔·관리자 화면의 짧은 이름 */
export const FAILURE_CLASS_LABEL: Record<RecurringFailureClass, string> = {
  INSUFFICIENT_FUNDS: '잔액 부족',
  ACCOUNT_PROBLEM: '계좌 문제',
  AUTH_REQUIRED: '추가 인증 필요',
  PROVIDER_TEMPORARY: '결제사 일시 오류',
  LIMIT_BLOCKED: '이용 한도',
  NO_PAYMENT_METHOD: '결제수단 없음',
  UNKNOWN_REASON: '기타 실패',
};

export function failureClassLabel(v: string | null | undefined): string {
  return isRecurringFailureClass(v) ? FAILURE_CLASS_LABEL[v] : '-';
}

/** 후원자 화면(복구 링크): 왜 안 됐는지 + 무엇을 하면 되는지 (쉬운 말) */
export const FAILURE_CLASS_GUIDE: Record<RecurringFailureClass, { why: string; todo: string }> = {
  INSUFFICIENT_FUNDS: {
    why: '출금하는 날 통장 잔액이 모자라 후원금이 빠져나가지 않았습니다.',
    todo: '다시 출금하는 날 전에 잔액을 채워 두시면 됩니다. 출금일을 급여일 뒤로 바꾸거나 이번 달만 쉬어 갈 수도 있습니다.',
  },
  ACCOUNT_PROBLEM: {
    why: '등록하신 계좌가 해지되었거나 출금할 수 없는 상태입니다.',
    todo: '쓰고 계신 계좌로 결제수단을 다시 등록해 주세요. 등록하면 바로 다음 출금 때 다시 출금합니다.',
  },
  AUTH_REQUIRED: {
    why: '은행(결제사)에서 본인 확인을 다시 받아야 출금할 수 있다고 알려 왔습니다.',
    todo: '결제수단을 다시 등록하면서 본인 확인을 마쳐 주세요. 등록하면 바로 다음 출금 때 다시 출금합니다.',
  },
  NO_PAYMENT_METHOD: {
    why: '등록된 결제수단이 없어 출금할 수 없었습니다.',
    todo: '결제수단을 등록해 주세요. 등록하면 바로 다음 출금 때 출금합니다.',
  },
  PROVIDER_TEMPORARY: {
    why: '결제사 점검 등 일시적인 문제로 출금하지 못했습니다. 후원자님 계좌 문제는 아닙니다.',
    todo: '따로 하실 일은 없습니다. 다음 날 자동으로 다시 시도합니다.',
  },
  LIMIT_BLOCKED: {
    why: '설정된 이용 한도에 걸려 출금하지 않았습니다.',
    todo: '마이페이지의 이용 한도를 확인해 주세요. 다음 날 다시 시도합니다.',
  },
  UNKNOWN_REASON: {
    why: '출금이 완료되지 않았습니다.',
    todo: '정해진 날에 자동으로 다시 시도합니다. 계속 실패하면 결제수단을 확인해 주세요.',
  },
};
