import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { decrypt, generateToken, sha256 } from '@/lib/crypto';
import { contractIntegrations, env } from '@/lib/env';
import { kstDateKey, kstStartOfDay, kstStartOfMonth } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import { ApprovalError, registerApprovalHandler, requestApproval } from './approvals';
import { notifySuperAdmins, notifyUser } from './notifications';
import { informationalTemplateCodes } from './outbound/classify';
import { revokeMarketingConsents } from './marketing-consent-revoke';
import * as tpl from './mt-templates';

/**
 * 관계 확장 안내 (2026-11-13 5차 L4) — **정책 결정 대기, 기본 꺼짐.**
 *
 * 대표 결정: 동의자에게만, 기관 승인 후, 월 1회 이하. 지금은 동의만 쌓는 단계이고 발송은 법무 확인 후다.
 * 그래서 기능은 만들되 두 스위치가 모두 켜져야 움직인다:
 *  ① 전역 `system_setting 'relationship_messages.enabled'`(최고관리자만, 기본 false)
 *  ② 기관 설정 `relationship_message_setting.enabled`(기본 false) + 켠 안내 종류
 * 어느 하나라도 꺼져 있으면 대상 계산·승인 요청·발송을 하지 않는다(화면은 "법무 확인 후 켤 수 있습니다").
 *
 * 저니 정의 방식이 아니라 별도 서비스다(저니에 광고성 단계를 넣지 않는 규칙 유지).
 *  - 대상 = (선택) 소식 수신 동의(marketing_consent_at 있고 철회 없음)만. 제외 = 출금 실패·복구 중·환불·열린 문의·최근 90일 해지·
 *    수신 거부(월간 안내 거부·후원자 차단)·탈퇴·기관 차단.
 *  - **항상 기관 승인**: 주 1회 대상 묶음을 승인 요청(RELATIONSHIP_MESSAGE_BATCH — 대상 수·문안·표본)으로 올리고, 승인하면 배치가 보낸다.
 *  - 문안 맨 앞 "(광고)", 끝에 무료 수신 거부 방법(링크 + RELATIONSHIP_OPTOUT_080 이 있으면 080). 야간(21~8시 KST) 금지 — 끌 수 없다.
 *  - 후원자당 월 1회 이하(기관 무관 전체 기준), 정보성 안내와 같은 날 겹치지 않게(그날 정보성 발송·대기열이 있으면 다음 날로).
 *  - 알림톡으로 보내지 않는다(정보성 템플릿만 쓰는 규칙) — 문자만(RELATIONSHIP_MESSAGE 는 ALIMTALK_TEMPLATES 에 없다).
 *  - 감시: 발송 후 7일 수신 거부율이 2% 를 넘으면 그 기관 관계 안내 자동 중지 + 기관·최고관리자 알림. 해지율도 같은 기준으로 알린다.
 */

export const RELATIONSHIP_ENABLED_KEY = 'relationship_messages.enabled';
export const OPT_OUT_STOP_RATE = 0.02;
export const MONITOR_DAYS = 7;
const APPROVED_TTL_DAYS = 7;
const QUIET_START = 21;
const QUIET_END = 8;

export const RELATIONSHIP_KINDS = {
  ONE_TIME_TO_RECURRING: { label: '일시후원 → 정기후원 안내', rule: '일시후원 2회 이상 · 두 번째 후원 14일 뒤 · 1회만', period: 'ONCE' },
  DORMANT_REENGAGE: { label: '휴면 후원자 재참여 안내', rule: '마지막 후원 6개월 뒤 · 연 1회', period: 'YEAR' },
  UPGRADE: { label: '정기후원 증액 안내', rule: '정기후원 1년 유지 · 약정 1주년 · 연 1회 이하', period: 'YEAR' },
  VOLUNTEER_TO_DONOR: { label: '봉사자 → 후원 안내', rule: '봉사 2회 이상 · 마지막 봉사 30일 뒤 · 1회만', period: 'ONCE' },
} as const;
export type RelationshipKind = keyof typeof RELATIONSHIP_KINDS;
export const RELATIONSHIP_KIND_ORDER: RelationshipKind[] = ['UPGRADE', 'ONE_TIME_TO_RECURRING', 'VOLUNTEER_TO_DONOR', 'DORMANT_REENGAGE'];
export const isRelationshipKind = (v: unknown): v is RelationshipKind => typeof v === 'string' && Object.hasOwn(RELATIONSHIP_KINDS, v);

