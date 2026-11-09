import { prisma } from '@/server/db';
import type { Prisma } from '@/generated/prisma/client';
import type { ContentKind } from '@/generated/prisma/enums';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { featureContentEnabled } from '@/lib/env';
import { formatWon } from '@/lib/money';
import { campaignProgress, campaignSchema, reservedKeywordKind, type CampaignInput } from '@/lib/fundraising';
import { normalizeKeyword } from './content-filter';
import { campaignEnded } from './campaign-after-end';

export { campaignEnded, campaignThanksText, endedCampaignRejecting, endedCampaignRejectingSafe } from './campaign-after-end';
import { CampaignCodeTakenError, campaignStats } from './fundraising';
import { calendarSlots, DEFAULT_CALENDAR_KINDS, formatSlot } from './content-calendar';
import { thanksDraftViolation } from './ai-drafts';
import { donationPageUrl } from './qr';
import { notifyUser } from './notifications';
import { requestApproval, registerApprovalHandler, type ApprovalRow } from './approvals';
import { registerConsumer, type StoredDomainEvent } from './events';
import type { InboxExceptionGroup } from './inbox-groups';

/**
 * 캠페인 전 과정 연결 (2026-11-12 4차 과제 I1).
 *
 *  - 개설 마법사: 제목·목표·기간·용도·대표 사진 한 번으로 캠페인 카드(후원페이지)·문자 키워드·QR(캠페인 QR — 행 없음, 주소만)·
 *    콘텐츠 일정 초안(기간 동안 주 N건 슬롯 `content_slot.status = PLANNED` — 콘텐츠는 배치가 슬롯 7일 전부터 만들어 **검토 대기**로)·
 *    감사 문구(AI 초안 규칙 — 입력칸만 채움)·종료 후 처리 방침·결과 보고 예정일을 **한 트랜잭션**으로 만든다.
 *    같은 제출(setup_key)은 두 번 처리하지 않는다. 외부 호출(콘텐츠 생성)은 트랜잭션 밖 배치에서만.
 *  - 종료 후 들어온 후원(after_end_policy): GENERAL(기본, 예전 동작 — 기관 일반 후원) · REJECT(결제를 만들지 않고 안내 문자만).
 *    다른 캠페인으로 옮기는 선택지는 없다. 지정 목적 변경은 후원자가 직접 고르게 안내한다.
 *  - 변경 영향 미리보기: 기간 연장·단축·목표 변경·종료 전에 후원페이지 문구·예약 콘텐츠·문자 키워드·결과 보고 예정일 영향을 계산하고
 *    확인한 뒤 같은 계산으로 반영한다. 기간 밖이 된 슬롯의 미게시 콘텐츠는 보류(HELD — 지우지 않음, 예약 게시 취소).
 *  - 목표 달성(기존 campaign.goal_reached) → 감사·결과 안내 준비를 승인 요청으로 제안(자동 발송 없음).
 *  - 기간 70% 경과 + 진행률 < 기간 비율 × 60% → 기관 알림 + 주간 보고 제안(캠페인당 1회, pace_alert_at 조건부 선점).
 *  - 결과 보고 예정일이 되면 승인 대기함 묶음 "결과 보고 작성"(3차 H 사업 결과 보고 화면으로).
 */

const DAY = 86_400_000;
export const AFTER_END_POLICIES = ['GENERAL', 'REJECT'] as const;
export type AfterEndPolicy = (typeof AFTER_END_POLICIES)[number];
export const AFTER_END_LABEL: Record<AfterEndPolicy, string> = {
  GENERAL: '기관 일반 후원으로 받기',
  REJECT: '받지 않고 안내만',
};
export const AFTER_END_DESCRIPTION: Record<AfterEndPolicy, string> = {
  GENERAL: '모금이 끝난 뒤 이 캠페인 키워드로 온 문자·후원은 기관 일반 후원으로 받습니다(지금과 같은 동작). 후원 화면에도 그렇게 안내합니다.',
  REJECT: '모금이 끝난 뒤 이 캠페인 키워드로 온 문자는 후원으로 처리하지 않고 "모금이 끝났다" 는 안내 문자만 보냅니다. 후원 화면에는 후원 버튼 대신 안내를 보입니다.',
};
export const RESULT_REPORT_DEFAULT_DAYS = 30;
export const CONTENT_PLAN_MAX_WEEKLY = 7;
export const CONTENT_PLAN_MAX_SLOTS = 120;
/** 슬롯 시각이 이만큼 가까워지면 배치가 콘텐츠를 만든다(검토 대기) */
export const PLANNED_LOOKAHEAD_DAYS = 7;
/** 배치 1회 생성 상한(전 기관 합) */
const PLANNED_MAX_PER_RUN = 20;
/** 진행 속도 규칙 */
export const PACE_ELAPSED_RATIO = 0.7;
export const PACE_PROGRESS_FACTOR = 0.6;

export class CampaignSetupError extends Error {}

