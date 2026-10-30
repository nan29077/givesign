import { env, featureContentEnabled } from '@/lib/env';
import { decrypt, encrypt } from '@/lib/crypto';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { kstMonthKey } from '@/lib/datetime';
import { attributionQuery } from '@/lib/attribution';
import { prisma } from '@/server/db';
import { PAID_STATUSES } from '@/components/studio/shared';
import {
  getContentAdapter,
  renderSceneSvg,
  type ContentBrief,
  type Tone,
} from '@/server/adapters/content';
import { getSnsAdapter, PLATFORM_KINDS, PLATFORM_SRC } from '@/server/adapters/sns';
import type { ContentKind, SocialPlatform } from '@/generated/prisma/enums';
import { campaignStats } from './fundraising';
import { monthRange } from './monthly-notice';

/**
 * 콘텐츠 자동 생성 → 검토 → 승인 → (SNS 게시) 파이프라인.
 *
 * 단계: SCRIPT(대본) → SCENES(장면 이미지) → VOICE(음성) → ASSEMBLE(영상 조립) → COVER(표지)
 *  - (콘텐츠, 단계) 당 작업 기록 1행. 이미 끝난 단계는 다시 돌리지 않는다 — 같은 단계를 두 번 과금하지 않는다.
 *  - 모든 산출물에 "AI 생성 콘텐츠" 표시, 기관에 모집등록번호가 있으면 함께 넣는다.
 *  - 모집등록번호가 없으면 생성·내려받기는 되지만 승인(=기관 명의 게시)은 막는다(기부금품법 모집 표시).
 *  - 기관 명의로 나가는 게시물이라 기본은 승인제. 기관이 '자동 승인'을 켜면 생성 직후 승인까지 진행한다.
 *  - 게시는 (콘텐츠, 플랫폼) 당 1회. 예약 시각이 되면 배치가 올린다. SOCIAL_PUBLISH_ENABLED 가 꺼져 있으면 예약을 받지 않는다.
 */

export class ContentError extends Error {}

export const CONTENT_KIND_LABEL: Record<ContentKind, string> = {
  SHORTFORM: '숏폼 (9:16 · 30~60초)',
  IMAGE_SQUARE: '캠페인 이미지 (정사각)',
  IMAGE_STORY: '캠페인 이미지 (스토리 9:16)',
};

export const CONTENT_STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성 중',
  GENERATING: '생성 중',
  REVIEW: '검토 대기',
  APPROVED: '승인됨',
  SCHEDULED: '게시 예약',
  PUBLISHED: '게시됨',
  FAILED: '생성 실패',
  ARCHIVED: '보관',
};

export const PUBLISH_STATUS_LABEL: Record<string, string> = {
  SCHEDULED: '예약',
  PUBLISHING: '게시 중',
  PUBLISHED: '게시됨',
  PRIVATE_UPLOADED: '비공개 업로드(공개 전환 필요)',
  FAILED: '실패',
  CANCELED: '취소',
};

const TONES: Tone[] = ['WARM', 'HOPEFUL', 'CALM', 'URGENT'];
type Step = 'SCRIPT' | 'SCENES' | 'VOICE' | 'ASSEMBLE' | 'COVER';
const INSTAGRAM_DAILY_LIMIT = 50;
const PUBLISH_MAX_ATTEMPTS = 3;

export interface Scene {
  caption: string;
  durationSec: number;
  svg: string;
}

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

export async function getContentSetting(merchantId: string) {
  const row = await prisma.merchantContentSetting.findUnique({ where: { merchantId } });
  return row ?? { merchantId, tone: 'WARM', bannedWords: [] as string[], autoApprove: false, monthlyLimit: 30, hashtags: [] as string[], updatedAt: new Date(0) };
}

