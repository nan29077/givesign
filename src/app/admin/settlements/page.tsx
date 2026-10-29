import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, MerchantOptions, FilterBar, Pager } from '@/components/admin/controls';
import { ActionForm } from '@/components/admin/action-form';
import { runPayoutBatchAction, retryPayoutAction } from '@/app/actions/admin/settlement';
import { buildPayoutDashboard } from '@/server/services/auto-settlement';
import { formatDateKeyKo } from '@/lib/business-day';
import { env } from '@/lib/env';
import { PAGE_SIZE, parsePage, clampPage, canManageMoney, canExportSettlementFiles } from '@/components/admin/constants';
import { SettlementRequestsPanel, type SettlementRow } from '@/components/admin/settlement-requests';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst, kstMonthKey } from '@/lib/datetime';
import { settlementStatusLabel, ledgerEntryLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { SettlementRequestStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const REQUEST_STATUSES: SettlementRequestStatus[] = ['REQUESTED', 'REVIEWING', 'APPROVED', 'PAID', 'PAYOUT_FAILED', 'REJECTED'];

export default async function AdminSettlementsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; merchantId?: string; key?: string; page?: string; rpage?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canManageMoney(me.adminPermission);
  // 이체파일·원천징수 자료에는 계좌번호와 주민등록번호 원문이 들어간다.
  // 두 라우트가 SUPER_ADMIN·FINANCE 만 허용하므로 링크도 같은 기준으로 잠근다.
  const canExportFiles = canExportSettlementFiles(me.adminPermission);

  const sp = await searchParams;
  const page = parsePage(sp.page);
  // 요청 목록과 원장 목록은 페이지를 따로 넘긴다 (하나의 page 로 묶으면 요청 목록이 2페이지부터 같은 내용을 반복한다)
  const requestPage = parsePage(sp.rpage);
  const status = REQUEST_STATUSES.includes(sp.status as SettlementRequestStatus)
    ? (sp.status as SettlementRequestStatus)
    : undefined;
  const merchantId = (sp.merchantId ?? '').trim() || undefined;
  const settlementKey = (sp.key ?? '').trim();

  const requestWhere: Prisma.SettlementRequestWhereInput = {
    ...(status ? { status } : {}),
    ...(merchantId ? { merchantId } : {}),
  };
  const ledgerWhere: Prisma.SettlementLedgerWhereInput = {
    ...(merchantId ? { merchantId } : {}),
    ...(settlementKey ? { settlementKey } : {}),
  };

  const [merchants, requestTotal, requests, ledgerTotal, ledgers, byStatus, ledgerKeys] = await Promise.all([
    prisma.merchantProfile.findMany({
      where: { status: 'APPROVED' },
      orderBy: { displayName: 'asc' },
      take: 60,
      select: { id: true, displayName: true, code: true },
    }),
    prisma.settlementRequest.count({ where: requestWhere }),
    prisma.settlementRequest.findMany({
      where: requestWhere,
      // 미처리(REQUESTED→REVIEWING→APPROVED) 건을 먼저, 그 안에서는 오래된 순으로 본다.
      // 최신순으로만 정렬하면 오래 밀린 요청이 뒤로 밀려 영영 처리되지 않는다.
      orderBy: [{ status: 'asc' }, { requestedAt: 'asc' }],
      skip: (requestPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, amount: true, withholding: true, payoutAmount: true, status: true,
        memo: true, adminMemo: true, payoutFailReason: true,
        residentMasked: true, residentPurgedAt: true,
        requestedAt: true, approvedAt: true, paidAt: true, rejectedAt: true,
        merchant: {
          select: {
            id: true, displayName: true, code: true,
            settlementAccount: { select: { bankName: true, accountTail4: true, holderMasked: true, verified: true } },
          },
        },
      },
    }),
    prisma.settlementLedger.count({ where: ledgerWhere }),
    prisma.settlementLedger.findMany({
      where: ledgerWhere,
      orderBy: { occurredAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, entryType: true, amount: true, memo: true, occurredAt: true, settlementKey: true,
        chargeId: true, refundId: true, requestId: true,
        merchant: { select: { id: true, displayName: true } },
      },
    }),
    // 목록과 같은 필터를 적용한다. where 를 빼면 사회복지기관으로 걸러도 타일만 전체 수치를 보여 준다.
    prisma.settlementRequest.groupBy({
      by: ['status'],
      where: requestWhere,
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.settlementLedger.findMany({
      distinct: ['settlementKey'],
      orderBy: { settlementKey: 'desc' },
      take: 24,
      select: { settlementKey: true },
    }),
  ]);

  // 자동 지급 모니터링 (오늘 지급 예정 / 실행 결과 / 실패 / 보류)
  const payout = await buildPayoutDashboard();

  // 사회복지기관별 정산 요약.
  //
  // 예전에는 이름순 상위 30곳만 getSettlementSummary 로 각각 조회했다. 그래서
  //  (1) 31번째 이후 사회복지기관은 잔액이 얼마든 이 표에 절대 나타나지 않았고
  //  (2) 사회복지기관 수만큼 쿼리가 늘었다.
  // 원장이 있는 사회복지기관 전체를 집계 두 번으로 가져와 잔액이 큰 순으로 보여 준다.
  const [ledgerAgg, pendingAgg] = await Promise.all([
    prisma.settlementLedger.groupBy({
      by: ['merchantId', 'entryType'],
      where: merchantId ? { merchantId } : {},
      _sum: { amount: true },
    }),
    prisma.settlementRequest.groupBy({
      by: ['merchantId'],
      where: {
        status: { in: ['REQUESTED', 'REVIEWING', 'APPROVED', 'PAYOUT_FAILED'] },
        ...(merchantId ? { merchantId } : {}),
      },
      _sum: { amount: true },
    }),
  ]);

  const entrySums = new Map<string, Map<string, bigint>>();
  for (const r of ledgerAgg) {
    const m = entrySums.get(r.merchantId) ?? new Map<string, bigint>();
    m.set(r.entryType, (m.get(r.entryType) ?? 0n) + (r._sum.amount ?? 0n));
    entrySums.set(r.merchantId, m);
  }
  const pendingByMerchant = new Map(pendingAgg.map((r) => [r.merchantId, r._sum.amount ?? 0n]));

  const summaryIds = [...new Set([...entrySums.keys(), ...pendingByMerchant.keys()])];
  const summaryMerchants =
    summaryIds.length > 0
      ? await prisma.merchantProfile.findMany({
          where: { id: { in: summaryIds } },
          select: { id: true, displayName: true, code: true },
        })
      : [];

  // getSettlementSummary 와 같은 계산식이다(원장 부호 규칙 포함).
  const allSummaries = summaryMerchants.map((c) => {
    const g = entrySums.get(c.id) ?? new Map<string, bigint>();
    const s = (t: string) => g.get(t) ?? 0n;
    const balance = [...g.values()].reduce((a, b) => a + b, 0n);
    const pending = pendingByMerchant.get(c.id) ?? 0n;
    const available = balance - pending;
    return {
      merchant: c,
      summary: {
        totalGross: s('CHARGE_GROSS'),
        totalPgFee: -s('PG_FEE'),
        totalPlatformFee: -s('PLATFORM_FEE'),
        totalRefund: -(s('REFUND') + s('REFUND_FEE_RETURN')),
        totalAdjustment: s('ADJUSTMENT'),
        totalPaid: -(s('PAYOUT') + s('PAYOUT_WITHHOLDING')),
        balance,
        pending,
        available: available < 0n ? 0n : available,
      },
    };
  });

  const SUMMARY_LIMIT = 100;
  const nonZeroSummaries = allSummaries
    .filter((s) => s.summary.balance !== 0n || s.summary.pending !== 0n)
    .sort((a, b) => (a.summary.available < b.summary.available ? 1 : a.summary.available > b.summary.available ? -1 : 0));
  const summaryHidden = Math.max(0, nonZeroSummaries.length - SUMMARY_LIMIT);
  const visibleSummaries = nonZeroSummaries.slice(0, SUMMARY_LIMIT);

  const lastPage = Math.max(1, Math.ceil(ledgerTotal / PAGE_SIZE));
  const requestLastPage = Math.max(1, Math.ceil(requestTotal / PAGE_SIZE));

  // 이 화면은 목록이 둘(요청 회차 rpage / 원장 page)이라 각각 보정한다.
  const pagerParams = { status: status ?? '', merchantId: merchantId ?? '', key: settlementKey };
  clampPage({
    basePath: '/admin/settlements',
    params: { ...pagerParams, rpage: String(requestPage) },
    page,
    lastPage,
    total: ledgerTotal,
  });
  clampPage({
    basePath: '/admin/settlements',
    params: { ...pagerParams, page: String(page) },
    page: requestPage,
    lastPage: requestLastPage,
    total: requestTotal,
    pageParam: 'rpage',
  });

  // 클라이언트 패널로 넘길 직렬화 행 (BigInt·Date 를 문자열로)
  const requestRows: SettlementRow[] = requests.map((r) => ({
    id: r.id,
    requestedAt: formatKst(r.requestedAt, false),
    status: r.status,
    statusText: settlementStatusLabel[r.status].text,
    statusTone: settlementStatusLabel[r.status].tone,
    amount: r.amount.toString(),
    withholding: r.withholding.toString(),
    payoutAmount: r.payoutAmount.toString(),
    merchantName: r.merchant.displayName,
    merchantCode: r.merchant.code,
    bank: r.merchant.settlementAccount?.bankName ?? null,
    accountTail4: r.merchant.settlementAccount?.accountTail4 ?? null,
    holderMasked: r.merchant.settlementAccount?.holderMasked ?? null,
    verified: r.merchant.settlementAccount?.verified ?? false,
    adminMemo: r.adminMemo,
    memo: r.memo,
    residentMasked: r.residentMasked,
    residentPurged: Boolean(r.residentPurgedAt),
    paidAt: r.paidAt ? formatKst(r.paidAt, false) : null,
    failReason: r.payoutFailReason,
  }));
  const countOf = (s: SettlementRequestStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  const sumOf = (s: SettlementRequestStatus) => byStatus.find((b) => b.status === s)?._sum.amount ?? 0n;

  return (
    <>
      <PageHeader
        title="정산 관리"
        description="자동 지급 현황과 사회복지기관별 정산 잔액, 지급 회차 처리, 정산 원장 조회를 제공합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="접수" value={formatNumber(countOf('REQUESTED'))} sub={formatWon(sumOf('REQUESTED'))} tone={countOf('REQUESTED') > 0 ? 'warning' : 'neutral'} />
        <StatTile label="검토중" value={formatNumber(countOf('REVIEWING'))} sub={formatWon(sumOf('REVIEWING'))} />
        <StatTile label="승인(지급 대기)" value={formatNumber(countOf('APPROVED'))} sub={formatWon(sumOf('APPROVED'))} tone="brand" />
        <StatTile label="지급 완료" value={formatNumber(countOf('PAID'))} sub={formatWon(sumOf('PAID'))} tone="success" />
      </div>

      <section className="mb-5">
        <SectionTitle
          title="자동 지급 현황"
          description={`지급일은 수수료 정책의 "지급일(영업일)"로 결정됩니다. 전역 정책으로 일괄 지정하고 사회복지기관 정책으로 개별 조정합니다. · 기준일 ${formatDateKeyKo(payout.todayKey)}`}
        />
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile
            label="오늘 지급 예정"
            value={formatWon(payout.scheduled.amount)}
            sub={`사회복지기관 ${formatNumber(payout.scheduled.merchants)}곳`}
            tone="brand"
          />
          <StatTile
            label="오늘 지급 완료"
            value={formatWon(payout.paidToday.amount)}
            sub={`${formatNumber(payout.paidToday.count)}건 (자동)`}
            tone="success"
          />
          <StatTile
            label="지급 실패"
            value={formatNumber(payout.failed.length)}
            sub={payout.failed.length > 0 ? '재시도 필요' : '없음'}
            tone={payout.failed.length > 0 ? 'danger' : 'neutral'}
          />
          <StatTile
            label="지급 보류(계좌)"
            value={formatNumber(payout.blocked.length)}
            sub={payout.blocked.length > 0 ? formatWon(payout.blocked.reduce((s, b) => s + b.amount, 0n)) : '없음'}
            tone={payout.blocked.length > 0 ? 'warning' : 'neutral'}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-start gap-3">
          <ActionForm disabled={!canEdit}
            action={runPayoutBatchAction}
            submitLabel="자동 지급 지금 실행"
            variant="secondary"
            compact
            confirm="지급일이 도래한 사회복지기관에 실제로 이체를 실행합니다. 계속할까요?"
          />
          <p className="max-w-[560px] text-[11.5px] leading-relaxed text-ink-400">
            배치는 매일 자동으로 실행됩니다. 이 버튼은 크론이 실패했거나 계좌 인증을 뒤늦게 마친 사회복지기관을 그날 안에
            지급할 때만 사용하세요. 같은 날 이미 처리된 사회복지기관은 멱등키로 걸러져 이중 지급되지 않습니다.
          </p>
        </div>

        {env.payout.provider === 'mock' ? (
          <div className="mt-3">
            <Notice tone="warning" title="지급대행 연동은 아직 mock 입니다">
              PAYOUT_PROVIDER 가 mock 이라 실제 이체가 일어나지 않습니다. 화면의 &ldquo;지급 완료&rdquo;는 모의 결과이며,
              운영 전환 시 지급대행사 규격에 맞춘 어댑터로 교체해야 합니다.
            </Notice>
          </div>
        ) : null}

        {payout.blocked.length > 0 ? (
          <div className="mt-4">
            <SectionTitle title="지급 보류 사회복지기관" description="지급 예정 금액이 있으나 계좌 문제로 지급되지 않습니다. 금액은 다음 회차로 이월됩니다." />
            <Table className="min-w-[700px]">
              <thead>
                <tr>
                  <Th>사회복지기관</Th>
                  <Th className="text-right">보류 금액</Th>
                  <Th>사유</Th>
                </tr>
              </thead>
              <tbody>
                {payout.blocked.map((b) => (
                  <tr key={b.merchantId}>
                    <Td>
                      <Link href={`/admin/merchants/${b.merchantId}`} className="font-semibold text-brand-700">
                        {b.merchantName}
                      </Link>
                    </Td>
                    <Td className="text-right tabular-nums">{formatWon(b.amount)}</Td>
                    <Td className="text-danger-500">{b.reason}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : null}

        {payout.failed.length > 0 ? (
          <div className="mt-4">
            <SectionTitle
              title="지급 실패 회차"
              description="재시도는 대행사 조회로 이미 지급되지 않았는지 확인한 뒤에만 다시 이체합니다."
            />
            <Table className="min-w-[900px]">
              <thead>
                <tr>
                  <Th>회차 생성일</Th>
                  <Th>사회복지기관</Th>
                  <Th className="text-right">실지급액</Th>
                  <Th>실패 사유</Th>
                  <Th>처리</Th>
                </tr>
              </thead>
              <tbody>
                {payout.failed.map((f) => (
                  <tr key={f.id}>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(f.at, false)}</Td>
                    <Td>
                      <Link href={`/admin/merchants/${f.merchantId}`} className="font-semibold text-brand-700">
                        {f.merchantName}
                      </Link>
                    </Td>
                    <Td className="text-right font-semibold tabular-nums">{formatWon(f.amount)}</Td>
                    <Td className="max-w-[280px] break-words text-danger-500">{f.reason ?? '-'}</Td>
                    <Td>
                      <ActionForm disabled={!canEdit}
                        action={retryPayoutAction}
                        submitLabel="지급 재시도"
                        variant="secondary"
                        compact
                        confirm="대행사 조회 후 필요하면 다시 이체합니다. 계속할까요?"
                      >
                        <input type="hidden" name="requestId" value={f.id} />
                      </ActionForm>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : null}
      </section>

      <Notice tone="danger" title="정산 원장은 조회 전용입니다">
        settlement_ledger 는 append-only 테이블이며, UPDATE/DELETE 는 DB 트리거로 차단되어 있습니다. 금액 정정이
        필요하면 반대 부호의 조정(ADJUSTMENT) 분개를 추가해야 합니다. 이 화면에서 원장을 직접 수정할 수 없습니다.
      </Notice>

      <section className="mt-5">
        <SectionTitle
          title="사회복지기관별 정산 요약"
          description={`잔액 = 원장 합계 / 보류 = 지급 진행 중 금액 / 가능 = 다음 회차에 지급 가능한 금액${
            summaryHidden > 0 ? ` · 가능 금액 상위 ${SUMMARY_LIMIT}곳만 표시 (${summaryHidden}곳 더 있음)` : ''
          }`}
        />
        {visibleSummaries.length === 0 ? (
          <EmptyState title="정산 원장이 있는 사회복지기관이 없습니다" />
        ) : (
          <Table className="min-w-[1000px]">
            <thead>
              <tr>
                <Th>사회복지기관</Th>
                <Th className="text-right">결제 총액</Th>
                <Th className="text-right">수수료</Th>
                <Th className="text-right">환불</Th>
                <Th className="text-right">지급 완료</Th>
                <Th className="text-right">잔액</Th>
                <Th className="text-right">보류</Th>
                <Th className="text-right">정산 가능</Th>
              </tr>
            </thead>
            <tbody>
              {visibleSummaries.map(({ merchant, summary }) => (
                <tr key={merchant.id}>
                  <Td>
                    <Link href={`/admin/merchants/${merchant.id}`} className="font-semibold text-brand-700">
                      {merchant.displayName}
                    </Link>
                    <span className="mt-0.5 block text-[11px] text-ink-400">{merchant.code}</span>
                  </Td>
                  <Td className="text-right tabular-nums">{formatWon(summary.totalGross)}</Td>
                  <Td className="text-right tabular-nums">{formatWon(summary.totalPgFee + summary.totalPlatformFee)}</Td>
                  <Td className="text-right tabular-nums">{formatWon(summary.totalRefund)}</Td>
                  <Td className="text-right tabular-nums">{formatWon(summary.totalPaid)}</Td>
                  <Td className="text-right font-semibold tabular-nums">{formatWon(summary.balance)}</Td>
                  <Td className="text-right tabular-nums">{formatWon(summary.pending)}</Td>
                  <Td className="text-right font-semibold tabular-nums text-brand-700">{formatWon(summary.available)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section className="mt-6">
        <SectionTitle
          title="지급 회차 처리"
          description={`전체 ${formatNumber(requestTotal)}건 · 자동 지급 배치가 만든 회차와 수동 처리 건을 함께 보여줍니다 (${requestPage}/${requestLastPage} 페이지)`}
        />
        <FilterBar action="/admin/settlements" resetHref="/admin/settlements">
          <AdminField label="요청 상태" className="w-40">
            <AdminSelect name="status" defaultValue={status ?? ''}>
              <option value="">전체</option>
              {REQUEST_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {settlementStatusLabel[s].text}
                </option>
              ))}
            </AdminSelect>
          </AdminField>
          <AdminField label="사회복지기관" className="w-52">
            <AdminSelect name="merchantId" defaultValue={merchantId ?? ''}>
              <MerchantOptions merchants={merchants} />
            </AdminSelect>
          </AdminField>
          <AdminField label="정산 월 (원장 필터)" className="w-40">
            <AdminInput name="key" defaultValue={settlementKey} placeholder={kstMonthKey()} list="settlement-keys" />
          </AdminField>
          <datalist id="settlement-keys">
            {ledgerKeys.map((k) => (
              <option key={k.settlementKey} value={k.settlementKey} />
            ))}
          </datalist>
        </FilterBar>

        <SettlementRequestsPanel rows={requestRows} canEdit={canEdit} canExportPayout={canExportFiles} />

        {canExportFiles ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* Link 는 화면에 보이면 prefetch 로 GET 을 미리 호출해 주민번호 복호화·감사로그가 클릭 없이 쌓인다. */}
            <a
              href={`/api/admin/settlements/withholding?from=${kstMonthKey()}-01`}
              className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-bold text-ink-700 hover:bg-ink-50"
            >
              이번 달 원천징수 지급명세서 자료 받기
            </a>
            <span className="text-[11.5px] text-ink-400">지급 완료 건의 지급명세서 산출 자료(CSV)를 내려받습니다.</span>
          </div>
        ) : null}

        <Pager
          basePath="/admin/settlements"
          params={{ status: status ?? '', merchantId: merchantId ?? '', key: settlementKey, page: String(page) }}
          page={requestPage}
          lastPage={requestLastPage}
          total={requestTotal}
          pageParam="rpage"
        />
      </section>

      <section className="mt-6">
        <SectionTitle
          title="정산 원장 조회"
          description="사회복지기관과 정산 월(settlement_key)로 필터링할 수 있습니다. 조회 전용입니다."
        />
        {ledgers.length === 0 ? (
          <EmptyState title="조건에 맞는 원장 분개가 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1000px]">
              <thead>
                <tr>
                  <Th>발생 시각</Th>
                  <Th>정산 월</Th>
                  <Th>사회복지기관</Th>
                  <Th>분개 유형</Th>
                  <Th className="text-right">금액</Th>
                  <Th>메모</Th>
                  <Th>연결 ID</Th>
                </tr>
              </thead>
              <tbody>
                {ledgers.map((l) => (
                  <tr key={l.id}>
                    <Td className="whitespace-nowrap">{formatKst(l.occurredAt, false)}</Td>
                    <Td className="font-mono text-[12px]">{l.settlementKey}</Td>
                    <Td>
                      <Link href={`/admin/merchants/${l.merchant.id}`} className="font-semibold text-brand-700">
                        {l.merchant.displayName}
                      </Link>
                    </Td>
                    <Td>{ledgerEntryLabel[l.entryType]}</Td>
                    <Td className={`text-right tabular-nums ${l.amount < 0n ? 'text-danger-500' : 'text-success-500'}`}>
                      {formatWon(l.amount)}
                    </Td>
                    <Td className="max-w-[200px] break-words">{l.memo ?? '-'}</Td>
                    <Td className="font-mono text-[11px] text-ink-400">
                      {l.chargeId ? <span className="block">결제 {l.chargeId}</span> : null}
                      {l.refundId ? <span className="block">환불 {l.refundId}</span> : null}
                      {l.requestId ? <span className="block">정산 {l.requestId}</span> : null}
                      {!l.chargeId && !l.refundId && !l.requestId ? '-' : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/settlements"
              params={{ status: status ?? '', merchantId: merchantId ?? '', key: settlementKey, rpage: String(requestPage) }}
              page={page}
              lastPage={lastPage}
              total={ledgerTotal}
            />
          </>
        )}
      </section>
    </>
  );
}