export function isAfterEndPolicy(v: unknown): v is AfterEndPolicy {
  return typeof v === 'string' && (AFTER_END_POLICIES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// 날짜(KST)
// ---------------------------------------------------------------------------

const dateKey = (d: Date) => d.toISOString().slice(0, 10);
export const kstStartMs = (key: string) => Date.parse(`${key}T00:00:00+09:00`);
export const kstEndMs = (key: string) => Date.parse(`${key}T23:59:59.999+09:00`);
export function kstTodayKey(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}
export function addDaysKey(key: string, days: number) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
const dateCol = (key: string) => new Date(`${key}T00:00:00Z`);
const isDateKey = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && dateKey(new Date(`${v}T00:00:00Z`)) === v;


// ---------------------------------------------------------------------------
// 콘텐츠 일정 슬롯
// ---------------------------------------------------------------------------

export interface ContentPlanRule {
  weeklyCount: number;
  postHour: number;
}

export function readContentPlan(v: unknown): ContentPlanRule | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const weeklyCount = Math.round(Number(o.weeklyCount));
  const postHour = Math.round(Number(o.postHour));
  if (!Number.isFinite(weeklyCount) || weeklyCount < 1 || weeklyCount > CONTENT_PLAN_MAX_WEEKLY) return null;
  if (!Number.isFinite(postHour) || postHour < 0 || postHour > 23) return null;
  return { weeklyCount, postHour };
}

/**
 * 기간(KST 시작일~종료일, 양끝 포함) 안의 콘텐츠 슬롯 시각. 지금 이후만, 상한 CONTENT_PLAN_MAX_SLOTS.
 * 요일은 주당 건수로 고르게(캘린더와 같은 퍼뜨리기), 시각은 postHour(KST).
 */
export function plannedSlotTimes(rule: ContentPlanRule, fromKey: string, toKey: string, now = new Date()): Date[] {
  const start = Math.max(now.getTime(), kstStartMs(fromKey) - 1);
  const end = kstEndMs(toKey);
  if (!(end > start)) return [];
  const days = Math.ceil((end - start) / DAY) + 1;
  return calendarSlots({ weeklyCount: rule.weeklyCount, days: [], postHour: rule.postHour }, new Date(start), days)
    .filter((s) => s.getTime() <= end && s.getTime() > now.getTime())
    .slice(0, CONTENT_PLAN_MAX_SLOTS);
}

async function slotKinds(merchantId: string): Promise<ContentKind[]> {
  const s = await prisma.merchantContentSetting.findUnique({ where: { merchantId }, select: { kinds: true } }).catch(() => null);
  return s?.kinds?.length ? s.kinds : DEFAULT_CALENDAR_KINDS;
}

// ---------------------------------------------------------------------------
// 개설 마법사
// ---------------------------------------------------------------------------

export interface CampaignPlanInput {
  /** 제출 키(화면을 열 때 만든 값) — 같은 제출은 한 번만 */
  setupKey: string;
  campaign: CampaignInput;
  /** 저장하면서 모금 시작(ACTIVE) */
  startNow: boolean;
  afterEndPolicy: AfterEndPolicy;
  /** 콘텐츠 일정(빼면 null) */
  content: ContentPlanRule | null;
  /** 이 캠페인 감사 문자(빼면 null) */
  thanksMessage: string | null;
  /** 결과 보고 예정일(빼면 null) */
  resultReportDueOn: string | null;
}

export interface CampaignPlanPreview {
  keyword: { code: string; ok: boolean; message: string };
  qr: { url: string; note: string };
  page: string[];
  content: { slots: Array<{ at: Date; label: string; taken: boolean }>; willCreate: number; taken: number; blockers: string[] } | null;
  thanks: { ok: boolean; message: string } | null;
  resultReportDueOn: string | null;
  afterEnd: { policy: AfterEndPolicy; text: string };
  problems: string[];
}

export function defaultResultReportDue(endsOn: string) {
  return addDaysKey(endsOn, RESULT_REPORT_DEFAULT_DAYS);
}

/** 개설 전 확인. 저장하지 않는다. 같은 계산을 저장(createCampaignFromPlan)에서도 다시 한다. */
export async function previewCampaignPlan(merchantId: string, input: CampaignPlanInput, now = new Date()): Promise<CampaignPlanPreview> {
  const problems: string[] = [];
  const c = input.campaign;
  const dup = await keywordTaken(merchantId, c.code);
  const keyword = {
    code: c.code,
    ok: !dup,
    message: dup ? `이미 '${c.code}' 키워드를 쓰는 캠페인이 있습니다. 다른 키워드를 입력해 주세요.` : `기관 문자 번호로 "${c.code} 응원 메시지" 처럼 보내면 이 캠페인 후원이 됩니다(모금 기간 안).`,
  };
  if (dup) problems.push(keyword.message);
  const org = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { code: true, fundraisingRegNo: true } });
  if (input.startNow) {
    const mo = await prisma.merchantMoNumber.count({ where: { merchantId, status: 'ASSIGNED' } });
    if (mo === 0) problems.push('배정된 MO 번호가 없어 바로 모금을 시작할 수 없습니다. "바로 모금 시작" 을 끄고 저장해 주세요.');
  }
  const page = [
    `후원페이지 캠페인 카드: "${c.title}" · 목표 ${formatWon(BigInt(c.goalAmount))} · ${c.startsOn} ~ ${c.endsOn}`,
    input.startNow ? '저장하면 바로 모금 중으로 공개됩니다.' : '작성 중으로 저장합니다. 캠페인 화면에서 "모금 시작" 을 눌러야 공개됩니다.',
  ];
  let content: CampaignPlanPreview['content'] = null;
  if (input.content) {
    const slots = plannedSlotTimes(input.content, c.startsOn, c.endsOn, now);
    const taken = new Set(
      slots.length ? (await prisma.contentSlot.findMany({ where: { merchantId, slotAt: { in: slots } }, select: { slotAt: true } })).map((r) => r.slotAt.getTime()) : [],
    );
    const blockers: string[] = [];
    if (!featureContentEnabled()) blockers.push('콘텐츠 기능이 꺼져 있어 슬롯만 잡고 콘텐츠는 만들지 않습니다.');
    if (!org.fundraisingRegNo) blockers.push('기부금품 모집등록번호가 없어 콘텐츠를 만들 수 없습니다. 기관 정보에 넣으면 그때부터 만듭니다.');
    if (!input.startNow) blockers.push('콘텐츠는 모금을 시작한 뒤 슬롯 7일 전부터 만듭니다.');
    content = {
      slots: slots.map((at) => ({ at, label: formatSlot(at), taken: taken.has(at.getTime()) })),
      willCreate: slots.filter((s) => !taken.has(s.getTime())).length,
      taken: taken.size,
      blockers,
    };
    if (slots.length === 0) content.blockers.push('기간 안에 남은 슬롯이 없습니다(이미 지난 기간).');
  }
  let thanks: CampaignPlanPreview['thanks'] = null;
  if (input.thanksMessage != null) {
    const bad = thanksDraftViolation(input.thanksMessage);
    thanks = bad ? { ok: false, message: `감사 문구: ${bad}` } : { ok: true, message: '이 캠페인 후원에는 이 감사 문자가 나갑니다(비우면 기관 기본 감사 문구).' };
    if (bad) problems.push(thanks.message);
  }
  if (input.resultReportDueOn && input.resultReportDueOn < c.endsOn) problems.push('결과 보고 예정일은 종료일 이후로 정해 주세요.');
  return {
    keyword,
    qr: { url: donationPageUrl(org.code), note: '캠페인 QR 은 저장하면 바로 생깁니다(캠페인 상세 주소 + ?src=qr — QR 코드 화면·캠페인 화면에서 내려받기).' },
    page,
    content,
    thanks,
    resultReportDueOn: input.resultReportDueOn,
    afterEnd: { policy: input.afterEndPolicy, text: AFTER_END_DESCRIPTION[input.afterEndPolicy] },
    problems,
  };
}

