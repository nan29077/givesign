import { kstStartOfDay } from '@/lib/datetime';
import type { ChargeStatus } from '@/generated/prisma/enums';

/**
 * 사회복지기관 관리자 공용 상수/헬퍼.
 * (공용 lib 을 수정하지 않기 위해 studio 전용으로 분리한다)
 */

/**
 * 기간 필터의 시작 시각.
 *
 * **화면과 CSV 라우트가 반드시 이 함수를 함께 써야 한다.**
 * 'today' 를 서버 로컬 자정(`setHours(0,0,0,0)`)으로 계산하면 운영(UTC)에서
 * KST 00:00~08:59 결제가 통째로 빠져, 화면 건수와 내려받은 파일이 어긋난다.
 *
 * 알 수 없는 값은 null(전체 기간)이 아니라 호출부에서 먼저 걸러야 한다.
 */
export function periodStart(period: string, now: Date = new Date()): Date | null {
  if (period === 'today') return kstStartOfDay(now);
  if (period === '7d') return new Date(now.getTime() - 7 * 86_400_000);
  if (period === '30d') return new Date(now.getTime() - 30 * 86_400_000);
  if (period === '90d') return new Date(now.getTime() - 90 * 86_400_000);
  return null;
}

/** 화이트리스트에 없는 기간 값은 기본값으로 바꾼다(셀렉트 표시와 실제 조회가 어긋나지 않게). */
export function normalizePeriod(raw: string, allowed: readonly string[], fallback: string): string {
  return allowed.includes(raw) ? raw : fallback;
}

/** 후원 내역 화면·CSV 가 허용하는 기간 값 */
export const CHARGE_PERIODS = ['today', '7d', '30d', 'all'] as const;
/** 후원 처리 화면·CSV 가 허용하는 기간 값 */
export const ORDER_PERIODS = ['7d', '30d', '90d', 'all'] as const;

/** 결제가 승인되어 정산 대상이 되는 결제 상태 */
export const PAID_STATUSES: ChargeStatus[] = [
  'PAYMENT_SUCCESS',
  'BROADCAST_PENDING',
  'BROADCASTED',
  'PARTIAL_DELIVERY_FAILED',
  'SETTLEMENT_PENDING',
  'SETTLED',
];

/**
 * 주문(배송·반품) 화면이 다루는 결제 상태.
 *
 * 환불을 요청했거나 환불이 끝난 주문도 회수·반품 처리가 남아 있으므로 목록에서 사라지면 안 된다.
 * 정산 집계용 PAID_STATUSES 와는 의도적으로 분리한다(환불 건은 정산 대상이 아니다).
 */
export const ORDER_CHARGE_STATUSES: ChargeStatus[] = [
  ...PAID_STATUSES,
  'REFUND_REQUESTED',
  'REFUNDED',
];

/**
 * 사회복지기관 1곳이 등록할 수 있는 상품 수 상한(종류별).
 * 서버 액션과 등록 화면이 같은 값을 봐야 "등록을 눌러야 상한을 알게 되는" 일이 없다.
 */
export const MAX_CHARGE_PRODUCTS = 12;

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

export function one(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

/** 쿼리스트링을 유지하면서 일부 값만 바꾼다 */
export function buildQuery(base: Record<string, string>, patch: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v) sp.set(k, v);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '') sp.delete(k);
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
