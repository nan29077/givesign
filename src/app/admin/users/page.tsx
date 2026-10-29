import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { SelectActionForm } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, clampPage, canWrite, canManageMoney } from '@/components/admin/constants';
import { issueTemporaryPasswordAction, updateUserStatus } from '@/app/actions/admin/accounts';
import { TempPasswordButton } from '@/components/admin/temp-password-button';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import type { Prisma } from '@/generated/prisma/client';
import type { UserRole, UserStatus } from '@/generated/prisma/enums';
import { ProfileAvatar } from '@/components/profile/generated-avatar';

export const dynamic = 'force-dynamic';

const roleLabel: Record<UserRole, string> = { PAYER: '후원자', MERCHANT: '사회복지기관', ADMIN: '관리자' };
const statusLabel: Record<UserStatus, { text: string; tone: 'success' | 'warning' | 'neutral' }> = {
  ACTIVE: { text: '활성', tone: 'success' },
  SUSPENDED: { text: '정지', tone: 'warning' },
  WITHDRAWN: { text: '탈퇴', tone: 'neutral' },
};

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; role?: string; status?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canWrite(me.adminPermission);
  // 임시 비밀번호 발급은 issueTemporaryPasswordAction 이 READ_ONLY 와 SUPPORT 를 모두 막는다.
  const canIssueTempPassword = canManageMoney(me.adminPermission);

  const sp = await searchParams;
  const now = new Date();
  const page = parsePage(sp.page);
  const q = (sp.q ?? '').trim();
  // `in` 은 프로토타입 체인까지 본다. `?role=constructor` · `?status=toString` 이
  // 통과해 Prisma 에 enum 이 아닌 값이 넘어가고 목록이 500 으로 죽는다.
  // 객체가 직접 가진 키만 본다.
  const role = sp.role && Object.hasOwn(roleLabel, sp.role) ? (sp.role as UserRole) : undefined;
  const status = sp.status && Object.hasOwn(statusLabel, sp.status) ? (sp.status as UserStatus) : undefined;

  const where: Prisma.UserWhereInput = {
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: 'insensitive' as const } },
            { name: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, users, byStatus, resetRequests] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, email: true, name: true, role: true, status: true, avatarIndex: true,
        phoneMasked: true, lastLoginAt: true, createdAt: true,
        merchantProfile: { select: { id: true, displayName: true, code: true, avatarUrl: true } },
        payerProfile: { select: { id: true } },
        adminProfile: { select: { permission: true } },
      },
    }),
    prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
    // 이메일 발송 연동 전이라 재설정 링크 원문은 서버 로그에만 남는다.
    // 여기서는 "요청이 실제로 접수됐는지" 만 확인할 수 있게 최근 요청을 보여 준다.
    prisma.passwordResetToken.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        usedAt: true,
        user: { select: { email: true } },
      },
    }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/users', params: { q, role: role ?? '', status: status ?? '' }, page, lastPage, total });
  const count = (s: UserStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="회원 관리"
        description="이메일·이름으로 검색하고 계정 상태를 변경합니다. 상태 변경 시 활성 세션이 즉시 만료됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="전체 회원" value={formatNumber(byStatus.reduce((a, b) => a + b._count._all, 0))} />
        <StatTile label="활성" value={formatNumber(count('ACTIVE'))} tone="success" />
        <StatTile label="정지" value={formatNumber(count('SUSPENDED'))} tone="warning" />
        <StatTile label="탈퇴" value={formatNumber(count('WITHDRAWN'))} />
      </div>

      <FilterBar action="/admin/users" resetHref="/admin/users">
        <AdminField label="검색 (이메일/이름)" className="w-56">
          <AdminInput name="q" defaultValue={q} placeholder="example@givesign.kr" />
        </AdminField>
        <AdminField label="회원 유형" className="w-36">
          <AdminSelect name="role" defaultValue={role ?? ''}>
            <option value="">전체</option>
            {(Object.keys(roleLabel) as UserRole[]).map((r) => (
              <option key={r} value={r}>
                {roleLabel[r]}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
        <AdminField label="상태" className="w-36">
          <AdminSelect name="status" defaultValue={status ?? ''}>
            <option value="">전체</option>
            {(Object.keys(statusLabel) as UserStatus[]).map((s) => (
              <option key={s} value={s}>
                {statusLabel[s].text}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
      </FilterBar>

      <Notice tone="neutral" title="개인정보 표시 원칙">
        전화번호는 마스킹된 값만 표시합니다. 원문 전화번호·계좌번호는 관리자 화면에서도 조회할 수 없습니다.
      </Notice>

      <div className="mt-4">
        {users.length === 0 ? (
          <EmptyState title="조건에 맞는 회원이 없습니다" description="검색어나 필터를 조정해 보세요." />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>이메일</Th>
                  <Th>이름</Th>
                  <Th>유형</Th>
                  <Th>연락처</Th>
                  <Th>상태</Th>
                  <Th>최근 로그인</Th>
                  <Th>가입일</Th>
                  <Th>상태 변경</Th>
                  <Th>비밀번호</Th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <Td className="max-w-[220px] break-all">{u.email ?? '-'}</Td>
                    <Td>
                      <div className="flex min-w-[150px] items-center gap-2.5">
                        <ProfileAvatar
                          seed={u.merchantProfile?.code ?? u.id}
                          avatarIndex={u.avatarIndex}
                          imageUrl={u.merchantProfile?.avatarUrl}
                          name={u.name}
                          className="h-9 w-9"
                        />
                        <div className="min-w-0">
                      <span className="block truncate font-semibold text-ink-900">{u.name ?? '-'}</span>
                      {u.merchantProfile ? (
                        <Link
                          href={`/admin/merchants/${u.merchantProfile.id}`}
                          className="mt-0.5 block text-[11px] font-semibold text-brand-700"
                        >
                          {u.merchantProfile.displayName} ({u.merchantProfile.code})
                        </Link>
                      ) : null}
                      {u.payerProfile ? (
                        <Link
                          href={`/admin/payers/${u.payerProfile.id}`}
                          className="mt-0.5 block text-[11px] font-semibold text-brand-700"
                        >
                          후원자 상세
                        </Link>
                      ) : null}
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={u.role === 'ADMIN' ? 'brand' : 'neutral'}>{roleLabel[u.role]}</Badge>
                      {u.adminProfile ? (
                        <span className="mt-0.5 block text-[11px] text-ink-400">{u.adminProfile.permission}</span>
                      ) : null}
                    </Td>
                    <Td>{u.phoneMasked ?? '-'}</Td>
                    <Td>
                      <Badge tone={statusLabel[u.status].tone}>{statusLabel[u.status].text}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap">{formatKst(u.lastLoginAt, false)}</Td>
                    <Td className="whitespace-nowrap">{formatKst(u.createdAt, false)}</Td>
                    <Td>
                      <SelectActionForm disabled={!canEdit}
                        action={updateUserStatus}
                        values={{ userId: u.id }}
                        name="status"
                        defaultValue={u.status}
                        options={[
                          { value: 'ACTIVE', label: '활성' },
                          { value: 'SUSPENDED', label: '정지' },
                          // 본인 탈퇴(결제수단 해지 + 개인정보 정리)와 다른 처리라 라벨을 구분한다.
                          { value: 'WITHDRAWN', label: '해지(관리자 처리)' },
                        ]}
                        confirm={`${u.email ?? u.id} 회원의 상태를 변경합니다. 계속할까요?`}
                      />
                    </Td>
                    <Td>
                      <TempPasswordButton
                        action={issueTemporaryPasswordAction}
                        userId={u.id}
                        label={u.email ?? u.id}
                        disabled={!canIssueTempPassword}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/users"
              params={{ q, role: role ?? '', status: status ?? '' }}
              page={page}
              lastPage={lastPage}
              total={total}
            />
          </>
        )}
      </div>

      <div className="mt-4">
        <SectionTitle
          title="최근 비밀번호 재설정 요청"
          description="사용자가 로그인 화면에서 직접 요청한 건입니다. 최근 10건."
        />
        <Notice tone="warning" title="재설정 링크 원문은 관리자도 볼 수 없습니다">
          링크 토큰은 해시로만 저장됩니다. 이메일 발송 연동 전까지는 링크 원문이 서버 로그에만 남으므로,
          사용자에게 직접 안내해야 할 때는 본인 확인 후 회원 목록의 [임시 비밀번호] 버튼을 사용해 주세요.
        </Notice>
        <div className="mt-3">
          {resetRequests.length === 0 ? (
            <EmptyState title="접수된 재설정 요청이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>이메일</Th>
                  <Th>요청 시각</Th>
                  <Th>만료 시각</Th>
                  <Th>상태</Th>
                </tr>
              </thead>
              <tbody>
                {resetRequests.map((r) => {
                  const expired = r.expiresAt.getTime() < now.getTime();
                  return (
                    <tr key={r.id}>
                      <Td className="max-w-[220px] break-all">{r.user.email ?? '-'}</Td>
                      <Td className="whitespace-nowrap">{formatKst(r.createdAt)}</Td>
                      <Td className="whitespace-nowrap">{formatKst(r.expiresAt)}</Td>
                      <Td>
                        {r.usedAt ? (
                          <Badge tone="success">사용됨</Badge>
                        ) : expired ? (
                          <Badge tone="neutral">만료</Badge>
                        ) : (
                          <Badge tone="brand">대기 중</Badge>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
      </div>
    </>
  );
}