const PAID = ['PAYMENT_SUCCESS', 'BROADCAST_PENDING', 'BROADCASTED', 'PARTIAL_DELIVERY_FAILED', 'SETTLEMENT_PENDING', 'SETTLED'] as const;

// ---------------------------------------------------------------------------
// 스위치·설정
// ---------------------------------------------------------------------------

export async function relationshipGloballyEnabled(): Promise<boolean> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: RELATIONSHIP_ENABLED_KEY } });
    const v = row?.value as unknown;
    return v === true || (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true);
  } catch {
    return false; // 읽지 못하면 닫는다
  }
}

export async function setRelationshipGloballyEnabled(enabled: boolean, adminUserId: string) {
  await prisma.systemSetting.upsert({
    where: { key: RELATIONSHIP_ENABLED_KEY },
    create: { key: RELATIONSHIP_ENABLED_KEY, value: { enabled } as Prisma.InputJsonValue, updatedBy: adminUserId, memo: '관계 확장 안내(광고성) 발송 — 법무 확인 후' },
    update: { value: { enabled } as Prisma.InputJsonValue, updatedBy: adminUserId },
  });
}

export async function relationshipSetting(merchantId: string) {
  return prisma.relationshipMessageSetting.findUnique({ where: { merchantId } });
}

export class RelationshipError extends Error {}

export async function saveRelationshipSetting(merchantId: string, input: { enabled: boolean; kinds: string[] }, userId: string) {
  if (!(await relationshipGloballyEnabled())) throw new RelationshipError('관계 안내는 법무 확인 후 켤 수 있습니다.');
  const kinds = [...new Set(input.kinds.filter(isRelationshipKind))];
  if (input.enabled && kinds.length === 0) throw new RelationshipError('켤 안내를 하나 이상 골라 주세요.');
  const data = { enabled: input.enabled, kinds, updatedBy: userId, ...(input.enabled ? { pausedAt: null, pauseReason: null } : {}) };
  await prisma.relationshipMessageSetting.upsert({ where: { merchantId }, create: { merchantId, ...data }, update: data });
}

/** 지금 이 기관에서 관계 안내가 움직이는가(두 스위치 + 중지 아님) */
export async function relationshipActiveFor(merchantId: string) {
  if (!(await relationshipGloballyEnabled())) return null;
  const s = await relationshipSetting(merchantId);
  if (!s || !s.enabled || s.pausedAt) return null;
  return s;
}

// ---------------------------------------------------------------------------
// 문안
// ---------------------------------------------------------------------------

export function relationshipBody(kind: RelationshipKind, m: { displayName: string; code: string }): string {
  const page = `${env.baseUrl}/donate/${m.code}`;
  switch (kind) {
    case 'ONE_TIME_TO_RECURRING':
      return `${m.displayName} 후원에 두 번이나 함께해 주셔서 감사합니다. 매월 정한 날 자동으로 후원하는 정기후원도 있습니다. 원하시면 후원하신 번호로 '정기'라고 보내 주세요.`;
    case 'DORMANT_REENGAGE':
      return `${m.displayName}입니다. 지난 후원에 다시 한 번 감사드립니다. 그동안의 소식은 후원페이지에서 보실 수 있습니다: ${page}`;
    case 'UPGRADE':
      return `${m.displayName} 정기후원 1년을 함께해 주셔서 감사합니다. 후원 금액은 언제든 조정하실 수 있습니다. 후원하신 번호로 '변경'이라고 보내 주세요.`;
    case 'VOLUNTEER_TO_DONOR':
      return `${m.displayName}에서 봉사해 주셔서 감사합니다. 봉사와 함께 후원으로도 참여하실 수 있습니다: ${page}`;
  }
}

/** 미리보기용 완성 문안(링크 자리 표시) */
export function relationshipPreview(kind: RelationshipKind, m: { displayName: string; code: string }): string {
  return tpl.tplRelationshipMessage({ body: relationshipBody(kind, m), optOutLink: `${env.baseUrl}/u/(수신거부 링크)`, optOut080: contractIntegrations().relationshipOptOut080 || null }).text;
}

// ---------------------------------------------------------------------------
// 대상 계산
// ---------------------------------------------------------------------------

function periodKey(kind: RelationshipKind, now: Date): string {
  return RELATIONSHIP_KINDS[kind].period === 'ONCE' ? 'ONCE' : kstDateKey(now).slice(0, 4);
}

