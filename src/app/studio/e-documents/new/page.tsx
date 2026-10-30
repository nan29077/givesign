import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, LinkButton, Notice } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { EDocComposeFields } from '@/components/studio/edoc-compose';
import { createEDocEnvelopeAction } from '@/app/actions/edoc';
import { EDOC_MAX_SIGNERS } from '@/server/services/edoc';
import { walletOverview } from '@/server/services/edoc-billing';
import { edocUseSourceLabel, pickUseSource } from '@/lib/edoc-billing';
import { newId } from '@/lib/id';
import { composeTemplates } from '../_data';

export const dynamic = 'force-dynamic';

/** 서명 요청 보내기 (1건). */
export default async function NewEDocPage({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const [templates, o] = await Promise.all([composeTemplates(merchantId), walletOverview(merchantId)]);
  const source = pickUseSource({ subscription: o.subscription, trialRemaining: o.wallet.trialRemaining, balance: o.wallet.balance, perDocument: o.plan.perDocument });
  const chargeText = source
    ? `${edocUseSourceLabel[source]}에서 1건${source === 'PREPAID' ? `(${o.plan.perDocument.toLocaleString('ko-KR')}원)` : ''}을 차감합니다.`
    : null;

  return (
    <>
      <PageHeader title="서명 요청 보내기" description="받는 분 휴대폰으로 서명 링크가 갑니다. 받은 번호로 본인확인을 한 뒤 내용을 확인하고 서명합니다." action={<LinkButton href="/studio/e-documents" variant="secondary">전자문서 센터</LinkButton>} />
      {templates.length === 0 ? (
        <Notice tone="brand" title="먼저 서식을 등록해 주세요">
          후원약정서·자원봉사 신청서 같은 기본 서식을 고르거나 직접 만들 수 있습니다. <Link href="/studio/documents/new?type=preset" className="font-bold underline">서식 만들기</Link>
        </Notice>
      ) : !source ? (
        <Notice tone="warning" title="이용 잔액이 없습니다">
          서명 요청 1건에 {o.plan.perDocument.toLocaleString('ko-KR')}원이 필요합니다. <Link href="/studio/document-billing" className="font-bold underline">충전·정액 이용 신청</Link>
        </Notice>
      ) : (
        <Card className="max-w-3xl">
          <ActionForm
            action={createEDocEnvelopeAction}
            submitLabel="서명 요청 보내기"
            confirmTitle="서명 요청을 보낼까요?"
            confirmMessage={`${chargeText} 아무도 문서를 열기 전에 취소하면 되돌립니다.`}
            confirmActionLabel="보내기"
          >
            <input type="hidden" name="nonce" value={newId()} />
            <EDocComposeFields templates={templates} defaultTemplateId={sp.template} maxSigners={EDOC_MAX_SIGNERS} />
            <Notice tone="neutral">
              서명자는 문자로 받은 링크를 열고 받은 번호로 인증번호를 확인해야 문서를 볼 수 있습니다. 발송 시점의 서식 내용이 그대로 보관되며,
              열람·인증·서명 기록은 위변조를 확인할 수 있는 감사추적으로 남습니다. 공동인증서·공인전자문서 중계·시점확인(TSA) 연동은 하지 않았습니다.
            </Notice>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
