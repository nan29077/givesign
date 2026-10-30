import { requireMerchant } from '@/server/auth';

/**
 * 실물 상품·배송·문서 상품 화면은 사회복지기관 기본 업무가 아니라 숨긴다.
 * 메뉴만 숨기면 주소를 직접 쳐서 들어올 수 있으므로 FEATURE_GOODS=true 가 아니면 404 로 막는다(점검 M-18).
 */
export default async function InstitutionDocumentsLayout({ children }: { children: React.ReactNode }) {
  await requireMerchant();
  return children;
}
