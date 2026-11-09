import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { featureContentEnabled } from '@/lib/env';
import { formatNumber, formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, LinkButton, Notice, StatTile } from '@/components/ui';
import { getContentAdapter } from '@/server/adapters/content';
import {
  CONTENT_OUTCOME_WINDOW_DAYS,
  CONTENT_WIN_MIN_PUBLISHED,
  contentOutcomes,
  latestWinHints,
  outcomeBreakdown,
  RETAINED_PLEDGE_DAYS,
  RETAINED_PLEDGE_MIN_SUCCESS,
  topOutcomes,
  variantComparisons,
  winHintsFrom,
  type OutcomeBucket,
} from '@/server/services/content-performance';

export const dynamic = 'force-dynamic';

/**
 * 콘텐츠 성과 (2026-11-11 G2-5) — 게시 → 클릭 → 후원·약정 → 3개월 유지. 출처를 모르는 후원은 배정하지 않고 "미확인" 으로 따로 센다.
 * 숫자는 모두 원천 집계값이다(결제 건·약정·출금 실행·게시 행 클릭).
 */
export default async function ContentPerformancePage() {
  if (!featureContentEnabled()) notFound();
  const { merchantId } = await requireMerchant();
  const [report, saved] = await Promise.all([contentOutcomes(merchantId), latestWinHints(merchantId)]);
  const b = outcomeBreakdown(report.items);
  const top = topOutcomes(report.items);
  const ab = variantComparisons(report.items);
  const hints = winHintsFrom(report.items);
  const mock = getContentAdapter().info().mode === 'mock';
  const total = report.items.reduce((a, o) => ({ clicks: a.clicks + o.clicks, donations: a.donations + o.donations, amount: a.amount + o.amount, pledges: a.pledges + o.newPledges, retained: a.retained + o.retainedPledges }), { clicks: 0, donations: 0, amount: 0n, pledges: 0, retained: 0 });

  return (
    <>
      <PageHeader
        title="콘텐츠 성과"
        description={`최근 ${CONTENT_OUTCOME_WINDOW_DAYS}일 게시한 콘텐츠의 클릭과 후원 전환입니다. 링크(/go)를 눌러 들어온 뒤 후원·약정한 기록만 콘텐츠에 붙입니다.`}
        action={<LinkButton href="/studio/content" variant="secondary" size="sm">콘텐츠 만들기</LinkButton>}
      />
      <div className="my-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="게시한 콘텐츠" value={`${report.items.length}건`} />
        <StatTile label="클릭" value={`${formatNumber(total.clicks)}회`} />
        <StatTile label="콘텐츠로 들어온 후원" value={`${formatNumber(total.donations)}건`} sub={formatWon(total.amount)} tone="brand" />
        <StatTile label="신규 정기 약정 · 3개월 유지" value={`${total.pledges} · ${total.retained}건`} sub={`유지 = ${RETAINED_PLEDGE_DAYS}일 뒤 진행 중 + 출금 ${RETAINED_PLEDGE_MIN_SUCCESS}회 이상`} />
        <StatTile label="출처 미확인 후원(배정 안 함)" value={`${formatNumber(report.unattributed.donations)}건`} sub={formatWon(report.unattributed.amount)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">상위 콘텐츠 5개</h2>
          {top.length === 0 ? (
            <div className="mt-3"><EmptyState title="게시한 콘텐츠가 없습니다" description="게시 기록(게시됨·비공개 업로드)이 있는 콘텐츠만 집계합니다." /></div>
          ) : (
            <ol className="mt-3 divide-y divide-ink-100">
              {top.map((o, i) => (
                <li key={o.itemId} className="py-2 text-[13px]">
                  <Link href={`/studio/content/${o.itemId}`} className="font-bold text-ink-900">{i + 1}. {o.title}</Link>
                  {o.variantLabel ? <Badge tone="brand" className="ml-1">{o.variantLabel}안</Badge> : null}
                  <p className="text-[12px] text-ink-500">클릭 {formatNumber(o.clicks)} · 후원 {o.donations}건 {formatWon(o.amount)} · 약정 {o.newPledges}(유지 {o.retainedPledges}){o.firstPublishedAt ? ` · ${formatKst(o.firstPublishedAt, false)} 게시` : ''}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">다음 생성에 넣는 &quot;잘된 것&quot;</h2>
          {report.items.length < CONTENT_WIN_MIN_PUBLISHED ? (
            <p className="mt-2 text-[13px] text-ink-500">게시가 {CONTENT_WIN_MIN_PUBLISHED}건 이상 쌓이면 요약해 콘텐츠 생성 지시에 넣습니다(지금 {report.items.length}건).</p>
          ) : hints.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-ink-700">{hints.map((h) => <li key={h}>{h}</li>)}</ul>
          ) : (
            <p className="mt-2 text-[13px] text-ink-500">두드러지게 잘된 요소가 아직 없습니다.</p>
          )}
          {mock ? <Notice tone="warning" title="AI 공급자 연결 전">지금은 저장·표시만 합니다. AI 공급자를 연결하면 콘텐츠 대본을 만들 때 참고합니다.</Notice> : null}
          {saved ? <p className="mt-2 text-[11.5px] text-ink-400">마지막으로 생성에 쓴 요약: {formatKst(new Date(saved.at), false)} · 게시 {saved.published}건 기준</p> : null}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <BucketCard title="형식별" rows={b.byKind} />
        <BucketCard title="요일별(KST)" rows={b.byWeekday} />
        <BucketCard title="시각별(KST)" rows={b.byHour} />
        <BucketCard title="주제별" rows={b.byTopic} />
        <BucketCard title="첫 문장 길이별" rows={b.byFirstLine} />
      </div>

      <Card className="mt-4">
        <h2 className="text-[16px] font-black text-ink-900">2안 비교(A/B)</h2>
        <p className="mt-1 text-[12px] text-ink-400">콘텐츠 설정에서 2안 비교를 켜면 캘린더 슬롯마다 캡션 2안을 만들고, 두 안을 모두 승인했을 때 나눠 게시합니다.</p>
        {ab.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-400">게시된 2안 비교가 없습니다.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[480px] text-[12.5px]">
              <thead><tr className="text-left text-ink-400"><th className="py-1">콘텐츠</th><th>A안 클릭·후원</th><th>B안 클릭·후원</th><th>더 나은 안</th></tr></thead>
              <tbody>
                {ab.map((g) => {
                  const score = (o: typeof g.a) => (o ? o.donations * 100 + o.newPledges * 100 + o.clicks : -1);
                  const winner = g.a && g.b ? (score(g.a) === score(g.b) ? '비슷함' : score(g.a) > score(g.b) ? 'A안' : 'B안') : '한 안만 게시';
                  return (
                    <tr key={g.groupId} className="border-t border-ink-100">
                      <td className="py-1.5 font-bold text-ink-900">{g.title}</td>
                      <td>{g.a ? `${formatNumber(g.a.clicks)} · ${g.a.donations}건` : '-'}</td>
                      <td>{g.b ? `${formatNumber(g.b.clicks)} · ${g.b.donations}건` : '-'}</td>
                      <td>{winner}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function BucketCard({ title, rows }: { title: string; rows: OutcomeBucket[] }) {
  return (
    <Card>
      <h3 className="text-[14px] font-black text-ink-900">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-ink-400">기록 없음</p>
      ) : (
        <ul className="mt-2 divide-y divide-ink-100 text-[12.5px]">
          {rows.slice(0, 8).map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-2 py-1.5">
              <span className="font-bold text-ink-800">{r.label} <span className="font-normal text-ink-400">{r.items}건</span></span>
              <span className="text-ink-600">평균 클릭 {r.avgClicks} · 후원 {r.donations} · 전환 {r.conversion === null ? '-' : `${r.conversion}%`}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
