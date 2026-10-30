import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { displayPayerName } from '@/lib/payer-name';
import { env } from '@/lib/env';
import { getESignAdapter } from '@/server/adapters/esign';

export const dynamic = 'force-dynamic';

const ESIGN: Record<string, string> = { NONE: '동의 기록', REQUESTED: '서명 요청', SIGNED: '서명 완료', DECLINED: '서명 거절', EXPIRED: '만료' };

/** 전자 약정서·신청서 보관함. 약정이 생기거나 바뀔 때마다 자동으로 쌓인다. */
export default async function StudioAgreementsPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const kind = sp.kind === 'VOLUNTEER_APPLICATION' ? 'VOLUNTEER_APPLICATION' : sp.kind === 'RECURRING_PLEDGE' ? 'RECURRING_PLEDGE' : undefined;
  const [docs, counts] = await Promise.all([
    prisma.agreementDocument.findMany({
      where: { merchantId, ...(kind ? { kind } : {}) },
      include: { payer: { select: { displayName: true, phoneMasked: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.agreementDocument.groupBy({ by: ['kind', 'esignStatus'], where: { merchantId }, _count: { _all: true } }),
  ]);
  const sum = (f: (c: (typeof counts)[number]) => boolean) => counts.filter(f).reduce((a, c) => a + c._count._all, 0);
  const esignMock = getESignAdapter().info().mode === 'mock';
  return (
    <>
      <PageHeader title="약정서·신청서" description="정기후원 약정서와 자원봉사 신청서가 작성 시점 내용 그대로 보관됩니다. 약정을 바꾸면 새 판이 생기고 이전 판도 남습니다." />
      {env.automation.esignEnabled ? (
        esignMock ? <Notice tone="warning" title="전자서명 mock">전자서명 공급자(페이싸인·모두싸인 등) 계약 전입니다. 서명 요청은 기록되지만 실제로 발송되지 않습니다.</Notice> : null
      ) : (
        <Notice tone="neutral">전자서명 연동이 꺼져 있어 동의 기록(시각·IP·약관 판·내용 해시)으로 약정서를 만듭니다.</Notice>
      )}
      <div className="my-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="정기후원 약정서" value={`${formatNumber(sum((c) => c.kind === 'RECURRING_PLEDGE'))}건`} tone="brand" />
        <StatTile label="자원봉사 신청서" value={`${formatNumber(sum((c) => c.kind === 'VOLUNTEER_APPLICATION'))}건`} />
        <StatTile label="서명 완료" value={`${formatNumber(sum((c) => c.esignStatus === 'SIGNED'))}건`} tone="success" />
        <StatTile label="서명 대기" value={`${formatNumber(sum((c) => c.esignStatus === 'REQUESTED'))}건`} />
      </div>
      <div className="mb-4 flex gap-2">
        {[[undefined, '전체'], ['RECURRING_PLEDGE', '정기후원 약정서'], ['VOLUNTEER_APPLICATION', '자원봉사 신청서']].map(([k, l]) => (
          <Link key={l} href={k ? `/studio/agreements?kind=${k}` : '/studio/agreements'} className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold ${kind === k ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600'}`}>{l}</Link>
        ))}
      </div>
      {docs.length === 0 ? (
        <EmptyState title="아직 작성된 문서가 없습니다" description="후원자가 정기후원을 약정하거나 자원봉사를 신청하면 자동으로 만들어집니다." />
      ) : (
        <Table>
          <thead><tr><Th>문서 번호</Th><Th>종류</Th><Th>작성자</Th><Th>판</Th><Th>서명</Th><Th>작성 시각</Th><Th></Th></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <Td className="font-mono text-[12px]">{d.docNo}</Td>
                <Td>{d.title}</Td>
                <Td>{displayPayerName(d.payer.displayName ?? '')} <span className="font-mono text-[12px] text-ink-400">{d.payer.phoneMasked}</span></Td>
                <Td className="tabular-nums">제{d.version}판</Td>
                <Td><Badge tone={d.esignStatus === 'SIGNED' ? 'success' : d.esignStatus === 'REQUESTED' ? 'warning' : 'neutral'}>{ESIGN[d.esignStatus]}</Badge></Td>
                <Td className="whitespace-nowrap tabular-nums">{formatKst(d.createdAt, false)}</Td>
                <Td><Link href={`/studio/agreements/${d.id}`} className="text-[12.5px] font-bold text-brand-700">열람</Link></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
