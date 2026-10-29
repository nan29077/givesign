import { env, isLocal } from '@/lib/env';

/**
 * mock 화면/액션 접근 가드.
 *
 * 왜 필요한가
 *  - `/mock/pg/pin` 의 서버 액션은 결제사 콜백과 **같은 함수**(completePinAuthorization)를
 *    호출한다. 실제 결제사가 연결된 환경에서 이 액션이 열려 있으면 세션 ID 만 알면
 *    PIN 인증을 건너뛰고 출금을 일으킬 수 있다.
 *  - 따라서 "실제 결제사가 붙어 있는 환경"에서는 mock 경로를 전부 닫는다.
 *
 * 허용 조건
 *  - APP_ENV=local (개발/검수), 또는
 *  - 해당 어댑터가 실제로 mock 모드인 환경.
 *    mock 링크 자체가 mock 어댑터에서만 발급되므로, provider 가 mock 이 아니면
 *    이 화면으로 들어올 정상 경로가 존재하지 않는다.
 *
 * 운영(APP_ENV=prod)은 부팅 점검(assertProductionSafety)에서 PAYMENT_PROVIDER=mock 을
 * 이미 거부하므로 두 조건 모두 거짓이 되어 완전히 닫힌다.
 */

export function isMockPaymentAllowed(): boolean {
  return isLocal || env.payment.provider === 'mock';
}

/** 서버 액션용. 허용되지 않으면 즉시 예외를 던진다(fail-closed). */
export function assertMockPaymentAllowed(): void {
  if (isMockPaymentAllowed()) return;
  throw new Error('이 환경에서는 모의 결제 화면을 사용할 수 없습니다.');
}