/** 동의자 중 제외 조건에 걸리지 않는 후원자. 꺼져 있으면 호출하지 않는다(호출부가 막는다). */
export async function eligibleConsenters(merchantId: string, now = new Date()): Promise<string[]> {
  const links = await prisma.payerMerchantLink.findMany({
    where: { merchantId, marketingConsentAt: { not: null }, marketingConsentWithdrawnAt: null, noticeOptOutAt: null, payerBlockedAt: null, payer: { onboardingStatus: { not: 'WITHDRAWN' }, mergedIntoId: null } },
    select: { payerId: true },
  });
  let ids = links.map((l) => l.payerId);
  if (ids.length === 0) return [];
  const d90 = new Date(now.getTime() - 90 * 86_400_000);
  const d30 = new Date(now.getTime() - 30 * 86_400_000);
  const d180 = new Date(now.getTime() - 180 * 86_400_000);
  const [blocked, recurringBad, failedRuns, refunds, inquiries] = await Promise.all([
    prisma.blockedPayer.findMany({ where: { merchantId, payerId: { in: ids } }, select: { payerId: true } }),
    prisma.recurringDonation.findMany({
      where: { merchantId, payerId: { in: ids }, OR: [{ status: 'SUSPENDED' }, { recoveryState: { not: 'NONE' } }, { status: 'CANCELED', canceledAt: { gte: d90 } }] },
      select: { payerId: true },
    }),
    prisma.recurringRun.findMany({ where: { status: { in: ['FAILED', 'PENDING'] }, ranAt: { gte: d30 }, recurring: { merchantId, payerId: { in: ids } } }, select: { recurring: { select: { payerId: true } } } }),
    prisma.refund.findMany({ where: { requestedAt: { gte: d180 }, charge: { merchantId, payerId: { in: ids } } }, select: { charge: { select: { payerId: true } } } }),
    prisma.supportInquiry.findMany({ where: { merchantId, payerId: { in: ids }, status: { not: 'CLOSED' } }, select: { payerId: true } }),
  ]);
  const out = new Set<string>([
    ...blocked.map((b) => b.payerId),
    ...recurringBad.map((r) => r.payerId),
    ...failedRuns.map((r) => r.recurring.payerId),
    ...refunds.map((r) => r.charge.payerId ?? ''),
    ...inquiries.map((q) => q.payerId ?? ''),
  ]);
  ids = ids.filter((id) => !out.has(id));
  return ids;
}

function kstMonthDay(d: Date) {
  const k = new Date(d.getTime() + 9 * 3_600_000);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth(), d: k.getUTCDate() };
}

/** 종류별 조건(대표 결정 문서 그대로). 한 후원자는 한 묶음에 한 종류만(RELATIONSHIP_KIND_ORDER 우선). */
export async function relationshipCandidates(merchantId: string, kinds: RelationshipKind[], now = new Date()): Promise<Array<{ payerId: string; kind: RelationshipKind }>> {
  const ids = await eligibleConsenters(merchantId, now);
  if (ids.length === 0 || kinds.length === 0) return [];
  const [charges, recurrings, activities] = await Promise.all([
    prisma.charge.findMany({ where: { merchantId, payerId: { in: ids }, status: { in: [...PAID] }, isTest: false, paidAt: { not: null } }, select: { payerId: true, channel: true, paidAt: true }, orderBy: { paidAt: 'asc' } }),
    prisma.recurringDonation.findMany({ where: { merchantId, payerId: { in: ids }, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { payerId: true, status: true, createdAt: true } }),
    prisma.volunteerActivity.findMany({ where: { merchantId, payerId: { in: ids } }, select: { payerId: true, activityDate: true } }),
  ]);
  const by = <T extends { payerId: string | null }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) if (r.payerId) m.set(r.payerId, [...(m.get(r.payerId) ?? []), r]);
    return m;
  };
  const chargeOf = by(charges);
  const recurringOf = by(recurrings);
  const actOf = by(activities);
  const day = 86_400_000;
  const out: Array<{ payerId: string; kind: RelationshipKind }> = [];
  for (const payerId of ids) {
    const cs = chargeOf.get(payerId) ?? [];
    const rs = recurringOf.get(payerId) ?? [];
    const acts = actOf.get(payerId) ?? [];
    const oneTime = cs.filter((c) => c.channel !== 'RECURRING');
    const hasLiveRecurring = rs.length > 0;
    const ok: Record<RelationshipKind, boolean> = {
      ONE_TIME_TO_RECURRING: !hasLiveRecurring && oneTime.length >= 2 && oneTime[1]!.paidAt!.getTime() + 14 * day <= now.getTime(),
      DORMANT_REENGAGE: !hasLiveRecurring && cs.length > 0 && cs[cs.length - 1]!.paidAt!.getTime() <= now.getTime() - 182 * day,
      UPGRADE: rs.some((r) => {
        if (r.status !== 'ACTIVE' || r.createdAt.getTime() > now.getTime() - 365 * day) return false;
        const a = kstMonthDay(r.createdAt);
        const n = kstMonthDay(now);
        const anniv = Date.UTC(n.y, a.m, a.d) - 9 * 3_600_000;
        const since = now.getTime() - anniv;
        return since >= 0 && since <= 14 * day;
      }),
      VOLUNTEER_TO_DONOR: cs.length === 0 && !hasLiveRecurring && acts.length >= 2 && Math.max(...acts.map((a) => a.activityDate.getTime())) + 30 * day <= now.getTime(),
    };
    const kind = RELATIONSHIP_KIND_ORDER.find((k) => kinds.includes(k) && ok[k]);
    if (kind) out.push({ payerId, kind });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 주간 승인 묶음
// ---------------------------------------------------------------------------

/** KST 기준 그 주 월요일 날짜 키 */
export function kstWeekKey(now: Date): string {
  const k = new Date(now.getTime() + 9 * 3_600_000);
  const dow = (k.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - dow));
  return monday.toISOString().slice(0, 10);
}

