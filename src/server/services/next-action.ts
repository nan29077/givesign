import { prisma } from '@/server/db';
import { Prisma } from '@/generated/prisma/client';
import { PAID_STATUSES } from '@/components/studio/shared';
import { kstDateKey } from '@/lib/datetime';
import { issuerReadiness } from './receipts';
import { pauseFactsFor } from './outbound/pause';

/**
 * 후원자별 "다음 업무" 판단 (2026-11-09 D1).
 *
 * (기관, 후원자) → 지금 가장 필요한 한 가지 + 이유. 설명 가능한 규칙만 쓴다(예측 모델 없음).
 * 우선순위는 `nextActionOrder` 한 곳이다. 저니가 이미 처리 중이면 `autoHandled` + 다음 실행 시각.
 * 목록(후원자 관리·후원자·봉사자·대시보드)은 `nextActionsForMerchant` 로 기관 단위로 한꺼번에 계산한다(후원자마다 쿼리하지 않음).
 */

export type NextActionKey = 'STAFF_CHECK' | 'RECURRING_ACTION' | 'SIGN_PENDING' | 'RECEIPT_INFO' | 'FIRST_THANKS' | 'VOLUNTEER_REVIEW' | 'NONE';

export interface NextAction {
  key: NextActionKey;
  label: string;
  reason: string;
  /** 담당자가 누를 곳(없으면 null) */
  suggestedAction: { label: string; href: string } | null;
  /** 저니·배치가 이미 처리 중 — 담당자 할 일이 아님 */
  autoHandled: boolean;
  /** 자동 처리의 다음 실행 시각 */
  nextRunAt: Date | null;
}

export const NEXT_ACTION_LABEL: Record<NextActionKey, string> = {
  STAFF_CHECK: '담당자 확인',
  RECURRING_ACTION: '정기 출금 조치 필요',
  SIGN_PENDING: '서명 미완료',
  RECEIPT_INFO: '영수증 정보 미등록',
  FIRST_THANKS: '첫 후원 감사 미발송',
  VOLUNTEER_REVIEW: '봉사 신청 확인',
  NONE: '할 일 없음',
};

/**
 * 우선순위 표(코드 한 곳).
 *   환불 진행 중·열린 문의 → 담당자 확인(자동 안내 멈춤) > 정기 출금 조치 필요 > 서명 미완료 > 영수증 정보 미등록 > 첫 후원 감사 미발송 > (봉사 신청 확인) > 없음
 * 1~2월(KST)은 연말정산 시기라 영수증 정보 미등록을 서명 미완료 앞으로 올린다(가중).
 */
export function nextActionOrder(now = new Date()): Exclude<NextActionKey, 'NONE'>[] {
  const month = Number(kstDateKey(now).slice(5, 7));
  const base: Exclude<NextActionKey, 'NONE'>[] = ['STAFF_CHECK', 'RECURRING_ACTION', 'SIGN_PENDING', 'RECEIPT_INFO', 'FIRST_THANKS', 'VOLUNTEER_REVIEW'];
  if (month === 1 || month === 2) return ['STAFF_CHECK', 'RECURRING_ACTION', 'RECEIPT_INFO', 'SIGN_PENDING', 'FIRST_THANKS', 'VOLUNTEER_REVIEW'];
  return base;
}

/** 첫 후원 감사는 첫 후원이 이 기간 안일 때만 본다(기능 이전 후원자가 모두 걸리지 않게). */
export const FIRST_THANKS_WINDOW_DAYS = 60;

/** 저니 (journeyKey, 현재 단계) → 그 저니가 처리 중인 다음 업무 */
const JOURNEY_HANDLES: Record<string, Partial<Record<string, NextActionKey>>> = {
  'donation-thanks': { 'thanks-letter': 'FIRST_THANKS', 'wait-receipt': 'RECEIPT_INFO', 'receipt-info': 'RECEIPT_INFO' },
  'receipt-info-yearend': { 'receipt-info': 'RECEIPT_INFO' },
  'recurring-resume': { wait: 'RECURRING_ACTION', 'resume-guide': 'RECURRING_ACTION' },
};
const JOURNEY_STEP_KEYS: Record<string, string[]> = {
  'donation-thanks': ['thanks-letter', 'wait-receipt', 'receipt-info'],
  'receipt-info-yearend': ['receipt-info'],
  'recurring-resume': ['wait', 'resume-guide'],
};

