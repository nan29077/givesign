import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { ActionButton, ActionForm, SelectActionForm } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, clampPage, canManageMoney, canWrite } from '@/components/admin/constants';
import { updateReportStatus, createBannedWord, deleteBannedWord } from '@/app/actions/admin/policy';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import type { Prisma } from '@/generated/prisma/client';
import type { ReportStatus, ContentAction } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const REPORT_STATUSES: ReportStatus[] = ['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED'];

const reportStatusLabel: Record<ReportStatus, { text: string; tone: 'warning' | 'brand' | 'success' | 'neutral' }> = {
  OPEN: { text: '접수', tone: 'warning' },
  REVIEWING: { text: '검토중', tone: 'brand' },
  RESOLVED: { text: '처리완료', tone: 'success' },
  DISMISSED: { text: '기각', tone: 'neutral' },
};

const actionLabel: Record<ContentAction, { text: string; tone: 'danger' | 'warning' | 'neutral' }> = {
  BLOCK: { text: '차단', tone: 'danger' },
  MASK: { text: '마스킹', tone: 'warning' },
  FLAG: { text: '표시', tone: 'neutral' },
};

export default async function AdminModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canManageMoney(me.adminPermission);
  // 신고 처리(updateReportStatus)는 SUPPORT 를 막지 않는다. 신고 응대가 고객지원의 업무다.
  const canHandleReports = canWrite(me.adminPermission);

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const status = REPORT_STATUSES.includes(sp.status as ReportStatus) ? (sp.status as ReportStatus) : undefined;

  const where: Prisma.ReportWhereInput = status ? { status } : {};

  const [total, reports, byStatus, words] = await Promise.all([
    prisma.report.count({ where }),
    prisma.report.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, chargeId: true, merchantId: true, category: true, content: true,
        status: true, handledBy: true, handledAt: true, createdAt: true, reporterUserId: true,
      },
    }),
    prisma.report.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.bannedWord.findMany({
      where: { scope: 'GLOBAL' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, word: true, action: true, active: true, createdAt: true },
    }),
  ]);

  // 접수자 계정 정보는 통합 관리자 화면에서만 조회한다 (본문에는 저장하지 않는다).
  const reporterIds = [...new Set(reports.map((r) => r.reporterUserId).filter((v): v is string => Boolean(v)))];
  const reporters = reporterIds.length
    ? await prisma.user.findMany({
        where: { id: { in: reporterIds } },
        select: { id: true, name: true, email: true, phoneMasked: true },
      })
    : [];
  const reporterById = new Map(reporters.map((u) => [u.id, u]));

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/moderation', params: { status: status ?? '' }, page, lastPage, total });
  const countOf = (s: ReportStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="신고·금칙어 관리"
        description="후원자 신고를 처리하고, 문자 결제 요청에 적용되는 전역 금칙어를 관리합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="접수" value={formatNumber(countOf('OPEN'))} tone={countOf('OPEN') > 0 ? 'warning' : 'neutral'} />
        <StatTile label="검토중" value={formatNumber(countOf('REVIEWING'))} tone="brand" />
        <StatTile label="처리완료" value={formatNumber(countOf('RESOLVED'))} tone="success" />
        <StatTile
          label="전역 금칙어"
          value={formatNumber(words.filter((w) => w.active).length)}
          sub={`등록 ${formatNumber(words.length)}건 중 활성`}
        />
      </div>

      <Notice tone="neutral" title="금칙어 처리 방식">
        마스킹(MASK)은 단어만 가려 표시하고, 표시(FLAG)는 그대로 두되 검토 대상으로 기록합니다.
        <b>차단(BLOCK)은 그 문자의 결제를 실제로 막습니다</b> — 신중히 사용하세요.
        문자 본문은 사회복지기관·최고관리자만 문자 관리에서 보므로 마스킹·표시는 기록만 가립니다.
        사회복지기관이 직접 등록한 개별 금칙어는 각 콘솔에서 관리합니다.
      </Notice>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>전역 금칙어 추가</CardTitle>
          <div className="mt-3">
            <ActionForm disabled={!canEdit} action={createBannedWord} submitLabel="금칙어 등록">
              <AdminField label="단어">
                <AdminInput name="word" required maxLength={40} />
              </AdminField>
              <AdminField label="처리 방식">
                <AdminSelect name="action" defaultValue="MASK">
                  <option value="MASK">마스킹 (MASK)</option>
                  <option value="FLAG">표시 (FLAG)</option>
                  <option value="BLOCK">차단 (BLOCK · 결제를 막습니다)</option>
                </AdminSelect>
              </AdminField>
            </ActionForm>
          </div>

          <div className="mt-4">
            <CardTitle>등록된 금칙어</CardTitle>
            {words.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-400">등록된 전역 금칙어가 없습니다.</p>
            ) : (
              <div className="mt-2 space-y-1.5">
                {words.map((w) => (
                  <div key={w.id} className="flex items-center justify-between gap-2 rounded-lg border border-ink-100 px-2.5 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink-900">{w.word}</span>
                      <Badge tone={actionLabel[w.action].tone}>{actionLabel[w.action].text}</Badge>
                      {!w.active ? <Badge tone="neutral">비활성</Badge> : null}
                    </div>
                    <ActionButton disabled={!canEdit}
                      action={deleteBannedWord}
                      values={{ id: w.id }}
                      label="삭제"
                      variant="ghost"
                      confirm={`금칙어 "${w.word}" 를 삭제합니다.`}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <div className="lg:col-span-2">
          <SectionTitle title="신고 처리" />
          <FilterBar action="/admin/moderation" resetHref="/admin/moderation">
            <AdminField label="처리 상태" className="w-40">
              <AdminSelect name="status" defaultValue={status ?? ''}>
                <option value="">전체</option>
                {REPORT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {reportStatusLabel[s].text}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
          </FilterBar>

          {reports.length === 0 ? (
            <EmptyState title="조건에 맞는 신고가 없습니다" />
          ) : (
            <>
              <Table className="min-w-[900px]">
                <thead>
                  <tr>
                    <Th>접수 시각</Th>
                    <Th>분류</Th>
                    <Th>접수자</Th>
                    <Th>내용</Th>
                    <Th>연결 거래</Th>
                    <Th>상태</Th>
                    <Th>처리</Th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap">
                        {formatKst(r.createdAt, false)}
                        {r.handledAt ? (
                          <span className="mt-0.5 block text-[11px] text-ink-400">처리 {formatKst(r.handledAt, false)}</span>
                        ) : null}
                      </Td>
                      <Td>{r.category}</Td>
                      <Td className="whitespace-nowrap text-[12px]">
                        {(() => {
                          const u = r.reporterUserId ? reporterById.get(r.reporterUserId) : null;
                          if (!u) return <span className="text-ink-400">비회원</span>;
                          return (
                            <>
                              <span className="block text-ink-900">{u.name ?? u.email ?? '회원'}</span>
                              <span className="block text-[11px] text-ink-400">{u.phoneMasked ?? u.email ?? ''}</span>
                            </>
                          );
                        })()}
                      </Td>
                      <Td className="max-w-[280px] break-words">{r.content}</Td>
                      <Td className="font-mono text-[11px] text-ink-400">{r.chargeId ?? '-'}</Td>
                      <Td>
                        <Badge tone={reportStatusLabel[r.status].tone}>{reportStatusLabel[r.status].text}</Badge>
                      </Td>
                      <Td>
                        <SelectActionForm disabled={!canHandleReports}
                          action={updateReportStatus}
                          values={{ reportId: r.id }}
                          name="status"
                          defaultValue={r.status}
                          options={REPORT_STATUSES.map((s) => ({ value: s, label: reportStatusLabel[s].text }))}
                          confirm="신고 처리 상태를 변경합니다. 처리자가 기록됩니다."
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pager
                basePath="/admin/moderation"
                params={{ status: status ?? '' }}
                page={page}
                lastPage={lastPage}
                total={total}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}
