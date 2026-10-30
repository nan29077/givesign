import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, MerchantOptions, Pager } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { PAGE_SIZE, canWrite, clampPage, parsePage } from '@/components/admin/constants';
import { setDonorMemberStatusAction } from '@/app/actions/admin/donor-members';
import { OrgLogo } from '@/components/brand/org-logo';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatNumber } from '@/lib/money';
import { formatKst, kstStartOfDay } from '@/lib/datetime';
import type { Prisma } from '@/generated/prisma/client';
import type { DonorMemberStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const STATUS: Record<DonorMemberStatus, { text: string; tone: 'success' | 'warning' | 'neutral' }> = {
  ACTIVE: { text: '정상', tone: 'success' },
  SUSPENDED: { text: '정지', tone: 'warning' },
  WITHDRAWN: { text: '탈퇴', tone: 'neutral' },
};

/**
 * 기관 후원페이지 회원 (통합 관리자).
 * 기관마다 독립된 후원 회원을 한곳에서 본다. 회원이 어느 기관 소속인지, 휴대폰 인증으로 후원 내역이 연결됐는지 확인한다.
 */
export default async function AdminDonorMembersPage({
  searchParams,
}: {
  searchParams: Promise<{ merchantId?: string; status?: string; q?: string; phone?: string; page?: string }>;
}) {
  const me = await requireAdmin();
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const merchantId = (sp.merchantId ?? '').trim();
  const status = (['ACTIVE', 'SUSPENDED', 'WITHDRAWN'] as const).find((s) => s === sp.status);
  const q = (sp.q ?? '').trim();
  const phone = sp.phone === 'linked' || sp.phone === 'none' ? sp.phone : '';

  const where: Prisma.DonorMemberWhereInput = {
    ...(merchantId ? { merchantId } : {}),
    ...(status ? { status } : {}),
    ...(phone === 'linked' ? { phoneVerifiedAt: { not: null } } : phone === 'none' ? { phoneVerifiedAt: null } : {}),
    ...(q ? { OR: [{ email: { contains: q.toLowerCase() } }, { name: { contains: q } }] } : {}),
  };

  const [total, rows, merchants, byMerchant, all, today, linked] = await Promise.all([
    prisma.donorMember.count({ where }),
    prisma.donorMember.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { merchant: { select: { id: true, code: true, displayName: true, avatarUrl: true } } },
    }),
    prisma.merchantProfile.findMany({ where: { status: 'APPROVED' }, orderBy: { displayName: 'asc' }, select: { id: true, code: true, displayName: true } }),
    prisma.donorMember.groupBy({ by: ['merchantId'], where: { status: { not: 'WITHDRAWN' } }, _count: { _all: true } }),
    prisma.donorMember.count({ where: { status: { not: 'WITHDRAWN' } } }),
    prisma.donorMember.count({ where: { createdAt: { gte: kstStartOfDay() } } }),
    prisma.donorMember.count({ where: { status: { not: 'WITHDRAWN' }, phoneVerifiedAt: { not: null } } }),
  ]);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const params = { merchantId, status: status ?? '', q, phone };
  clampPage({ basePath: '/admin/donor-members', params, page, lastPage, total });
  const countOf = new Map(byMerchant.map((b) => [b.merchantId, b._count._all]));
  const writable = canWrite(me.adminPermission);

  return (
    <>
      <PageHeader
        title="기관 후원 회원"
        description="각 기관 후원페이지(/donate/기관코드)에서 가입한 회원입니다. 회원은 가입한 기관에만 속하며 다른 기관과 계정이 섞이지 않습니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="전체 회원" value={formatNumber(all)} sub="탈퇴 제외" tone="brand" />
        <StatTile label="오늘 가입" value={formatNumber(today)} />
        <StatTile label="휴대폰 인증" value={formatNumber(linked)} sub={all ? `${Math.round((linked / all) * 100)}% 후원 내역 연결` : '-'} />
        <StatTile label="회원이 있는 기관" value={formatNumber(countOf.size)} />
      </div>

      {countOf.size > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {merchants
            .filter((m) => countOf.has(m.id))
            .sort((a, b) => (countOf.get(b.id) ?? 0) - (countOf.get(a.id) ?? 0))
            .map((m) => (
              <Link
                key={m.id}
                href={`/admin/donor-members?merchantId=${m.id}`}
                className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold ${merchantId === m.id ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-ink-200 bg-white text-ink-600 hover:bg-ink-50'}`}
              >
                {m.displayName} <span className="tabular-nums text-ink-400">{formatNumber(countOf.get(m.id) ?? 0)}</span>
              </Link>
            ))}
        </div>
      ) : null}

      <FilterBar action="/admin/donor-members" resetHref="/admin/donor-members">
        <AdminField label="소속 기관" className="w-60">
          <AdminSelect name="merchantId" defaultValue={merchantId}>
            <MerchantOptions merchants={merchants} allLabel="전체 기관" />
          </AdminSelect>
        </AdminField>
        <AdminField label="상태" className="w-32">
          <AdminSelect name="status" defaultValue={status ?? ''}>
            <option value="">전체</option>
            <option value="ACTIVE">정상</option>
            <option value="SUSPENDED">정지</option>
            <option value="WITHDRAWN">탈퇴</option>
          </AdminSelect>
        </AdminField>
        <AdminField label="휴대폰 인증" className="w-36">
          <AdminSelect name="phone" defaultValue={phone}>
            <option value="">전체</option>
            <option value="linked">인증함</option>
            <option value="none">미인증</option>
          </AdminSelect>
        </AdminField>
        <AdminField label="이메일·이름" className="w-56">
          <AdminInput name="q" defaultValue={q} placeholder="검색" />
        </AdminField>
      </FilterBar>

      <Notice tone="neutral" title="관리 기준">
        같은 사람이 여러 기관에 가입하면 기관마다 별도 회원으로 보입니다. 후원 내역 연결은 회원이 휴대폰을 인증해야 이뤄지며,
        연결된 번호는 마스킹 값만 표시합니다. 정지하면 즉시 로그아웃되고 다시 로그인할 수 없습니다. 모든 처리는 감사로그에 남습니다.
      </Notice>

      <div className="mt-4">
        {rows.length === 0 ? (
          <EmptyState title="조건에 맞는 후원 회원이 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1100px]">
              <thead>
                <tr>
                  <Th>소속 기관</Th>
                  <Th>회원</Th>
                  <Th>휴대폰</Th>
                  <Th>상태</Th>
                  <Th>가입 · 최근 로그인</Th>
                  <Th>관리</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <Link href={`/admin/donor-members?merchantId=${r.merchant.id}`} className="flex items-center gap-2 hover:underline">
                        <OrgLogo code={r.merchant.code} name={r.merchant.displayName} logoUrl={r.merchant.avatarUrl} className="h-8 w-8" />
                        <span className="min-w-0">
                          <span className="block truncate font-bold text-ink-900">{r.merchant.displayName}</span>
                          <span className="block font-mono text-[11px] text-ink-400">{r.merchant.code}</span>
                        </span>
                      </Link>
                    </Td>
                    <Td>
                      <span className="block font-bold text-ink-900">{r.name}</span>
                      <span className="block text-[12px] text-ink-500">{r.status === 'WITHDRAWN' ? '-' : r.email}</span>
                      {r.marketingAgreed ? <span className="mt-0.5 inline-block text-[11px] text-ink-400">소식 수신 동의</span> : null}
                    </Td>
                    <Td>
                      {r.phoneVerifiedAt ? (
                        <>
                          <Badge tone="success">인증</Badge>
                          <span className="mt-1 block font-mono text-[12px] text-ink-600">{r.phoneMasked}</span>
                        </>
                      ) : (
                        <span className="text-[12px] text-ink-400">미인증</span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].text}</Badge>
                      {r.adminNote ? <span className="mt-1 block max-w-[180px] truncate text-[11px] text-ink-400" title={r.adminNote}>{r.adminNote}</span> : null}
                    </Td>
                    <Td className="whitespace-nowrap text-[12px] text-ink-500">
                      {formatKst(r.createdAt, false)}
                      <span className="block text-ink-400">{r.lastLoginAt ? formatKst(r.lastLoginAt, false) : '로그인 기록 없음'}</span>
                    </Td>
                    <Td className="min-w-[220px]">
                      {!writable || r.status === 'WITHDRAWN' ? (
                        <span className="text-[12px] text-ink-300">-</span>
                      ) : r.status === 'ACTIVE' ? (
                        <ActionForm action={setDonorMemberStatusAction} submitLabel="정지" compact variant="danger" confirm="이 회원을 정지할까요? 즉시 로그아웃됩니다.">
                          <input type="hidden" name="memberId" value={r.id} />
                          <input type="hidden" name="status" value="SUSPENDED" />
                          <AdminInput name="note" placeholder="정지 사유 (필수)" maxLength={200} />
                        </ActionForm>
                      ) : (
                        <ActionButton action={setDonorMemberStatusAction} values={{ memberId: r.id, status: 'ACTIVE' }} label="정지 해제" />
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager basePath="/admin/donor-members" params={params} page={page} lastPage={lastPage} total={total} />
          </>
        )}
      </div>
    </>
  );
}
