import Link from 'next/link';
import { FilePlus2, FileSignature, Files, HeartHandshake, Receipt, ShieldCheck, Users, UserRoundCheck, Wallet } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, LinkButton, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { edocEnvelopeStatusLabel, edocRoleLabel, edocStats } from '@/server/services/edoc';
import { walletOverview } from '@/server/services/edoc-billing';
import { WELFARE_PRESETS } from '@/server/services/documents';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import type { EDocEnvelopeStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{ key: string; label: string; statuses?: EDocEnvelopeStatus[] }> = [
  { key: '', label: '전체' },
  { key: 'open', label: '서명 대기', statuses: ['SENT', 'IN_PROGRESS'] },
  { key: 'done', label: '완료', statuses: ['COMPLETED'] },
  { key: 'stopped', label: '거절·만료·취소', statuses: ['DECLINED', 'EXPIRED', 'CANCELLED'] },
];

const CATEGORY_ICON = { 후원: HeartHandshake, 자원봉사: Users, 이용자: UserRoundCheck, 동의서: ShieldCheck } as const;

/**
 * 기관 전자문서 센터.
 * 후원약정서·자원봉사 확인서·보호자 동의서 같은 기관 서류를 문자로 보내 서명받고, 완료본과 감사추적을 보관한다.
 * 기부금영수증은 전자서명 문서가 아니라 영수증 대장(/studio/receipts)에서 발급한다.
 */
export default async function EDocumentCenter({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const filter = FILTERS.find((x) => x.key === (sp.f ?? '')) ?? FILTERS[0]!;
  const [overview, stats, templates, envelopes] = await Promise.all([
    walletOverview(merchantId),
    edocStats(merchantId),
    prisma.documentTemplate.findMany({ where: { merchantId, active: true, archivedAt: null }, select: { presetKey: true } }),
    prisma.eDocEnvelope.findMany({
      where: { merchantId, ...(filter.statuses ? { status: { in: filter.statuses } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { signers: { orderBy: { order: 'asc' }, select: { id: true, role: true, nameMasked: true, status: true } } },
    }),
  ]);
  const owned = new Set(templates.map((t) => t.presetKey).filter(Boolean));
  const presets = WELFARE_PRESETS();

  return (
    <>
      <PageHeader
        title="전자문서 센터"
        description="기관 서류를 문자로 보내고, 받는 분이 휴대폰에서 본인확인 후 서명합니다. 완료본과 감사추적을 함께 보관합니다."
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/studio/e-documents/bulk" variant="secondary">여러 명에게 보내기</LinkButton>
            <LinkButton href="/studio/e-documents/new">서명 요청 보내기</LinkButton>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="지금 보낼 수 있는 건수" value={`${formatNumber(overview.sendable)}건`} sub={overview.subscription ? `정액 ${overview.monthlyLeft}건 · 시범 ${overview.wallet.trialRemaining}건 · 충전 ${overview.prepaidDocs}건` : `시범 ${overview.wallet.trialRemaining}건 · 충전 ${overview.prepaidDocs}건`} tone="brand" />
        <StatTile label="서명 대기" value={`${formatNumber(stats.open)}건`} />
        <StatTile label="이번 달 발송" value={`${formatNumber(stats.thisMonth)}건`} />
        <StatTile label="서명 완료" value={`${formatNumber(stats.completed)}건`} sub={stats.declined ? `거절 ${stats.declined}건` : undefined} />
      </div>

      {overview.lowBalance ? (
        <div className="mb-4">
          <Notice tone="warning" title="이용 잔액이 얼마 남지 않았습니다">
            충전 잔액 {overview.wallet.balance.toLocaleString('ko-KR')}원 · 1건 {overview.plan.perDocument.toLocaleString('ko-KR')}원.{' '}
            <Link href="/studio/document-billing" className="font-bold underline">충전·정액 이용 신청</Link>
          </Notice>
        </div>
      ) : null}

      <section className="mb-6">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-[15px] font-black text-ink-900">자주 쓰는 기관 서류</h2>
          <Link href="/studio/documents" className="text-[12.5px] font-bold text-ink-500 hover:underline">서식 관리</Link>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {presets.map((p) => {
            const Icon = CATEGORY_ICON[p.category ?? '동의서'];
            return (
              <Link key={p.key} href={owned.has(p.key) ? '/studio/e-documents/new' : `/studio/documents/new?type=preset&preset=${p.key}`}>
                <Card className="h-full transition hover:-translate-y-0.5 hover:border-brand-300">
                  <div className="flex items-center gap-2">
                    <Icon size={18} strokeWidth={1.7} className="text-brand-700" />
                    <span className="text-[11px] font-bold text-ink-400">{p.category}</span>
                    {owned.has(p.key) ? <Badge tone="success" className="ml-auto">등록됨</Badge> : null}
                  </div>
                  <p className="mt-2 text-[14px] font-bold text-ink-900">{p.name}</p>
                  <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-500">{p.description}</p>
                  <p className="mt-2 text-[11px] text-ink-400">서명: {(p.signers ?? []).map((s) => s.label).join(' · ')}</p>
                </Card>
              </Link>
            );
          })}
          <Link href="/studio/receipts">
            <Card className="h-full border-dashed transition hover:border-brand-300">
              <div className="flex items-center gap-2"><Receipt size={18} strokeWidth={1.7} className="text-brand-700" /><span className="text-[11px] font-bold text-ink-400">영수증</span></div>
              <p className="mt-2 text-[14px] font-bold text-ink-900">기부금영수증</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-500">서명 문서가 아니라 영수증 대장에서 결제 성공 건으로 발급합니다.</p>
            </Card>
          </Link>
        </div>
      </section>

      <section>
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-[15px] font-black text-ink-900">보낸 서명 요청</h2>
          {FILTERS.map((x) => (
            <Link key={x.key} href={x.key ? `/studio/e-documents?f=${x.key}` : '/studio/e-documents'} className={`rounded-full border px-3 py-1 text-[12.5px] font-bold ${filter.key === x.key ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-ink-200 bg-white text-ink-600'}`}>
              {x.label}
            </Link>
          ))}
        </div>
        {envelopes.length === 0 ? (
          <EmptyState
            title="아직 보낸 서명 요청이 없습니다"
            description="서식을 고르고 받는 분의 이름과 휴대폰 번호를 넣으면 서명 링크가 문자로 갑니다."
            action={<LinkButton href="/studio/e-documents/new"><FilePlus2 size={16} strokeWidth={1.7} /> 서명 요청 보내기</LinkButton>}
          />
        ) : (
          <Table className="min-w-[860px]">
            <thead>
              <tr>
                <Th>문서</Th>
                <Th>서명자</Th>
                <Th>상태</Th>
                <Th>보낸 날 · 기한</Th>
              </tr>
            </thead>
            <tbody>
              {envelopes.map((e) => (
                <tr key={e.id}>
                  <Td>
                    <Link href={`/studio/e-documents/${e.id}`} className="flex items-center gap-2 font-bold text-ink-900 hover:underline">
                      <FileSignature size={16} strokeWidth={1.7} className="shrink-0 text-ink-400" />
                      {e.title}
                    </Link>
                    {e.batchId ? <span className="ml-6 text-[11px] text-ink-400">대량 발송</span> : null}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {e.signers.map((s) => (
                        <span key={s.id} className={`rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold ${s.status === 'SIGNED' ? 'bg-success-50 text-[#0b7d59]' : s.status === 'DECLINED' ? 'bg-danger-50 text-danger-500' : 'bg-ink-100 text-ink-600'}`}>
                          {edocRoleLabel[s.role]} {s.nameMasked}
                        </span>
                      ))}
                    </div>
                  </Td>
                  <Td><Badge tone={edocEnvelopeStatusLabel[e.status].tone}>{edocEnvelopeStatusLabel[e.status].text}</Badge></Td>
                  <Td className="whitespace-nowrap text-[12px] text-ink-500">
                    {formatKst(e.createdAt, false)}
                    <span className="block text-ink-400">{e.completedAt ? `완료 ${formatKst(e.completedAt, false)}` : `기한 ${formatKst(e.expiresAt, false).slice(0, 10)}`}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <p className="mt-5 flex gap-2 text-[12px] leading-relaxed text-ink-500">
        <Files size={16} strokeWidth={1.7} className="mt-0.5 shrink-0" />
        이전에 만든 작성 링크(문서 상품·작성 요청)는 <Link href="/studio/documents" className="mx-1 font-bold underline">서식·제출 문서</Link>에서 계속 볼 수 있습니다.
      </p>
      <p className="mt-1.5 flex gap-2 text-[12px] leading-relaxed text-ink-500">
        <Wallet size={16} strokeWidth={1.7} className="mt-0.5 shrink-0" />
        이용료는 서명 요청 1건을 보낼 때 1번 차감합니다. 재안내·열람·서명에는 추가 차감이 없고, 아무도 열기 전에 취소하면 되돌립니다. 이용 잔액은 후원금과 별개입니다.
      </p>
    </>
  );
}
