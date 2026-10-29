'use server';

import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { completePinAuthorization } from '@/server/services/pin-authorization';
import { assertMockPaymentAllowed } from '@/server/mock-guard';

/**
 * 모의 PIN 화면 전용 서버 액션.
 *
 * 실제 연동에서는 결제사 화면에서 PIN 을 입력하고 결제사가 콜백을 보낸다.
 * 이 액션은 그 콜백과 **같은 함수**(completePinAuthorization)를 호출하므로,
 * 중복 처리 방어도 동일하게 적용된다.
 */

export interface MockPinResult {
  ok: boolean;
  message: string;
  transactionNo?: string;
  amountText?: string;
  merchantName?: string;
}

export async function submitMockPinAction(sessionId: string, pin: string): Promise<MockPinResult> {
  // 실제 결제사가 연결된 환경에서는 이 액션 자체를 열지 않는다.
  // (세션 ID 만 알면 PIN 인증을 건너뛰고 출금이 일어날 수 있다)
  assertMockPaymentAllowed();

  const digits = String(pin ?? '').replace(/[^0-9]/g, '');
  if (digits.length !== 6) {
    return { ok: false, message: 'PIN 6자리를 입력해 주세요.' };
  }

  const result = await completePinAuthorization({
    sessionId: String(sessionId ?? ''),
    resultCode: 'MOCK',
    resultMessage: '[MOCK] 모의 PIN 화면에서 인증 완료',
  });

  if (!result.chargeId) return { ok: result.ok, message: result.message };

  const charge = await prisma.charge.findUnique({
    where: { id: result.chargeId },
    select: { transactionNo: true, amount: true, merchant: { select: { displayName: true } } },
  });

  return {
    ok: result.ok,
    message: result.message,
    transactionNo: charge?.transactionNo,
    amountText: charge ? `${formatNumber(charge.amount)}원` : undefined,
    merchantName: charge?.merchant.displayName,
  };
}