export async function saveContentSetting(
  merchantId: string,
  input: { tone: string; bannedWords: string[]; autoApprove: boolean; monthlyLimit?: number; hashtags: string[] },
) {
  const tone = TONES.includes(input.tone as Tone) ? input.tone : 'WARM';
  const banned = input.bannedWords.map((w) => w.trim()).filter(Boolean).slice(0, 50);
  const tags = input.hashtags.map((t) => t.replace(/^#/, '').trim()).filter((t) => /^[\p{L}\p{N}_]{1,30}$/u.test(t)).slice(0, 10);
  const data = { tone, bannedWords: banned, autoApprove: input.autoApprove, hashtags: tags };
  return prisma.merchantContentSetting.upsert({
    where: { merchantId },
    create: { merchantId, ...data },
    update: data,
  });
}

export async function monthlyUsage(merchantId: string, now = new Date()) {
  const { start, end } = monthRange(kstMonthKey(now));
  const [count, cost] = await Promise.all([
    prisma.contentItem.count({ where: { merchantId, createdAt: { gte: start, lt: end } } }),
    prisma.contentItem.aggregate({ where: { merchantId, createdAt: { gte: start, lt: end } }, _sum: { costKrw: true } }),
  ]);
  return { count, costKrw: cost._sum.costKrw ?? 0 };
}

// ---------------------------------------------------------------------------
// 생성
// ---------------------------------------------------------------------------

async function moRoute(merchantId: string) {
  const r = await prisma.merchantMoNumber.findFirst({
    where: { merchantId, status: 'ASSIGNED' },
    orderBy: { assignedAt: 'desc' },
    select: { phoneNumber: true, mode: true, keyword: true },
  });
  return r;
}

function formatMo(n: string) {
  const d = n.replace(/\D/g, '');
  if (d.length === 12) return `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8)}`;
  if (d.length === 11) return `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4)}`;
  return n;
}

function aiFooter(regNo: string | null) {
  return regNo ? `AI 생성 콘텐츠 · 기부금품 모집등록 ${regNo}` : 'AI 생성 콘텐츠';
}

export async function requestContent(input: { merchantId: string; campaignId: string; kind: ContentKind; userId: string; tone?: string }) {
  if (!featureContentEnabled()) throw new ContentError('콘텐츠 자동 생성을 사용하지 않는 중입니다.');
  const campaign = await prisma.campaign.findFirst({ where: { id: input.campaignId, merchantId: input.merchantId } });
  if (!campaign) throw new ContentError('캠페인을 찾을 수 없습니다.');
  if (campaign.status === 'ARCHIVED') throw new ContentError('보관된 캠페인으로는 만들 수 없습니다.');
  const setting = await getContentSetting(input.merchantId);
  const usage = await monthlyUsage(input.merchantId);
  if (usage.count >= setting.monthlyLimit) throw new ContentError(`이번 달 생성 한도(${setting.monthlyLimit}건)를 모두 썼습니다.`);

  const item = await prisma.contentItem.create({
    data: {
      id: newId(),
      merchantId: input.merchantId,
      campaignId: campaign.id,
      kind: input.kind,
      status: 'GENERATING',
      title: campaign.title,
      provider: getContentAdapter().info().provider,
      createdBy: input.userId,
    },
  });
  await runContentPipeline(item.id, input.tone && TONES.includes(input.tone as Tone) ? (input.tone as Tone) : undefined);
  return prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
}

async function jobDone(itemId: string, step: Step) {
  const j = await prisma.contentJob.findUnique({ where: { itemId_step: { itemId, step } } });
  return j?.status === 'DONE' ? j : null;
}

async function recordJob(itemId: string, step: Step, provider: string, status: 'DONE' | 'FAILED', output: object | null, costKrw = 0, error?: string) {
  await prisma.contentJob.upsert({
    where: { itemId_step: { itemId, step } },
    create: { id: newId(), itemId, step, status, provider, costKrw, output: output ?? undefined, error: error ?? null },
    update: { status, provider, costKrw, output: output ?? undefined, error: error ?? null },
  });
}

export async function buildBrief(merchantId: string, campaignId: string, toneOverride?: Tone): Promise<{ brief: ContentBrief; color: string }> {
  const [merchant, campaign, page, setting, route] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { displayName: true, fundraisingRegNo: true } }),
    prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
    prisma.merchantDonationPage.findUnique({ where: { merchantId }, select: { color: true } }),
    getContentSetting(merchantId),
    moRoute(merchantId),
  ]);
  const stats = (await campaignStats([campaign.id])).get(campaign.id);
  const daysLeft = Math.max(0, Math.ceil((campaign.endsOn.getTime() - Date.now()) / 86_400_000));
  const color = page?.color ?? '#28634e';
  const prefix = route?.mode === 'SHARED_PREFIX' && route.keyword ? `${route.keyword} ` : '';
  return {
    color,
    brief: {
      merchantName: merchant.displayName,
      campaignTitle: campaign.title,
      summary: campaign.summary,
      story: campaign.story,
      beneficiary: campaign.beneficiary,
      usagePlan: campaign.usagePlan,
      goalAmount: campaign.goalAmount,
      raisedAmount: stats?.raised ?? 0n,
      daysLeft: campaign.status === 'ACTIVE' ? daysLeft : null,
      keyword: `${prefix}${campaign.code}`,
      moNumber: route ? formatMo(route.phoneNumber) : null,
      tone: toneOverride ?? ((TONES.includes(setting.tone as Tone) ? setting.tone : 'WARM') as Tone),
      color,
      regNo: merchant.fundraisingRegNo ?? null,
      bannedWords: setting.bannedWords,
    },
  };
}

