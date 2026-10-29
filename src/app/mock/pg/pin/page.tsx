import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Logo } from '@/components/brand/logo';
import { Card, Notice } from '@/components/ui';
import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { MockPinForm } from './mock-pin-form';
import { isMockPaymentAllowed } from '@/server/mock-guard';

/**
 * Mock PIN 입력창 (결제사 PIN 인증 화면 대체).
 *
 * 실제 연동 시
 *  - 이 화면은 제거되고, 결제사(헥토파이낸셜/카드사)가 제공하는 PIN 인증창으로 대체된다.
 *  - PIN 은 결제사 화면에서만 입력되며 기브싸인 서버로 전달되지 않는다.
 *  - 여기서 입력한 값은 어떤 금융기관에도 전송되지 않으며 저장되지 않는다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '테스트용 모의 PIN 인증창',
  robots: { index: false, follow: false },
};

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export default async function MockPgPinPage({ searchParams }: { searchParams: Promise<Search> }) {
  // 실결제 환경에서는 존재하지 않는 화면으로 취급한다.
  if (!isMockPaymentAllowed()) notFound();

  const sp = await searchParams;
  const sessionId = one(sp.session);

  const session = sessionId
    ? await prisma.paymentPinSession.findUnique({
        where: { sessionId },
        include: { charge: { include: { merchant: { select: { displayName: true } } } } },
      })
    : null;

  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-6">
      <div className="app-column">
        <div className="mb-4 flex items-center justify-between">
          <Logo />
          <span className="text-[11px] font-semibold text-ink-300">모의 PIN 인증창</span>
        </div>

        <div className="mb-3">
          <Notice tone="warning" title="[MOCK] 실제 결제사 화면이 아닙니다">
            결제사 연동규격 수령 전까지 사용하는 테스트 화면입니다. 입력한 PIN 은 어떤 금융기관에도 전송되지 않으며
            저장되지 않습니다.
          </Notice>
        </div>

        {!session ? (
          <Card>
            <p className="text-[15px] font-extrabold text-ink-900">인증 세션을 찾을 수 없습니다</p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
              링크가 잘못되었거나 이미 처리된 요청입니다. 결제는 진행되지 않았습니다.
            </p>
          </Card>
        ) : (
          <MockPinForm
            sessionId={session.sessionId}
            merchantName={session.charge.merchant.displayName}
            amountText={`${formatNumber(session.amount)}원`}
            message={session.charge.message}
            status={session.status}
            expiresAtIso={session.expiresAt.toISOString()}
          />
        )}
      </div>
    </main>
  );
}
