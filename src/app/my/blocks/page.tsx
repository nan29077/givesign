import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Card, CardTitle, Badge, EmptyState, Notice, LinkButton } from '@/components/ui';
import { BlockToggle } from '@/components/my/block-toggle';
import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function MyBlocksPage() {
  const { payerId } = await requirePayerContext('/my/blocks');
  if (!payerId) {
    return (
      <EmptyState
        title={NO_PAYER_TITLE}
        description={NO_PAYER_DESC}
        action={
          <LinkButton href="/my/account#phone-link" size="sm">
            휴대폰 번호 연결하기
          </LinkButton>
        }
      />
    );
  }

  // 후원자가 건 차단(payerBlockedAt)과 사회복지기관이 건 차단(blockedPayer)은 별개다.
  // 이 화면에서 해제할 수 있는 것은 후원자 본인이 건 차단뿐이다.
  const [links, blockedByMerchants] = await Promise.all([
    prisma.payerMerchantLink.findMany({
      where: { payerId },
      orderBy: [{ payerBlockedAt: { sort: 'desc', nulls: 'last' } }, { lastDonatedAt: 'desc' }],
      select: {
        id: true,
        payerBlockedAt: true,
        totalAmount: true,
        totalCount: true,
        lastDonatedAt: true,
        merchantId: true,
        merchant: { select: { displayName: true, code: true, status: true } },
      },
    }),
    prisma.blockedPayer.findMany({ where: { payerId }, select: { merchantId: true } }),
  ]);
  const merchantBlocked = new Set(blockedByMerchants.map((b) => b.merchantId));

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/my/account"
          className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-ink-400 transition-colors hover:text-ink-900"
        >
          <ChevronLeft size={14} strokeWidth={1.8} />
          내 정보로 돌아가기
        </Link>
        <h2 className="mt-1 text-[18px] font-black tracking-[-0.025em] text-ink-900">결제 차단</h2>
      </div>
      <Notice tone="brand" title="사회복지기관별 결제 차단">
        차단하면 해당 사회복지기관에 보낸 문자는 결제로 접수되지 않습니다. 실수로 반복 발송하는 것을 막고 싶을 때
        사용하세요. 차단은 언제든 해제할 수 있습니다.
      </Notice>

      {links.length === 0 ? (
        <EmptyState
          title="결제한 사회복지기관이 없습니다"
          description="문자후원를 이용하면 사회복지기관별 차단을 설정할 수 있습니다."
        />
      ) : (
        <div className="space-y-2.5">
          {links.map((l) => {
            const blocked = Boolean(l.payerBlockedAt);
            const blockedByMerchant = merchantBlocked.has(l.merchantId);
            return (
              <Card key={l.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-[14.5px] font-bold text-ink-900">
                        {l.merchant.status === 'APPROVED' ? (
                          <Link href={`/c/${l.merchant.code}`} className="hover:text-brand-700">
                            {l.merchant.displayName}
                          </Link>
                        ) : (
                          l.merchant.displayName
                        )}
                      </p>
                      {blocked ? <Badge tone="danger">차단됨</Badge> : null}
                      {blockedByMerchant ? <Badge tone="neutral">사회복지기관이 차단함</Badge> : null}
                      {!blocked && !blockedByMerchant ? <Badge tone="success">결제 가능</Badge> : null}
                    </div>
                    <p className="mt-1 text-[12.5px] text-ink-400">
                      누적 {formatWon(l.totalAmount)} · {formatNumber(l.totalCount)}건
                      {l.lastDonatedAt ? ` · 최근 ${formatKst(l.lastDonatedAt, false)}` : ''}
                    </p>
                    {blocked ? (
                      <p className="mt-1 text-[12px] text-ink-400">차단 일시 {formatKst(l.payerBlockedAt, false)}</p>
                    ) : null}
                  </div>
                  <div className="shrink-0">
                    <BlockToggle linkId={l.id} blocked={blocked} />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardTitle>전체 이용을 중단하고 싶다면</CardTitle>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          모든 사회복지기관에 대한 문자후원를 멈추려면 등록 계좌 관리에서 자동출금 동의를 해지해 주세요.
        </p>
        <LinkButton href="/my/account" variant="secondary" size="md" className="mt-3">
          등록 계좌 관리
        </LinkButton>
      </Card>
    </div>
  );
}
