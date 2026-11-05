import { env, featureContentEnabled } from '@/lib/env';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { kstMonthKey } from '@/lib/datetime';
import { attributionQuery } from '@/lib/attribution';
import { prisma } from '@/server/db';
import { Prisma } from '@/generated/prisma/client';
import { emitDomainEventSafe } from './events';
import { PAID_STATUSES } from '@/components/studio/shared';
import {
  getContentAdapter,
  kindFormat,
  renderSceneSvg,
  type ContentBrief,
  type ScriptUsage,
  type Tone,
} from '@/server/adapters/content';
import { loadSharp } from '@/server/adapters/content/video';
import { getSnsAdapter, PLATFORM_KINDS, PLATFORM_LABEL, PLATFORM_SRC } from '@/server/adapters/sns';
import type { ContentKind, SocialPlatform } from '@/generated/prisma/enums';
import { getObject, objectNameFromUrl } from '@/server/uploads';
import { collectSocialMetrics, socialPublishAuth } from './social-oauth';
import { goLink } from './content-clicks';
import { campaignStats } from './fundraising';
import { monthRange } from './monthly-notice';
import { recordAiUsage } from './ai-usage';
import { adaptCaption, composeFromVariant, LINK_TOKEN, postToText, type PlatformPost } from './content-captions';
import { ownedPostingId } from './volunteer-postings';

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
  CARD_NEWS: '카드뉴스 (4:5 · 5~7장)',
  IMAGE_FEED: '피드 이미지 (4:5 · 1장)',
};

/** 목록 배지용 짧은 이름 */
export const CONTENT_KIND_SHORT: Record<ContentKind, string> = {
  SHORTFORM: '숏폼',
  IMAGE_SQUARE: '정사각',
  IMAGE_STORY: '스토리',
  CARD_NEWS: '카드뉴스',
  IMAGE_FEED: '피드',
};

export const CONTENT_KINDS: ContentKind[] = ['SHORTFORM', 'CARD_NEWS', 'IMAGE_FEED', 'IMAGE_SQUARE', 'IMAGE_STORY'];

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
  /** 카드뉴스 구간 이름 */
  label?: string;
  /** 진행률 막대 (0~100) */
  progress?: number;
}

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

export async function getContentSetting(merchantId: string) {
  const row = await prisma.merchantContentSetting.findUnique({ where: { merchantId } });
  return row ?? {
    merchantId, tone: 'WARM', bannedWords: [] as string[], autoApprove: false, monthlyLimit: 30, hashtags: [] as string[],
    calendarEnabled: false, weeklyCount: 3, days: [1, 3, 5], postHour: 19, kinds: [] as ContentKind[], platforms: [] as SocialPlatform[], autoSchedule: false,
    updatedAt: new Date(0),
  };
}

export interface CalendarSettingInput {
  calendarEnabled: boolean;
  weeklyCount: number;
  days: number[];
  postHour: number;
  kinds: ContentKind[];
  platforms: SocialPlatform[];
  autoSchedule: boolean;
}

