import { prisma } from '@/server/db';
import type { Prisma } from '@/generated/prisma/client';
import { newId } from '@/lib/id';
import { decrypt, encrypt, generateToken } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { sendMtDetailed } from '../charge-flow';
import * as tpl from '../mt-templates';
import type { MtTemplateCode, TemplateOutput } from '../mt-templates';
import {
  OUTBOUND_BUNDLE_MAX_BYTES,
  OUTBOUND_BUNDLE_TEMPLATE,
  OUTBOUND_MAX_DEFERRALS,
  RELATIONAL_WEEKLY_CAP,
  lmsBytes,
  relationalLabel,
  relationalPriority,
  type RelationalKind,
} from './classify';
import { autoPauseReason } from './pause';
import { isOutboundQuietHour, nextOutboundMorning } from './quiet';

/**
 * 통합 발송 관리 — 관계·정보형 안내 발송 대기열 (2026-11-09 D2).
 *
 *  - 관계·정보형 안내(분류표 `classify.ts`)는 바로 보내지 않고 `outbound_queue` 에 쌓는다(발송 키 유니크 → 한 번만).
 *    짧게 기다린 뒤(`OUTBOUND_COALESCE_MINUTES`, 기본 10분) 같은 (기관, 후원자) 대기분을 **한 통으로 묶어** 보낸다.
 *    묶음 본문이 LMS 길이(2,000바이트)를 넘으면 나눠 보낸다. 안내 1건이면 원래 템플릿 그대로(알림톡 경로 포함) 보낸다.
 *  - 7일 상한은 저니 발송과 대기열 발송을 합쳐 (기관, 후원자) 기준으로 센다(`relationalCapCount`). 저니가 예약하며 이미 센 안내
 *    (`precounted`)는 대기열에서 다시 세거나 미루지 않는다. 넘치면 우선순위 낮은 것부터 하루 보류, 3번 보류되면 건너뛰고 기록한다.
 *  - 야간 21~9시(KST)는 다음 날 9시로. 열린 문의·진행 중 환불이 있으면 하루 보류(`pause.ts`).
 *  - 선점: 후원자 단위 advisory lock 안에서 QUEUED → SENDING(lockedBy) 조건부 갱신. 겹친 배치가 같은 안내를 두 번 보내지 않는다.
 *    SENDING 으로 15분 넘게 남은 안내(발송 중 중단)는 다시 보내지 않고 UNKNOWN 으로 닫는다(두 번 보내는 것보다 안전).
 *  - 결과는 원천에 되돌려 적는다: 저니 단계 기록(발송 키), 발급 문서(sent_at·send_error), 월간 안내 기록·실행 집계.
 *  - **거래·요청형 안내는 이 모듈을 거치지 않는다.** `OUTBOUND_COORDINATOR=off` 면 지금 경로 그대로 바로 보낸다.
 */

export function coordinatorEnabled(): boolean {
  return (process.env.OUTBOUND_COORDINATOR ?? 'on') !== 'off';
}

/** 묶음 대기 시간(ms). 0 이면 쌓자마자 그 후원자 대기분을 보낸다(테스트 기본값). */
export function coalesceWaitMs(): number {
  const n = Number(process.env.OUTBOUND_COALESCE_MINUTES ?? 10);
  return (Number.isFinite(n) && n >= 0 ? n : 10) * 60_000;
}

const DAY = 86_400_000;
const SENDING_STALE_MS = 15 * 60_000;
const RETRY_GAP_MS = 3_600_000;
const MAX_ATTEMPTS = 3;
/** 수동 재발송용 본문 보관 기간 */
export const RESEND_BODY_RETENTION_DAYS = 14;

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * (기관, 후원자) 7일 관계·정보형 발송 수 — 저니 상한 함수와 통합(코드 한 곳).
 * = 저니 발송 단계 기록(sent) + 대기열에서 보낸·보내는 중인 안내(저니가 이미 센 것은 제외).
 */
