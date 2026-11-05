/**
 * 시드 실행 환경 판정 (순수 함수 — DB 에 닿지 않는다).
 *
 * - prod    : 기준 데이터(약관·전역 수수료/한도 정책·전역 금칙어·필수 SystemSetting)만,
 *             이미 있으면 건드리지 않고 없는 것만 만든다. 계정·샘플 거래는 만들지 않는다.
 * - staging : 기준 데이터 + 샘플. 단 샘플 계정 비밀번호는 SEED_ADMIN_PASSWORD 가 필수다
 *             (CLAUDE.md 에 공개된 기본 비밀번호로 외부 접근 가능한 최고관리자가 생기지 않게).
 * - local   : 기준 데이터 + 샘플, 기존처럼 공개 기본 비밀번호를 쓴다.
 *
 * APP_ENV 별칭은 src/lib/env.ts 와 같다. NODE_ENV=production 이면 APP_ENV 와 무관하게 prod 로 본다
 * (예전 시드 가드와 같은 fail-closed).
 */
export type SeedEnv = Record<string, string | undefined>;
export type SeedTier = 'local' | 'staging' | 'prod';

const ALIASES: Record<string, SeedTier> = {
  local: 'local',
  dev: 'staging',
  development: 'staging',
  stage: 'staging',
  staging: 'staging',
  prod: 'prod',
  production: 'prod',
};

export function resolveSeedTier(e: SeedEnv = process.env): SeedTier {
  if (e.NODE_ENV === 'production') return 'prod';
  const raw = (e.APP_ENV ?? '').trim().toLowerCase();
  return ALIASES[raw] ?? 'local';
}

export const LOCAL_SEED_PASSWORD = 'givesign1234!';

/**
 * 샘플 계정 비밀번호.
 * local 은 공개 기본값(SEED_ADMIN_PASSWORD 가 있으면 그 값), staging 은 SEED_ADMIN_PASSWORD(12자 이상) 필수,
 * prod 는 계정을 만들지 않는다.
 */
export function seedAccountPassword(
  tier: SeedTier,
  e: SeedEnv = process.env,
): { ok: true; password: string } | { ok: false; message: string } {
  if (tier === 'prod') return { ok: false, message: '운영 환경에서는 시드 계정을 만들지 않습니다.' };
  const given = (e.SEED_ADMIN_PASSWORD ?? '').trim();
  if (tier === 'local') return { ok: true, password: given || LOCAL_SEED_PASSWORD };
  if (!given) {
    return { ok: false, message: `APP_ENV=${tier} 에서는 SEED_ADMIN_PASSWORD 를 지정해야 샘플 계정을 만듭니다.` };
  }
  if (given.length < 12 || given === LOCAL_SEED_PASSWORD) {
    return { ok: false, message: 'SEED_ADMIN_PASSWORD 는 12자 이상이고 공개 기본값과 달라야 합니다.' };
  }
  return { ok: true, password: given };
}
