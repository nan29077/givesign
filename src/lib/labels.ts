import type {
  ChargeStatus,
  DeliveryStatus,
  MoProcessResult,
  PaymentTxStatus,
  RefundStatus,
  MerchantStatus,
  MoNumberStatus,
  SettlementRequestStatus,
  LedgerEntryType,
  RiskLevel,
  RiskType,
  PayerOnboardingStatus,
  HolidayKind,
  PaymentMethodKind,
  ShipmentStatus,
} from '@/generated/prisma/enums';

export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

/** 결제수단 종류. CARD 는 스키마·로직만 준비된 상태이며 등록 화면은 아직 없다. */
export const paymentMethodKindLabel: Record<PaymentMethodKind, string> = {
  ACCOUNT: '계좌 (내통장결제)',
  CARD: '신용카드',
};

export const payerOnboardingStatusLabel: Record<PayerOnboardingStatus, { text: string; tone: Tone }> = {
  UNREGISTERED: { text: '최초 안내 전', tone: 'neutral' },
  LINK_SENT: { text: '가입 링크 발송', tone: 'warning' },
  REGISTERED: { text: '가입 완료', tone: 'success' },
  SUSPENDED: { text: '이용 중지', tone: 'danger' },
  WITHDRAWN: { text: '탈퇴', tone: 'neutral' },
};

export const chargeStatusLabel: Record<ChargeStatus, { text: string; tone: Tone }> = {
  RECEIVED: { text: '수신', tone: 'neutral' },
  PENDING_AMOUNT: { text: '금액선택대기', tone: 'brand' },
  UNREGISTERED: { text: '미등록', tone: 'warning' },
  LIMIT_BLOCKED: { text: '한도차단', tone: 'warning' },
  CONTENT_BLOCKED: { text: '내용차단', tone: 'danger' },
  PENDING_CONFIRM: { text: '확인대기', tone: 'brand' },
  PENDING_PIN: { text: 'PIN인증대기', tone: 'brand' },
  PENDING_PAYMENT: { text: '결제요청', tone: 'brand' },
  PAYMENT_SUCCESS: { text: '결제성공', tone: 'success' },
  PAYMENT_FAILED: { text: '결제실패', tone: 'danger' },
  // 아래 세 상태는 도네이도(방송 송출) 시절의 잔재다. 지금은 어떤 코드도 이 상태를
  // 결제 건에 기록하지 않는다. enum 에는 남아 있으므로 라벨은 두되, 화면 필터에는 노출하지 않는다
  // (SELECTABLE_CHARGE_STATUSES 참고). 용어도 "후원 반영" 기준으로 고쳐 둔다.
  BROADCAST_PENDING: { text: '반영대기(미사용)', tone: 'neutral' },
  BROADCASTED: { text: '반영완료(미사용)', tone: 'neutral' },
  PARTIAL_DELIVERY_FAILED: { text: '일부 반영실패(미사용)', tone: 'neutral' },
  REFUND_REQUESTED: { text: '환불요청', tone: 'warning' },
  REFUNDED: { text: '환불완료', tone: 'danger' },
  SETTLEMENT_PENDING: { text: '정산대기', tone: 'success' },
  SETTLED: { text: '정산완료', tone: 'success' },
};

/**
 * 화면의 상태 필터에 노출할 결제 상태.
 *
 * chargeStatusLabel 을 그대로 뿌리면 코드가 한 번도 기록하지 않는 상태까지 드롭다운에 뜬다.
 * 사회복지기관이 그걸 고르면 항상 0건이라 "내 후원이 반영 안 됐나" 로 오해한다.
 */
export const SELECTABLE_CHARGE_STATUSES = (Object.keys(chargeStatusLabel) as ChargeStatus[]).filter(
  (s) => s !== 'BROADCAST_PENDING' && s !== 'BROADCASTED' && s !== 'PARTIAL_DELIVERY_FAILED' && s !== 'PENDING_CONFIRM',
);

