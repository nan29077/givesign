/**
 * 환경변수 로더.
 * - 모든 외부 연동 키는 여기서만 읽는다.
 * - 값이 없을 때 임의 기본값으로 "성공 처리"하지 않고, mock 모드로 명시 전환한다.
 */

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function bool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

export type ProviderMode = 'mock' | string;

export type AppEnv = 'local' | 'staging' | 'prod';


const NODE_ENV = str('NODE_ENV', 'development');

/** dev/stage 같은 흔한 표기도 받아 준다. */
const APP_ENV_ALIASES: Record<string, AppEnv> = {
  local: 'local',
  dev: 'staging',
  development: 'staging',
  stage: 'staging',
  staging: 'staging',
  prod: 'prod',
  production: 'prod',
};

/**
 * APP_ENV 결정 규칙 (fail-closed).
 *
 * - 명시적으로 지정한 값이 있으면 그 값을 따른다.
 *   (로컬에서 `npm run build && npm run start` 로 미리보기를 돌리는 경우가 있으므로
 *    NODE_ENV=production 만으로 prod 로 단정하면 정상적인 로컬 검수가 막힌다)
 * - **미설정이거나 오타** 면 안전한 쪽으로 판정한다:
 *   NODE_ENV=production → 'prod', 그 외 → 'local'.
 *   즉 배포 시 APP_ENV 를 빠뜨려도 테스트 로그인·MO 시뮬레이터·개발 아웃박스가 열리지 않는다.
 */
function resolveAppEnv(): AppEnv {
  const raw = str('APP_ENV', '').trim().toLowerCase();
  const known = APP_ENV_ALIASES[raw];
  if (known) return known;
  return NODE_ENV === 'production' ? 'prod' : 'local';
}

const APP_ENV = resolveAppEnv();
const IS_LOCAL = APP_ENV === 'local';

/**
 * PIN 완료 콜백의 "성공 코드" 기본값.
 *
 * 계약 전 mock 검수를 돌리기 위한 값이다. 실제 결제사 규격의 성공 코드로 반드시 교체해야 하며,
 * 이 값이 그대로 남아 있는 채로 운영에 나가면 결제사가 어떤 코드를 보내든 'OK'/'SUCCESS' 같은
 * 흔한 문자열만 맞추면 승인(출금)이 실행된다. 그래서 운영 부팅 점검에서 이 기본값을 거부한다.
 */
const DEFAULT_PIN_SUCCESS_CODES = '0000,OK,SUCCESS,MOCK';
/** 어떤 환경에서도 실제 결제 성공으로 인정하면 안 되는 코드(mock 전용). */
const MOCK_ONLY_PIN_CODES = ['MOCK'];

/**
 * 헥토 PIN 인증창 발급이 아직 mock 구현인지 여부.
 *
 * `src/server/adapters/payment/hecto.ts` 의 `requestPinLink()` 는 연동규격서를 받지 못해
 * 기브싸인 내부 모의 PIN 화면 주소를 돌려주고 `mock: true` 를 세운다. 즉 결제사를 붙여도
 * **인증 단계만 우리 화면**이다. 실제 출금이 가능한 빌키를 든 채 인증만 모의로 통과시키는
 * 조합이므로 부팅 점검에서 막는다. 실연동을 완성하면 이 값을 false 로 바꾼다.
 *
 * env 모듈은 서버 어댑터를 import 할 수 없으므로(순환 참조) 여기에 상수로 둔다.
 */
const HECTO_PIN_LINK_IS_MOCK = true;

function isMockPinLink(): boolean {
  return HECTO_PIN_LINK_IS_MOCK;
}

/**
 * 운영/스테이징에서 반드시 있어야 하는 시크릿.
 * 로컬에서만 개발용 기본값을 허용하고, 그 외 환경에서는 모듈 로드 시점에 즉시 예외를 던진다.
 * (기본값으로 조용히 기동해 세션 위조·전화번호 해시 충돌이 발생하는 fail-open 을 막는다)
 */