export async function relationalCapCount(db: Db, merchantId: string, payerId: string | null, now: Date, excludeLockedBy?: string): Promise<number> {
  const since = new Date(now.getTime() - 7 * DAY);
  const journey = await db.journeyStepLog.count({ where: { merchantId, payerId, sent: true, at: { gte: since } } });
  if (!payerId || !coordinatorEnabled()) return journey;
  const queued = await db.outboundQueue.count({
    // 보내는 중(SENDING)도 센다 — 단, 지금 이 실행이 잡은 안내(아직 보내지 않음)는 뺀다.
    where: { merchantId, payerId, precounted: false, OR: [{ status: 'SENT', sentAt: { gte: since } }, { status: 'SENDING', ...(excludeLockedBy ? { NOT: { lockedBy: excludeLockedBy } } : {}) }] },
  });
  return journey + queued;
}

export type RelationalSendResult =
  | { mode: 'direct'; ok: boolean; mtId: string | null; channel: 'SMS' | 'ALIMTALK' | null; fallback: boolean }
  | { mode: 'queued'; itemId: string; dueAt: Date; detail: string }
  | { mode: 'skipped'; itemId: string; reason: string };

export interface RelationalSendInput {
  merchantId: string;
  payerId: string;
  kind: RelationalKind;
  template: TemplateOutput;
  /** 원래 안내의 발송 키(같은 키는 한 번만) */
  sendKey: string;
  source: 'journey' | 'issued_document' | 'notice';
  sourceId?: string | null;
  /** 저니 발송 예약에서 이미 7일 상한에 센 안내 */
  precounted: boolean;
  now?: Date;
}

async function directSend(merchantId: string, payerId: string, template: TemplateOutput): Promise<RelationalSendResult> {
  const payer = await prisma.payerProfile.findUnique({ where: { id: payerId }, select: { phoneEnc: true } });
  if (!payer) return { mode: 'direct', ok: false, mtId: null, channel: null, fallback: false };
  const r = await sendMtDetailed({ phone: decrypt(payer.phoneEnc), template, merchantId });
  return { mode: 'direct', ok: r.ok, mtId: r.id, channel: r.channel, fallback: r.fallback };
}

/**
 * 관계·정보형 안내 1건 보내기(조정). 꺼져 있으면 바로 보낸다(지금과 같은 경로).
 * 켜져 있으면 대기열에 쌓고, 대기 시간이 0 이면 그 자리에서 그 후원자 대기분을 보내 결과를 돌려준다.
 */
export async function sendRelational(input: RelationalSendInput): Promise<RelationalSendResult> {
  if (!coordinatorEnabled()) return directSend(input.merchantId, input.payerId, input.template);
  const now = input.now ?? new Date();
  const wait = coalesceWaitMs();
  let due = new Date(now.getTime() + wait);
  if (isOutboundQuietHour(due)) due = nextOutboundMorning(due);
  let itemId = newId();
  try {
    await prisma.outboundQueue.create({
      data: {
        id: itemId,
        merchantId: input.merchantId,
        payerId: input.payerId,
        kind: input.kind,
        priority: relationalPriority(input.kind),
        sendKey: input.sendKey,
        source: input.source,
        sourceId: input.sourceId ?? null,
        precounted: input.precounted,
        templateCode: input.template.code,
        templateEnc: encrypt(JSON.stringify(input.template)),
        bodyMasked: input.template.masked,
        dueAt: due,
      },
    });
  } catch (e) {
    if ((e as { code?: string })?.code !== 'P2002') throw e;
    // 같은 발송 키가 이미 쌓였다(겹친 실행·재시도) — 새로 쌓지 않는다.
    const prior = await prisma.outboundQueue.findUnique({ where: { sendKey: input.sendKey } });
    if (!prior) throw e;
    itemId = prior.id;
    if (prior.status === 'SENT') return resultOf(prior);
    if (prior.status !== 'FAILED' && prior.status !== 'SKIPPED') return { mode: 'queued', itemId, dueAt: prior.dueAt, detail: '이미 발송 대기열에 있음' };
    // 실패·건너뛴 안내를 원천이 다시 보내려 한다(저니 재시도 등) — 같은 행을 조건부로 다시 쌓는다(보낸 적 없는 안내만).
    const re = await prisma.outboundQueue.updateMany({
      where: { id: prior.id, status: prior.status },
      data: {
        status: 'QUEUED', dueAt: due, templateEnc: encrypt(JSON.stringify(input.template)), bodyMasked: input.template.masked,
        deferrals: 0, attempts: 0, lastReason: null, mtMessageId: null, bundleId: null,
      },
    });
    if (re.count === 0) return { mode: 'queued', itemId, dueAt: prior.dueAt, detail: '이미 발송 대기열에 있음' };
  }
  if (wait > 0) {
    return { mode: 'queued', itemId, dueAt: due, detail: `발송 대기열 등록 — ${relationalLabel(input.kind)}, 같은 날 안내와 묶어 보냄` };
  }
  await flushPayer(input.merchantId, input.payerId, now, { inlineItemId: itemId });
  const after = await prisma.outboundQueue.findUniqueOrThrow({ where: { id: itemId } });
  return resultOf(after);
}

