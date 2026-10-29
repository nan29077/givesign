import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, MerchantOptions, FilterBar, Pager } from '@/components/admin/controls';
import { shortId } from '@/components/admin/mask';
import { PAGE_SIZE, parsePage, clampPage } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { moResultLabel, chargeStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { MoProcessResult } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const RESULTS: MoProcessResult[] = [
  'PENDING', 'ROUTED', 'UNKNOWN_ROUTE', 'DUPLICATE', 'UNREGISTERED_DONOR', 'BLOCKED', 'ERROR',
];

function parseDate(raw?: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(`${raw}T00:00:00+09:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function AdminMoMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{
    result?: string; merchantId?: string; from?: string; to?: string; number?: string; page?: string;
  }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  await requireAdmin();

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const result = RESULTS.includes(sp.result as MoProcessResult) ? (sp.result as MoProcessResult) : undefined;
  const merchantId = (sp.merchantId ?? '').trim() || undefined;
  const receivedNumber = (sp.number ?? '').trim();
  const fromRaw = parseDate(sp.from);
  const toRawDate = parseDate(sp.to);
  // 시작일이 종료일보다 뒤면 어떤 조건으로도 0건이다. 조회하지 말고 안내한다.
  const invalidRange = Boolean(fromRaw && toRawDate && fromRaw > toRawDate);
  const from = invalidRange ? undefined : fromRaw;
  const toRaw = invalidRange ? undefined : toRawDate;
  const to = toRaw ? new Date(toRaw.getTime() + 86_400_000) : undefined;

  const where: Prisma.MoInboundMessageWhereInput = {
    ...(result ? { result } : {}),
    ...(merchantId ? { merchantId } : {}),
    ...(receivedNumber ? { receivedNumber: { contains: receivedNumber } } : {}),
    ...(from || to ? { receivedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };

  const [total, messages, grouped, merchants] = await Promise.all([
    prisma.moInboundMessage.count({ where }),
    prisma.moInboundMessage.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, providerMessageId: true, providerCode: true, receivedNumber: true, phoneMasked: true,
        messageType: true, contentFiltered: true, matchedKeyword: true, result: true, resultDetail: true,
        receivedAt: true, processedAt: true,
        merchant: { select: { id: true, displayName: true, code: true } },
        charge: { select: { id: true, transactionNo: true, status: true } },
      },
    }),
    prisma.moInboundMessage.groupBy({ by: ['result'], _count: { _all: true } }),
    prisma.merchantProfile.findMany({ orderBy: { displayName: 'asc' }, select: { id: true, displayName: true, code: true } }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/mo-messages', params: {
      result: result ?? '',
      merchantId: merchantId ?? '',
      number: receivedNumber,
      from: sp.from ?? '',
      to: sp.to ?? '',
    }, page, lastPage, total });
  const countOf = (r: MoProcessResult) => grouped.find((g) => g.result === r)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="수신 문자 관리"
        description="MO 사업자로부터 수신한 원문은 암호화 보관되며 관리자 화면에서도 복호화하지 않습니다. 필터링된 노출용 문구만 표시합니다."
      />

      {invalidRange ? (
        <Notice tone="warning" title="기간을 다시 확인해 주세요">
          시작일이 종료일보다 뒤입니다. 기간 조건을 무시하고 전체 기간으로 조회했습니다.
        </Notice>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="정상 라우팅" value={formatNumber(countOf('ROUTED'))} tone="success" />
        <StatTile label="대상 없음" value={formatNumber(countOf('UNKNOWN_ROUTE'))} tone={countOf('UNKNOWN_ROUTE') > 0 ? 'warning' : 'neutral'} />
        <StatTile label="미등록 후원자" value={formatNumber(countOf('UNREGISTERED_DONOR'))} tone={countOf('UNREGISTERED_DONOR') > 0 ? 'warning' : 'neutral'} />
        <StatTile label="처리 오류" value={formatNumber(countOf('ERROR'))} tone={countOf('ERROR') > 0 ? 'danger' : 'neutral'} />
      </div>

      <FilterBar action="/admin/mo-messages" resetHref="/admin/mo-messages">
        <AdminField label="처리 결과" className="w-40">
          <AdminSelect name="result" defaultValue={result ?? ''}>
            <option value="">전체</option>
            {RESULTS.map((r) => (
              <option key={r} value={r}>
                {moResultLabel[r].text}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
        <AdminField label="사회복지기관" className="w-52">
          <AdminSelect name="merchantId" defaultValue={merchantId ?? ''}>
            <MerchantOptions merchants={merchants} />
          </AdminSelect>
        </AdminField>
        <AdminField label="수신번호" className="w-40">
          <AdminInput name="number" defaultValue={receivedNumber} placeholder="15880000" />
        </AdminField>
        <AdminField label="시작일 (KST)" className="w-40">
          <AdminInput type="date" name="from" defaultValue={sp.from ?? ''} />
        </AdminField>
        <AdminField label="종료일 (KST)" className="w-40">
          <AdminInput type="date" name="to" defaultValue={sp.to ?? ''} />
        </AdminField>
      </FilterBar>

      <Notice tone="neutral" title="원문 비노출 원칙">
        수신 문자 원문(content_enc)은 분쟁 대응 목적의 암호문으로만 보관합니다. 관리자 화면에는 금칙어 필터링을 거친
        결제 요청 문구만 표시되며, 발신 번호는 마스킹된 값만 제공합니다.
      </Notice>

      <div className="mt-4">
        {messages.length === 0 ? (
          <EmptyState title="조건에 맞는 수신 문자가 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1200px]">
              <thead>
                <tr>
                  <Th>수신 시각</Th>
                  <Th>사업자 메시지 ID</Th>
                  <Th>수신번호</Th>
                  <Th>발신(마스킹)</Th>
                  <Th>유형</Th>
                  <Th>결과</Th>
                  <Th>매칭 키워드</Th>
                  <Th>사회복지기관</Th>
                  <Th>필터링된 내용</Th>
                  <Th>연결 거래</Th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id}>
                    <Td className="whitespace-nowrap">
                      {formatKst(m.receivedAt, false)}
                      {m.processedAt ? (
                        <span className="mt-0.5 block text-[11px] text-ink-400">처리 {formatKst(m.processedAt, false)}</span>
                      ) : null}
                    </Td>
                    <Td className="font-mono text-[12px]">
                      {shortId(m.providerMessageId, 10, 6)}
                      <span className="mt-0.5 block text-[11px] text-ink-400">{m.providerCode}</span>
                    </Td>
                    <Td className="font-mono text-[12px]">{m.receivedNumber}</Td>
                    <Td>{m.phoneMasked}</Td>
                    <Td>{m.messageType}</Td>
                    <Td>
                      <Badge tone={moResultLabel[m.result].tone}>{moResultLabel[m.result].text}</Badge>
                      {m.resultDetail ? (
                        <span className="mt-0.5 block max-w-[160px] text-[11px] break-words text-ink-400">{m.resultDetail}</span>
                      ) : null}
                    </Td>
                    <Td>{m.matchedKeyword ?? '-'}</Td>
                    <Td>
                      {m.merchant ? (
                        <Link href={`/admin/merchants/${m.merchant.id}`} className="font-semibold text-brand-700">
                          {m.merchant.displayName}
                        </Link>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </Td>
                    <Td className="max-w-[240px] break-words">{m.contentFiltered ?? <span className="text-ink-300">표시 가능한 내용 없음</span>}</Td>
                    <Td>
                      {m.charge ? (
                        <>
                          <span className="block font-mono text-[12px]">{m.charge.transactionNo}</span>
                          <Badge tone={chargeStatusLabel[m.charge.status].tone}>
                            {chargeStatusLabel[m.charge.status].text}
                          </Badge>
                        </>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/mo-messages"
              params={{
                result: result ?? '', merchantId: merchantId ?? '', number: receivedNumber,
                from: sp.from ?? '', to: sp.to ?? '',
              }}
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
