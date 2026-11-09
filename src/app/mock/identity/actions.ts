'use server';

import { redirect } from 'next/navigation';
import { isLocal, contractIntegrations } from '@/lib/env';
import { completeIdentityVerification } from '@/server/services/identity';

/** 모의 본인인증 완료(2026-11-13 5차 L1). 실공급자 환경에서는 닫힌다. 입력값은 저장하지 않고 해시만 남는다. */
export async function mockIdentitySubmit(formData: FormData) {
  if (!(isLocal || contractIntegrations().identityProvider === 'mock')) throw new Error('이 환경에서는 모의 본인인증을 사용할 수 없습니다.');
  const req = String(formData.get('req') ?? '');
  const r = await completeIdentityVerification({
    requestToken: req,
    payload: {
      name: String(formData.get('name') ?? ''),
      birthDate: String(formData.get('birthDate') ?? ''),
      phone: String(formData.get('phone') ?? ''),
      cancel: String(formData.get('decision') ?? '') === 'cancel' ? '1' : '',
    },
  });
  if (r.ok) redirect(r.returnPath);
  redirect(`/mock/identity?req=${encodeURIComponent(req)}&error=${encodeURIComponent(r.message)}${r.returnPath ? `&back=${encodeURIComponent(r.returnPath)}` : ''}`);
}
