import Link from 'next/link';
import { Activity, Flag, Wallet } from 'lucide-react';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, SectionTitle, StatTile, Table, Th, Td, Badge, EmptyState, LinkButton } from '@/components/ui';
import { SafetyBanner } from '@/components/admin/safety-banner';
import { BannerStrip } from '@/components/public/banner-strip';
import { PAID_CHARGE_STATUSES } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst, kstStartOfDay, kstStartOfMonth } from '@/lib/datetime';
import { chargeStatusLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

export default async function AdminDashboardPage() {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  const canSeeInquiries = me.adminPermission === 'SUPER_ADMIN';

  const todayStart = kstStartOfDay();
  const monthStart = kstStartOfMonth();

  const [
    todayPaid,
    monthPaid,
    todayReceived,
    txTotal,
    txApproved,
    unregistered,
    limitBlocked,
    settlementPending,
    openReports,
    openRisks,
    openInquiries,
    recentCharges,
  ] = await Promise.all([
    prisma.charge.aggregate({
      where: { status: { in: PAID_CHARGE_STATUSES }, paidAt: { gte: todayStart } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.charge.aggregate({
      where: { status: { in: PAID_CHARGE_STATUSES }, paidAt: { gte: monthStart } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.charge.count({ where: { receivedAt: { gte: todayStart } } }),
    prisma.paymentTransaction.count({ where: { requestedAt: { gte: todayStart } } }),
    prisma.paymentTransaction.count({ where: { requestedAt: { gte: todayStart }, status: 'APPROVED' } }),
    prisma.moInboundMessage.count({ where: { receivedAt: { gte: todayStart }, result: 'UNREGISTERED_DONOR' } }),
    prisma.charge.count({ where: { receivedAt: { gte: todayStart }, status: 'LIMIT_BLOCKED' } }),
    prisma.settlementRequest.aggregate({
      where: { status: { in: ['REQUESTED', 'REVIEWING'] } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.report.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
    prisma.riskDetection.count({ where: { resolved: false } }),
    prisma.supportInquiry.count({ where: { status: 'OPEN' } }),
    prisma.charge.findMany({
      orderBy: { receivedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        transactionNo: true,
        amount: true,
        status: true,
        receivedAt: true,
        merchant: { select: { displayName: true } },
        payer: { select: { phoneMasked: true } },
      },
    }),
  ]);

  const successRate = txTotal === 0 ? null : Math.round((txApproved / txTotal) * 1000) / 10;

  // 처리 대기 건이 하나라도 있으면 '확인이 필요한 건' 섹션을 지표보다 위에 배치한다.
  // 운영자가 접속해서 가장 먼저 할 일이 화면 순서와 일치하도록.
  const pendingTotal =
    unregistered + limitBlocked + openRisks + settlementPending._count._all + openReports + openInquiries;

  // 확인이 필요한 건 / 결제 현황 — 정의는 한 벌, 순서만 바꿔 렌더한다.
  const pendingSection = (
    <section>
      <SectionTitle title="확인이 필요한 건" description="숫자를 누르면 해당 관리 화면으로 이동합니다." />
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Link href="/admin/mo-messages?result=UNREGISTERED_DONOR">
          <StatTile
            label="오늘 미등록 응답"
            value={formatNumber(unregistered)}
            sub="계좌 미등록 후원자에게 안내 발송"
            tone={unregistered > 0 ? 'warning' : 'neutral'}
          />
        </Link>
        <Link href="/admin/risk">
          <StatTile
            label="오늘 한도 차단"
            value={formatNumber(limitBlocked)}
            sub="한도·속도 제한에 걸린 결제"
            tone={limitBlocked > 0 ? 'warning' : 'neutral'}
          />
        </Link>
        <Link href="/admin/risk?resolved=NO">
          <StatTile
            label="미해결 이상거래"
            value={formatNumber(openRisks)}
            sub="해결 처리 필요"
            tone={openRisks > 0 ? 'danger' : 'neutral'}
          />
        </Link>
        <Link href="/admin/settlements">
          <StatTile
            label="정산 요청 대기"
            value={formatNumber(settlementPending._count._all)}
            sub={formatWon(settlementPending._sum.amount ?? 0n)}
            tone={settlementPending._count._all > 0 ? 'warning' : 'neutral'}
          />
        </Link>
        <Link href="/admin/moderation">
          <StatTile
            label="미해결 신고"
            value={formatNumber(openReports)}
            sub="접수·검토중 합계"
            tone={openReports > 0 ? 'warning' : 'neutral'}
          />
        </Link>
        {/* 문의 화면은 최고 관리자 전용이다. 메뉴에서 숨긴 정보가 대시보드로 새지 않게 한다. */}
        {canSeeInquiries ? (
          <Link href="/admin/inquiries?status=OPEN">
            <StatTile
              label="답변 대기 문의"
              value={formatNumber(openInquiries)}
              sub="1:1 문의 답변 대기"
              tone={openInquiries > 0 ? 'warning' : 'neutral'}
            />
          </Link>
        ) : null}
        <Link href="/admin/refunds">
          <StatTile label="환불 관리" value="바로가기" sub="요청 승인·거절 처리" />
        </Link>
        <Link href="/admin/merchants">
          <StatTile label="사회복지기관 심사" value="바로가기" sub="대기 건 확인" />
        </Link>
      </div>
    </section>
  );

  const paymentSection = (
    <section>
      <SectionTitle title="결제 현황" description="금액은 결제가 승인된 건만 집계합니다. 환불 완료 건은 제외됩니다." />
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="오늘 결제 완료"
          value={formatNumber(todayPaid._count._all)}
          sub={formatWon(todayPaid._sum.amount ?? 0n)}
          tone="brand"
        />
        <StatTile
          label="이번 달 결제 완료"
          value={formatNumber(monthPaid._count._all)}
          sub={formatWon(monthPaid._sum.amount ?? 0n)}
        />
        <StatTile label="오늘 문자 접수" value={formatNumber(todayReceived)} sub="결제 이전 단계 포함" />
        <StatTile
          label="오늘 결제 성공률"
          value={successRate === null ? '-' : `${successRate}%`}
          sub={`요청 ${formatNumber(txTotal)}건 중 승인 ${formatNumber(txApproved)}건`}
          tone={successRate !== null && successRate < 90 ? 'warning' : 'success'}
        />
      </div>
    </section>
  );

  return (
    <>
      <PageHeader
        title="운영 대시보드"
        description="오늘(KST) 기준 문자·결제 지표와 즉시 처리해야 할 대기 건을 함께 보여줍니다."
      />

      <div className="space-y-5">
        <SafetyBanner />
        <BannerStrip position="CONSOLE_TOP" />

        {/*
          두 섹션은 내용이 같고 순서만 바뀐다.
          예전에는 90줄짜리 블록을 두 벌 유지하다가, 같은 "오늘 한도 차단" 타일의 링크가
          한쪽은 /admin/risk, 다른 쪽은 /admin/mo-messages?result=BLOCKED 로 갈라졌다.
          (두 화면의 집합도 서로 다르다 — 수치는 charge.status = LIMIT_BLOCKED 기준이다)
          한 벌만 정의하고 순서만 바꾼다.
        */}
        {pendingTotal > 0 ? (
          <>
            {pendingSection}
            {paymentSection}
          </>
        ) : (
          <>
            {paymentSection}
            {pendingSection}
          </>
        )}

        <section>
          <SectionTitle title="최근 결제 10건" />
          {recentCharges.length === 0 ? (
            <EmptyState
              title="아직 후원 내역이 없습니다"
              description="MO 시뮬레이터로 문자 수신부터 결제까지 전체 흐름을 검증할 수 있습니다."
              action={
                <LinkButton href="/admin/simulator" variant="secondary" size="sm">
                  MO 시뮬레이터 열기
                </LinkButton>
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>거래번호</Th>
                  <Th>사회복지기관</Th>
                  <Th>후원자</Th>
                  <Th className="text-right">금액</Th>
                  <Th>상태</Th>
                  <Th>수신 시각</Th>
                </tr>
              </thead>
              <tbody>
                {recentCharges.map((d) => {
                  const label = chargeStatusLabel[d.status];
                  return (
                    <tr key={d.id}>
                      <Td className="font-mono text-[12px]">{d.transactionNo}</Td>
                      <Td>{d.merchant.displayName}</Td>
                      <Td>{d.payer?.phoneMasked ?? '-'}</Td>
                      <Td className="text-right tabular-nums">{formatWon(d.amount)}</Td>
                      <Td>
                        <Badge tone={label.tone}>{label.text}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap">{formatKst(d.receivedAt, false)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>

        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
                <Activity size={16} strokeWidth={1.7} />
              </span>
              <CardTitle>지표 집계 기준</CardTitle>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-500">
              모든 날짜 경계는 KST(UTC+9) 기준입니다. 결제 금액은 승인 시각(paidAt) 기준이며, 문자 접수 건수는 수신
              시각(receivedAt) 기준입니다.
            </p>
          </Card>
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
                <Wallet size={16} strokeWidth={1.7} />
              </span>
              <CardTitle>정산 원장은 수정 불가</CardTitle>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-500">
              정산 원장은 append-only 이며 정정은 반대 분개로만 처리합니다. 환불 승인 시 자동으로 반대 분개가 쌓입니다.
            </p>
          </Card>
        </div>

        <Card>
          <div className="mb-2 flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
              <Flag size={16} strokeWidth={1.7} />
            </span>
            <CardTitle>바로가기</CardTitle>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { href: '/admin/system', label: '시스템 상태' },
              { href: '/admin/mo-messages', label: '수신 문자' },
              { href: '/admin/payments', label: '결제 관리' },
              { href: '/admin/settlements', label: '정산 관리' },
              { href: '/admin/policies', label: '한도 정책' },
              { href: '/admin/audit', label: '감사로그' },
            ].map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-semibold text-ink-700 hover:bg-ink-50"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
