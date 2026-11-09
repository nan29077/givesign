import { createHash } from 'node:crypto';
import { prisma } from '@/server/db';
import { kstDateKey } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import { featureContentEnabled } from '@/lib/env';
import { PREFLIGHT_BLOCK_PREFIX } from './purpose-documents';

/**
 * 승인 대기함 — 원인별 묶음(예외 그룹) (2026-11-09 과제 C1).
 *
 * 같은 원인의 개별 항목을 한 줄로 묶어 "무엇 때문에 몇 명이 멈췄고, 무엇을 누르면 풀리는지" 를 보여 준다.
 * 원천 테이블에서 그때그때 센다(복사하지 않음). 다른 영역(정기후원 복구 등)은 `registerInboxGroupProvider` 로
 * 같은 형식의 묶음을 넣는다. 제공자 하나가 실패하거나 늦어도 화면 전체는 깨지지 않는다(그 묶음만 "불러오지 못함").
 *
 * 결과를 모르는 건(UNKNOWN)에는 "다시 실행" 을 주지 않고 "결과 확인" 으로만 안내한다(절대 규칙 — 자동 재실행 금지).
 */

/** 다른 작업자와 맞춘 형식 — 바꾸지 않는다. */
export interface InboxExceptionGroup {
  kind: string;
  title: string;
  reason: string;
  affectedCount: number;
  amount?: bigint | null;
  oldestAt: Date;
  href: string;
  recommendedAction: string;
  actions?: Array<{ label: string; action: string; payload?: Record<string, string> }>;
  severity?: 'high' | 'normal';
}

export interface InboxGroupContext {
  merchantId: string;
  now: Date;
}

export type InboxGroupProvider = (ctx: InboxGroupContext) => Promise<InboxExceptionGroup | InboxExceptionGroup[] | null>;

interface ProviderEntry {
  name: string;
  label: string;
  fn: InboxGroupProvider;
}

const providers = new Map<string, ProviderEntry>();

/**
 * 묶음 제공자 등록. 같은 이름으로 다시 부르면 바꿔 끼운다(멱등).
 * @param label 불러오지 못했을 때 화면에 쓸 이름
 */
export function registerInboxGroupProvider(name: string, fn: InboxGroupProvider, label = name) {
  providers.set(name, { name, label, fn });
}

export function unregisterInboxGroupProvider(name: string) {
  providers.delete(name);
}

export function registeredInboxGroupProviders(): string[] {
  ensureDefaults();
  return [...providers.keys()];
}

export interface LoadedInboxGroup {
  /** 담당자 배정 키 */
  key: string;
  provider: string;
  group: InboxExceptionGroup | null;
  /** 제공자가 실패·시간 초과했을 때 */
  error?: string;
  errorLabel?: string;
}

/** 묶음 키(담당자 배정 키). kind 가 같으면 같은 키다. */
export function groupKey(kind: string) {
  return `group:${kind}`;
}

const PROVIDER_TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('시간 초과')), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/** 모든 제공자를 부른다. 실패한 제공자는 error 를 단 자리표시로 돌려준다. 영향 0 인 묶음은 뺀다. */
export async function loadInboxGroups(merchantId: string, now = new Date()): Promise<LoadedInboxGroup[]> {
  ensureDefaults();
  const ctx = { merchantId, now };
  const entries = [...providers.values()];
  const settled = await Promise.allSettled(entries.map((e) => withTimeout(Promise.resolve().then(() => e.fn(ctx)), PROVIDER_TIMEOUT_MS)));
  const out: LoadedInboxGroup[] = [];
  settled.forEach((s, i) => {
    const e = entries[i]!;
    if (s.status === 'rejected') {
      logger.warn('승인 대기함 묶음 불러오기 실패', { provider: e.name, message: (s.reason as Error)?.message });
      out.push({ key: groupKey(e.name), provider: e.name, group: null, error: '불러오지 못함', errorLabel: e.label });
      return;
    }
    const list = s.value == null ? [] : Array.isArray(s.value) ? s.value : [s.value];
    for (const g of list) {
      if (!g || g.affectedCount <= 0) continue;
      out.push({ key: groupKey(g.kind), provider: e.name, group: g });
    }
  });
  return out;
}

