/**
 * Next.js 부팅 훅.
 * 운영 환경 설정이 안전 요건을 만족하지 못하면 여기서 기동을 중단시킨다.
 * (잘못된 설정으로 조용히 서비스가 뜨는 것을 막는 마지막 방어선)
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
  const { assertBootSafety, bootWarnings, env } = await import('@/lib/env');
  assertBootSafety();

  // 기동은 계속하되, 특정 기능이 멈추는 설정 누락은 반드시 눈에 띄게 남긴다.
  for (const w of bootWarnings()) console.warn(`[env] ${w}`);

  // 암호화 provider 주입. CRYPTO_PROVIDER 값에 따라 구현체를 갈아끼운다.
  // (미구현 provider 를 임의로 성공 처리하지 않는다 — 주입에 실패하면 그대로 기동을 멈춘다)
  const { installCryptoProvider } = await import('@/server/crypto-provider');
  await installCryptoProvider();

  if (env.appEnv !== 'prod') {
    console.info(`[env] APP_ENV=${env.appEnv} / NODE_ENV=${env.nodeEnv} 로 기동합니다.`);
  }
  }
}