function renderScenes(captions: Array<{ caption: string; durationSec: number }>, kind: ContentKind, merchantName: string, color: string, regNo: string | null): Scene[] {
  const format = kind === 'IMAGE_SQUARE' ? 'SQUARE' : 'STORY';
  return captions.map((s, i) => ({
    caption: s.caption,
    durationSec: s.durationSec,
    svg: renderSceneSvg({ caption: s.caption, index: i, total: captions.length, merchantName, color, footer: aiFooter(regNo), format }),
  }));
}

/** 생성 단계를 순서대로 돌린다. 끝난 단계는 건너뛴다(재시작 안전). */
export async function runContentPipeline(itemId: string, toneOverride?: Tone) {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: itemId } });
  if (!item.campaignId) throw new ContentError('캠페인이 없는 콘텐츠입니다.');
  const adapter = getContentAdapter();
  const provider = adapter.info().provider;
  try {
    const { brief, color } = await buildBrief(item.merchantId, item.campaignId, toneOverride);
    const kind = item.kind;
    let cost = 0;

    let script = (await jobDone(itemId, 'SCRIPT'))?.output as { title: string; script: string; scenes: Array<{ caption: string; durationSec: number }>; hashtags: string[] } | null;
    if (!script) {
      const r = await adapter.script(brief, kind);
      script = r.data;
      cost += r.costKrw;
      await recordJob(itemId, 'SCRIPT', provider, 'DONE', script, r.costKrw);
    }

    let scenes: Scene[] | null = (await jobDone(itemId, 'SCENES')) ? (item.scenes as unknown as Scene[]) : null;
    if (!scenes || scenes.length === 0) {
      scenes = renderScenes(script.scenes, kind, brief.merchantName, color, brief.regNo);
      await recordJob(itemId, 'SCENES', 'givesign-svg', 'DONE', { count: scenes.length });
    }

    if (kind === 'SHORTFORM') {
      if (!(await jobDone(itemId, 'VOICE'))) {
        const v = await adapter.voice(script.script);
        cost += v.costKrw;
        await recordJob(itemId, 'VOICE', provider, 'DONE', v, v.costKrw);
      }
      if (!(await jobDone(itemId, 'ASSEMBLE'))) {
        const a = await adapter.assemble(scenes.length);
        cost += a.costKrw;
        await recordJob(itemId, 'ASSEMBLE', provider, 'DONE', a, a.costKrw);
      }
    }
    if (!(await jobDone(itemId, 'COVER'))) await recordJob(itemId, 'COVER', 'givesign-svg', 'DONE', { from: 'scene-2' });

    const setting = await getContentSetting(item.merchantId);
    const tags = [...new Set([...script.hashtags, ...setting.hashtags])].slice(0, 12);
    const regNoIncluded = Boolean(brief.regNo);
    const caption = buildCaptionTemplate({ summary: brief.summary, campaignTitle: brief.campaignTitle, moNumber: brief.moNumber, keyword: brief.keyword, regNo: brief.regNo, tags });
    const autoApprove = setting.autoApprove && regNoIncluded;
    await prisma.contentItem.update({
      where: { id: itemId },
      data: {
        title: script.title,
        script: script.script,
        scenes: scenes as unknown as object,
        hashtags: tags,
        caption,
        coverSvg: scenes[Math.min(1, scenes.length - 1)]!.svg,
        aiLabeled: true,
        regNoIncluded,
        costKrw: { increment: cost },
        status: autoApprove ? 'APPROVED' : 'REVIEW',
        approvedBy: autoApprove ? 'AUTO' : null,
        approvedAt: autoApprove ? new Date() : null,
        error: null,
      },
    });
  } catch (e) {
    const message = (e as Error).message;
    logger.error('콘텐츠 생성 실패', { itemId, message });
    await prisma.contentItem.update({ where: { id: itemId }, data: { status: 'FAILED', error: message.slice(0, 300) } });
  }
}