async function resultOf(item: { id: string; status: string; mtMessageId: string | null; dueAt: Date; lastReason: string | null }): Promise<RelationalSendResult> {
  if (item.status === 'SENT' || item.status === 'FAILED') {
    const mt = item.mtMessageId ? await prisma.mtOutboundMessage.findUnique({ where: { id: item.mtMessageId }, select: { channel: true, fallback: true } }) : null;
    return { mode: 'direct', ok: item.status === 'SENT', mtId: item.mtMessageId, channel: (mt?.channel as 'SMS' | 'ALIMTALK' | undefined) ?? null, fallback: mt?.fallback ?? false };
  }
  if (item.status === 'SKIPPED' || item.status === 'UNKNOWN') return { mode: 'skipped', itemId: item.id, reason: item.lastReason ?? '건너뜀' };
  return { mode: 'queued', itemId: item.id, dueAt: item.dueAt, detail: item.lastReason ? `발송 보류 — ${item.lastReason}` : '발송 대기열 등록' };
}

// ---------------------------------------------------------------------------
// 묶음 본문
// ---------------------------------------------------------------------------

const PREFIX = '[기브싸인] ';
const strip = (s: string) => (s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s);

function bundleTemplate(merchantName: string, parts: TemplateOutput[]): TemplateOutput {
  const head = `${PREFIX}${merchantName} 안내 ${parts.length}건`;
  const text = [head, ...parts.map((p, i) => `${i + 1}. ${strip(p.text)}`)].join('\n');
  const masked = [head, ...parts.map((p, i) => `${i + 1}. ${strip(p.masked)}`)].join('\n');
  return { code: OUTBOUND_BUNDLE_TEMPLATE as MtTemplateCode, text, masked };
}

