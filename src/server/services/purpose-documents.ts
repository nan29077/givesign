/**
 * 용도별 자동 발송 문서 — 계약(인터페이스).
 *
 * 저니 엔진(journeys.ts)·이벤트 소비자는 이 함수만 부른다. 어떤 서식을 쓸지, 서명이 필요한지,
 * 어떤 링크로 보낼지는 이 모듈이 정한다.
 *
 * 규칙(2단계 구현이 지켜야 하는 것)
 *  - 서식 선택: 기관이 그 용도로 지정한 DocumentTemplate(활성) → 없으면 기본 세트(DOCUMENT_PRESETS)에서
 *    그 기관 복사본을 만들어(멱등) 쓴다. 기관이 "이 용도 자동 발송 끔" 으로 두면 보내지 않는다(blocked).
 *  - 본문·PDF 레이아웃의 머지 필드({{후원자명}} 등)를 MergeContext 로 채운 **스냅샷**을 남긴다(SHA-256).
 *    스냅샷에는 마스킹 값만(전화번호·주민번호 원문 금지).
 *  - 서명이 필요한 용도(약정서·신청서)는 전자문서 센터 봉투(EDocEnvelope)로 서명을 받는다. 이용요금 잔액이
 *    부족하면 보내지 않고 blocked: 'EDOC_BALANCE' 로 돌려준다(호출자가 승인 대기함에 사유를 올린다).
 *  - 서명이 필요 없는 용도(감사장·확인서)는 열람 토큰 링크로 보낸다(토큰은 해시만 저장).
 *  - dedupeKey 로 같은 발송을 두 번 하지 않는다(재시도 안전). 이미 보냈으면 { ok: true, already: true }.
 *  - 발송 채널은 sendMtForPayer(알림톡 → 문자 대체). 결제 링크가 아니므로 알림톡 허용 목록에 넣는다.
 *  - 실패는 예외 대신 { ok: false } 로 돌려준다(사후 처리 실패가 업무를 막지 않는다).
 */

export const DOCUMENT_PURPOSES = [
  /** 후원 약정서(정기후원 약정 시) — 서명 */
  'SUPPORT_AGREEMENT',
  /** 자원봉사 신청서 — 서명 */
  'VOLUNTEER_APPLICATION',
  /** 후원 감사장(일시·첫 후원) */
  'THANKS_LETTER',
  /** 정기후원 감사장(누적 이정표) */
  'RECURRING_THANKS',
  /** 연말 감사장(영수증 발급과 함께) */
  'YEAR_END_THANKS',
  /** 자원봉사 활동 확인서 */
  'VOLUNTEER_CONFIRMATION',
  /** 자원봉사 감사장(누적 시간 이정표) */
  'VOLUNTEER_THANKS',
  /**
   * 정기후원 변경·해지 신청서. **자동 발송 경로가 없다**(점검 A 낮음 — 결정: 문서화).
   * 정기후원 변경은 후원자 본인이 마이페이지에서 하고 그 결과는 약정서 새 판(SUPPORT_AGREEMENT)으로 서명받는다.
   * 이 서식은 기관이 서면 변경·해지 신청을 따로 받을 때 전자문서 센터에서 직접 보내는 용도로만 쓴다.
   */
  'RECURRING_CHANGE',
  /** 후원금 사용 결과(사업 진행) 보고 — 정보성, 서명 없음 (2026-11-09 3차 H1). 담당자 승인 후 승인 대기함 배치로만 보낸다. */
  'IMPACT_REPORT',
  /** 후원금 수입·사용 연 1회 통보 — 정보성, 서명 없음 (2026-11-09 3차 H2, 재무·회계 규칙 제41조의5 — 법령 서식과 대조 필요) */
  'ANNUAL_DONATION_NOTICE',
  /**
   * 초상권 이용 동의서(2026-11-11 G). 콘텐츠 소재에 얼굴이 나온 봉사자·직원·행사 참가자에게 받는다 — 서명.
   * 자동 발송 경로가 없다(전자문서 센터에서 직접 보낸다). 소재는 이 용도의 서명 요청(보냈거나 완료)과 연결해야 콘텐츠에 쓸 수 있다.
   */
  'PORTRAIT_CONSENT',
  /**
   * 개인정보 수집·이용 동의서(2026-11-12 4차 J2) — 서명. 자동 발송 경로가 없다 — 업무별 문서 묶음(정기후원·봉사 신청)으로만 보낸다.
   * 기본 서식은 기존 CONSENT_PRIVACY 서식이다(용도 없는 기관 복사본이 있으면 그 서식에 용도만 붙는다).
   */
  'PRIVACY_CONSENT',
  /** 정기후원 출금 동의서(2026-11-12 4차 J2) — 서명. 계좌 번호는 문서에 적지 않는다(결제수단 등록 화면). 묶음으로만 보낸다. */
  'DEBIT_CONSENT',
] as const;

