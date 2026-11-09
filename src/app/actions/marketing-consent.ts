'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { clientIpFrom } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import { findDonationOrg, getDonorMember } from '@/server/services/donor-members';
import { setDonorMemberMarketing, setMarketingConsent } from '@/server/services/marketing-consent';
import type { DonorActionState } from '@/app/actions/donor';

/**
 * (선택) 기관 소식·후원 안내 수신 동의 켜고 끄기 (2026-11-09).
 *  - 통합 후원자: /my/agreements (기관별)
 *  - 기관 후원 회원: /donate/[코드]/my (그 기관만)
 * 월간 후원 안내 수신 거부(toggleNoticeOptOutAction)와 다른 설정이다.
 */

async function meta() {
  const h = await headers();
  return { ip: clientIpFrom((n) => h.get(n)) ?? null, userAgent: h.get('user-agent') };
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

export async function toggleMarketingConsentAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const user = await getSessionUser();
  const payer = user ? await prisma.payerProfile.findUnique({ where: { userId: user.id }, select: { id: true } }) : null;
  if (!payer) return { ok: false, message: '휴대폰 번호가 연결된 후원자 정보가 없습니다. 내 정보에서 휴대폰 번호를 먼저 연결해 주세요.' };
  const merchantId = text(f, 'merchantId');
  const agree = text(f, 'agree') === '1';
  // 이 후원자와 이미 이어진 기관만 바꾼다(아무 기관 id 로 연결 행을 만들지 않게).
  const link = await prisma.payerMerchantLink.findUnique({ where: { payerId_merchantId: { payerId: payer.id, merchantId } }, select: { id: true } });
  if (!link) return { ok: false, message: '후원·봉사로 이어진 기관이 아닙니다.' };
  try {
    await setMarketingConsent({ payerId: payer.id, merchantId, agree, source: 'MY', ...(await meta()) });
  } catch (e) {
    logger.error('소식 수신 동의 변경 실패', { message: (e as Error).message });
    return { ok: false, message: '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
  revalidatePath('/my/agreements');
  return { ok: true, message: agree ? '이 기관의 소식·후원 안내 수신에 동의했습니다.' : '이 기관의 소식·후원 안내 수신 동의를 철회했습니다.' };
}

export async function donorMarketingToggleAction(_prev: DonorActionState, f: FormData): Promise<DonorActionState> {
  const org = await findDonationOrg(text(f, 'code'));
  const member = org ? await getDonorMember(org) : null;
  if (!org || !member) return { ok: false, message: '로그인이 필요합니다.' };
  const agree = text(f, 'agree') === '1';
  try {
    await setDonorMemberMarketing(member.id, agree, await meta());
  } catch (e) {
    logger.error('후원 회원 소식 수신 동의 변경 실패', { message: (e as Error).message });
    return { ok: false, message: '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
  revalidatePath(`/donate/${org.code}/my`);
  return { ok: true, message: agree ? `${org.displayName} 소식·후원 안내 수신에 동의했습니다.` : `${org.displayName} 소식·후원 안내 수신 동의를 철회했습니다.` };
}
