import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, JsonView, Pager } from '@/components/admin/controls';
import { PAGE_SIZE, parsePage, clampPage } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatNumber } from '@/lib/money';
import { formatKst, kstStartOfDay } from '@/lib/datetime';
import type { Prisma } from '@/generated/prisma/client';

export const dynamic = 'force-dynamic';

function parseDate(raw?: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(`${raw}T00:00:00+09:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; targetType?: string; from?: string; to?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  await requireAdmin();

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const action = (sp.action ?? '').trim();
  const targetType = (sp.targetType ?? '').trim();
  const from = parseDate(sp.from);
  const toRaw = parseDate(sp.to);
  const to = toRaw ? new Date(toRaw.getTime() + 86_400_000) : undefined;

  const where: Prisma.AdminAuditLogWhereInput = {
    ...(action ? { action: { contains: action, mode: 'insensitive' as const } } : {}),
    ...(targetType ? { targetType } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };

  const [total, logs, actions, targetTypes, todayCount, actionKinds, targetKinds] = await Promise.all([
    prisma.adminAuditLog.count({ where }),
    prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, action: true, targetType: true, targetId: true,
        beforeValue: true, afterValue: true, ip: true, userAgent: true, createdAt: true,
        actorLabel: true, actorRole: true,
        admin: { select: { permission: true, user: { select: { email: true, name: true } } } },
      },
    }),
    prisma.adminAuditLog.findMany({ distinct: ['action'], orderBy: { action: 'asc' }, take: 100, select: { action: true } }),
    prisma.adminAuditLog.findMany({ distinct: ['targetType'], orderBy: { targetType: 'asc' }, take: 50, select: { targetType: true } }),
    prisma.adminAuditLog.count({ where: { createdAt: { gte: kstStartOfDay() } } }),
    // 드롭다운 목록은 상한이 있어도, 종류 "수" 는 잘리지 않은 값을 보여 준다.
    prisma.adminAuditLog.groupBy({ by: ['action'], _count: { _all: true } }),
    prisma.adminAuditLog.groupBy({ by: ['targetType'], _count: { _all: true } }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/audit', params: { action, targetType, from: sp.from ?? '', to: sp.to ?? '' }, page, lastPage, total });

  return (
    <>
      <PageHeader
        title="감사로그"
        description="관리자가 수행한 모든 변경의 전/후 값과 접속 정보를 기록합니다. 로그는 수정하거나 삭제할 수 없습니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="전체 기록" value={formatNumber(total)} sub="현재 조건 기준" />
        <StatTile label="오늘 기록" value={formatNumber(todayCount)} tone="brand" />
        <StatTile label="액션 종류" value={formatNumber(actionKinds.length)} />
        <StatTile label="대상 유형" value={formatNumber(targetKinds.length)} />
      </div>

      <FilterBar action="/admin/audit" resetHref="/admin/audit">
        <AdminField label="액션" className="w-56">
          <AdminInput name="action" defaultValue={action} placeholder="예: REFUND_APPROVE" list="audit-actions" />
        </AdminField>
        <datalist id="audit-actions">
          {actions.map((a) => (
            <option key={a.action} value={a.action} />
          ))}
        </datalist>
        <AdminField label="대상 유형" className="w-48">
          <AdminSelect name="targetType" defaultValue={targetType}>
            <option value="">전체</option>
            {targetTypes.map((t) => (
              <option key={t.targetType} value={t.targetType}>
                {t.targetType}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
        <AdminField label="시작일 (KST)" className="w-40">
          <AdminInput type="date" name="from" defaultValue={sp.from ?? ''} />
        </AdminField>
        <AdminField label="종료일 (KST)" className="w-40">
          <AdminInput type="date" name="to" defaultValue={sp.to ?? ''} />
        </AdminField>
      </FilterBar>

      <Notice tone="neutral" title="기록 범위">
        회원 상태 변경, 후원자 잠금·제한, 사회복지기관 심사와 결제 모드, 코드 재발급, MO 번호 배정·회수, 환불 승인·거절,
        정산 처리, 정책·약관·배너·금칙어 변경, 관리자 권한 변경이 모두 기록됩니다.
      </Notice>

      <div className="mt-4">
        {logs.length === 0 ? (
          <EmptyState title="조건에 맞는 감사로그가 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1200px]">
              <thead>
                <tr>
                  <Th>시각</Th>
                  <Th>관리자</Th>
                  <Th>액션</Th>
                  <Th>대상</Th>
                  <Th>변경 전</Th>
                  <Th>변경 후</Th>
                  <Th>접속 정보</Th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <Td className="whitespace-nowrap">{formatKst(l.createdAt)}</Td>
                    <Td>
                      {l.admin?.user.email ?? l.actorLabel ?? '시스템'}
                      {l.admin ? (
                        <span className="mt-0.5 block text-[11px] text-ink-400">{l.admin.permission}</span>
                      ) : l.actorRole && l.actorRole !== 'SYSTEM' ? (
                        <span className="mt-0.5 block text-[11px] text-ink-400">{l.actorRole === 'MERCHANT' ? '기관 담당자' : l.actorRole === 'PAYER' ? '후원자' : l.actorRole}</span>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone="neutral">{l.action}</Badge>
                    </Td>
                    <Td>
                      {l.targetType}
                      <span className="mt-0.5 block font-mono text-[11px] break-all text-ink-400">{l.targetId ?? '-'}</span>
                    </Td>
                    <Td>
                      <JsonView value={l.beforeValue} maxLength={400} />
                    </Td>
                    <Td>
                      <JsonView value={l.afterValue} maxLength={400} />
                    </Td>
                    <Td className="max-w-[180px] text-[11px] break-words text-ink-400">
                      {l.ip ?? '-'}
                      {l.userAgent ? <span className="block">{l.userAgent.slice(0, 60)}</span> : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/audit"
              params={{ action, targetType, from: sp.from ?? '', to: sp.to ?? '' }}
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
