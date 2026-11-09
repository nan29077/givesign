import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { env, featureContentEnabled } from '@/lib/env';
import { Badge, Card, Field, Input, Notice, StatTile, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { ScenePlayer } from '@/components/content/scene-player';
import { formatKst, kstDateKey } from '@/lib/datetime';
import { formatWon } from '@/lib/money';
import { PLATFORM_KINDS, PLATFORM_LABEL, PLATFORMS, snsIsMock } from '@/server/adapters/sns';
import { kindFormat } from '@/server/adapters/content';
import { CONTENT_KIND_LABEL, CONTENT_STATUS_LABEL, PUBLISH_STATUS_LABEL, contentConversions, renderCaption, type Scene } from '@/server/services/content';
import {
  approveContentAction,
  archiveContentAction,
  cancelPublishAction,
  makeYoutubePublicAction,
  regenerateContentAction,
  resolveUnknownPublishAction,
  schedulePublishAction,
  updateContentAction,
} from '@/app/actions/automation';

export const dynamic = 'force-dynamic';

/** 게시 예약 기본값: 지금부터 10분 뒤 (KST, datetime-local 형식) */
function defaultScheduleValue() {
  return new Date(Date.now() + 9 * 3600_000 + 10 * 60_000).toISOString().slice(0, 16);
}

export default async function StudioContentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!featureContentEnabled()) notFound();
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const item = await prisma.contentItem.findFirst({ where: { id, merchantId }, include: { publishes: { orderBy: { createdAt: 'asc' } }, jobs: true } });
  if (!item) notFound();
  const [channels, conv, campaign, previewCaption] = await Promise.all([
    // 실연동이면 mock 시절 연결은 게시 대상이 아니다(content.ts publishableChannelWhere 와 같은 기준).
    prisma.socialChannel.findMany({ where: { merchantId, status: 'CONNECTED', mock: snsIsMock() } }),
    contentConversions(merchantId, [item.id]),
    item.campaignId ? prisma.campaign.findUnique({ where: { id: item.campaignId }, select: { title: true, code: true } }) : null,
    renderCaption(item, 'INSTAGRAM'),
  ]);
  const cv = conv.get(item.id)!;
  const scenes = (item.scenes as unknown as Scene[]) ?? [];
  const format = kindFormat(item.kind);
  const slot = await prisma.contentSlot.findFirst({ where: { merchantId, itemId: item.id } });
  const editable = item.status === 'REVIEW' || item.status === 'APPROVED';
  const canPublish = ['APPROVED', 'SCHEDULED', 'PUBLISHED'].includes(item.status);
  const voice = item.jobs.find((j) => j.step === 'VOICE')?.output as { available?: boolean; note?: string } | undefined;
  const assemble = item.jobs.find((j) => j.step === 'ASSEMBLE')?.output as { available?: boolean; note?: string } | undefined;
  const connected = new Set(channels.map((c) => c.platform));
  const platforms = PLATFORMS;
  const captionTargets = PLATFORMS.filter((p) => PLATFORM_KINDS[p].includes(item.kind));
  const now = defaultScheduleValue();
  const dl = (q: string) => `/api/studio/content/${item.id}/asset?${q}`;

  return (
    <div className="space-y-4">
      <Link href="/studio/content" className="text-[13px] font-bold text-ink-500">← 콘텐츠 만들기</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-black text-ink-900">{item.title}</h1>
          <p className="mt-1 text-[13px] text-ink-500">
            {CONTENT_KIND_LABEL[item.kind]} · {campaign ? `${campaign.title} (${campaign.code})` : '캠페인 없음'} · {formatKst(item.createdAt, false)} · 공급자 {item.provider}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone={item.status === 'REVIEW' ? 'warning' : item.status === 'PUBLISHED' ? 'success' : 'brand'}>{CONTENT_STATUS_LABEL[item.status]}</Badge>
            <Badge tone={item.aiLabeled ? 'success' : 'danger'}>{item.aiLabeled ? 'AI 생성 표시 포함' : 'AI 생성 표시 없음 — 승인 불가'}</Badge>
            <Badge tone={item.regNoIncluded ? 'success' : 'danger'}>{item.regNoIncluded ? '모집등록번호 포함' : '모집등록번호 없음 — 승인 불가'}</Badge>
            {item.approvedAt ? <Badge>승인 {formatKst(item.approvedAt, false)}{item.approvedBy === 'AUTO' ? ' (자동)' : ''}</Badge> : null}
            {slot ? <Badge tone="brand">캘린더 슬롯 {formatKst(slot.slotAt, false)}{slot.note ? ` · ${slot.note}` : ''}</Badge> : null}
          </div>
        </div>
      </div>
      {item.status === 'FAILED' ? <Notice tone="danger" title="생성 실패">{item.error ?? '알 수 없는 오류'}</Notice> : null}
      {item.status === 'REVIEW' && item.error ? <Notice tone="warning" title="자동 승인하지 않음">{item.error} — 내용을 확인하고 고친 뒤 승인해 주세요.</Notice> : null}

      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile label="이 콘텐츠로 들어온 후원" value={`${cv.donations}건`} sub={formatWon(cv.amount)} tone="brand" />
        <StatTile label="정기 약정" value={`${cv.pledges}건`} />
        <StatTile label="자원봉사 신청" value={`${cv.volunteers}건`} />
        <StatTile label="생성 비용" value={formatWon(BigInt(item.costKrw))} sub={item.provider === 'mock' ? 'mock (과금 없음)' : undefined} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <Card>
          {item.kind === 'SHORTFORM' && item.videoUrl ? (
            <div>
              <p className="mb-1.5 text-[12.5px] font-bold text-ink-700">조립된 영상 (9:16 mp4)</p>
              <video src={item.videoUrl} controls preload="metadata" className="mx-auto aspect-[9/16] w-full max-w-[300px] rounded-2xl bg-ink-900" />
            </div>
          ) : item.kind === 'SHORTFORM' ? <Notice tone="warning" title="영상 파일이 아직 없습니다">아래 장면은 영상 제작용 미리보기입니다. 영상 생성 상태를 확인한 뒤 다시 만들어 주세요.</Notice> : null}
          {item.kind === 'SHORTFORM' ? <details className="mt-4"><summary className="cursor-pointer text-sm font-bold text-ink-700">영상 장면·자막 보기</summary><div className="mt-3"><ScenePlayer scenes={scenes} format={format} /></div></details> : <ScenePlayer scenes={scenes} format={format} />}
          <div className="mt-4 space-y-1.5 text-[12.5px]">
            {item.kind === 'SHORTFORM' ? (
              <>
                {voice && !voice.available ? <p className="text-ink-500">{voice.note}</p> : null}
                {assemble && !assemble.available ? <p className="text-ink-500">{assemble.note}</p> : null}
                {assemble?.available && assemble.note ? <p className="text-ink-500">{assemble.note}</p> : null}
              </>
            ) : null}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-[12.5px] font-bold">
            <a className="rounded-xl border border-ink-200 px-3 py-2 text-center" href={dl('cover=1')}>표지 SVG</a>
            <a className="rounded-xl border border-ink-200 px-3 py-2 text-center" href={dl('cover=1&format=png')}>표지 PNG</a>
            {item.kind === 'SHORTFORM' ? <a className="rounded-xl border border-ink-200 px-3 py-2 text-center" href={dl('script=1')}>자막 SRT</a> : null}
            {item.videoUrl ? <a className="rounded-xl border border-ink-200 px-3 py-2 text-center" href={item.videoUrl} download>영상 MP4</a> : null}
            {scenes.map((s, i) => <a key={i} className="rounded-xl border border-ink-200 px-3 py-2 text-center" href={dl(`scene=${i}&format=png`)}>{item.kind === 'CARD_NEWS' ? `카드 ${i + 1}${s.label ? ` · ${s.label}` : ''}` : `장면 ${i + 1}`} PNG</a>)}
            {[...captionTargets, 'QR' as const].map((p) => <a key={p} className="rounded-xl border border-ink-200 px-3 py-2 text-center" href={dl(`caption=${p}`)}>캡션 · {p === 'QR' ? 'QR·기타' : PLATFORM_LABEL[p]}</a>)}
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <h2 className="text-[16px] font-black text-ink-900">대본·캡션 검토</h2>
            {editable ? (
              <div className="mt-3"><ActionForm action={updateContentAction} submitLabel="고친 내용으로 다시 그리기" variant="secondary">
                <input type="hidden" name="id" value={item.id} />
                {scenes.map((s, i) => (
                  <Field key={i} label={`장면 ${i + 1} 자막 (${s.durationSec}초)`}><Input name="scene" defaultValue={s.caption} maxLength={120} /></Field>
                ))}
                <Field label="게시물 캡션" hint="{링크} 는 게시할 때 플랫폼별 유입 경로가 붙은 후원 주소로 바뀝니다. “AI 생성 콘텐츠” 표시는 지울 수 없습니다. 캡션을 고치면 플랫폼별 캡션(길이·해시태그 수 규칙)은 고친 캡션에서 다시 만듭니다.">
                  <Textarea name="caption" rows={9} defaultValue={item.caption ?? ''} maxLength={2000} />
                </Field>
              </ActionForm></div>
            ) : (
              <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-ink-50 p-3 font-sans text-[13px] leading-relaxed text-ink-700">{previewCaption}</pre>
            )}
          </Card>

          <Card>
            <h2 className="text-[16px] font-black text-ink-900">승인</h2>
            <p className="mt-1.5 text-[13px] text-ink-500">기관 명의로 나가는 게시물입니다. 사실과 다른 내용·수혜자를 특정할 수 있는 표현이 없는지 확인해 주세요.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {item.status === 'REVIEW' ? (
                <ActionForm action={approveContentAction} submitLabel="승인" confirmMessage="이 콘텐츠를 기관 명의 게시물로 승인합니다.">
                  <input type="hidden" name="id" value={item.id} />
                </ActionForm>
              ) : null}
              <ActionForm action={regenerateContentAction} submitLabel="새로 만들기" variant="secondary" pendingLabel="만드는 중">
                <input type="hidden" name="id" value={item.id} />
              </ActionForm>
              {item.status !== 'ARCHIVED' ? (
                <ActionForm action={archiveContentAction} submitLabel="보관" variant="ghost" confirmMessage="보관하면 예약된 게시도 취소됩니다.">
                  <input type="hidden" name="id" value={item.id} />
                </ActionForm>
              ) : null}
            </div>
          </Card>

          <Card>
            <h2 className="text-[16px] font-black text-ink-900">SNS 게시</h2>
            {!env.automation.socialPublishEnabled ? (
              <div className="mt-3"><Notice tone="neutral" title="자동 게시 준비 중">유튜브 API 감사·메타 앱 검수가 끝나면 열립니다. 지금은 왼쪽에서 장면·캡션을 내려받아 직접 올려 주세요. 캡션 링크에 유입 경로가 들어 있어 후원 전환은 그대로 집계됩니다.</Notice></div>
            ) : (
              <>
                {snsIsMock() ? <div className="mt-3"><Notice tone="warning" title="SNS 게시 mock">플랫폼 실연동 전입니다. 예약·게시 흐름은 동작하지만 실제로 올라가지 않으며 조회수 같은 지표도 없습니다.</Notice></div> : null}
                {canPublish ? (
                  <div className="mt-3"><ActionForm action={schedulePublishAction} submitLabel="게시 예약">
                    <input type="hidden" name="id" value={item.id} />
                    <div className="flex flex-wrap gap-2">
                      {platforms.map((p) => {
                        const noVideo = item.kind === 'SHORTFORM' && !item.videoUrl;
                        const ok = connected.has(p) && PLATFORM_KINDS[p].includes(item.kind) && !noVideo;
                        return (
                          <label key={p} className={`rounded-xl border px-3 py-2 text-[13px] font-bold ${ok ? 'cursor-pointer border-ink-200 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50' : 'border-ink-100 text-ink-300'}`}>
                            <input type="checkbox" name="platform" value={p} disabled={!ok} className="sr-only" />
                            {PLATFORM_LABEL[p]}{!connected.has(p) ? ' (미연결)' : !PLATFORM_KINDS[p].includes(item.kind) ? ' (형식 불가)' : noVideo ? ' (영상 없음)' : ''}
                          </label>
                        );
                      })}
                    </div>
                    <Field label="게시 시각 (KST)" hint="지금보다 이전이면 다음 배치(1시간 안)에 바로 올립니다. 인스타그램은 24시간에 50건까지입니다."><Input type="datetime-local" name="at" defaultValue={now} min={`${kstDateKey()}T00:00`} /></Field>
                  </ActionForm></div>
                ) : <p className="mt-2 text-[13px] text-ink-400">승인된 뒤에 예약할 수 있습니다.</p>}
              </>
            )}
            {item.publishes.length ? (
              <ul className="mt-4 divide-y divide-ink-100">
                {item.publishes.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                    <span>
                      <b>{PLATFORM_LABEL[p.platform]}</b> <Badge tone={p.status === 'PUBLISHED' ? 'success' : p.status === 'FAILED' ? 'danger' : p.status === 'UNKNOWN' ? 'warning' : 'neutral'} className="ml-1">{PUBLISH_STATUS_LABEL[p.status] ?? p.status}</Badge>
                      {p.mock ? <Badge tone="warning" className="ml-1">mock — 실제 게시 안 됨</Badge> : null}
                      <span className="ml-2 text-ink-400">{p.publishedAt ? `게시 ${formatKst(p.publishedAt, false)}` : `예약 ${formatKst(p.scheduledAt, false)}`}</span>
                      {p.error ? <span className="ml-2 text-danger-500">{p.error}</span> : null}
                    </span>
                    <span className="flex items-center gap-3">
                      {p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="font-bold text-brand-700">게시물</a> : null}
                      {!p.mock && p.metricsAt ? <span className="tabular-nums text-ink-500">조회 {p.views} · 좋아요 {p.likes}</span> : null}
                      {/* 링크 클릭은 기브싸인 짧은 링크(/go)로 직접 센 값이다(봇·같은 IP 10분 중복 제외). */}
                      <span className="tabular-nums text-ink-500">링크 클릭 {p.clicks}</span>
                      {p.platform === 'YOUTUBE' && p.status === 'PRIVATE_UPLOADED' && !p.mock ? (
                        <ActionForm action={makeYoutubePublicAction} submitLabel="공개로 전환" size="sm" confirmMessage="유튜브 영상을 공개로 바꿉니다. 영상 내용을 유튜브에서 먼저 확인해 주세요.">
                          <input type="hidden" name="id" value={item.id} />
                          <input type="hidden" name="publishId" value={p.id} />
                        </ActionForm>
                      ) : null}
                      {p.status === 'UNKNOWN' ? (
                        <>
                          <ActionForm action={resolveUnknownPublishAction} submitLabel="다시 게시" variant="secondary" size="sm" confirmMessage="채널에 이미 올라가 있지 않은지 먼저 확인해 주세요. 올라가 있다면 두 번 게시됩니다.">
                            <input type="hidden" name="id" value={item.id} />
                            <input type="hidden" name="publishId" value={p.id} />
                            <input type="hidden" name="intent" value="republish" />
                          </ActionForm>
                          <ActionForm action={resolveUnknownPublishAction} submitLabel="게시됨으로 표시" variant="ghost" size="sm">
                            <input type="hidden" name="id" value={item.id} />
                            <input type="hidden" name="publishId" value={p.id} />
                            <input type="hidden" name="intent" value="mark" />
                            <Input name="url" placeholder="게시물 주소(선택, https://)" className="h-8 w-48 text-[12px]" />
                          </ActionForm>
                        </>
                      ) : null}
                      {p.status === 'SCHEDULED' ? (
                        <ActionForm action={cancelPublishAction} submitLabel="취소" variant="ghost" size="sm">
                          <input type="hidden" name="id" value={item.id} />
                          <input type="hidden" name="publishId" value={p.id} />
                        </ActionForm>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
