import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { ActionForm, SelectActionForm } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, clampPage, canManageMoney } from '@/components/admin/constants';
import { updateMerchantStatus, applyGlobalAmountBounds } from '@/app/actions/admin/accounts';
import { assignMoNumber } from '@/app/actions/admin/transactions';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { merchantStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { MerchantStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const STATUS_OPTIONS: Array<{ value: MerchantStatus; label: string }> = [
  { value: 'PENDING', label: '심사대기' },
  { value: 'APPROVED', label: '승인' },
  { value: 'REJECTED', label: '반려' },
  { value: 'SUSPENDED', label: '정지' },
];

const merchantSelect = {
  id: true,
  displayName: true,
  channelName: true,
  code: true,
  status: true,
  allowCustomAmount: true,
  approvedAt: true,
  createdAt: true,
  user: { select: { email: true, name: true, phoneMasked: true } },
  moRoutes: { where: { status: 'ASSIGNED' as const }, select: { phoneNumber: true, keyword: true } },
  _count: { select: { charges: true, chargeProducts: true } },
} satisfies Prisma.MerchantProfileSelect;

function MerchantRows({
  merchants,
  canEdit,
  availableMoNumbers,
}: {
  /** 권한이 없으면 심사 상태 변경을 잠근다. */
  canEdit: boolean;
  availableMoNumbers: Array<{ id: string; phoneNumber: string; keyword: string | null }>;
  merchants: Array<{
    id: string;
    displayName: string;
    channelName: string | null;
    code: string;
    status: MerchantStatus;
    allowCustomAmount: boolean;
    approvedAt: Date | null;
    createdAt: Date;
    user: { email: string | null; name: string | null; phoneMasked: string | null };
    moRoutes: Array<{ phoneNumber: string; keyword: string | null }>;
    _count: { charges: number; chargeProducts: number };
  }>;
}) {
  return (
    <tbody>
      {merchants.map((c) => (
        <tr key={c.id}>
          <Td>
            <Link href={`/admin/merchants/${c.id}`} className="font-semibold text-brand-700">
              {c.displayName}
            </Link>
            <span className="mt-0.5 block text-[11px] text-ink-400">{c.channelName ?? '채널명 미등록'}</span>
          </Td>
          <Td className="font-mono text-[12px]">{c.code}</Td>
          <Td>
            {c.user.email ?? '-'}
            <span className="mt-0.5 block text-[11px] text-ink-400">{c.user.phoneMasked ?? '연락처 미등록'}</span>
          </Td>
          <Td className="text-right tabular-nums">{c._count.chargeProducts}개{c.allowCustomAmount ? " + 직접" : ""}</Td>
          <Td>
            {c.moRoutes.length > 0 ? (
              c.moRoutes.map((m) => (
                <span key={`${m.phoneNumber}-${m.keyword ?? ''}`} className="block text-[12px]">
                  {m.phoneNumber}
                  {m.keyword ? ` (${m.keyword})` : ''}
                </span>
              ))
            ) : c.status === 'APPROVED' && availableMoNumbers.length > 0 ? (
              <SelectActionForm
                disabled={!canEdit}
                action={assignMoNumber}
                values={{ merchantId: c.id }}
                name="id"
                options={availableMoNumbers.map((m) => ({
                  value: m.id,
                  label: m.phoneNumber + (m.keyword ? ` (${m.keyword})` : ''),
                }))}
                submitLabel="배정"
                confirm={`${c.displayName} 에게 선택한 MO 번호를 배정합니다.`}
              />
            ) : (
              <Badge tone="warning">미배정</Badge>
            )}
          </Td>
          <Td className="text-right tabular-nums">{formatNumber(c._count.charges)}</Td>
          <Td>
            <Badge tone={merchantStatusLabel[c.status].tone}>{merchantStatusLabel[c.status].text}</Badge>
            <span className="mt-0.5 block text-[11px] text-ink-400">
              신청 {formatKst(c.createdAt, false)}
              {c.approvedAt ? ` · 승인 ${formatKst(c.approvedAt, false)}` : ''}
            </span>
          </Td>
          <Td>
            <SelectActionForm disabled={!canEdit}
              action={updateMerchantStatus}
              values={{ merchantId: c.id }}
              name="status"
              defaultValue={c.status}
              options={STATUS_OPTIONS}
              confirm={`${c.displayName} 님의 심사 상태를 변경합니다.`}
              hint={c.status === 'PENDING' ? '승인 후 MO 번호 배정이 필요합니다.' : undefined}
            />
          </Td>
        </tr>
      ))}
    </tbody>
  );
}

const HEAD = (
  <thead>
    <tr>
      <Th>사회복지기관</Th>
      <Th>코드</Th>
      <Th>담당자</Th>
      <Th className="text-right">후원 항목</Th>
      <Th>MO 번호</Th>
      <Th className="text-right">결제 건수</Th>
      <Th>상태</Th>
      <Th>심사 처리</Th>
    </tr>
  </thead>
);

export default async function AdminMerchantsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canManageMoney(me.adminPermission);

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? '').trim();
  const status = STATUS_OPTIONS.some((s) => s.value === sp.status) ? (sp.status as MerchantStatus) : undefined;

  const where: Prisma.MerchantProfileWhereInput = {
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { displayName: { contains: q, mode: 'insensitive' as const } },
            { channelName: { contains: q, mode: 'insensitive' as const } },
            { code: { contains: q.toUpperCase() } },
            { user: { email: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [pending, pendingTotal, total, merchants, byStatus, availableMoNumbers] = await Promise.all([
    prisma.merchantProfile.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: merchantSelect,
    }),
    prisma.merchantProfile.count({ where: { status: 'PENDING' } }),
    prisma.merchantProfile.count({ where }),
    prisma.merchantProfile.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: merchantSelect,
    }),
    prisma.merchantProfile.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.merchantMoNumber.findMany({
      where: { status: 'AVAILABLE' },
      select: { id: true, phoneNumber: true, keyword: true },
      orderBy: { phoneNumber: 'asc' },
    }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/merchants', params: { q, status: status ?? '' }, page, lastPage, total });
  const count = (s: MerchantStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="사회복지기관 심사"
        description="심사 대기 건을 먼저 처리하고, 승인 후에는 MO 번호를 배정해야 문자후원이 접수됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="심사대기" value={formatNumber(count('PENDING'))} tone={count('PENDING') > 0 ? 'warning' : 'neutral'} />
        <StatTile label="승인" value={formatNumber(count('APPROVED'))} tone="success" />
        <StatTile label="반려" value={formatNumber(count('REJECTED'))} />
        <StatTile label="정지" value={formatNumber(count('SUSPENDED'))} tone={count('SUSPENDED') > 0 ? 'danger' : 'neutral'} />
      </div>

      <section className="mb-5">
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>후원 금액 허용 범위 공통 적용</CardTitle>
            <Badge tone="warning">전체 사회복지기관 일괄 변경</Badge>
          </div>
          <p className="mt-1 mb-3 text-[12.5px] leading-relaxed text-ink-500">
            모든 사회복지기관의 후원 금액 최소·최대 허용 범위를 한 번에 변경합니다. 사회복지기관은 이 범위 안에서만
            후원 항목을 만들 수 있으며, 범위를 벗어난 상품은 자동으로 비활성화됩니다(금액은 바꾸지 않습니다).
            개별 사회복지기관의 범위는 상세 화면에서 따로 조정할 수 있습니다.
          </p>
          <ActionForm disabled={!canEdit}
            action={applyGlobalAmountBounds}
            submitLabel="전체 적용"
            confirm="모든 사회복지기관에 새 허용 범위를 일괄 적용합니다. 범위를 벗어난 후원 항목은 판매 중지(비활성)되며, 상품 금액은 바꾸지 않습니다. 되돌리려면 상품을 하나씩 다시 켜야 합니다. 계속할까요?"
          >
            <div className="grid max-w-xl grid-cols-2 gap-2">
              <AdminField label="1건 최소 (원)">
                <AdminInput name="minAmount" inputMode="numeric" defaultValue="1000" required />
              </AdminField>
              <AdminField label="1건 최대 (원)">
                <AdminInput name="maxAmount" inputMode="numeric" defaultValue="50000" required />
              </AdminField>
            </div>
          </ActionForm>
        </Card>
      </section>

      {pending.length > 0 ? (
        <section className="mb-6">
          <SectionTitle
            title={`심사 대기 ${pendingTotal}건`}
            description={
              pendingTotal > pending.length
                ? `신청 순서대로 ${pending.length}건까지 표시합니다. 승인 시 승인 시각이 기록되고 감사로그가 남습니다.`
                : '신청 순서대로 표시합니다. 승인 시 승인 시각이 기록되고 감사로그가 남습니다.'
            }
          />
          <Notice tone="warning" title="승인 전 확인 사항">
            채널 실명 확인, 사업자 정보, 정산 계좌 인증 여부를 함께 검토해 주세요. 승인 후 MO 번호 배정 화면에서 수신
            번호를 지정해야 결제 문자가 라우팅됩니다.
          </Notice>
          <div className="mt-3">
            <Table className="min-w-[1100px]">
              {HEAD}
              <MerchantRows merchants={pending} canEdit={canEdit} availableMoNumbers={availableMoNumbers} />
            </Table>
          </div>
        </section>
      ) : (
        <Notice tone="success" title="심사 대기 건이 없습니다">
          새 신청이 들어오면 이 위치에 우선 표시됩니다.
        </Notice>
      )}

      <SectionTitle title="전체 사회복지기관" />

      <FilterBar action="/admin/merchants" resetHref="/admin/merchants">
        <AdminField label="검색 (이름/채널/코드/이메일)" className="w-64">
          <AdminInput name="q" defaultValue={q} placeholder="기브싸인 또는 GIV-8K2M" />
        </AdminField>
        <AdminField label="상태" className="w-36">
          <AdminSelect name="status" defaultValue={status ?? ''}>
            <option value="">전체</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
      </FilterBar>

      {merchants.length === 0 ? (
        <EmptyState title="조건에 맞는 사회복지기관이 없습니다" />
      ) : (
        <>
          <Table className="min-w-[1100px]">
            {HEAD}
            <MerchantRows merchants={merchants} canEdit={canEdit} availableMoNumbers={availableMoNumbers} />
          </Table>
          <Pager
            basePath="/admin/merchants"
            params={{ q, status: status ?? '' }}
            page={page}
            lastPage={lastPage}
            total={total}
          />
        </>
      )}
    </>
  );
}
