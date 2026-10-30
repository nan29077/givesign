import Link from 'next/link';
import { formatMoNumber } from '@/lib/mo-number';
import {
  CircleAlert,
  CircleCheck,
  ChevronRight,
  Info,
} from 'lucide-react';
import { Badge, Card, EmptyState, LinkButton } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { BannerStrip } from '@/components/public/banner-strip';
import { PAID_STATUSES } from '@/components/studio/shared';
import { OnboardingChecklist } from '@/components/studio/onboarding-checklist';
import { ChargeCardGrid } from '@/components/studio/charge-cards';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { getStudioPendingCounts } from '@/server/services/studio-pending';
import { getSettlementSummary } from '@/server/services/settlement';
import { formatNumber, formatWon } from '@/lib/money';
import { kstMonthKey, kstStartOfDay } from '@/lib/datetime';
import { moNumberStatusLabel } from '@/lib/labels';
import { featureGoodsEnabled } from '@/lib/env';
import { campaignProgress, daysLeft } from '@/lib/fundraising';
import { ProgressBar } from '@/components/public/progress-bar';
import { listCampaigns, merchantDonationSummary, monthlyTrend } from '@/server/services/fundraising';
import { receiptCandidates } from '@/server/services/receipts';

export const dynamic = 'force-dynamic';

/**
 * 사회복지기관 대시보드.
 * 카드가 많아 어수선해지지 않도록 화면을 네 덩어리로만 나눈다.
 *   1) 핵심 수치 (오늘 + 정산)
 *   2) 연동 상태 (카드 대신 한 줄 목록)
 *   3) 최근 결제 메시지
 * 세부 관리 진입은 각 줄의 링크와 좌측 메뉴로 처리한다.
 */
