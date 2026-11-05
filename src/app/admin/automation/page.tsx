import Link from 'next/link';
import { requireAdmin } from '@/server/auth';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionButton } from '@/components/admin/action-form';
import { setAlimtalkStatusAction, retryEventAction } from '@/app/actions/admin/automation';
import { CRON_JOBS } from '@/server/cron-registry';
import { eventQueueStats } from '@/server/services/events';
import { alimtalkIsMock, getAlimtalkAdapter } from '@/server/adapters/alimtalk';
import { getMailAdapter } from '@/server/adapters/mail';
import { platformMissingCredentials, SNS_OAUTH_FAMILY, SNS_PLATFORMS, SNS_PLATFORM_LABEL } from '@/server/adapters/sns/platforms';
import { snsIsMock, PLATFORM_LABEL } from '@/server/adapters/sns';
import { getContentAdapter } from '@/server/adapters/content';
import { getESignAdapter } from '@/server/adapters/esign';
import { ALIMTALK_STATUS_LABEL } from '@/server/services/alimtalk';
import { formatKst, kstMonthKey } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { monthRange } from '@/server/services/monthly-notice';
import { stalePublishingBefore } from '@/server/services/content';
import { getLlmAdapter } from '@/server/adapters/llm';
import { AI_FEATURE_LABEL, aiUsageThisMonth, type AiFeature } from '@/server/services/ai-usage';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'alimtalk', label: '알림톡 채널' },
  { key: 'content', label: '콘텐츠·게시' },
  { key: 'notices', label: '월간 안내' },
  { key: 'jobs', label: '배치·이벤트' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/** 마지막 종료가 주기의 3배를 넘었으면 지연. (렌더 밖 함수 — 화면 시각 계산) */
function isLate(lastFinishedAt: Date | null, intervalSec: number) {
  return !lastFinishedAt || Date.now() - lastFinishedAt.getTime() > intervalSec * 3000;
}

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
    // 실패 + 게시 중에 멈춘 건(배치가 다음 실행에 되돌리지만, 그 전까지 관리자에게 보이게)
    prisma.contentPublish.findMany({ where: { OR: [{ status: 'FAILED' }, { status: 'PUBLISHING', updatedAt: { lt: stalePublishingBefore() } }] }, include: { item: { select: { title: true, merchant: { select: { displayName: true } } } } }, orderBy: { updatedAt: 'desc' }, take: 50 }),
    prisma.noticeRun.findMany({ include: { merchant: { select: { displayName: true } } }, orderBy: { startedAt: 'desc' }, take: 50 }),
    prisma.volunteerApplication.count({ where: { createdAt: { gte: start } } }),
    prisma.agreementDocument.count({ where: { createdAt: { gte: start } } }),
  ]);
  const [heartbeats, eventStats, failedEvents] = tab === 'jobs'
    ? await Promise.all([
        prisma.cronHeartbeat.findMany(),
        eventQueueStats(),
        prisma.domainEvent.findMany({ where: { status: 'FAILED' }, orderBy: { occurredAt: 'desc' }, take: 50, select: { id: true, type: true, merchantId: true, occurredAt: true, attempts: true, lastError: true } }),
      ])
    : [[], null, []] as const;
  const beatByName = new Map(heartbeats.map((h) => [h.name, h]));
  const merchants = new Map((await prisma.merchantProfile.findMany({ where: { id: { in: contentAgg.map((c) => c.merchantId) } }, select: { id: true, displayName: true } })).map((m) => [m.id, m.displayName]));
  // 공급자 상태: 꺼짐 / mock / 키 없음 / 실연동 (2026-11-06 7단계 — SNS 플랫폼별·알림톡·메일)
  type ProviderState = 'off' | 'mock' | 'nokey' | 'live';
  const STATE_TEXT: Record<ProviderState, string> = { off: '꺼짐', mock: 'mock', nokey: '키 없음', live: '실연동' };
  const STATE_TONE: Record<ProviderState, 'neutral' | 'warning' | 'danger' | 'success'> = { off: 'neutral', mock: 'warning', nokey: 'danger', live: 'success' };
  const stateOf = (enabled: boolean, mode: 'mock' | 'live', missing: string[]): ProviderState => (!enabled ? 'off' : mode === 'mock' ? 'mock' : missing.length ? 'nokey' : 'live');
  const alimtalkInfo = getAlimtalkAdapter().info();
  const mailInfo = getMailAdapter().info();
  const snsMock = snsIsMock();
  const providers: Array<{ name: string; state: ProviderState; sub: string }> = [
    { name: '알림톡', state: stateOf(env.automation.alimtalkEnabled, alimtalkIsMock() ? 'mock' : 'live', alimtalkInfo.missingCredentials), sub: `공급자 ${env.automation.alimtalkProvider}${alimtalkIsMock() && env.automation.alimtalkProvider !== 'mock' ? ' (SAFE_MODE 로 mock)' : ''}` },
    ...SNS_PLATFORMS.filter((p) => SNS_OAUTH_FAMILY[p]).map((p) => {
      const missing = platformMissingCredentials(p);
      return { name: `SNS · ${SNS_PLATFORM_LABEL[p]}`, state: stateOf(env.automation.socialPublishEnabled, snsMock ? 'mock' : 'live', missing), sub: missing.length && !snsMock ? `없음 ${missing.join(', ')}` : `공급자 ${env.automation.socialProvider}` };
    }),
    { name: 'SNS · 네이버 블로그·카카오 채널', state: 'off', sub: '공개 게시 API 없음 — 내려받아 직접 게시' },
    { name: '메일', state: stateOf(true, mailInfo.mode, mailInfo.missingCredentials), sub: `공급자 ${env.integrations.mail.provider}${mailInfo.missingCredentials.length ? ` · 없음 ${mailInfo.missingCredentials.join(', ')}` : ''}` },
    { name: '전자서명', state: stateOf(env.automation.esignEnabled, getESignAdapter().info().mode, getESignAdapter().info().missingCredentials), sub: `공급자 ${env.automation.esignProvider}` },
    { name: '콘텐츠 생성', state: stateOf(true, getContentAdapter().info().mode, getContentAdapter().info().missingCredentials), sub: `공급자 ${getContentAdapter().info().provider}` },
  ];
  return (
    <>
      <PageHeader title="자동화 운영" description="발굴(콘텐츠·SNS)·안내(알림톡·월간 안내)·약정서 연동 상태와 기관별 처리 현황입니다." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {providers.map((p) => (
          <StatTile key={p.name} label={p.name} value={STATE_TEXT[p.state]} sub={p.sub} tone={STATE_TONE[p.state]} />
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
          <AiCostPanel />
          <Table>
            <thead><tr><Th>기관</Th><Th>이번 달 생성</Th><Th>비용</Th></tr></thead>
            <tbody>
              {contentAgg.map((c) => <tr key={c.merchantId}><Td>{merchants.get(c.merchantId) ?? c.merchantId}</Td><Td className="tabular-nums">{c._count._all}건</Td><Td className="tabular-nums">{formatWon(BigInt(c._sum.costKrw ?? 0))}</Td></tr>)}
              {contentAgg.length === 0 ? <tr><Td className="text-ink-400">이번 달 생성 기록이 없습니다.</Td><Td /><Td /></tr> : null}
            </tbody>
          </Table>
          <h2 className="text-[15px] font-black">게시 실패 · 게시 중 멈춤</h2>
          <Table>
            <thead><tr><Th>기관</Th><Th>콘텐츠</Th><Th>플랫폼</Th><Th>시도</Th><Th>사유</Th></tr></thead>
            <tbody>
              {publishFailed.map((p) => <tr key={p.id}><Td>{p.item.merchant.displayName}</Td><Td>{p.item.title}</Td><Td>{PLATFORM_LABEL[p.platform]}</Td><Td className="tabular-nums">{p.attempts}</Td><Td className="text-[12px] text-danger-500">{p.status === 'PUBLISHING' ? '게시 중 멈춤(다음 배치에서 예약으로 되돌림) ' : ''}{p.error}</Td></tr>)}
              {publishFailed.length === 0 ? <tr><Td className="text-ink-400">실패한 게시가 없습니다.</Td><Td /><Td /><Td /><Td /></tr> : null}
            </tbody>
          </Table>
        </div>
      ) : null}

      {tab === 'jobs' ? (
        <div className="space-y-4">
          <Notice tone="neutral">외부 스케줄러(EventBridge 등)에 아래 주기로 등록합니다. 마지막 실행이 주기의 3배를 넘기면 &apos;지연&apos; 으로 표시합니다.</Notice>
          <Table>
            <thead><tr><Th>배치</Th><Th>주기</Th><Th>마지막 시작</Th><Th>마지막 종료</Th><Th>결과</Th><Th>소요</Th><Th>실행/실패</Th><Th>하는 일</Th></tr></thead>
            <tbody>
              {CRON_JOBS.map((j) => {
                const h = beatByName.get(j.name);
                const late = isLate(h?.lastFinishedAt ?? null, j.intervalSec);
                return (
                  <tr key={j.name}>
                    <Td className="font-mono text-[12px] font-semibold">{j.path}</Td>
                    <Td className="whitespace-nowrap text-[12px]">{j.schedule}</Td>
                    <Td className="whitespace-nowrap text-[12px]">{h?.lastStartedAt ? formatKst(h.lastStartedAt) : '-'}</Td>
                    <Td className="whitespace-nowrap text-[12px]">{h?.lastFinishedAt ? formatKst(h.lastFinishedAt) : '-'}</Td>
                    <Td>{!h ? <Badge tone="neutral">기록 없음</Badge> : late ? <Badge tone="warning">지연</Badge> : h.lastOk ? <Badge tone="success">정상</Badge> : <Badge tone="danger">실패 {h.lastStatus ?? ''}</Badge>}</Td>
                    <Td className="tabular-nums text-[12px]">{h?.lastDurationMs != null ? `${formatNumber(h.lastDurationMs)}ms` : '-'}</Td>
                    <Td className="tabular-nums text-[12px]">{h ? `${formatNumber(h.runCount)} / ${formatNumber(h.failCount)}` : '-'}</Td>
                    <Td className="text-[12px] text-ink-500">{j.description}{h?.lastError && !h.lastOk ? <span className="block text-danger-500">{h.lastError}</span> : null}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {eventStats ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label="처리 대기 이벤트" value={`${formatNumber(eventStats.pending)}건`} sub={eventStats.oldestPendingAt ? `가장 오래된 ${formatKst(eventStats.oldestPendingAt)}` : undefined} tone={eventStats.pending > 500 ? 'warning' : 'neutral'} />
              <StatTile label="재시도 소진" value={`${formatNumber(eventStats.failed)}건`} tone={eventStats.failed ? 'danger' : 'neutral'} />
              <StatTile label="최근 24시간 이벤트" value={`${formatNumber(eventStats.last24h)}건`} />
            </div>
          ) : null}
          <h2 className="text-[15px] font-black">재시도 소진 이벤트</h2>
          <Table>
            <thead><tr><Th>시각</Th><Th>종류</Th><Th>기관</Th><Th>시도</Th><Th>오류</Th><Th></Th></tr></thead>
            <tbody>
              {failedEvents.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap text-[12px]">{formatKst(e.occurredAt)}</Td>
                  <Td className="font-mono text-[12px]">{e.type}</Td>
                  <Td className="font-mono text-[12px]">{e.merchantId}</Td>
                  <Td className="tabular-nums">{e.attempts}</Td>
                  <Td className="text-[12px] text-danger-500">{e.lastError}</Td>
                  <Td><ActionButton action={retryEventAction} values={{ id: e.id }} label="다시 처리" /></Td>
                </tr>
              ))}
              {failedEvents.length === 0 ? <tr><Td className="text-ink-400">재시도 소진 이벤트가 없습니다.</Td></tr> : null}
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

/** 콘텐츠 탭 — LLM 공급자·모델·이번 달 AI 비용(ai_usage 합) */
async function AiCostPanel() {
  const llm = getLlmAdapter().info();
  const usage = await aiUsageThisMonth();
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="LLM 공급자" value={llm.mode === 'mock' ? 'mock' : llm.provider} sub={llm.missingCredentials.length ? `설정 없음: ${llm.missingCredentials.join(', ')}` : undefined} tone={llm.mode === 'mock' ? 'warning' : llm.missingCredentials.length ? 'danger' : 'success'} />
        <StatTile label="모델" value={llm.model || '-'} />
        <StatTile label="이번 달 AI 비용" value={formatWon(BigInt(usage.total))} sub="ai_usage 합계 (단가 환경변수 기준)" />
        <StatTile label="이번 달 AI 호출" value={`${formatNumber(usage.rows.reduce((a, r) => a + r._count._all, 0))}회`} />
      </div>
      {usage.rows.length ? (
        <Table>
          <thead><tr><Th>기능</Th><Th>호출</Th><Th>입력 토큰</Th><Th>출력 토큰</Th><Th>비용</Th></tr></thead>
          <tbody>
            {usage.rows.map((r) => (
              <tr key={r.feature}>
                <Td>{AI_FEATURE_LABEL[r.feature as AiFeature] ?? r.feature}</Td>
                <Td className="tabular-nums">{formatNumber(r._count._all)}</Td>
                <Td className="tabular-nums">{formatNumber(r._sum.inputTokens ?? 0)}</Td>
                <Td className="tabular-nums">{formatNumber(r._sum.outputTokens ?? 0)}</Td>
                <Td className="tabular-nums">{formatWon(BigInt(r._sum.costKrw ?? 0))}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </div>
  );
}
