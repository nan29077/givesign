/**
 * 고객센터 문의 유형.
 * ('use server' 모듈은 async 함수만 export 할 수 있어 상수는 별도 파일로 분리한다)
 */
export const SUPPORT_CATEGORIES = [
  { value: 'REFUND', label: '결제 취소 · 환불' },
  { value: 'REGISTRATION', label: '계좌 등록 · 자동출금 동의' },
  { value: 'PAYMENT', label: '결제 오류 · 중복 결제' },
  { value: 'BROADCAST', label: '후원 반영 · 후원 내역 표시' },
  { value: 'ABUSE', label: '부적절한 이용 신고' },
  { value: 'MERCHANT', label: '사회복지기관 가입 · 정산' },
  { value: 'ETC', label: '기타 문의' },
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number]['value'];

export const SUPPORT_CATEGORY_VALUES: readonly string[] = SUPPORT_CATEGORIES.map((c) => c.value);
