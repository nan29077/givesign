import type { DomainEventType, StoredDomainEvent } from '../events';

/**
 * 저니(자동 안내 흐름) 타입.
 *
 * 저니 = 트리거 이벤트 → 순서 있는 단계(조건·대기·안내 문자·문서 발송).
 * 정의는 코드에 고정하고(광고성 단계를 기관이 임의로 만들 수 없게), 기관은 켜기/끄기·단계별 승인·값만 바꾼다.
 */

export type ParamValue = number | boolean | number[];

export interface ParamDef {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'numberList';
  default: ParamValue;
  min?: number;
  max?: number;
  unit?: string;
  hint?: string;
}

/** 실행 맥락. 이벤트 payload 에서 마스킹·숫자 값만 옮긴다(개인정보 원문 금지). */
export interface JourneyContext {
  amount?: string;
  totalAmount?: string;
  count?: number;
  campaignId?: string | null;
  campaignTitle?: string | null;
  channel?: string | null;
  taxYear?: number;
  receiptNo?: string | null;
  minutes?: number;
  totalMinutes?: number;
  hours?: number;
  activityTitle?: string | null;
  activityDate?: string | null;
  assignment?: string | null;
  schedule?: string | null;
  reason?: string | null;
  dayOfMonth?: number | null;
  /** 결제에서 시작한 실행의 결제 건(발송 직전 환불 재확인 — 점검 A-M3) */
  chargeId?: string | null;
  /** 계좌이체 확정(offline.received)에서 시작한 실행의 기록 id(발송 직전 되돌리기 재확인 — 2026-11-09 E) */
  offlineDonationId?: string | null;
  /** 봉사 전날 안내: 신청·회차·시작 시각(발송 직전 재확인 — 점검 A-M6) */
  applicationId?: string | null;
  shiftId?: string | null;
  startsAt?: string | null;
  /** 승인된 단계 key */
  approved?: Record<string, true>;
  /** 반려된 단계 key */
  rejected?: Record<string, true>;
  /** 발송 보류(야간·상한) 횟수 */
  deferrals?: number;
}

export type StepOutcome =
  /** 했다(발송 단계면 sent=true) → 다음 단계 */
  | { type: 'done'; detail?: string; sent?: boolean }
  /** 조건이 맞지 않아 이 단계만 건너뛴다 → 다음 단계 */
  | { type: 'skip'; detail: string }
  /** 흐름을 끝낸다(남은 단계를 하지 않음) */
  | { type: 'stop'; detail: string }
  /** 다음 단계를 until 이후에 */
  | { type: 'wait'; until: Date; detail?: string }
  /** 같은 단계를 until 이후 다시(막힘·보류) */
  | { type: 'retry'; until: Date; detail: string };

export interface StepEnv {
  run: { id: string; merchantId: string; payerId: string | null; journeyKey: string; triggerKey: string; startedAt: Date; context: JourneyContext; subjectType?: string | null };
  params: Record<string, ParamValue>;
  merchant: { id: string; displayName: string };
  now: Date;
}

export interface StepDef {
  key: string;
  label: string;
  kind: 'condition' | 'wait' | 'message' | 'document';
  /** 기관이 '승인 후 보내기' 로 바꿀 수 있는 단계 */
  approvable?: boolean;
  /** 승인 필요 기본값 */
  defaultApproval?: boolean;
  /** 후원자 수신 거부(자동 안내 끔)·발송 상한·야간 보류를 적용하는 발송 단계 */
  sends?: boolean;
  /** 단계 설명(화면) */
  describe(params: Record<string, ParamValue>): string;
  /** false 면 이 단계만 건너뛴다(조건 사유 문자열을 돌려주면 그 사유로 기록) */
  when?(env: StepEnv): Promise<true | string>;
  /** 승인 요청 제목(승인 단계일 때) */
  approvalTitle?(env: StepEnv): Promise<string>;
  run(env: StepEnv): Promise<StepOutcome>;
}

export interface JourneyDef {
  key: string;
  label: string;
  description: string;
  /** 화면 묶음 */
  group: '후원' | '정기후원' | '자원봉사' | '영수증';
  triggers: readonly DomainEventType[];
  triggerLabel: string;
  defaultEnabled: boolean;
  params: ParamDef[];
  /** 이 이벤트로 실행을 시작할지(맞지 않으면 실행을 만들지 않는다). params 는 그 기관의 저니 설정값 */
  accept?(event: StoredDomainEvent, params: Record<string, ParamValue>): boolean;
  /** 실행 맥락 만들기 */
  buildContext(event: StoredDomainEvent): JourneyContext;
  steps: StepDef[];
}

/**
 * 단계가 고칠 일이 있어 막혔다(발송 전 점검 등). 엔진은 재시도하지 않고 실행을 바로 FAILED(막힌 일)로 둔다.
 * 승인 대기함이 보여 주고, 기관이 고친 뒤 다시 실행한다(retryJourneyRun). (2026-11-09 C2)
 */
export class JourneyBlockedError extends Error {
  readonly blocked = true;
}
