/**
 * 마스킹 로거.
 * 전화번호/빌키/토큰/계좌번호가 로그로 새어나가지 않도록 출력 직전에 한 번 더 거른다.
 */

const SENSITIVE_KEYS = [
  'phone', 'phoneNumber', 'mobile', 'msisdn',
  'billKey', 'billkey', 'cardNo', 'account', 'accountNo', 'accountNumber',
  'token', 'accessToken', 'refreshToken', 'password',
  'authorization', 'signature', 'secret', 'apiKey', 'licenseKey',
];

const PHONE_RE = /(01[016789])[-\s]?(\d{3,4})[-\s]?(\d{4})/g;

/**
 * URL 은 통째로 가린다.
 *
 * 이 앱의 일회용 링크(비밀번호 재설정, 계좌 등록, PIN 인가)는 토큰을 경로나 쿼리에 싣는다.
 * 그 링크가 로그에 한 줄만 남아도 로그를 볼 수 있는 사람이 남의 계정을 가져갈 수 있다.
 * 호스트만 남기고 나머지는 지운다.
 */
const URL_RE = /(https?:\/\/[^\s/]+)\/\S*/gi;

/** 문자열에서 개인정보·자격증명 흔적을 지운다. 로그 메시지와 meta 양쪽에 쓴다. */
export function scrubText(input: string): string {
  return input.replace(URL_RE, '$1/[링크 감춤]').replace(PHONE_RE, '$1-****-$3');
}

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return scrubText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase()))) {
      out[k] = typeof v === 'string' && v.length > 8 ? `${v.slice(0, 2)}***${v.slice(-2)}` : '***';
    } else {
      out[k] = scrub(v, depth + 1);
    }
  }
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, message: string, meta?: unknown) {
  const line = {
    ts: new Date().toISOString(),
    level,
    // message 도 반드시 걸러야 한다. 예전에는 meta 만 걸러서,
    // 링크를 메시지에 끼워 넣은 곳(비밀번호 재설정)에서 토큰이 그대로 새 나갔다.
    message: scrubText(message),
    ...(meta !== undefined ? { meta: scrub(meta) } : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (m: string, meta?: unknown) => emit('debug', m, meta),
  info: (m: string, meta?: unknown) => emit('info', m, meta),
  warn: (m: string, meta?: unknown) => emit('warn', m, meta),
  error: (m: string, meta?: unknown) => emit('error', m, meta),
};
