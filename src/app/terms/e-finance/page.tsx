import type { Metadata } from 'next';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { TermsArticle, TermsNav } from '@/components/public/terms-article';
import { Notice } from '@/components/ui';
import { currentTermsDoc } from '@/server/services/terms';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '전자금융거래 이용약관',
  description: '전자금융거래의 이용조건, 거래내용 확인, 오류 정정 절차를 안내합니다.',
};

export default async function EFinanceTermsPage() {
  // 시행일이 지난 것 중 최신 1건이 현행 약관이다(시행 예정 개정안은 아직 보여주지 않는다).
  const doc = await currentTermsDoc('E_FINANCE');

  return (
    <PublicShell>
      <PageHeader
        eyebrow="약관"
        title="전자금융거래 이용약관"
        description="출금이체 방식의 문자후원 결제에 적용되는 약관입니다."
      />
      <TermsNav current="e-finance" />
      <TermsArticle doc={doc} />
      <div className="mt-4">
        <Notice tone="warning" title="출금이체 동의 안내">
          계좌 등록 시 출금이체에 동의하면, 이후 보내는 문자에 대해 등록한 계좌에서 결제 금액이 출금됩니다. 동의는
          마이페이지의 등록 계좌 관리에서 언제든 해지할 수 있습니다.
        </Notice>
      </div>
    </PublicShell>
  );
}