async function keywordTaken(merchantId: string, code: string, exceptId?: string) {
  const token = normalizeKeyword(code);
  const rows = await prisma.campaign.findMany({ where: { merchantId, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { code: true } });
  return rows.some((r) => normalizeKeyword(r.code) === token);
}

export interface CampaignPlanResult {
  campaignId: string;
  created: boolean;
  slotsCreated: number;
  slotsSkipped: number;
}

/**
 * 마법사 저장. 캠페인·콘텐츠 일정 슬롯을 한 트랜잭션으로 만든다 — 중간에 실패하면 아무것도 남지 않는다.
 * 같은 setupKey 로 다시 부르면 처음 만든 캠페인을 돌려준다(created=false, 슬롯을 더 만들지 않음).
 */
export async function createCampaignFromPlan(merchantId: string, input: CampaignPlanInput, now = new Date()): Promise<CampaignPlanResult> {
  const setupKey = input.setupKey.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(setupKey)) throw new CampaignSetupError('제출 키가 올바르지 않습니다. 화면을 새로 고쳐 주세요.');
  const existing = await prisma.campaign.findUnique({ where: { setupKey }, select: { id: true, merchantId: true } });
  if (existing) {
    if (existing.merchantId !== merchantId) throw new CampaignSetupError('제출 키가 올바르지 않습니다. 화면을 새로 고쳐 주세요.');
    return { campaignId: existing.id, created: false, slotsCreated: 0, slotsSkipped: 0 };
  }
  const parsed = campaignSchema.safeParse(input.campaign);
  if (!parsed.success) throw new CampaignSetupError(parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.');
  const c = parsed.data;
  if (!isAfterEndPolicy(input.afterEndPolicy)) throw new CampaignSetupError('종료 후 처리 방침을 골라 주세요.');
  if (input.thanksMessage != null) {
    const bad = thanksDraftViolation(input.thanksMessage);
    if (bad) throw new CampaignSetupError(`감사 문구: ${bad}`);
  }
  if (input.resultReportDueOn != null) {
    if (!isDateKey(input.resultReportDueOn)) throw new CampaignSetupError('결과 보고 예정일을 확인해 주세요.');
    if (input.resultReportDueOn < c.endsOn) throw new CampaignSetupError('결과 보고 예정일은 종료일 이후로 정해 주세요.');
  }
  if (await keywordTaken(merchantId, c.code)) throw new CampaignCodeTakenError();
  if (input.startNow) {
    const mo = await prisma.merchantMoNumber.count({ where: { merchantId, status: 'ASSIGNED' } });
    if (mo === 0) throw new CampaignSetupError('배정된 MO 번호가 없어 문자 후원을 받을 수 없습니다. "바로 모금 시작" 을 끄고 저장하거나 관리자에게 번호 배정을 요청해 주세요.');
  }
  const slots = input.content ? plannedSlotTimes(input.content, c.startsOn, c.endsOn, now) : [];
  const kinds = slots.length ? await slotKinds(merchantId) : DEFAULT_CALENDAR_KINDS;
  const id = newId();
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.campaign.create({
        data: {
          id,
          merchantId,
          code: c.code,
          title: c.title,
          summary: c.summary,
          story: c.story || null,
          beneficiary: c.beneficiary || null,
          usagePlan: c.usagePlan || null,
          imageUrl: c.imageUrl || null,
          goalAmount: BigInt(c.goalAmount),
          startsOn: dateCol(c.startsOn),
          endsOn: dateCol(c.endsOn),
          featured: c.featured,
          status: input.startNow ? 'ACTIVE' : 'DRAFT',
          afterEndPolicy: input.afterEndPolicy,
          thanksMessage: input.thanksMessage,
          resultReportDueOn: input.resultReportDueOn ? dateCol(input.resultReportDueOn) : null,
          contentPlan: input.content ? (input.content as unknown as Prisma.InputJsonValue) : undefined,
          setupKey,
        },
      });
      let slotsCreated = 0;
      if (slots.length) {
        const r = await tx.contentSlot.createMany({
          data: slots.map((at, i) => ({ id: newId(), merchantId, slotAt: at, kind: kinds[i % kinds.length]!, campaignId: id, status: 'PLANNED', note: '캠페인 콘텐츠 일정 — 슬롯 7일 전부터 만들어 검토 대기로 올립니다.' })),
          skipDuplicates: true,
        });
        slotsCreated = r.count;
      }
      return { campaignId: id, created: true, slotsCreated, slotsSkipped: slots.length - slotsCreated };
    });
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') {
      const again = await prisma.campaign.findUnique({ where: { setupKey }, select: { id: true, merchantId: true } });
      if (again && again.merchantId === merchantId) return { campaignId: again.id, created: false, slotsCreated: 0, slotsSkipped: 0 };
      throw new CampaignCodeTakenError();
    }
    throw e;
  }
}

