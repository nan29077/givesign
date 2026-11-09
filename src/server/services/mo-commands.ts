import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { generateToken, tokenHash } from '@/lib/crypto';
import { campaignOpen, normalizeCampaignCode } from '@/lib/fundraising';
import { MO_COMMAND_LABEL, moCommandKind, type MoCommandKind } from '@/lib/mo-commands';
import { amountShortText, extractAmount, matchIntent, uniqueBest, type IntentEntry } from '@/lib/mo-intent';
import { normalizeText } from './content-filter';
import { promoActive } from './promo-codes';
import * as tpl from './mt-templates';
import type { TemplateOutput } from './mt-templates';

/**
 * 문자를 명령 창구로 (2026-11-12 4차 K3) + 알아듣지 못한 문자 보완 해석 연결 (K2).
 *
 * 해석 순서(charge-flow processMoRow): 라우팅 → 기존 예약어(정기·봉사) → **명령어** → (결제 흐름) 캠페인 키워드 → 홍보물 키워드.
 *  - 명령어는 결제 건을 만들지 않고, 그 번호 본인 확인(인증번호)이 필요한 화면 링크(`/mo/[토큰]`)만 회신한다.
 *  - 기관에 이 단어를 키워드로 쓰는 캠페인(보관 전)이 있으면 명령어로 보지 않는다 — 기존 캠페인 키워드 우선.
 *  - 같은 번호·같은 명령은 10분에 한 번만 링크를 보낸다(문자 폭주 방지, 예약어와 같은 규칙).
 *  - 명령 문자 종류별 수는 단계 기록(funnel_step)에 `COMMAND` 단계 + 이유(종류)로 남긴다(결제 단계와 섞이지 않음 —
 *    채널도 'COMMAND' 라 결제 단계 집계·측정 시작 시각에 들어가지 않는다).
 *
 * 보완 해석(K2)은 **고르기·미리 선택**으로만 쓴다:
 *  - 대표번호 공유에서 기관 키워드를 못 알아본 문자(UNKNOWN_ROUTE) → 비슷한 기관·캠페인이 있으면 고르기 링크(INTENT)
 *  - 기관이 정해진 문자(전용번호 등)는 지금처럼 일반 후원 금액 선택 링크를 보내되, 그 화면에 캠페인·금액을 미리 골라 둔다
 *    (`moIntentHint` → 보안 링크 payload.intent). 결제 건·금액은 후원자가 화면에서 눌러야 정해진다.
 */

export const MO_REPLY_LINK_TTL_SEC = 30 * 60;
export type MoReplyKind = MoCommandKind | 'INTENT';

// ---------------------------------------------------------------------------
// 회신 링크
// ---------------------------------------------------------------------------

export async function issueReplyLink(input: {
  kind: MoReplyKind;
  merchantId: string | null;
  phoneHash: string;
  moMessageId?: string | null;
  payload?: Record<string, unknown>;
  ttlSec?: number;
}) {
  const token = generateToken(24);
  const expiresAt = new Date(Date.now() + (input.ttlSec ?? MO_REPLY_LINK_TTL_SEC) * 1000);
  const row = await prisma.moReplyLink.create({
    data: {
      id: newId(),
      tokenHash: tokenHash(token),
      kind: input.kind,
      merchantId: input.merchantId,
      phoneHash: input.phoneHash,
      moMessageId: input.moMessageId ?? null,
      payload: (input.payload ?? {}) as object,
      expiresAt,
    },
  });
  return { id: row.id, token, url: `${env.baseUrl}/mo/${token}`, expiresAt };
}

export type ReplyLinkRow = NonNullable<Awaited<ReturnType<typeof prisma.moReplyLink.findUnique>>>;

/** 토큰 → 링크. 만료면 EXPIRED. 처음 열면 openedAt 을 남긴다. */
export async function resolveReplyLink(token: string, opts: { markOpened?: boolean } = {}): Promise<{ ok: true; link: ReplyLinkRow } | { ok: false; reason: 'NOT_FOUND' | 'EXPIRED' }> {
  if (!token || token.length > 200) return { ok: false, reason: 'NOT_FOUND' };
  const link = await prisma.moReplyLink.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!link) return { ok: false, reason: 'NOT_FOUND' };
  if (link.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'EXPIRED' };
  if (opts.markOpened && !link.openedAt) {
    await prisma.moReplyLink.updateMany({ where: { id: link.id, openedAt: null }, data: { openedAt: new Date() } }).catch(() => undefined);
  }
  return { ok: true, link };
}

/** 명령 링크의 후원자(그 번호). 탈퇴했거나 없으면 null. */
export async function replyLinkPayer(link: Pick<ReplyLinkRow, 'phoneHash'>) {
  const p = await prisma.payerProfile.findUnique({ where: { phoneHash: link.phoneHash }, select: { id: true, phoneMasked: true, onboardingStatus: true, userId: true } });
  if (!p || p.onboardingStatus === 'WITHDRAWN') return null;
  return p;
}