export async function saveContentSetting(
  merchantId: string,
  input: { tone: string; bannedWords: string[]; autoApprove: boolean; hashtags: string[]; calendar?: CalendarSettingInput },
) {
  const tone = TONES.includes(input.tone as Tone) ? input.tone : 'WARM';
  const banned = input.bannedWords.map((w) => w.trim()).filter(Boolean).slice(0, 50);
  const tags = input.hashtags.map((t) => t.replace(/^#/, '').trim()).filter((t) => /^[\p{L}\p{N}_]{1,30}$/u.test(t)).slice(0, 10);
  const c = input.calendar;
  const calendar = c
    ? {
        calendarEnabled: c.calendarEnabled,
        weeklyCount: Math.min(7, Math.max(1, Math.round(Number(c.weeklyCount) || 3))),
        days: [...new Set(c.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b),
        postHour: Math.min(23, Math.max(0, Math.round(Number(c.postHour) || 0))),
        kinds: [...new Set(c.kinds.filter((k) => CONTENT_KINDS.includes(k)))],
        platforms: [...new Set(c.platforms.filter((p) => Object.hasOwn(PLATFORM_LABEL, p)))],
        autoSchedule: c.autoSchedule,
      }
    : {};
  const data = { tone, bannedWords: banned, autoApprove: input.autoApprove, hashtags: tags, ...calendar };
  return prisma.merchantContentSetting.upsert({
    where: { merchantId },
    create: { merchantId, ...data },
    update: data,
  });
}

export async function monthlyUsage(merchantId: string, now = new Date()) {
  const { start, end } = monthRange(kstMonthKey(now));
  const [count, cost] = await Promise.all([
    // 생성 실패(공급자 오류)는 한도에 넣지 않는다 — 공급자 장애의 비용을 기관 한도로 떠안지 않게. 비용 합계는 실제 쓴 만큼 그대로 센다.
    prisma.contentItem.count({ where: { merchantId, createdAt: { gte: start, lt: end }, status: { not: 'FAILED' } } }),
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

export function aiFooter(regNo: string | null) {
  return regNo ? `AI 생성 콘텐츠 · 기부금품 모집등록 ${regNo}` : 'AI 생성 콘텐츠';
}

/**
 * 기관 로고(기관 정보 > 기관 로고)를 장면 SVG 에 넣을 data: URI 로. 자체 저장소·/assets 이미지만,
 * sharp 로 144px PNG 로 줄인다(장면마다 들어가므로 작게). 못 읽으면 로고 없이 그린다.
 */
const logoCache = new Map<string, string | null>();
export async function logoDataUri(avatarUrl: string | null | undefined): Promise<string | null> {
  if (!avatarUrl) return null;
  if (logoCache.has(avatarUrl)) return logoCache.get(avatarUrl)!;
  let buf: Buffer | null = null;
  try {
    const name = objectNameFromUrl(avatarUrl);
    if (name) buf = await getObject(name);
    else if (/^\/assets\/[\w\-/]+\.(png|jpe?g|webp|svg)$/i.test(avatarUrl) && !avatarUrl.includes('..')) {
      const { promises: fs } = await import('node:fs');
      const path = await import('node:path');
      buf = await fs.readFile(path.join(process.cwd(), 'public', avatarUrl));
    }
  } catch {
    buf = null;
  }
  let uri: string | null = null;
  if (buf && buf.length < 5 * 1024 * 1024) {
    const sharp = await loadSharp();
    const png = sharp ? await sharp(buf).resize(144, 144, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } } as Record<string, unknown>).png().toBuffer().catch(() => null) : null;
    if (png) uri = `data:image/png;base64,${png.toString('base64')}`;
  }
  if (logoCache.size > 200) logoCache.clear();
  logoCache.set(avatarUrl, uri);
  return uri;
}

export async function requestContent(input: { merchantId: string; campaignId: string; kind: ContentKind; userId: string; tone?: string; postingId?: string | null }) {
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
      // 봉사 모집 공고 연결(저장만). 5단계 buildBrief 와 합칠 때 공고 필드를 대본에 연결한다.
      postingId: await ownedPostingId(input.merchantId, input.postingId),
    },
  });
  await runContentPipeline(item.id, input.tone && TONES.includes(input.tone as Tone) ? (input.tone as Tone) : undefined);
  return prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
}

async function jobDone(itemId: string, step: Step) {
  const j = await prisma.contentJob.findUnique({ where: { itemId_step: { itemId, step } } });
  return j?.status === 'DONE' ? j : null;
}

/** 다른 실행이 같은 단계를 돌리는 중이다. 이 실행은 조용히 물러난다(실패로 기록하지 않는다). */
class StepBusyError extends Error {}

/** 단계 선점 유지 시간. 이보다 오래 RUNNING 이면 멈춘 것으로 보고 다시 잡는다. */
const STEP_LEASE_MS = 10 * 60_000;
/** 배치가 멈춘 생성으로 보고 재개하는 기준. */
const STUCK_GENERATING_MS = 120_000;

/**
 * 외부 호출(과금) 단계 선점. (콘텐츠, 단계) 유니크 행을 RUNNING 으로 먼저 만들고,
 * 이미 있으면 FAILED·오래된 RUNNING 만 조건부 갱신으로 다시 잡는다. 끝난 단계면 그 기록을 돌려준다.
 * 두 실행이 겹쳐도 같은 단계의 공급자 호출은 한 번만 일어난다.
 */
async function claimStep(itemId: string, step: Step, provider: string) {
  try {
    await prisma.contentJob.create({ data: { id: newId(), itemId, step, status: 'RUNNING', provider } });
    return null;
  } catch (e) {
    if ((e as { code?: string })?.code !== 'P2002') throw e;
  }
  const r = await prisma.contentJob.updateMany({
    where: { itemId, step, OR: [{ status: 'FAILED' }, { status: 'RUNNING', updatedAt: { lt: new Date(Date.now() - STEP_LEASE_MS) } }] },
    data: { status: 'RUNNING', provider, error: null },
  });
  if (r.count === 1) return null;
  const done = await jobDone(itemId, step);
  if (done) return done;
  throw new StepBusyError(`${step} 단계를 다른 실행이 처리 중입니다.`);
}

/** 생성이 살아 있음을 알린다(배치가 멈춘 것으로 오인해 다시 집지 않게). */
async function touchItem(itemId: string) {
  await prisma.contentItem.updateMany({ where: { id: itemId, status: 'GENERATING' }, data: { updatedAt: new Date() } }).catch(() => undefined);
}

/**
 * 게시 전 문구 검사(담당자 수정·자동 승인 공통). 통과하면 null, 아니면 사유.
 * 금지어 · 장면 자막 길이 · {링크} · "AI 생성 콘텐츠" 표시.
 */
export function contentDraftViolation(input: { bannedWords: string[]; captions: string[]; caption: string; hashtags?: string[]; platformCaptions?: string[] }): string | null {
  for (const c of [...input.captions, input.caption, ...(input.hashtags ?? []), ...(input.platformCaptions ?? [])]) {
    const hit = input.bannedWords.find((w) => w && c.includes(w));
    if (hit) return `금지어가 들어 있습니다: ${hit}`;
  }
  if (input.captions.some((c) => c.length > 120)) return '장면 자막은 120자 이내로 적어 주세요.';
  if (!input.caption.includes('{링크}')) return '캡션에서 {링크} 를 지우면 후원 링크가 빠집니다. {링크} 를 남겨 주세요.';
  if (!input.caption.includes('AI 생성 콘텐츠')) return '캡션의 "AI 생성 콘텐츠" 표시는 지울 수 없습니다.';
  for (const p of input.platformCaptions ?? []) {
    if (!p.includes('{링크}') || !p.includes('AI 생성 콘텐츠')) return '플랫폼별 캡션에 후원 링크나 "AI 생성 콘텐츠" 표시가 빠졌습니다.';
  }
  return null;
}

async function recordJob(itemId: string, step: Step, provider: string, status: 'DONE' | 'FAILED', output: object | null, costKrw = 0, error?: string) {
  await prisma.contentJob.upsert({
    where: { itemId_step: { itemId, step } },
    create: { id: newId(), itemId, step, status, provider, costKrw, output: output ?? undefined, error: error ?? null },
    update: { status, provider, costKrw, output: output ?? undefined, error: error ?? null },
  });
}

export async function buildBrief(merchantId: string, campaignId: string, toneOverride?: Tone, postingId?: string | null): Promise<{ brief: ContentBrief; color: string; logo: string | null }> {
  const [merchant, campaign, page, setting, route, posting] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { displayName: true, fundraisingRegNo: true, description: true, avatarUrl: true } }),
    prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
    prisma.merchantDonationPage.findUnique({ where: { merchantId }, select: { color: true, intro: true } }),
    getContentSetting(merchantId),
    moRoute(merchantId),
    // 봉사 모집 공고와 연결된 콘텐츠면 공고 내용(분야·장소·모집 기간)을 대본에 넣는다(6단계 연결).
    postingId
      ? prisma.volunteerPosting.findFirst({ where: { id: postingId, merchantId, archivedAt: null }, select: { title: true, interest: true, description: true, place: true, recruitTo: true } })
      : Promise.resolve(null),
  ]);
  const stats = (await campaignStats([campaign.id])).get(campaign.id);
  const recruit = posting
    ? `자원봉사 모집: ${posting.title} (${posting.interest} · ${posting.place}, ${posting.recruitTo.toISOString().slice(5, 10).replace('-', '/')}까지). ${posting.description}`.slice(0, 300)
    : null;
  const daysLeft = Math.max(0, Math.ceil((campaign.endsOn.getTime() - Date.now()) / 86_400_000));
  const color = page?.color ?? '#28634e';
  const prefix = route?.mode === 'SHARED_PREFIX' && route.keyword ? `${route.keyword} ` : '';
  return {
    color,
    logo: await logoDataUri(merchant.avatarUrl),
    brief: {
      merchantName: merchant.displayName,
      merchantIntro: merchant.description?.trim() || null,
      merchantBusiness: page?.intro?.trim() || null,
      campaignTitle: campaign.title,
      summary: campaign.summary,
      story: recruit ? [campaign.story, recruit].filter(Boolean).join(' ') : campaign.story,
      usagePlan: recruit ? `${campaign.usagePlan ?? ''} 함께할 자원봉사자도 모집합니다. 같은 번호로 '봉사' 를 보내 신청하세요.`.trim() : campaign.usagePlan,
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

function renderScenes(
  captions: Array<{ caption: string; durationSec: number; label?: string; progress?: number }>,
  kind: ContentKind,
  merchantName: string,
  color: string,
  regNo: string | null,
  logo: string | null = null,
): Scene[] {
  const format = kindFormat(kind);
  return captions.map((s, i) => ({
    caption: s.caption,
    durationSec: s.durationSec,
    ...(s.label ? { label: s.label } : {}),
    ...(typeof s.progress === 'number' ? { progress: s.progress } : {}),
    svg: renderSceneSvg({ caption: s.caption, index: i, total: captions.length, merchantName, color, footer: aiFooter(regNo), format, label: s.label, progress: s.progress, logo }),
  }));
}

/** 문자 후원 안내 줄 (기본 캡션·플랫폼별 캡션 공통) */
function moLines(moNumber: string | null, keyword: string | null) {
  return moNumber ? [`문자 후원: ${moNumber} 로 '${keyword ?? '응원합니다'}' 보내기`, `정기후원: 같은 번호로 '정기' · 자원봉사: '봉사'`] : [];
}

async function recordScriptUsage(merchantId: string, usage: ScriptUsage[] | undefined) {
  for (const u of usage ?? []) {
    await recordAiUsage({ merchantId, feature: 'content_script', provider: u.provider, model: u.model, usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens }, ok: u.ok });
  }
}

/** 생성 단계를 순서대로 돌린다. 끝난 단계는 건너뛴다(재시작 안전). */
export async function runContentPipeline(itemId: string, toneOverride?: Tone) {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: itemId } });
  if (!item.campaignId) throw new ContentError('캠페인이 없는 콘텐츠입니다.');
  const adapter = getContentAdapter();
  const provider = adapter.info().provider;
  const claimed: Step[] = [];
  try {
    const { brief, color, logo } = await buildBrief(item.merchantId, item.campaignId, toneOverride, item.postingId);
    const kind = item.kind;
    let cost = 0;

    type ScriptOut = {
      title: string;
      script: string;
      scenes: Array<{ caption: string; durationSec: number; label?: string; progress?: number }>;
      hashtags: string[];
      platformCaptions?: Record<string, { title?: string; body: string }>;
    };
    const scriptDone = await claimStep(itemId, 'SCRIPT', provider);
    let script = (scriptDone?.output ?? null) as ScriptOut | null;
    if (!scriptDone) {
      claimed.push('SCRIPT');
      let r;
      try {
        r = await adapter.script(brief, kind);
      } catch (e) {
        await recordScriptUsage(item.merchantId, (e as { usage?: ScriptUsage[] }).usage);
        throw e;
      }
      await recordScriptUsage(item.merchantId, r.usage);
      script = r.data;
      cost += r.costKrw;
      await recordJob(itemId, 'SCRIPT', provider, 'DONE', script, r.costKrw);
      await touchItem(itemId);
    }
    if (!script) throw new ContentError('대본 기록을 읽지 못했습니다.');

    let scenes: Scene[] | null = (await jobDone(itemId, 'SCENES')) ? (item.scenes as unknown as Scene[]) : null;
    if (!scenes || scenes.length === 0) {
      scenes = renderScenes(script.scenes, kind, brief.merchantName, color, brief.regNo, logo);
      await recordJob(itemId, 'SCENES', 'givesign-svg', 'DONE', { count: scenes.length });
    }

    let videoUrl: string | null = item.videoUrl ?? null;
    if (kind === 'SHORTFORM') {
      if (!(await claimStep(itemId, 'VOICE', provider))) {
        claimed.push('VOICE');
        const v = await adapter.voice(script.script);
        cost += v.costKrw;
        await recordJob(itemId, 'VOICE', provider, 'DONE', v, v.costKrw);
        await touchItem(itemId);
      }
      const assembled = await claimStep(itemId, 'ASSEMBLE', provider);
      if (!assembled) {
        claimed.push('ASSEMBLE');
        // 음성(TTS)은 계약 전이라 없다 — 자막이 그려진 장면만으로 조립한다.
        const a = await adapter.assemble({ scenes: scenes.map((s) => ({ svg: s.svg, durationSec: s.durationSec })), audio: null });
        cost += a.costKrw;
        videoUrl = a.videoUrl ?? null;
        await recordJob(itemId, 'ASSEMBLE', provider, 'DONE', a, a.costKrw);
        await touchItem(itemId);
      } else {
        videoUrl = videoUrl ?? ((assembled.output as { videoUrl?: string } | null)?.videoUrl ?? null);
      }
    }
    if (!(await jobDone(itemId, 'COVER'))) await recordJob(itemId, 'COVER', 'givesign-svg', 'DONE', { from: 'scene-2' });

    const setting = await getContentSetting(item.merchantId);
    const tags = [...new Set([...script.hashtags, ...setting.hashtags])].slice(0, 12);
    const regNoIncluded = Boolean(brief.regNo);
    const caption = buildCaptionTemplate({ summary: brief.summary, campaignTitle: brief.campaignTitle, moNumber: brief.moNumber, keyword: brief.keyword, regNo: brief.regNo, tags });
    // LLM 이 쓴 플랫폼별 본문에 시스템이 문자 안내·링크·해시태그·AI 표시를 붙여 완성본으로 저장한다(mock 은 저장하지 않고 규칙 기반).
    const platformCaptions = script.platformCaptions ? composeStoredCaptions(script.platformCaptions, { moLines: moLines(brief.moNumber, brief.keyword), tags, footer: aiFooter(brief.regNo) }) : null;
    // 자동 승인도 담당자 수정과 같은 검사를 거친다. 걸리면 자동 승인을 무시하고 검토 대기로 두며 사유를 남긴다.
    const violation = setting.autoApprove
      ? contentDraftViolation({
          bannedWords: setting.bannedWords,
          captions: scenes.map((s) => s.caption),
          caption,
          hashtags: tags,
          platformCaptions: platformCaptions ? Object.values(platformCaptions).map((p) => postToText(p)) : [],
        })
      : null;
    const autoApprove = setting.autoApprove && regNoIncluded && !violation;
    // 다른 실행이 먼저 끝냈으면(생성 중이 아니면) 덮어쓰지 않는다.
    const finished = await prisma.contentItem.updateMany({
      where: { id: itemId, status: 'GENERATING' },
      data: {
        title: script.title,
        script: script.script,
        scenes: scenes as unknown as object,
        hashtags: tags,
        caption,
        platformCaptions: platformCaptions ? (platformCaptions as unknown as Prisma.InputJsonObject) : undefined,
        videoUrl,
        coverSvg: scenes[Math.min(1, scenes.length - 1)]!.svg,
        aiLabeled: true,
        regNoIncluded,
        costKrw: { increment: cost },
        status: autoApprove ? 'APPROVED' : 'REVIEW',
        approvedBy: autoApprove ? 'AUTO' : null,
        approvedAt: autoApprove ? new Date() : null,
        error: violation ? `자동 승인 보류: ${violation}`.slice(0, 300) : null,
      },
    });
    if (finished.count === 0) logger.warn('콘텐츠 생성 결과를 반영하지 않음 — 이미 다른 실행이 끝냈습니다', { itemId });
    else if (autoApprove) {
      await emitDomainEventSafe({
        merchantId: item.merchantId, type: 'content.approved', subjectType: 'content_item', subjectId: itemId,
        payload: { kind: item.kind, campaignId: item.campaignId, approvedBy: 'AUTO' },
      });
      await autoScheduleSlotItem(itemId);
    }
  } catch (e) {
    if (e instanceof StepBusyError) {
      logger.info('콘텐츠 생성 단계가 다른 실행에서 진행 중 — 이 실행은 물러납니다', { itemId, message: e.message });
      return;
    }
    const message = (e as Error).message;
    logger.error('콘텐츠 생성 실패', { itemId, message });
    if (claimed.length) {
      await prisma.contentJob
        .updateMany({ where: { itemId, step: { in: claimed }, status: 'RUNNING' }, data: { status: 'FAILED', error: message.slice(0, 300) } })
        .catch(() => undefined);
    }
    await prisma.contentItem.updateMany({ where: { id: itemId, status: 'GENERATING' }, data: { status: 'FAILED', error: message.slice(0, 300) } });
  }
}