/** 길이 상한 안에서 앞에서부터 채운다. 한 건만으로 넘으면 그 건 혼자 보낸다(원래 템플릿). */
export function splitBundles<T extends { template: TemplateOutput }>(merchantName: string, items: T[]): T[][] {
  const groups: T[][] = [];
  let cur: T[] = [];
  for (const it of items) {
    const next = [...cur, it];
    if (cur.length > 0 && lmsBytes(bundleTemplate(merchantName, next.map((x) => x.template)).text) > OUTBOUND_BUNDLE_MAX_BYTES) {
      groups.push(cur);
      cur = [it];
    } else cur = next;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// ---------------------------------------------------------------------------
// 보내기
// ---------------------------------------------------------------------------

type QueueRow = Awaited<ReturnType<typeof prisma.outboundQueue.findUniqueOrThrow>>;

/** 원천 기록에 결과를 되돌려 적는다. 실패해도 발송 결과는 바뀌지 않는다. */
async function propagate(item: QueueRow, outcome: 'SENT' | 'FAILED' | 'SKIPPED', info: { mtId?: string | null; channel?: string | null; fallback?: boolean; bundled?: number; reason?: string }) {
  try {
    if (item.source === 'journey') {
      const data =
        outcome === 'SENT'
          ? { detail: info.bundled && info.bundled > 1 ? `묶음 발송(${info.bundled}건 한 통)` : '발송 완료(대기열)' }
          : { outcome: outcome === 'FAILED' ? 'FAILED' : 'SKIPPED', sent: false, detail: (info.reason ?? '발송 실패').slice(0, 300) };
      await prisma.journeyStepLog.updateMany({ where: { dedupeKey: item.sendKey }, data });
    } else if (item.source === 'issued_document' && item.sourceId) {
      await prisma.issuedDocument.update({
        where: { id: item.sourceId },
        data: outcome === 'SENT' ? { sentAt: new Date(), sendCount: { increment: 1 }, sendError: null } : { sendError: (info.reason ?? '문자 발송 실패').slice(0, 300) },
      });
    } else if (item.source === 'notice' && item.sourceId) {
      const d = await prisma.noticeDelivery.findUnique({ where: { id: item.sourceId }, select: { noticeRunId: true, status: true } });
      if (!d || d.status !== 'QUEUED') return;
      const u = await prisma.noticeDelivery.updateMany({
        where: { id: item.sourceId, status: 'QUEUED' },
        data: outcome === 'SENT' ? { status: 'SENT', channel: info.channel ?? null, mtMessageId: info.mtId ?? null } : { status: outcome, reason: info.reason?.slice(0, 200) ?? null, mtMessageId: info.mtId ?? null },
      });
      if (u.count === 0) return;
      await prisma.noticeRun.update({
        where: { id: d.noticeRunId },
        data:
          outcome === 'SENT'
            ? { sentCount: { increment: 1 }, ...(info.channel === 'ALIMTALK' ? { alimtalkCount: { increment: 1 } } : {}), ...(info.fallback ? { fallbackCount: { increment: 1 } } : {}) }
            : outcome === 'FAILED'
              ? { failedCount: { increment: 1 } }
              : { skippedCount: { increment: 1 } },
      });
    }
  } catch (e) {
    logger.warn('발송 대기열 결과 기록 실패', { itemId: item.id, message: (e as Error).message });
  }
}

async function finish(item: QueueRow, status: 'SENT' | 'FAILED' | 'SKIPPED', data: Prisma.OutboundQueueUpdateManyMutationInput, info: Parameters<typeof propagate>[2], skipPropagate: boolean) {
  await prisma.outboundQueue.updateMany({
    where: { id: item.id, status: 'SENDING', lockedBy: item.lockedBy },
    data: { status, lockedAt: null, lockedBy: null, templateEnc: null, ...data },
  });
  if (!skipPropagate) await propagate(item, status, info);
}

async function release(item: QueueRow, data: Prisma.OutboundQueueUpdateManyMutationInput) {
  await prisma.outboundQueue.updateMany({ where: { id: item.id, status: 'SENDING', lockedBy: item.lockedBy }, data: { status: 'QUEUED', lockedAt: null, lockedBy: null, ...data } });
}

/** 하루 보류(3번 넘으면 건너뜀) */
async function defer(item: QueueRow, now: Date, reason: string, skipPropagate: boolean) {
  const deferrals = item.deferrals + 1;
  if (deferrals > OUTBOUND_MAX_DEFERRALS) {
    await finish(item, 'SKIPPED', { deferrals, lastReason: `${reason} — ${OUTBOUND_MAX_DEFERRALS}번 보류되어 건너뜀` }, { reason: `${reason} — 보류가 길어져 건너뜀` }, skipPropagate);
    return;
  }
  await release(item, { deferrals, lastReason: reason, dueAt: new Date(now.getTime() + DAY) });
}

/**
 * 한 후원자의 기한 된 대기분을 묶어 보낸다. 다른 실행이 잡고 있으면 아무것도 하지 않는다.
 * @returns 실제로 나간 문자 수
 */
export async function flushPayer(merchantId: string, payerId: string, now = new Date(), opts: { inlineItemId?: string } = {}): Promise<number> {
  const owner = `${Date.now()}:${generateToken(6)}`;
  const claimAt = new Date(Math.max(Date.now(), now.getTime()));
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outbound:${merchantId}:${payerId}`}))`;
    await tx.outboundQueue.updateMany({
      where: { merchantId, payerId, status: 'QUEUED', dueAt: { lte: now } },
      data: { status: 'SENDING', lockedAt: claimAt, lockedBy: owner },
    });
  });
  const items = await prisma.outboundQueue.findMany({ where: { lockedBy: owner, status: 'SENDING' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] });
  if (items.length === 0) return 0;
  const skipFor = (it: QueueRow) => it.id === opts.inlineItemId;

  // 1) 받는 사람 상태: 탈퇴·차단·안내 수신 거부 → 건너뜀
  const [payer, link, blocked, merchant] = await Promise.all([
    prisma.payerProfile.findUnique({ where: { id: payerId }, select: { onboardingStatus: true, blockedAt: true, phoneEnc: true } }),
    prisma.payerMerchantLink.findUnique({ where: { payerId_merchantId: { payerId, merchantId } }, select: { payerBlockedAt: true, noticeOptOutAt: true } }),
    prisma.blockedPayer.findFirst({ where: { merchantId, payerId }, select: { id: true } }),
    prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { displayName: true } }),
  ]);
  const stop = !payer || payer.onboardingStatus === 'WITHDRAWN' ? '탈퇴한 후원자' : payer.blockedAt || blocked || link?.payerBlockedAt ? '차단 관계' : link?.noticeOptOutAt ? '후원자가 이 기관 안내 수신을 끔' : !merchant ? '기관 없음' : null;
  if (stop) {
    for (const it of items) await finish(it, 'SKIPPED', { lastReason: stop }, { reason: stop }, skipFor(it));
    return 0;
  }

  // 2) 야간 → 다음 날 9시(보류 횟수에 넣지 않음)
  if (isOutboundQuietHour(now)) {
    const until = nextOutboundMorning(now);
    for (const it of items) await release(it, { dueAt: until, lastReason: '야간 발송 보류' });
    return 0;
  }

  // 3) 담당자 확인 전 멈춤(열린 문의·진행 중 환불) — 저니가 이미 확인한 안내(precounted)는 제외
  const fresh = items.filter((i) => !i.precounted);
  let sendable = items.filter((i) => i.precounted);
  if (fresh.length) {
    const pause = await autoPauseReason(merchantId, payerId);
    if (pause) {
      for (const it of fresh) await defer(it, now, `${pause} — 담당자 확인 전 자동 안내 보류`, skipFor(it));
    } else {
      // 4) 7일 상한 — 우선순위 높은 것부터, 넘치는 것은 하루 보류
      const used = await relationalCapCount(prisma, merchantId, payerId, now, owner);
      const room = Math.max(0, RELATIONAL_WEEKLY_CAP - used);
      const ordered = [...fresh].sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime());
      sendable = [...sendable, ...ordered.slice(0, room)];
      for (const it of ordered.slice(room)) await defer(it, now, `후원자당 7일 ${RELATIONAL_WEEKLY_CAP}건 상한`, skipFor(it));
    }
  }
  if (sendable.length === 0) return 0;

  // 5) 본문 복원 → 길이 상한으로 묶기 → 보내기
  const ready: Array<{ item: QueueRow; template: TemplateOutput }> = [];
  for (const it of sendable) {
    try {
      const raw = JSON.parse(decrypt(it.templateEnc ?? '')) as TemplateOutput;
      ready.push({ item: it, template: raw });
    } catch {
      await finish(it, 'FAILED', { lastReason: '본문을 읽지 못함' }, { reason: '본문을 읽지 못함' }, skipFor(it));
    }
  }
  let phone: string;
  try {
    phone = decrypt(payer!.phoneEnc);
  } catch {
    for (const r of ready) await finish(r.item, 'FAILED', { lastReason: '연락처를 읽지 못함' }, { reason: '연락처를 읽지 못함' }, skipFor(r.item));
    return 0;
  }
  ready.sort((a, b) => b.item.priority - a.item.priority || a.item.createdAt.getTime() - b.item.createdAt.getTime());
  // 묶음 본문에는 관리자 공통 문구(치환값이 있는 템플릿)를 먼저 적용한다(한 건이면 sendMtDetailed 가 적용).
  const prepared = ready.length > 1 ? await Promise.all(ready.map(async (r) => ({ ...r, template: await tpl.applyMtTemplateOverride(r.template) }))) : ready;
  let messages = 0;
  for (const group of splitBundles(merchant!.displayName, prepared)) {
    const template = group.length === 1 ? group[0]!.template : bundleTemplate(merchant!.displayName, group.map((g) => g.template));
    const bundleId = group.length > 1 ? newId() : null;
    let res: { ok: boolean; id: string | null; channel: 'SMS' | 'ALIMTALK' | null; fallback: boolean };
    try {
      const r = await sendMtDetailed({ phone, template, merchantId });
      res = { ok: r.ok, id: r.id, channel: r.channel, fallback: r.fallback };
    } catch (e) {
      logger.warn('묶음 발송 예외', { merchantId, message: (e as Error).message });
      res = { ok: false, id: null, channel: null, fallback: false };
    }
    if (res.ok) messages += 1;
    for (const g of group) {
      const it = g.item;
      if (res.ok) {
        await finish(it, 'SENT', { sentAt: new Date(), mtMessageId: res.id, bundleId, attempts: { increment: 1 }, lastReason: null }, { mtId: res.id, channel: res.channel, fallback: res.fallback, bundled: group.length }, skipFor(it));
        continue;
      }
      const attempts = it.attempts + 1;
      // 그 자리에서 보낸(대기 0) 안내는 호출부가 지금처럼 재시도한다. 대기열 안내는 1시간 뒤 다시(3번까지).
      if (skipFor(it) || attempts >= MAX_ATTEMPTS) {
        await finish(it, 'FAILED', { attempts, mtMessageId: res.id, lastReason: '문자 발송 실패' }, { mtId: res.id, reason: '문자 발송 실패' }, skipFor(it));
      } else {
        await release(it, { attempts, mtMessageId: res.id, lastReason: '문자 발송 실패 — 1시간 뒤 다시', dueAt: new Date(now.getTime() + RETRY_GAP_MS) });
      }
    }
  }
  return messages;
}