// ---------------------------------------------------------------------------
// 명령 문자 처리
// ---------------------------------------------------------------------------

/** 명령 문자 종류별 수(단계 기록 COMMAND). 실패해도 흐름을 막지 않는다. */
export async function recordCommandStep(moMessageId: string, merchantId: string, kind: string): Promise<void> {
  try {
    await prisma.funnelStep.createMany({
      data: [{ id: newId(), flowKey: `mo:${moMessageId}`, step: 'COMMAND', merchantId, channel: 'COMMAND', source: 'SMS', moMessageId, reason: kind, occurredAt: new Date() }],
      skipDuplicates: true,
    });
  } catch (e) {
    logger.warn('명령 문자 기록 실패 — 처리는 계속합니다', { message: (e as Error).message });
  }
}

export interface MoCommandOutcome {
  kind: MoCommandKind;
  detail: string;
  message: string;
}

/**
 * 명령 문자면 링크를 회신하고 결과를 돌려준다. 명령이 아니면 null(다음 단계로).
 * 결제 건·멱등키를 만들지 않는다. `send` 는 charge-flow 의 sendMt(순환 import 를 피하려고 받는다).
 */
export async function handleMoCommand(input: {
  merchant: { id: string; displayName: string };
  body: string;
  moRowId: string;
  phoneHash: string;
  send: (template: TemplateOutput) => Promise<boolean>;
}): Promise<MoCommandOutcome | null> {
  const body = normalizeText(input.body ?? '');
  const m = body.match(/^(\S+)(?:\s+[\s\S]*)?$/u);
  if (!m) return null;
  const kind = moCommandKind(m[1]!);
  if (!kind) return null;

  // 기존 캠페인 키워드 우선: 이 단어를 키워드로 쓰는 보관 전 캠페인이 있으면 명령어로 보지 않는다.
  const code = normalizeCampaignCode(m[1]!);
  const owned = await prisma.campaign.findMany({ where: { merchantId: input.merchant.id, status: { not: 'ARCHIVED' } }, select: { code: true } });
  if (owned.some((c) => normalizeCampaignCode(c.code) === code)) return null;

  await recordCommandStep(input.moRowId, input.merchant.id, kind);

  const first = await kv.setnx(`mo:command:${input.merchant.id}:${input.phoneHash}:${kind}`, '1', 600).catch(() => true);
  if (!first) {
    return { kind, detail: `COMMAND_${kind} (10분 내 재요청·링크 생략)`, message: '같은 안내를 방금 보냈습니다. 링크를 다시 보내지 않았습니다.' };
  }
  const link = await issueReplyLink({ kind, merchantId: input.merchant.id, phoneHash: input.phoneHash, moMessageId: input.moRowId });
  await input.send(tpl.tplMoCommandLink({ merchantName: input.merchant.displayName, label: MO_COMMAND_LABEL[kind], link: link.url, ttlMin: MO_REPLY_LINK_TTL_SEC / 60 }));
  return { kind, detail: `COMMAND_${kind}`, message: `${MO_COMMAND_LABEL[kind]} 확인 링크를 보냈습니다. 후원 건은 만들지 않았습니다.` };
}

/** 기관별 명령 문자 수(기간). 결제 단계와 따로 보여 준다. */
export async function commandCounts(merchantId: string | null, since: Date, until = new Date()): Promise<Array<{ kind: string; count: number }>> {
  const rows = await prisma.funnelStep.groupBy({
    by: ['reason'],
    where: { step: 'COMMAND', occurredAt: { gte: since, lt: until }, ...(merchantId ? { merchantId } : {}) },
    _count: { _all: true },
  });
  return rows.filter((r) => r.reason).map((r) => ({ kind: r.reason!, count: r._count._all })).sort((a, b) => b.count - a.count);
}

export const COMMAND_COUNT_LABEL: Record<string, string> = {
  ...MO_COMMAND_LABEL,
  PLEDGE: '정기후원 약정',
  VOLUNTEER: '자원봉사 신청',
};

// ---------------------------------------------------------------------------
// 보완 해석 (K2)
// ---------------------------------------------------------------------------

interface CampaignRef {
  merchantId: string;
  campaignId: string;
}

