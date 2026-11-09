import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CreditCard } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { Card, Notice } from '@/components/ui';
import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { isLocal, contractIntegrations } from '@/lib/env';
import { mockCardDecision } from './actions';

/**
 * 모의 카드 결제창(2026-11-13 5차 L2). 실카드 PG 연동 전 검수용이다 — 카드 번호를 받지 않고, 어떤 카드사에도 보내지 않는다.
 * 금액 끝자리로 결과가 갈린다(999 거절 · 888 지연 후 승인 · 777 지연 후 실패 · 666 결과 미확인 · 444 취소 실패).
 */

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '테스트용 모의 카드 결제창', robots: { index: false, follow: false } };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

export default async function MockCardPage({ searchParams }: { searchParams: Promise<Search> }) {
  if (!(isLocal || contractIntegrations().cardProvider === 'mock')) notFound();
  const sp = await searchParams;
  const sessionId = one(sp.session);
  const result = one(sp.result);
  const session = sessionId ? await prisma.cardCheckoutSession.findUnique({ where: { sessionId } }) : null;
  const charge = session ? await prisma.charge.findUnique({ where: { id: session.chargeId }, select: { merchant: { select: { displayName: true } } } }) : null;

  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-6">
      <div className="app-column">
        <div className="mb-4 flex items-center justify-between">
          <Logo />
          <span className="text-[11px] font-semibold text-ink-300">모의 카드 결제창</span>
        </div>
        <div className="mb-3">
          <Notice tone="warning" title="[MOCK] 실제 카드사 화면이 아닙니다">
            카드 PG 연동규격 수령 전까지 쓰는 테스트 화면입니다. 카드 정보를 받지 않으며 실제 승인·출금은 일어나지 않습니다.
          </Notice>
        </div>
        {result ? (
          <Card className="mb-3">
            <p className="text-[14px] font-bold text-ink-900">{result}</p>
          </Card>
        ) : null}
        {!session || !charge ? (
          <Card>
            <p className="text-[15px] font-extrabold text-ink-900">결제 세션을 찾을 수 없습니다</p>
            <p className="mt-2 text-[13px] text-ink-500">링크가 잘못되었거나 이미 처리된 요청입니다. 결제는 진행되지 않았습니다.</p>
          </Card>
        ) : (
          <Card>
            <div className="flex items-center gap-2">
              <CreditCard size={18} strokeWidth={1.7} className="text-brand-700" />
              <p className="text-[15px] font-extrabold text-ink-900">{charge.merchant.displayName} 카드 후원</p>
            </div>
            <p className="mt-2 text-[22px] font-extrabold text-brand-700">{formatNumber(session.amount)}원</p>
            <p className="mt-1 text-[13px] text-ink-500">카드는 일시후원만 됩니다. 상태: {session.status}</p>
            {session.status === 'PENDING' ? (
              <form action={mockCardDecision} className="mt-4 grid gap-2">
                <input type="hidden" name="session" value={session.sessionId} />
                <button type="submit" name="decision" value="approve" className="h-12 rounded-xl bg-brand-400 text-[15px] font-extrabold text-ink-900 hover:bg-brand-500">[MOCK] 카드 인증 완료</button>
                <button type="submit" name="decision" value="cancel" className="h-11 rounded-xl border border-ink-200 bg-white text-[14px] font-bold text-ink-700">결제 취소</button>
              </form>
            ) : null}
          </Card>
        )}
      </div>
    </main>
  );
}