/** 정렬: 기한 넘김 → 영향 큰 순 → 오래된 순. 불러오지 못한 묶음은 맨 아래. */
export function sortInboxGroups<T extends LoadedInboxGroup>(list: T[], overdue: (key: string) => boolean): T[] {
  return [...list].sort((a, b) => {
    if (!a.group || !b.group) return a.group ? -1 : b.group ? 1 : 0;
    const oa = overdue(a.key) ? 1 : 0;
    const ob = overdue(b.key) ? 1 : 0;
    if (oa !== ob) return ob - oa;
    const ha = a.group.severity === 'high' ? 1 : 0;
    const hb = b.group.severity === 'high' ? 1 : 0;
    if (ha !== hb) return hb - ha;
    if (a.group.affectedCount !== b.group.affectedCount) return b.group.affectedCount - a.group.affectedCount;
    return a.group.oldestAt.getTime() - b.group.oldestAt.getTime();
  });
}

// ---------------------------------------------------------------------------
// 기본 제공자
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const RECENT_MS = 14 * DAY;

/** 연간 영수증 준비 — 영수증 정보가 없는 지난해 후원자. 연 1회 발급 기관, 1~2월 또는 영수증 일괄 발급 요청이 살아 있을 때. */
export async function receiptInfoGroup(ctx: InboxGroupContext): Promise<InboxExceptionGroup | null> {
  const m = await prisma.merchantProfile.findUnique({
    where: { id: ctx.merchantId },
    select: { receiptCycle: true, businessNo: true, representativeName: true, address: true, designatedDonee: true, designatedDoneeVerifiedAt: true, designatedDoneeUntil: true },
  });
  if (!m || m.receiptCycle !== 'YEARLY') return null;
  const { issuerReadiness } = await import('./receipts');
  if (!issuerReadiness(m).ok) return null;
  const key = kstDateKey(ctx.now);
  const month = Number(key.slice(5, 7));
  const taxYear = Number(key.slice(0, 4)) - 1;
  const live = await prisma.approvalRequest.count({ where: { merchantId: ctx.merchantId, kind: 'RECEIPT_BATCH', status: { in: ['PENDING', 'PROCESSING', 'QUEUED', 'FAILED'] } } });
  if (!(month <= 2 || live > 0)) return null;
  const s = await receiptInfoSegments(ctx.merchantId, taxYear);
  if (s.total === 0) return null;
  const parts = [`안내 가능 ${s.contactable.length}명`];
  if (s.alreadyGuided) parts.push(`이미 안내함 ${s.alreadyGuided}명`);
  if (s.unreachable.length) parts.push(`연락 확인 필요 ${s.unreachable.length}명(${[...new Set(s.unreachable.map((u) => u.why))].join('·')})`);
  return {
    kind: 'RECEIPT_INFO_MISSING',
    title: '연간 영수증 준비가 멈춘 이유',
    reason: `${taxYear}년 영수증 정보가 없는 후원자 ${s.total}명: ${parts.join(' · ')}`,
    affectedCount: s.total,
    amount: s.amount,
    oldestAt: s.oldestAt ?? ctx.now,
    href: '/studio/receipts',
    recommendedAction: s.contactable.length
      ? `${s.contactable.length}명에게 영수증 정보 등록 방법을 안내하세요. 등록하면 다음 영수증 준비에 포함됩니다.`
      : '연락이 닿지 않는 후원자는 후원자 관리에서 연락처·수신 여부를 확인하세요.',
    actions: s.contactable.length ? [{ label: `${s.contactable.length}명에게 등록 안내 보내기`, action: 'receipt.send_info', payload: { taxYear: String(taxYear) } }] : [],
    severity: month <= 2 ? 'high' : 'normal',
  };
}

