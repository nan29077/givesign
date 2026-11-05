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
  /** 정기후원 변경·해지 신청서 */
  'RECURRING_CHANGE',
] as const;
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
}

export type IssuePurposeDocumentResult =
  | { ok: true; issuedId: string; link: string | null; already?: boolean; signature: boolean }
  | { ok: false; reason: string; blocked?: 'DISABLED' | 'NO_TEMPLATE' | 'EDOC_BALANCE' | 'WITHDRAWN' | 'NOT_READY' };

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
