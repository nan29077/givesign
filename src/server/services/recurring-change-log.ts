import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';

/**
 * 정기후원 변경 이력 (2026-11-09 2차 F) — `recurring_change_log`.
 * 후원자 셀프서비스(/my · 기관 후원 회원 화면)와 복구 링크(/r/recover)에서 바꾼 내용을 시간순으로 남긴다.
 * 기록 실패가 변경 자체를 되돌리지 않는다(기록은 안전 래퍼로만 부른다). 개인정보 원문은 넣지 않는다.
 */

export type RecurringChangeActor = 'DONOR' | 'MERCHANT' | 'ADMIN' | 'SYSTEM';
export type RecurringChangeVia = 'MY' | 'MEMBER' | 'RECOVER_LINK' | 'SMS';
export type RecurringChangeKind = 'CHANGE' | 'PAUSE' | 'PAUSE_UNTIL' | 'RESUME' | 'CANCEL';

export interface RecurringTermsSnapshot {
  status: string;
  amount: string;
  dayOfMonth: number;
  resumeOn?: string | null;
}

export function termsSnapshot(r: { status: string; amount: bigint; dayOfMonth: number; resumeOn?: Date | null }): RecurringTermsSnapshot {
  return { status: r.status, amount: r.amount.toString(), dayOfMonth: r.dayOfMonth, resumeOn: r.resumeOn ? r.resumeOn.toISOString().slice(0, 10) : null };
}

export interface RecordRecurringChangeInput {
  recurringId: string;
  merchantId: string;
  payerId: string;
  actor: RecurringChangeActor;
  via: RecurringChangeVia;
  kind: RecurringChangeKind;
  before: RecurringTermsSnapshot;
  after: RecurringTermsSnapshot;
  summary: string;
  reason?: string | null;
}

/** 이력 한 줄. 예외를 던지지 않는다. */
export async function recordRecurringChange(input: RecordRecurringChangeInput): Promise<void> {
  try {
    await prisma.recurringChangeLog.create({
      data: {
        id: newId(),
        recurringId: input.recurringId,
        merchantId: input.merchantId,
        payerId: input.payerId,
        actor: input.actor,
        via: input.via,
        kind: input.kind,
        before: input.before as object,
        after: input.after as object,
        summary: input.summary.slice(0, 500),
        reason: input.reason ? input.reason.slice(0, 200) : null,
      },
    });
  } catch (e) {
    logger.error('정기후원 변경 이력 기록 실패', { recurringId: input.recurringId, message: (e as Error).message });
  }
}

export const CHANGE_KIND_LABEL: Record<RecurringChangeKind, string> = {
  CHANGE: '금액·출금일 변경',
  PAUSE: '일시정지',
  PAUSE_UNTIL: '쉬어 가기(재개일 지정)',
  RESUME: '다시 시작',
  CANCEL: '해지',
};

export const CHANGE_VIA_LABEL: Record<RecurringChangeVia, string> = {
  MY: '마이페이지',
  MEMBER: '기관 후원 회원 화면',
  RECOVER_LINK: '복구 안내 링크',
  SMS: '문자 명령 링크',
};

/** 누가 바꿨는지(기관 콘솔·후원자 화면 공용) */
export function changeActorLabel(actor: string): string {
  if (actor === 'DONOR') return '후원자 본인';
  if (actor === 'MERCHANT') return '기관';
  if (actor === 'ADMIN') return '관리자';
  return '시스템';
}

export function changeKindLabel(kind: string): string {
  return CHANGE_KIND_LABEL[kind as RecurringChangeKind] ?? kind;
}

export function changeViaLabel(via: string): string {
  return CHANGE_VIA_LABEL[via as RecurringChangeVia] ?? via;
}

/** 약정 하나의 변경 이력(최신 순) */
export function recurringChangeHistory(recurringId: string, take = 20) {
  return prisma.recurringChangeLog.findMany({ where: { recurringId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take });
}

/** 기관의 최근 변경 이력(기관 콘솔 정기후원 화면) */
export function merchantRecurringChanges(merchantId: string, take = 30) {
  return prisma.recurringChangeLog.findMany({
    where: { merchantId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    include: { recurring: { select: { payer: { select: { displayName: true, phoneMasked: true } } } } },
  });
}
