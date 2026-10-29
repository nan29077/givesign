import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { addDays } from '@/lib/datetime';

/**
 * 멱등성 유틸.
 * 같은 MO Webhook 이 재전송되어도 결제가 중복 승인되지 않도록
 * (scope, key) 유니크 제약으로 1차 방어한다.
 *
 * 전체 방어 체계
 *  1) mo_inbound_message.provider_message_id UNIQUE  ← 사업자 재전송
 *  2) idempotency_key (scope,key) UNIQUE             ← 거래 생성
 *  3) 후원자 행 잠금(SELECT ... FOR UPDATE) + 판정 트랜잭션  ← 동시성
 *  4) PG 주문번호 재사용 + 거래결과조회               ← 외부 확정
 */

export type IdempotencyOutcome<T> =
  | { status: 'ACQUIRED'; release: (resourceId: string) => Promise<void>; abort: () => Promise<void> }
  | { status: 'DUPLICATE'; resourceId: string | null; value?: T };

export async function acquireIdempotency<T = unknown>(
  scope: string,
  key: string,
  ttlDays = 7,
): Promise<IdempotencyOutcome<T>> {
  try {
    const row = await prisma.idempotencyKey.create({
      data: {
        id: newId(),
        scope,
        key,
        status: 'IN_PROGRESS',
        expiresAt: addDays(new Date(), ttlDays),
      },
    });
    return {
      status: 'ACQUIRED',
      release: async (resourceId: string) => {
        await prisma.idempotencyKey.update({
          where: { id: row.id },
          data: { status: 'DONE', resourceId },
        });
      },
      abort: async () => {
        await prisma.idempotencyKey.delete({ where: { id: row.id } }).catch(() => undefined);
      },
    };
  } catch {
    const existing = await prisma.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
    return { status: 'DUPLICATE', resourceId: existing?.resourceId ?? null };
  }
}

export async function purgeExpiredIdempotencyKeys(now = new Date()): Promise<number> {
  const r = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
  return r.count;
}
