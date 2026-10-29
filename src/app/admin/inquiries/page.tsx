import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { PAGE_SIZE, parsePage, clampPage } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import type { Prisma } from '@/generated/prisma/client';
import type { InquiryStatus } from '@/generated/prisma/enums';
import { SUPPORT_CATEGORIES } from '@/components/public/support-options';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<InquiryStatus, { text: string; tone: 'warning' | 'success' | 'neutral' }> = {
  OPEN: { text: '답변 대기', tone: 'warning' },
  ANSWERED: { text: '답변 완료', tone: 'success' },
  CLOSED: { text: '종결', tone: 'neutral' },
};

function categoryLabel(value: string): string {
  return SUPPORT_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

export default async function AdminInquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; q?: string; category?: string; source?: string }>;
}) {
  // 문의 목록에는 문의자 이름·연락처가 보인다. 메뉴와 같은 기준(최고관리자)으로만 연다.
  const admin = await requireAdmin();
  if (admin.adminPermission !== 'SUPER_ADMIN') {
    return (
      <>
        <PageHeader title="1:1 문의" description="최고관리자 권한에서만 열람할 수 있습니다." />
        <Notice tone="danger" title="권한이 없습니다">문의 내용은 최고관리자만 확인할 수 있습니다.</Notice>
      </>
    );
  }

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const status = (['OPEN', 'ANSWERED', 'CLOSED'] as const).includes(sp.status as InquiryStatus)
    ? (sp.status as InquiryStatus)
    : undefined;

  const q = (sp.q ?? '').trim().slice(0, 80);
  const category = (sp.category ?? '').trim() || undefined;
  const source = sp.source === 'WIDGET' || sp.source === 'FORM' ? sp.source : undefined;

  // 이름·이메일로 찾으려면 먼저 해당 사용자 id 를 구해야 한다 (SupportInquiry.userId 는 FK 가 아니다).
  const matchedUserIds = q
    ? (
        await prisma.user.findMany({
          where: {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
          take: 200,
        })
      ).map((u) => u.id)
    : [];

  const where: Prisma.SupportInquiryWhereInput = {
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
    ...(source ? { source } : {}),
    ...(q
      ? {
          OR: [
            { id: q },
            { guestName: { contains: q, mode: 'insensitive' } },
            { contactMasked: { contains: q, mode: 'insensitive' } },
            { transactionNo: { contains: q, mode: 'insensitive' } },
            { messages: { some: { body: { contains: q, mode: 'insensitive' } } } },
            ...(matchedUserIds.length > 0 ? [{ userId: { in: matchedUserIds } }] : []),
          ],
        }
      : {}),
  };

  const [total, inquiries, byStatus, unreadCount] = await Promise.all([
    prisma.supportInquiry.count({ where }),
    prisma.supportInquiry.findMany({
      where,
      orderBy: [{ status: 'asc' }, { lastMessageAt: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, userId: true, guestName: true, contactMasked: true, status: true,
        category: true, source: true, transactionNo: true,
        createdAt: true, lastMessageAt: true,
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { sender: true, body: true } },
        _count: { select: { messages: true } },
      },
    }),
    // 목록과 같은 필터를 적용한다(타일만 전체 수치를 보여 주면 필터한 결과로 오인한다).
    prisma.supportInquiry.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.supportMessage.count({ where: { sender: 'USER', readByAdminAt: null } }),
  ]);

  const userIds = inquiries.map((i) => i.userId).filter((v): v is string => Boolean(v));
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true, role: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/inquiries', params: { status: status ?? '', q, category: category ?? '', source: source ?? '' }, page, lastPage, total });
  const count = (s: InquiryStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="문의 관리"
        description="사이트 우측 하단 문의 버튼으로 접수된 1:1 채팅 문의입니다. 답변을 등록하면 사용자 문의 창에 바로 표시됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="답변 대기" value={formatNumber(count('OPEN'))} tone={count('OPEN') > 0 ? 'warning' : 'neutral'} />
        <StatTile label="답변 완료" value={formatNumber(count('ANSWERED'))} tone="success" />
        <StatTile label="종결" value={formatNumber(count('CLOSED'))} />
        <StatTile label="읽지 않은 메시지" value={formatNumber(unreadCount)} tone={unreadCount > 0 ? 'brand' : 'neutral'} />
      </div>

      {count('OPEN') > 0 ? (
        <Notice tone="warning" title={`답변을 기다리는 문의가 ${formatNumber(count('OPEN'))}건 있습니다`}>
          답변 대기 문의가 목록 맨 위에 표시됩니다. 문의 제목을 눌러 답변을 등록해 주세요.
        </Notice>
      ) : (
        <Notice tone="success">답변을 기다리는 문의가 없습니다.</Notice>
      )}

      <div className="mt-5">
        <SectionTitle title="문의 목록" />
        <FilterBar action="/admin/inquiries" resetHref="/admin/inquiries">
          <AdminField label="검색" className="w-72">
            <AdminInput
              name="q"
              defaultValue={q}
              placeholder="이름 · 이메일 · 연락처 · 거래번호 · 본문 · 접수번호"
            />
          </AdminField>
          <AdminField label="상태" className="w-36">
            <AdminSelect name="status" defaultValue={status ?? ''}>
              <option value="">전체</option>
              <option value="OPEN">답변 대기</option>
              <option value="ANSWERED">답변 완료</option>
              <option value="CLOSED">종결</option>
            </AdminSelect>
          </AdminField>
          <AdminField label="문의 유형" className="w-48">
            <AdminSelect name="category" defaultValue={category ?? ''}>
              <option value="">전체</option>
              <option value="일반">일반(채팅)</option>
              {SUPPORT_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </AdminSelect>
          </AdminField>
          <AdminField label="접수 경로" className="w-36">
            <AdminSelect name="source" defaultValue={source ?? ''}>
              <option value="">전체</option>
              <option value="WIDGET">문의 창</option>
              <option value="FORM">고객센터 폼</option>
            </AdminSelect>
          </AdminField>
        </FilterBar>
      </div>

      {inquiries.length === 0 ? (
        <EmptyState title="문의가 없습니다" description="사용자가 문의를 보내면 이곳에 표시됩니다." />
      ) : (
        <>
          <Table className="min-w-[980px]">
            <thead>
              <tr>
                <Th>문의자</Th>
                <Th>유형</Th>
                <Th>최근 메시지</Th>
                <Th className="text-right">메시지 수</Th>
                <Th>상태</Th>
                <Th>최근 활동</Th>
                <Th>접수일</Th>
              </tr>
            </thead>
            <tbody>
              {inquiries.map((q) => {
                const u = q.userId ? userMap.get(q.userId) : null;
                const label = STATUS_LABEL[q.status];
                const last = q.messages[0];
                return (
                  <tr key={q.id}>
                    <Td>
                      <Link href={`/admin/inquiries/${q.id}`} className="font-semibold text-brand-700">
                        {u ? (u.name ?? u.email ?? '회원') : (q.guestName || '비회원')}
                      </Link>
                      <span className="mt-0.5 block text-[11px] text-ink-400">
                        {u ? `${u.email ?? '-'} · ${u.role}` : `게스트${q.contactMasked ? ` · ${q.contactMasked}` : ''}`}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap text-[12px]">
                      <span className="block text-ink-700">{categoryLabel(q.category)}</span>
                      <span className="block text-[11px] text-ink-400">
                        {q.source === 'FORM' ? '고객센터 폼' : '문의 창'}
                        {q.transactionNo ? ` · ${q.transactionNo}` : ''}
                      </span>
                    </Td>
                    <Td>
                      <span className="block max-w-[360px] truncate text-[12.5px] text-ink-700">
                        {last ? `${last.sender === 'ADMIN' ? '[답변] ' : ''}${last.body}` : '-'}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums">{formatNumber(q._count.messages)}</Td>
                    <Td>
                      <Badge tone={label.tone}>{label.text}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(q.lastMessageAt, false)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(q.createdAt, false)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pager
            basePath="/admin/inquiries"
            params={{ status: status ?? '', q, category: category ?? '', source: source ?? '' }}
            page={page}
            lastPage={lastPage}
            total={total}
          />
        </>
      )}
    </>
  );
}
