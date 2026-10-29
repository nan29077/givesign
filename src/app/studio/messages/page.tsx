import Link from 'next/link';
import { Badge, Card, EmptyState, Notice, Table, Td, Th } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { InlineActionForm } from '@/components/studio/action-form';
import {
  CHARGE_PERIODS,
  PAID_STATUSES,
  buildQuery,
  normalizePeriod,
  one,
  periodStart,
  type SearchParamsRecord,
} from '@/components/studio/shared';
import { blockPayerAction } from '@/app/actions/studio';
import { MoNumberPanel, type MoNumberView } from '@/components/studio/mo-number-panel';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatNumber, formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { chargeStatusLabel, moResultLabel, moNumberStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';

export const dynamic = 'force-dynamic';

const TAKE = 50;

const PERIODS = [
  { value: 'today', label: '오늘' },
  { value: '7d', label: '최근 7일' },
  { value: '30d', label: '최근 30일' },
  { value: 'all', label: '전체' },
] as const;

const TABS = [
  { value: 'all', label: '전체 수신' },
  { value: 'success', label: '결제 성공' },
  { value: 'failed', label: '결제 실패' },
  { value: 'unregistered', label: '미등록 사용자' },
  { value: 'blocked', label: '차단됨' },
  { value: 'filtered', label: '차단·필터' },
] as const;

type TabValue = (typeof TABS)[number]['value'];

function tabWhere(tab: TabValue): Prisma.MoInboundMessageWhereInput {
  switch (tab) {
    case 'success':
      return { charge: { status: { in: PAID_STATUSES } } };
    case 'failed':
      return { charge: { status: 'PAYMENT_FAILED' } };
    case 'unregistered':
      return { OR: [{ result: 'UNREGISTERED_DONOR' }, { charge: { status: 'UNREGISTERED' } }] };
    case 'blocked':
      return { OR: [{ result: 'BLOCKED' }, { charge: { status: { in: ['LIMIT_BLOCKED', 'CONTENT_BLOCKED'] } } }] };
    case 'filtered':
      // 별표 1개는 후원자가 쓴 문자(★☆* 등)에도 나온다. 마스킹은 최소 3자를 채우므로 '***' 로 본다.
      // (금칙어 마스킹과 개인정보 마스킹을 구분하는 컬럼이 없어 둘 다 포함된다 — 화면에 그렇게 안내한다)
      return { OR: [{ charge: { status: 'CONTENT_BLOCKED' } }, { contentFiltered: { contains: '***' } }] };
    default:
      return {};
  }
}

export default async function StudioMessagesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;

  const raw = one(sp.tab) as TabValue;
  const tab: TabValue = TABS.some((t) => t.value === raw) ? raw : 'all';
  const period = normalizePeriod(one(sp.period) || '30d', CHARGE_PERIODS, '30d');
  const pageRaw = Math.max(1, Number.parseInt(one(sp.page) || '1', 10) || 1);

  const gte = periodStart(period);
  const where: Prisma.MoInboundMessageWhereInput = {
    merchantId,
    ...tabWhere(tab),
    ...(gte ? { receivedAt: { gte } } : {}),
  };

  const [total, rows, blockedRows, moNumbers, merchant] = await Promise.all([
    prisma.moInboundMessage.count({ where }),
    prisma.moInboundMessage.findMany({
      where,
      // 같은 시각의 수신이 있어도 페이지 사이에서 순서가 흔들리지 않게 id 를 보조 정렬로 둔다.
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      skip: (pageRaw - 1) * TAKE,
      take: TAKE,
      select: {
        id: true,
        receivedAt: true,
        phoneMasked: true,
        matchedKeyword: true,
        messageType: true,
        contentFiltered: true,
        result: true,
        resultDetail: true,
        charge: {
          select: { id: true, transactionNo: true, status: true, amount: true, payerId: true },
        },
      },
    }),
    prisma.blockedPayer.findMany({ where: { merchantId }, select: { payerId: true } }),
    prisma.merchantMoNumber.findMany({
      where: { merchantId },
      orderBy: [{ status: 'asc' }, { assignedAt: 'desc' }],
      select: { id: true, phoneNumber: true, keyword: true, mode: true, status: true, assignedAt: true },
    }),
    prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { displayName: true } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / TAKE));
  // 범위를 벗어난 page 로 들어오면 빈 화면 + 되돌아갈 링크가 없는 상태가 된다.
  const page = Math.min(pageRaw, totalPages);
  const base = { tab, period };

  const blockedSet = new Set(blockedRows.map((b) => b.payerId));

  const numbers: MoNumberView[] = moNumbers.map((m) => ({
    id: m.id,
    phoneNumber: m.phoneNumber,
    keyword: m.keyword,
    mode: m.mode,
    statusText: moNumberStatusLabel[m.status].text,
    statusTone: moNumberStatusLabel[m.status].tone,
    assignedAt: m.assignedAt ? formatKst(m.assignedAt, false) : null,
  }));

  // 후원자에게 안내할 문구 (배정된 번호가 있을 때만)
  const primary = moNumbers.find((m) => m.status === 'ASSIGNED') ?? moNumbers[0] ?? null;
  const guideText = primary
    ? [
        `${merchant?.displayName ?? '사회복지기관'} 문자후원`,
        `${primary.phoneNumber} 으로 문자를 보내주세요.`,
        primary.keyword ? `문자 맨 앞에 ${primary.keyword} 를 붙여주세요.` : null,
        '문자를 보내면 후원 금액을 고를 수 있는 링크가 발송됩니다.',
        '최초 1회 계좌 등록이 필요하며, 만 19세 이상만 이용할 수 있습니다.',
      ]
        .filter(Boolean)
        .join('\n')
    : null;

  return (
    <>
      <PageHeader
        title="문자 관리"
        description={`조건에 맞는 수신 문자 ${formatNumber(total)}건 · ${page} / ${totalPages} 페이지`}
      />

      <div className="space-y-4">
        <MoNumberPanel numbers={numbers} guideText={guideText} />

        <Notice tone="neutral" title="문자 원문은 표시되지 않습니다">
          필터링을 마친 내용만 확인할 수 있습니다. 개인정보가 포함될 수 있는 원문과 후원자 전화번호 전체는
          사회복지기관에 제공되지 않습니다. <b>차단·필터</b> 탭에는 금칙어뿐 아니라 전화번호·계좌 같은 개인정보 마스킹이
          적용된 문자도 함께 나옵니다.
        </Notice>

        <Card padded={false}>
          <div className="flex flex-wrap items-center gap-1.5 border-b border-ink-100 p-2">
            <span className="mr-1 text-[12px] font-bold text-ink-400">기간</span>
            {PERIODS.map((p) => (
              <Link
                key={p.value}
                href={`/studio/messages${buildQuery({ tab }, { period: p.value })}`}
                className={
                  p.value === period
                    ? 'rounded-lg bg-ink-900 px-2.5 py-1.5 text-[12px] font-bold text-white'
                    : 'rounded-lg px-2.5 py-1.5 text-[12px] font-bold text-ink-500 hover:bg-ink-50'
                }
              >
                {p.label}
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 p-2">
            {TABS.map((t) => (
              <Link
                key={t.value}
                href={`/studio/messages${buildQuery({ period }, { tab: t.value === 'all' ? undefined : t.value })}`}
                className={
                  t.value === tab
                    ? 'rounded-lg bg-brand-50 px-3 py-2 text-[13px] font-bold text-brand-700'
                    : 'rounded-lg px-3 py-2 text-[13px] font-medium text-ink-500 hover:bg-ink-50 hover:text-ink-900'
                }
              >
                {t.label}
              </Link>
            ))}
          </div>
        </Card>

        {rows.length === 0 ? (
          <EmptyState title="해당 조건의 문자가 없습니다" description="다른 탭을 선택해 보세요." />
        ) : (
          <Table className="min-w-full">
            <thead>
              <tr>
                <Th>수신시각</Th>
                <Th>후원자</Th>
                <Th>키워드</Th>
                <Th>내용(필터링됨)</Th>
                <Th>처리 결과</Th>
                <Th>결제 상태</Th>
                <Th className="text-right">결제 금액</Th>
                <Th>조치</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const res = moResultLabel[m.result];
                const charge = m.charge;
                const ds = charge ? chargeStatusLabel[charge.status] : null;
                const payerId = charge?.payerId ?? null;
                const isBlocked = payerId ? blockedSet.has(payerId) : false;
                return (
                  <tr key={m.id} className="hover:bg-ink-50">
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(m.receivedAt, false)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{m.phoneMasked}</Td>
                    <Td className="whitespace-nowrap">{m.matchedKeyword ?? '-'}</Td>
                    <Td className="max-w-[320px]">
                      <span className="line-clamp-2">{m.contentFiltered ?? '(표시할 내용 없음)'}</span>
                    </Td>
                    <Td>
                      <Badge tone={res.tone}>{res.text}</Badge>
                      {m.resultDetail ? (
                        <span className="mt-1 block text-[11.5px] text-ink-400">{m.resultDetail}</span>
                      ) : null}
                    </Td>
                    <Td>
                      {charge && ds ? (
                        <Link href={`/studio/charges/${charge.id}`} className="inline-block">
                          <Badge tone={ds.tone}>{ds.text}</Badge>
                        </Link>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      {charge ? formatWon(charge.amount) : '-'}
                    </Td>
                    <Td>
                      {payerId ? (
                        isBlocked ? (
                          <Badge tone="danger">차단됨</Badge>
                        ) : (
                          <InlineActionForm
                            action={blockPayerAction}
                            submitLabel="후원자 차단"
                            variant="danger"
                            confirmMessage="이 후원자를 차단하시겠습니까? 이후 문자는 결제로 접수되지 않습니다."
                            fields={{ payerId, reason: '문자 관리 화면에서 차단' }}
                          />
                        )
                      ) : (
                        <span className="text-[12px] text-ink-300">후원자 미확인</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}

        {totalPages > 1 ? (
          <nav className="flex items-center justify-center gap-2">
            <PageLink href={`/studio/messages${buildQuery(base, { page: page - 1 })}`} disabled={page <= 1}>
              이전
            </PageLink>
            <span className="text-[13px] tabular-nums text-ink-500">
              {page} / {totalPages}
            </span>
            <PageLink href={`/studio/messages${buildQuery(base, { page: page + 1 })}`} disabled={page >= totalPages}>
              다음
            </PageLink>
          </nav>
        ) : null}
      </div>
    </>
  );
}

function PageLink({ href, disabled, children }: { href: string; disabled: boolean; children: React.ReactNode }) {
  if (disabled) {
    return (
      <span className="inline-flex h-9 items-center rounded-lg border border-ink-100 px-3 text-[13px] font-semibold text-ink-300">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="inline-flex h-9 items-center rounded-lg border border-ink-200 bg-white px-3 text-[13px] font-semibold text-ink-700 hover:bg-ink-50"
    >
      {children}
    </Link>
  );
}
