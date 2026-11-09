/**
 * 발송 분류표 (2026-11-09 D2) — 코드 한 곳.
 *
 *  - 거래·요청형(TRANSACTIONAL): 인증번호, 결제 링크, 후원자가 요청한 안내, 서명 요청, 결제 실패·복구 안내, 결제 완료 안내 등.
 *    7일 상한·합치기·대기열·담당자 확인 보류 대상이 **아니다**. 지금 경로 그대로 바로 나간다.
 *  - 관계·정보형(RELATIONAL): 감사장, 영수증 정보 안내, 월간 안내, 누적 감사, 연말 감사장, 봉사 감사.
 *    발송 대기열(outbound_queue)에서 합치기·7일 상한·우선순위·야간 보류를 함께 적용한다.
 *
 * 새 안내를 만들면 여기에 분류를 먼저 적는다. 표에 없는 템플릿은 거래·요청형으로 본다(지금처럼 바로 나간다 — 안전한 쪽).
 */

/** 관계·정보형 안내 종류. 우선순위가 높을수록 상한이 찼을 때 먼저 보낸다(낮은 것부터 하루 보류). */
export const RELATIONAL_KIND = {
  MONTHLY_NOTICE: { label: '월간 안내', priority: 1 },
  RECURRING_THANKS: { label: '정기후원 누적 감사', priority: 2 },
  VOLUNTEER_THANKS: { label: '봉사 감사', priority: 2 },
  THANKS_LETTER: { label: '감사장', priority: 3 },
  YEAR_END_THANKS: { label: '연말 감사장', priority: 3 },
  RECEIPT_INFO: { label: '영수증 정보 등록 안내', priority: 4 },
  // 2026-11-09 3차 H — 정보성 문서 안내(권유 문구 없음)
  IMPACT_REPORT: { label: '후원금 사용 결과 보고', priority: 2 },
  ANNUAL_NOTICE: { label: '후원금 연간 통보', priority: 4 },
} as const;

export type RelationalKind = keyof typeof RELATIONAL_KIND;

export function relationalPriority(kind: string): number {
  return (RELATIONAL_KIND as Record<string, { priority: number }>)[kind]?.priority ?? 0;
}

export function relationalLabel(kind: string): string {
  return (RELATIONAL_KIND as Record<string, { label: string }>)[kind]?.label ?? kind;
}

/** 문자 템플릿 코드 → 관계·정보형 종류. 여기 없는 코드는 거래·요청형이다. */
const TEMPLATE_KIND: Record<string, RelationalKind> = {
  MONTHLY_NOTICE: 'MONTHLY_NOTICE',
  RECEIPT_INFO_REQUEST: 'RECEIPT_INFO',
  VOLUNTEER_THANKS: 'VOLUNTEER_THANKS',
};

/** 용도별 자동 발송 문서(열람 링크 안내) → 관계·정보형 종류. 서명이 필요한 용도(약정서·신청서·변경 신청서)는 서명 요청이라 거래·요청형. */
const DOCUMENT_PURPOSE_KIND: Record<string, RelationalKind> = {
  THANKS_LETTER: 'THANKS_LETTER',
  RECURRING_THANKS: 'RECURRING_THANKS',
  YEAR_END_THANKS: 'YEAR_END_THANKS',
  VOLUNTEER_THANKS: 'VOLUNTEER_THANKS',
  VOLUNTEER_CONFIRMATION: 'VOLUNTEER_THANKS',
  IMPACT_REPORT: 'IMPACT_REPORT',
  ANNUAL_DONATION_NOTICE: 'ANNUAL_NOTICE',
};

/** 저니 단계 → 관계·정보형 종류. 봉사 전날 일정 안내·정기후원 재개 안내는 신청·약정 상태 안내라 거래·요청형(멈추지 않음). */
const JOURNEY_STEP_KIND: Record<string, RelationalKind> = {
  'thanks-letter': 'THANKS_LETTER',
  'receipt-info': 'RECEIPT_INFO',
  'recurring-thanks': 'RECURRING_THANKS',
  'volunteer-thanks-msg': 'VOLUNTEER_THANKS',
  'volunteer-confirmation': 'VOLUNTEER_THANKS',
  'volunteer-thanks-letter': 'VOLUNTEER_THANKS',
  'year-end-letter': 'YEAR_END_THANKS',
};

