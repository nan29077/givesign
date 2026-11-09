import { inboxItems, type InboxItem } from './inbox';
import { loadInboxGroups, sortInboxGroups, type LoadedInboxGroup } from './inbox-groups';
import { inboxAssignmentsFor, isOverdue } from './inbox-assignments';
import { PREFLIGHT_BLOCK_PREFIX } from './purpose-documents';
import type { InboxAssignment } from '@/generated/prisma/client';

/**
 * 승인 대기함 "예외 해결 화면" 조립 (2026-11-09 과제 C1).
 *
 * `inboxItems`(원천 테이블에서 모은 항목 — 배지 수와 같은 근거)는 그대로 두고, 그 위에
 *  - 항목마다 판단 정보(발생 이유·기다린 시간·권장 조치·바로 실행 가능 여부)
 *  - 원인별 묶음(inbox-groups 제공자)
 *  - 담당자 배정·기한(inbox_assignment)
 * 을 붙여 정렬한다: 기한 넘김 → 영향 큰 순 → 오래된 순.
 */

export interface InboxDecision {
  /** 발생 이유(쉬운 말) */
  reason: string;
  /** 권장 조치 한 줄 */
  recommendedAction: string;
  /** 기다린 시간(N시간/N일) */
  waitedLabel: string;
  waitedMs: number;
  overdue: boolean;
  assignment: InboxAssignment | null;
  /** 결과를 모르는 건 — "다시 실행" 을 주지 않는다 */
  resultUnknown: boolean;
}

export type DecoratedInboxItem = InboxItem & { decision: InboxDecision };
export type DecoratedInboxGroup = LoadedInboxGroup & { waitedLabel: string; overdue: boolean; assignment: InboxAssignment | null };

export function waitedLabel(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return '1시간 안';
  if (h < 48) return `${h}시간`;
  return `${Math.floor(h / 24)}일`;
}

/** 항목 종류별 쉬운 이유·권장 조치 */
export function explainItem(it: InboxItem): { reason: string; recommendedAction: string; resultUnknown: boolean } {
  const err = it.error ?? '';
  switch (it.kind) {
    case 'RECEIPT_BATCH':
      return { reason: '지난해 후원 영수증을 한꺼번에 발급할 준비가 끝났습니다.', recommendedAction: '대상 수·표본·제외 대상을 확인한 뒤 승인하세요.', resultUnknown: false };
    case 'JOURNEY_STEP':
      return { reason: '자동 안내 중 "승인 후 보내기" 로 둔 단계입니다.', recommendedAction: '내용을 보고 승인하거나, 보내지 않으려면 반려하세요.', resultUnknown: false };
    case 'CONTENT_REVIEW':
      return { reason: 'AI 가 만든 콘텐츠가 검토를 기다립니다.', recommendedAction: '내용을 확인하고 승인하면 게시할 수 있습니다.', resultUnknown: false };
    case 'VOLUNTEER_APPLICATION':
      return { reason: '새 자원봉사 신청이 들어왔습니다.', recommendedAction: '자원봉사 화면에서 승인·배정하세요.', resultUnknown: false };
    case 'DOCUMENT_SUBMITTED':
      return { reason: '후원자가 문서를 제출했습니다.', recommendedAction: '제출 내용을 확인 처리하세요.', resultUnknown: false };
    case 'REPORT':
      return { reason: '처리하지 않은 신고가 있습니다.', recommendedAction: '신고 내용을 확인하고 처리하세요.', resultUnknown: false };
    case 'EDOC_SIGNING':
      return { reason: '후원자가 서명할 차례입니다.', recommendedAction: '오래 열지 않았으면 재안내를 보내세요.', resultUnknown: false };
    case 'REFUND':
      return { reason: '환불은 관리자가 확인합니다.', recommendedAction: '기다리면 됩니다. 급하면 고객센터로 문의하세요.', resultUnknown: false };
    case 'APPROVAL_FAILED':
      return { reason: '승인한 일을 실행하다 여러 번 실패했습니다.', recommendedAction: '원인을 확인한 뒤 다시 실행하세요. 이미 처리된 건은 다시 하지 않습니다.', resultUnknown: false };
    case 'JOURNEY_FAILED':
      if (err.startsWith(PREFLIGHT_BLOCK_PREFIX) || (it.summary ?? '').startsWith(PREFLIGHT_BLOCK_PREFIX)) {
        return { reason: '문서 발송 전 점검에서 막혔습니다(필수 항목 빈칸·연락처 등).', recommendedAction: '서식이나 후원자 정보를 고친 뒤 다시 실행하세요.', resultUnknown: false };
      }
      return { reason: '자동 안내가 여러 번 실패해 멈췄습니다.', recommendedAction: '원인을 확인한 뒤 다시 실행하세요. 보낸 단계는 다시 보내지 않습니다.', resultUnknown: false };
    case 'PUBLISH_FAILED':
      return { reason: 'SNS 게시에 실패했습니다.', recommendedAction: '채널 연결과 실패 이유를 확인한 뒤 콘텐츠 화면에서 다시 예약하세요.', resultUnknown: false };
    default:
      if (it.key.startsWith('approval-run:')) {
        return { reason: '승인한 일을 처리하고 있습니다.', recommendedAction: '몇 분 안에 끝납니다. 기다리면 됩니다.', resultUnknown: false };
      }
      return { reason: it.kindLabel, recommendedAction: '열어서 확인하세요.', resultUnknown: false };
  }
}

export interface InboxOverview {
  actions: DecoratedInboxItem[];
  waiting: DecoratedInboxItem[];
  blocked: DecoratedInboxItem[];
  groups: DecoratedInboxGroup[];
  /** "지금 처리할 일 N건" — 승인·처리할 일 + 막힌 일 */
  nowCount: number;
  overdueCount: number;
}

function sortItems(list: DecoratedInboxItem[]): DecoratedInboxItem[] {
  return [...list].sort((a, b) => {
    if (a.decision.overdue !== b.decision.overdue) return a.decision.overdue ? -1 : 1;
    const ia = a.affectedCount ?? 0;
    const ib = b.affectedCount ?? 0;
    if (ia !== ib) return ib - ia;
    return a.at.getTime() - b.at.getTime();
  });
}

export async function inboxOverview(merchantId: string, now = new Date()): Promise<InboxOverview> {
  const [{ actions, waiting, blocked }, groups, assignments] = await Promise.all([
    inboxItems(merchantId),
    loadInboxGroups(merchantId, now),
    inboxAssignmentsFor(merchantId),
  ]);
  const decorate = (it: InboxItem): DecoratedInboxItem => {
    const a = assignments.get(it.key) ?? null;
    const waited = Math.max(0, now.getTime() - it.at.getTime());
    return { ...it, decision: { ...explainItem(it), waitedLabel: waitedLabel(waited), waitedMs: waited, overdue: isOverdue(a, now), assignment: a } };
  };
  const g = sortInboxGroups(groups, (k) => isOverdue(assignments.get(k), now)).map((x) => {
    const a = assignments.get(x.key) ?? null;
    return { ...x, waitedLabel: x.group ? waitedLabel(Math.max(0, now.getTime() - x.group.oldestAt.getTime())) : '', overdue: isOverdue(a, now), assignment: a };
  });
  const A = sortItems(actions.map(decorate));
  const W = sortItems(waiting.map(decorate));
  const B = sortItems(blocked.map(decorate));
  const overdueCount = [...A, ...W, ...B].filter((i) => i.decision.overdue).length + g.filter((x) => x.overdue).length;
  return { actions: A, waiting: W, blocked: B, groups: g, nowCount: A.length + B.length, overdueCount };
}
