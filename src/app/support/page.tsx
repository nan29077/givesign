import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ShieldAlert, Clock, FileText } from 'lucide-react';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { SupportForm } from '@/components/public/support-form';
import { BannerStrip } from '@/components/public/banner-strip';
import { Card, CardTitle, Notice, LinkButton } from '@/components/ui';

export const metadata: Metadata = {
  title: '고객센터',
  description: '결제 취소·환불, 계좌 등록, 결제 오류, 후원 반영 문제를 접수합니다.',
};

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ tx?: string; intent?: string }>;
}) {
  const sp = await searchParams;
  const tx = (sp.tx ?? '').slice(0, 64);

  // 도입 상담은 전용 페이지(/business)로 분리했다.
  // 예전 링크·북마크가 이 화면의 고객센터 문의 접수로 떨어지지 않게 넘겨준다.
  if (sp.intent === 'onboarding') redirect('/business');

  return (
    <PublicShell aside={<SupportAside />}>
      <PageHeader
        eyebrow="고객센터"
        title="문의 접수"
        description="문의 유형과 내용을 남겨주시면 담당자가 확인 후 답변드립니다. 결제 관련 문의는 거래번호를 함께 적어주세요."
      />

      <BannerStrip position="SUPPORT_TOP" className="mb-4" />

      <Notice tone="brand" title="문의 전에 확인해 주세요">
        계좌 등록, 한도, 환불 조건은 이용방법과 자주 묻는 질문에 정리되어 있습니다. 급한 결제 오류는 거래번호와 함께
        접수해 주시면 우선 확인합니다. 서비스에 기브싸인을 도입하려면{' '}
        <Link href="/business" className="font-bold text-brand-700 underline underline-offset-2">
          서비스 도입 문의
        </Link>
        를 이용해 주세요.
      </Notice>

      <div className="mt-5">
        <SupportForm defaultTransactionNo={tx || undefined} />
      </div>

      <section className="mt-8 space-y-2.5">
        <Card>
          <div className="flex gap-3">
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-50 text-brand-700">
              <ShieldAlert size={17} strokeWidth={1.7} />
            </span>
            <div>
              <CardTitle>개인정보 보호</CardTitle>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
                문의 내용에는 계좌번호, 카드번호, 주민등록번호 등 민감정보를 절대 입력하지 마세요. 기브싸인은 문의
                과정에서 이러한 정보를 요구하지 않습니다.
              </p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex gap-3">
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-50 text-brand-700">
              <Clock size={17} strokeWidth={1.7} />
            </span>
            <div>
              <CardTitle>답변 안내</CardTitle>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
                접수된 문의는 순차적으로 처리됩니다. 현재 서비스는 준비 단계로 전화 상담 창구는 운영하지 않으며, 접수된
                내용은 운영자 화면에서 확인합니다.
              </p>
            </div>
          </div>
        </Card>
      </section>
    </PublicShell>
  );
}

function SupportAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>자주 찾는 안내</CardTitle>
        <div className="mt-3 space-y-2">
          <LinkButton href="/how-it-works" variant="secondary" size="md" className="w-full">
            이용방법
          </LinkButton>
          <LinkButton href="/faq" variant="secondary" size="md" className="w-full">
            자주 묻는 질문
          </LinkButton>
          <LinkButton href="/my" variant="secondary" size="md" className="w-full">
            내 후원 내역
          </LinkButton>
        </div>
      </Card>
      <Card>
        <div className="flex gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-50 text-brand-700">
            <FileText size={17} strokeWidth={1.7} />
          </span>
          <div>
            <CardTitle>약관 확인</CardTitle>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
              이용약관, 개인정보처리방침, 전자금융거래약관에서 권리와 절차를 확인할 수 있습니다.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