/** 캡션 서식. {링크} 는 게시할 때 플랫폼별 유입 경로가 붙은 주소로 바뀐다. */
export function buildCaptionTemplate(input: { summary: string; campaignTitle: string; moNumber: string | null; keyword: string | null; regNo: string | null; tags: string[] }) {
  return [
    `${input.campaignTitle}`,
    input.summary,
    '',
    input.moNumber ? `문자 후원: ${input.moNumber} 로 '${input.keyword ?? '응원합니다'}' 보내기` : null,
    input.moNumber ? `정기후원: 같은 번호로 '정기' · 자원봉사: '봉사'` : null,
    '후원하기: {링크}',
    '',
    input.tags.map((t) => `#${t}`).join(' '),
    '',
    aiFooter(input.regNo),
  ]
    .filter((l) => l !== null)
    .join('\n');
}

export async function contentLink(merchantId: string, campaignId: string | null, platform: SocialPlatform | null, itemId: string) {
  const m = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { code: true } });
  const path = campaignId ? `/donate/${m.code}/campaigns/${campaignId}` : `/donate/${m.code}`;
  const q = attributionQuery(platform ? PLATFORM_SRC[platform] : 'QR', itemId);
  return `${env.baseUrl}${path}?${q}`;
}

export async function renderCaption(item: { id: string; merchantId: string; campaignId: string | null; caption: string | null }, platform: SocialPlatform | null) {
  const link = await contentLink(item.merchantId, item.campaignId, platform, item.id);
  return (item.caption ?? '').replace('{링크}', link);
}

// ---------------------------------------------------------------------------
// 검토 · 승인
// ---------------------------------------------------------------------------

async function ownItem(merchantId: string, id: string) {
  const item = await prisma.contentItem.findFirst({ where: { id, merchantId } });
  if (!item) throw new ContentError('콘텐츠를 찾을 수 없습니다.');
  return item;
}

/** 대본(장면 자막)·캡션 수정. 장면 이미지는 새 자막으로 다시 그린다. 승인 상태였다면 검토로 되돌린다. */
export async function updateContentDraft(merchantId: string, id: string, input: { captions: string[]; caption: string }) {
  const item = await ownItem(merchantId, id);
  if (!['REVIEW', 'APPROVED'].includes(item.status)) throw new ContentError('검토·승인 단계의 콘텐츠만 고칠 수 있습니다.');
  const old = item.scenes as unknown as Scene[];
  const setting = await getContentSetting(merchantId);
  const captions = input.captions.map((c) => c.trim()).filter(Boolean).slice(0, 10);
  if (captions.length === 0) throw new ContentError('장면 자막이 비어 있습니다.');
  for (const c of [...captions, input.caption]) {
    const hit = setting.bannedWords.find((w) => w && c.includes(w));
    if (hit) throw new ContentError(`금지어가 들어 있습니다: ${hit}`);
  }
  if (captions.some((c) => c.length > 120)) throw new ContentError('장면 자막은 120자 이내로 적어 주세요.');
  if (!input.caption.includes('{링크}')) throw new ContentError('캡션에서 {링크} 를 지우면 후원 링크가 빠집니다. {링크} 를 남겨 주세요.');
  if (!input.caption.includes('AI 생성 콘텐츠')) throw new ContentError('캡션의 "AI 생성 콘텐츠" 표시는 지울 수 없습니다.');
  const merchant = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { displayName: true, fundraisingRegNo: true } });
  const page = await prisma.merchantDonationPage.findUnique({ where: { merchantId }, select: { color: true } });
  const scenes = renderScenes(
    captions.map((c, i) => ({ caption: c, durationSec: old[i]?.durationSec ?? 6 })),
    item.kind,
    merchant.displayName,
    page?.color ?? '#28634e',
    merchant.fundraisingRegNo ?? null,
  );
  return prisma.contentItem.update({
    where: { id },
    data: {
      scenes: scenes as unknown as object,
      script: captions.join('\n'),
      caption: input.caption.slice(0, 2000),
      coverSvg: scenes[Math.min(1, scenes.length - 1)]!.svg,
      status: 'REVIEW',
      approvedAt: null,
      approvedBy: null,
    },
  });
}