/**
 * 비실물 상품의 지급 처리 상태.
 *
 * DeliveryStatus enum 을 재사용하지만 화면 문구는 "지급" 기준이어야 한다.
 * 이 라벨을 안 쓰고 deliveryStatusLabel 을 그대로 쓰면 목록은 "지급 대기",
 * 내려받은 엑셀은 "대기" 로 나와 같은 값이 두 이름을 갖는다.
 */
export const pointStatusLabel: Record<DeliveryStatus, { text: string; tone: Tone }> = {
  PENDING: { text: '지급 대기', tone: 'warning' },
  SENT: { text: '지급 완료', tone: 'success' },
  FAILED: { text: '지급 보류', tone: 'danger' },
  SKIPPED: { text: '지급 대상 아님', tone: 'neutral' },
};

/** 실물 주문의 배송·반품 상태. 목록 필터와 상세 뱃지가 같은 값을 본다. */
export const shipmentStatusLabel: Record<ShipmentStatus, { text: string; tone: Tone }> = {
  PREPARING: { text: '배송 준비', tone: 'warning' },
  SHIPPED: { text: '발송 완료', tone: 'brand' },
  DELIVERED: { text: '배송 완료', tone: 'success' },
  CANCELED: { text: '배송 취소', tone: 'neutral' },
  RETURN_REQUESTED: { text: '반품 접수', tone: 'warning' },
  RETURNING: { text: '회수중', tone: 'warning' },
  RETURNED: { text: '반품 완료', tone: 'danger' },
  EXCHANGE_REQUESTED: { text: '교환 접수', tone: 'warning' },
  EXCHANGE_SHIPPED: { text: '교환 발송', tone: 'brand' },
};

/** 반품·교환 흐름에 속한 상태. 목록 탭을 나눌 때 쓴다. */
export const RETURN_SHIPMENT_STATUSES: ShipmentStatus[] = [
  'RETURN_REQUESTED',
  'RETURNING',
  'RETURNED',
  'EXCHANGE_REQUESTED',
  'EXCHANGE_SHIPPED',
];

/** 배송 흐름(반품 제외)에 속한 상태. */
export const DELIVERY_SHIPMENT_STATUSES: ShipmentStatus[] = ['PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELED'];

export const deliveryStatusLabel: Record<DeliveryStatus, { text: string; tone: Tone }> = {
  PENDING: { text: '대기', tone: 'neutral' },
  SENT: { text: '성공', tone: 'success' },
  FAILED: { text: '실패', tone: 'danger' },
  SKIPPED: { text: '건너뜀', tone: 'neutral' },
};

export const moResultLabel: Record<MoProcessResult, { text: string; tone: Tone }> = {
  PENDING: { text: '처리중', tone: 'neutral' },
  ROUTED: { text: '정상', tone: 'success' },
  UNKNOWN_ROUTE: { text: '대상없음', tone: 'warning' },
  DUPLICATE: { text: '중복', tone: 'neutral' },
  UNREGISTERED_DONOR: { text: '미등록', tone: 'warning' },
  BLOCKED: { text: '차단', tone: 'danger' },
  ERROR: { text: '오류', tone: 'danger' },
};

export const paymentTxStatusLabel: Record<PaymentTxStatus, { text: string; tone: Tone }> = {
  REQUESTED: { text: '요청', tone: 'neutral' },
  APPROVED: { text: '승인', tone: 'success' },
  FAILED: { text: '실패', tone: 'danger' },
  CANCELED: { text: '취소', tone: 'neutral' },
  TIMEOUT: { text: '타임아웃', tone: 'warning' },
  UNKNOWN: { text: '확인필요', tone: 'danger' },
};

export const refundStatusLabel: Record<RefundStatus, { text: string; tone: Tone }> = {
  REQUESTED: { text: '요청', tone: 'warning' },
  APPROVED: { text: '승인', tone: 'brand' },
  REJECTED: { text: '거절', tone: 'neutral' },
  DONE: { text: '완료', tone: 'success' },
  FAILED: { text: '실패', tone: 'danger' },
};