const maskName = (n: string | null) => {
  const v = (n ?? '').trim();
  if (!v) return '후원자';
  return v.length <= 1 ? `${v}*` : `${v[0]}${'*'.repeat(Math.max(1, v.length - 1))}`;
};

/** 지난 묶음 정리: 승인되지 않은 지난 주 요청은 만료하고 그 대상 행은 풀어 준다. 승인 뒤 오래 못 보낸 행도 만료. */
async function expireOld(merchantId: string, weekKey: string, now: Date) {
  const stale = await prisma.approvalRequest.findMany({ where: { merchantId, kind: 'RELATIONSHIP_MESSAGE_BATCH', status: 'PENDING', dedupeKey: { not: `relationship:${merchantId}:${weekKey}` } }, select: { id: true } });
  for (const a of stale) {
    await prisma.$transaction(async (tx) => {
      const r = await tx.approvalRequest.updateMany({ where: { id: a.id, status: 'PENDING' }, data: { status: 'EXPIRED', result: '다음 주 묶음으로 바뀌어 만료' } });
      if (r.count === 0) return;
      const rows = await tx.relationshipMessage.findMany({ where: { approvalId: a.id, status: 'PROPOSED' }, select: { id: true } });
      for (const row of rows) await tx.relationshipMessage.update({ where: { id: row.id }, data: { status: 'EXPIRED', dedupeKey: `expired:${row.id}` } });
    });
  }
  const cutoff = new Date(now.getTime() - APPROVED_TTL_DAYS * 86_400_000);
  const old = await prisma.relationshipMessage.findMany({ where: { merchantId, status: 'APPROVED', updatedAt: { lt: cutoff } }, select: { id: true } });
  for (const row of old) await prisma.relationshipMessage.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'EXPIRED', skipReason: '승인 뒤 7일 안에 보내지 못함', dedupeKey: `expired:${row.id}` } });
}

