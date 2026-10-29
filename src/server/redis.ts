import Redis from 'ioredis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * Redis (ElastiCache) 클라이언트.
 * 로컬/테스트에서 Redis 가 없을 때는 인메모리 폴백을 사용한다.
 * 운영에서는 ALLOW_INMEMORY_FALLBACK=false 로 두어 폴백을 금지한다.
 */

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  incr(key: string, ttlSec?: number): Promise<number>;
  del(key: string): Promise<void>;
  /** 원자적 선점. 이미 존재하면 false */
  setnx(key: string, value: string, ttlSec: number): Promise<boolean>;
}

class MemoryStore implements KvStore {
  private map = new Map<string, { v: string; exp: number }>();

  private alive(key: string) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return e;
  }

  async get(key: string) {
    return this.alive(key)?.v ?? null;
  }

  async set(key: string, value: string, ttlSec?: number) {
    this.map.set(key, { v: value, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  }

  async incr(key: string, ttlSec?: number) {
    const cur = Number((await this.get(key)) ?? 0) + 1;
    const existing = this.alive(key);
    this.map.set(key, {
      v: String(cur),
      exp: existing?.exp || (ttlSec ? Date.now() + ttlSec * 1000 : 0),
    });
    return cur;
  }

  async del(key: string) {
    this.map.delete(key);
  }

  async setnx(key: string, value: string, ttlSec: number) {
    if (this.alive(key)) return false;
    await this.set(key, value, ttlSec);
    return true;
  }

  /** 테스트 전용. 저장된 키를 모두 버린다. */
  clear() {
    this.map.clear();
  }
}

/**
 * Redis 스토어.
 * 개발 환경에서 Redis 가 떠 있지 않아도 앱이 죽지 않도록,
 * 명령 실패 시 인메모리 스토어로 자동 강등한다(운영에서는 폴백 금지).
 */
/** 폴백으로 내려간 뒤 Redis 를 다시 시도하기까지의 시간. */
const FALLBACK_RETRY_MS = 30_000;

/** 재접속을 기다리는 최대 시간. 이 안에 못 붙으면 이번 요청은 폴백으로 처리한다. */
const RECONNECT_TIMEOUT_MS = 2_000;

/** 같은 연결 오류를 다시 로그로 남기기까지의 최소 간격. */
const REDIS_ERROR_LOG_INTERVAL_MS = 60_000;

class RedisStore implements KvStore {
  private fallback: MemoryStore | null = null;
  private fallbackUntil = 0;

  constructor(private client: Redis) {}

  /**
   * 지금 폴백을 써야 하는지.
   *
   * 한 번 강등되면 영원히 인메모리로 도는 구조였다. Redis 가 복구돼도 프로세스를
   * 재시작하기 전까지 속도 제한·재전송 방어·배치 잠금이 인스턴스별로 쪼개진 채 남는다.
   * 일정 시간이 지나면 다시 Redis 를 시도한다.
   */
  private async useFallback(): Promise<MemoryStore | null> {
    if (!this.fallback) return null;
    if (Date.now() >= this.fallbackUntil) {
      logger.info('Redis 재시도 — 인메모리 폴백을 해제합니다.');
      this.fallback = null;
      // 재접속을 포기한 연결(status 'end')은 명령을 받아도 되살아나지 않는다.
      // 여기서 직접 다시 연결해야 페일오버가 끝난 뒤 진짜 Redis 로 돌아온다.
      // 연결이 설 때까지 **기다린다** — 기다리지 않으면 이번 명령이 아직 죽어 있는
      // 연결로 나가 실패하고, 곧바로 다시 폴백으로 내려가 30초를 더 잃는다.
      await this.reconnect();
      return null;
    }
    return this.fallback;
  }

  /**
   * 끊긴 연결을 다시 세운다.
   *
   * ioredis 는 retryStrategy 가 숫자가 아닌 값을 돌려주면 그 연결을 버리고 status 를
   * 'end' 로 둔다. 그 뒤로는 명령을 아무리 보내도 다시 붙지 않는다.
   * 실패해도 조용히 넘긴다 — 다음 폴백 만료 때 또 시도한다.
   */
  private async reconnect(): Promise<void> {
    const status = (this.client as unknown as { status?: string }).status;
    if (status !== 'end' && status !== 'close') return;
    // Redis 가 여전히 죽어 있으면 여기서 요청이 오래 붙잡히면 안 된다. 짧게 끊는다.
    await Promise.race([
      this.client.connect().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, RECONNECT_TIMEOUT_MS)),
    ]);
  }

  /** 현재 인메모리 폴백으로 동작 중인지(헬스체크에서 노출한다). */
  isDegraded(): boolean {
    return Boolean(this.fallback) && Date.now() < this.fallbackUntil;
  }

  private degrade(e: unknown): MemoryStore {
    if (!env.allowInMemoryFallback) throw e;
    if (!this.fallback) {
      logger.error('Redis 명령 실패. 인메모리 폴백으로 전환합니다(개발 전용).', {
        message: (e as Error)?.message,
      });
      this.fallback = new MemoryStore();
    }
    this.fallbackUntil = Date.now() + FALLBACK_RETRY_MS;
    return this.fallback;
  }

  async get(key: string) {
    const fb = await this.useFallback();
    if (fb) return fb.get(key);
    try {
      return await this.client.get(key);
    } catch (e) {
      return this.degrade(e).get(key);
    }
  }

  async set(key: string, value: string, ttlSec?: number) {
    const fb = await this.useFallback();
    if (fb) return fb.set(key, value, ttlSec);
    try {
      if (ttlSec) await this.client.set(key, value, 'EX', ttlSec);
      else await this.client.set(key, value);
    } catch (e) {
      await this.degrade(e).set(key, value, ttlSec);
    }
  }

  async incr(key: string, ttlSec?: number) {
    const fb = await this.useFallback();
    if (fb) return fb.incr(key, ttlSec);
    try {
      if (!ttlSec) return await this.client.incr(key);
      // INCR 과 EXPIRE 를 나눠 보내면 그 사이에 프로세스가 죽거나 연결이 끊겼을 때
      // 만료 없는 키가 남는다. 그 키는 영원히 줄지 않아 해당 번호·IP 가 영구 차단된다.
      // 한 번에 보내 원자적으로 처리한다.
      const [n] = (await this.client
        .multi()
        .incr(key)
        .expire(key, ttlSec, 'NX')
        .exec()) as [[Error | null, number], [Error | null, number]];
      if (n[0]) throw n[0];
      return n[1];
    } catch (e) {
      return this.degrade(e).incr(key, ttlSec);
    }
  }

  async del(key: string) {
    const fb = await this.useFallback();
    if (fb) return fb.del(key);
    try {
      await this.client.del(key);
    } catch (e) {
      await this.degrade(e).del(key);
    }
  }

  async setnx(key: string, value: string, ttlSec: number) {
    const fb = await this.useFallback();
    if (fb) return fb.setnx(key, value, ttlSec);
    try {
      const r = await this.client.set(key, value, 'EX', ttlSec, 'NX');
      return r === 'OK';
    } catch (e) {
      return this.degrade(e).setnx(key, value, ttlSec);
    }
  }
}