const md = (d: Date) => {
  const k = kstDateKey(d);
  return `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
};
const dateOnlyMd = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;

interface Facts {
  withdrawn: boolean;
  blocked: boolean;
  optOut: boolean;
  openInquiry: boolean;
  refundInProgress: boolean;
  paidCount: number;
  firstPaidAt: Date | null;
  lastPaidAt: Date | null;
  recurring: { status: string; recoveryState: string; actionDeadlineOn: Date | null; nextChargeOn: Date } | null;
  signPending: { since: Date } | null;
  receiptProfile: boolean;
  receiptInfoSentAt: Date | null;
  thanksSent: boolean;
  volunteerPending: boolean;
  lastContactAt: Date | null;
  runs: Array<{ handles: NextActionKey; dueAt: Date; status: string }>;
}

async function loadFacts(merchantId: string, payerIds: string[], now: Date): Promise<{ facts: Map<string, Facts>; issuer: boolean }> {
  const facts = new Map<string, Facts>();
  if (payerIds.length === 0) return { facts, issuer: false };
  const yearStart = new Date(`${kstDateKey(now).slice(0, 4)}-01-01T00:00:00+09:00`);
  const [merchant, payers, links, blocked, paid, recurring, agreements, signDocs, profiles, receiptInfo, thanks, volunteers, runs, pause] = await Promise.all([
    prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { businessNo: true, representativeName: true, address: true, designatedDonee: true, designatedDoneeVerifiedAt: true, designatedDoneeUntil: true },
    }),
    prisma.payerProfile.findMany({ where: { id: { in: payerIds } }, select: { id: true, onboardingStatus: true, blockedAt: true, phoneHash: true } }),
    prisma.payerMerchantLink.findMany({ where: { merchantId, payerId: { in: payerIds } }, select: { payerId: true, noticeOptOutAt: true, payerBlockedAt: true } }),
    prisma.blockedPayer.findMany({ where: { merchantId, payerId: { in: payerIds } }, select: { payerId: true } }),
    prisma.charge.groupBy({
      by: ['payerId'],
      where: { merchantId, payerId: { in: payerIds }, isTest: false, status: { in: PAID_STATUSES } },
      _count: { _all: true },
      _min: { paidAt: true },
      _max: { paidAt: true },
    }),
    prisma.recurringDonation.findMany({
      where: { merchantId, payerId: { in: payerIds }, status: { in: ['ACTIVE', 'PAUSED', 'SUSPENDED'] } },
      select: { payerId: true, status: true, recoveryState: true, actionDeadlineOn: true, nextChargeOn: true },
    }),
    // 서명 요청 중인 약정서·신청서(새 판이 나온 이전 판은 제외)
    prisma.$queryRaw<Array<{ payer_id: string; created_at: Date }>>`
      SELECT a.payer_id, a.created_at FROM agreement_document a
       WHERE a.merchant_id = ${merchantId} AND a.payer_id IN (${Prisma.join(payerIds)}) AND a.esign_status = 'REQUESTED'
         AND NOT EXISTS (SELECT 1 FROM agreement_document n WHERE n.supersedes_id = a.id)`,
    prisma.issuedDocument.findMany({ where: { merchantId, payerId: { in: payerIds }, signature: true, status: 'REQUESTED', archivedAt: null }, select: { payerId: true, createdAt: true } }),
    prisma.payerReceiptProfile.findMany({ where: { payerId: { in: payerIds } }, select: { payerId: true } }),
    prisma.journeyStepLog.groupBy({ by: ['payerId'], where: { merchantId, payerId: { in: payerIds }, stepKey: 'receipt-info', sent: true, at: { gte: yearStart } }, _max: { at: true } }),
    prisma.issuedDocument.findMany({ where: { merchantId, payerId: { in: payerIds }, purpose: 'THANKS_LETTER' }, select: { payerId: true }, distinct: ['payerId'] }),
    prisma.volunteerApplication.findMany({ where: { merchantId, payerId: { in: payerIds }, status: 'RECEIVED' }, select: { payerId: true }, distinct: ['payerId'] }),
    prisma.journeyRun.findMany({
      where: { merchantId, payerId: { in: payerIds }, status: { in: ['WAITING', 'RUNNING', 'AWAITING_APPROVAL'] }, journeyKey: { in: Object.keys(JOURNEY_HANDLES) } },
      select: { payerId: true, journeyKey: true, stepIndex: true, dueAt: true, status: true },
    }),
    pauseFactsFor(merchantId, payerIds),
  ]);
  const hashes = payers.map((p) => p.phoneHash);
  const contacts = hashes.length
    ? await prisma.mtOutboundMessage.groupBy({ by: ['phoneHash'], where: { merchantId, phoneHash: { in: hashes }, merchantSent: false }, _max: { createdAt: true } })
    : [];
  const contactBy = new Map(contacts.map((c) => [c.phoneHash, c._max.createdAt]));
  const linkBy = new Map(links.map((l) => [l.payerId, l]));
  const blockedSet = new Set(blocked.map((b) => b.payerId));
  const paidBy = new Map(paid.map((p) => [p.payerId!, p]));
  const recBy = new Map<string, (typeof recurring)[number]>();
  // 조치 필요 > 정지 > 재시도 > 그 밖 순으로 한 건만 본다(기관당 진행 중 약정은 1건이 원칙)
  const recRank = (r: (typeof recurring)[number]) => (r.recoveryState === 'ACTION_REQUIRED' ? 3 : r.status === 'SUSPENDED' ? 2 : r.recoveryState === 'RETRYING' ? 1 : 0);
  for (const r of recurring) {
    const cur = recBy.get(r.payerId);
    if (!cur || recRank(r) > recRank(cur)) recBy.set(r.payerId, r);
  }
  const signBy = new Map<string, Date>();
  for (const s of [...agreements.map((a) => ({ payerId: a.payer_id, at: a.created_at })), ...signDocs.map((d) => ({ payerId: d.payerId, at: d.createdAt }))]) {
    const cur = signBy.get(s.payerId);
    if (!cur || s.at < cur) signBy.set(s.payerId, s.at);
  }
  const profileSet = new Set(profiles.map((p) => p.payerId));
  const receiptInfoBy = new Map(receiptInfo.map((r) => [r.payerId!, r._max.at]));
  const thanksSet = new Set(thanks.map((t) => t.payerId));
  const volSet = new Set(volunteers.map((v) => v.payerId));
  const runsBy = new Map<string, Facts['runs']>();
  for (const r of runs) {
    const stepKey = JOURNEY_STEP_KEYS[r.journeyKey]?.[r.stepIndex];
    const handles = stepKey ? JOURNEY_HANDLES[r.journeyKey]?.[stepKey] : undefined;
    if (!handles || !r.payerId) continue;
    runsBy.set(r.payerId, [...(runsBy.get(r.payerId) ?? []), { handles, dueAt: r.dueAt, status: r.status }]);
  }
  for (const p of payers) {
    const l = linkBy.get(p.id);
    const pf = pause.get(p.id);
    const pc = paidBy.get(p.id);
    const r = recBy.get(p.id);
    facts.set(p.id, {
      withdrawn: p.onboardingStatus === 'WITHDRAWN',
      blocked: Boolean(p.blockedAt || l?.payerBlockedAt || blockedSet.has(p.id)),
      optOut: Boolean(l?.noticeOptOutAt),
      openInquiry: Boolean(pf?.openInquiry),
      refundInProgress: Boolean(pf?.refundInProgress),
      paidCount: pc?._count._all ?? 0,
      firstPaidAt: pc?._min.paidAt ?? null,
      lastPaidAt: pc?._max.paidAt ?? null,
      recurring: r ? { status: r.status, recoveryState: r.recoveryState, actionDeadlineOn: r.actionDeadlineOn, nextChargeOn: r.nextChargeOn } : null,
      signPending: signBy.has(p.id) ? { since: signBy.get(p.id)! } : null,
      receiptProfile: profileSet.has(p.id),
      receiptInfoSentAt: receiptInfoBy.get(p.id) ?? null,
      thanksSent: thanksSet.has(p.id),
      volunteerPending: volSet.has(p.id),
      lastContactAt: contactBy.get(p.phoneHash) ?? null,
      runs: runsBy.get(p.id) ?? [],
    });
  }
  return { facts, issuer: merchant ? issuerReadiness(merchant).ok : false };
}

const none = (reason: string): NextAction => ({ key: 'NONE', label: NEXT_ACTION_LABEL.NONE, reason, suggestedAction: null, autoHandled: false, nextRunAt: null });

/** 규칙 판단(순수 함수 — 테스트 대상). */
export function decideNextAction(f: Facts, ctx: { issuer: boolean; now: Date }): NextAction {
  if (f.withdrawn) return none('탈퇴한 후원자입니다. 안내하지 않습니다.');
  if (f.blocked) return none('차단 관계라 안내하지 않습니다.');
  const run = (k: NextActionKey) => f.runs.filter((r) => r.handles === k).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
  const auto = (key: NextActionKey, reason: string, at: Date | null, approval = false): NextAction => ({
    key,
    label: NEXT_ACTION_LABEL[key],
    reason: approval ? `${reason} · 담당자 승인 대기` : at ? `${reason} · 자동 처리 중(다음 실행 ${md(at)})` : `${reason} · 자동 처리 중`,
    suggestedAction: approval ? { label: '승인 대기함 열기', href: '/studio/inbox' } : null,
    autoHandled: !approval,
    nextRunAt: at,
  });
  const contact = f.lastContactAt ? ` 최근 안내 ${md(f.lastContactAt)}.` : '';
  const recentDonor = f.firstPaidAt ? ctx.now.getTime() - f.firstPaidAt.getTime() <= FIRST_THANKS_WINDOW_DAYS * 86_400_000 : false;
  const thisYear = kstDateKey(ctx.now).slice(0, 4);
  const lastYear = String(Number(thisYear) - 1);
  const month = Number(kstDateKey(ctx.now).slice(5, 7));
  const donatedForReceipt = f.lastPaidAt ? kstDateKey(f.lastPaidAt).slice(0, 4) === thisYear || ((month === 1 || month === 2) && kstDateKey(f.lastPaidAt).slice(0, 4) === lastYear) : false;

  for (const key of nextActionOrder(ctx.now)) {
    switch (key) {
      case 'STAFF_CHECK':
        if (f.refundInProgress)
          return { key, label: NEXT_ACTION_LABEL[key], reason: '진행 중인 환불이 있어 감사·안내 같은 자동 안내를 멈췄습니다. 환불이 끝나면 다시 나갑니다.', suggestedAction: { label: '후원 내역 보기', href: '/studio/charges' }, autoHandled: false, nextRunAt: null };
        if (f.openInquiry)
          return { key, label: NEXT_ACTION_LABEL[key], reason: '답변하지 않은 고객센터 문의가 있어 자동 안내를 멈췄습니다. 답변이 끝나면 다시 나갑니다.', suggestedAction: null, autoHandled: false, nextRunAt: null };
        break;
      case 'RECURRING_ACTION': {
        const r = f.recurring;
        if (!r) break;
        const j = run(key);
        if (r.recoveryState === 'ACTION_REQUIRED') {
          const dl = r.actionDeadlineOn ? ` 기한 ${dateOnlyMd(r.actionDeadlineOn)}까지 등록하지 않으면 정지됩니다.` : '';
          return { key, label: NEXT_ACTION_LABEL[key], reason: `계좌·인증 문제로 출금되지 않아 결제수단을 다시 등록해야 합니다(복구 안내 문자는 보냈습니다).${dl}${contact}`, suggestedAction: { label: '정기후원 조치 필요 보기', href: '/studio/recurring?recovery=ACTION_REQUIRED' }, autoHandled: false, nextRunAt: null };
        }
        if (r.status === 'SUSPENDED') {
          if (j) return auto(key, '출금 실패로 정기후원이 정지됨 — 재개 방법 안내', j.dueAt, j.status === 'AWAITING_APPROVAL');
          return { key, label: '정기후원 정지됨', reason: `출금 실패로 정기후원이 정지되었습니다. 후원자가 결제수단을 확인하면 재개됩니다.${contact}`, suggestedAction: { label: '정기후원 보기', href: '/studio/recurring' }, autoHandled: false, nextRunAt: null };
        }
        if (r.recoveryState === 'RETRYING') {
          return { key, label: '정기 출금 재시도 중', reason: `출금이 한 번 실패해 자동으로 다시 시도합니다 · 자동 처리 중(다음 실행 ${dateOnlyMd(r.nextChargeOn)})`, suggestedAction: null, autoHandled: true, nextRunAt: r.nextChargeOn };
        }
        break;
      }
      case 'SIGN_PENDING':
        if (f.signPending) {
          const days = Math.max(0, Math.floor((ctx.now.getTime() - f.signPending.since.getTime()) / 86_400_000));
          return { key, label: NEXT_ACTION_LABEL[key], reason: `약정서·신청서 서명 요청을 보낸 지 ${days}일 지났지만 아직 서명하지 않았습니다.${contact}`, suggestedAction: { label: '서명 재안내(승인 대기함)', href: '/studio/inbox' }, autoHandled: false, nextRunAt: null };
        }
        break;
      case 'RECEIPT_INFO': {
        if (!ctx.issuer || f.receiptProfile || f.optOut || !donatedForReceipt) break;
        const j = run(key);
        if (j) return auto(key, '영수증 정보(성명·주민등록번호) 등록 안내', j.dueAt, j.status === 'AWAITING_APPROVAL');
        if (f.receiptInfoSentAt) return { key, label: NEXT_ACTION_LABEL[key], reason: `올해 ${md(f.receiptInfoSentAt)} 등록 방법을 안내했습니다. 후원자 등록을 기다립니다(안내는 한 해 한 번).`, suggestedAction: null, autoHandled: true, nextRunAt: null };
        return { key, label: NEXT_ACTION_LABEL[key], reason: `기부금영수증을 발급하려면 성명·주민등록번호 등록이 필요합니다. 아직 안내하지 않았습니다.${month <= 2 ? ' 연말정산 시기입니다.' : ''}`, suggestedAction: { label: '영수증 정보 안내 보내기(승인 대기함)', href: '/studio/inbox' }, autoHandled: false, nextRunAt: null };
      }
      case 'FIRST_THANKS': {
        if (f.paidCount < 1 || f.thanksSent || f.optOut || !recentDonor) break;
        const j = run(key);
        if (j) return auto(key, '첫 후원 감사장 발송', j.dueAt, j.status === 'AWAITING_APPROVAL');
        return { key, label: NEXT_ACTION_LABEL[key], reason: `첫 후원(${md(f.firstPaidAt!)})에 대한 감사장이 아직 나가지 않았습니다. 후원 감사 자동 안내가 꺼져 있거나 기준 금액 미만일 수 있습니다.`, suggestedAction: { label: '자동 안내 설정 보기', href: '/studio/journeys' }, autoHandled: false, nextRunAt: null };
      }
      case 'VOLUNTEER_REVIEW':
        if (f.volunteerPending) return { key, label: NEXT_ACTION_LABEL[key], reason: '접수된 자원봉사 신청이 승인을 기다립니다.', suggestedAction: { label: '자원봉사 신청 보기', href: '/studio/volunteers' }, autoHandled: false, nextRunAt: null };
        break;
    }
  }
  return none(`지금 필요한 일이 없습니다.${contact}`);
}

/** 기관 단위로 한꺼번에(목록·대시보드). 후원자마다 쿼리하지 않는다. */
export async function nextActionsForMerchant(merchantId: string, payerIds: string[], now = new Date()): Promise<Map<string, NextAction>> {
  const ids = [...new Set(payerIds.filter(Boolean))];
  const { facts, issuer } = await loadFacts(merchantId, ids, now);
  const out = new Map<string, NextAction>();
  for (const id of ids) {
    const f = facts.get(id);
    out.set(id, f ? decideNextAction(f, { issuer, now }) : none('후원자 정보를 찾을 수 없습니다.'));
  }
  return out;
}

export async function nextActionForPayer(merchantId: string, payerId: string, now = new Date()): Promise<NextAction> {
  return (await nextActionsForMerchant(merchantId, [payerId], now)).get(payerId)!;
}

/** 담당자가 할 일이 있는가(자동 처리 중·할 일 없음 제외) — 목록 필터·대시보드 한 줄 */
export function needsStaff(a: NextAction | undefined): boolean {
  return Boolean(a && a.key !== 'NONE' && !a.autoHandled);
}

/** 이 기관에 후원·약정·봉사로 이어진 후원자 id 전체(대시보드 집계용) */
export async function merchantPayerIds(merchantId: string): Promise<string[]> {
  const links = await prisma.payerMerchantLink.findMany({ where: { merchantId }, select: { payerId: true } });
  return links.map((l) => l.payerId);
}

export type { Facts as NextActionFacts };
