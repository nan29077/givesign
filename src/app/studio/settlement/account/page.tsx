import { redirect } from 'next/navigation';

/**
 * 정산 계좌 화면은 정산 관리로 통합되었다.
 * 기존 북마크·링크 호환을 위해 리다이렉트만 남긴다.
 */
export default function StudioSettlementAccountPage() {
  redirect('/studio/settlement?tab=account');
}
