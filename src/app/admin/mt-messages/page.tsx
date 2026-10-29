import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { maskLinkTokens, shortId } from '@/components/admin/mask';
import { PAGE_SIZE, parsePage, clampPage } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { readMockOutbox } from '@/server/adapters/mt';
import { env } from '@/lib/env';
import { maskPhone } from '@/lib/crypto';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { deliveryStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { DeliveryStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const STATUSES: DeliveryStatus[] = ['PENDING', 'SENT', 'FAILED', 'SKIPPED'];

export default async function AdminMtMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; template?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  await requireAdmin();

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const status = STATUSES.includes(sp.status as DeliveryStatus) ? (sp.status as DeliveryStatus) : undefined;
  const template = (sp.template ?? '').trim();

  const where: Prisma.MtOutboundMessageWhereInput = {
    ...(status ? { status } : {}),
    ...(template ? { templateCode: { contains: template, mode: 'insensitive' as const } } : {}),
  };

  const [total, messages, grouped] = await Promise.all([
    prisma.mtOutboundMessage.count({ where }),
    prisma.mtOutboundMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, phoneMasked: true, fromNumber: true, messageType: true, templateCode: true,
        bodyMasked: true, status: true, providerCode: true, providerMessageId: true,
        resultCode: true, resultMessage: true, attempts: true, sentAt: true, createdAt: true,
        charge: { select: { transactionNo: true } },
      },
    }),
    prisma.mtOutboundMessage.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);

  const outbox = env.mt.provider === 'mock' || env.safety.safeMode ? readMockOutbox(30) : [];
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/mt-messages', params: { status: status ?? '', template }, page, lastPage, total });
  const countOf = (s: DeliveryStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="MT 발송 관리"
        description="후원자에게 나가는 안내 문자 이력입니다. 본문은 보안링크 토큰을 제거한 마스킹 버전만 저장·표시합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="발송 성공" value={formatNumber(countOf('SENT'))} tone="success" />
        <StatTile label="대기" value={formatNumber(countOf('PENDING'))} />
        <StatTile label="실패" value={formatNumber(countOf('FAILED'))} tone={countOf('FAILED') > 0 ? 'danger' : 'neutral'} />
        <StatTile label="건너뜀" value={formatNumber(countOf('SKIPPED'))} />
      </div>

      <FilterBar action="/admin/mt-messages" resetHref="/admin/mt-messages">
        <AdminField label="발송 상태" className="w-40">
          <AdminSelect name="status" defaultValue={status ?? ''}>
            <option value="">전체</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {deliveryStatusLabel[s].text}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
        <AdminField label="템플릿 코드" className="w-48">
          <AdminInput name="template" defaultValue={template} placeholder="예: CONFIRM" />
        </AdminField>
      </FilterBar>

      {messages.length === 0 ? (
        <EmptyState title="조건에 맞는 발송 이력이 없습니다" />
      ) : (
        <>
          <Table className="min-w-[1100px]">
            <thead>
              <tr>
                <Th>생성 시각</Th>
                <Th>템플릿</Th>
                <Th>수신자</Th>
                <Th>발신번호</Th>
                <Th>유형</Th>
                <Th>상태</Th>
                <Th className="text-right">시도</Th>
                <Th>결과 코드</Th>
                <Th>본문(마스킹)</Th>
                <Th>연결 거래</Th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id}>
                  <Td className="whitespace-nowrap">
                    {formatKst(m.createdAt, false)}
                    {m.sentAt ? <span className="mt-0.5 block text-[11px] text-ink-400">발송 {formatKst(m.sentAt, false)}</span> : null}
                  </Td>
                  <Td>{m.templateCode ?? '-'}</Td>
                  <Td>{m.phoneMasked}</Td>
                  <Td className="font-mono text-[12px]">{m.fromNumber}</Td>
                  <Td>{m.messageType}</Td>
                  <Td>
                    <Badge tone={deliveryStatusLabel[m.status].tone}>{deliveryStatusLabel[m.status].text}</Badge>
                    {m.providerMessageId ? (
                      <span className="mt-0.5 block text-[11px] text-ink-400">{shortId(m.providerMessageId, 8, 4)}</span>
                    ) : null}
                  </Td>
                  <Td className="text-right tabular-nums">{formatNumber(m.attempts)}</Td>
                  <Td className="max-w-[180px] break-words">
                    {m.resultCode ?? '-'}
                    {m.resultMessage ? <span className="block text-[11px] text-ink-400">{m.resultMessage}</span> : null}
                  </Td>
                  <Td className="max-w-[280px] break-words whitespace-pre-wrap">{maskLinkTokens(m.bodyMasked)}</Td>
                  <Td className="font-mono text-[12px]">{m.charge?.transactionNo ?? '-'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pager
            basePath="/admin/mt-messages"
            params={{ status: status ?? '', template }}
            page={page}
            lastPage={lastPage}
            total={total}
          />
        </>
      )}

      <section className="mt-6">
        <SectionTitle
          title="개발용 모의 발송함"
          description="mock MT 어댑터가 적재한 메모리 발송함입니다. 실제 문자는 발송되지 않습니다."
        />
        <Notice tone="warning" title="이 카드는 개발·검수용입니다">
          현재 MT_PROVIDER={env.mt.provider}
          {env.safety.safeMode ? ', SAFE_MODE 켜짐(실제 발송 차단)' : ''} 상태입니다. 아래 목록은 프로세스 메모리에만
          존재하며 재시작하면 사라집니다. 실제 발송 이력은 위 표(MtOutboundMessage)를 기준으로 확인하세요. 본문의 보안
          링크 토큰은 여기서도 마스킹됩니다.
        </Notice>
        <div className="mt-3">
          <Card>
            <CardTitle>모의 발송 {outbox.length}건</CardTitle>
            {outbox.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-400">적재된 모의 발송 내역이 없습니다.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {outbox.map((o) => (
                  <div key={o.id} className="rounded-xl border border-ink-100 bg-ink-50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[12px] font-semibold text-ink-700">{maskPhone(o.to)}</span>
                      <span className="text-[11px] text-ink-400">
                        {formatKst(o.at, false)} · {shortId(o.id, 10, 4)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-700">
                      {maskLinkTokens(o.text)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </section>
    </>
  );
}
