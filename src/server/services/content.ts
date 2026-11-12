import { createHash } from 'node:crypto';
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
import { SNS_AUTH_EXPIRED } from '@/server/adapters/sns/live';
import type { ContentKind, SocialPlatform } from '@/generated/prisma/enums';
import { getObject, objectNameFromUrl } from '@/server/uploads';
import { collectSocialMetrics, markChannelExpired, SocialTokenExpiredError, socialPublishAuth } from './social-oauth';
import { goLink } from './content-clicks';
import { campaignStats } from './fundraising';
import { monthRange } from './monthly-notice';
import { recordAiUsage } from './ai-usage';
import { adaptCaption, captionProblem, composeFromVariant, LINK_TOKEN, postToText, type PlatformPost } from './content-captions';
import { ownedPostingId } from './volunteer-postings';
import { CONTENT_REJECT_REASON_LABEL } from '@/lib/content-review';
import { contentWinHints } from './content-performance';

/**
 * 콘텐츠 자동 생성 → 검토 → 승인 → (SNS 게시) 파이프라인.
 *
 * 단계: SCRIPT(대본) → SCENES(장면 이미지) → VOICE(음성) → ASSEMBLE(영상 조립) → COVER(표지)
 *  - (콘텐츠, 단계) 당 작업 기록 1행. 이미 끝난 단계는 다시 돌리지 않는다 — 같은 단계를 두 번 과금하지 않는다.
 *  - 모든 산출물에 "AI 생성 콘텐츠" 표시, 기관에 모집등록번호가 있으면 함께 넣는다.
 *  - 모집등록번호가 없으면 생성·내려받기는 되지만 승인(=기관 명의 게시)은 막는다(기부금품법 모집 표시).
 *  - 기관 명의로 나가는 게시물이라 **항상 사람이 승인해야 게시된다**(2026-11-09 대표 결정 — 자동 승인 없음, autoApprove 는 무시).
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
  UNKNOWN: '결과 미확인(확인 필요)',
  PUBLISHED: '게시됨',
  PRIVATE_UPLOADED: '비공개 업로드(공개 전환 필요)',
  FAILED: '실패',
  CANCELED: '취소',
};

const TONES: Tone[] = ['WARM', 'HOPEFUL', 'CALM', 'URGENT'];
type Step = 'SCRIPT' | 'SCENES' | 'VOICE' | 'ASSEMBLE' | 'COVER';
// 담당자 수정 뒤 재조립은 REASSEMBLE_STEP('REASSEMBLE') — 아래 재조립 절.
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
    abTestEnabled: false,
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
  /** 2안 비교(A/B) — 주지 않으면 바꾸지 않는다(2026-11-11 G) */
  abTestEnabled?: boolean;
}

