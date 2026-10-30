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
import { CONTENT_KIND_LABEL, CONTENT_STATUS_LABEL, contentConversions, getContentSetting, monthlyUsage } from '@/server/services/content';
import { requestContentAction, saveContentSettingAction } from '@/app/actions/automation';

export const dynamic = 'force-dynamic';

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
  const filter = sp.status && CONTENT_STATUS_LABEL[sp.status] ? sp.status : undefined;
  const [merchant, campaigns, items, setting, usage, counts] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { fundraisingRegNo: true } }),
    prisma.campaign.findMany({ where: { merchantId, status: { in: ['ACTIVE', 'DRAFT'] } }, orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }] }),
    prisma.contentItem.findMany({ where: { merchantId, status: filter ? (filter as never) : { not: 'ARCHIVED' } }, orderBy: { createdAt: 'desc' }, take: 60, include: { publishes: true } }),
    getContentSetting(merchantId),
    monthlyUsage(merchantId),
    prisma.contentItem.groupBy({ by: ['status'], where: { merchantId }, _count: { _all: true } }),
  ]);
  const conv = await contentConversions(merchantId, items.map((i) => i.id));
  const c = (s: string) => counts.find((x) => x.status === s)?._count._all ?? 0;
  const totalConv = [...conv.values()].reduce((a, v) => ({ donations: a.donations + v.donations, amount: a.amount + v.amount, pledges: a.pledges + v.pledges, volunteers: a.volunteers + v.volunteers }), { donations: 0, amount: 0n, pledges: 0, volunteers: 0 });
  const mock = getContentAdapter().info().mode === 'mock';
  const campaignTitle = new Map(campaigns.map((x) => [x.id, x.title]));

  return (
    <>
      <PageHeader
        title="콘텐츠 만들기"
        description="캠페인 이야기로 숏폼(9:16)과 캠페인 이미지를 자동으로 만듭니다. 기관 명의로 나가는 게시물이라 담당자가 검토·승인한 뒤 게시합니다."
        action={<LinkButton href="/studio/channels" variant="secondary" size="sm">SNS 채널 연결</LinkButton>}
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
                  {(['SHORTFORM', 'IMAGE_SQUARE', 'IMAGE_STORY'] as const).map((k, idx) => (
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
            <Checkbox name="autoApprove" defaultChecked={setting.autoApprove} label="자동 승인" description="켜면 생성 직후 승인까지 진행합니다(모집등록번호가 있을 때만). 기본은 담당자 승인입니다." />
          </ActionForm></div>
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
                <SvgThumb svg={it.coverSvg} format={it.kind === 'IMAGE_SQUARE' ? 'SQUARE' : 'STORY'} className="w-full" />
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge tone={STATUS_TONE[it.status]}>{CONTENT_STATUS_LABEL[it.status]}</Badge>
                  <Badge>{it.kind === 'SHORTFORM' ? '숏폼' : it.kind === 'IMAGE_SQUARE' ? '정사각' : '스토리'}</Badge>
                </div>
                <p className="mt-1.5 line-clamp-2 text-[12.5px] font-bold text-ink-900">{it.campaignId ? campaignTitle.get(it.campaignId) ?? it.title : it.title}</p>
                <p className="mt-0.5 text-[11px] text-ink-400">{formatKst(it.createdAt, false)}</p>
                {cv.donations || cv.pledges || cv.volunteers ? <p className="mt-1 text-[11.5px] font-bold text-brand-700">후원 {cv.donations} · 약정 {cv.pledges} · 봉사 {cv.volunteers}</p> : null}
                {it.publishes.length ? <p className="mt-0.5 text-[11px] text-ink-500">{it.publishes.map((p) => p.platform === 'YOUTUBE' ? '유튜브' : p.platform === 'INSTAGRAM' ? '인스타' : '페북').join(' · ')}</p> : null}
              </Link>
            );
          })}
        </div>
      )}
      {env.automation.socialPublishEnabled ? null : <p className="mt-4 text-[12px] text-ink-400">SNS 자동 게시가 아직 열리지 않았습니다(플랫폼 심사 전). 승인된 콘텐츠는 상세 화면에서 내려받아 직접 올려 주세요.</p>}
    </>
  );
}