export interface ReceiptInfoSegments {
  total: number;
  amount: bigint;
  oldestAt: Date | null;
  contactable: string[];
  alreadyGuided: number;
  unreachable: Array<{ payerId: string; why: string }>;
}

/** 영수증 정보 미등록자를 "안내 가능 / 이미 안내함 / 연락 확인 필요" 로 나눈다. */
export async function receiptInfoSegments(merchantId: string, taxYear: number): Promise<ReceiptInfoSegments> {
  const { receiptCandidates } = await import('./receipts');
  const cands = (await receiptCandidates(merchantId, taxYear)).filter((c) => !c.ready && !c.conflict);
  const ids = cands.map((c) => c.payerId);
  const [links, blocked, events, payers, firsts] = await Promise.all([
    prisma.payerMerchantLink.findMany({ where: { merchantId, payerId: { in: ids } }, select: { payerId: true, noticeOptOutAt: true, payerBlockedAt: true } }),
    prisma.blockedPayer.findMany({ where: { merchantId, payerId: { in: ids } }, select: { payerId: true } }),
    prisma.domainEvent.findMany({ where: { dedupeKey: { in: ids.map((p) => receiptInfoDedupeKey(merchantId, p, taxYear)) } }, select: { payerId: true } }),
    prisma.payerProfile.findMany({ where: { id: { in: ids } }, select: { id: true, phoneMasked: true } }),
    prisma.charge.groupBy({ by: ['payerId'], where: { merchantId, payerId: { in: ids }, receiptId: null, paidAt: { gte: new Date(Date.UTC(taxYear, 0, 1, -9)), lt: new Date(Date.UTC(taxYear + 1, 0, 1, -9)) } }, _min: { paidAt: true } }),
  ]);
  const linkMap = new Map(links.map((l) => [l.payerId, l]));
  const blockedSet = new Set(blocked.map((b) => b.payerId));
  const guided = new Set(events.map((e) => e.payerId));
  const phone = new Map(payers.map((p) => [p.id, p.phoneMasked]));
  const out: ReceiptInfoSegments = { total: cands.length, amount: 0n, oldestAt: null, contactable: [], alreadyGuided: 0, unreachable: [] };
  for (const f of firsts) if (f._min.paidAt && (!out.oldestAt || f._min.paidAt < out.oldestAt)) out.oldestAt = f._min.paidAt;
  for (const c of cands) {
    out.amount += c.amount;
    const l = linkMap.get(c.payerId);
    if (c.withdrawn) out.unreachable.push({ payerId: c.payerId, why: '탈퇴' });
    else if (!phone.get(c.payerId)) out.unreachable.push({ payerId: c.payerId, why: '번호 없음' });
    else if (blockedSet.has(c.payerId) || l?.payerBlockedAt) out.unreachable.push({ payerId: c.payerId, why: '차단' });
    else if (l?.noticeOptOutAt) out.unreachable.push({ payerId: c.payerId, why: '수신 거부' });
    else if (guided.has(c.payerId)) out.alreadyGuided += 1;
    else out.contactable.push(c.payerId);
  }
  return out;
}

/** 연간 영수증 배치(receipt-batch.ts)와 같은 키 — 같은 사람에게 한 해 한 번만 안내한다. */
export function receiptInfoDedupeKey(merchantId: string, payerId: string, taxYear: number) {
  return `receipt.info_needed:${merchantId}:${payerId}:${taxYear}`;
}

