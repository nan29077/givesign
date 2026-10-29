import type { Metadata } from 'next';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { TermsArticle, TermsNav } from '@/components/public/terms-article';
import { currentTermsDoc } from '@/server/services/terms';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '서비스 이용약관',
  description: '기브싸인 문자후원 서비스 이용약관입니다.',
};

export default async function TermsPage() {
  // 시행일이 지난 것 중 최신 1건이 현행 약관이다(시행 예정 개정안은 아직 보여주지 않는다).
  const doc = await currentTermsDoc('TERMS_SERVICE');

  return (
    <PublicShell>
      <PageHeader eyebrow="약관" title="서비스 이용약관" description="기브싸인 문자후원 서비스의 이용조건과 절차입니다." />
      <TermsNav current="terms" />
      <TermsArticle doc={doc} />
    </PublicShell>
  );
}