/** 주 1회 대상 묶음을 승인 요청으로 올린다. 꺼져 있으면 아무것도 계산하지 않는다. */
export async function proposeWeeklyBatch(merchantId: string, now = new Date()): Promise<{ created: boolean; total: number; approvalId?: string; reason?: string }> {
  const setting = await relationshipActiveFor(merchantId);
  if (!setting) return { created: false, total: 0, reason: 'DISABLED' };
  const weekKey = kstWeekKey(now);
  const dedupeKey = `relationship:${merchantId}:${weekKey}`;
  if (await prisma.approvalRequest.findUnique({ where: { dedupeKey }, select: { id: true } })) return { created: false, total: 0, reason: 'ALREADY' };
  await expireOld(merchantId, weekKey, now);
  const merchant = await prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { displayName: true, code: true, status: true } });
  if (!merchant || merchant.status !== 'APPROVED') return { created: false, total: 0, reason: 'MERCHANT' };
  const kinds = setting.kinds.filter(isRelationshipKind);
  const busy = await prisma.relationshipMessage.findMany({ where: { merchantId, status: { in: ['PROPOSED', 'APPROVED', 'SENDING'] } }, select: { payerId: true } });
  const busySet = new Set(busy.map((b) => b.payerId));
  const all = (await relationshipCandidates(merchantId, kinds, now)).filter((c) => !busySet.has(c.payerId));
  // 이미 그 기간에 같은 종류를 받은(또는 묶인) 후원자는 뺀다
  const keys = all.map((c) => `${merchantId}:${c.payerId}:${c.kind}:${periodKey(c.kind, now)}`);
  const taken = new Set((await prisma.relationshipMessage.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } })).map((r) => r.dedupeKey));
  const targets = all.filter((_, i) => !taken.has(keys[i]!));
  if (targets.length === 0) return { created: false, total: 0, reason: 'NO_TARGET' };

  const counts: Record<string, number> = {};
  for (const t of targets) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
  const names = await prisma.payerProfile.findMany({ where: { id: { in: targets.slice(0, 3).map((t) => t.payerId) } }, select: { id: true, displayName: true } });
  const nameOf = new Map(names.map((n) => [n.id, n.displayName]));
  const samples = targets.slice(0, 3).map((t) => ({ kind: t.kind, name: maskName(nameOf.get(t.payerId) ?? null) }));
  const texts = Object.fromEntries(Object.keys(counts).map((k) => [k, relationshipPreview(k as RelationshipKind, merchant)]));

  const res = await prisma.$transaction(async (tx) => {
    const { created, request } = await requestApproval(
      {
        merchantId,
        kind: 'RELATIONSHIP_MESSAGE_BATCH',
        title: `관계 확장 안내(광고) ${targets.length}명 — 승인하면 문자로 보냅니다`,
        summary: Object.entries(counts).map(([k, n]) => `${RELATIONSHIP_KINDS[k as RelationshipKind].label} ${n}명`).join(' · '),
        payload: { weekKey, total: targets.length, counts, texts, samples, cost: '문자 요금(광고성 문자 1건당)' },
        dedupeKey,
        expiresAt: new Date(now.getTime() + 7 * 86_400_000),
      },
      tx,
    );
    if (!created) return { created: false, id: request.id };
    await tx.relationshipMessage.createMany({
      data: targets.map((t) => ({
        id: newId(), merchantId, payerId: t.payerId, kind: t.kind, periodKey: periodKey(t.kind, now),
        dedupeKey: `${merchantId}:${t.payerId}:${t.kind}:${periodKey(t.kind, now)}`, approvalId: request.id, status: 'PROPOSED',
      })),
      skipDuplicates: true,
    });
    return { created: true, id: request.id };
  });
  return { created: res.created, total: res.created ? targets.length : 0, approvalId: res.id };
}

// ---------------------------------------------------------------------------
// 발송
// ---------------------------------------------------------------------------

/** 광고성 야간(21~8시 KST) — 정보성 보류 스위치(JOURNEY_QUIET_HOURS)와 무관하게 항상 지킨다(법정 제한). */
export function isPromoQuietHour(d: Date): boolean {
  const h = new Date(d.getTime() + 9 * 3_600_000).getUTCHours();
  return h >= QUIET_START || h < QUIET_END;
}

function nextDayMorning(now: Date): Date {
  return new Date(kstStartOfDay(now).getTime() + 86_400_000 + 9 * 3_600_000);
}

export interface RelationshipSendResult {
  skipped?: 'DISABLED' | 'QUIET_HOURS';
  sent: number;
  deferred: number;
  dropped: number;
  failed: number;
}