export async function saveContentSetting(
  merchantId: string,
  /** autoApprove 는 받아도 무시한다(2026-11-09 — 항상 사람 승인). 호환을 위해 인자만 남긴다. */
  input: { tone: string; bannedWords: string[]; autoApprove?: boolean; hashtags: string[]; calendar?: CalendarSettingInput },
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
        ...(typeof c.abTestEnabled === 'boolean' ? { abTestEnabled: c.abTestEnabled } : {}),
      }
    : {};
  const data = { tone, bannedWords: banned, autoApprove: false, hashtags: tags, ...calendar };
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
const artworkCache = new Map<number, string | null>();
/** 직접 제작한 기본 일러스트만 쓴다. 캠페인에 올린 수혜자 사진을 SNS로 재사용하지 않는다. */
async function campaignArtwork(title: string): Promise<string | null> {
  const index = /아이|아동|학교|교육/.test(title) ? 2 : /어르신|노인/.test(title) ? 3 : /돌봄|이웃/.test(title) ? 5 : 1;
  if (artworkCache.has(index)) return artworkCache.get(index)!;
  let uri: string | null = null;
  try {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const sharp = await loadSharp();
    const source = await fs.readFile(path.join(process.cwd(), 'public', 'assets', 'givesign', 'presets', `banner-${index}.webp`));
    const png = sharp ? await sharp(source).resize(1080, 608, { fit: 'cover' }).png().toBuffer() : null;
    if (png) uri = `data:image/png;base64,${png.toString('base64')}`;
  } catch { /* 일러스트가 없어도 텍스트 지면으로 만든다. */ }
  if (uri) artworkCache.set(index, uri);
  return uri;
}
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
  artwork: string | null = null,
): Scene[] {
  const format = kindFormat(kind);
  return captions.map((s, i) => ({
    caption: s.caption,
    durationSec: s.durationSec,
    ...(s.label ? { label: s.label } : {}),
    ...(typeof s.progress === 'number' ? { progress: s.progress } : {}),
    svg: renderSceneSvg({ caption: s.caption, index: i, total: captions.length, merchantName, color, footer: aiFooter(regNo), format, label: s.label, progress: s.progress, logo, artwork }),
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
    // 수정 요청 한 줄·반려 이유 학습(2026-11-09). LLM 공급자만 문장에 반영하고 mock 은 무시한다(요청은 콘텐츠 메모로 남는다).
    brief.revisionRequest = item.revisionRequest ?? null;
    brief.avoid = await contentAvoidHints(item.merchantId);
    // 최근 90일 성과 상위 요소(게시 10건 이상일 때만) — 프롬프트 "잘된 것"(2026-11-11 G). mock 은 저장·표시만.
    brief.wins = await contentWinHints(item.merchantId);
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
      scenes = renderScenes(script.scenes, kind, brief.merchantName, color, brief.regNo, logo, await campaignArtwork(brief.campaignTitle));
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
    if (!(await jobDone(itemId, 'COVER'))) await recordJob(itemId, 'COVER', 'givesign-svg', 'DONE', { from: 'scene-1' });

    const setting = await getContentSetting(item.merchantId);
    const tags = [...new Set([...script.hashtags, ...setting.hashtags])].slice(0, 12);
    const regNoIncluded = Boolean(brief.regNo);
    const caption = buildCaptionTemplate({ summary: brief.summary, campaignTitle: brief.campaignTitle, moNumber: brief.moNumber, keyword: brief.keyword, regNo: brief.regNo, tags });
    // LLM 이 쓴 플랫폼별 본문에 시스템이 문자 안내·링크·해시태그·AI 표시를 붙여 완성본으로 저장한다(mock 은 저장하지 않고 규칙 기반).
    const platformCaptions = script.platformCaptions ? composeStoredCaptions(script.platformCaptions, { moLines: moLines(brief.moNumber, brief.keyword), tags, footer: aiFooter(brief.regNo) }) : null;
    // 자동 승인은 없다(2026-11-09 대표 결정). 생성 결과는 항상 검토 대기이고, 사전 점검 결과는 승인 화면이 보여 준다(content-review.ts).
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
        coverSvg: scenes[0]!.svg,
        aiLabeled: true,
        regNoIncluded,
        costKrw: { increment: cost },
        status: 'REVIEW',
        approvedBy: null,
        approvedAt: null,
        error: null,
      },
    });
    if (finished.count === 0) logger.warn('콘텐츠 생성 결과를 반영하지 않음 — 이미 다른 실행이 끝냈습니다', { itemId });
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

/**
 * 캡션 {링크} 자리에 들어갈 수 있는 가장 긴 링크 길이. 게시 링크(/go/게시 id)와 후원페이지 링크(유입 경로 포함) 중 긴 쪽.
 * 캡션 길이를 이 값으로 맞춰야 치환 뒤에도 "AI 생성 콘텐츠·모집등록번호·링크" 꼬리가 잘리지 않는다(2026-11-06 점검 A-M10).
 */
export function captionLinkReserve(): number {
  const id = 'X'.repeat(26);
  return Math.max(goLink(id).length, `${env.baseUrl}/donate/${'X'.repeat(16)}/campaigns/${id}?${attributionQuery('NAVER_BLOG', id)}`.length);
}

/** LLM 플랫폼 변형 → 링크 자리({링크})가 남은 완성 캡션 */
function composeStoredCaptions(
  variants: Record<string, { title?: string; body: string }>,
  common: { moLines: string[]; tags: string[]; footer: string },
): Record<string, PlatformPost> {
  const out: Record<string, PlatformPost> = {};
  for (const [k, v] of Object.entries(variants)) {
    if (!Object.hasOwn(PLATFORM_LABEL, k) || !v || typeof v.body !== 'string') continue;
    out[k] = composeFromVariant(k as SocialPlatform, v, common, captionLinkReserve());
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
  const post = stored && typeof stored.text === 'string' ? stored : adaptCaption(base, platform, undefined, Math.max(link.length, captionLinkReserve()));
  const out = { title: post.title ?? null, text: post.text.replace(LINK_TOKEN, link) };
  // 예전 규칙으로 저장된 캡션이 실제 링크로 바꾼 뒤 길이를 넘으면, 꼬리를 고정한 채 본문만 다시 줄인다(자르지 않음).
  if (captionProblem(platform, out)) {
    const refit = adaptCaption(postToText(post), platform, undefined, link.length);
    return { title: refit.title ?? out.title, text: refit.text.replace(LINK_TOKEN, link) };
  }
  return out;
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

/**
 * 반려·수정 요청 이유 학습(2026-11-09) — 기관의 최근 20개를 "피해야 할 것" 문장으로 요약한다. 메모는 저장 때 이미 가렸다.
 * LLM 프롬프트에만 쓰고 로그에 남기지 않는다.
 */
export async function contentAvoidHints(merchantId: string): Promise<string[]> {
  const rows = await prisma.contentFeedback
    .findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' }, take: 20, select: { kind: true, reasonCode: true, note: true } })
    .catch(() => []);
  if (rows.length === 0) return [];
  const counts = new Map<string, number>();
  for (const r of rows) if (r.reasonCode) counts.set(r.reasonCode, (counts.get(r.reasonCode) ?? 0) + 1);
  const out = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${CONTENT_REJECT_REASON_LABEL[code as keyof typeof CONTENT_REJECT_REASON_LABEL] ?? code} 때문에 반려된 적이 있음(${n}회)`);
  const notes = [...new Set(rows.map((r) => r.note?.trim()).filter((n): n is string => Boolean(n)))].slice(0, 6);
  for (const n of notes) out.push(n.slice(0, 80));
  return out.slice(0, 10);
}

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
    await campaignArtwork(item.title),
  );
  // 숏폼 영상은 요청 안에서 다시 조립하지 않는다(수십 초 — 2026-11-12 결정). 재조립 작업을 쌓고
  // 응답 뒤(after)·배치(`reassembleQueuedVideos`)가 만든다. 준비되는 동안 승인은 막힌다(`approveContent`).
  // 작업 행을 먼저 잡고(배치의 마무리와 같은 순서) 콘텐츠를 바꾼다.
  return prisma.$transaction(async (tx) => {
    if (item.kind === 'SHORTFORM') {
      const output = { hash: scenesHash(scenes), attempts: 0 };
      await tx.contentJob.upsert({
        where: { itemId_step: { itemId: id, step: REASSEMBLE_STEP } },
        create: { id: newId(), itemId: id, step: REASSEMBLE_STEP, status: 'QUEUED', provider: getContentAdapter().info().provider, output },
        update: { status: 'QUEUED', provider: getContentAdapter().info().provider, output, error: null, costKrw: 0 },
      });
    }
    return tx.contentItem.update({
    where: { id },
    data: {
      scenes: scenes as unknown as object,
      script: captions.join('\n'),
      caption: input.caption.slice(0, 2000),
      // 담당자가 고친 캡션이 기준이 된다. 플랫폼별 캡션은 고친 캡션에서 규칙으로 다시 만든다.
      platformCaptions: Prisma.DbNull,
      // 장면 글이 바뀌었으므로 예전 자막으로 조립한 영상은 쓰지 않는다(새 영상은 재조립 작업이 채운다).
      videoUrl: null,
      coverSvg: scenes[0]!.svg,
      status: 'REVIEW',
      approvedAt: null,
      approvedBy: null,
      error: null,
    },
    });
  });
}

// ---------------------------------------------------------------------------
// 숏폼 영상 재조립 (담당자 수정 뒤 — 2026-11-12)
// ---------------------------------------------------------------------------

/** 재조립 작업 단계 이름(content_job.step). 처음 생성의 ASSEMBLE 기록과 따로 둔다. */
export const REASSEMBLE_STEP = 'REASSEMBLE';
/** 예외로 끝난 재조립의 재시도 상한. 넘으면 FAILED — 승인은 풀리고 영상 없는 숏폼은 예전처럼 예약이 막힌다. */
export const REASSEMBLE_MAX_ATTEMPTS = 3;
/** RUNNING 이 이보다 오래면 멈춘 것으로 보고 다시 잡는다. */
const REASSEMBLE_LEASE_MS = 10 * 60_000;

function scenesHash(scenes: Array<Pick<Scene, 'svg' | 'durationSec'>>): string {
  return createHash('sha256').update(JSON.stringify(scenes.map((s) => [s.svg, s.durationSec]))).digest('hex');
}

export type VideoRebuildState = 'NONE' | 'PREPARING' | 'FAILED';

/** 화면 표시·승인 판단용. PREPARING = 대기·조립 중(멈춘 RUNNING 도 다시 잡힐 때까지 준비 중으로 본다). */
export async function videoRebuildState(itemId: string): Promise<VideoRebuildState> {
  const job = await prisma.contentJob.findUnique({ where: { itemId_step: { itemId, step: REASSEMBLE_STEP } }, select: { status: true } });
  if (!job) return 'NONE';
  if (job.status === 'QUEUED' || job.status === 'RUNNING') return 'PREPARING';
  if (job.status === 'FAILED') return 'FAILED';
  return 'NONE';
}

type ReassembleOutcome = 'DONE' | 'NO_VIDEO' | 'SKIPPED' | 'STALE' | 'RETRY' | 'FAILED';

/**
 * 한 콘텐츠의 재조립. 선점(QUEUED 또는 멈춘 RUNNING → RUNNING) → 조립 → 마무리(작업 행 FOR UPDATE 후
 * 아직 RUNNING 이고 장면 해시가 같을 때만 영상 주소를 넣는다). 조립 중에 담당자가 다시 고치면 작업이
 * QUEUED·새 해시로 바뀌어 이 결과는 버려지고 다음 실행이 새 장면으로 만든다.
 */
export async function reassembleContentVideo(itemId: string, now = new Date()): Promise<ReassembleOutcome> {
  const claimed = await prisma.contentJob.updateMany({
    where: { itemId, step: REASSEMBLE_STEP, OR: [{ status: 'QUEUED' }, { status: 'RUNNING', updatedAt: { lt: new Date(now.getTime() - REASSEMBLE_LEASE_MS) } }] },
    data: { status: 'RUNNING' },
  });
  if (claimed.count === 0) return 'SKIPPED';
  const job = await prisma.contentJob.findUnique({ where: { itemId_step: { itemId, step: REASSEMBLE_STEP } } });
  const item = await prisma.contentItem.findUnique({ where: { id: itemId }, select: { kind: true, scenes: true } });
  const meta = (job?.output ?? {}) as { hash?: string; attempts?: number };
  const attempts = Number(meta.attempts ?? 0);
  const scenes = (item?.scenes ?? []) as unknown as Scene[];
  if (!job || !item || item.kind !== 'SHORTFORM' || scenesHash(scenes) !== meta.hash) {
    // 콘텐츠가 사라졌거나 숏폼이 아니거나 장면이 작업 기록과 다르다 — 영상을 만들지 않고 닫는다.
    await prisma.contentJob.updateMany({ where: { itemId, step: REASSEMBLE_STEP, status: 'RUNNING' }, data: { status: 'DONE', error: '장면이 바뀌어 재조립을 건너뜀' } });
    return 'STALE';
  }
  let result: Awaited<ReturnType<ReturnType<typeof getContentAdapter>['assemble']>>;
  try {
    result = await getContentAdapter().assemble({ scenes, audio: null });
  } catch (e) {
    const next = attempts + 1;
    const failed = next >= REASSEMBLE_MAX_ATTEMPTS;
    await prisma.contentJob.updateMany({
      where: { itemId, step: REASSEMBLE_STEP, status: 'RUNNING' },
      data: { status: failed ? 'FAILED' : 'QUEUED', output: { hash: meta.hash, attempts: next }, error: (e as Error).message.slice(0, 300) },
    });
    logger.warn('숏폼 영상 재조립 실패', { itemId, attempts: next, message: (e as Error).message.slice(0, 160) });
    return failed ? 'FAILED' : 'RETRY';
  }
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: string; output: { hash?: string } | null }>>`
      SELECT status, output FROM content_job WHERE item_id = ${itemId} AND step = ${REASSEMBLE_STEP} FOR UPDATE`;
    const cur = rows[0];
    if (!cur || cur.status !== 'RUNNING' || cur.output?.hash !== meta.hash) return 'STALE' as const;
    if (result.videoUrl) {
      await tx.contentItem.updateMany({ where: { id: itemId, videoUrl: null }, data: { videoUrl: result.videoUrl } });
    }
    await tx.contentJob.update({
      where: { itemId_step: { itemId, step: REASSEMBLE_STEP } },
      data: { status: 'DONE', costKrw: result.costKrw ?? 0, output: { hash: meta.hash, attempts, note: result.note, available: result.available, videoUrl: result.videoUrl ?? null }, error: null },
    });
    return result.videoUrl ? ('DONE' as const) : ('NO_VIDEO' as const);
  });
}

/** 배치: 쌓인 재조립을 오래된 것부터 시간 상한 안에서 처리한다(이벤트 배치 1분·콘텐츠 배치 1시간). */
export async function reassembleQueuedVideos(opts: { limit?: number; budgetMs?: number; now?: Date } = {}) {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const out = { done: 0, noVideo: 0, retry: 0, failed: 0, stale: 0 };
  const jobs = await prisma.contentJob.findMany({
    where: { step: REASSEMBLE_STEP, OR: [{ status: 'QUEUED' }, { status: 'RUNNING', updatedAt: { lt: new Date(now.getTime() - REASSEMBLE_LEASE_MS) } }] },
    orderBy: { updatedAt: 'asc' },
    select: { itemId: true },
    take: opts.limit ?? 5,
  });
  for (const j of jobs) {
    if (opts.budgetMs && Date.now() - started > opts.budgetMs) break;
    const r = await reassembleContentVideo(j.itemId, now).catch((e) => {
      logger.error('숏폼 영상 재조립 처리 오류', { itemId: j.itemId, message: (e as Error).message.slice(0, 160) });
      return 'SKIPPED' as const;
    });
    if (r === 'DONE') out.done += 1;
    else if (r === 'NO_VIDEO') out.noVideo += 1;
    else if (r === 'RETRY') out.retry += 1;
    else if (r === 'FAILED') out.failed += 1;
    else if (r === 'STALE') out.stale += 1;
  }
  return out;
}

/**
 * 슬롯 시각이 지난 뒤 승인할 때의 예약 선택(2026-11-09).
 *  NEXT_SLOT = 캘린더 설정 기준 다음 빈 슬롯으로 옮겨 예약 · NOW = 지금 게시 예약 · APPROVE_ONLY = 승인만.
 *  (자동 예약 조건 — autoSchedule·SNS 게시 열림·연결 채널 — 은 셋 다 그대로 적용한다)
 */
export type PastSlotChoice = 'NEXT_SLOT' | 'NOW' | 'APPROVE_ONLY';

export async function approveContent(merchantId: string, id: string, userId: string, opts: { whenPast?: PastSlotChoice; now?: Date } = {}) {
  if (!userId || userId === 'AUTO' || userId === 'CALENDAR') throw new ContentError('담당자만 승인할 수 있습니다.');
  const item = await ownItem(merchantId, id);
  if (item.status !== 'REVIEW') throw new ContentError('검토 대기 중인 콘텐츠만 승인할 수 있습니다.');
  if (!item.aiLabeled) throw new ContentError('AI 생성 표시가 없는 콘텐츠는 승인할 수 없습니다.');
  // 수정한 자막으로 영상을 다시 만드는 중이면 승인하지 않는다 — 승인 때 예약이 영상 없는 숏폼을 건너뛰지 않게(2026-11-12).
  if (item.kind === 'SHORTFORM' && (await videoRebuildState(id)) === 'PREPARING') {
    throw new ContentError('수정한 자막으로 영상을 다시 만드는 중입니다. 영상이 준비되면(보통 1~2분) 승인해 주세요.');
  }
  if (!item.regNoIncluded) {
    throw new ContentError('기부금품 모집등록번호가 없어 승인할 수 없습니다. 기관 정보에 모집등록번호를 넣고 콘텐츠를 다시 만들어 주세요.');
  }
  // 연결한 소재(얼굴 소재는 초상권 동의서 필요, 수혜자 소재 금지)를 승인 때 다시 확인한다(2026-11-11 G).
  if (item.assetIds?.length) {
    const problem = await (await import('./content-assets')).contentAssetsProblem(merchantId, item.assetIds);
    if (problem) throw new ContentError(problem);
  }
  // 검토 대기일 때만 조건부로 바꾼다 — 두 사람이 동시에 눌러도 승인·이벤트·예약은 한 번(2026-11-09).
  const claimed = await prisma.contentItem.updateMany({ where: { id, merchantId, status: 'REVIEW' }, data: { status: 'APPROVED', approvedBy: userId, approvedAt: new Date() } });
  if (claimed.count === 0) throw new ContentError('이미 다른 담당자가 처리한 콘텐츠입니다.');
  const approved = await prisma.contentItem.findUniqueOrThrow({ where: { id } });
  await emitDomainEventSafe({
    merchantId, type: 'content.approved', subjectType: 'content_item', subjectId: id,
    payload: { kind: approved.kind, campaignId: approved.campaignId, approvedBy: 'USER' },
  });
  // 캘린더 슬롯 콘텐츠면, 슬롯이 아직 미래이고 자동 예약이 켜져 있을 때 그 시각으로 예약한다.
  // 슬롯이 지났으면 고른 대로(기본은 승인만 — 화면은 "다음 빈 슬롯" 을 기본으로 보낸다).
  const now = opts.now ?? new Date();
  const slot = await prisma.contentSlot.findFirst({ where: { itemId: id }, select: { id: true, slotAt: true } });
  if (slot && slot.slotAt.getTime() <= now.getTime() && opts.whenPast && opts.whenPast !== 'APPROVE_ONLY') {
    if (opts.whenPast === 'NOW') await autoScheduleSlotItem(id, now, { at: now });
    else {
      const { moveSlotToNextFree } = await import('./content-calendar');
      const moved = await moveSlotToNextFree(slot.id, now);
      if (moved) await autoScheduleSlotItem(id, now);
      else await prisma.contentSlot.update({ where: { id: slot.id }, data: { status: 'APPROVED', note: '다음 빈 슬롯을 찾지 못했습니다(캘린더 설정 확인). 승인됨 — 게시 예약은 직접 해 주세요.' } }).catch(() => undefined);
    }
  } else {
    await autoScheduleSlotItem(id, now);
  }
  // 2안 비교 묶음이면 두 안이 모두 승인됐을 때 나눠 예약한다(승인되지 않은 안은 예약하지 않음 — 2026-11-11 G).
  if (approved.variantGroupId) await (await import('./content-variants')).afterVariantDecision(id, now);
  return prisma.contentItem.findUniqueOrThrow({ where: { id } });
}

/**
 * 콘텐츠 캘린더 슬롯 자동 예약. 슬롯이 미래이고, 기관이 autoSchedule 을 켰고, SNS 게시가 열려 있으며,
 * 연결된 채널 중 설정 플랫폼·형식 허용인 곳이 있을 때만. 결과는 슬롯 메모로 남긴다. 실패가 승인을 되돌리지 않는다.
 */
export async function autoScheduleSlotItem(itemId: string, now = new Date(), opts: { at?: Date } = {}): Promise<SocialPlatform[]> {
  const slot = await prisma.contentSlot.findFirst({ where: { itemId } });
  if (!slot) return [];
  // 캠페인 기간이 줄거나 종료돼 보류된 슬롯은 자동 예약하지 않는다(2026-11-12 4차 I — 보류 상태 유지)
  if (slot.status === 'HELD') return [];
  const note = async (status: string, text: string | null) =>
    prisma.contentSlot.update({ where: { id: slot.id }, data: { status, note: text?.slice(0, 300) ?? null } }).catch(() => undefined);
  const item = await prisma.contentItem.findUnique({ where: { id: itemId }, select: { status: true, kind: true, merchantId: true } });
  if (!item || item.status !== 'APPROVED') return [];
  const setting = await getContentSetting(slot.merchantId);
  if (!setting.autoSchedule) {
    await note('APPROVED', '자동 예약 꺼짐 — 승인됨. 게시 예약은 콘텐츠 화면에서 직접 해 주세요.');
    return [];
  }
  // at 을 주면(슬롯이 지난 뒤 "지금 게시 예약") 그 시각으로 예약한다.
  const at = opts.at ?? slot.slotAt;
  if (!opts.at && slot.slotAt.getTime() <= now.getTime()) {
    await note('APPROVED', '슬롯 시각이 지나 자동 예약하지 않았습니다.');
    return [];
  }
  if (!env.automation.socialPublishEnabled) {
    await note('APPROVED', 'SNS 자동 게시가 열리지 않아 예약하지 않았습니다(내려받아 직접 게시).');
    return [];
  }
  const channels = await prisma.socialChannel.findMany({ where: { merchantId: slot.merchantId, status: 'CONNECTED', platform: { in: setting.platforms }, ...publishableChannelWhere() } });
  const full = await prisma.contentItem.findUnique({ where: { id: itemId }, select: { videoUrl: true } });
  const targets = channels.map((c) => c.platform).filter((p) => PLATFORM_KINDS[p].includes(item.kind) && !needsVideo(item.kind, full?.videoUrl));
  if (targets.length === 0) {
    await note('APPROVED', '연결된 자동 게시 채널 중 이 형식을 올릴 곳이 없습니다.');
    return [];
  }
  try {
    const created = await schedulePublish(slot.merchantId, itemId, targets, at);
    await note('SCHEDULED', `${created.map((p) => PLATFORM_LABEL[p]).join(' · ')} 예약${opts.at ? ' (지금 게시)' : ''}`);
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

function snsIsMockNow() {
  return getSnsAdapter().info().mode === 'mock';
}

/**
 * 게시에 쓸 수 있는 채널 조건. 실연동이면 mock 시절 연결(토큰 없음)은 제외한다 — 예약했다가 배치에서
 * 토큰 없음으로 실패하는 대신 다시 연결하라고 알린다(2026-11-06 점검 낮음). mock 공급자면 mock 연결만.
 */
function publishableChannelWhere() {
  return { mock: snsIsMockNow() };
}

/** 숏폼은 영상 파일이 있어야 어느 플랫폼에도 올릴 수 있다(장면 이미지로 대신하지 않는다). */
function needsVideo(kind: ContentKind, videoUrl: string | null | undefined) {
  return kind === 'SHORTFORM' && !videoUrl;
}

export async function schedulePublish(merchantId: string, id: string, platforms: SocialPlatform[], at: Date) {
  if (!env.automation.socialPublishEnabled) {
    throw new ContentError('SNS 자동 게시가 아직 열리지 않았습니다(플랫폼 심사 전). 승인된 콘텐츠를 내려받아 직접 올려 주세요.');
  }
  const item = await ownItem(merchantId, id);
  if (!['APPROVED', 'SCHEDULED', 'PUBLISHED'].includes(item.status)) throw new ContentError('승인된 콘텐츠만 게시할 수 있습니다.');
  if (platforms.length === 0) throw new ContentError('게시할 채널을 골라 주세요.');
  const channels = await prisma.socialChannel.findMany({ where: { merchantId, platform: { in: platforms }, status: 'CONNECTED', ...publishableChannelWhere() } });
  const connected = new Set(channels.map((c) => c.platform));
  const created: SocialPlatform[] = [];
  for (const p of platforms) {
    if (!connected.has(p)) throw new ContentError(`${PLATFORM_LABEL[p] ?? p} 채널이 연결되어 있지 않습니다.${snsIsMockNow() ? '' : ' (mock 시절 연결은 실연동 게시에 쓸 수 없어 다시 연결해야 합니다)'}`);
    if (!PLATFORM_KINDS[p].includes(item.kind)) throw new ContentError(`${PLATFORM_LABEL[p] ?? p} 에는 이 형식을 올릴 수 없습니다.`);
    // 영상이 없는 숏폼을 영상 플랫폼에 예약하면 배치에서 세 번 실패하고 끝난다 — 예약 단계에서 막는다(2026-11-06 점검 낮음).
    if (needsVideo(item.kind, item.videoUrl)) throw new ContentError(`${PLATFORM_LABEL[p] ?? p}: 숏폼 영상 파일이 없어 예약할 수 없습니다. 영상 생성 상태와 FFmpeg 설치를 확인한 뒤 다시 만들어 주세요.`);
    const existing = await prisma.contentPublish.findUnique({ where: { itemId_platform: { itemId: id, platform: p } } });
    // 결과 미확인(UNKNOWN)은 실제로 올라갔을 수 있다 — 예약으로 덮지 않고 "다시 게시"/"게시됨으로 표시" 로만 푼다.
    if (existing && ['PUBLISHED', 'PRIVATE_UPLOADED', 'PUBLISHING', 'UNKNOWN'].includes(existing.status)) continue;
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

/**
 * 콘텐츠의 게시가 모두 끝났으면 콘텐츠 상태를 맞춘다. 하나라도 올라갔으면 PUBLISHED,
 * 남은 예약·진행·미확인이 없고 하나도 올라가지 않았으면 APPROVED 로 되돌린다(SCHEDULED 에 남지 않게 — 2026-11-06 점검 낮음).
 */
async function settleItemStatus(itemId: string) {
  const rows = await prisma.contentPublish.groupBy({ by: ['status'], where: { itemId }, _count: { _all: true } });
  const n = (st: string[]) => rows.filter((r) => st.includes(r.status)).reduce((a, r) => a + r._count._all, 0);
  if (n(['SCHEDULED', 'PUBLISHING', 'UNKNOWN']) > 0) return;
  const next = n(['PUBLISHED', 'PRIVATE_UPLOADED']) > 0 ? 'PUBLISHED' : 'APPROVED';
  await prisma.contentItem.updateMany({ where: { id: itemId, status: { in: ['SCHEDULED', 'PUBLISHED'] } }, data: { status: next } });
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
  /**
   * 게시 실패 처리. **PUBLISHING 일 때만** 바꾼다(2026-11-06 점검 A-M8) — 이미 성공으로 기록됐거나 다른 경로가 바꾼 행을
   * 예약으로 되돌려 다시 올리는 일이 없게. noRetry 면(토큰 만료·검증 실패) 재시도 없이 실패로 닫는다.
   */
  const fail = async (message: string, opts: { noRetry?: boolean } = {}) => {
    const retry = !opts.noRetry && p.attempts < PUBLISH_MAX_ATTEMPTS;
    const r = await prisma.contentPublish.updateMany({
      where: { id: p.id, status: 'PUBLISHING' },
      data: retry
        ? { status: 'SCHEDULED', scheduledAt: new Date(now.getTime() + 30 * 60_000), error: message.slice(0, 300) }
        : { status: 'FAILED', error: message.slice(0, 300) },
    });
    if (r.count === 0) return 'SKIPPED' as const;
    if (!retry) await settleItemStatus(p.itemId).catch(() => undefined);
    return retry ? ('RETRY' as const) : ('FAILED' as const);
  };
  if (!channel || channel.status !== 'CONNECTED') return fail('채널 연결이 끊겼습니다. SNS 채널을 다시 연결해 주세요.', { noRetry: channel?.status === 'EXPIRED' || channel?.status === 'REVOKED' });
  if (!snsIsMockNow() && channel.mock) return fail('mock 시절 연결이라 실제로 올릴 수 없습니다. SNS 채널에서 계정 로그인으로 다시 연결해 주세요.', { noRetry: true });
  if (needsVideo(p.item.kind, p.item.videoUrl)) return fail('올릴 영상 파일이 없습니다. (영상 조립 공급자 연동 전에는 숏폼 영상이 만들어지지 않습니다)', { noRetry: true });
  if (p.platform === 'INSTAGRAM') {
    const recent = await prisma.contentPublish.count({
      where: { platform: 'INSTAGRAM', status: { in: ['PUBLISHED', 'PRIVATE_UPLOADED'] }, publishedAt: { gte: new Date(now.getTime() - 86_400_000) }, item: { merchantId: p.item.merchantId } },
    });
    if (recent >= INSTAGRAM_DAILY_LIMIT) {
      await prisma.contentPublish.updateMany({ where: { id: p.id, status: 'PUBLISHING' }, data: { status: 'SCHEDULED', scheduledAt: new Date(now.getTime() + 3600_000), attempts: { decrement: 1 }, error: '인스타그램 24시간 게시 한도(50건) — 1시간 뒤 다시 시도' } });
      return 'DEFERRED' as const;
    }
  }
  const scenes = (p.item.scenes as unknown as Scene[]) ?? [];
  // 공급자 호출 전 단계 — 여기서 난 예외는 아직 아무것도 올리지 않았으므로 실패 처리(재시도)로 돌린다.
  let post: PlatformPost;
  let auth: Awaited<ReturnType<typeof socialPublishAuth>>;
  try {
    post = await renderPlatformPost(p.item, p.platform, { publishId: p.id });
    // 링크·AI 표시·모집등록번호를 자르지 않는다. 넘치면 검증 실패로 닫는다(A-M10, 어댑터는 자르지 않음).
    const problem = captionProblem(p.platform, post);
    if (problem) return fail(problem, { noRetry: true });
    auth = await socialPublishAuth(channel);
  } catch (e) {
    // 토큰 갱신 실패는 refreshIfNeeded 가 채널을 만료로 바꿨다 — 재시도해도 같은 결과다(A-M12).
    return fail((e as Error).message, { noRetry: e instanceof SocialTokenExpiredError });
  }
  let res;
  try {
    res = await getSnsAdapter().publish({
      platform: p.platform,
      ...auth,
      caption: post.text,
      title: post.title ?? p.item.title,
      assets: scenes.map((s) => s.svg),
      kind: p.item.kind,
      videoUrl: p.item.videoUrl,
    });
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!res.ok || !res.data) {
    if (res.code === SNS_AUTH_EXPIRED) {
      // 게시 중 토큰 폐기 — 채널을 만료로 바꾸고(기관 알림) 재시도하지 않는다(2026-11-06 점검 A-M12).
      await markChannelExpired(channel, res.message ?? '게시 중 인증 만료').catch((e) => logger.error('SNS 채널 만료 처리 실패', { message: (e as Error).message }));
      return fail(`${res.message ?? '인증이 만료되었습니다.'} SNS 채널을 다시 연결해 주세요.`, { noRetry: true });
    }
    return fail(res.message ?? '게시에 실패했습니다.');
  }
  // ---- 여기부터는 이미 올라갔다. 아래 기록이 실패해도 예약으로 되돌리지 않는다(A-M8 — 중복 게시 방지). ----
  const data = res.data;
  try {
    await prisma.contentPublish.updateMany({
      where: { id: p.id, status: 'PUBLISHING' },
      data: { status: data.status, mock: data.mock, externalPostId: data.externalPostId, url: data.url, publishedAt: new Date(), error: null },
    });
  } catch (e) {
    // 성공 기록이 안 됐다 — PUBLISHING 으로 남고, 고착 복구가 UNKNOWN 으로 닫아 담당자가 확인한다(자동 재게시 없음).
    logger.error('SNS 게시 성공 기록 실패 — 결과 미확인으로 남깁니다', { publishId: p.id, externalPostId: data.externalPostId, message: (e as Error).message });
    await prisma.contentPublish
      .updateMany({ where: { id: p.id, status: 'PUBLISHING' }, data: { status: 'UNKNOWN', externalPostId: data.externalPostId, url: data.url, error: '게시는 성공했지만 기록에 실패했습니다. 채널에서 확인 후 "게시됨으로 표시" 해 주세요.' } })
      .catch(() => undefined);
    return 'PUBLISHED' as const;
  }
  await settleItemStatus(p.itemId).catch((e) => logger.error('콘텐츠 상태 갱신 실패', { itemId: p.itemId, message: (e as Error).message }));
  await emitDomainEventSafe({
    merchantId: p.item.merchantId, type: 'content.published', subjectType: 'content_publish', subjectId: p.id,
    payload: { itemId: p.itemId, platform: p.platform, mock: data.mock, url: data.url ?? null },
  });
  return 'PUBLISHED' as const;
}

/** 게시 중(PUBLISHING) 상태가 이보다 오래 갱신이 없으면 게시 도중 멈춘 것으로 본다. */
export const PUBLISHING_STALE_MS = 30 * 60_000;

/** 이 시각보다 오래 갱신이 없는 PUBLISHING 은 멈춘 것으로 본다(관리자 화면 표시용). */
export function stalePublishingBefore(now = new Date()) {
  return new Date(now.getTime() - PUBLISHING_STALE_MS);
}

/**
 * 게시 도중 멈춘 건(프로세스 종료·타임아웃) 정리. 공급자에 실제로 올라갔을 수 있으므로 **자동으로 다시 올리지 않는다**
 * (2026-11-06 점검 A-M9). 결과 미확인(UNKNOWN)으로 닫고, 담당자가 채널을 확인한 뒤
 * "다시 게시"(resolveUnknownPublish REPUBLISH) 또는 "게시됨으로 표시"(MARK_PUBLISHED)를 고른다. 조건부 갱신이라 그 사이 끝난 게시는 건드리지 않는다.
 */
export async function recoverStalePublishing(now = new Date()) {
  const threshold = new Date(now.getTime() - PUBLISHING_STALE_MS);
  const note = '게시 도중 응답이 끊겨 결과를 확인하지 못했습니다. 채널에 이미 올라갔는지 확인한 뒤 "다시 게시" 또는 "게시됨으로 표시" 를 골라 주세요.';
  const stale = await prisma.contentPublish.findMany({ where: { status: 'PUBLISHING', updatedAt: { lt: threshold } }, select: { id: true }, take: 200 });
  let unknown = 0;
  for (const s of stale) {
    const r = await prisma.contentPublish.updateMany({ where: { id: s.id, status: 'PUBLISHING', updatedAt: { lt: threshold } }, data: { status: 'UNKNOWN', error: note } });
    unknown += r.count;
  }
  return { unknown };
}

/**
 * 결과 미확인 게시 정리(기관 담당자). REPUBLISH = 지금 다시 예약(시도 횟수 초기화), MARK_PUBLISHED = 채널에서 확인했으니 게시됨으로.
 * UNKNOWN 일 때만 조건부로 바꾼다.
 */
export async function resolveUnknownPublish(merchantId: string, publishId: string, action: 'REPUBLISH' | 'MARK_PUBLISHED', input: { url?: string | null; now?: Date } = {}) {
  const p = await prisma.contentPublish.findFirst({ where: { id: publishId, item: { merchantId } } });
  if (!p) throw new ContentError('게시 기록을 찾을 수 없습니다.');
  const now = input.now ?? new Date();
  if (action === 'REPUBLISH') {
    if (!env.automation.socialPublishEnabled) throw new ContentError('SNS 자동 게시가 열려 있지 않습니다.');
    const r = await prisma.contentPublish.updateMany({ where: { id: p.id, status: 'UNKNOWN' }, data: { status: 'SCHEDULED', scheduledAt: now, attempts: 0, error: null } });
    if (r.count === 0) throw new ContentError('결과 미확인 상태의 게시만 다시 게시할 수 있습니다.');
    await prisma.contentItem.updateMany({ where: { id: p.itemId, status: { in: ['APPROVED', 'PUBLISHED'] } }, data: { status: 'SCHEDULED' } });
    return 'SCHEDULED' as const;
  }
  const url = input.url?.trim() || null;
  if (url && !/^https:\/\/[^\s]{4,500}$/.test(url)) throw new ContentError('게시물 주소는 https:// 로 시작해야 합니다.');
  const r = await prisma.contentPublish.updateMany({
    where: { id: p.id, status: 'UNKNOWN' },
    data: { status: 'PUBLISHED', publishedAt: p.publishedAt ?? now, url: url ?? p.url, error: null },
  });
  if (r.count === 0) throw new ContentError('결과 미확인 상태의 게시만 게시됨으로 표시할 수 있습니다.');
  await settleItemStatus(p.itemId);
  return 'PUBLISHED' as const;
}

/** 배치: 멈춘 생성 재개 → 멈춘 게시 복구 → 예약 게시 → 지표 수집 */
/**
 * 예약 게시 실행(2026-11-13 점검 A-M5). 예약 시각이 된 게시물을 올리고, 30분 넘게 멈춘 게시는 결과 미확인으로 닫는다.
 * 5분 배치(content-publish)와 1시간 배치(content)가 함께 부른다 — 예약 → 게시 중 전환이 조건부 갱신이라 겹쳐도 한 번만 올린다.
 */
export async function publishDueContent(now = new Date(), opts: { limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const out = { recovered: 0, published: 0, retried: 0, failed: 0, deferred: 0 };
  out.recovered = (await recoverStalePublishing(now)).unknown;
  if (!env.automation.socialPublishEnabled) return out;
  const due = await prisma.contentPublish.findMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: now } }, select: { id: true }, orderBy: { scheduledAt: 'asc' }, take: opts.limit ?? 50 });
  for (const d of due) {
    if (opts.budgetMs && Date.now() - started > opts.budgetMs) break;
    const r = await publishOne(d.id, now);
    if (r === 'PUBLISHED') out.published += 1;
    else if (r === 'RETRY') out.retried += 1;
    else if (r === 'FAILED') out.failed += 1;
    else if (r === 'DEFERRED') out.deferred += 1;
  }
  return out;
}

export async function processContentQueue(now = new Date()) {
  const result = { resumed: 0, published: 0, retried: 0, failed: 0, deferred: 0, metrics: 0, recovered: 0, reassembled: 0 };
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
  // 담당자 수정 뒤 쌓인 숏폼 영상 재조립(응답 뒤 실행이 끊긴 것 포함)
  const videos = await reassembleQueuedVideos({ limit: 10, budgetMs: 300_000, now });
  result.reassembled = videos.done + videos.noVideo;
  // 예약 게시는 5분 배치(/api/cron/content-publish)가 주로 맡고, 여기서는 놓친 것만 함께 올린다(선점이 조건부라 겹쳐도 한 번).
  const pub = await publishDueContent(now);
  result.recovered = pub.recovered;
  result.published = pub.published;
  result.retried = pub.retried;
  result.failed = pub.failed;
  result.deferred = pub.deferred;
  // 지표 수집: 100건 상한 — 오래 갱신되지 않은 것부터(2026-11-13 점검 A-L4, 정렬이 없어 일부가 영영 갱신되지 않을 수 있었다)
  const live = await prisma.contentPublish.findMany({
    where: { status: { in: ['PUBLISHED', 'PRIVATE_UPLOADED'] }, mock: false, publishedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
    orderBy: [{ metricsAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
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
