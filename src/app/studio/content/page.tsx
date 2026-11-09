import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { env, featureContentEnabled } from '@/lib/env';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Checkbox, EmptyState, Field, Input, LinkButton, Notice, Select, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { SvgThumb } from '@/components/content/scene-player';
import { formatKst } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { getContentAdapter, TONE_LABEL, type Tone } from '@/server/adapters/content';
import { CONTENT_KIND_LABEL, CONTENT_KIND_SHORT, CONTENT_KINDS, CONTENT_STATUS_LABEL, contentConversions, getContentSetting, monthlyUsage } from '@/server/services/content';
import { calendarBlockers, calendarPreview, DEFAULT_CALENDAR_KINDS, effectiveDays, WEEKDAY_LABEL } from '@/server/services/content-calendar';
import { aiDraftAvailability, getCachedInsight } from '@/server/services/ai-drafts';
import { kindFormat } from '@/server/adapters/content';
import { PLATFORM_LABEL, PLATFORMS } from '@/server/adapters/sns';
import { requestContentAction, saveContentSettingAction } from '@/app/actions/automation';
import { contentInsightFormAction } from '@/app/actions/ai-drafts';
import { kstDateKey } from '@/lib/datetime';
import type { ContentStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

/** 슬롯 시각이 지났는가 (렌더 밖 함수 — 화면 시각 계산) */
function isPastSlot(at: Date | undefined) {
  return Boolean(at && at.getTime() <= Date.now());
}

const STATUS_TONE: Record<string, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'> = {
  GENERATING: 'neutral', REVIEW: 'warning', APPROVED: 'brand', SCHEDULED: 'brand', PUBLISHED: 'success', FAILED: 'danger', ARCHIVED: 'neutral', DRAFT: 'neutral',
};

/**
 * 콘텐츠 만들기 — 캠페인으로 숏폼·캠페인 이미지를 자동 생성하고 검토·승인한다.
 * 승인된 콘텐츠는 SNS 채널에 예약 게시하거나(플랫폼 심사 후) 내려받아 직접 올린다.
 */
