import { getSessionUser, requireMerchant, type SessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { assertBazaarEnabled } from '@/server/services/bazaar-settings';

/**
 * 라이브 바자회 화면·액션 공용 가드.
 * 모든 진입점은 스위치를 먼저 확인한다(꺼지면 기능이 없는 것처럼 동작).
 */

export async function requireGiver() {
  await assertBazaarEnabled();
  const user = await getSessionUser();
  if (!user || user.role !== 'GIVER') throw new Error('현물 기부 회원 로그인이 필요합니다.');
  const donor = await prisma.inKindDonor.findUnique({ where: { userId: user.id } });
  if (!donor) throw new Error('기부 회원 정보를 찾을 수 없습니다.');
  return { user, donor };
}

export async function requireBazaarMerchant(): Promise<SessionUser & { merchantId: string }> {
  await assertBazaarEnabled();
  return requireMerchant();
}

/** 기관이 바자회 참여 승인 상태인지 */
export async function merchantParticipation(merchantId: string) {
  return prisma.merchantBazaar.findUnique({ where: { merchantId } });
}