const globalForKv = globalThis as unknown as { kv?: KvStore; redis?: Redis };

function build(): KvStore {
  if (!env.redisUrl) {
    if (!env.allowInMemoryFallback) throw new Error('REDIS_URL 이 필요합니다.');
    logger.warn('REDIS_URL 미설정. 인메모리 폴백을 사용합니다.');
    return new MemoryStore();
  }
  try {
    const client = new Redis(env.redisUrl, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      // 오프라인 큐를 끄면 연결 불가 시 즉시 에러가 나므로 폴백이 빠르게 동작한다
      enableOfflineQueue: !env.allowInMemoryFallback,
      // 여기서 null 을 돌려주면 ioredis 가 그 연결을 버린다(status 'end').
      //
      // 예전에는 그것으로 끝이었다. ElastiCache 페일오버(보통 30초~1분) 한 번에
      // 프로세스를 재시작할 때까지 한도 카운터·속도 제한·인증번호가 전부 인메모리
      // 폴백으로 내려앉고, 서버가 여러 대면 대당 카운터가 따로 놀아 한도가 몇 배로 풀렸다.
      //
      // 그렇다고 무한히 재시도하면 재접속 타이머가 이벤트 루프를 붙잡아,
      // Redis 없이 도는 짧은 프로세스(빌드·시드·테스트)가 끝나지 않고 매달린다.
      //
      // 그래서 여기서는 짧게 포기하고(프로세스가 정상 종료된다), 복구는
      // RedisStore.reconnect() 가 맡는다 — 폴백 유예가 끝날 때 직접 다시 연결한다.
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 300, 2000)),
    });
    // 연결 오류 로그는 묶어서 남긴다.
    //
    // 재접속을 주기적으로 다시 시도하므로, 그대로 두면 Redis 를 안 띄운 개발 환경에서
    // 같은 줄이 30초마다 다섯 줄씩 끝없이 쌓여 정작 봐야 할 로그를 덮는다.
    // 처음 한 번은 바로 남기고, 그 뒤로는 1분에 한 줄로 줄이면서 그동안의 횟수를 함께 적는다.
    let lastErrorLoggedAt = 0;
    let suppressed = 0;
    client.on('error', (e: Error) => {
      const now = Date.now();
      if (now - lastErrorLoggedAt < REDIS_ERROR_LOG_INTERVAL_MS) {
        suppressed += 1;
        return;
      }
      lastErrorLoggedAt = now;
      logger.warn('redis error', {
        message: e.message,
        ...(suppressed > 0 ? { 생략된_동일_오류: suppressed } : {}),
      });
      suppressed = 0;
    });
    globalForKv.redis = client;
    return new RedisStore(client);
  } catch (e) {
    if (!env.allowInMemoryFallback) throw e;
    logger.warn('Redis 연결 실패. 인메모리 폴백을 사용합니다.');
    return new MemoryStore();
  }
}

