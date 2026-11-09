import Link from 'next/link';
import { Card, Notice, StatTile, cx } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { FunnelBars } from '@/components/funnel/funnel-bars';
import { prisma } from '@/server/db';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { FUNNEL_CHANNEL_LABEL, funnelReport } from '@/server/services/funnel-report';
import type { FunnelChannel } from '@/server/services/funnel';
import { COMMAND_COUNT_LABEL, commandCounts } from '@/server/services/mo-commands';

/** 신고 · 문자 후원 단계 탭 */
export function ReportTabs({ active }: { active: 'reports' | 'funnel' }) {
  const tabs = [
    { key: 'reports', href: '/studio/reports', label: '신고 내역' },
    { key: 'funnel', href: '/studio/reports?tab=funnel', label: '문자 후원 단계별 현황' },
  ] as const;
  return (
    <nav className="mb-4 flex flex-wrap gap-2" aria-label="보고 화면">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cx('rounded-full border px-3.5 py-2 text-[13px] font-bold', active === t.key ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600')}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** 기간 시작 (렌더 밖 함수 — 화면 시각 계산) */
function sinceDays(days: number) {
  return new Date(Date.now() - days * 86_400_000);
}

const CHANNELS: FunnelChannel[] = ['MO', 'WEB', 'QR'];

/**
 * 문자 후원 단계별 현황 (2026-11-09 B1). 측정 시작 이후의 기록만 보여 준다(이 기능 전 결제 건은 거꾸로 추정하지 않는다).
 * 막대 깔때기는 CSS 만 쓴다. 미완료 안내 문자는 만들지 않았다(측정만 — 정책 결정 대기).
 */
export async function FunnelTab({ merchantId, days, campaign, channel }: { merchantId: string; days?: string; campaign?: string; channel?: string }) {
  const period = days === '7' ? 7 : 30;
  const ch: FunnelChannel = CHANNELS.includes(channel as FunnelChannel) ? (channel as FunnelChannel) : 'MO';
  const campaigns = await prisma.campaign.findMany({ where: { merchantId, status: { not: 'ARCHIVED' } }, orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }], select: { id: true, title: true, code: true } });
  const campaignId = campaign && campaigns.some((c) => c.id === campaign) ? campaign : null;
  const report = await funnelReport({ merchantId, campaignId, channel: ch, since: sinceDays(period) });
  const commands = await commandCounts(merchantId, sinceDays(period)); // 명령 문자(2026-11-12 4차 K3) — 결제 단계와 따로
  const q = (over: Record<string, string | null>) => {
    const p = new URLSearchParams({ tab: 'funnel', days: String(period), channel: ch, ...(campaignId ? { campaign: campaignId } : {}) });
    for (const [k, v] of Object.entries(over)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    return `/studio/reports?${p.toString()}`;
  };
  const pill = (on: boolean) => cx('rounded-full border px-3 py-1.5 text-[12.5px] font-bold', on ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-ink-200 bg-white text-ink-600');
  const paid = report.steps[report.steps.length - 1]?.count ?? 0;

  return (
    <>
      <PageHeader title="문자 후원 단계별 현황" description="문자를 받은 뒤 후원이 끝날 때까지 어느 단계에서 많이 멈추는지 봅니다. 개인정보 없이 단계 도달 수만 셉니다." />
      <ReportTabs active="funnel" />
      <div className="space-y-4">
        <Notice tone="neutral" title="측정 시작 이후만 보여 줍니다">
          {report.measuredSince ? `${formatKst(report.measuredSince, false)}부터 기록한 흐름입니다.` : '아직 기록된 흐름이 없습니다.'} 이 기능 전의 후원 건은 결제 상태로 거꾸로 추정하지 않습니다.
          같은 링크를 여러 번 열어도 한 번만 세고, 카카오·네이버 같은 링크 미리보기는 세지 않습니다.
        </Notice>

        <div className="flex flex-wrap gap-2">
          <Link href={q({ days: '7' })} className={pill(period === 7)}>최근 7일</Link>
          <Link href={q({ days: '30' })} className={pill(period === 30)}>최근 30일</Link>
          <span className="mx-1 hidden w-px bg-ink-100 sm:block" />
          {CHANNELS.map((c) => <Link key={c} href={q({ channel: c })} className={pill(ch === c)}>{FUNNEL_CHANNEL_LABEL[c]}</Link>)}
        </div>
        {campaigns.length ? (
          <div className="flex flex-wrap gap-1.5">
            <Link href={q({ campaign: null })} className={pill(!campaignId)}>모든 캠페인</Link>
            {campaigns.map((c) => <Link key={c.id} href={q({ campaign: c.id })} className={pill(campaignId === c.id)}>{c.title}</Link>)}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile label={ch === 'MO' ? '문자 수신' : '후원 시작'} value={`${formatNumber(report.total)}건`} />
          <StatTile label="후원 완료" value={`${formatNumber(paid)}건`} tone="success" />
          <StatTile label="전체 전환율" value={`${report.total ? report.steps[report.steps.length - 1]!.rateFromStart : 0}%`} tone="brand" />
          <StatTile label="가장 많이 끊기는 곳" value={report.biggestDrop ? `${formatNumber(report.biggestDrop.lost)}건` : '-'} sub={report.biggestDrop ? `${report.steps.find((s) => s.step === report.biggestDrop!.to)?.label ?? ''} 전` : undefined} tone={report.biggestDrop ? 'warning' : 'neutral'} />
        </div>

        <Card>
          {report.total === 0 ? (
            <p className="text-[13px] text-ink-400">이 기간에 시작된 {FUNNEL_CHANNEL_LABEL[ch]} 흐름이 없습니다.</p>
          ) : (
            <FunnelBars report={report} />
          )}
        </Card>
        <p className="text-[12px] leading-relaxed text-ink-400">
          {ch === 'MO'
            ? '단계: 문자 수신 → 안내 문자(확인 링크) 발송 → 링크 열람 → 금액·방식 선택 → 인증(PIN) 시작 → 후원 완료. 결제수단 미등록 번호는 안내 문자 대신 가입 안내가 나가 "결제수단 미등록" 으로 끝납니다.'
            : '웹·QR 후원은 후원페이지에서 금액을 제출한 순간부터 셉니다(문자 수신·회신 단계 없음, 후원페이지 방문 수는 세지 않습니다).'}
        </p>
        {ch === 'MO' ? (
          <Card>
            <h2 className="mb-1 text-[15px] font-black text-ink-900">명령 문자 (최근 {period}일)</h2>
            <p className="mb-3 text-[12.5px] text-ink-500">정기·봉사·영수증·내역·변경·해지·문의 문자는 후원(결제) 단계에 넣지 않고 따로 셉니다.</p>
            {commands.length === 0 ? <p className="text-[13px] text-ink-400">이 기간에 받은 명령 문자가 없습니다.</p> : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {commands.map((c) => <StatTile key={c.kind} label={COMMAND_COUNT_LABEL[c.kind] ?? c.kind} value={`${formatNumber(c.count)}건`} />)}
              </div>
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