export async function approveContent(merchantId: string, id: string, userId: string) {
  const item = await ownItem(merchantId, id);
  if (item.status !== 'REVIEW') throw new ContentError('검토 대기 중인 콘텐츠만 승인할 수 있습니다.');
  if (!item.aiLabeled) throw new ContentError('AI 생성 표시가 없는 콘텐츠는 승인할 수 없습니다.');
  if (!item.regNoIncluded) {
    throw new ContentError('기부금품 모집등록번호가 없어 승인할 수 없습니다. 기관 정보에 모집등록번호를 넣고 콘텐츠를 다시 만들어 주세요.');
  }
  return prisma.contentItem.update({ where: { id }, data: { status: 'APPROVED', approvedBy: userId, approvedAt: new Date() } });
}

export async function archiveContent(merchantId: string, id: string) {
  await ownItem(merchantId, id);
  await prisma.contentPublish.updateMany({ where: { itemId: id, status: 'SCHEDULED' }, data: { status: 'CANCELED' } });
  return prisma.contentItem.update({ where: { id }, data: { status: 'ARCHIVED' } });
}

/** 같은 캠페인·형식으로 새로 만든다(기존 것은 보관). 단계별 과금 기록은 새 콘텐츠에 따로 남는다. */
export async function regenerateContent(merchantId: string, id: string, userId: string, tone?: string) {
  const item = await ownItem(merchantId, id);
  if (!item.campaignId) throw new ContentError('캠페인이 없는 콘텐츠입니다.');
  const fresh = await requestContent({ merchantId, campaignId: item.campaignId, kind: item.kind, userId, tone });
  if (item.status !== 'PUBLISHED' && item.status !== 'SCHEDULED') await archiveContent(merchantId, id);
  return fresh;
}

// ---------------------------------------------------------------------------
// SNS 채널 · 게시
// ---------------------------------------------------------------------------

export async function connectSocialChannel(merchantId: string, platform: SocialPlatform, accountName: string, userId: string) {
  const name = accountName.trim();
  if (!/^[@\p{L}\p{N}_. -]{2,40}$/u.test(name)) throw new ContentError('계정 이름은 2~40자로 입력해 주세요.');
  const adapter = getSnsAdapter();
  const mock = adapter.info().mode === 'mock';
  // 실연동에서는 OAuth 동의 화면을 거쳐 토큰을 받는다. mock 은 토큰 없이 연결 표시만 한다.
  return prisma.socialChannel.upsert({
    where: { merchantId_platform: { merchantId, platform } },
    create: { id: newId(), merchantId, platform, accountName: name, status: 'CONNECTED', mock, connectedBy: userId, accessTokenEnc: mock ? null : encrypt('pending-oauth') },
    update: { accountName: name, status: 'CONNECTED', mock, connectedBy: userId, connectedAt: new Date() },
  });
}

export async function disconnectSocialChannel(merchantId: string, platform: SocialPlatform) {
  await prisma.socialChannel.updateMany({ where: { merchantId, platform }, data: { status: 'REVOKED', accessTokenEnc: null, refreshTokenEnc: null } });
}

export async function schedulePublish(merchantId: string, id: string, platforms: SocialPlatform[], at: Date) {
  if (!env.automation.socialPublishEnabled) {
    throw new ContentError('SNS 자동 게시가 아직 열리지 않았습니다(플랫폼 심사 전). 승인된 콘텐츠를 내려받아 직접 올려 주세요.');
  }
  const item = await ownItem(merchantId, id);
  if (!['APPROVED', 'SCHEDULED', 'PUBLISHED'].includes(item.status)) throw new ContentError('승인된 콘텐츠만 게시할 수 있습니다.');
  if (platforms.length === 0) throw new ContentError('게시할 채널을 골라 주세요.');
  const channels = await prisma.socialChannel.findMany({ where: { merchantId, platform: { in: platforms }, status: 'CONNECTED' } });
  const connected = new Set(channels.map((c) => c.platform));
  const created: SocialPlatform[] = [];
  for (const p of platforms) {
    if (!connected.has(p)) throw new ContentError(`${p} 채널이 연결되어 있지 않습니다.`);
    if (!PLATFORM_KINDS[p].includes(item.kind)) throw new ContentError(`${p} 에는 이 형식을 올릴 수 없습니다.`);
    const existing = await prisma.contentPublish.findUnique({ where: { itemId_platform: { itemId: id, platform: p } } });
    if (existing && ['PUBLISHED', 'PRIVATE_UPLOADED', 'PUBLISHING'].includes(existing.status)) continue;
    await prisma.contentPublish.upsert({
      where: { itemId_platform: { itemId: id, platform: p } },
      create: { id: newId(), itemId: id, platform: p, scheduledAt: at, status: 'SCHEDULED', mock: getSnsAdapter().info().mode === 'mock' },
      update: { scheduledAt: at, status: 'SCHEDULED', attempts: 0, error: null },
    });
    created.push(p);
  }
  if (created.length && item.status === 'APPROVED') await prisma.contentItem.update({ where: { id }, data: { status: 'SCHEDULED' } });
  return created;
}

