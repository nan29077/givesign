import crypto from 'node:crypto';
import { env } from './env';
import { normalizePhone } from './phone';
export { normalizePhone, phoneTail4 } from './phone';

/**
 * 개인정보 / 금융정보 보호 유틸.
 *
 * 저장 규칙
 *  - 전화번호: phoneHash(HMAC) + phoneEnc(암호화) + phoneMasked(마스킹) 3분리
 *  - 계좌번호: 원문 저장 금지. 끝 4자리만
 *  - 빌키/OAuth 토큰/스트림키: 암호화 또는 해시 저장, 로그 출력 금지
 *
 * 운영에서는 CRYPTO_PROVIDER=aws-kms 로 전환하여 KMS 봉투암호화를 사용한다.
 * (KMS 구현은 @aws-sdk/client-kms 설치 후 kmsProvider 에 주입)
 */

const ALGO = 'aes-256-gcm';

function masterKey(): Buffer {
  const raw = env.crypto.masterKey;
  if (!raw) throw new Error('CRYPTO_MASTER_KEY 가 설정되지 않았습니다.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    // 짧은 개발용 문자열도 안전하게 32바이트로 확장
    return crypto.createHash('sha256').update(raw).digest();
  }
  return key;
}

export interface CryptoProvider {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

const localProvider: CryptoProvider = {
  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, masterKey(), iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', 'local', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
  },
  decrypt(payload: string): string {
    const [version, provider, ivB64, tagB64, ctB64] = payload.split(':');
    if (version !== 'v1' || provider !== 'local') throw new Error('지원하지 않는 암호문 형식입니다.');
    const decipher = crypto.createDecipheriv(ALGO, masterKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  },
};

/** KMS provider 는 실제 키 계약 후 주입한다. 미구현 상태에서 임의 성공 처리하지 않는다. */
let injectedProvider: CryptoProvider | null = null;
export function setCryptoProvider(p: CryptoProvider) {
  injectedProvider = p;
}

function provider(): CryptoProvider {
  if (injectedProvider) return injectedProvider;
  if (env.crypto.provider === 'aws-kms') {
    throw new Error('CRYPTO_PROVIDER=aws-kms 이지만 KMS provider 가 주입되지 않았습니다.');
  }
  return localProvider;
}

export function encrypt(plain: string): string {
  return provider().encrypt(plain);
}

export function decrypt(cipher: string): string {
  return provider().decrypt(cipher);
}

// ---------------------------------------------------------------------------
// 해시 / 마스킹
// ---------------------------------------------------------------------------

/** 검색용 결정적 해시. 레인보우 공격 방지를 위해 반드시 secret 을 사용한다. */
export function hmac(value: string, secret = env.crypto.phoneHashSecret): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 010-1234-5678 / 01012345678 / +821012345678 → 01012345678 */

export function phoneHash(phone: string): string {
  return hmac(normalizePhone(phone));
}

/**
 * 사회복지기관별 후원자 식별자(payerRef).
 *
 * 파트너 API 로 내보내는 "같은 번호 = 같은 값" 식별자다. 예전에는 전역 phoneHash 를 그대로
 * 내보냈는데, 그러면 **사회복지기관 A 와 사회복지기관 B 가 각자 받은 값을 맞춰 보는 것만으로 같은 사람임을
 * 알 수 있다.** 사회복지기관 두 곳의 데이터가 합쳐지면(제휴·유출) 전역 식별자 하나로 후원자의
 * 서비스 이용 내역이 통째로 연결된다.
 *
 * 그래서 사회복지기관마다 다른 값이 나오도록 한 번 더 파생시킨다.
 *   payerRef = HMAC(secret, "payerref:" + merchantId + ":" + phoneHash)
 *
 * 같은 사회복지기관 안에서는 여전히 결정적이라 회원 매칭 용도는 그대로 유지된다.
 * 전역 phoneHash 자체는 절대 외부로 내보내지 않는다.
 */
export function merchantPayerRef(merchantId: string, phoneHashValue: string): string {
  if (!merchantId || !phoneHashValue) return '';
  return hmac(`payerref:${merchantId}:${phoneHashValue}`);
}

export function maskPhone(phone: string): string {
  const p = normalizePhone(phone);
  if (p.length < 9) return '***';
  const head = p.slice(0, 3);
  const tail = p.slice(-4);
  return `${head}-****-${tail}`;
}

/**
 * 표시용 전화번호 끝 4자리.
 * 마스킹된 값("010-****-1234")과 원문("01012345678") 모두 받는다.
 * 숫자가 4자리 미만이면 빈 문자열을 돌려준다.
 */

export function maskName(name: string): string {
  if (!name) return '';
  if (name.length === 1) return name;
  if (name.length === 2) return name[0] + '*';
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1];
}

export function maskAccount(account: string): string {
  const a = (account || '').replace(/[^0-9]/g, '');
  if (a.length < 4) return '****';
  return `****${a.slice(-4)}`;
}

export function accountTail4(account: string): string {
  const a = (account || '').replace(/[^0-9]/g, '');
  return a.slice(-4);
}

/** 주민등록번호 정규화(숫자 13자리). 형식이 아니면 null. */
export function normalizeResident(input: string): string | null {
  const d = (input || '').replace(/[^0-9]/g, '');
  return /^\d{13}$/.test(d) ? d : null;
}

/**
 * 주민등록번호 표기용 마스킹(예: 901010-1******).
 * 뒷자리 첫 숫자(성별)까지만 남기고 전부 가린다.
 */
export function maskResident(input: string): string {
  const d = normalizeResident(input);
  if (!d) return '******-*******';
  return `${d.slice(0, 6)}-${d[6]}******`;
}

/** 주민등록번호 유효성(형식 + 체크섬). 신분증 검증은 아니고 오타 방지용이다. */
export function isValidResident(input: string): boolean {
  const d = normalizeResident(input);
  if (!d) return false;
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(d[i]) * w[i];
  const check = (11 - (sum % 11)) % 10;
  return check === Number(d[12]);
}

/** 빌키/토큰 등 비밀값의 화면 표기용 힌트 */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return '*'.repeat(secret.length);
  return `${secret.slice(0, 4)}${'*'.repeat(Math.max(4, secret.length - 8))}${secret.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 1회용 보안 토큰
// ---------------------------------------------------------------------------

export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * 숫자 인증번호 (CSPRNG).
 * Math.random() 은 예측 가능해 인증번호 생성에 사용해서는 안 된다.
 */
export function generateNumericCode(digits = 6): string {
  const min = 10 ** (digits - 1);
  const max = 10 ** digits;
  return String(crypto.randomInt(min, max));
}

/** 지정한 알파벳으로 CSPRNG 난수 문자열 생성 (사회복지기관 코드 등). */
export function randomCodeString(alphabet: string, length: number): string {
  let s = '';
  for (let i = 0; i < length; i += 1) s += alphabet[crypto.randomInt(0, alphabet.length)];
  return s;
}

export function tokenHash(token: string): string {
  return crypto.createHmac('sha256', env.crypto.sessionSecret).update(token).digest('hex');
}

/** 타이밍 공격 방지 비교 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Webhook HMAC 서명 검증 */
export function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = signature.replace(/^sha256=/, '').trim().toLowerCase();
  return safeEqual(expected, given);
}