function requiredSecret(key: string, devFallback: string): string {
  const v = process.env[key];
  if (v && v.trim() !== '') return v;
  if (IS_LOCAL) return devFallback;
  throw new Error(`[env] ${key} 가 설정되지 않았습니다. APP_ENV=${APP_ENV} 환경에서는 필수입니다.`);
}

export const env = {
  nodeEnv: NODE_ENV,
  appEnv: APP_ENV,
  baseUrl: str('APP_BASE_URL', 'http://localhost:3060'),
  timezone: str('APP_TIMEZONE', 'Asia/Seoul'),

  databaseUrl: str('DATABASE_URL'),
  directDatabaseUrl: str('DIRECT_DATABASE_URL'),

  redisUrl: str('REDIS_URL'),
  allowInMemoryFallback: bool('ALLOW_INMEMORY_FALLBACK', true),

  crypto: {
    provider: str('CRYPTO_PROVIDER', 'local') as 'local' | 'aws-kms',
    masterKey: str('CRYPTO_MASTER_KEY'),
    phoneHashSecret: requiredSecret('PHONE_HASH_SECRET', 'dev-only-phone-hmac-secret'),
    sessionSecret: requiredSecret('SESSION_SECRET', 'dev-only-session-secret'),
    awsRegion: str('AWS_REGION', 'ap-northeast-2'),
    kmsKeyId: str('AWS_KMS_KEY_ID'),
  },

  payment: {
    provider: str('PAYMENT_PROVIDER', 'mock') as ProviderMode,
    /** 헥토파이낸셜 상점아이디 (mercntId). */
    hectoMid: str('HECTO_MID'),
    hectoLicenseKey: str('HECTO_LICENSE_KEY'),
    /** custCi / trPrice 암호화용 AES-256 키 (32byte). */
    hectoAesKey: str('HECTO_AES_KEY'),
    /** 위변조 검증 해시키 (SHA256 signature 재료). */
    hectoHashKey: str('HECTO_HASH_KEY'),
    /**
     * 내통장결제(EzAuth) 호스트는 결제창과 서버 API 가 서로 다르다.
     * - UI(결제창/SettlePay.js): https://ezauth.settlebank.co.kr
     * - 서버 API(승인/빌키): https://ezauthapi.settlebank.co.kr:8081
     * 하나로 합치면 승인 요청이 결제창 호스트로 나가 전건 실패한다.
     */
    hectoAuthUiBase: str('HECTO_AUTH_UI_BASE', 'https://ezauth.settlebank.co.kr'),
    hectoAuthApiBase: str('HECTO_AUTH_API_BASE', 'https://ezauthapi.settlebank.co.kr:8081'),
    /** 결제 결과 콜백을 받을 자사 URL. 결제창 hash 재료(호스트)에도 사용된다. */
    hectoCallbackUrl: str('HECTO_CALLBACK_URL'),
    /** 헥토 공식 제한은 결제인증 후 10분. 그보다 짧게 운용한다. */
    confirmTtlSec: num('PAYMENT_CONFIRM_TTL_SEC', 300),
    /** 후원 금액 선택 링크 유효시간. 금액 선택 + PIN 입력을 한 화면에서 끝내는 시간이다. */
    selectTtlSec: num('PAYMENT_SELECT_TTL_SEC', 600),
    /** PIN 입력 링크 유효시간. 결제사 인증창 유효시간(10분)을 넘지 않게 잡는다. */
    pinTtlSec: num('PAYMENT_PIN_TTL_SEC', 300),
    /** PIN 완료 콜백 검증용 공유 비밀 (X-Pin-Secret). 실연동 시 결제사 서명 검증으로 대체한다. */
    pinCallbackSecret: str('PAYMENT_PIN_CALLBACK_SECRET'),
    /**
     * PIN 완료 콜백에서 "인증 성공"으로 인정할 결과코드 목록 (대문자, 콤마 구분).
     * 이 목록에 없는 코드는 인증 실패로 처리하고 승인(출금)을 실행하지 않는다.
     * 실연동 시 결제사 규격의 성공 코드로 교체한다.
     */
    pinSuccessCodes: str('PAYMENT_PIN_SUCCESS_CODES', DEFAULT_PIN_SUCCESS_CODES)
      .split(',')
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean),
    /**
     * PIN 완료 콜백을 보낼 수 있는 결제사 IP 허용목록 (콤마 구분).
     *
     * 공유 비밀(X-Pin-Secret) 하나만으로 막으면 비밀이 유출되는 순간 어디서든
     * "인증 성공" 통지를 만들어 출금을 일으킬 수 있다. 발신 IP 를 함께 봐서 2중으로 막는다.
     * 비어 있으면 로컬에서만 검사를 생략한다(운영에서는 부팅 점검이 설정을 요구한다).
     */
    pinCallbackIps: str('PIN_CALLBACK_IPS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  emma: {
    /** EMMA(인포뱅크 온프레미스 에이전트) 연동 사용 여부. */
    enabled: bool('EMMA_ENABLED', false),
    /**
     * EMMA 전용 DB 접속 URL. 비우면 앱과 같은 DB(DATABASE_URL)를 쓴다.
     * EMMA 는 테이블·프로시저 생성 권한을 요구하므로 **분리를 권장**한다.
     */
    dbUrl: str('EMMA_DB_URL'),
    poolMax: num('EMMA_DB_POOL_MAX', 4),
    /**
     * 계약한 대표번호(숫자만).
     * 설정하면 이 대표번호로 들어온 수신만 처리한다. 한 EMMA 에 여러 서비스의 번호가 물린
     * 구성에서 서로의 문자를 가로채는 사고를 막는 안전판이다.
     */
    baseNumber: str('EMMA_MO_BASE_NUMBER'),
    /**
     * EMMA 이중화 인스턴스 ID(2자리). **이중화를 실제로 쓸 때만** 설정한다.
     * 값이 EMMA 설정과 다르면 MT 가 큐에 쌓이기만 하고 발송되지 않는다(emma/mt-sender.ts 주석 참고).
     */
    emmaId: str('EMMA_ID'),
    /** 폴링 1회에 가져올 최대 건수. */
    batchSize: num('EMMA_MO_BATCH_SIZE', 200),
    /** 선점된 채 이 시간(초)을 넘긴 건은 중단된 것으로 보고 되살린다. */
    staleSec: num('EMMA_MO_STALE_SEC', 300),
  },

  mo: {
    provider: str('MO_PROVIDER', 'mock') as ProviderMode,
    webhookSecret: str('MO_WEBHOOK_SECRET'),
    allowedIps: str('MO_ALLOWED_IPS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** MTONET 050/MO 연동 값. */
    mtonetUserId: str('MTONET_USER_ID'),
    mtonetApiKey: str('MTONET_API_KEY'),

    /**
     * 이미 가입한 후원자의 MO 폭주 상한 (사회복지기관 × 전화번호 단위).
     *
     * MO 문자 1건마다 금액 선택 링크 MT 가 한 통 나간다. 같은 번호가 문자를 연달아 보내면
     * (오해·장난·단말 자동 재전송) 그만큼 문자가 나가고 비용이 청구된다.
     *
     * 1차 방어는 "직전 링크가 아직 유효하면 다시 보내지 않는다"(charge-flow 의 checkMoThrottle)로,
     * 사실상 링크 유효시간(PAYMENT_SELECT_TTL_SEC, 기본 10분)당 1건이 된다.
     * 여기 값은 그 위에 얹는 안전판이다. **정상 후원자가 닿을 수 없는 값**으로 잡아
     * 실수로 결제를 막지 않게 한다. 0 이면 상한을 쓰지 않는다.
     */
    chargeThrottleWindowSec: num('MO_CHARGE_THROTTLE_WINDOW_SEC', 1800),
    chargeThrottleMax: num('MO_CHARGE_THROTTLE_MAX', 10),
  },

  /** 문자 발송(MT). provider 는 mock | coolsms | emma 를 지원한다. */
  mt: {
    provider: str('MT_PROVIDER', 'mock') as ProviderMode,
    apiKey: str('MT_API_KEY'),
    apiSecret: str('MT_API_SECRET'),
    fromNumber: str('MT_FROM_NUMBER', '15880000'),
    /**
     * 사업자에 등록한 발신번호. 사업자 규격에서 부르는 이름이 sender 이므로 별도 변수로 받는다.
     * 미설정이면 기존 MT_FROM_NUMBER 를 그대로 쓴다 (두 값을 따로 관리하다 어긋나는 사고 방지).
     */
    senderNumber: str('MT_SENDER_NUMBER', str('MT_FROM_NUMBER', '15880000')),
  },

  /** 소셜 간편 로그인 (카카오 / 네이버). 키가 없으면 준비 중 상태로 표시된다. */
  social: {
    kakao: {
      clientId: str('KAKAO_CLIENT_ID'),
      clientSecret: str('KAKAO_CLIENT_SECRET'),
      redirectUri: str('KAKAO_REDIRECT_URI'),
    },
    naver: {
      clientId: str('NAVER_CLIENT_ID'),
      clientSecret: str('NAVER_CLIENT_SECRET'),
      redirectUri: str('NAVER_REDIRECT_URI'),
    },
  },

  /** 지급대행(정산금 이체) 연동 */
  payout: {
    provider: str('PAYOUT_PROVIDER', 'mock') as ProviderMode,
    apiBase: str('PAYOUT_API_BASE'),
    apiKey: str('PAYOUT_API_KEY'),
    /** 자동 지급 최소 금액(원). 이보다 적으면 다음 회차로 이월한다. */
    minAmount: num('PAYOUT_MIN_AMOUNT', 1000),
  },

  storage: {
    bucket: str('S3_BUCKET'),
    publicBase: str('S3_PUBLIC_BASE'),
  },

  /**
   * 정리 배치(/api/cron/cleanup) 호출용 공유 비밀.
   * 외부 스케줄러(AWS EventBridge Scheduler 등)가 Authorization: Bearer 로 보낸다.
   * 비어 있으면 로컬에서만 호출을 허용한다(fail-closed).
   */
  cron: {
    secret: str('CRON_SECRET'),
  },

  safety: {
    /** 금융사 서면승인 등록 전에는 DIRECT_TRIGGER 를 열지 않는다. */
    allowDirectTrigger: bool('ALLOW_DIRECT_TRIGGER', false),
    /** true 이면 실제 결제/실제 MT 발송을 차단한다. */
    safeMode: bool('SAFE_MODE', true),
  },
} as const;

/**
 * 구(舊) CONFIRM_LINK 경로(기브싸인 자체 확인 페이지)를 계속 쓸지 여부. **deprecated**
 *
 * 기본값 false — CONFIRM_LINK 모드는 결제사 PIN 인증 링크를 사용한다.
 * 되돌림(롤백)이 필요할 때만 ALLOW_LEGACY_CONFIRM_LINK=true 로 연다.
 *
 * `env` 객체가 아니라 함수로 노출하는 이유: 이 값은 운영 중 전환 가능한 스위치이고,
 * 테스트에서 두 경로를 모두 검증하려면 호출 시점에 읽어야 한다.
 */
export function allowLegacyConfirmLink(): boolean {
  return bool('ALLOW_LEGACY_CONFIRM_LINK', false);
}

/**
 * 결제 페이지 PC 웹 결제에서 구(舊) 즉시 결제를 계속 쓸지 여부. **deprecated**
 *
 * 기본값 false — 웹 결제도 결제사 PIN 인증 링크를 문자로 보내고, PIN 입력 후에 결제된다.
 * 되돌림(롤백)이 필요할 때만 ALLOW_LEGACY_WEB_INSTANT_PAY=true 로 연다.
 * (allowLegacyConfirmLink 와 같은 이유로 함수로 노출한다)
 */
export function allowLegacyWebInstantPay(): boolean {
  return bool('ALLOW_LEGACY_WEB_INSTANT_PAY', false);
}

export const isProd = env.appEnv === 'prod';
/** 개발 전용 기능(테스트 로그인, MO 시뮬레이터, 개발 아웃박스)을 열어도 되는 환경인지. */
export const isLocal = env.appEnv === 'local';

/**
 * 실물 상품·배송·문서 상품 기능 노출 여부.
 * 메시지페이에서 넘어온 기능으로 코드는 유지하되, 사회복지기관 콘솔·공개 화면에서는 기본으로 숨긴다.
 */
export function featureGoodsEnabled(): boolean {
  return process.env.FEATURE_GOODS === 'true';
}

/** 운영 배포 전 반드시 통과해야 하는 환경 점검 */
export function assertProductionSafety(): string[] {
  const problems: string[] = [];
  if (!isProd) return problems;
  if (env.crypto.provider !== 'aws-kms') problems.push('운영에서는 CRYPTO_PROVIDER=aws-kms 여야 합니다.');
  // KMS 키 ID 가 없으면 provider 주입이 실패해 암호화가 전건 예외가 된다.
  if (env.crypto.provider === 'aws-kms' && !env.crypto.kmsKeyId) {
    problems.push('CRYPTO_PROVIDER=aws-kms 인데 AWS_KMS_KEY_ID 가 비어 있습니다.');
  }
  if (env.crypto.sessionSecret.startsWith('dev-only')) problems.push('SESSION_SECRET 이 기본값입니다.');
  if (env.crypto.phoneHashSecret.startsWith('dev-only')) problems.push('PHONE_HASH_SECRET 이 기본값입니다.');
  if (env.allowInMemoryFallback) problems.push('운영에서는 ALLOW_INMEMORY_FALLBACK=false 여야 합니다.');
  // EMMA 는 HTTP 웹훅을 쓰지 않고 DB 폴링으로 붙는다(/api/cron/emma-mo).
  // 그 구성에서는 MO 웹훅 설정이 아예 필요 없으므로 요구하지 않는다.
  if (!env.emma.enabled) {
    if (env.mo.allowedIps.length === 0) problems.push('MO_ALLOWED_IPS 가 비어 있습니다.');
    if (!env.mo.webhookSecret) problems.push('MO_WEBHOOK_SECRET 이 비어 있습니다.');
  } else if (!env.cron.secret) {
    // EMMA 폴링은 크론 비밀로만 보호된다. 비어 있으면 폴링이 전건 401 로 막혀 수신이 멈춘다.
    problems.push('EMMA_ENABLED=true 인데 CRON_SECRET 이 비어 있습니다. (MO 폴링이 전건 거절됩니다)');
  }
  // 비어 있으면 PIN 완료 콜백이 전건 거절되어 결제가 영원히 완료되지 않는다.
  if (!env.payment.pinCallbackSecret) problems.push('PAYMENT_PIN_CALLBACK_SECRET 이 비어 있습니다.');
  // 공유 비밀 하나가 유출되면 임의의 출금 통지를 만들 수 있다. 발신 IP 로 2중 방어한다.
  if (env.payment.pinCallbackIps.length === 0) {
    problems.push('PIN_CALLBACK_IPS 가 비어 있습니다. (결제사 발신 IP 허용목록은 운영에서 필수입니다)');
  }
  // 기본 성공 코드('0000,OK,SUCCESS,MOCK')는 mock 검수용이다. 그대로 두면 결제사가 실패를
  // 통지해도 흔한 문자열 하나만 맞으면 승인이 실행된다. 실제 규격 코드로 교체해야 한다.
  if (!process.env.PAYMENT_PIN_SUCCESS_CODES || process.env.PAYMENT_PIN_SUCCESS_CODES.trim() === '') {
    problems.push(
      'PAYMENT_PIN_SUCCESS_CODES 가 설정되지 않았습니다. 운영에서는 결제사 규격의 실제 성공 코드를 지정해야 합니다.',
    );
  }
  const mockCodes = env.payment.pinSuccessCodes.filter((c) => MOCK_ONLY_PIN_CODES.includes(c));
  if (mockCodes.length > 0) {
    problems.push(`PAYMENT_PIN_SUCCESS_CODES 에 mock 전용 코드가 남아 있습니다: ${mockCodes.join(', ')}`);
  }
  if (env.payment.provider === 'mock') problems.push('PAYMENT_PROVIDER 가 mock 입니다.');
  // 결제사(헥토)를 붙였는데 PIN 인증만 mock 으로 남아 있으면, 실제 출금이 가능한 빌키를 든 채
  // 인증 단계만 모의 화면으로 통과시키게 된다. 조합 자체를 막는다.
  if (env.payment.provider === 'hecto' && isMockPinLink()) {
    problems.push(
      'PAYMENT_PROVIDER=hecto 인데 PIN 인증 링크가 아직 mock 구현입니다. ' +
        '(src/server/adapters/payment/hecto.ts 의 requestPinLink 실연동을 완료하고 ' +
        'src/lib/env.ts 의 HECTO_PIN_LINK_IS_MOCK 을 false 로 바꾸십시오)',
    );
  }
  // 문자 수신·발신이 mock 이면 결제 요청을 아예 못 받거나, 링크 문자가 나가지 않는다.
  if (env.mo.provider === 'mock' && !env.emma.enabled) problems.push('MO_PROVIDER 가 mock 입니다.');
  if (env.mt.provider === 'mock') problems.push('MT_PROVIDER 가 mock 입니다. (링크 문자가 실제로 발송되지 않습니다)');
  // 발신번호 기본값(15880000)은 형식만 맞춘 자리표시자다. 그대로 두면 사업자에 등록되지 않은
  // 번호로 발송을 시도해 전건 실패하거나, 남의 번호로 문자가 나간다.
  if (!process.env.MT_FROM_NUMBER || process.env.MT_FROM_NUMBER.trim() === '') {
    problems.push('MT_FROM_NUMBER 가 설정되지 않았습니다. (기본값 15880000 은 자리표시자입니다)');
  }
  if (env.mt.fromNumber === '15880000' || env.mt.senderNumber === '15880000') {
    problems.push('MT 발신번호가 기본값(15880000) 그대로입니다. 사업자에 등록한 발신번호로 바꿔 주세요.');
  }
  // SAFE_MODE 기본값이 true 라, 운영 배포에서 이 값을 빠뜨리면 결제·문자 어댑터가
  // 조용히 mock 으로 바뀐다. 아무에게도 청구하지 않고 "결제 완료" 문자가 나가고,
  // 며칠 뒤 자동 정산이 실재하지 않는 결제에 대해 사회복지기관에 실제 이체를 한다.
  if (env.safety.safeMode) {
    problems.push('운영에서는 SAFE_MODE=false 여야 합니다. (true 이면 결제·문자가 mock 으로 대체됩니다)');
  }
  if (env.payout.provider === 'mock') {
    problems.push('PAYOUT_PROVIDER 가 mock 입니다. mock 지급대행은 이체 없이 정산을 완료 처리합니다.');
  }
  // 되돌림용 스위치들은 운영에서 열려 있으면 안 된다.
  if (allowLegacyWebInstantPay()) {
    problems.push('운영에서는 ALLOW_LEGACY_WEB_INSTANT_PAY=false 여야 합니다.');
  }
  if (!env.redisUrl) {
    problems.push('REDIS_URL 이 비어 있습니다. (속도 제한·재전송 방어·배치 잠금이 동작하지 않습니다)');
  }
  if (!env.baseUrl.startsWith('https://')) problems.push('운영에서는 APP_BASE_URL 이 https 여야 합니다.');
  // 로컬 디스크 저장은 다중 인스턴스에서 이미지가 안 보이고 재배포 때 사라진다.
  if ((process.env.STORAGE_DRIVER ?? 'local').toLowerCase() !== 's3') {
    problems.push('운영에서는 STORAGE_DRIVER=s3 여야 합니다. (로컬 디스크 저장은 재배포 시 이미지가 사라집니다)');
  } else if (!process.env.S3_BUCKET) {
    problems.push('STORAGE_DRIVER=s3 인데 S3_BUCKET 이 비어 있습니다.');
  }
  if (env.payment.provider !== 'mock') {
    if (!env.payment.hectoMid) problems.push('HECTO_MID 가 비어 있습니다.');
    if (!env.payment.hectoHashKey) problems.push('HECTO_HASH_KEY 가 비어 있습니다.');
    if (!env.payment.hectoAesKey) problems.push('HECTO_AES_KEY 가 비어 있습니다.');
    if (env.payment.hectoAuthUiBase === env.payment.hectoAuthApiBase) {
      problems.push('HECTO_AUTH_UI_BASE 와 HECTO_AUTH_API_BASE 는 서로 다른 호스트여야 합니다.');
    }
  }
  return problems;
}

/**
 * 기동을 막지는 않지만 운영자가 확인해야 하는 설정.
 *
 * "없으면 서비스가 위험한 값"은 assertProductionSafety() 에서 기동을 중단시키고,
 * "없으면 특정 기능만 멈추는 값"은 여기서 경고만 남긴다.
 */
export function bootWarnings(): string[] {
  const warnings: string[] = [];
  if (isProd && !env.cron.secret) {
    warnings.push(
      'CRON_SECRET 이 비어 있습니다. 정리 배치(/api/cron/cleanup)가 전건 401 로 거절되어 ' +
        '만료된 PIN 인증/확인 링크가 자동 취소되지 않습니다.',
    );
  }
  // provider=local 인데 마스터키가 없으면 개인정보 암호화가 호출 시점에 예외가 된다.
  if (env.crypto.provider === 'local' && !env.crypto.masterKey) {
    warnings.push('CRYPTO_MASTER_KEY 가 비어 있습니다. 개인정보 암호화가 호출 시점에 실패합니다.');
  }

  // ── local 이 아닌 환경(staging 포함)에서 mock 사업자가 남아 있는지 ─────────────────
  //
  // 운영(prod)은 assertProductionSafety() 가 기동을 중단시킨다. 스테이징은 검수를 위해
  // mock 을 켜 두는 경우가 있으므로 막지 않되, "실제 문자가 나가지 않는 상태"임을
  // 부팅 로그에 반드시 남긴다. 이 경고가 없으면 스테이징에서 문자를 못 받은 원인을
  // 코드에서 찾다가 시간을 버린다.
  if (!isLocal) {
    if (env.mo.provider === 'mock' && !env.emma.enabled) {
      warnings.push(
        `MO_PROVIDER=mock 입니다 (APP_ENV=${env.appEnv}). 실제 수신 문자를 받을 수 없고 시뮬레이터 경로만 동작합니다.`,
      );
    }
    if (env.mt.provider === 'mock') {
      warnings.push(
        `MT_PROVIDER=mock 입니다 (APP_ENV=${env.appEnv}). 실제 문자가 발송되지 않고 개발 아웃박스에만 쌓입니다.`,
      );
    }
    if (env.safety.safeMode) {
      warnings.push(
        `SAFE_MODE=true 입니다 (APP_ENV=${env.appEnv}). 결제·문자 어댑터가 mock 으로 대체됩니다.`,
      );
    }
    if (env.payment.provider === 'hecto' && isMockPinLink()) {
      warnings.push(
        'PAYMENT_PROVIDER=hecto 이지만 PIN 인증창은 아직 mock 구현입니다. ' +
          '(hecto.ts requestPinLink — 연동규격서 수령 후 교체 필요)',
      );
    }
    if (env.payment.pinCallbackIps.length === 0) {
      warnings.push('PIN_CALLBACK_IPS 가 비어 있습니다. PIN 완료 콜백의 발신 IP 검사가 생략됩니다.');
    }
  }
  return warnings;
}

/**
 * 부팅 시 1회 호출한다 (src/instrumentation.ts).
 * 운영 환경에서 위 점검을 통과하지 못하면 기동 자체를 중단시킨다.
 * — 잘못된 설정으로 조용히 서비스가 뜨는 것이 가장 위험하다.
 */
export function assertBootSafety(): void {
  const problems = assertProductionSafety();
  if (problems.length === 0) return;
  const msg = `[env] 운영 환경 설정 점검 실패\n- ${problems.join('\n- ')}`;
  throw new Error(msg);
}