/** 마법사 입력(폼) 정리 — 키워드 예약어·중복은 저장 때 다시 본다. */
export function campaignPlanFromForm(f: {
  setupKey: string; code: string; title: string; summary: string; usagePlan: string; imageUrl: string; goalAmount: string; startsOn: string; endsOn: string;
  startNow: boolean; featured: boolean; afterEndPolicy: string;
  includeContent: boolean; weeklyCount: string; postHour: string;
  includeThanks: boolean; thanksMessage: string;
  includeReport: boolean; resultReportDueOn: string;
}): { ok: true; input: CampaignPlanInput } | { ok: false; message: string } {
  const parsed = campaignSchema.safeParse({
    code: f.code, title: f.title, summary: f.summary || f.title, usagePlan: f.usagePlan, imageUrl: f.imageUrl,
    goalAmount: f.goalAmount.replace(/,/g, ''), startsOn: f.startsOn, endsOn: f.endsOn, featured: f.featured,
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.' };
  if (reservedKeywordKind(parsed.data.code)) return { ok: false, message: '예약어는 키워드로 쓸 수 없습니다.' };
  const policy = isAfterEndPolicy(f.afterEndPolicy) ? f.afterEndPolicy : 'GENERAL';
  let content: ContentPlanRule | null = null;
  if (f.includeContent) {
    content = readContentPlan({ weeklyCount: f.weeklyCount, postHour: f.postHour });
    if (!content) return { ok: false, message: `콘텐츠 일정은 주 1~${CONTENT_PLAN_MAX_WEEKLY}건, 게시 시각 0~23시로 정해 주세요.` };
  }
  const thanks = f.includeThanks ? f.thanksMessage.trim() : null;
  if (f.includeThanks && !thanks) return { ok: false, message: '감사 문구를 적거나 체크를 빼 주세요.' };
  const due = f.includeReport ? (f.resultReportDueOn.trim() || defaultResultReportDue(parsed.data.endsOn)) : null;
  if (due != null && !isDateKey(due)) return { ok: false, message: '결과 보고 예정일을 확인해 주세요.' };
  return {
    ok: true,
    input: { setupKey: f.setupKey, campaign: parsed.data, startNow: f.startNow, afterEndPolicy: policy, content, thanksMessage: thanks, resultReportDueOn: due },
  };
}

// ---------------------------------------------------------------------------
// 종료 후 후원 처리
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 변경 영향 미리보기 · 반영
// ---------------------------------------------------------------------------

export interface CampaignChange {
  endsOn?: string | null;
  goalAmount?: number | null;
  close?: boolean;
}

/** 아직 게시되지 않은 슬롯 상태(보류 대상) */
const HOLDABLE_SLOT = ['PLANNED', 'GENERATING', 'REVIEW', 'APPROVED', 'SCHEDULED', 'FAILED'];

export interface CampaignChangeImpact {
  before: { endsOn: string; goalAmount: bigint; status: string; resultReportDueOn: string | null };
  after: { endsOn: string; goalAmount: bigint; status: string; resultReportDueOn: string | null };
  page: string[];
  keyword: string[];
  content: { upcoming: number; review: number; hold: number; holdReview: number; restore: number; add: number };
  resultReport: string;
  goalReset: boolean;
  problems: string[];
  /** 반영할 때 그대로 쓰는 값(화면에 보인 숫자와 같게) */
  plan: { holdIds: string[]; restoreIds: string[]; addTimes: Date[] };
}

function readChange(c: { endsOn: Date; goalAmount: bigint; status: string; startsOn: Date }, change: CampaignChange) {
  const endsOn = change.endsOn ? change.endsOn : dateKey(c.endsOn);
  const goal = change.goalAmount != null ? BigInt(Math.round(change.goalAmount)) : c.goalAmount;
  return { endsOn, goal, close: Boolean(change.close) };
}

async function loadCampaign(db: Prisma.TransactionClient | typeof prisma, merchantId: string, id: string) {
  const c = await db.campaign.findFirst({ where: { id, merchantId } });
  if (!c) throw new CampaignSetupError('캠페인을 찾을 수 없습니다.');
  return c;
}

async function computeImpact(db: Prisma.TransactionClient | typeof prisma, merchantId: string, campaignId: string, change: CampaignChange, now: Date): Promise<CampaignChangeImpact> {
  const c = await loadCampaign(db, merchantId, campaignId);
  const { endsOn, goal, close } = readChange(c, change);
  const problems: string[] = [];
  const startKey = dateKey(c.startsOn);
  const oldEnd = dateKey(c.endsOn);
  if (!isDateKey(endsOn) || endsOn < startKey) problems.push('종료일은 시작일 이후의 올바른 날짜로 정해 주세요.');
  if (goal < 10_000n) problems.push('목표 금액은 1만원 이상이어야 합니다.');
  if (close && c.status !== 'ACTIVE') problems.push('모금 중인 캠페인만 종료할 수 있습니다.');
  if (c.status === 'ARCHIVED') problems.push('보관된 캠페인은 바꿀 수 없습니다. 먼저 복원해 주세요.');
  const stats = (await campaignStats([c.id])).get(c.id)!;
  const nextStatus = close ? 'CLOSED' : c.status;
  const today = kstTodayKey(now);

  const page: string[] = [];
  const keyword: string[] = [];
  const policy = isAfterEndPolicy(c.afterEndPolicy) ? c.afterEndPolicy : 'GENERAL';
  const afterText = policy === 'REJECT' ? '후원으로 받지 않고 "모금이 끝났다" 는 안내 문자만 보냅니다' : '기관 일반 후원으로 받습니다';
  const left = (k: string) => Math.max(0, Math.ceil((kstEndMs(k) - now.getTime()) / DAY));
  if (endsOn !== oldEnd) {
    page.push(`후원페이지 기간: ${dateKey(c.startsOn)} ~ ${oldEnd} → ${endsOn} (남은 기간 ${left(oldEnd)}일 → ${left(endsOn)}일)`);
    if (endsOn < today) page.push('새 종료일이 이미 지나 후원페이지에 "모금 기간이 아닙니다" 로 보입니다.');
    keyword.push(`문자 키워드 '${c.code}' 는 ${endsOn}까지 이 캠페인 후원으로 받고, 그 뒤에는 ${afterText}.`);
  }
  if (goal !== c.goalAmount) {
    page.push(`진행률: ${campaignProgress(stats.raised, c.goalAmount).percent}% → ${campaignProgress(stats.raised, goal).percent}% (목표 ${formatWon(c.goalAmount)} → ${formatWon(goal)}, 모인 금액 ${formatWon(stats.raised)})`);
    if (goal <= stats.raised) page.push('새 목표가 이미 모인 금액 이하라 후원페이지에 목표 달성으로 보입니다.');
  }
  if (close) {
    page.push(`후원페이지에 "모금 종료" 로 보입니다. 종료 후 후원: ${AFTER_END_LABEL[policy]}.`);
    keyword.push(`문자 키워드 '${c.code}' 로 오는 문자는 앞으로 ${afterText}.`);
  }
  // 목표를 모인 금액보다 높이면 목표 달성 표시를 지워 새 목표 달성 때 다시 알린다(기존 이벤트 규칙 그대로 1회)
  const goalReset = goal !== c.goalAmount && c.goalReachedAt != null && goal > stats.raised;
  if (goalReset) page.push('목표 달성 표시를 지웁니다. 새 목표에 닿으면 감사·결과 안내 준비를 다시 제안합니다.');

  // 콘텐츠 슬롯
  const effEnd = close ? now.getTime() : kstEndMs(endsOn);
  const slots = await db.contentSlot.findMany({ where: { campaignId: c.id, merchantId, slotAt: { gt: now } }, select: { id: true, slotAt: true, status: true, itemId: true } });
  const itemIds = slots.map((s) => s.itemId).filter((x): x is string => Boolean(x));
  const [items, published] = await Promise.all([
    itemIds.length ? db.contentItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, status: true } }) : Promise.resolve([]),
    itemIds.length ? db.contentPublish.findMany({ where: { itemId: { in: itemIds }, status: { in: ['PUBLISHED', 'PRIVATE_UPLOADED', 'PUBLISHING', 'UNKNOWN'] } }, select: { itemId: true } }) : Promise.resolve([]),
  ]);
  const itemStatus = new Map(items.map((i) => [i.id, i.status]));
  const publishedSet = new Set(published.map((p) => p.itemId));
  const unpublished = slots.filter((s) => HOLDABLE_SLOT.includes(s.status) && !(s.itemId && publishedSet.has(s.itemId)));
  const holdRows = unpublished.filter((s) => s.slotAt.getTime() > effEnd);
  const restoreRows = close ? [] : slots.filter((s) => s.status === 'HELD' && s.slotAt.getTime() <= effEnd);
  const plan = readContentPlan(c.contentPlan);
  let addTimes: Date[] = [];
  if (!close && plan && endsOn > oldEnd) {
    const candidates = plannedSlotTimes(plan, addDaysKey(oldEnd, 1), endsOn, now);
    const taken = new Set(candidates.length ? (await db.contentSlot.findMany({ where: { merchantId, slotAt: { in: candidates } }, select: { slotAt: true } })).map((r) => r.slotAt.getTime()) : []);
    addTimes = candidates.filter((t) => !taken.has(t.getTime()));
  }
  const review = unpublished.filter((s) => s.itemId && itemStatus.get(s.itemId) === 'REVIEW').length;

  // 결과 보고 예정일 — 종료일이 바뀌면 같은 날 수만큼 옮기고, 종료하는데 예정일이 없으면 오늘 + 30일
  const dueBefore = c.resultReportDueOn ? dateKey(c.resultReportDueOn) : null;
  let dueAfter = dueBefore;
  if (dueBefore && endsOn !== oldEnd) {
    const delta = Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${oldEnd}T00:00:00Z`)) / DAY);
    dueAfter = addDaysKey(dueBefore, delta);
  }
  if (close && !dueAfter) dueAfter = addDaysKey(today, RESULT_REPORT_DEFAULT_DAYS);
  const resultReport = dueBefore === dueAfter
    ? (dueAfter ? `결과 보고 예정일 ${dueAfter} (그대로)` : '결과 보고 예정일 없음')
    : `결과 보고 예정일 ${dueBefore ?? '없음'} → ${dueAfter}`;
  if (keyword.length === 0) keyword.push(`문자 키워드 '${c.code}' 는 바뀌지 않습니다.`);

  return {
    before: { endsOn: oldEnd, goalAmount: c.goalAmount, status: c.status, resultReportDueOn: dueBefore },
    after: { endsOn, goalAmount: goal, status: nextStatus, resultReportDueOn: dueAfter },
    page: page.length ? page : ['후원페이지 문구는 바뀌지 않습니다.'],
    keyword,
    content: {
      upcoming: unpublished.length,
      review,
      hold: holdRows.length,
      holdReview: holdRows.filter((s) => s.itemId && itemStatus.get(s.itemId) === 'REVIEW').length,
      restore: restoreRows.length,
      add: addTimes.length,
    },
    resultReport,
    goalReset,
    problems,
    plan: { holdIds: holdRows.map((s) => s.id), restoreIds: restoreRows.map((s) => s.id), addTimes },
  };
}

/** 변경 영향 미리보기(저장하지 않음) */
export async function campaignChangeImpact(merchantId: string, campaignId: string, change: CampaignChange, now = new Date()) {
  return computeImpact(prisma, merchantId, campaignId, change, now);
}

/**
 * 확인한 변경 반영. 캠페인 행을 잠그고 화면이 본 판(updatedAt)과 같을 때만 같은 계산으로 반영한다.
 * 보류 = 슬롯 HELD + 그 콘텐츠의 예약 게시 취소(콘텐츠·슬롯은 지우지 않음).
 */
export async function applyCampaignChange(merchantId: string, campaignId: string, change: CampaignChange, expectedUpdatedAt: string | null, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM campaign WHERE id = ${campaignId} AND merchant_id = ${merchantId} FOR UPDATE`;
    const cur = await loadCampaign(tx, merchantId, campaignId);
    if (expectedUpdatedAt && cur.updatedAt.toISOString() !== expectedUpdatedAt) {
      throw new CampaignSetupError('그사이 캠페인이 바뀌었습니다. 영향 미리보기를 다시 확인해 주세요.');
    }
    const impact = await computeImpact(tx, merchantId, campaignId, change, now);
    if (impact.problems.length) throw new CampaignSetupError(impact.problems[0]!);
    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        endsOn: dateCol(impact.after.endsOn),
        goalAmount: impact.after.goalAmount,
        status: impact.after.status as 'ACTIVE' | 'CLOSED' | 'DRAFT' | 'ARCHIVED',
        ...(change.close ? { closedAt: now } : {}),
        resultReportDueOn: impact.after.resultReportDueOn ? dateCol(impact.after.resultReportDueOn) : null,
        ...(impact.goalReset ? { goalReachedAt: null } : {}),
      },
    });
    if (impact.plan.holdIds.length) {
      const held = await tx.contentSlot.findMany({ where: { id: { in: impact.plan.holdIds } }, select: { id: true, itemId: true } });
      await tx.contentSlot.updateMany({
        where: { id: { in: impact.plan.holdIds }, status: { in: HOLDABLE_SLOT } },
        data: { status: 'HELD', note: change.close ? '캠페인 종료로 보류 — 게시하지 않습니다(콘텐츠는 남아 있음).' : '캠페인 기간이 줄어 보류 — 게시하지 않습니다(콘텐츠는 남아 있음).' },
      });
      const items = held.map((h) => h.itemId).filter((x): x is string => Boolean(x));
      if (items.length) {
        await tx.contentPublish.updateMany({ where: { itemId: { in: items }, status: 'SCHEDULED' }, data: { status: 'CANCELED' } });
        // 남은 예약·게시가 없으면 예약 상태의 콘텐츠를 승인됨으로 되돌린다(콘텐츠 자체는 지우지 않음)
        for (const itemId of items) {
          const live = await tx.contentPublish.count({ where: { itemId, status: { in: ['SCHEDULED', 'PUBLISHING', 'UNKNOWN', 'PUBLISHED', 'PRIVATE_UPLOADED'] } } });
          if (live === 0) await tx.contentItem.updateMany({ where: { id: itemId, status: 'SCHEDULED' }, data: { status: 'APPROVED' } });
        }
      }
    }
    if (impact.plan.restoreIds.length) {
      const rows = await tx.contentSlot.findMany({ where: { id: { in: impact.plan.restoreIds }, status: 'HELD' }, select: { id: true, itemId: true } });
      const st = rows.length ? new Map((await tx.contentItem.findMany({ where: { id: { in: rows.map((r) => r.itemId).filter((x): x is string => Boolean(x)) } }, select: { id: true, status: true } })).map((i) => [i.id, i.status])) : new Map<string, string>();
      for (const r of rows) {
        const s = r.itemId ? st.get(r.itemId) : null;
        const next = !r.itemId ? 'PLANNED' : s === 'REVIEW' ? 'REVIEW' : s === 'FAILED' ? 'FAILED' : s === 'ARCHIVED' ? 'ARCHIVED' : 'APPROVED';
        await tx.contentSlot.updateMany({ where: { id: r.id, status: 'HELD' }, data: { status: next, note: '기간 연장으로 보류를 풀었습니다. 게시 예약은 콘텐츠 화면에서 다시 해 주세요.' } });
      }
    }
    let added = 0;
    if (impact.plan.addTimes.length) {
      const kinds = await slotKinds(merchantId);
      const r = await tx.contentSlot.createMany({
        data: impact.plan.addTimes.map((at, i) => ({ id: newId(), merchantId, slotAt: at, kind: kinds[i % kinds.length]!, campaignId, status: 'PLANNED', note: '기간 연장으로 추가한 콘텐츠 일정' })),
        skipDuplicates: true,
      });
      added = r.count;
    }
    return { impact, added };
  });
}