/** 자동 안내 실패를 이유별로 묶는다. */
export function journeyFailureClass(lastError: string | null): { code: string; label: string; retryable: boolean } {
  const e = lastError ?? '';
  if (e.startsWith(PREFLIGHT_BLOCK_PREFIX)) return { code: 'PREFLIGHT', label: '발송 전 점검에서 막힘(빈칸·연락처 등)', retryable: true };
  if (/잔액/.test(e)) return { code: 'BALANCE', label: '전자문서 이용 잔액 부족', retryable: true };
  if (/서식/.test(e)) return { code: 'TEMPLATE', label: '서식 문제', retryable: true };
  const code = createHash('sha1').update(e.slice(0, 60)).digest('hex').slice(0, 8);
  return { code: `E${code}`, label: e ? e.slice(0, 60) : '알 수 없는 오류', retryable: true };
}

export async function journeyFailedGroups(ctx: InboxGroupContext): Promise<InboxExceptionGroup[]> {
  const runs = await prisma.journeyRun.findMany({
    where: { merchantId: ctx.merchantId, status: 'FAILED', finishedAt: { gte: new Date(ctx.now.getTime() - RECENT_MS) } },
    select: { id: true, payerId: true, lastError: true, finishedAt: true, journeyKey: true },
    take: 500,
  });
  const by = new Map<string, { cls: ReturnType<typeof journeyFailureClass>; payers: Set<string>; runs: number; oldest: Date }>();
  for (const r of runs) {
    const cls = journeyFailureClass(r.lastError);
    const g = by.get(cls.code) ?? { cls, payers: new Set<string>(), runs: 0, oldest: r.finishedAt ?? ctx.now };
    g.runs += 1;
    if (r.payerId) g.payers.add(r.payerId);
    if (r.finishedAt && r.finishedAt < g.oldest) g.oldest = r.finishedAt;
    by.set(cls.code, g);
  }
  return [...by.values()].map((g) => ({
    kind: `JOURNEY_FAILED.${g.cls.code}`,
    title: `자동 안내 실패 — ${g.cls.label}`,
    reason: `최근 14일 자동 안내 ${g.runs}건이 같은 이유로 멈췄습니다.`,
    affectedCount: g.payers.size || g.runs,
    oldestAt: g.oldest,
    href: '/studio/journeys',
    recommendedAction:
      g.cls.code === 'PREFLIGHT'
        ? '서식의 빈칸(필수 항목)이나 후원자 연락처를 고친 뒤 다시 실행하세요. 이미 보낸 단계는 다시 보내지 않습니다.'
        : g.cls.code === 'BALANCE'
          ? '전자문서 이용요금을 충전한 뒤 다시 실행하세요.'
          : '원인을 확인한 뒤 다시 실행하세요. 이미 보낸 단계는 다시 보내지 않습니다.',
    actions: g.cls.retryable ? [{ label: `${g.runs}건 다시 실행`, action: 'journey.retry_failed', payload: { cls: g.cls.code } }] : [],
    severity: g.cls.code === 'PREFLIGHT' ? 'high' : 'normal',
  }));
}