/**
 * 기관 담당자 대상 정보성 안내(2026-11-11 G). 후원자에게 가는 안내가 아니므로 (기관, 후원자) 7일 상한·묶음 대기열(sendRelational —
 * 후원자 행 기준)에 넣지 않는다. 발송 키 대신 원천 행의 조건부 선점(weekly_plan.report_claimed_at)으로 한 번만 보낸다.
 * 알림톡 정보성 템플릿(ALIMTALK_TEMPLATES)에 있고, 승인 전이면 문자 대체 규칙 그대로다.
 */
export const STAFF_INFO_TEMPLATES: Record<string, string> = {
  WEEKLY_REPORT: '주간 운영 보고 안내',
};

export function isStaffInfoTemplate(code: string | null | undefined): boolean {
  return Boolean(code && Object.hasOwn(STAFF_INFO_TEMPLATES, code));
}

export function kindOfTemplate(code: string | null | undefined): RelationalKind | null {
  return code ? (TEMPLATE_KIND[code] ?? null) : null;
}

export function kindOfDocumentPurpose(purpose: string): RelationalKind | null {
  return DOCUMENT_PURPOSE_KIND[purpose] ?? null;
}

export function kindOfJourneyStep(stepKey: string): RelationalKind | null {
  return JOURNEY_STEP_KIND[stepKey] ?? null;
}

export function isRelationalTemplate(code: string | null | undefined): boolean {
  return kindOfTemplate(code) !== null;
}

/** 기관·후원자당 관계·정보형 안내 7일 상한(11-06 미결정: 기준은 (기관, 후원자) 유지 — 대표 결정 전). 저니 상한과 같은 값. */
export const RELATIONAL_WEEKLY_CAP = 3;
/** 상한·담당자 확인으로 대기열 안내를 하루씩 미루는 최대 횟수. 넘으면 건너뛰고 기록한다. */
export const OUTBOUND_MAX_DEFERRALS = 3;
/** 묶음 발송 본문 상한(LMS 2,000바이트, 한글 2바이트 기준). 넘으면 둘로 나눈다. */
export const OUTBOUND_BUNDLE_MAX_BYTES = 2000;
/** 묶음 발송 이력의 템플릿 코드(알림톡 템플릿이 없어 문자로 나간다) */
export const OUTBOUND_BUNDLE_TEMPLATE = 'OUTBOUND_BUNDLE';

/** LMS 길이 계산(EUC-KR 기준: ASCII 1바이트, 그 밖 2바이트). */
export function lmsBytes(text: string): number {
  let n = 0;
  for (const ch of text) n += ch.charCodeAt(0) < 0x80 ? 1 : 2;
  return n;
}

// ---------------------------------------------------------------------------
// 상태 5단계에서 "안내 종류" 표시(거래·요청형 포함 — 열람·완료를 이어 볼 수 있는 것만)
// ---------------------------------------------------------------------------

/** 기관 콘솔 단계 집계에 보이는 안내 종류. key 는 템플릿 코드 묶음. */
export const NOTICE_STAGE_GROUPS: Array<{ key: string; label: string; templates: string[]; relational: boolean; opened: 'document' | 'sign' | 'recovery' | null; completed: 'receipt-profile' | 'sign' | 'payment-method' | null }> = [
  { key: 'DOCUMENT', label: '감사장·확인서 등 열람 문서', templates: ['DOCUMENT_ISSUED'], relational: true, opened: 'document', completed: null },
  { key: 'RECEIPT_INFO', label: '영수증 정보 등록 안내', templates: ['RECEIPT_INFO_REQUEST'], relational: true, opened: null, completed: 'receipt-profile' },
  { key: 'MONTHLY_NOTICE', label: '월간 안내', templates: ['MONTHLY_NOTICE'], relational: true, opened: null, completed: null },
  { key: 'VOLUNTEER_THANKS', label: '봉사 감사 문자', templates: ['VOLUNTEER_THANKS'], relational: true, opened: null, completed: null },
  { key: 'SIGN_REQUEST', label: '서명 요청', templates: ['EDOC_SIGN_REQUEST', 'AGREEMENT_ISSUED'], relational: false, opened: 'sign', completed: 'sign' },
  {
    key: 'RECOVERY',
    label: '정기후원 출금 실패·복구 안내',
    templates: ['RECURRING_FAILED', 'RECURRING_ACCOUNT_PROBLEM', 'RECURRING_AUTH_REQUIRED', 'RECURRING_NO_METHOD', 'RECURRING_SUSPENDED', 'RECURRING_RESUME_GUIDE'],
    relational: false,
    opened: 'recovery',
    completed: 'payment-method',
  },
  { key: 'CHARGE_SUCCESS', label: '후원 완료 안내', templates: ['CHARGE_SUCCESS'], relational: false, opened: null, completed: null },
];