// ---------------------------------------------------------------------------
// 계획 슬롯 → 콘텐츠(검토 대기) 배치
// ---------------------------------------------------------------------------

export interface PlannedRunResult {
  created: number;
  failed: number;
  waiting: number;
}

/**
 * 슬롯 시각이 7일 안으로 들어온 PLANNED 슬롯의 콘텐츠를 만든다(검토 대기 — 승인해야 게시). 모금 중·기간 안 캠페인만.
 * PLANNED → GENERATING 조건부 선점이라 겹쳐 도는 배치도 한 슬롯을 한 번만 만든다. 만들 수 없는 이유(모집등록번호 없음·한도)는
 * 슬롯을 PLANNED 로 되돌리고 메모로 남긴다(다음 배치가 다시 본다).
 */
export async function generatePlannedSlots(now = new Date()): Promise<PlannedRunResult> {
  const result: PlannedRunResult = { created: 0, failed: 0, waiting: 0 };
  if (!featureContentEnabled()) return result;
  const horizon = new Date(now.getTime() + PLANNED_LOOKAHEAD_DAYS * DAY);
  const rows = await prisma.contentSlot.findMany({
    where: { status: 'PLANNED', itemId: null, campaignId: { not: null }, slotAt: { gt: now, lte: horizon } },
    orderBy: { slotAt: 'asc' },
    take: 200,
    select: { id: true, merchantId: true, campaignId: true, kind: true, slotAt: true },
  });
  const { requestContent, ContentError } = await import('./content');
  for (const s of rows) {
    if (result.created + result.failed >= PLANNED_MAX_PER_RUN) break;
    const c = await prisma.campaign.findUnique({ where: { id: s.campaignId! }, select: { status: true, startsOn: true, endsOn: true } });
    const today = kstTodayKey(now);
    if (!c || c.status !== 'ACTIVE' || dateKey(c.startsOn) > today || dateKey(c.endsOn) < today) {
      result.waiting += 1;
      continue;
    }
    const claim = await prisma.contentSlot.updateMany({ where: { id: s.id, status: 'PLANNED', itemId: null }, data: { status: 'GENERATING', note: '콘텐츠 만드는 중' } });
    if (claim.count === 0) continue;
    try {
      const item = await requestContent({ merchantId: s.merchantId, campaignId: s.campaignId!, kind: s.kind, userId: 'CAMPAIGN_PLAN' });
      const status = item.status === 'REVIEW' ? 'REVIEW' : item.status === 'FAILED' ? 'FAILED' : item.status;
      // 그사이 보류(HELD)됐으면 상태는 보류 그대로 두고 콘텐츠만 잇는다
      const done = await prisma.contentSlot.updateMany({
        where: { id: s.id, status: 'GENERATING' },
        data: { itemId: item.id, status, note: item.status === 'FAILED' ? (item.error ?? '생성 실패').slice(0, 300) : '검토 대기 — 승인해야 게시됩니다.' },
      });
      if (done.count === 0) await prisma.contentSlot.updateMany({ where: { id: s.id }, data: { itemId: item.id } });
      if (item.status === 'FAILED') result.failed += 1;
      else result.created += 1;
    } catch (e) {
      const message = e instanceof ContentError ? e.message : '생성 중 오류가 발생했습니다.';
      logger.warn('캠페인 콘텐츠 일정 생성 보류', { merchantId: s.merchantId, message: (e as Error).message });
      await prisma.contentSlot.updateMany({ where: { id: s.id, status: 'GENERATING' }, data: { status: 'PLANNED', note: `아직 만들지 못함: ${message}`.slice(0, 300) } });
      result.waiting += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 진행 속도(70% 규칙)
// ---------------------------------------------------------------------------

/** 기간 경과 비율(0~1, 시작일~종료일 양끝 포함 KST 날짜 수 기준) */
export function elapsedRatio(startsOn: Date, endsOn: Date, now = new Date()) {
  const total = Math.round((Date.parse(`${dateKey(endsOn)}T00:00:00Z`) - Date.parse(`${dateKey(startsOn)}T00:00:00Z`)) / DAY) + 1;
  const done = Math.round((Date.parse(`${kstTodayKey(now)}T00:00:00Z`) - Date.parse(`${dateKey(startsOn)}T00:00:00Z`)) / DAY) + 1;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, done / total));
}

/** 70% 경과 + 진행률 < 경과 비율 × 60% */
export function paceBehind(input: { raised: bigint; goal: bigint; elapsed: number }) {
  if (input.goal <= 0n || input.elapsed < PACE_ELAPSED_RATIO) return false;
  const progress = Number((input.raised * 10_000n) / input.goal) / 10_000;
  return progress < input.elapsed * PACE_PROGRESS_FACTOR;
}

export async function runCampaignPaceCheck(now = new Date()): Promise<{ checked: number; alerted: number }> {
  const today = kstTodayKey(now);
  const rows = await prisma.campaign.findMany({
    where: { status: 'ACTIVE', paceAlertAt: null, goalAmount: { gt: 0n }, endsOn: { gte: dateCol(today) }, startsOn: { lte: dateCol(today) } },
    select: { id: true, merchantId: true, title: true, goalAmount: true, startsOn: true, endsOn: true },
    take: 500,
  });
  let alerted = 0;
  const stats = await campaignStats(rows.map((r) => r.id));
  for (const c of rows) {
    const elapsed = elapsedRatio(c.startsOn, c.endsOn, now);
    const raised = stats.get(c.id)?.raised ?? 0n;
    if (!paceBehind({ raised, goal: c.goalAmount, elapsed })) continue;
    const claimed = await prisma.campaign.updateMany({ where: { id: c.id, paceAlertAt: null }, data: { paceAlertAt: now } });
    if (claimed.count === 0) continue;
    alerted += 1;
    const pct = campaignProgress(raised, c.goalAmount).percent;
    const m = await prisma.merchantProfile.findUnique({ where: { id: c.merchantId }, select: { userId: true } });
    if (m) {
      await notifyUser({
        userId: m.userId,
        title: '캠페인 진행 속도 점검',
        body: `${c.title} — 기간 ${Math.round(elapsed * 100)}% 지났고 진행률 ${pct}%입니다. 기간 연장이나 캠페인 소식 콘텐츠 보강을 검토해 보세요.`,
        linkUrl: `/studio/campaigns/${c.id}`,
      }).catch((e) => logger.warn('진행 속도 알림 실패', { message: (e as Error).message }));
    }
  }
  return { checked: rows.length, alerted };
}

/** 주간 보고 제안(최근 7일 안에 진행 속도 알림을 받은 모금 중 캠페인) — 개인정보 없음 */
export async function campaignPaceSuggestions(merchantId: string, now = new Date()) {
  const rows = await prisma.campaign.findMany({
    where: { merchantId, status: 'ACTIVE', paceAlertAt: { gte: new Date(now.getTime() - 7 * DAY) } },
    select: { id: true, title: true, goalAmount: true, startsOn: true, endsOn: true },
    take: 5,
  });
  if (rows.length === 0) return [];
  const stats = await campaignStats(rows.map((r) => r.id));
  return rows.map((c) => ({
    key: `campaign:pace:${c.id}`,
    type: 'INFO' as const,
    title: `'${c.title.slice(0, 30)}' 진행이 기간보다 느립니다 — 연장·콘텐츠 보강 제안`,
    detail: `기간 ${Math.round(elapsedRatio(c.startsOn, c.endsOn, now) * 100)}% 경과 · 진행률 ${campaignProgress(stats.get(c.id)?.raised ?? 0n, c.goalAmount).percent}%. 캠페인 화면의 "기간·목표 바꾸기" 에서 영향을 미리 보고 연장할 수 있습니다.`,
    href: `/studio/campaigns/${c.id}`,
  }));
}

// ---------------------------------------------------------------------------
// 목표 달성 → 감사·결과 안내 준비(승인 요청)
// ---------------------------------------------------------------------------

export function goalFollowupKey(campaignId: string) {
  return `campaign-goal:${campaignId}`;
}

/** campaign.goal_reached 소비자 — 승인 요청만 쌓는다(자동 발송 없음). */
export async function handleCampaignGoalFollowup(ev: StoredDomainEvent) {
  const c = await prisma.campaign.findFirst({ where: { id: ev.subjectId, merchantId: ev.merchantId }, select: { id: true, title: true, goalReachedAt: true } });
  if (!c || !c.goalReachedAt) return 'SKIPPED' as const;
  // 목표를 다시 올려 두 번째로 달성하면 새 요청(달성 시각을 키에 넣는다)
  await requestApproval({
    merchantId: ev.merchantId,
    kind: 'CAMPAIGN_GOAL_FOLLOWUP',
    title: `목표 달성 — '${c.title.slice(0, 40)}' 감사·결과 안내 준비`,
    summary: '승인하면 사업 진행·결과 보고에 감사 인사 초안(작성 중)을 만듭니다. 후원자에게는 아무것도 보내지 않습니다 — 초안을 확인·승인한 뒤 발송 승인을 따로 받습니다.',
    payload: { campaignId: c.id, title: c.title },
    subjectType: 'campaign',
    subjectId: c.id,
    dedupeKey: `${goalFollowupKey(c.id)}:${c.goalReachedAt.getTime()}`,
  });
}

/** 승인 → 사업 진행 기록 초안(DRAFT) 1건. 다시 불러도 같은 초안(createdBy 표시로 1회). */
export async function approveGoalFollowup(req: ApprovalRow): Promise<string> {
  const campaignId = String(req.payload.campaignId ?? req.subjectId ?? '');
  const marker = `CAMPAIGN_GOAL:${req.id}`;
  const existing = await prisma.impactUpdate.findFirst({ where: { merchantId: req.merchantId, createdBy: marker }, select: { id: true } });
  if (existing) return '이미 초안을 만들었습니다. 사업 진행·결과 보고 화면에서 확인해 주세요.';
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, merchantId: req.merchantId }, select: { id: true, title: true, goalAmount: true } });
  if (!c) return '캠페인을 찾을 수 없어 초안을 만들지 않았습니다.';
  const { saveImpactUpdate } = await import('./impact-reports');
  await saveImpactUpdate(req.merchantId, marker, {
    campaignId: c.id,
    title: `${c.title} 목표 달성 감사 인사`.slice(0, 80),
    body: `함께해 주신 덕분에 '${c.title}' 모금이 목표 ${formatWon(c.goalAmount)}에 닿았습니다. 후원금을 어떻게 쓰고 있는지 진행 소식으로 전해 드리겠습니다. (담당자가 내용을 고친 뒤 승인해 주세요)`,
    photos: [],
    photoRuleAck: false,
  });
  return '사업 진행·결과 보고에 감사 인사 초안을 만들었습니다. 내용을 고치고 승인한 뒤 발송 승인을 요청해 주세요(자동 발송 없음).';
}