export async function cancelPublish(merchantId: string, publishId: string) {
  const p = await prisma.contentPublish.findFirst({ where: { id: publishId, item: { merchantId } } });
  if (!p) throw new ContentError('게시 예약을 찾을 수 없습니다.');
  const r = await prisma.contentPublish.updateMany({ where: { id: publishId, status: 'SCHEDULED' }, data: { status: 'CANCELED' } });
  if (r.count === 0) throw new ContentError('이미 게시됐거나 처리 중인 예약은 취소할 수 없습니다.');
}

async function publishOne(publishId: string, now: Date) {
  // 예약 → 게시 중 전환을 조건부 갱신으로 잡는다. 겹쳐 도는 배치가 같은 게시를 두 번 올리지 않는다.
  const claim = await prisma.contentPublish.updateMany({
    where: { id: publishId, status: 'SCHEDULED', scheduledAt: { lte: now } },
    data: { status: 'PUBLISHING', attempts: { increment: 1 } },
  });
  if (claim.count === 0) return 'SKIPPED' as const;
  const p = await prisma.contentPublish.findUniqueOrThrow({ where: { id: publishId }, include: { item: true } });
  const channel = await prisma.socialChannel.findUnique({ where: { merchantId_platform: { merchantId: p.item.merchantId, platform: p.platform } } });
  const fail = async (message: string) => {
    const retry = p.attempts < PUBLISH_MAX_ATTEMPTS;
    await prisma.contentPublish.update({
      where: { id: p.id },
      data: retry
        ? { status: 'SCHEDULED', scheduledAt: new Date(now.getTime() + 30 * 60_000), error: message.slice(0, 300) }
        : { status: 'FAILED', error: message.slice(0, 300) },
    });
    return retry ? ('RETRY' as const) : ('FAILED' as const);
  };
  if (!channel || channel.status !== 'CONNECTED') return fail('채널 연결이 끊겼습니다. SNS 채널을 다시 연결해 주세요.');
  if (p.platform === 'INSTAGRAM') {
    const recent = await prisma.contentPublish.count({
      where: { platform: 'INSTAGRAM', status: { in: ['PUBLISHED', 'PRIVATE_UPLOADED'] }, publishedAt: { gte: new Date(now.getTime() - 86_400_000) }, item: { merchantId: p.item.merchantId } },
    });
    if (recent >= INSTAGRAM_DAILY_LIMIT) {
      await prisma.contentPublish.update({ where: { id: p.id }, data: { status: 'SCHEDULED', scheduledAt: new Date(now.getTime() + 3600_000), attempts: { decrement: 1 }, error: '인스타그램 24시간 게시 한도(50건) — 1시간 뒤 다시 시도' } });
      return 'DEFERRED' as const;
    }
  }
  const scenes = (p.item.scenes as unknown as Scene[]) ?? [];
  const caption = await renderCaption(p.item, p.platform);
  try {
    const res = await getSnsAdapter().publish({
      platform: p.platform,
      accessToken: channel.accessTokenEnc ? decrypt(channel.accessTokenEnc) : null,
      caption,
      title: p.item.title,
      assets: scenes.map((s) => s.svg),
      kind: p.item.kind,
    });
    if (!res.ok || !res.data) return fail(res.message ?? '게시에 실패했습니다.');
    await prisma.contentPublish.update({
      where: { id: p.id },
      data: { status: res.data.status, mock: res.data.mock, externalPostId: res.data.externalPostId, url: res.data.url, publishedAt: new Date(), error: null },
    });
    const left = await prisma.contentPublish.count({ where: { itemId: p.itemId, status: { in: ['SCHEDULED', 'PUBLISHING'] } } });
    if (left === 0) await prisma.contentItem.update({ where: { id: p.itemId }, data: { status: 'PUBLISHED' } });
    return 'PUBLISHED' as const;
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** 배치: 멈춘 생성 재개 → 예약 게시 → 지표 수집 */
export async function processContentQueue(now = new Date()) {
  const result = { resumed: 0, published: 0, retried: 0, failed: 0, deferred: 0, metrics: 0 };
  const stuck = await prisma.contentItem.findMany({
    where: { status: 'GENERATING', updatedAt: { lt: new Date(now.getTime() - 120_000) } },
    select: { id: true },
    take: 20,
  });
  for (const s of stuck) {
    await runContentPipeline(s.id);
    result.resumed += 1;
  }
  if (env.automation.socialPublishEnabled) {
    const due = await prisma.contentPublish.findMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: now } }, select: { id: true }, orderBy: { scheduledAt: 'asc' }, take: 50 });
    for (const d of due) {
      const r = await publishOne(d.id, now);
      if (r === 'PUBLISHED') result.published += 1;
      else if (r === 'RETRY') result.retried += 1;
      else if (r === 'FAILED') result.failed += 1;
      else if (r === 'DEFERRED') result.deferred += 1;
    }
  }
  const live = await prisma.contentPublish.findMany({
    where: { status: { in: ['PUBLISHED', 'PRIVATE_UPLOADED'] }, mock: false, publishedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
    take: 100,
  });
  for (const p of live) {
    const m = await getSnsAdapter().metrics(p.platform, p.externalPostId).catch(() => null);
    if (!m) continue;
    await prisma.contentPublish.update({ where: { id: p.id }, data: { views: m.views, likes: m.likes, metricsAt: now } });
    result.metrics += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 전환 집계 (원천은 결제 건·약정·봉사 신청)
// ---------------------------------------------------------------------------

export async function contentConversions(merchantId: string, itemIds: string[]) {
  if (itemIds.length === 0) return new Map<string, { donations: number; amount: bigint; pledges: number; volunteers: number }>();
  const [charges, pledges, vols] = await Promise.all([
    prisma.charge.groupBy({
      by: ['contentItemId'],
      where: { merchantId, contentItemId: { in: itemIds }, status: { in: PAID_STATUSES }, recurringId: null, isTest: false },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.recurringDonation.groupBy({ by: ['contentItemId'], where: { merchantId, contentItemId: { in: itemIds } }, _count: { _all: true } }),
    prisma.volunteerApplication.groupBy({ by: ['contentItemId'], where: { merchantId, contentItemId: { in: itemIds } }, _count: { _all: true } }),
  ]);
  const out = new Map<string, { donations: number; amount: bigint; pledges: number; volunteers: number }>();
  for (const id of itemIds) out.set(id, { donations: 0, amount: 0n, pledges: 0, volunteers: 0 });
  for (const c of charges) if (c.contentItemId) Object.assign(out.get(c.contentItemId)!, { donations: c._count._all, amount: c._sum.amount ?? 0n });
  for (const p of pledges) if (p.contentItemId) out.get(p.contentItemId)!.pledges = p._count._all;
  for (const v of vols) if (v.contentItemId) out.get(v.contentItemId)!.volunteers = v._count._all;
  return out;
}

/** 유입 경로별 전환 (기관 대시보드 깔때기) */
export async function sourceFunnel(merchantId: string, since: Date) {
  const [charges, pledges, vols] = await Promise.all([
    prisma.charge.groupBy({
      by: ['source'],
      where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, recurringId: null, paidAt: { gte: since } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.recurringDonation.groupBy({ by: ['source'], where: { merchantId, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.volunteerApplication.groupBy({ by: ['source'], where: { merchantId, createdAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const map = new Map<string, { donations: number; amount: bigint; pledges: number; volunteers: number }>();
  const get = (k: string | null) => {
    const key = k ?? 'UNKNOWN';
    if (!map.has(key)) map.set(key, { donations: 0, amount: 0n, pledges: 0, volunteers: 0 });
    return map.get(key)!;
  };
  for (const c of charges) Object.assign(get(c.source), { donations: c._count._all, amount: c._sum.amount ?? 0n });
  for (const p of pledges) get(p.source).pledges = p._count._all;
  for (const v of vols) get(v.source).volunteers = v._count._all;
  return map;
}
