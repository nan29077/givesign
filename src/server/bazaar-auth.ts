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

/**
 * 기관 콘솔 바자회 변경 작업 가드: 스위치 + 승인된 기관 + **바자회 참여 승인(APPROVED)**.
 * 참여가 정지·반려·대기인 기관은 진행 중 건의 매칭 수락·가액 확정·검수 확정(영수증 발급)·편성 승인을 할 수 없다(점검 B-5).
 * 참여 신청과 자기 참여 상태 조회만 예외다 — requireBazaarMerchantAny() 를 쓴다.
 */
export async function requireBazaarMerchant(): Promise<SessionUser & { merchantId: string }> {
  const m = await requireBazaarMerchantAny();
  const p = await merchantParticipation(m.merchantId);
  if (p?.status !== 'APPROVED') {
    throw new Error(
      p?.status === 'SUSPENDED'
        ? '라이브 바자회 참여가 정지된 기관입니다. 고객센터로 문의해 주세요.'
        : '라이브 바자회 참여 승인 후 이용할 수 있습니다.',
    );
  }
  return m;
}

/** 참여 신청·참여 상태 조회용(참여 승인 전에도 통과) */
export async function requireBazaarMerchantAny(): Promise<SessionUser & { merchantId: string }> {
  await assertBazaarEnabled();
  return requireMerchant();
}

/** 기관이 바자회 참여 승인 상태인지 */
export async function merchantParticipation(merchantId: string) {
  return prisma.merchantBazaar.findUnique({ where: { merchantId } });
}