/** 저니·소비자가 자동으로 보내지 않는 용도(기관이 전자문서 센터에서 직접 보낸다) */
export const MANUAL_ONLY_PURPOSES: readonly DocumentPurpose[] = ['RECURRING_CHANGE', 'PORTRAIT_CONSENT', 'PRIVACY_CONSENT', 'DEBIT_CONSENT'];
export type DocumentPurpose = (typeof DOCUMENT_PURPOSES)[number];

export const DOCUMENT_PURPOSE_LABEL: Record<DocumentPurpose, string> = {
  SUPPORT_AGREEMENT: '후원 약정서',
  VOLUNTEER_APPLICATION: '자원봉사 신청서',
  THANKS_LETTER: '후원 감사장',
  RECURRING_THANKS: '정기후원 감사장',
  YEAR_END_THANKS: '연말 감사장',
  VOLUNTEER_CONFIRMATION: '자원봉사 활동 확인서',
  VOLUNTEER_THANKS: '자원봉사 감사장',
  RECURRING_CHANGE: '정기후원 변경·해지 신청서',
  IMPACT_REPORT: '후원금 사용 결과 보고',
  ANNUAL_DONATION_NOTICE: '후원금 수입·사용 연간 통보',
  PORTRAIT_CONSENT: '초상권 이용 동의서',
  PRIVACY_CONSENT: '개인정보 수집·이용 동의서',
  DEBIT_CONSENT: '정기후원 출금 동의서',
};

/** 머지 필드 값. 기관명·대표자·발급일은 모듈이 채운다. 금액은 원 단위 정수. */
export interface MergeContext {
  donorName?: string | null;
  amount?: bigint | null;
  totalAmount?: bigint | null;
  count?: number | null;
  date?: string | null;
  campaignTitle?: string | null;
  dayOfMonth?: number | null;
  activityTitle?: string | null;
  activityDate?: string | null;
  activityHours?: number | null;
  totalHours?: number | null;
  taxYear?: number | null;
  receiptNo?: string | null;
  assignment?: string | null;
  /** 2026-11-09 3차 H: 사업 진행 기록 제목·결과 본문(캠페인 전체)·본인 참여 합계 문장·기관 전체 사용 요약 */
  reportTitle?: string | null;
  reportBody?: string | null;
  participation?: string | null;
  usageSummary?: string | null;
  /** 2026-11-12 4차 J: 가린 연락처(예: 010-****-5678). 비우면 발급 때 후원자 행의 가린 번호로 채운다 */
  phoneMasked?: string | null;
}

export interface IssuePurposeDocumentInput {
  merchantId: string;
  purpose: DocumentPurpose;
  payerId: string;
  context: MergeContext;
  /** 원천(결제·약정·봉사 신청·활동·영수증) */
  subject?: { type: string; id: string };
  dedupeKey: string;
  /** false 면 만들기만 하고 안내 문자는 보내지 않는다 */
  notify?: boolean;
  /** 본문을 서식 머지 대신 이 값으로(약정서 스냅샷 본문 — 내부 전자서명). 파일 서식 PDF 는 그대로 머지한다. */
  bodyOverride?: string;
}

export type IssuePurposeDocumentResult =
  | { ok: true; issuedId: string; link: string | null; already?: boolean; signature: boolean }
  | {
      ok: false;
      reason: string;
      blocked?: 'DISABLED' | 'NO_TEMPLATE' | 'EDOC_BALANCE' | 'WITHDRAWN' | 'NOT_READY' | 'PREFLIGHT';
      /** 일시 오류(예외)로 만들지 못함 — 다시 시도하면 될 수 있다(2026-11-13 점검 A-M1). 저니 문서 단계는 재시도한다. */
      transient?: true;
    };

/** 발송 전 점검(document-preflight)에서 막혔을 때 사유 앞머리. 저니 기록·승인 대기함이 이 말로 "막힌 일" 을 찾는다. */
export const PREFLIGHT_BLOCK_PREFIX = '발송 전 점검에서 막혔습니다';

/**
 * 용도별 문서 발송(2단계 구현: issued-documents.ts). 이 파일은 계약만 두고 구현은 늦게 불러온다
 * (구현이 전자문서·문자 모듈을 가져오므로, 이 파일을 import 하는 쪽이 순환 참조에 걸리지 않게).
 *
 *  - 서명 불필요 용도: link = 열람 링크(/l/[토큰]). 안내 문자를 보냈으면 이 링크다.
 *  - 서명 필요 용도: link = null(서명 링크는 전자문서 센터가 본인 번호로 보낸다), signature = true, issuedId = 발급 대장 id.
 *  - already: true 면 link 는 null 이다(토큰 원문은 저장하지 않는다).
 */
export async function issuePurposeDocument(input: IssuePurposeDocumentInput): Promise<IssuePurposeDocumentResult> {
  const { issuePurposeDocumentImpl } = await import('./issued-documents');
  return issuePurposeDocumentImpl(input);
}

/** 약정서·신청서(agreement_document) 한 판의 서명 요청 발송 키. 내부 전자서명과 저니가 같은 키를 쓰면 한 번만 보낸다. */
export function agreementSignDedupeKey(agreementDocId: string): string {
  return `agreement:${agreementDocId}`;
}
