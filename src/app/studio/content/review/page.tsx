import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CalendarClock, CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { featureContentEnabled } from '@/lib/env';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Field, Input, LinkButton, Notice, Select } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { SvgThumb } from '@/components/content/scene-player';
import { ContentBulkApprove } from '@/components/studio/content-bulk-approve';
import { kindFormat, getContentAdapter } from '@/server/adapters/content';
import { PLATFORM_LABEL } from '@/server/adapters/sns';
import { CONTENT_KIND_SHORT, getContentSetting } from '@/server/services/content';
import { formatSlot, WEEKDAY_LABEL } from '@/server/services/content-calendar';
import { contentPlatformsFor, contentPrecheck, reviewWeeks, type PrecheckRow, type ReviewEntry } from '@/server/services/content-review';
import { CONTENT_REJECT_REASON_LABEL, CONTENT_REJECT_REASONS, CONTENT_REVISION_MAX_LEN, CONTENT_REVISIONS_PER_DAY } from '@/lib/content-review';
import { bulkApproveContentAction, rejectContentAction, reviseContentAction } from '@/app/actions/content-review';
import { assetStatusForItems, CONSENT_STATE_LABEL, type AssetUsability } from '@/server/services/content-assets';

export const dynamic = 'force-dynamic';

const FORM_ID = 'content-bulk-approve';

