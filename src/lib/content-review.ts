/**
 * 콘텐츠 승인 편의(2026-11-09) — 화면과 서비스가 같이 쓰는 값.
 */

/** 반려 이유 분류 */
export const CONTENT_REJECT_REASONS = ['FACT', 'TONE', 'PRIVACY', 'IMAGE', 'LENGTH', 'OTHER'] as const;
export type ContentRejectReason = (typeof CONTENT_REJECT_REASONS)[number];

export const CONTENT_REJECT_REASON_LABEL: Record<ContentRejectReason, string> = {
  FACT: '사실과 다른 내용',
  TONE: '표현·분위기가 맞지 않음',
  PRIVACY: '수혜자를 알아볼 수 있는 표현',
  IMAGE: '그림·사진 문제',
  LENGTH: '너무 길거나 짧음',
  OTHER: '기타',
};

/** 콘텐츠당(수정 요청 판 묶음) 하루 수정 요청 횟수 */
export const CONTENT_REVISIONS_PER_DAY = 5;
/** 수정 요청 한 줄 길이 */
export const CONTENT_REVISION_MAX_LEN = 100;
/** 한 번에 승인할 수 있는 최대 건수 */
export const CONTENT_BATCH_MAX = 50;

export const PAST_SLOT_CHOICE_LABEL = {
  NEXT_SLOT: '다음 빈 슬롯에 예약',
  NOW: '지금 게시 예약',
  APPROVE_ONLY: '승인만',
} as const;