/** 기관의 모금 중 캠페인 → 비교 키(키워드·별칭·인식 중인 홍보물 키워드) */
async function campaignEntries(merchantIds: string[], now = new Date()): Promise<{ entries: Array<IntentEntry<string>>; refs: Map<string, CampaignRef & { code: string; title: string }> }> {
  const campaigns = (await prisma.campaign.findMany({ where: { merchantId: { in: merchantIds }, status: 'ACTIVE' } })).filter((c) => campaignOpen(c, now));
  const promos = campaigns.length
    ? await prisma.campaignPromo.findMany({ where: { campaignId: { in: campaigns.map((c) => c.id) }, archivedAt: null, keyword: { not: null } } })
    : [];
  const entries: Array<IntentEntry<string>> = [];
  const refs = new Map<string, CampaignRef & { code: string; title: string }>();
  for (const c of campaigns) {
    refs.set(c.id, { merchantId: c.merchantId, campaignId: c.id, code: c.code, title: c.title });
    entries.push({ key: c.code, ref: c.id });
    for (const a of c.aliases) entries.push({ key: a, alias: true, ref: c.id });
  }
  for (const p of promos) if (p.keyword && promoActive(p, now)) entries.push({ key: p.keyword, ref: p.campaignId });
  return { entries, refs };
}

export interface MoIntentHint {
  campaignId?: string;
  amount?: number;
  /** 화면 안내용 */
  note: string;
}

/**
 * 기관이 정해진 MO 의 금액 선택 화면에 미리 골라 둘 값. 캠페인 키워드가 이미 맞았으면 금액만 본다.
 * 아무것도 못 찾으면 null(화면은 지금과 같다).
 */
export async function moIntentHint(merchantId: string, body: string, matched: { campaign: { id: string } | null; rest: string }): Promise<MoIntentHint | null> {
  try {
    const source = matched.campaign ? matched.rest : body;
    const amt = extractAmount(source);
    let campaignId: string | undefined;
    if (!matched.campaign) {
      const { entries } = await campaignEntries([merchantId]);
      const best = uniqueBest(matchIntent(amt ? amt.rest : body, entries));
      if (best) campaignId = best.ref;
    }
    if (!campaignId && !amt) return null;
    const parts = [campaignId ? '캠페인' : null, amt ? '금액' : null].filter(Boolean).join('·');
    return { ...(campaignId ? { campaignId } : {}), ...(amt ? { amount: amt.amount } : {}), note: `보내신 문자 내용으로 ${parts}을 미리 골라 두었습니다. 맞는지 확인한 뒤 눌러 주세요.` };
  } catch (e) {
    logger.warn('문자 의도 해석 실패 — 일반 화면으로 보냅니다', { message: (e as Error).message });
    return null;
  }
}

/** 보안 링크 payload 에서 미리 선택 값을 읽는다(형식이 다르면 무시). */
export function readIntentHint(payload: unknown): MoIntentHint | null {
  const p = (payload ?? {}) as { intent?: { campaignId?: unknown; amount?: unknown; note?: unknown } };
  const i = p.intent;
  if (!i || typeof i !== 'object') return null;
  const campaignId = typeof i.campaignId === 'string' ? i.campaignId : undefined;
  const amount = typeof i.amount === 'number' && Number.isInteger(i.amount) && i.amount > 0 ? i.amount : undefined;
  if (!campaignId && !amount) return null;
  return { campaignId, amount, note: typeof i.note === 'string' ? i.note : '보내신 문자 내용으로 미리 골라 두었습니다.' };
}

export interface IntentCandidate {
  merchantId: string;
  merchantCode: string;
  merchantName: string;
  /** 대표번호 기관 키워드 */
  merchantKeyword: string;
  campaignId: string | null;
  campaignCode: string | null;
  campaignTitle: string | null;
}

/**
 * 대표번호 공유 번호로 온 문자인데 기관 키워드를 못 알아본 경우(UNKNOWN_ROUTE) 비슷한 기관·캠페인을 찾는다.
 *  1) 맨 앞 낱말이 어느 기관 키워드와 오타 거리 안이면 그 기관(나머지에서 캠페인을 다시 찾음)
 *  2) 아니면 그 번호를 쓰는 모든 기관의 모금 중 캠페인 키워드·별칭·홍보물과 비교
 * 전용번호가 걸린 번호(라우팅 충돌 포함)는 보지 않는다. 최대 5개.
 */
