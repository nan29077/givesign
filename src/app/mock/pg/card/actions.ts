'use server';

import { redirect } from 'next/navigation';
import { isLocal, contractIntegrations } from '@/lib/env';
import { completeCardCheckout } from '@/server/services/card-payment';

/** 모의 카드 결제창의 승인·취소(2026-11-13 5차 L2). 실카드 공급자 환경에서는 닫힌다. */
function assertMockCardAllowed() {
  if (!(isLocal || contractIntegrations().cardProvider === 'mock')) throw new Error('이 환경에서는 모의 카드 결제창을 사용할 수 없습니다.');
}

export async function mockCardDecision(formData: FormData) {
  assertMockCardAllowed();
  const sessionId = String(formData.get('session') ?? '');
  const cancel = String(formData.get('decision') ?? '') === 'cancel';
  const r = await completeCardCheckout({ sessionId, cancel });
  redirect(`/mock/pg/card?session=${encodeURIComponent(sessionId)}&result=${encodeURIComponent(r.message)}`);
}
