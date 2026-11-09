import { env } from '@/lib/env';

/** 도입 시험 안내용 — 결제·문자 수신 공급자가 mock 인가(2026-11-12 4차 I). 시험 자체는 공급자와 무관하게 항상 샌드박스다. */
export function isMockPaymentProvider() {
  return env.payment.provider === 'mock';
}

export function isMockMoProvider() {
  return env.mo.provider === 'mock' && !env.emma.enabled;
}