export async function findIntentCandidates(receivedNumber: string, body: string, now = new Date()): Promise<{ candidates: IntentCandidate[]; amount: number | null }> {
  const rows = await prisma.merchantMoNumber.findMany({
    where: { phoneNumber: receivedNumber, status: 'ASSIGNED', merchantId: { not: null } },
    include: { merchant: { select: { id: true, code: true, displayName: true, status: true, user: { select: { status: true, deletedAt: true } } } } },
  });
  if (rows.some((r) => r.mode === 'DEDICATED')) return { candidates: [], amount: null };
  const shared = rows.filter((r) => r.mode === 'SHARED_PREFIX' && r.keyword && r.merchant && r.merchant.status === 'APPROVED' && r.merchant.user.status === 'ACTIVE' && !r.merchant.user.deletedAt);
  if (shared.length === 0) return { candidates: [], amount: null };

  const text = normalizeText(body ?? '');
  const amt = extractAmount(text);
  const remain = amt ? amt.rest : text;
  const byMerchant = new Map(shared.map((r) => [r.merchant!.id, r]));
  const out: IntentCandidate[] = [];
  const push = (merchantId: string, c: { campaignId: string; code: string; title: string } | null) => {
    const r = byMerchant.get(merchantId)!;
    if (out.some((o) => o.merchantId === merchantId && o.campaignId === (c?.campaignId ?? null))) return;
    out.push({
      merchantId,
      merchantCode: r.merchant!.code,
      merchantName: r.merchant!.displayName,
      merchantKeyword: r.keyword!,
      campaignId: c?.campaignId ?? null,
      campaignCode: c?.code ?? null,
      campaignTitle: c?.title ?? null,
    });
  };

  // (1) 기관 키워드 오타
  const tokens = remain.split(/\s+/u).filter(Boolean);
  const merchantMatches = matchIntent(tokens[0] ?? '', shared.map((r) => ({ key: r.keyword!, ref: r.merchant!.id })));
  const bestMerchant = uniqueBest(merchantMatches.filter((x) => x.via === 'TYPO' || x.via === 'SPACING' || x.via === 'SUFFIX'));
  if (bestMerchant) {
    const rest = tokens.slice(1).join(' ');
    const { entries, refs } = await campaignEntries([bestMerchant.ref], now);
    const best = rest ? uniqueBest(matchIntent(rest, entries)) : null;
    const ref = best ? refs.get(best.ref) : null;
    push(bestMerchant.ref, ref ? { campaignId: ref.campaignId, code: ref.code, title: ref.title } : null);
    return { candidates: out, amount: amt?.amount ?? null };
  }

  // (2) 모든 기관 캠페인
  const { entries, refs } = await campaignEntries([...byMerchant.keys()], now);
  for (const m of matchIntent(remain, entries).slice(0, 5)) {
    const ref = refs.get(m.ref);
    if (ref) push(ref.merchantId, { campaignId: ref.campaignId, code: ref.code, title: ref.title });
  }
  return { candidates: out.slice(0, 5), amount: amt?.amount ?? null };
}

/**
 * UNKNOWN_ROUTE 회신을 고르기 링크로 바꿀 수 있으면 보내고 true. 후보가 없으면 false(호출부가 예전 안내를 보낸다).
 * 결제 건·멱등키를 만들지 않는다.
 */
export async function suggestForUnknownRoute(input: {
  receivedNumber: string;
  body: string;
  phoneHash: string;
  moRowId: string;
  send: (template: TemplateOutput) => Promise<boolean>;
}): Promise<{ sent: boolean; count: number }> {
  try {
    const { candidates, amount } = await findIntentCandidates(input.receivedNumber, input.body);
    if (candidates.length === 0) return { sent: false, count: 0 };
    const merchantIds = [...new Set(candidates.map((c) => c.merchantId))];
    const link = await issueReplyLink({
      kind: 'INTENT',
      merchantId: merchantIds.length === 1 ? merchantIds[0]! : null,
      phoneHash: input.phoneHash,
      moMessageId: input.moRowId,
      payload: { candidates, amount, receivedNumber: input.receivedNumber },
    });
    const sent = await input.send(tpl.tplMoIntentLink({ merchantName: merchantIds.length === 1 ? candidates[0]!.merchantName : null, link: link.url }));
    return { sent, count: candidates.length };
  } catch (e) {
    logger.warn('알아듣지 못한 문자 보완 해석 실패 — 예전 안내를 보냅니다', { message: (e as Error).message });
    return { sent: false, count: 0 };
  }
}

/** INTENT 링크 payload 읽기 */
export function readIntentPayload(payload: unknown): { candidates: IntentCandidate[]; amount: number | null; receivedNumber: string | null } {
  const p = (payload ?? {}) as { candidates?: unknown; amount?: unknown; receivedNumber?: unknown };
  const candidates = Array.isArray(p.candidates) ? (p.candidates as IntentCandidate[]).filter((c) => c && typeof c.merchantId === 'string').slice(0, 5) : [];
  return {
    candidates,
    amount: typeof p.amount === 'number' ? p.amount : null,
    receivedNumber: typeof p.receivedNumber === 'string' ? p.receivedNumber : null,
  };
}

/** 고르기 화면의 "문자로 다시 보내기" 본문 */
export function intentSmsBody(c: IntentCandidate, amount: number | null) {
  return [c.merchantKeyword, c.campaignCode, amount ? amountShortText(amount) : null].filter(Boolean).join(' ') + ' ';
}
