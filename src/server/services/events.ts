import { prisma } from '@/server/db';
import type { Prisma } from '@/generated/prisma/client';
import { newId } from '@/lib/id';
import { generateToken } from '@/lib/crypto';
import { logger } from '@/lib/logger';

/**
 * 도메인 이벤트 (아웃박스 패턴).
 *
 * 왜 필요한가
 * -----------
 * 후원 성공 뒤에 따라붙는 일(감사장·영수증 안내·기관 알림·명단 연결·목표 달성·저니)이
 * 예전에는 `executePayment` 안에 순서대로 하드코딩돼 있었다. 하나를 더하려면 결제 코드를 고쳐야 했고,
 * 프로세스가 중간에 죽으면 뒤쪽 단계는 영영 실행되지 않았다.
 *
 * 규칙
 * ----
 *  - 이벤트는 업무 트랜잭션 **안에서** 함께 기록한다(`tx` 전달). 업무가 롤백되면 이벤트도 없다.
 *  - `dedupeKey` 유니크 — 같은 사건을 두 번 기록해도 한 행이다(재시도·재진입 안전).
 *  - 소비자는 `registerConsumer` 로 등록하고, /api/cron/events 가 (이벤트, 소비자) 1회씩 처리한다.
 *    한 소비자가 실패해도 다른 소비자 결과는 남고, 실패한 소비자만 다음 배치에서 다시 돈다.
 *  - 소비자 실패는 업무 결과를 바꾸지 않는다(절대 규칙 3).
 *  - payload 에 개인정보 원문(전화번호·이름 원문·주민번호)을 넣지 않는다. ID 와 금액·마스킹 값만.
 */

export const DOMAIN_EVENT_TYPES = [
  'charge.paid',
  'charge.refunded',
  'recurring.pledged',
  'recurring.changed',
  'recurring.suspended',
  'recurring.resumed',
  'recurring.canceled',
  'recurring.milestone',
  'volunteer.applied',
  'volunteer.approved',
  'volunteer.rejected',
  'volunteer.activity_recorded',
  'volunteer.milestone',
  'receipt.issued',
  'receipt.batch_ready',
  'campaign.goal_reached',
  'content.approved',
  'content.published',
  'agreement.issued',
  'agreement.signed',
  'document.signed',
  'supporter.dormant',
  /** 연초: 지난해 후원자 중 영수증 정보 미등록자(영수증 배치가 낸다) */
  'receipt.info_needed',
  /** 봉사 회차 전날(저니 배치가 낸다) */
  'volunteer.shift_reminder_due',
  /** 매월 발급 기관: 지난해 결제 건이 모두 영수증에 묶임(연말 감사장 — 영수증 배치가 낸다) */
  'receipt.year_closed',
  /** 전자서명 봉투가 서명 없이 끝남(거절·만료·취소) — 발급 문서·약정서 상태 반영 재확인 */
  'document.closed',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export interface DomainEventInput {
  merchantId: string;
  type: DomainEventType;
  subjectType: string;
  subjectId: string;
  payerId?: string | null;
  payload?: Record<string, unknown>;
  /** 비우면 `${type}:${subjectId}` */
  dedupeKey?: string;
  occurredAt?: Date;
}

type Tx = Prisma.TransactionClient | typeof prisma;

/** JSON 으로 저장할 수 있게 BigInt·Date 를 바꾼다. */
function jsonSafe(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(v ?? {}, (_k, val) => (typeof val === 'bigint' ? val.toString() : val)),
  ) as Prisma.InputJsonValue;
}

/**
 * 이벤트 기록. 업무 트랜잭션 안에서 부르면 원자적으로 남는다.
 * 같은 dedupeKey 가 이미 있으면 아무것도 하지 않는다(예외를 던지지 않는다).
 */