export default async function StudioDashboardPage() {
  const { merchantId } = await requireMerchant();
  const todayStart = kstStartOfDay();

  const [
    todayAmount,
    todayMessages,
    todaySuccess,
    todayFailed,
    monthLedger,
    summary,
    moNumber,
    recent,
  ] = await Promise.all([
    prisma.charge.aggregate({
      where: { merchantId, receivedAt: { gte: todayStart }, status: { in: PAID_STATUSES } },
      _sum: { amount: true },
    }),
    prisma.moInboundMessage.count({ where: { merchantId, receivedAt: { gte: todayStart } } }),
    prisma.charge.count({
      where: { merchantId, receivedAt: { gte: todayStart }, status: { in: PAID_STATUSES } },
    }),
    prisma.charge.count({
      where: { merchantId, receivedAt: { gte: todayStart }, status: 'PAYMENT_FAILED' },
    }),
    prisma.settlementLedger.aggregate({
      where: {
        merchantId,
        settlementKey: kstMonthKey(),
        entryType: { notIn: ['PAYOUT', 'PAYOUT_WITHHOLDING'] },
      },
      _sum: { amount: true },
    }),
    getSettlementSummary(merchantId),
    // 배정 중인 번호를 우선 보여 준다. 나중에 배정됐다 회수된 번호가 있어도 현재 번호가 가려지지 않게.
    prisma.merchantMoNumber
      .findFirst({
        where: { merchantId, status: 'ASSIGNED' },
        orderBy: { assignedAt: 'desc' },
        select: { phoneNumber: true, keyword: true, mode: true, status: true },
      })
      .then(
        (assigned) =>
          assigned ??
          prisma.merchantMoNumber.findFirst({
            where: { merchantId },
            orderBy: { assignedAt: 'desc' },
            select: { phoneNumber: true, keyword: true, mode: true, status: true },
          }),
      ),
    prisma.charge.findMany({
      where: { merchantId },
      orderBy: { receivedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        transactionNo: true,
        displayName: true,
        message: true,
        amount: true,
        status: true,
        channel: true,
        receivedAt: true,
        anonymous: true,
        // 전화번호는 저장 시점에 마스킹된 값만 읽는다(원문/암호문은 화면으로 내리지 않는다).
        payer: { select: { phoneMasked: true } },
      },
    }),
  ]);

  // 사이드바 배지와 같은 집계다(요청 단위 캐시라 이 호출은 쿼리를 새로 돌리지 않는다).
  const [pending, activeProducts, donation, campaignsAll, trend, receiptCandidatesNow] = await Promise.all([
    getStudioPendingCounts(merchantId),
    prisma.chargeProduct.count({ where: { merchantId, active: true, archivedAt: null } }),
    merchantDonationSummary(merchantId),
    listCampaigns(merchantId),
    monthlyTrend(merchantId, 6),
    receiptCandidates(merchantId, new Date().getFullYear()),
  ]);
  const openCampaigns = campaignsAll.filter((c) => c.open);
  const receiptPending = receiptCandidatesNow.filter((c) => c.ready).length;
  const goodsEnabled = featureGoodsEnabled();
  const ordersPending = pending.orders;
  const pointsPending = pending.points;

  const moAssigned = moNumber?.status === 'ASSIGNED';

  const links: { label: string; ok: boolean; value: string; href: string }[] = [
    {
      label: 'MO 수신번호',
      ok: moAssigned,
      value: moNumber
        ? `${formatMoNumber(moNumber.phoneNumber)}${moNumber.keyword ? ` (${moNumber.keyword})` : ''} · ${moNumberStatusLabel[moNumber.status].text}`
        : '배정된 번호 없음',
      href: '/studio/messages',
    },
  ];

  // 연동 미완료 항목이 있으면 최상단에 '다음 할 일' 로 안내한다 (온보딩 완주 유도)
  const nextStep = links.find((l) => !l.ok) ?? null;

  return (
    <>
      <PageHeader
        title="대시보드"
        description="오늘 들어온 문자후원과 모금 현황, 연동 상태를 한눈에 확인합니다. (KST 기준)"
        action={
          <LinkButton href="/studio/charges" variant="secondary" size="sm">
            후원 내역 전체 보기
          </LinkButton>
        }
      />

      <div className="space-y-4">
        <BannerStrip position="CONSOLE_TOP" />

        {/* 0) 신규 사회복지기관 온보딩 체크리스트 — 모두 완료되면 스스로 사라진다 */}
        <OnboardingChecklist merchantId={merchantId} />

        {/* 0-1) 모금 현황 — 후원 업무의 첫 화면. 캠페인 진행률과 정기후원·영수증 준비 상태로 바로 간다. */}
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <TodoTile href="/studio/campaigns" label="모금 중 캠페인" value={openCampaigns.length} unit="개" hint={openCampaigns.length ? `${formatWon(openCampaigns.reduce((a, c) => a + c.stats.raised, 0n))} 모금` : '캠페인 만들기'} />
          <TodoTile href="/studio/recurring" label="정기후원" value={donation.recurringActive} unit="명" hint={donation.recurringActive ? `월 ${formatWon(donation.recurringMonthly)}` : '약정 없음'} />
          <TodoTile href="/studio/donors" label="함께한 후원자" value={donation.totalDonors} unit="명" hint={`누적 ${formatWon(donation.totalRaised)}`} />
          <TodoTile href="/studio/receipts" label="영수증 발급 대기" value={receiptPending} unit="명" hint={receiptPending ? '기부금영수증 발급' : '대기 없음'} />
        </div>
        {goodsEnabled ? (
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <TodoTile href="/studio/orders?tab=delivery" label="배송 준비" value={ordersPending} unit="건" hint={ordersPending > 0 ? '송장 등록 필요' : '밀린 주문 없음'} />
            <TodoTile href="/studio/orders?tab=digital" label="지급 대기" value={pointsPending} unit="건" hint={pointsPending > 0 ? '비실물 지급 필요' : '밀린 지급 없음'} />
            <TodoTile href="/studio/products" label="노출 중인 항목" value={activeProducts} unit="개" hint="후원 항목 관리" />
            <TodoTile href="/studio/settings?tab=shipping" label="후원 설정" value={null} unit="" hint="금액 · 배송 · 안내 문자" />
          </div>
        ) : null}

        {openCampaigns.length > 0 || trend.some((t) => t.count > 0) ? (
          <Card padded={false} className="overflow-hidden">
            <div className="grid lg:grid-cols-2 lg:divide-x lg:divide-ink-100">
              <div className="p-4">
                <p className="mb-3 text-[13px] font-bold text-ink-900">캠페인 진행률 <span className="ml-1 text-[11.5px] font-medium text-ink-400">결제 성공 기준</span></p>
                {openCampaigns.length === 0 ? (
                  <p className="text-[12.5px] text-ink-400">모금 중인 캠페인이 없습니다.</p>
                ) : (
                  <ul className="space-y-3">
                    {openCampaigns.slice(0, 4).map((c) => {
                      const p = campaignProgress(c.stats.raised, c.goalAmount);
                      return (
                        <li key={c.id}>
                          <Link href={`/studio/campaigns/${c.id}`} className="flex items-baseline justify-between gap-2 text-[13px]">
                            <span className="truncate font-bold text-ink-900">{c.title} <span className="font-mono text-[11px] text-ink-400">{c.code}</span></span>
                            <span className="shrink-0 tabular-nums text-ink-500">{formatWon(c.stats.raised)} · {p.percent}% · {daysLeft(c.endsOn)}일</span>
                          </Link>
                          <ProgressBar percent={p.capped} className="mt-1" height="h-2" />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <div className="p-4">
                <p className="mb-3 text-[13px] font-bold text-ink-900">월별 후원 추이 <span className="ml-1 text-[11.5px] font-medium text-ink-400">최근 6개월</span></p>
                <div className="flex h-28 items-end gap-2">
                  {trend.map((t) => {
                    const max = trend.reduce((m, x) => (x.total > m ? x.total : m), 0n);
                    const h = max > 0n ? Math.max(4, Number((t.total * 100n) / max)) : 4;
                    const hr = max > 0n ? Number((t.recurring * 100n) / max) : 0;
                    return (
                      <div key={t.month} className="flex flex-1 flex-col items-center gap-1" title={`${t.month} ${formatWon(t.total)} (${t.count}건, 정기 ${formatWon(t.recurring)})`}>
                        <div className="relative flex w-full items-end justify-center" style={{ height: '88px' }}>
                          <div className="w-full max-w-[34px] rounded-t-md bg-brand-200" style={{ height: `${h}%` }}>
                            <div className="w-full rounded-t-md bg-brand-500" style={{ height: `${h ? (hr / h) * 100 : 0}%` }} />
                          </div>
                        </div>
                        <span className="text-[10.5px] tabular-nums text-ink-400">{t.month.slice(5)}월</span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-ink-400">진한 막대는 정기후원 비중입니다.</p>
              </div>
            </div>
          </Card>
        ) : null}

        {nextStep ? (
          <Link
            href={nextStep.href}
            className="flex items-center justify-between gap-3 rounded-2xl border border-brand-300 bg-brand-100 px-4 py-3.5 transition-transform hover:-translate-y-0.5"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <CircleAlert size={18} strokeWidth={1.8} className="shrink-0 text-brand-800" />
              <span className="min-w-0">
                <span className="block text-[13.5px] font-extrabold text-ink-900">
                  다음 할 일: {nextStep.label} 설정
                </span>
                <span className="block truncate text-[12px] text-ink-700">
                  {nextStep.value} — 설정을 마쳐야 결제를 받을 수 있습니다.
                </span>
              </span>
            </span>
            <ChevronRight size={16} strokeWidth={1.8} className="shrink-0 text-brand-800" />
          </Link>
        ) : null}

        {/* mock 안내: 큰 박스 대신 한 줄 띠 */}
        <p className="flex items-start gap-2 rounded-xl border border-warning-500/25 bg-warning-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-700">
          <Info size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-warning-500" />
          <span>
            현재 mock 모드입니다. 결제·문자 전송이 모두 모의 처리되며, 화면의 성공 표시는 실제 금융 거래가
            아닙니다.
          </span>
        </p>

        {/* 1) 핵심 수치 — 카드 8개 대신 한 판에 정리 */}
        <Card padded={false} className="overflow-hidden">
          <div className="grid grid-cols-2 divide-ink-100 lg:grid-cols-4 lg:divide-x">
            <Metric label="오늘 접수 금액" value={formatWon(todayAmount._sum.amount ?? 0n)} accent />
            <Metric label="오늘 문자 수신" value={`${formatNumber(todayMessages)}건`} />
            <Metric
              label="결제 성공"
              value={`${formatNumber(todaySuccess)}건`}
              sub={todayFailed > 0 ? `실패 ${formatNumber(todayFailed)}건` : '실패 없음'}
              subTone={todayFailed > 0 ? 'danger' : 'muted'}
            />
            <Metric label="이번 달 예상 정산금" value={formatWon(monthLedger._sum.amount ?? 0n)} sub={kstMonthKey()} />
          </div>

          <div className="grid grid-cols-3 border-t border-ink-100 bg-ink-50/60 divide-x divide-ink-100">
            <MiniMetric label="정산 가능" value={formatWon(summary.available)} accent />
            <MiniMetric label="정산 보류" value={formatWon(summary.pending)} />
            <MiniMetric label="정산 완료" value={formatWon(summary.totalPaid)} />
          </div>

          <Link
            href="/studio/settlement"
            className="flex items-center justify-between border-t border-ink-100 px-4 py-2.5 text-[12.5px] font-semibold text-ink-500 transition-colors hover:bg-ink-50 hover:text-ink-900"
          >
            정산 관리로 이동
            <ChevronRight size={15} strokeWidth={1.8} />
          </Link>
        </Card>

        {/* 2) 연동 상태 — 카드 3개 대신 목록 한 장 */}
        <Card padded={false}>
          <p className="border-b border-ink-100 px-4 py-3 text-[13px] font-bold text-ink-900">
            연동 상태
            <span className="ml-2 text-[11.5px] font-medium text-ink-400">
              연동이 끝나야 결제를 받을 수 있습니다
            </span>
          </p>
          <ul>
            {links.map((l) => (
              <li key={l.href} className="border-b border-ink-100 last:border-0">
                <Link
                  href={l.href}
                  className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-ink-50"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className={l.ok ? 'text-success-500' : 'text-warning-500'}>
                      {l.ok ? <CircleCheck size={16} strokeWidth={1.8} /> : <CircleAlert size={16} strokeWidth={1.8} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-bold text-ink-900">{l.label}</span>
                      <span className="block truncate text-[12px] text-ink-500">{l.value}</span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone={l.ok ? 'success' : 'warning'}>{l.ok ? '정상' : '설정 필요'}</Badge>
                    <ChevronRight size={15} strokeWidth={1.8} className="text-ink-300" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {/* 3) 최근 문자 후원 내역 — 카드로 한 건씩 읽히게 */}
        <section>
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[15px] font-bold tracking-tight text-ink-900">최근 문자 후원 내역</h2>
              <p className="mt-0.5 text-[12px] text-ink-400">
                최근 {recent.length}건입니다. 카드를 누르면 결제 상세로 이동합니다.
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-3">
              <Link href="/studio/messages" className="text-[12.5px] font-semibold text-ink-500 hover:underline">
                문자 관리
              </Link>
              <Link href="/studio/charges" className="text-[12.5px] font-semibold text-brand-700 hover:underline">
                전체 보기
              </Link>
            </span>
          </div>

          {recent.length === 0 ? (
            <Card>
              <EmptyState
                title="아직 후원 내역이 없습니다"
                description="서비스 화면에 결제 수신번호를 안내하면 결제가 시작됩니다. 안내 문구는 문자 관리에서 복사할 수 있습니다."
                action={
                  <LinkButton href="/studio/messages" variant="secondary" size="sm">
                    결제 수신번호 안내 문구 복사하러 가기
                  </LinkButton>
                }
              />
            </Card>
          ) : (
            <ChargeCardGrid
              dense
              items={recent.map((d) => ({
                id: d.id,
                transactionNo: d.transactionNo,
                receivedAt: d.receivedAt,
                displayName: d.displayName,
                anonymous: d.anonymous,
                message: d.message,
                amount: d.amount,
                status: d.status,
                channel: d.channel,
                phoneMasked: d.payer?.phoneMasked ?? null,
              }))}
            />
          )}
        </section>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  sub,
  subTone = 'muted',
  accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  subTone?: 'muted' | 'danger';
  accent?: boolean;
}) {
  return (
    <div className="border-b border-ink-100 px-4 py-4 last:border-b-0 lg:border-b-0">
      <p className="text-[11.5px] font-bold text-ink-400">{label}</p>
      <p
        className={
          accent
            ? 'mt-1.5 text-[22px] font-black tracking-[-0.035em] tabular-nums text-brand-700'
            : 'mt-1.5 text-[22px] font-black tracking-[-0.035em] tabular-nums text-ink-900'
        }
      >
        {value}
      </p>
      {sub ? (
        <p className={subTone === 'danger' ? 'mt-0.5 text-[11.5px] text-danger-500' : 'mt-0.5 text-[11.5px] text-ink-400'}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}

function MiniMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="px-4 py-3">
      <p className="text-[11px] font-semibold text-ink-400">{label}</p>
      <p
        className={
          accent
            ? 'mt-0.5 text-[15px] font-extrabold tabular-nums text-brand-700'
            : 'mt-0.5 text-[15px] font-extrabold tabular-nums text-ink-900'
        }
      >
        {value}
      </p>
    </div>
  );
}

/** 대시보드에서 바로 처리 화면으로 넘어가는 타일. */
function TodoTile({
  href,
  label,
  value,
  unit,
  hint,
}: {
  href: string;
  label: string;
  value: number | null;
  unit: string;
  hint: string;
}) {
  const urgent = value !== null && value > 0 && (label === '배송 준비' || label === '지급 대기');
  return (
    <Link
      href={href}
      className="card min-h-[104px] p-4 transition-all hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)]"
    >
      <p className="text-[11.5px] font-bold text-ink-400">{label}</p>
      <p
        className={`mt-2 text-[22px] font-black tracking-[-0.035em] tabular-nums ${
          urgent ? 'text-warning-500' : 'text-ink-900'
        }`}
      >
        {value === null ? '설정' : `${formatNumber(value)}${unit}`}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{hint}</p>
    </Link>
  );
}