let registered = false;
export function registerCampaignSetupHandlers() {
  if (registered) return;
  registered = true;
  registerApprovalHandler('CAMPAIGN_GOAL_FOLLOWUP', { onApprove: (req) => approveGoalFollowup(req) });
  registerConsumer({ name: 'campaign-goal-followup', types: ['campaign.goal_reached'], handle: handleCampaignGoalFollowup });
}

// ---------------------------------------------------------------------------
// 결과 보고 작성 — 승인 대기함 묶음
// ---------------------------------------------------------------------------

/** 결과 보고 예정일이 된(오늘 ≥ 예정일) 끝난 캠페인 중 승인된 결과 보고가 없는 것 */
export async function resultReportsDue(merchantId: string, now = new Date()) {
  const today = kstTodayKey(now);
  const rows = await prisma.campaign.findMany({
    where: { merchantId, status: { in: ['ACTIVE', 'CLOSED'] }, resultReportDueOn: { lte: dateCol(today) } },
    select: { id: true, title: true, status: true, endsOn: true, resultReportDueOn: true },
    orderBy: { resultReportDueOn: 'asc' },
  });
  const ended = rows.filter((c) => campaignEnded(c, now));
  if (ended.length === 0) return [];
  const done = await prisma.impactUpdate.findMany({ where: { merchantId, campaignId: { in: ended.map((c) => c.id) }, status: { in: ['APPROVED', 'SENT'] }, archivedAt: null }, select: { campaignId: true } });
  const doneSet = new Set(done.map((d) => d.campaignId));
  return ended.filter((c) => !doneSet.has(c.id));
}

export async function resultReportInboxGroup(merchantId: string, now = new Date()): Promise<InboxExceptionGroup | null> {
  const due = await resultReportsDue(merchantId, now);
  if (due.length === 0) return null;
  const today = kstTodayKey(now);
  const overdue = due.filter((c) => dateKey(c.resultReportDueOn!) < today).length;
  const first = due[0]!;
  return {
    kind: 'campaign-result-report',
    title: `결과 보고 작성 ${due.length}건`,
    reason: due.length === 1 ? `'${first.title}' 결과 보고 예정일(${dateKey(first.resultReportDueOn!)})입니다.` : `결과 보고 예정일이 된 캠페인 ${due.length}개${overdue ? ` (예정일 지남 ${overdue})` : ''}`,
    affectedCount: due.length,
    oldestAt: new Date(kstStartMs(dateKey(first.resultReportDueOn!))),
    href: '/studio/impact',
    recommendedAction: '사업 진행·결과 보고에서 캠페인 결과 보고를 쓰고 승인하면 이 묶음에서 빠집니다.',
    actions: [],
    severity: overdue ? 'high' : 'normal',
  };
}