/** 게시 실패 / 결과 미확인. 결과 미확인은 "결과 확인" 만(다시 실행 버튼 없음). */
export async function publishGroups(ctx: InboxGroupContext): Promise<InboxExceptionGroup[]> {
  if (!featureContentEnabled()) return [];
  const rows = await prisma.contentPublish.findMany({
    where: { item: { merchantId: ctx.merchantId }, OR: [{ status: 'FAILED', updatedAt: { gte: new Date(ctx.now.getTime() - RECENT_MS) } }, { status: 'UNKNOWN' }] },
    select: { id: true, itemId: true, status: true, updatedAt: true },
    take: 300,
  });
  const out: InboxExceptionGroup[] = [];
  const failed = rows.filter((r) => r.status === 'FAILED');
  const unknown = rows.filter((r) => r.status === 'UNKNOWN');
  const oldest = (l: typeof rows) => l.reduce((a, r) => (r.updatedAt < a ? r.updatedAt : a), l[0]!.updatedAt);
  const hrefOf = (l: typeof rows) => (new Set(l.map((r) => r.itemId)).size === 1 ? `/studio/content/${l[0]!.itemId}` : '/studio/content');
  if (unknown.length) {
    out.push({
      kind: 'PUBLISH_UNKNOWN',
      title: 'SNS 게시 결과 미확인',
      reason: `게시 도중 응답이 끊겨 실제로 올라갔는지 모르는 게시 ${unknown.length}건`,
      affectedCount: unknown.length,
      oldestAt: oldest(unknown),
      href: hrefOf(unknown),
      recommendedAction: '채널에서 올라갔는지 먼저 확인한 뒤 콘텐츠 화면에서 "게시됨으로 표시" 또는 "다시 게시" 를 고르세요(자동으로 다시 올리지 않습니다).',
      actions: [],
      severity: 'high',
    });
  }
  if (failed.length) {
    out.push({
      kind: 'PUBLISH_FAILED',
      title: 'SNS 게시 실패',
      reason: `최근 14일 게시에 실패한 ${failed.length}건(채널 연결·형식·캡션 길이 등)`,
      affectedCount: failed.length,
      oldestAt: oldest(failed),
      href: hrefOf(failed),
      recommendedAction: '채널 연결 상태와 실패 이유를 확인한 뒤 콘텐츠 화면에서 다시 예약하세요.',
      actions: [],
    });
  }
  return out;
}

export const ESIGN_EXPIRING_DAYS = 3;

export interface EsignSegments {
  unviewed: string[];
  viewed: string[];
  expiring: string[];
  oldestAt: Date | null;
}

/** 서명 대기 봉투를 미열람 / 열람 후 미서명 / 만료 임박(3일) 으로 나눈다(봉투 id 목록). */
export async function esignSegments(merchantId: string, now: Date): Promise<EsignSegments> {
  const envs = await prisma.eDocEnvelope.findMany({
    where: { merchantId, status: { in: ['SENT', 'IN_PROGRESS'] }, expiresAt: { gt: now } },
    select: { id: true, sentAt: true, expiresAt: true, signers: { select: { status: true, viewedAt: true } } },
    take: 500,
  });
  const s: EsignSegments = { unviewed: [], viewed: [], expiring: [], oldestAt: null };
  for (const e of envs) {
    const pending = e.signers.filter((x) => x.status === 'SENT' || x.status === 'VIEWED');
    if (!pending.length) continue;
    if (!s.oldestAt || e.sentAt < s.oldestAt) s.oldestAt = e.sentAt;
    if (pending.some((x) => x.status === 'VIEWED' || x.viewedAt)) s.viewed.push(e.id);
    else s.unviewed.push(e.id);
    if (e.expiresAt.getTime() - now.getTime() <= ESIGN_EXPIRING_DAYS * DAY) s.expiring.push(e.id);
  }
  return s;
}

export async function esignGroup(ctx: InboxGroupContext): Promise<InboxExceptionGroup | null> {
  const s = await esignSegments(ctx.merchantId, ctx.now);
  const total = new Set([...s.unviewed, ...s.viewed]).size;
  if (!total) return null;
  const actions: NonNullable<InboxExceptionGroup['actions']> = [];
  if (s.unviewed.length) actions.push({ label: `미열람 ${s.unviewed.length}건 재안내`, action: 'edoc.remind', payload: { segment: 'unviewed' } });
  if (s.viewed.length) actions.push({ label: `열람 후 미서명 ${s.viewed.length}건 재안내`, action: 'edoc.remind', payload: { segment: 'viewed' } });
  if (s.expiring.length) actions.push({ label: `만료 임박 ${s.expiring.length}건 재안내`, action: 'edoc.remind', payload: { segment: 'expiring' } });
  return {
    kind: 'ESIGN_PENDING',
    title: '전자서명 미완료',
    reason: `서명을 기다리는 문서 ${total}건: 미열람 ${s.unviewed.length} · 열람 후 미서명 ${s.viewed.length} · 만료 임박(${ESIGN_EXPIRING_DAYS}일) ${s.expiring.length}`,
    affectedCount: total,
    oldestAt: s.oldestAt ?? ctx.now,
    href: '/studio/e-documents',
    recommendedAction: s.expiring.length ? `기한이 ${ESIGN_EXPIRING_DAYS}일 안에 끝나는 ${s.expiring.length}건부터 재안내하세요(서명자마다 하루 한 번).` : '오래 열지 않은 서명 요청에 재안내를 보내세요(서명자마다 하루 한 번).',
    actions,
    severity: s.expiring.length ? 'high' : 'normal',
  };
}

