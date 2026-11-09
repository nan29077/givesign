import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { Card, EmptyState } from '@/components/ui';
import { receivedDocuments } from '@/server/services/donor-documents';
import { ReceivedDocumentsList } from '@/components/self-service/received-documents';

export const dynamic = 'force-dynamic';

/**
 * 받은 문서 — 기관이 보낸 감사장·확인서(열람 링크가 만료돼도 여기서 다시 연다), 서명 요청,
 * 약정서·신청서(서명 완료본 · 동의 기록으로 성립한 판) (2026-11-09 2차 F 에 약정서 추가).
 */
export default async function MyDocumentsPage() {
  const { payerId } = await requirePayerContext('/my/documents');
  if (!payerId) return <EmptyState title={NO_PAYER_TITLE} description={NO_PAYER_DESC} />;
  const docs = await receivedDocuments(payerId);
  return (
    <Card>
      <h2 className="text-[18px] font-black text-ink-900">받은 문서</h2>
      <p className="mt-1 text-[15px] leading-relaxed text-ink-500">기관이 보낸 감사장·활동 확인서와 정기후원 약정서입니다. 문자 링크의 열람 기간이 지나도 여기서 다시 열 수 있습니다. 기부금영수증은 영수증 탭에서 확인해 주세요.</p>
      <ReceivedDocumentsList docs={docs} base="/my" showMerchant />
    </Card>
  );
}