/** 배치 시간 상한 */
export const OUTBOUND_BATCH_BUDGET_MS = 50_000;

/**
 * 기한 된 대기분 보내기(`/api/cron/outbound`, 1분). 후원자 단위로 묶어 보낸다.
 * 발송 중 멈춘 안내는 UNKNOWN(다시 보내지 않음), 수동 재발송용 본문은 보관 기간이 지나면 지운다.
 */
export async function flushDueOutbound(opts: { now?: Date; limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const out = { payers: 0, messages: 0, stale: 0, purged: 0 };
  const stale = await prisma.outboundQueue.updateMany({
    where: { status: 'SENDING', lockedAt: { lt: new Date(now.getTime() - SENDING_STALE_MS) } },
    data: { status: 'UNKNOWN', lockedAt: null, lockedBy: null, templateEnc: null, lastReason: '발송 중 멈춤 — 두 번 보내지 않도록 다시 보내지 않음' },
  });
  out.stale = stale.count;
  // 스위치를 끈 뒤에도 이미 쌓인 안내는 보낸다(쌓을 때 약속한 발송). 새로 쌓이지는 않는다.
  {
    const groups = await prisma.outboundQueue.groupBy({
      by: ['merchantId', 'payerId'],
      where: { status: 'QUEUED', dueAt: { lte: now } },
      _min: { dueAt: true },
      orderBy: { _min: { dueAt: 'asc' } },
      take: opts.limit ?? 300,
    });
    for (const g of groups) {
      if (Date.now() - started >= (opts.budgetMs ?? OUTBOUND_BATCH_BUDGET_MS)) break;
      out.payers += 1;
      out.messages += await flushPayer(g.merchantId, g.payerId, now).catch((e) => {
        logger.error('발송 대기열 처리 실패', { merchantId: g.merchantId, message: (e as Error).message });
        return 0;
      });
    }
  }
  const purged = await prisma.mtOutboundMessage.updateMany({
    where: { resendBodyEnc: { not: null }, createdAt: { lt: new Date(now.getTime() - RESEND_BODY_RETENTION_DAYS * DAY) } },
    data: { resendBodyEnc: null },
  });
  out.purged = purged.count;
  return out;
}