/** 캡션 서식. {링크} 는 게시할 때 플랫폼별 유입 경로가 붙은 주소로 바뀐다. */
export function buildCaptionTemplate(input: { summary: string; campaignTitle: string; moNumber: string | null; keyword: string | null; regNo: string | null; tags: string[] }) {
  return [
    `${input.campaignTitle}`,
    input.summary,
    '',
    ...moLines(input.moNumber, input.keyword),
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

/** LLM 플랫폼 변형 → 링크 자리({링크})가 남은 완성 캡션 */
function composeStoredCaptions(
  variants: Record<string, { title?: string; body: string }>,
  common: { moLines: string[]; tags: string[]; footer: string },
): Record<string, PlatformPost> {
  const out: Record<string, PlatformPost> = {};
  for (const [k, v] of Object.entries(variants)) {
    if (!Object.hasOwn(PLATFORM_LABEL, k) || !v || typeof v.body !== 'string') continue;
    out[k] = composeFromVariant(k as SocialPlatform, v, common);
  }
  return out;
}

type CaptionItem = { id: string; merchantId: string; campaignId: string | null; caption: string | null; platformCaptions?: unknown; title?: string };

/**
 * 플랫폼별 게시 글(제목·본문). LLM 이 쓴 변형이 저장돼 있으면 그것을, 없으면(mock·담당자 수정 후) 기본 캡션을 규칙으로 바꾼다.
 * platform 이 null 이면(QR·기타) 기본 캡션 그대로.
 */
export async function renderPlatformPost(item: CaptionItem, platform: SocialPlatform | null, opts: { publishId?: string } = {}): Promise<PlatformPost> {
  // 실제 게시(게시 행이 있을 때)는 기브싸인 짧은 링크(/go/게시 id)로 — 클릭을 직접 센다(봇·10분 중복 제외).
  // 대상 주소는 /go 가 게시 행에서 서버로 만든다(쿼리로 받지 않음). 내려받기·미리보기는 후원페이지 주소 그대로.
  const link = opts.publishId ? goLink(opts.publishId) : await contentLink(item.merchantId, item.campaignId, platform, item.id);
  const base = item.caption ?? '';
  if (!platform) return { title: item.title ?? null, text: base.replace(LINK_TOKEN, link) };
  const stored = (item.platformCaptions && typeof item.platformCaptions === 'object' ? (item.platformCaptions as Record<string, PlatformPost>)[platform] : null) ?? null;
  const post = stored && typeof stored.text === 'string' ? stored : adaptCaption(base, platform);
  return { title: post.title ?? null, text: post.text.replace(LINK_TOKEN, link) };
}

export async function renderCaption(item: CaptionItem, platform: SocialPlatform | null) {
  if (!platform) {
    const link = await contentLink(item.merchantId, item.campaignId, platform, item.id);
    return (item.caption ?? '').replace('{링크}', link);
  }
  return postToText(await renderPlatformPost(item, platform));
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
  const violation = contentDraftViolation({ bannedWords: setting.bannedWords, captions, caption: input.caption });
  if (violation) throw new ContentError(violation);
  const merchant = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { displayName: true, fundraisingRegNo: true, avatarUrl: true } });
  const page = await prisma.merchantDonationPage.findUnique({ where: { merchantId }, select: { color: true } });
  const scenes = renderScenes(
    captions.map((c, i) => ({ caption: c, durationSec: old[i]?.durationSec ?? 6, label: old[i]?.label, progress: old[i]?.progress })),
    item.kind,
    merchant.displayName,
    page?.color ?? '#28634e',
    merchant.fundraisingRegNo ?? null,
    await logoDataUri(merchant.avatarUrl),
  );
  return prisma.contentItem.update({
    where: { id },
    data: {
      scenes: scenes as unknown as object,
      script: captions.join('\n'),
      caption: input.caption.slice(0, 2000),
      // 담당자가 고친 캡션이 기준이 된다. 플랫폼별 캡션은 고친 캡션에서 규칙으로 다시 만든다.
      platformCaptions: Prisma.DbNull,
      // 장면 글이 바뀌었으므로 예전 자막으로 조립한 영상은 쓰지 않는다.
      videoUrl: null,
      coverSvg: scenes[Math.min(1, scenes.length - 1)]!.svg,
      status: 'REVIEW',
      approvedAt: null,
      approvedBy: null,
      error: null,
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
  const approved = await prisma.contentItem.update({ where: { id }, data: { status: 'APPROVED', approvedBy: userId, approvedAt: new Date() } });
  await emitDomainEventSafe({
    merchantId, type: 'content.approved', subjectType: 'content_item', subjectId: id,
    payload: { kind: approved.kind, campaignId: approved.campaignId, approvedBy: 'USER' },
  });
  // 캘린더 슬롯 콘텐츠면, 슬롯이 아직 미래이고 자동 예약이 켜져 있을 때 그 시각으로 예약한다.
  await autoScheduleSlotItem(id);
  return prisma.contentItem.findUniqueOrThrow({ where: { id } });
}

/**
 * 콘텐츠 캘린더 슬롯 자동 예약. 슬롯이 미래이고, 기관이 autoSchedule 을 켰고, SNS 게시가 열려 있으며,
 * 연결된 채널 중 설정 플랫폼·형식 허용인 곳이 있을 때만. 결과는 슬롯 메모로 남긴다. 실패가 승인을 되돌리지 않는다.
 */
export async function autoScheduleSlotItem(itemId: string, now = new Date()): Promise<SocialPlatform[]> {
  const slot = await prisma.contentSlot.findFirst({ where: { itemId } });
  if (!slot) return [];
  const note = async (status: string, text: string | null) =>
    prisma.contentSlot.update({ where: { id: slot.id }, data: { status, note: text?.slice(0, 300) ?? null } }).catch(() => undefined);
  const item = await prisma.contentItem.findUnique({ where: { id: itemId }, select: { status: true, kind: true, merchantId: true } });
  if (!item || item.status !== 'APPROVED') return [];
  const setting = await getContentSetting(slot.merchantId);
  if (!setting.autoSchedule) {
    await note('APPROVED', '자동 예약 꺼짐 — 승인됨. 게시 예약은 콘텐츠 화면에서 직접 해 주세요.');
    return [];
  }
  if (slot.slotAt.getTime() <= now.getTime()) {
    await note('APPROVED', '슬롯 시각이 지나 자동 예약하지 않았습니다.');
    return [];
  }
  if (!env.automation.socialPublishEnabled) {
    await note('APPROVED', 'SNS 자동 게시가 열리지 않아 예약하지 않았습니다(내려받아 직접 게시).');
    return [];
  }
  const channels = await prisma.socialChannel.findMany({ where: { merchantId: slot.merchantId, status: 'CONNECTED', platform: { in: setting.platforms } } });
  const targets = channels.map((c) => c.platform).filter((p) => PLATFORM_KINDS[p].includes(item.kind));
  if (targets.length === 0) {
    await note('APPROVED', '연결된 자동 게시 채널 중 이 형식을 올릴 곳이 없습니다.');
    return [];
  }
  try {
    const created = await schedulePublish(slot.merchantId, itemId, targets, slot.slotAt);
    await note('SCHEDULED', `${created.map((p) => PLATFORM_LABEL[p]).join(' · ')} 예약`);
    return created;
  } catch (e) {
    await note('APPROVED', `자동 예약 실패: ${(e as Error).message}`);
    return [];
  }
}

export async function archiveContent(merchantId: string, id: string) {
  await ownItem(merchantId, id);
  await prisma.contentPublish.updateMany({ where: { itemId: id, status: 'SCHEDULED' }, data: { status: 'CANCELED' } });
  await prisma.contentSlot.updateMany({ where: { merchantId, itemId: id }, data: { status: 'ARCHIVED', note: '보관됨' } });
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

export const SOCIAL_OAUTH_NOT_READY = '실연동에서는 계정 이름만으로 연결하지 않습니다. SNS 채널 화면의 "계정 로그인으로 연결"(OAuth 동의 화면)로 연결해 주세요. 연결 키가 없는 플랫폼은 승인된 콘텐츠를 내려받아 직접 올려 주세요.';

export async function connectSocialChannel(merchantId: string, platform: SocialPlatform, accountName: string, userId: string) {
  const name = accountName.trim();
  if (!/^[@\p{L}\p{N}_. -]{2,40}$/u.test(name)) throw new ContentError('계정 이름은 2~40자로 입력해 주세요.');
  const adapter = getSnsAdapter();
  const mock = adapter.info().mode === 'mock';
  // 실연동에서는 OAuth 동의 화면을 거쳐 토큰을 받아야 연결이다. 그 흐름이 아직 없으므로 연결을 거절한다
  // (계정 이름만으로 '연결됨'을 꾸미거나 자리표시자 토큰을 저장하지 않는다 — 절대 규칙 2). mock 은 토큰 없이 연결 표시만 한다.
  if (!mock) throw new ContentError(SOCIAL_OAUTH_NOT_READY);
  return prisma.socialChannel.upsert({
    where: { merchantId_platform: { merchantId, platform } },
    create: { id: newId(), merchantId, platform, accountName: name, status: 'CONNECTED', mock: true, connectedBy: userId, accessTokenEnc: null },
    update: { accountName: name, status: 'CONNECTED', mock: true, connectedBy: userId, connectedAt: new Date(), accessTokenEnc: null, refreshTokenEnc: null },
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
    if (!connected.has(p)) throw new ContentError(`${PLATFORM_LABEL[p] ?? p} 채널이 연결되어 있지 않습니다.`);
    if (!PLATFORM_KINDS[p].includes(item.kind)) throw new ContentError(`${PLATFORM_LABEL[p] ?? p} 에는 이 형식을 올릴 수 없습니다.`);
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
  const post = await renderPlatformPost(p.item, p.platform, { publishId: p.id });
  try {
    const res = await getSnsAdapter().publish({
      platform: p.platform,
      ...(await socialPublishAuth(channel)),
      caption: post.text,
      title: post.title ?? p.item.title,
      assets: scenes.map((s) => s.svg),
      kind: p.item.kind,
      videoUrl: p.item.videoUrl,
    });
    if (!res.ok || !res.data) return fail(res.message ?? '게시에 실패했습니다.');
    await prisma.contentPublish.update({
      where: { id: p.id },
      data: { status: res.data.status, mock: res.data.mock, externalPostId: res.data.externalPostId, url: res.data.url, publishedAt: new Date(), error: null },
    });
    const left = await prisma.contentPublish.count({ where: { itemId: p.itemId, status: { in: ['SCHEDULED', 'PUBLISHING'] } } });
    if (left === 0) await prisma.contentItem.update({ where: { id: p.itemId }, data: { status: 'PUBLISHED' } });
    await emitDomainEventSafe({
      merchantId: p.item.merchantId, type: 'content.published', subjectType: 'content_publish', subjectId: p.id,
      payload: { itemId: p.itemId, platform: p.platform, mock: res.data.mock, url: res.data.url ?? null },
    });
    return 'PUBLISHED' as const;
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** 게시 중(PUBLISHING) 상태가 이보다 오래 갱신이 없으면 게시 도중 멈춘 것으로 본다. */
export const PUBLISHING_STALE_MS = 30 * 60_000;

/** 이 시각보다 오래 갱신이 없는 PUBLISHING 은 멈춘 것으로 본다(관리자 화면 표시용). */
export function stalePublishingBefore(now = new Date()) {
  return new Date(now.getTime() - PUBLISHING_STALE_MS);
}

/**
 * 게시 도중 멈춘 건(프로세스 종료·타임아웃) 복구. 결과를 모르므로 다시 예약으로 되돌리되,
 * 시도 횟수를 다 썼으면 실패로 닫는다. 조건부 갱신이라 그 사이 끝난 게시는 건드리지 않는다.
 * 공급자에 실제로 올라갔을 수 있으므로 사유에 "이미 올라갔는지 확인" 을 남긴다.
 */
export async function recoverStalePublishing(now = new Date()) {
  const threshold = new Date(now.getTime() - PUBLISHING_STALE_MS);
  const note = '게시 도중 응답이 끊겨 결과를 확인하지 못했습니다. 채널에 이미 올라갔는지 확인해 주세요.';
  const failed = await prisma.contentPublish.updateMany({
    where: { status: 'PUBLISHING', updatedAt: { lt: threshold }, attempts: { gte: PUBLISH_MAX_ATTEMPTS } },
    data: { status: 'FAILED', error: note },
  });
  const requeued = await prisma.contentPublish.updateMany({
    where: { status: 'PUBLISHING', updatedAt: { lt: threshold }, attempts: { lt: PUBLISH_MAX_ATTEMPTS } },
    data: { status: 'SCHEDULED', scheduledAt: now, error: note },
  });
  return { requeued: requeued.count, failed: failed.count };
}

/** 배치: 멈춘 생성 재개 → 멈춘 게시 복구 → 예약 게시 → 지표 수집 */
export async function processContentQueue(now = new Date()) {
  const result = { resumed: 0, published: 0, retried: 0, failed: 0, deferred: 0, metrics: 0, recovered: 0 };
  const threshold = new Date(now.getTime() - STUCK_GENERATING_MS);
  const stuck = await prisma.contentItem.findMany({
    where: { status: 'GENERATING', updatedAt: { lt: threshold } },
    select: { id: true },
    take: 20,
  });
  for (const s of stuck) {
    // 재개 전에 선점한다. 그 사이 다른 실행(요청 안의 생성·겹친 배치)이 갱신했으면 건너뛴다.
    const claim = await prisma.contentItem.updateMany({ where: { id: s.id, status: 'GENERATING', updatedAt: { lt: threshold } }, data: { updatedAt: new Date() } });
    if (claim.count === 0) continue;
    await runContentPipeline(s.id);
    result.resumed += 1;
  }
  const rec = await recoverStalePublishing(now);
  result.recovered = rec.requeued + rec.failed;
  result.failed += rec.failed;
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
    const m = await collectSocialMetrics(p).catch(() => null);
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