export default async function StudioContentPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  if (!featureContentEnabled()) notFound();
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  // 허용 목록(자기 속성)만 받는다. 일반 객체 조회는 constructor·toString 같은 프로토타입 키를 통과시킨다.
  const filter = sp.status && Object.hasOwn(CONTENT_STATUS_LABEL, sp.status) ? (sp.status as ContentStatus) : undefined;
  const [merchant, campaigns, items, setting, usage, counts] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { fundraisingRegNo: true } }),
    prisma.campaign.findMany({ where: { merchantId, status: { in: ['ACTIVE', 'DRAFT'] } }, orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }] }),
    prisma.contentItem.findMany({ where: { merchantId, status: filter ?? { not: 'ARCHIVED' } }, orderBy: { createdAt: 'desc' }, take: 60, include: { publishes: true } }),
    getContentSetting(merchantId),
    monthlyUsage(merchantId),
    prisma.contentItem.groupBy({ by: ['status'], where: { merchantId }, _count: { _all: true } }),
  ]);
  const [conv, preview, blockers, insight, itemSlots] = await Promise.all([
    contentConversions(merchantId, items.map((i) => i.id)),
    calendarPreview(merchantId),
    calendarBlockers(merchantId),
    getCachedInsight(merchantId),
    prisma.contentSlot.findMany({ where: { merchantId, itemId: { in: items.map((i) => i.id) } }, select: { itemId: true, slotAt: true } }),
  ]);
  const slotAtBy = new Map(itemSlots.map((x) => [x.itemId, x.slotAt]));
  const ai = aiDraftAvailability();
  const insightToday = insight?.dayKey === kstDateKey();
  const calendarKinds = setting.kinds.length ? setting.kinds : DEFAULT_CALENDAR_KINDS;
  const usedDays = new Set(effectiveDays(setting));
  const c = (s: string) => counts.find((x) => x.status === s)?._count._all ?? 0;
  const totalConv = [...conv.values()].reduce((a, v) => ({ donations: a.donations + v.donations, amount: a.amount + v.amount, pledges: a.pledges + v.pledges, volunteers: a.volunteers + v.volunteers }), { donations: 0, amount: 0n, pledges: 0, volunteers: 0 });
  const mock = getContentAdapter().info().mode === 'mock';
  const campaignTitle = new Map(campaigns.map((x) => [x.id, x.title]));

  return (
    <>
      <PageHeader
        title="콘텐츠 만들기"
        description="캠페인 이야기로 숏폼(9:16)과 캠페인 이미지를 자동으로 만듭니다. 기관 명의로 나가는 게시물이라 담당자가 검토·승인한 뒤 게시합니다."
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/studio/content/review" size="sm">주간 승인{c('REVIEW') ? ` (${c('REVIEW')})` : ''}</LinkButton>
            <LinkButton href="/studio/content/performance" variant="secondary" size="sm">성과</LinkButton>
            <LinkButton href="/studio/content/assets" variant="secondary" size="sm">소재</LinkButton>
            <LinkButton href="/studio/channels" variant="secondary" size="sm">SNS 채널 연결</LinkButton>
          </div>
        }
      />
      {mock ? <Notice tone="warning" title="콘텐츠 생성 mock">AI 공급자(대본·이미지·음성) 연결 전입니다. 캠페인 내용으로 대본과 장면 이미지(SVG)를 만들고, 음성·영상(mp4)은 만들지 않습니다. 장면 이미지와 자막 파일은 바로 내려받아 쓸 수 있습니다.</Notice> : null}
      {!merchant.fundraisingRegNo ? (
        <div className="mt-3"><Notice tone="warning" title="기부금품 모집등록번호가 없습니다">콘텐츠는 만들 수 있지만 승인(게시)은 할 수 없습니다. 모집 광고에는 등록번호 표시가 필요합니다. 기관 정보에서 모집등록번호를 넣어 주세요.</Notice></div>
      ) : null}

      <div className="my-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="검토 대기" value={`${c('REVIEW')}건`} tone={c('REVIEW') ? 'warning' : 'neutral'} />
        <StatTile label="게시됨" value={`${c('PUBLISHED')}건`} tone="success" />
        <StatTile label="이번 달 생성" value={`${usage.count}/${setting.monthlyLimit}건`} sub={`비용 ${formatWon(BigInt(usage.costKrw))}`} />
        <StatTile label="콘텐츠로 들어온 후원" value={`${formatNumber(totalConv.donations)}건`} sub={formatWon(totalConv.amount)} tone="brand" />
        <StatTile label="콘텐츠로 들어온 약정·봉사" value={`${totalConv.pledges}·${totalConv.volunteers}건`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">새로 만들기</h2>
          {campaigns.length === 0 ? (
            <div className="mt-3"><EmptyState title="모금 중인 캠페인이 없습니다" description="캠페인을 먼저 만들면 그 이야기로 콘텐츠를 만들 수 있습니다." action={<LinkButton href="/studio/campaigns/new" size="sm">캠페인 만들기</LinkButton>} /></div>
          ) : (
            <div className="mt-3"><ActionForm action={requestContentAction} submitLabel="자동으로 만들기" pendingLabel="만드는 중">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="캠페인" required>
                  <Select name="campaignId">{campaigns.map((x) => <option key={x.id} value={x.id}>{x.title} ({x.code}){x.status === 'DRAFT' ? ' · 작성 중' : ''}</option>)}</Select>
                </Field>
                <Field label="분위기">
                  <Select name="tone" defaultValue={setting.tone}>{(Object.keys(TONE_LABEL) as Tone[]).map((t) => <option key={t} value={t}>{TONE_LABEL[t]}</option>)}</Select>
                </Field>
              </div>
              <Field label="형식 (여러 개 선택)">
                <div className="flex flex-wrap gap-2">
                  {CONTENT_KINDS.map((k, idx) => (
                    <label key={k} className="cursor-pointer rounded-xl border border-ink-200 px-3 py-2 text-[13px] font-bold has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                      <input type="checkbox" name="kind" value={k} defaultChecked={idx === 0} className="sr-only" />{CONTENT_KIND_LABEL[k]}
                    </label>
                  ))}
                </div>
              </Field>
              <p className="text-[12px] leading-relaxed text-ink-400">모든 결과물에 “AI 생성 콘텐츠” 표시와 모집등록번호가 들어갑니다. 수혜자 실사진·실명은 쓰지 않습니다. 캡션에는 후원 링크(유입 경로 포함)와 문자 키워드가 자동으로 들어갑니다.</p>
            </ActionForm></div>
          )}
        </Card>
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">기관 콘텐츠 설정</h2>
          <div className="mt-3"><ActionForm action={saveContentSettingAction} submitLabel="설정 저장" variant="secondary">
            <Field label="기본 분위기"><Select name="tone" defaultValue={setting.tone}>{(Object.keys(TONE_LABEL) as Tone[]).map((t) => <option key={t} value={t}>{TONE_LABEL[t]}</option>)}</Select></Field>
            <Field label="쓰지 않을 단어 (쉼표로 구분)"><Input name="bannedWords" defaultValue={setting.bannedWords.join(', ')} placeholder="예: 불쌍한, 가엾은" /></Field>
            <Field label="기본 해시태그"><Input name="hashtags" defaultValue={setting.hashtags.map((t) => `#${t}`).join(' ')} placeholder="#우리동네복지관 #나눔" /></Field>
            <Notice tone="neutral" title="승인 방식">콘텐츠는 AI 가 자동으로 만들고, 담당자가 승인해야 게시됩니다. 승인 전에는 어떤 채널에도 올라가지 않습니다.</Notice>

            <div className="mt-2 border-t border-ink-100 pt-4">
              <h3 className="text-[14px] font-black text-ink-900">콘텐츠 캘린더 (자율 생성)</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-400">정한 요일·시각(KST)마다 진행 중인 캠페인으로 콘텐츠를 스스로 만듭니다. 진행률이 낮고 마감이 가까운 캠페인부터 돌아가며 고르고, 형식은 고른 순서대로 돌립니다. 월 생성 한도 안에서만 만듭니다.</p>
              <Checkbox name="calendarEnabled" defaultChecked={setting.calendarEnabled} label="캘린더 켜기" />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="주당 건수 (1~7)"><Input type="number" name="weeklyCount" min={1} max={7} defaultValue={setting.weeklyCount} /></Field>
                <Field label="게시 시각 (KST)">
                  <Select name="postHour" defaultValue={String(setting.postHour)}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select>
                </Field>
              </div>
              <Field label="요일" hint="비워 두면 주당 건수에 맞춰 고르게 고릅니다. 주당 건수보다 많이 고르면 그중 고르게 씁니다.">
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAY_LABEL.map((d, i) => (
                    <label key={d} className="cursor-pointer rounded-lg border border-ink-200 px-2.5 py-1.5 text-[12.5px] font-bold has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                      <input type="checkbox" name="day" value={i} defaultChecked={setting.days.includes(i)} className="sr-only" />{d}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="만들 형식 (돌아가며)">
                <div className="flex flex-wrap gap-1.5">
                  {CONTENT_KINDS.map((k) => (
                    <label key={k} className="cursor-pointer rounded-lg border border-ink-200 px-2.5 py-1.5 text-[12.5px] font-bold has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                      <input type="checkbox" name="calendarKind" value={k} defaultChecked={calendarKinds.includes(k)} className="sr-only" />{CONTENT_KIND_SHORT[k]}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="자동 게시 플랫폼" hint="연결된 채널 중 형식을 올릴 수 있는 곳에만 예약합니다.">
                <div className="flex flex-wrap gap-1.5">
                  {PLATFORMS.map((p) => (
                    <label key={p} className="cursor-pointer rounded-lg border border-ink-200 px-2.5 py-1.5 text-[12.5px] font-bold has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                      <input type="checkbox" name="calendarPlatform" value={p} defaultChecked={setting.platforms.includes(p)} className="sr-only" />{PLATFORM_LABEL[p]}
                    </label>
                  ))}
                </div>
              </Field>
              <input type="hidden" name="abTestField" value="1" />
              <Checkbox name="abTestEnabled" defaultChecked={setting.abTestEnabled} label="2안 비교(A/B)" description="슬롯마다 캡션만 다른 B안을 함께 만듭니다(추가 비용 없음, 월 생성 건수에는 들어갑니다). 두 안을 모두 승인하면 두 플랫폼이나 두 시각에 나눠 게시하고 클릭으로 비교합니다. 한쪽만 승인하면 그 안만 게시합니다." />
              <Checkbox name="autoSchedule" defaultChecked={setting.autoSchedule} label="승인되면 슬롯 시각으로 자동 예약" description="담당자가 승인하는 순간 슬롯 시각으로 예약합니다(슬롯이 아직 미래일 때). 슬롯 시각이 지난 뒤 승인하면 다음 빈 슬롯 · 지금 · 승인만 중에서 고릅니다. SNS 자동 게시가 열려 있어야 합니다." />
            </div>
          </ActionForm></div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">다음 4주 캘린더</h2>
          {setting.calendarEnabled && blockers.length ? (
            <div className="mt-3 space-y-2">{blockers.map((b) => <Notice key={b.code} tone="warning" title="캘린더가 만들지 않는 이유">{b.message}</Notice>)}</div>
          ) : null}
          {!setting.calendarEnabled ? <p className="mt-2 text-[13px] text-ink-400">캘린더가 꺼져 있습니다. 켜면 아래 시각마다 만듭니다 (미리보기).</p> : null}
          <p className="mt-2 text-[12px] text-ink-400">요일 {[...usedDays].map((d) => WEEKDAY_LABEL[d]).join('·')} · {String(setting.postHour).padStart(2, '0')}:00 · 생성은 슬롯 7일 전부터 1시간마다 한 건씩</p>
          {preview.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-400">다가오는 슬롯이 없습니다.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-100">
              {preview.map((p) => (
                <li key={p.at.toISOString()} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
                  <span className="font-bold text-ink-900">{p.label} <Badge className="ml-1">{CONTENT_KIND_SHORT[p.kind]}</Badge></span>
                  <span className="text-[12px] text-ink-500">
                    {p.slot?.itemId ? <Link href={`/studio/content/${p.slot.itemId}`} className="font-bold text-brand-700">{CONTENT_STATUS_LABEL[p.slot.status] ?? (p.slot.status === 'SCHEDULED' ? '게시 예약' : p.slot.status)}</Link> : p.slot ? (p.slot.status === 'FAILED' ? '생성 실패' : '만드는 중') : p.withinLookahead ? '곧 생성' : '예정'}
                    {p.slot?.note ? <span className="ml-2 text-ink-400">{p.slot.note}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">콘텐츠 성과 요약 (최근 30일)</h2>
          {insight ? (
            <div className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-700">
              <p className="whitespace-pre-wrap">{insight.summary}</p>
              <ul className="list-disc space-y-1 pl-5 text-ink-600">{insight.suggestions.map((x, i) => <li key={i}>{x}</li>)}</ul>
              <p className="text-[11.5px] text-ink-400">AI 생성 요약 · {insight.dayKey} 기준. 숫자는 콘텐츠 전환 기록에서 나왔습니다.</p>
            </div>
          ) : <p className="mt-2 text-[13px] text-ink-400">아직 만든 요약이 없습니다.</p>}
          <div className="mt-3">
            {ai.available ? (
              insightToday ? <p className="text-[12px] text-ink-400">요약은 하루 한 번 만듭니다.</p> : (
                <ActionForm action={contentInsightFormAction} submitLabel="오늘 요약 만들기" variant="secondary" size="sm" pendingLabel="만드는 중" />
              )
            ) : <p className="text-[12px] text-ink-400">{ai.message}</p>}
          </div>
        </Card>
      </div>

      <div className="mt-6 mb-3 flex flex-wrap gap-2">
        {[undefined, 'REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'ARCHIVED'].map((s) => (
          <Link key={s ?? 'all'} href={s ? `/studio/content?status=${s}` : '/studio/content'} className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold ${filter === s ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600'}`}>
            {s ? CONTENT_STATUS_LABEL[s] : '전체'}
          </Link>
        ))}
      </div>
      {items.length === 0 ? (
        <EmptyState title="아직 만든 콘텐츠가 없습니다" />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {items.map((it) => {
            const cv = conv.get(it.id)!;
            return (
              <Link key={it.id} href={`/studio/content/${it.id}`} className="card block p-3 transition hover:-translate-y-0.5">
                <SvgThumb svg={it.coverSvg} format={kindFormat(it.kind)} className="w-full" />
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge tone={STATUS_TONE[it.status]}>{CONTENT_STATUS_LABEL[it.status]}</Badge>
                  <Badge>{CONTENT_KIND_SHORT[it.kind]}</Badge>
                  {it.createdBy === 'CALENDAR' ? <Badge tone="brand">캘린더</Badge> : null}
                  {it.status === 'REVIEW' && isPastSlot(slotAtBy.get(it.id)) ? <Badge tone="danger">게시 시각 지남</Badge> : null}
                </div>
                <p className="mt-1.5 line-clamp-2 text-[12.5px] font-bold text-ink-900">{it.campaignId ? campaignTitle.get(it.campaignId) ?? it.title : it.title}</p>
                <p className="mt-0.5 text-[11px] text-ink-400">{formatKst(it.createdAt, false)}</p>
                {cv.donations || cv.pledges || cv.volunteers ? <p className="mt-1 text-[11.5px] font-bold text-brand-700">후원 {cv.donations} · 약정 {cv.pledges} · 봉사 {cv.volunteers}</p> : null}
                {it.publishes.length ? <p className="mt-0.5 text-[11px] text-ink-500">{it.publishes.map((p) => PLATFORM_LABEL[p.platform]).join(' · ')}</p> : null}
              </Link>
            );
          })}
        </div>
      )}
      {env.automation.socialPublishEnabled ? null : <p className="mt-4 text-[12px] text-ink-400">SNS 자동 게시가 아직 열리지 않았습니다(플랫폼 심사 전). 승인된 콘텐츠는 상세 화면에서 내려받아 직접 올려 주세요.</p>}
    </>
  );
}