export const merchantStatusLabel: Record<MerchantStatus, { text: string; tone: Tone }> = {
  PENDING: { text: '심사대기', tone: 'warning' },
  APPROVED: { text: '승인', tone: 'success' },
  REJECTED: { text: '반려', tone: 'danger' },
  SUSPENDED: { text: '정지', tone: 'danger' },
};

export const moNumberStatusLabel: Record<MoNumberStatus, { text: string; tone: Tone }> = {
  AVAILABLE: { text: '재고', tone: 'neutral' },
  RESERVED: { text: '예약', tone: 'warning' },
  ASSIGNED: { text: '배정', tone: 'success' },
  RECLAIMED: { text: '회수', tone: 'neutral' },
  DISABLED: { text: '중지', tone: 'danger' },
};

export const settlementStatusLabel: Record<SettlementRequestStatus, { text: string; tone: Tone }> = {
  REQUESTED: { text: '요청', tone: 'warning' },
  REVIEWING: { text: '검토중', tone: 'brand' },
  APPROVED: { text: '승인', tone: 'brand' },
  PAID: { text: '지급완료', tone: 'success' },
  PAYOUT_FAILED: { text: '지급실패', tone: 'danger' },
  REJECTED: { text: '반려', tone: 'danger' },
};

export const ledgerEntryLabel: Record<LedgerEntryType, string> = {
  CHARGE_GROSS: '결제 총액',
  PG_FEE: '결제수수료',
  PLATFORM_FEE: '플랫폼수수료',
  REFUND: '환불',
  REFUND_FEE_RETURN: '수수료 환입',
  ADJUSTMENT: '조정',
  PAYOUT: '정산 지급',
  PAYOUT_WITHHOLDING: '원천징수',
};

export const riskLevelLabel: Record<RiskLevel, { text: string; tone: Tone }> = {
  LOW: { text: '낮음', tone: 'neutral' },
  MEDIUM: { text: '보통', tone: 'warning' },
  HIGH: { text: '높음', tone: 'danger' },
  CRITICAL: { text: '심각', tone: 'danger' },
};

export const riskTypeLabel: Record<RiskType, string> = {
  VELOCITY: '연속 결제',
  DAILY_LIMIT: '일일 한도',
  MONTHLY_LIMIT: '월간 한도',
  REPEATED_FAILURE: '반복 실패',
  NEW_DONOR: '신규 후원자',
  MANUAL_REVIEW: '수동 검수',
  DUPLICATE_WEBHOOK: '중복 수신',
  ABNORMAL_AMOUNT: '이상 금액',
  PAYMENT_UNKNOWN: '결제결과 미확인',
};

/** 정산일(영업일) 계산에서 제외되는 공휴일 종류. */
export const holidayKindLabel: Record<HolidayKind, { text: string; tone: Tone }> = {
  STATUTORY: { text: '법정공휴일', tone: 'brand' },
  SUBSTITUTE: { text: '대체공휴일', tone: 'warning' },
  TEMPORARY: { text: '임시공휴일', tone: 'danger' },
  BANK_ONLY: { text: '은행 휴무일', tone: 'neutral' },
};

export const paymentModeLabel = {
  CONFIRM_LINK: '확인형 (MT 링크 확인 후 결제)',
  DIRECT_TRIGGER: '즉시형 (MO 수신 즉시 결제)',
  RECURRING: '정기후원 자동 출금 (약정 동의)',
} as const;

/**
 * 후원 경로(charge.channel) 표시.
 * 'WEB' 이 아니면 모두 문자(MO)로 보던 예전 표시는 정기후원 자동 출금을 MO 로 오인하게 만든다.
 */
export const chargeChannelLabel: Record<string, { short: string; long: string }> = {
  MO: { short: '문자(MO)', long: '문자(MO) 후원' },
  WEB: { short: '웹(PC)', long: '웹(PC) 후원' },
  RECURRING: { short: '정기', long: '정기후원 자동 출금' },
};

export function channelLabel(channel: string, form: 'short' | 'long' = 'short'): string {
  return (chargeChannelLabel[channel] ?? chargeChannelLabel.MO)[form];
}
