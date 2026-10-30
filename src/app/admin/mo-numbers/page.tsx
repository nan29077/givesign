import Link from 'next/link';
import { formatMoNumber } from '@/lib/mo-number';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar } from '@/components/admin/controls';
import { ActionButton, ActionForm, SelectActionForm } from '@/components/admin/action-form';
import { createMoNumber, assignMoNumber, changeMoNumberStatus } from '@/app/actions/admin/transactions';
import { canManageMoney } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { moNumberStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { MoNumberStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const STATUSES: MoNumberStatus[] = ['AVAILABLE', 'RESERVED', 'ASSIGNED', 'RECLAIMED', 'DISABLED'];

export default async function AdminMoNumbersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canManageMoney(me.adminPermission);

  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const status = STATUSES.includes(sp.status as MoNumberStatus) ? (sp.status as MoNumberStatus) : undefined;

  const where: Prisma.MerchantMoNumberWhereInput = {
    ...(status ? { status } : {}),
    ...(q ? { OR: [{ phoneNumber: { contains: q.replace(/[\s-]/g, '') } }, { keyword: { contains: q.toUpperCase() } }, { merchant: { displayName: { contains: q } } }] } : {}),
  };

  const [numbers, grouped, costSum, approvedMerchants] = await Promise.all([
    prisma.merchantMoNumber.findMany({
      where,
      orderBy: [{ status: 'asc' }, { phoneNumber: 'asc' }],
      take: 200,
      select: {
        id: true, phoneNumber: true, keyword: true, mode: true, status: true, monthlyCost: true,
        assignedAt: true, releasedAt: true, memo: true,
        merchant: { select: { id: true, displayName: true, code: true } },
      },
    }),
    prisma.merchantMoNumber.groupBy({ by: ['status'], _count: { _all: true }, _sum: { monthlyCost: true } }),
    prisma.merchantMoNumber.aggregate({ _sum: { monthlyCost: true } }),
    prisma.merchantProfile.findMany({
      where: { status: 'APPROVED' },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true, code: true },
    }),
  ]);

  const countOf = (s: MoNumberStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const assignedCost = grouped.find((g) => g.status === 'ASSIGNED')?._sum.monthlyCost ?? 0n;

  return (
    <>
      <PageHeader
        title="MO 번호 재고·배정"
        description="수신번호는 전용번호(DEDICATED) 또는 대표번호 공유(SHARED_PREFIX + 키워드) 두 가지 방식으로 운영합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-6">
        {STATUSES.map((s) => (
          <StatTile
            key={s}
            label={moNumberStatusLabel[s].text}
            value={formatNumber(countOf(s))}
            tone={s === 'ASSIGNED' ? 'success' : s === 'DISABLED' ? 'danger' : 'neutral'}
          />
        ))}
        <StatTile
          label="월 비용 합계"
          value={formatWon(costSum._sum.monthlyCost ?? 0n)}
          sub={`배정분 ${formatWon(assignedCost)}`}
          tone="brand"
        />
      </div>

      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardTitle>번호 등록</CardTitle>
          <p className="mt-1 mb-3 text-[12px] leading-relaxed text-ink-400">
            사업자에게 발급받은 수신번호를 재고로 등록합니다. 대표번호 공유 모드는 키워드가 반드시 필요합니다.
          </p>
          <ActionForm disabled={!canEdit} action={createMoNumber} submitLabel="재고 등록">
            <AdminField label="수신번호" hint="1588-1234-1234 형식 (하이픈 없이 입력해도 됩니다)">
              <AdminInput name="phoneNumber" inputMode="tel" placeholder="1588-1234-1234" maxLength={14} required />
            </AdminField>
            <AdminField label="키워드" hint="대표번호 공유 모드에서 문자 맨 앞에 붙는 식별 키워드">
              <AdminInput name="keyword" placeholder="GIVESIGN" />
            </AdminField>
            <AdminField label="수신 모드">
              <AdminSelect name="mode" defaultValue="DEDICATED">
                <option value="DEDICATED">전용번호 (DEDICATED)</option>
                <option value="SHARED_PREFIX">대표번호 공유 (SHARED_PREFIX)</option>
              </AdminSelect>
            </AdminField>
            <AdminField label="월 비용 (원)">
              <AdminInput name="monthlyCost" inputMode="numeric" defaultValue="0" required />
            </AdminField>
            <AdminField label="메모">
              <AdminInput name="memo" placeholder="계약 사업자, 회선 구분 등" />
            </AdminField>
          </ActionForm>
        </Card>

        <div className="lg:col-span-2">
          <Notice tone="neutral" title="배정·회수 규칙">
            승인된 사회복지기관에만 번호를 배정할 수 있습니다. 회수하면 사회복지기관 연결이 끊기고 상태가 회수로
            바뀌며, 해당 번호로 들어온 문자는 대상 없음으로 처리됩니다. 사용중지는 회선 해지 등 더 이상 사용하지 않는
            번호에 사용합니다. 모든 변경은 감사로그에 기록됩니다.
          </Notice>
          <div className="mt-3">
            <FilterBar action="/admin/mo-numbers" resetHref="/admin/mo-numbers">
              <AdminField label="번호·키워드 검색" className="w-52">
                <AdminInput name="q" defaultValue={q} placeholder="1588... 또는 기관명" />
              </AdminField>
              <AdminField label="상태" className="w-40">
                <AdminSelect name="status" defaultValue={status ?? ''}>
                  <option value="">전체</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {moNumberStatusLabel[s].text}
                    </option>
                  ))}
                </AdminSelect>
              </AdminField>
            </FilterBar>
          </div>
        </div>
      </div>

      <SectionTitle title="번호 목록" description="최대 200건까지 표시합니다." />

      {numbers.length === 0 ? (
        <EmptyState title="등록된 MO 번호가 없습니다" description="왼쪽 등록 폼으로 재고를 먼저 추가하세요." />
      ) : (
        <Table className="min-w-[1100px]">
          <thead>
            <tr>
              <Th>번호</Th>
              <Th>키워드</Th>
              <Th>모드</Th>
              <Th>상태</Th>
              <Th>배정 사회복지기관</Th>
              <Th className="text-right">월 비용</Th>
              <Th>배정·회수</Th>
              <Th>배정</Th>
              <Th>상태 변경</Th>
            </tr>
          </thead>
          <tbody>
            {numbers.map((n) => (
              <tr key={n.id}>
                <Td className="font-mono text-[13px] font-semibold">{formatMoNumber(n.phoneNumber)}</Td>
                <Td>{n.keyword ?? '-'}</Td>
                <Td>{n.mode === 'DEDICATED' ? '전용번호' : '대표번호 공유'}</Td>
                <Td>
                  <Badge tone={moNumberStatusLabel[n.status].tone}>{moNumberStatusLabel[n.status].text}</Badge>
                  {n.memo ? <span className="mt-0.5 block max-w-[140px] text-[11px] break-words text-ink-400">{n.memo}</span> : null}
                </Td>
                <Td>
                  {n.merchant ? (
                    <Link href={`/admin/merchants/${n.merchant.id}`} className="font-semibold text-brand-700">
                      {n.merchant.displayName}
                    </Link>
                  ) : (
                    <span className="text-ink-300">-</span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">{formatWon(n.monthlyCost)}</Td>
                <Td className="whitespace-nowrap text-[11px] text-ink-400">
                  {n.assignedAt ? `배정 ${formatKst(n.assignedAt, false)}` : '-'}
                  {n.releasedAt ? <span className="block">회수 {formatKst(n.releasedAt, false)}</span> : null}
                </Td>
                <Td>
                  {n.status === 'ASSIGNED' || n.status === 'DISABLED' ? (
                    <span className="text-[12px] text-ink-300">-</span>
                  ) : (
                    <SelectActionForm disabled={!canEdit}
                      action={assignMoNumber}
                      values={{ id: n.id }}
                      name="merchantId"
                      options={[
                        { value: '', label: '사회복지기관 선택' },
                        ...approvedMerchants.map((c) => ({ value: c.id, label: `${c.displayName} (${c.code})` })),
                      ]}
                      submitLabel="배정"
                      confirm="선택한 사회복지기관에 이 수신번호를 배정합니다."
                    />
                  )}
                </Td>
                <Td>
                  <div className="flex flex-col gap-1.5">
                    {n.status === 'ASSIGNED' ? (
                      <ActionButton disabled={!canEdit}
                        action={changeMoNumberStatus}
                        values={{ id: n.id, status: 'RECLAIMED' }}
                        label="회수"
                        confirm="배정을 해제하고 번호를 회수합니다. 이 번호로 들어오는 문자는 대상 없음으로 처리됩니다."
                      />
                    ) : null}
                    {n.status !== 'DISABLED' ? (
                      <ActionButton disabled={!canEdit}
                        action={changeMoNumberStatus}
                        values={{ id: n.id, status: 'DISABLED' }}
                        label="사용중지"
                        variant="danger"
                        confirm="번호를 사용중지 처리합니다."
                      />
                    ) : (
                      <ActionButton disabled={!canEdit}
                        action={changeMoNumberStatus}
                        values={{ id: n.id, status: 'AVAILABLE' }}
                        label="재고 복귀"
                        confirm="사용중지를 해제하고 재고로 되돌립니다."
                      />
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
