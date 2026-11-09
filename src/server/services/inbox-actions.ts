import { prisma } from '@/server/db';
import { kstDateKey } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import { kv } from '@/server/redis';
import { emitDomainEventSafe } from './events';
import { esignSegments, journeyFailureClass, receiptInfoDedupeKey, receiptInfoSegments } from './inbox-groups';

/**
 * 승인 대기함 묶음의 "바로 실행" (2026-11-09 과제 C1). 모두 기존 경로를 다시 쓴다.
 *
 *  - receipt.send_info : 영수증 정보 미등록자 중 안내 가능한 사람에게 `receipt.info_needed`(연간 배치와 같은 키) → 저니가 안내.
 *                        같은 사람·같은 해는 한 번(이벤트 dedupeKey). 수신 거부·차단·탈퇴·번호 없음은 넣지 않는다(저니도 다시 거른다).
 *  - journey.retry_failed : 같은 이유로 멈춘 자동 안내 실행을 다시 실행(retryJourneyRun — 보낸 단계는 다시 보내지 않음).
 *  - edoc.remind       : 서명 대기 서명자에게 재안내(remindSigner — 5회·1시간 규칙 그대로) + 서명자마다 하루 1회(선점 키).
 * 결과를 모르는 건(UNKNOWN)은 여기서 다루지 않는다(자동 재실행 금지).
 */

export class InboxActionError extends Error {}

export const INBOX_GROUP_ACTIONS = ['receipt.send_info', 'journey.retry_failed', 'edoc.remind'] as const;
export type InboxGroupAction = (typeof INBOX_GROUP_ACTIONS)[number];

export function isInboxGroupAction(v: string): v is InboxGroupAction {
  return (INBOX_GROUP_ACTIONS as readonly string[]).includes(v);
}

const MAX_PER_CLICK = 200;

export async function runInboxGroupAction(input: {
  merchantId: string;
  userId: string;
  action: InboxGroupAction;
  payload: Record<string, string>;
  now?: Date;
}): Promise<{ done: number; skipped: number; message: string }> {
  const now = input.now ?? new Date();
  if (input.action === 'receipt.send_info') return sendReceiptInfo(input.merchantId, Number(input.payload.taxYear), now);
  if (input.action === 'journey.retry_failed') return retryFailedRuns(input.merchantId, String(input.payload.cls ?? ''), now);
  return remindSegment(input.merchantId, input.userId, String(input.payload.segment ?? ''), now);
}

async function sendReceiptInfo(merchantId: string, taxYear: number, now: Date) {
  const thisYear = Number(kstDateKey(now).slice(0, 4));
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear >= thisYear) throw new InboxActionError('귀속 연도가 올바르지 않습니다.');
  const s = await receiptInfoSegments(merchantId, taxYear);
  const { receiptCandidates } = await import('./receipts');
  const byPayer = new Map((await receiptCandidates(merchantId, taxYear)).map((c) => [c.payerId, c]));
  let done = 0;
  for (const payerId of s.contactable.slice(0, MAX_PER_CLICK)) {
    const c = byPayer.get(payerId);
    await emitDomainEventSafe({
      merchantId,
      type: 'receipt.info_needed',
      subjectType: 'payer',
      subjectId: payerId,
      payerId,
      dedupeKey: receiptInfoDedupeKey(merchantId, payerId, taxYear),
      payload: { taxYear, amount: c?.amount ?? 0n, count: c?.count ?? 0, source: 'inbox' },
    });
    done += 1;
  }
  const skipped = s.unreachable.length + s.alreadyGuided;
  return {
    done,
    skipped,
    message: done
      ? `${done}명에게 등록 안내를 보내도록 올렸습니다(1~2분 안에 자동 안내가 보냅니다, 밤에는 다음 날 오전).${skipped ? ` 연락 확인 필요·이미 안내한 ${skipped}명은 뺐습니다.` : ''}`
      : '새로 안내할 후원자가 없습니다(이미 안내했거나 연락이 닿지 않습니다).',
  };
}

async function retryFailedRuns(merchantId: string, cls: string, now: Date) {
  if (!cls) throw new InboxActionError('다시 실행할 묶음을 찾을 수 없습니다.');
  const runs = await prisma.journeyRun.findMany({
    where: { merchantId, status: 'FAILED', finishedAt: { gte: new Date(now.getTime() - 14 * 86_400_000) } },
    select: { id: true, lastError: true },
    take: 500,
  });
  const target = runs.filter((r) => journeyFailureClass(r.lastError).code === cls).slice(0, MAX_PER_CLICK);
  const { retryJourneyRun } = await import('./journeys/engine');
  let done = 0;
  let skipped = 0;
  for (const r of target) {
    try {
      await retryJourneyRun(merchantId, r.id);
      done += 1;
    } catch (e) {
      skipped += 1;
      logger.warn('막힌 자동 안내 다시 실행 실패', { runId: r.id, message: (e as Error).message });
    }
  }
  return { done, skipped, message: done ? `${done}건을 다시 실행했습니다. 같은 원인이 남아 있으면 다시 막힌 일로 돌아옵니다.` : '다시 실행할 안내가 없습니다.' };
}

/** 하루 1회 선점 키(서명자 × KST 날짜). 동시에 눌러도 한 번만 보낸다. */
export function remindDayKey(signerId: string, now: Date) {
  return `inbox-remind:${signerId}:${kstDateKey(now)}`;
}

async function remindSegment(merchantId: string, userId: string, segment: string, now: Date) {
  if (!['unviewed', 'viewed', 'expiring'].includes(segment)) throw new InboxActionError('재안내할 묶음을 찾을 수 없습니다.');
  const s = await esignSegments(merchantId, now);
  const ids = (segment === 'unviewed' ? s.unviewed : segment === 'viewed' ? s.viewed : s.expiring).slice(0, MAX_PER_CLICK);
  const signers = await prisma.eDocSigner.findMany({
    where: { envelopeId: { in: ids }, status: { in: ['SENT', 'VIEWED'] } },
    select: { id: true, envelopeId: true, lastRemindedAt: true },
  });
  const { remindSigner, EDocError } = await import('./edoc');
  let done = 0;
  let skipped = 0;
  const dayStart = new Date(`${kstDateKey(now)}T00:00:00+09:00`);
  for (const sg of signers) {
    // 오늘 이미 재안내했으면(대기함·전자문서 센터 어디서든) 건너뛴다.
    if (sg.lastRemindedAt && sg.lastRemindedAt >= dayStart) {
      skipped += 1;
      continue;
    }
    const first = await kv.setnx(remindDayKey(sg.id, now), '1', 26 * 3600).catch(() => false);
    if (!first) {
      skipped += 1;
      continue;
    }
    try {
      const r = await remindSigner({ merchantId, envelopeId: sg.envelopeId, signerId: sg.id, actorId: userId });
      if (r.ok) done += 1;
      else skipped += 1;
    } catch (e) {
      skipped += 1;
      if (!(e instanceof EDocError)) logger.warn('승인 대기함 재안내 실패', { signerId: sg.id, message: (e as Error).message });
    }
  }
  return {
    done,
    skipped,
    message: done ? `${done}명에게 재안내를 보냈습니다.${skipped ? ` 오늘 이미 보냈거나 한도에 닿은 ${skipped}명은 건너뛰었습니다.` : ''}` : '지금 재안내할 서명자가 없습니다(오늘 이미 보냈거나 재안내 한도에 닿았습니다).',
  };
}
