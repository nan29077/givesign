import { env } from '@/lib/env';
import { getPaymentAdapter } from '@/server/adapters/payment';
import { getMtAdapter } from '@/server/adapters/mt';

/**
 * 공개 화면의 "테스트 환경" 고지 판단.
 *
 * 예전에는 공개 푸터·기관 신청 폼에 "실제 결제와 문자 발송은 비활성화" 가 하드코딩되어
 * 실결제사를 연결한 운영에서도 거짓 고지가 떴다(점검 F H-2). 이제 실제 어댑터 상태를 읽어
 * 결제나 문자가 mock 으로 처리될 때만 알린다.
 */
export interface ServiceModeInput {
  safeMode: boolean;
  paymentMode: 'mock' | 'live' | 'unknown';
  mtMode: 'mock' | 'live' | 'unknown';
}

export interface ServiceMode {
  /** 실제 출금이 일어나지 않는다 */
  paymentMock: boolean;
  /** 실제 문자가 나가지 않는다 */
  mtMock: boolean;
  /** 둘 중 하나라도 테스트 처리면 true — 공개 화면 고지 기준 */
  testMode: boolean;
}

/** 순수 판단. 어댑터 상태를 알 수 없으면(설정 오류 등) 실제로 처리된다고 단정하지 않고 테스트로 본다. */
export function decideServiceMode(input: ServiceModeInput): ServiceMode {
  const paymentMock = input.safeMode || input.paymentMode !== 'live';
  const mtMock = input.safeMode || input.mtMode !== 'live';
  return { paymentMock, mtMock, testMode: paymentMock || mtMock };
}

function modeOf(read: () => { mode: string }): 'mock' | 'live' | 'unknown' {
  try {
    const m = read().mode;
    return m === 'mock' ? 'mock' : m ? 'live' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function currentServiceMode(): ServiceMode {
  // SAFE_MODE 면 어댑터를 부르지 않는다(부를 때마다 "mock 으로 대체" 경고 로그가 남는다).
  if (env.safety.safeMode) return decideServiceMode({ safeMode: true, paymentMode: 'mock', mtMode: 'mock' });
  return decideServiceMode({
    safeMode: env.safety.safeMode,
    paymentMode: modeOf(() => getPaymentAdapter().info()),
    mtMode: modeOf(() => getMtAdapter().info()),
  });
}

/** 공개 화면 고지 문구. 사실(무엇이 일어나지 않는지)만 적는다. */
export function testModeNotice(mode: ServiceMode): string | null {
  if (!mode.testMode) return null;
  if (mode.paymentMock && mode.mtMock) return '현재 테스트 환경이라 실제 출금과 문자 발송이 일어나지 않습니다.';
  if (mode.paymentMock) return '현재 테스트 환경이라 실제 출금이 일어나지 않습니다.';
  return '현재 테스트 환경이라 실제 문자 발송이 일어나지 않습니다.';
}
