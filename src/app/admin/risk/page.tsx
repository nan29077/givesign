import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminSelect, FilterBar, JsonView, Pager } from '@/components/admin/controls';
import { ActionButton } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, clampPage, canManageMoney } from '@/components/admin/constants';
import { resolveRiskDetection } from '@/app/actions/admin/transactions';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst, kstStartOfDay, kstStartOfMonth } from '@/lib/datetime';
import { riskLevelLabel, riskTypeLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { RiskLevel, RiskType } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const LEVELS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
// 라벨 사전에서 파생시킨다. 손으로 나열하면 enum 이 늘 때 필터에서 빠진다
// (실제로 CRITICAL 로만 생성되는 PAYMENT_UNKNOWN 이 목록에도 URL 파라미터 검증에도 없었다).
const TYPES = Object.keys(riskTypeLabel) as RiskType[];

export default async function AdminRiskPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string; type?: string; resolved?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canManageMoney(me.adminPermission);

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const level = LEVELS.includes(sp.level as RiskLevel) ? (sp.level as RiskLevel) : undefined;
  const type = TYPES.includes(sp.type as RiskType) ? (sp.type as RiskType) : undefined;
  const resolvedFilter = sp.resolved === 'YES' ? true : sp.resolved === 'NO' ? false : undefined;

  const where: Prisma.RiskDetectionWhereInput = {
    ...(level ? { level } : {}),
    ...(type ? { type } : {}),
    ...(resolvedFilter !== undefined ? { resolved: resolvedFilter } : {}),
  };

  const todayStart = kstStartOfDay();
  const monthStart = kstStartOfMonth();

  const [total, risks, byLevel, unresolved, blockedToday, blockedMonth, blockedAgg, byType] = await Promise.all([
    prisma.riskDetection.count({ where }),
    prisma.riskDetection.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, type: true, level: true, resolved: true, resolvedBy: true, resolvedAt: true,
        createdAt: true, detail: true, chargeId: true, merchantId: true,
        payer: { select: { id: true, phoneMasked: true } },
      },
    }),
    prisma.riskDetection.groupBy({ by: ['level'], where: { resolved: false }, _count: { _all: true } }),
    prisma.riskDetection.count({ where: { resolved: false } }),
    prisma.charge.count({ where: { status: 'LIMIT_BLOCKED', receivedAt: { gte: todayStart } } }),
    prisma.charge.count({ where: { status: 'LIMIT_BLOCKED', receivedAt: { gte: monthStart } } }),
    prisma.charge.aggregate({ where: { status: 'LIMIT_BLOCKED' }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.riskDetection.groupBy({ by: ['type'], where: { resolved: false }, _count: { _all: true } }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/risk', params: { level: level ?? '', type: type ?? '', resolved: sp.resolved ?? '' }, page, lastPage, total });
  // RiskDetection 에는 charge 관계가 없다. 내부 ID 를 그대로 보여 주면 결제 화면에서 검색조차
  // 되지 않으므로, 이 페이지에 보이는 건의 거래번호만 따로 읽어 링크로 건다.
  const chargeIds = risks.map((r) => r.chargeId).filter((v): v is string => Boolean(v));
  const chargeNoRows = chargeIds.length
    ? await prisma.charge.findMany({
        where: { id: { in: chargeIds } },
        select: { id: true, transactionNo: true },
      })
    : [];
  const transactionNoOf = new Map(chargeNoRows.map((c) => [c.id, c.transactionNo]));

  const levelCount = (l: RiskLevel) => byLevel.find((b) => b.level === l)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="한도·이상거래"
        description="한도 정책에 걸린 결제와 이상거래 탐지 이력을 확인하고 해결 처리합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="미해결 탐지" value={formatNumber(unresolved)} tone={unresolved > 0 ? 'danger' : 'success'} />
        <StatTile label="미해결 HIGH 이상" value={formatNumber(levelCount('HIGH') + levelCount('CRITICAL'))} tone="warning" />
        <StatTile label="오늘 한도 차단" value={formatNumber(blockedToday)} sub={`이번 달 ${formatNumber(blockedMonth)}건`} />
        <StatTile
          label="한도 차단 누적"
          value={formatNumber(blockedAgg._count._all)}
          sub={`차단 금액 합계 ${formatWon(blockedAgg._sum.amount ?? 0n)}`}
        />
      </div>

      <Notice tone="neutral" title="한도 차단과 이상거래 탐지">
        한도 차단(LIMIT_BLOCKED)은 정책 위반으로 결제 이전에 차단된 결제입니다. 이상거래 탐지는 속도·금액·실패 패턴을
        기록한 것으로, 결제 차단 여부와 별개로 운영자가 검토해야 합니다.
      </Notice>

      {byType.length > 0 ? (
        <div className="mt-4">
          <SectionTitle title="미해결 탐지 유형 분포" />
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {byType.map((t) => (
              <StatTile key={t.type} label={riskTypeLabel[t.type]} value={formatNumber(t._count._all)} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-5">
        <SectionTitle title="이상거래 탐지 목록" />
        <FilterBar action="/admin/risk" resetHref="/admin/risk">
          <AdminField label="위험 레벨" className="w-36">
            <AdminSelect name="level" defaultValue={level ?? ''}>
              <option value="">전체</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {riskLevelLabel[l].text}
                </option>
              ))}
            </AdminSelect>
          </AdminField>
          <AdminField label="탐지 유형" className="w-44">
            <AdminSelect name="type" defaultValue={type ?? ''}>
              <option value="">전체</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {riskTypeLabel[t]}
                </option>
              ))}
            </AdminSelect>
          </AdminField>
          <AdminField label="해결 여부" className="w-36">
            <AdminSelect name="resolved" defaultValue={sp.resolved ?? ''}>
              <option value="">전체</option>
              <option value="NO">미해결</option>
              <option value="YES">해결</option>
            </AdminSelect>
          </AdminField>
        </FilterBar>

        {risks.length === 0 ? (
          <EmptyState title="조건에 맞는 탐지 내역이 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1100px]">
              <thead>
                <tr>
                  <Th>탐지 시각</Th>
                  <Th>유형</Th>
                  <Th>레벨</Th>
                  <Th>후원자</Th>
                  <Th>연결 거래</Th>
                  <Th>상세</Th>
                  <Th>해결</Th>
                  <Th>처리</Th>
                </tr>
              </thead>
              <tbody>
                {risks.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap">{formatKst(r.createdAt, false)}</Td>
                    <Td>{riskTypeLabel[r.type]}</Td>
                    <Td>
                      <Badge tone={riskLevelLabel[r.level].tone}>{riskLevelLabel[r.level].text}</Badge>
                    </Td>
                    <Td>
                      {r.payer ? (
                        <Link href={`/admin/payers/${r.payer.id}`} className="font-semibold text-brand-700">
                          {r.payer.phoneMasked}
                        </Link>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </Td>
                    <Td className="font-mono text-[11px]">
                      {r.chargeId && transactionNoOf.has(r.chargeId) ? (
                        <Link
                          href={`/admin/payments?q=${encodeURIComponent(transactionNoOf.get(r.chargeId)!)}`}
                          className="font-semibold text-brand-700"
                        >
                          {transactionNoOf.get(r.chargeId)}
                        </Link>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </Td>
                    <Td>
                      <details>
                        <summary className="cursor-pointer text-[12px] text-brand-700">상세 보기</summary>
                        <div className="mt-1.5">
                          <JsonView value={r.detail} maxLength={600} />
                        </div>
                      </details>
                    </Td>
                    <Td>
                      {r.resolved ? (
                        <>
                          <Badge tone="success">해결</Badge>
                          <span className="mt-0.5 block text-[11px] text-ink-400">
                            {formatKst(r.resolvedAt, false)}
                            {r.resolvedBy ? ` · ${r.resolvedBy}` : ''}
                          </span>
                        </>
                      ) : (
                        <Badge tone="danger">미해결</Badge>
                      )}
                    </Td>
                    <Td>
                      {r.resolved ? (
                        <span className="text-[12px] text-ink-300">-</span>
                      ) : (
                        <ActionButton disabled={!canEdit}
                          action={resolveRiskDetection}
                          values={{ riskId: r.id }}
                          label="해결 처리"
                          confirm="이 탐지 건을 해결 처리합니다. 처리자와 시각이 기록됩니다."
                        />
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/risk"
              params={{ level: level ?? '', type: type ?? '', resolved: sp.resolved ?? '' }}
              page={page}
              lastPage={lastPage}
              total={total}
            />
          </>
        )}
      </div>
    </>
  );
}
