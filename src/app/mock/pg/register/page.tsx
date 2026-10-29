import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Logo } from '@/components/brand/logo';
import { MockRegisterForm } from './mock-register-form';
import { isMockPaymentAllowed } from '@/server/mock-guard';

/**
 * Mock 결제창 (헥토파이낸셜 내통장결제 결제창 대체 화면).
 *
 * 실제 연동 시
 *  - 이 화면은 제거되고, 헥토파이낸셜이 제공하는 결제창(계좌 인증 + 출금이체 등록)으로 대체된다.
 *  - 계좌번호/인증 정보는 헥토 결제창에서만 입력되며 기브싸인 서버로 전달되지 않는다.
 *  - 여기서 입력한 값은 어떤 금융기관에도 전송되지 않으며 저장되지 않는다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '테스트용 모의 결제창',
  robots: { index: false, follow: false },
};

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export default async function MockPgRegisterPage({ searchParams }: { searchParams: Promise<Search> }) {
  // 실결제 환경에서는 존재하지 않는 화면으로 취급한다.
  if (!isMockPaymentAllowed()) notFound();

  const sp = await searchParams;
  const tid = one(sp.tid);
  const ref = one(sp.ref);
  const returnUrl = one(sp.return);

  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-6">
      <div className="app-column">
        <div className="mb-4 flex items-center justify-between">
          <Logo />
          <span className="text-[11px] font-semibold text-ink-300">모의 결제창</span>
        </div>
        <MockRegisterForm tid={tid} ref_={ref} returnUrl={returnUrl} />
      </div>
    </main>
  );
}