/** 승인된 안내를 보낸다(배치). 보내기 직전에 스위치·동의·제외·월 1회·같은 날 정보성을 다시 본다. */
export async function sendApprovedRelationshipMessages(now = new Date(), limit = 200): Promise<RelationshipSendResult> {
  const out: RelationshipSendResult = { sent: 0, deferred: 0, dropped: 0, failed: 0 };
  if (!(await relationshipGloballyEnabled())) return { ...out, skipped: 'DISABLED' };
  if (isPromoQuietHour(now)) return { ...out, skipped: 'QUIET_HOURS' };
  const rows = await prisma.relationshipMessage.findMany({
    where: { status: 'APPROVED', OR: [{ notBefore: null }, { notBefore: { lte: now } }] },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  const merchantCache = new Map<string, { setting: Awaited<ReturnType<typeof relationshipActiveFor>>; merchant: { displayName: string; code: string; status: string } | null; eligible: Set<string> }>();
  const informational = informationalTemplateCodes();
  for (const row of rows) {
    let mc = merchantCache.get(row.merchantId);
    if (!mc) {
      const setting = await relationshipActiveFor(row.merchantId);
      const merchant = await prisma.merchantProfile.findUnique({ where: { id: row.merchantId }, select: { displayName: true, code: true, status: true } });
      const eligible = setting ? new Set(await eligibleConsenters(row.merchantId, now)) : new Set<string>();
      mc = { setting, merchant, eligible };
      merchantCache.set(row.merchantId, mc);
    }
    const drop = async (reason: string) => {
      await prisma.relationshipMessage.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'SKIPPED', skipReason: reason } });
      out.dropped += 1;
    };
    if (!mc.setting || !mc.merchant || mc.merchant.status !== 'APPROVED') continue; // 기관이 끄거나 중지되면 보내지 않고 기다린다(7일 뒤 만료)
    if (!isRelationshipKind(row.kind) || !mc.setting.kinds.includes(row.kind)) { await drop('기관이 이 안내를 껐습니다'); continue; }
    if (!mc.eligible.has(row.payerId)) { await drop('동의 철회·수신 거부·제외 조건'); continue; }
    const payer = await prisma.payerProfile.findUnique({ where: { id: row.payerId }, select: { phoneHash: true, phoneEnc: true, onboardingStatus: true } });
    if (!payer || payer.onboardingStatus === 'WITHDRAWN' || !payer.phoneEnc) { await drop('탈퇴·번호 없음'); continue; }
    // 후원자당 월 1회(기관 무관)
    const monthly = await prisma.relationshipMessage.count({ where: { payerId: row.payerId, status: { in: ['SENT', 'SENDING'] }, sentAt: { gte: kstStartOfMonth(now) } } });
    if (monthly > 0) {
      // 월 상한은 '이번 달' 사정이라 그 안내 자체를 영구히 막지 않는다 — 기간 키를 풀어 다음 묶음에서 다시 제안될 수 있게 한다(만료와 같은 방식).
      await prisma.relationshipMessage.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'SKIPPED', skipReason: '이번 달 관계 안내를 이미 받았습니다(월 1회) — 다음 달 묶음에서 다시 제안', dedupeKey: `skipped:${row.id}` } });
      out.dropped += 1;
      continue;
    }
    // 정보성 안내와 같은 날 겹치지 않게
    const today = kstStartOfDay(now);
    const [infoSent, infoQueued] = await Promise.all([
      prisma.mtOutboundMessage.count({ where: { phoneHash: payer.phoneHash, createdAt: { gte: today }, templateCode: { in: informational } } }),
      prisma.outboundQueue.count({ where: { payerId: row.payerId, status: { in: ['QUEUED', 'SENDING'] }, dueAt: { lt: new Date(today.getTime() + 86_400_000) } } }),
    ]);
    if (infoSent + infoQueued > 0) {
      await prisma.relationshipMessage.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { notBefore: nextDayMorning(now), skipReason: '같은 날 정보성 안내가 있어 다음 날로' } });
      out.deferred += 1;
      continue;
    }
    // 선점 + 수신 거부 토큰
    const token = generateToken(18);
    const claimed = await prisma.relationshipMessage.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'SENDING', optOutTokenHash: sha256(token), sentAt: now } });
    if (claimed.count !== 1) continue;
    const template = tpl.tplRelationshipMessage({
      body: relationshipBody(row.kind, mc.merchant),
      optOutLink: `${env.baseUrl}/u/${token}`,
      optOut080: contractIntegrations().relationshipOptOut080 || null,
    });
    try {
      // charge-flow 를 늦게 불러 순환 참조를 피한다. 알림톡 경로는 RELATIONSHIP_MESSAGE 가 정보성 템플릿에 없어 타지 않는다(문자만).
      const { sendMtDetailed } = await import('./charge-flow');
      const r = await sendMtDetailed({ phone: decrypt(payer.phoneEnc), template, merchantId: row.merchantId });
      await prisma.relationshipMessage.update({ where: { id: row.id }, data: { status: r.ok ? 'SENT' : 'FAILED', mtMessageId: r.id, skipReason: r.ok ? null : '문자 발송 실패' } });
      if (r.ok) out.sent += 1;
      else out.failed += 1;
    } catch (e) {
      logger.error('관계 안내 발송 실패', { id: row.id, message: (e as Error).message });
      await prisma.relationshipMessage.update({ where: { id: row.id }, data: { status: 'FAILED', skipReason: '발송 중 오류' } }).catch(() => undefined);
      out.failed += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 수신 거부·감시
// ---------------------------------------------------------------------------

/** 무료 수신 거부 링크(/u/[토큰]). 그 기관 소식 수신 동의를 철회한다. 여러 번 눌러도 한 번. */
export async function optOutRelationship(token: string, meta: { ip?: string | null; userAgent?: string | null } = {}, now = new Date()): Promise<{ ok: boolean; merchantName?: string }> {
  const row = await prisma.relationshipMessage.findUnique({ where: { optOutTokenHash: sha256(token) }, select: { id: true, payerId: true, merchantId: true } });
  if (!row) return { ok: false };
  await prisma.$transaction(async (tx) => {
    await tx.relationshipMessage.updateMany({ where: { id: row.id, optedOutAt: null }, data: { optedOutAt: now } });
    await revokeMarketingConsents(tx, { payerId: row.payerId, merchantId: row.merchantId, source: 'OPT_OUT', ip: meta.ip, userAgent: meta.userAgent, now });
  });
  const m = await prisma.merchantProfile.findUnique({ where: { id: row.merchantId }, select: { displayName: true } });
  return { ok: true, merchantName: m?.displayName };
}

export interface BatchStats {
  approvalId: string;
  sent: number;
  optedOut: number;
  canceled: number;
  optOutRate: number;
  cancelRate: number;
  firstSentAt: Date | null;
}

/** 묶음별 발송 후 7일 수신 거부·해지 비율 */
export async function batchStats(approvalId: string): Promise<BatchStats> {
  const rows = await prisma.relationshipMessage.findMany({ where: { approvalId, status: 'SENT' }, select: { payerId: true, merchantId: true, sentAt: true, optedOutAt: true } });
  let optedOut = 0;
  let canceled = 0;
  let first: Date | null = null;
  for (const r of rows) {
    if (!r.sentAt) continue;
    if (!first || r.sentAt < first) first = r.sentAt;
    const until = new Date(r.sentAt.getTime() + MONITOR_DAYS * 86_400_000);
    const link = await prisma.payerMerchantLink.findUnique({ where: { payerId_merchantId: { payerId: r.payerId, merchantId: r.merchantId } }, select: { marketingConsentWithdrawnAt: true } });
    const w = link?.marketingConsentWithdrawnAt;
    if ((r.optedOutAt && r.optedOutAt <= until) || (w && w >= r.sentAt && w <= until)) optedOut += 1;
    const c = await prisma.recurringDonation.count({ where: { merchantId: r.merchantId, payerId: r.payerId, status: 'CANCELED', canceledAt: { gte: r.sentAt, lte: until } } });
    if (c > 0) canceled += 1;
  }
  const sent = rows.length;
  return { approvalId, sent, optedOut, canceled, optOutRate: sent ? optedOut / sent : 0, cancelRate: sent ? canceled / sent : 0, firstSentAt: first };
}

/** 감시 배치: 발송 후 7일 안 묶음의 수신 거부율이 2% 를 넘으면 그 기관 관계 안내를 자동 중지하고 알린다. */
export async function monitorRelationshipOptOuts(now = new Date()): Promise<{ paused: string[]; cancelAlerts: string[] }> {
  const since = new Date(now.getTime() - MONITOR_DAYS * 86_400_000);
  const recent = await prisma.relationshipMessage.findMany({ where: { status: 'SENT', sentAt: { gte: since }, approvalId: { not: null } }, select: { approvalId: true, merchantId: true }, distinct: ['approvalId'] });
  const paused: string[] = [];
  const cancelAlerts: string[] = [];
  for (const r of recent) {
    const s = await batchStats(r.approvalId!);
    if (s.sent === 0) continue;
    const merchant = await prisma.merchantProfile.findUnique({ where: { id: r.merchantId }, select: { userId: true, displayName: true } });
    if (s.optOutRate > OPT_OUT_STOP_RATE) {
      const reason = `발송 후 7일 수신 거부율 ${(s.optOutRate * 100).toFixed(1)}%(${s.optedOut}/${s.sent}) — 기준 ${OPT_OUT_STOP_RATE * 100}% 초과로 자동 중지`;
      const p = await prisma.relationshipMessageSetting.updateMany({ where: { merchantId: r.merchantId, pausedAt: null }, data: { pausedAt: now, pauseReason: reason } });
      if (p.count === 1) {
        paused.push(r.merchantId);
        // 아직 보내지 않은 승인분은 보내지 않는다(배치가 중지 상태를 보고 기다리다 7일 뒤 만료)
        if (merchant) await notifyUser({ userId: merchant.userId, title: '관계 안내가 자동 중지되었습니다', body: reason, linkUrl: '/studio/relationship' }).catch(() => undefined);
        await notifySuperAdmins({ title: `관계 안내 자동 중지 — ${merchant?.displayName ?? r.merchantId}`, body: reason, linkUrl: '/admin/site-settings' }).catch(() => undefined);
      }
    }
    if (s.cancelRate > OPT_OUT_STOP_RATE) {
      const key = `relationship-cancel-alert:${r.approvalId}`;
      const first = await prisma.systemSetting.createMany({ data: [{ key, value: { at: now.toISOString() } as Prisma.InputJsonValue, memo: '관계 안내 해지율 알림 1회' }], skipDuplicates: true });
      if (first.count === 1) {
        cancelAlerts.push(r.merchantId);
        const body = `관계 안내 발송 후 7일 정기후원 해지율 ${(s.cancelRate * 100).toFixed(1)}%(${s.canceled}/${s.sent}). 문안·대상을 확인해 주세요.`;
        if (merchant) await notifyUser({ userId: merchant.userId, title: '관계 안내 뒤 해지가 늘었습니다', body, linkUrl: '/studio/relationship' }).catch(() => undefined);
      }
    }
  }
  return { paused, cancelAlerts };
}

/** 배치 한 번: (전역 켜짐일 때만) 기관별 주간 묶음 제안 → 승인분 발송 → 감시 */
export async function runRelationshipCron(now = new Date()) {
  if (!(await relationshipGloballyEnabled())) return { skipped: 'DISABLED' as const };
  const settings = await prisma.relationshipMessageSetting.findMany({ where: { enabled: true, pausedAt: null }, select: { merchantId: true } });
  let proposed = 0;
  for (const s of settings) {
    const r = await proposeWeeklyBatch(s.merchantId, now).catch((e) => {
      logger.error('관계 안내 묶음 제안 실패', { merchantId: s.merchantId, message: (e as Error).message });
      return null;
    });
    if (r?.created) proposed += 1;
  }
  const sent = await sendApprovedRelationshipMessages(now);
  const monitor = await monitorRelationshipOptOuts(now);
  return { proposed, ...sent, paused: monitor.paused.length, cancelAlerts: monitor.cancelAlerts.length };
}

/** 기관 화면 요약 */
export async function relationshipOverview(merchantId: string) {
  const [setting, batches] = await Promise.all([
    relationshipSetting(merchantId),
    prisma.approvalRequest.findMany({ where: { merchantId, kind: 'RELATIONSHIP_MESSAGE_BATCH' }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, title: true, status: true, createdAt: true } }),
  ]);
  const stats = await Promise.all(batches.map((b) => batchStats(b.id)));
  return { setting, batches: batches.map((b, i) => ({ ...b, stats: stats[i]! })) };
}

// ---------------------------------------------------------------------------
// 승인 처리기
// ---------------------------------------------------------------------------

export function registerRelationshipHandlers() {
  registerApprovalHandler('RELATIONSHIP_MESSAGE_BATCH', {
    async onApprove(req) {
      if (!(await relationshipActiveFor(req.merchantId))) throw new ApprovalError('관계 안내가 꺼져 있거나 중지되어 승인할 수 없습니다. (법무 확인 후 켤 수 있습니다)');
      const r = await prisma.relationshipMessage.updateMany({ where: { approvalId: req.id, status: 'PROPOSED' }, data: { status: 'APPROVED' } });
      const already = await prisma.relationshipMessage.count({ where: { approvalId: req.id, status: { not: 'PROPOSED' } } });
      return `${r.count || already}명에게 보낼 안내를 승인했습니다. 야간(21~8시)을 피해 문자로 나갑니다(후원자당 월 1회, 정보성 안내와 같은 날이면 다음 날).`;
    },
    async onReject(req) {
      await prisma.relationshipMessage.updateMany({ where: { approvalId: req.id, status: 'PROPOSED' }, data: { status: 'REJECTED' } });
    },
  });
}