/** 잔액 부족으로 보류된 자동 발송(저니 문서 단계). 필요 금액 = (막힌 건수 − 지금 보낼 수 있는 건수) × 1건 요금. */
export async function edocBalanceGroup(ctx: InboxGroupContext): Promise<InboxExceptionGroup | null> {
  const logs = await prisma.journeyStepLog.findMany({
    where: { merchantId: ctx.merchantId, outcome: 'BLOCKED', detail: { startsWith: '전자문서 이용 잔액 부족' }, at: { gte: new Date(ctx.now.getTime() - RECENT_MS) } },
    select: { runId: true, stepIndex: true, at: true },
    orderBy: { at: 'asc' },
    take: 1000,
  });
  if (!logs.length) return null;
  const runIds = [...new Set(logs.map((l) => l.runId))];
  const open = await prisma.journeyRun.findMany({ where: { id: { in: runIds }, status: 'WAITING' }, select: { id: true, stepIndex: true } });
  const blocked = open.filter((r) => logs.some((l) => l.runId === r.id && l.stepIndex === r.stepIndex));
  if (!blocked.length) return null;
  const { walletOverview } = await import('./edoc-billing');
  const w = await walletOverview(ctx.merchantId);
  const short = Math.max(0, blocked.length - w.sendable);
  const oldest = logs.find((l) => blocked.some((b) => b.id === l.runId))?.at ?? ctx.now;
  return {
    kind: 'EDOC_BALANCE',
    title: '전자문서 잔액 부족으로 막힌 발송',
    reason: `서명이 필요한 문서 ${blocked.length}건이 이용 잔액이 없어 보류 중입니다${short ? ` · 부족 ${short}건` : ' · 지금 잔액으로 보낼 수 있습니다(다음 재시도 때 나갑니다)'}`,
    affectedCount: blocked.length,
    amount: BigInt(short * w.plan.perDocument),
    oldestAt: oldest,
    href: '/studio/document-billing',
    recommendedAction: short ? `전자문서 이용요금을 ${(short * w.plan.perDocument).toLocaleString('ko-KR')}원 이상 충전하세요. 충전되면 하루 안에 자동으로 다시 보냅니다.` : '추가 조치 없이 다음 재시도 때 보냅니다.',
    actions: [],
    severity: short ? 'high' : 'normal',
  };
}

let defaultsRegistered = false;
function ensureDefaults() {
  if (defaultsRegistered) return;
  defaultsRegistered = true;
  // 이미 다른 모듈이 같은 이름으로 넣었으면 덮지 않는다.
  const def = (name: string, label: string, fn: InboxGroupProvider) => {
    if (!providers.has(name)) registerInboxGroupProvider(name, fn, label);
  };
  def('receipt-info', '연간 영수증 준비', receiptInfoGroup);
  def('journey-failed', '자동 안내 실패', journeyFailedGroups);
  def('publish', 'SNS 게시', publishGroups);
  def('esign', '전자서명 미완료', esignGroup);
  def('edoc-balance', '전자문서 잔액', edocBalanceGroup);
}

/** 테스트용: 기본 제공자를 다시 깐다. */
export function resetInboxGroupProviders() {
  providers.clear();
  defaultsRegistered = false;
}
