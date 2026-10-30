import Link from 'next/link';
import { requireAdmin } from '@/server/auth';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionButton } from '@/components/admin/action-form';
import { setAlimtalkStatusAction } from '@/app/actions/admin/automation';
import { alimtalkIsMock } from '@/server/adapters/alimtalk';
import { snsIsMock, PLATFORM_LABEL } from '@/server/adapters/sns';
import { getContentAdapter } from '@/server/adapters/content';
import { getESignAdapter } from '@/server/adapters/esign';
import { ALIMTALK_STATUS_LABEL } from '@/server/services/alimtalk';
import { formatKst, kstMonthKey } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { monthRange } from '@/server/services/monthly-notice';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'alimtalk', label: '알림톡 채널' },
  { key: 'content', label: '콘텐츠·게시' },
  { key: 'notices', label: '월간 안내' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/**
 * 자동화 운영 (통합 관리자).
 * 외부 연동 상태, 기관별 알림톡 채널 승인 확인, 콘텐츠 생성 비용·게시 실패, 월간 안내 실행을 본다.
 */
export default async function AdminAutomationPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : 'alimtalk';
  const { start, end } = monthRange(kstMonthKey());
  const [channels, contentAgg, publishFailed, notices, volunteerApps, agreements] = await Promise.all([
    prisma.merchantAlimtalkChannel.findMany({ include: { merchant: { select: { displayName: true, code: true } } }, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }] }),
    prisma.contentItem.groupBy({ by: ['merchantId'], where: { createdAt: { gte: start, lt: end } }, _count: { _all: true }, _sum: { costKrw: true } }),
    prisma.contentPublish.findMany({ where: { status: 'FAILED' }, include: { item: { select: { title: true, merchant: { select: { displayName: true } } } } }, orderBy: { updatedAt: 'desc' }, take: 50 }),
    prisma.noticeRun.findMany({ include: { merchant: { select: { displayName: true } } }, orderBy: { startedAt: 'desc' }, take: 50 }),
    prisma.volunteerApplication.count({ where: { createdAt: { gte: start } } }),
    prisma.agreementDocument.count({ where: { createdAt: { gte: start } } }),
  ]);
  const merchants = new Map((await prisma.merchantProfile.findMany({ where: { id: { in: contentAgg.map((c) => c.merchantId) } }, select: { id: true, displayName: true } })).map((m) => [m.id, m.displayName]));
  const providers = [
    { name: '알림톡', enabled: env.automation.alimtalkEnabled, mock: alimtalkIsMock(), provider: env.automation.alimtalkProvider },
    { name: 'SNS 게시', enabled: env.automation.socialPublishEnabled, mock: snsIsMock(), provider: env.automation.socialProvider },
    { name: '전자서명', enabled: env.automation.esignEnabled, mock: getESignAdapter().info().mode === 'mock', provider: env.automation.esignProvider },
    { name: '콘텐츠 생성', enabled: true, mock: getContentAdapter().info().mode === 'mock', provider: env.automation.contentProvider },
  ];
  return (
    <>
      <PageHeader title="자동화 운영" description="발굴(콘텐츠·SNS)·안내(알림톡·월간 안내)·약정서 연동 상태와 기관별 처리 현황입니다." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {providers.map((p) => (
          <StatTile key={p.name} label={p.name} value={!p.enabled ? '꺼짐' : p.mock ? 'mock' : '실연동'} sub={`공급자 ${p.provider}`} tone={!p.enabled ? 'neutral' : p.mock ? 'warning' : 'success'} />
        ))}
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="알림톡 승인 대기" value={`${channels.filter((c) => c.status === 'PENDING').length}곳`} tone="warning" />
        <StatTile label="이번 달 콘텐츠 생성" value={`${formatNumber(contentAgg.reduce((a, c) => a + c._count._all, 0))}건`} sub={formatWon(BigInt(contentAgg.reduce((a, c) => a + (c._sum.costKrw ?? 0), 0)))} />
        <StatTile label="이번 달 약정서·신청서" value={`${formatNumber(agreements)}건`} sub={`자원봉사 신청 ${volunteerApps}건`} />
        <StatTile label="게시 실패" value={`${publishFailed.length}건`} tone={publishFailed.length ? 'danger' : 'neutral'} />
      </div>
      <div className="mb-4 flex gap-1 rounded-2xl bg-ink-100 p-1 text-[13px] font-bold">
        {TABS.map((t) => (
          <Link key={t.key} href={`/admin/automation?tab=${t.key}`} className={t.key === tab ? 'flex-1 rounded-xl bg-white px-3 py-2 text-center text-ink-900 shadow-sm' : 'flex-1 rounded-xl px-3 py-2 text-center text-ink-500'}>{t.label}</Link>
        ))}
      </div>

      {tab === 'alimtalk' ? (
        channels.length === 0 ? <EmptyState title="알림톡 채널을 등록한 기관이 없습니다" /> : (
          <>
            <Notice tone="neutral">카카오 비즈니스 관리자센터에서 기관 발신프로필과 템플릿 승인 상태를 확인한 뒤 &apos;사용 중&apos; 으로 바꿔 주세요. 확인 전에는 같은 안내가 문자로 나갑니다.</Notice>
            <div className="mt-3"><Table>
              <thead><tr><Th>기관</Th><Th>채널</Th><Th>발신프로필</Th><Th>템플릿</Th><Th>상태</Th><Th>확인</Th><Th></Th></tr></thead>
              <tbody>
                {channels.map((c) => {
                  const codes = Object.entries((c.templateCodes ?? {}) as Record<string, string>).filter(([, v]) => v);
                  return (
                    <tr key={c.merchantId}>
                      <Td className="font-semibold">{c.merchant.displayName} <span className="font-mono text-[12px] text-ink-400">{c.merchant.code}</span></Td>
                      <Td>{c.channelId}</Td>
                      <Td className="font-mono text-[12px]">{c.senderKeyMasked ?? '-'}</Td>
                      <Td className="text-[12px]">{codes.length}개 <span className="text-ink-400">{codes.slice(0, 3).map(([, v]) => v).join(', ')}{codes.length > 3 ? ' …' : ''}</span></Td>
                      <Td><Badge tone={c.status === 'ACTIVE' ? 'success' : c.status === 'PENDING' ? 'warning' : 'neutral'}>{ALIMTALK_STATUS_LABEL[c.status]}</Badge></Td>
                      <Td className="whitespace-nowrap text-[12px]">{c.verifiedAt ? formatKst(c.verifiedAt, false) : '-'}</Td>
                      <Td className="whitespace-nowrap">
                        {c.status !== 'ACTIVE' ? <ActionButton action={setAlimtalkStatusAction} values={{ merchantId: c.merchantId, status: 'ACTIVE' }} label="사용 중으로" variant="primary" confirm="카카오 승인 내용을 확인했습니까?" /> : null}
                        {c.status !== 'SUSPENDED' ? <ActionButton action={setAlimtalkStatusAction} values={{ merchantId: c.merchantId, status: 'SUSPENDED' }} label="중지" /> : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table></div>
          </>
        )
      ) : null}

      {tab === 'content' ? (
        <div className="space-y-4">
          <Table>
            <thead><tr><Th>기관</Th><Th>이번 달 생성</Th><Th>비용</Th></tr></thead>
            <tbody>
              {contentAgg.map((c) => <tr key={c.merchantId}><Td>{merchants.get(c.merchantId) ?? c.merchantId}</Td><Td className="tabular-nums">{c._count._all}건</Td><Td className="tabular-nums">{formatWon(BigInt(c._sum.costKrw ?? 0))}</Td></tr>)}
              {contentAgg.length === 0 ? <tr><Td className="text-ink-400">이번 달 생성 기록이 없습니다.</Td><Td /><Td /></tr> : null}
            </tbody>
          </Table>
          <h2 className="text-[15px] font-black">게시 실패</h2>
          <Table>
            <thead><tr><Th>기관</Th><Th>콘텐츠</Th><Th>플랫폼</Th><Th>시도</Th><Th>사유</Th></tr></thead>
            <tbody>
              {publishFailed.map((p) => <tr key={p.id}><Td>{p.item.merchant.displayName}</Td><Td>{p.item.title}</Td><Td>{PLATFORM_LABEL[p.platform]}</Td><Td className="tabular-nums">{p.attempts}</Td><Td className="text-[12px] text-danger-500">{p.error}</Td></tr>)}
              {publishFailed.length === 0 ? <tr><Td className="text-ink-400">실패한 게시가 없습니다.</Td><Td /><Td /><Td /><Td /></tr> : null}
            </tbody>
          </Table>
        </div>
      ) : null}

      {tab === 'notices' ? (
        <Table>
          <thead><tr><Th>기관</Th><Th>월</Th><Th>대상</Th><Th>발송</Th><Th>알림톡</Th><Th>문자 대체</Th><Th>실패</Th><Th>영수증</Th><Th>상태</Th></tr></thead>
          <tbody>
            {notices.map((n) => (
              <tr key={n.id}>
                <Td>{n.merchant.displayName}</Td><Td>{n.monthKey}</Td><Td className="tabular-nums">{n.recipientCount}</Td><Td className="tabular-nums">{n.sentCount}</Td>
                <Td className="tabular-nums">{n.alimtalkCount}</Td><Td className="tabular-nums">{n.fallbackCount}</Td><Td className="tabular-nums">{n.failedCount}</Td><Td className="tabular-nums">{n.receiptsIssued}</Td>
                <Td>{n.status === 'DONE' ? <Badge tone="success">완료</Badge> : <Badge tone="warning">진행 중</Badge>}</Td>
              </tr>
            ))}
            {notices.length === 0 ? <tr><Td className="text-ink-400">실행 기록이 없습니다.</Td></tr> : null}
          </tbody>
        </Table>
      ) : null}
    </>
  );
}