function dayLabel(dayKey: string) {
  const d = new Date(`${dayKey}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${WEEKDAY_LABEL[d.getUTCDay()]})`;
}

function weekLabel(start: Date) {
  const k = new Date(start.getTime() + 9 * 3600_000);
  const e = new Date(k.getTime() + 6 * 86_400_000);
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()} ~ ${e.getUTCMonth() + 1}/${e.getUTCDate()}`;
}

function captionHead(caption: string | null) {
  const line = (caption ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' · ');
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/**
 * 주간 묶음 승인 (2026-11-09). 이번 주·다음 주(월~일, KST) 검토 대기 콘텐츠를 날짜별 카드로 — 골라서 한 번에 승인,
 * 개별 반려(이유 + 메모)·수정 요청(한 줄). 모바일에서 한 손으로 쓰게 카드는 세로, 버튼은 크게.
 */
export default async function ContentReviewPage() {
  if (!featureContentEnabled()) notFound();
  const { merchantId } = await requireMerchant();
  const [{ weeks, later, total }, setting] = await Promise.all([reviewWeeks(merchantId), getContentSetting(merchantId)]);
  const shown = weeks.flatMap((w) => w.days.flatMap((d) => d.entries));
  const checks = new Map<string, PrecheckRow[]>(
    await Promise.all(shown.map(async (e) => [e.item.id, await contentPrecheck(e.item, setting)] as const)),
  );
  // 소재를 쓴 콘텐츠는 초상권 동의서 상태를 함께 보여 준다(2026-11-11 G)
  const assets = await assetStatusForItems(merchantId, shown.map((e) => ({ id: e.item.id, assetIds: e.item.assetIds ?? [] })));
  const mock = getContentAdapter().info().mode === 'mock';
  const hasPastDue = shown.some((e) => e.pastDue);

  return (
    <>
      <PageHeader
        title="주간 콘텐츠 승인"
        description="AI 가 만든 이번 주·다음 주 콘텐츠를 한 번에 확인합니다. 담당자가 승인해야만 게시됩니다."
        action={<LinkButton href="/studio/content" variant="secondary" size="sm">콘텐츠 만들기</LinkButton>}
      />
      {mock ? <div className="mb-3"><Notice tone="warning" title="콘텐츠 생성 mock">AI 공급자 연결 전입니다. 수정 요청은 메모로만 남고, 문장 반영은 AI 공급자 연결 후 됩니다.</Notice></div> : null}

      {total === 0 ? (
        <EmptyState title="승인을 기다리는 콘텐츠가 없습니다" description="콘텐츠 캘린더가 만들거나 직접 만든 콘텐츠가 여기에 모입니다." />
      ) : (
        <div className="space-y-6">
          {weeks.map((w) => (
            <section key={w.key}>
              <h2 className="mb-2 flex items-center gap-2 text-[16px] font-black text-ink-900">
                {w.key === 'THIS' ? '이번 주' : '다음 주'} <span className="text-[13px] font-bold text-ink-400">{weekLabel(w.start)} · {w.count}건</span>
              </h2>
              {w.count === 0 ? <p className="text-[13px] text-ink-400">검토할 콘텐츠가 없습니다.</p> : null}
              <div className="space-y-4">
                {w.days.map((d) => (
                  <div key={d.dayKey}>
                    <p className="mb-1.5 text-[13px] font-bold text-ink-600">{dayLabel(d.dayKey)}</p>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {d.entries.map((e) => (
                        <ReviewCard key={e.item.id} entry={e} checks={checks.get(e.item.id) ?? []} platforms={contentPlatformsFor(e.item.kind, setting.platforms)} mock={mock} assets={assets.get(e.item.id) ?? []} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {later ? <p className="text-[12.5px] text-ink-400">다음 주 뒤에 게시할 콘텐츠 {later}건은 콘텐츠 만들기 화면의 검토 대기에서 볼 수 있습니다.</p> : null}
          <ContentBulkApprove action={bulkApproveContentAction} formId={FORM_ID} total={shown.length} hasPastDue={hasPastDue} />
        </div>
      )}
    </>
  );
}

function ReviewCard({ entry, checks, platforms, mock, assets = [] }: { entry: ReviewEntry; checks: PrecheckRow[]; platforms: string[]; mock: boolean; assets?: AssetUsability[] }) {
  const { item } = entry;
  const blocked = checks.some((c) => c.blocking && !c.ok);
  const failed = checks.filter((c) => !c.ok).length;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex gap-3">
        <label className="flex shrink-0 cursor-pointer items-start pt-1">
          <input
            type="checkbox"
            name="ids"
            value={item.id}
            form={FORM_ID}
            disabled={blocked}
            aria-label={`${item.title} 고르기`}
            className="h-6 w-6 accent-brand-600"
          />
        </label>
        <Link href={`/studio/content/${item.id}`} className="w-20 shrink-0" aria-label={`${item.title} 상세 보기`}>
          <SvgThumb svg={item.coverSvg} format={kindFormat(item.kind)} className="w-full" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-1">
            <Badge>{CONTENT_KIND_SHORT[item.kind]}</Badge>
            {entry.pastDue ? <Badge tone="danger">게시 시각 지남</Badge> : null}
            {item.revisionRequest ? <Badge tone="brand">수정 요청 판</Badge> : null}
            {item.variantLabel ? <Badge tone="brand">2안 비교 {item.variantLabel}안</Badge> : null}
          </div>
          <Link href={`/studio/content/${item.id}`} className="mt-1 block line-clamp-2 text-[13.5px] font-bold text-ink-900">{item.title}</Link>
          <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-500">{captionHead(item.caption)}</p>
          <p className="mt-1 flex items-center gap-1 text-[12px] text-ink-500">
            <CalendarClock size={14} strokeWidth={1.7} />
            {entry.slotAt ? formatSlot(entry.slotAt) : '게시 시각 없음(직접 예약)'}
          </p>
          <p className="mt-0.5 text-[11.5px] text-ink-400">{platforms.map((p) => PLATFORM_LABEL[p as keyof typeof PLATFORM_LABEL] ?? p).join(' · ')}</p>
        </div>
      </div>

      {assets.length ? (
        <ul className="space-y-1 rounded-lg bg-ink-50 px-3 py-2 text-[12px] text-ink-600">
          {assets.map((u) => (
            <li key={u.asset.id}>
              소재 · {u.asset.hasFace ? CONSENT_STATE_LABEL[u.consent] : '얼굴 없음'}
              {u.usable ? null : <span className="ml-1 font-bold text-danger-500">사용 불가 — {u.reasons[0]}</span>}
              {u.warnings.map((w) => <span key={w} className="ml-1 text-warning-500">{w}</span>)}
            </li>
          ))}
        </ul>
      ) : null}

      {item.revisionRequest ? (
        <p className="rounded-lg bg-ink-50 px-3 py-2 text-[12px] text-ink-600">
          수정 요청: {item.revisionRequest}
          {mock ? <span className="ml-1 font-bold text-warning-500">(AI 공급자 연결 후 문장 반영)</span> : null}
        </p>
      ) : null}

      <details className="rounded-lg border border-ink-100 px-3 py-2" open={failed > 0}>
        <summary className="cursor-pointer text-[12.5px] font-bold text-ink-700">
          사전 점검 {checks.length - failed}/{checks.length} 통과{blocked ? ' · 승인 불가 항목 있음' : ''}
        </summary>
        <ul className="mt-2 space-y-1.5">
          {checks.map((c) => (
            <li key={c.key} className="flex gap-1.5 text-[12px] leading-snug">
              {c.ok ? (
                <CircleCheck size={16} strokeWidth={1.7} className="mt-px shrink-0 text-success-500" />
              ) : c.blocking ? (
                <CircleAlert size={16} strokeWidth={1.7} className="mt-px shrink-0 text-danger-500" />
              ) : (
                <TriangleAlert size={16} strokeWidth={1.7} className="mt-px shrink-0 text-warning-500" />
              )}
              <span><b className="text-ink-800">{c.label}</b> <span className="text-ink-500">{c.detail}</span></span>
            </li>
          ))}
        </ul>
      </details>

      <div className="grid gap-2 sm:grid-cols-2">
        <details className="rounded-lg border border-ink-100 px-3 py-2">
          <summary className="cursor-pointer text-[13px] font-bold text-ink-700">수정 요청</summary>
          <div className="mt-2">
            <ActionForm action={reviseContentAction} submitLabel="다시 만들기" pendingLabel="만드는 중" size="lg">
              <input type="hidden" name="id" value={item.id} />
              <Field label="한 줄 요청" hint={`예: 첫 문장을 짧게. 하루 ${CONTENT_REVISIONS_PER_DAY}회까지, 실명·연락처는 적을 수 없습니다.`}>
                <Input name="request" maxLength={CONTENT_REVISION_MAX_LEN} required placeholder="사진을 더 밝게" />
              </Field>
            </ActionForm>
          </div>
        </details>
        <details className="rounded-lg border border-ink-100 px-3 py-2">
          <summary className="cursor-pointer text-[13px] font-bold text-danger-500">반려</summary>
          <div className="mt-2">
            <ActionForm action={rejectContentAction} submitLabel="반려" variant="danger" size="lg" confirmMessage="반려하면 이 콘텐츠는 게시되지 않고 보관됩니다. 이유는 다음 생성 때 참고합니다.">
              <input type="hidden" name="id" value={item.id} />
              <Field label="이유">
                <Select name="reasonCode" defaultValue="OTHER">
                  {CONTENT_REJECT_REASONS.map((r) => <option key={r} value={r}>{CONTENT_REJECT_REASON_LABEL[r]}</option>)}
                </Select>
              </Field>
              <Field label="메모 (선택)"><Input name="note" maxLength={200} placeholder="예: 목표액 표현이 과장됨" /></Field>
            </ActionForm>
          </div>
        </details>
      </div>
    </Card>
  );
}