export async function emitDomainEvent(input: DomainEventInput, tx: Tx = prisma): Promise<void> {
  await tx.domainEvent.createMany({
    data: [
      {
        id: newId(),
        merchantId: input.merchantId,
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payerId: input.payerId ?? null,
        payload: jsonSafe(input.payload),
        dedupeKey: input.dedupeKey ?? `${input.type}:${input.subjectId}`,
        occurredAt: input.occurredAt ?? new Date(),
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * 트랜잭션 밖(사후)에서 기록할 때. 기록 실패가 호출한 업무를 막지 않는다.
 * 원자성이 필요한 곳(결제 성공)은 반드시 `emitDomainEvent(…, tx)` 를 쓴다.
 */
export async function emitDomainEventSafe(input: DomainEventInput): Promise<void> {
  await emitDomainEvent(input).catch((e) =>
    logger.error('도메인 이벤트 기록 실패', { type: input.type, subjectId: input.subjectId, message: (e as Error).message }),
  );
}

// ---------------------------------------------------------------------------
// 소비자 등록
// ---------------------------------------------------------------------------

export type StoredDomainEvent = {
  id: string;
  merchantId: string;
  type: string;
  subjectType: string;
  subjectId: string;
  payerId: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
};

/** 'SKIPPED' 를 돌려주면 처리할 것이 없었다는 뜻(성공과 같게 취급). */
export type ConsumerResult = void | 'SKIPPED';

export interface DomainEventConsumer {
  /** 소비자 이름. 처리 기록의 키라 바꾸면 이미 처리한 이벤트를 다시 돈다. */
  name: string;
  types: readonly DomainEventType[] | '*';
  handle(event: StoredDomainEvent): Promise<ConsumerResult>;
}

const consumers = new Map<string, DomainEventConsumer>();

export function registerConsumer(consumer: DomainEventConsumer) {
  consumers.set(consumer.name, consumer);
}

/** 테스트용 */
export function registeredConsumers(): DomainEventConsumer[] {
  return [...consumers.values()];
}

export function unregisterConsumer(name: string) {
  consumers.delete(name);
}

// ---------------------------------------------------------------------------
// 처리 (배치)
// ---------------------------------------------------------------------------

export const EVENT_MAX_ATTEMPTS = 6;
/**
 * 처리 중 표시가 이 시간 넘게 남아 있으면 죽은 실행으로 보고 다시 잡는다.
 * 선점 시각은 **그 이벤트를 잡는 순간**의 시각이다(배치 시작 시각이 아니다 — 점검 A-3).
 * 한 배치의 처리 시간 상한(EVENT_BATCH_BUDGET_MS)과 events 배치 잠금(cron-registry lockTtlSec)은 이 값보다 짧거나 같다.
 */
export const EVENT_LEASE_MS = 5 * 60_000;
/** 한 번의 processDomainEvents 가 새 이벤트를 잡는 시간 상한. 넘기면 남은 것은 다음 배치가 잡는다. */
export const EVENT_BATCH_BUDGET_MS = 60_000;

/**
 * 기준 시각(now)에서 실제로 흐른 시간을 더한 시계. 배치가 시작 시각을 넘겨받아도 선점 시각은 "잡는 순간" 이 된다.
 * (테스트가 미래 시각을 now 로 넘겨도 같은 방식으로 동작한다.)
 */
export function elapsedClock(base?: Date): () => Date {
  const startedReal = Date.now();
  const baseMs = base?.getTime() ?? startedReal;
  return () => new Date(baseMs + (Date.now() - startedReal));
}

/** 재시도 간격(분): 1, 5, 15, 60, 180 */
const BACKOFF_MIN = [1, 5, 15, 60, 180];

function backoff(attempts: number, now: Date): Date {
  const min = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] ?? 180;
  return new Date(now.getTime() + min * 60_000);
}

export interface ProcessEventsResult {
  claimed: number;
  done: number;
  retry: number;
  failed: number;
  deliveries: number;
}

/**
 * 대기 중인 이벤트를 선점해 소비자에게 나눠 준다.
 * 선점은 조건부 갱신(`locked_at` 이 비었거나 임대 만료)이라 두 배치가 겹쳐도 같은 이벤트를 함께 잡지 않는다.
 */
export async function processDomainEvents(opts: { limit?: number; now?: Date; budgetMs?: number } = {}): Promise<ProcessEventsResult> {
  const clock = elapsedClock(opts.now);
  const now = clock();
  const limit = opts.limit ?? 200;
  const owner = `${now.getTime()}:${generateToken(6)}`;
  const leaseCut = new Date(now.getTime() - EVENT_LEASE_MS);
  const deadline = now.getTime() + (opts.budgetMs ?? EVENT_BATCH_BUDGET_MS);
  const result: ProcessEventsResult = { claimed: 0, done: 0, retry: 0, failed: 0, deliveries: 0 };

  const candidates = await prisma.domainEvent.findMany({
    where: {
      status: 'PENDING',
      nextAttemptAt: { lte: now },
      OR: [{ lockedAt: null }, { lockedAt: { lt: leaseCut } }],
    },
    orderBy: { occurredAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  for (const c of candidates) {
    // 시간 상한: 오래 걸린 배치가 계속 새 이벤트를 잡으면 다음 배치와 겹친다. 남은 것은 다음 배치가 잡는다.
    if (clock().getTime() >= deadline) break;
    // 선점 시각 = 지금(잡는 순간). 배치 시작 시각으로 잡으면 오래 걸린 배치가 막 잡은 이벤트도
    // 다음 배치에는 "임대 만료" 로 보여 두 번 처리된다(점검 A-3).
    const claimAt = clock();
    const cut = new Date(claimAt.getTime() - EVENT_LEASE_MS);
    const claim = await prisma.domainEvent.updateMany({
      where: { id: c.id, status: 'PENDING', OR: [{ lockedAt: null }, { lockedAt: { lt: cut } }] },
      data: { lockedAt: claimAt, lockedBy: owner },
    });
    if (claim.count === 0) continue;
    result.claimed += 1;

    const ev = await prisma.domainEvent.findUniqueOrThrow({
      where: { id: c.id },
      include: { deliveries: { select: { consumer: true, status: true, attempts: true } } },
    });
    const stored: StoredDomainEvent = {
      id: ev.id,
      merchantId: ev.merchantId,
      type: ev.type,
      subjectType: ev.subjectType,
      subjectId: ev.subjectId,
      payerId: ev.payerId,
      payload: (ev.payload ?? {}) as Record<string, unknown>,
      occurredAt: ev.occurredAt,
    };
    const finished = new Map(ev.deliveries.map((d) => [d.consumer, d]));
    const targets = [...consumers.values()].filter(
      (k) => k.types === '*' || (k.types as readonly string[]).includes(ev.type),
    );

    const errors: string[] = [];
    for (const k of targets) {
      const prev = finished.get(k.name);
      if (prev && (prev.status === 'DONE' || prev.status === 'SKIPPED')) continue;
      result.deliveries += 1;
      try {
        const r = await k.handle(stored);
        const status = r === 'SKIPPED' ? 'SKIPPED' : 'DONE';
        await prisma.domainEventDelivery.upsert({
          where: { eventId_consumer: { eventId: ev.id, consumer: k.name } },
          create: { id: newId(), eventId: ev.id, consumer: k.name, status, doneAt: new Date() },
          update: { status, error: null, doneAt: new Date(), attempts: { increment: 1 } },
        });
      } catch (e) {
        const message = (e as Error).message.slice(0, 500);
        errors.push(`${k.name}: ${message}`);
        logger.warn('이벤트 소비자 실패', { eventId: ev.id, type: ev.type, consumer: k.name, message });
        await prisma.domainEventDelivery
          .upsert({
            where: { eventId_consumer: { eventId: ev.id, consumer: k.name } },
            create: { id: newId(), eventId: ev.id, consumer: k.name, status: 'FAILED', error: message },
            update: { status: 'FAILED', error: message, attempts: { increment: 1 } },
          })
          .catch(() => undefined);
      }
    }

    const attempts = ev.attempts + 1;
    if (errors.length === 0) {
      await prisma.domainEvent.updateMany({
        where: { id: ev.id, lockedBy: owner },
        data: { status: 'DONE', attempts, processedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null },
      });
      result.done += 1;
    } else if (attempts >= EVENT_MAX_ATTEMPTS) {
      await prisma.domainEvent.updateMany({
        where: { id: ev.id, lockedBy: owner },
        data: { status: 'FAILED', attempts, lockedAt: null, lockedBy: null, lastError: errors.join(' | ').slice(0, 1000) },
      });
      result.failed += 1;
      logger.error('이벤트 처리 재시도 소진', { eventId: ev.id, type: ev.type, errors });
    } else {
      await prisma.domainEvent.updateMany({
        where: { id: ev.id, lockedBy: owner },
        data: {
          attempts,
          nextAttemptAt: backoff(attempts, now),
          lockedAt: null,
          lockedBy: null,
          lastError: errors.join(' | ').slice(0, 1000),
        },
      });
      result.retry += 1;
    }
  }
  return result;
}

/** 관리자 화면: 재시도 소진 이벤트를 다시 대기로 돌린다. */
export async function retryFailedEvent(id: string) {
  return prisma.domainEvent.updateMany({
    where: { id, status: 'FAILED' },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null },
  });
}

export async function eventQueueStats() {
  const [pending, failed, last24h] = await Promise.all([
    prisma.domainEvent.count({ where: { status: 'PENDING' } }),
    prisma.domainEvent.count({ where: { status: 'FAILED' } }),
    prisma.domainEvent.count({ where: { occurredAt: { gte: new Date(Date.now() - 86_400_000) } } }),
  ]);
  const oldestPending = await prisma.domainEvent.findFirst({
    where: { status: 'PENDING' },
    orderBy: { occurredAt: 'asc' },
    select: { occurredAt: true },
  });
  return { pending, failed, last24h, oldestPendingAt: oldestPending?.occurredAt ?? null };
}