export const kv: KvStore = globalForKv.kv ?? build();
if (process.env.NODE_ENV !== 'production') globalForKv.kv = kv;

/**
 * 인증번호 오입력 횟수를 하나 쓴다.
 *
 * 레코드 안의 남은 횟수를 읽고 빼서 다시 쓰는 방식은 두 가지가 잘못된다.
 *  1) 동시에 들어온 요청이 같은 값을 읽어, 5회 제한이 실제로는 더 많이 허용된다.
 *  2) 다시 쓸 때 TTL 이 새로 시작돼, 계속 틀리는 동안 인증번호가 만료되지 않는다.
 *
 * 그래서 시도 횟수만 따로 원자적 카운터로 센다. TTL 은 처음 한 번만 붙고(EXPIRE NX)
 * 이후 증가에는 연장되지 않으므로, 인증 창은 발급 시점부터 정확히 ttlSec 이다.
 *
 * 돌려주는 값은 "이번 시도 뒤 남은 횟수" 다. 0 이면 더 시도할 수 없다.
 */
export async function consumeAttempt(key: string, max: number, ttlSec: number): Promise<number> {
  const used = await kv.incr(key, ttlSec);
  return Math.max(0, max - used);
}

/**
 * 인메모리 카운터를 비운다. **테스트 전용**.
 *
 * 속도 제한 카운터는 프로세스 전역이라 테스트 간에 그대로 살아남는다. DB 만 비우면
 * 앞 테스트가 올려 둔 카운터 때문에 뒤 테스트가 실행 순서에 따라 제한에 걸린다.
 * Redis 를 쓰는 환경에서는 아무것도 하지 않는다(운영 데이터를 지우지 않기 위함).
 */
export function clearMemoryKv(): void {
  if (kv instanceof MemoryStore) kv.clear();
}
