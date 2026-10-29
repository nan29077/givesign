import { z } from 'zod';
import { requireAdmin, type SessionUser } from '@/server/auth';
import type { AdminActionState } from '@/components/admin/state';

/**
 * 관리자 서버 액션 공통 헬퍼.
 *
 * 규칙
 *  - 모든 액션은 requireAdmin() 을 먼저 통과해야 한다.
 *  - READ_ONLY 권한은 조회만 가능하며 어떤 변경도 수행할 수 없다.
 *  - 변경 성공/실패는 예외를 던지지 않고 AdminActionState 로 돌려준다.
 *
 * 이 파일은 'use server' 가 아니다. (동기 함수/타입을 export 하기 위함)
 */

export type { AdminActionState };

/**
 * 권한 판정은 반드시 **화이트리스트**로 한다.
 *
 * `permission !== 'READ_ONLY'` 같은 블랙리스트는 두 경우에 조용히 열린다.
 *  1) adminProfile 행이 없어 adminPermission 이 undefined 인 계정(레이아웃에 "권한 미지정"으로 뜬다)
 *  2) AdminPermission enum 에 등급이 추가됐는데 이 파일을 함께 고치지 않은 경우
 * 어느 쪽이든 "모르는 등급"이 금전·정책 변경까지 통과한다. 화이트리스트는 반대로 닫힌다.
 * (같은 이유로 api/admin/settlements/* 라우트도 화이트리스트를 쓴다)
 */
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'OPERATION', 'FINANCE', 'SUPPORT']);
const MONEY_PERMISSIONS: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'OPERATION', 'FINANCE']);

export async function requireWriteAdmin(): Promise<SessionUser> {
  const user = await requireAdmin();
  if (!WRITE_PERMISSIONS.has(String(user.adminPermission))) {
    throw new Error('읽기 전용 권한입니다. 변경 작업은 수행할 수 없습니다.');
  }
  return user;
}

/** 금전·정책 변경 전용 진입점. 정산·환불·수수료·한도처럼 돈이 움직이는 액션에서 쓴다. */
export async function requireFinanceAdmin(): Promise<SessionUser> {
  const user = await requireWriteAdmin();
  assertMoneyAdmin(user);
  return user;
}

/**
 * run() 안에서 이미 받은 admin 으로 금전·정책 권한을 확인한다.
 *
 * 액션마다 문구가 다르므로 message 를 받는다. 판정 기준(화이트리스트)은 한 곳에 모아 둔다.
 */
export function assertMoneyAdmin(admin: SessionUser, message?: string): void {
  if (!MONEY_PERMISSIONS.has(String(admin.adminPermission))) {
    throw new Error(message ?? '이 작업은 최고관리자·운영·재무 권한에서만 가능합니다.');
  }
}

/** 액션 본문 실행 래퍼. 성공 시 반환한 문자열이 그대로 사용자 메시지가 된다. */
export async function run(
  fn: (admin: SessionUser) => Promise<string | { message: string; detail?: Record<string, string> }>,
): Promise<AdminActionState> {
  try {
    const admin = await requireWriteAdmin();
    const result = await fn(admin);
    if (typeof result === 'string') return { ok: true, message: result };
    return { ok: true, message: result.message, detail: result.detail };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '처리 중 오류가 발생했습니다.' };
  }
}

// ------------------------------------------------------------------ 입력 파싱

export function text(fd: FormData, key: string): string {
  return String(fd.get(key) ?? '').trim();
}

export function optText(fd: FormData, key: string): string | null {
  const v = text(fd, key);
  return v === '' ? null : v;
}

export function bool(fd: FormData, key: string): boolean {
  const v = text(fd, key);
  return v === 'on' || v === 'true' || v === '1';
}

const intSchema = z.coerce.number().int();

export function int(fd: FormData, key: string, opts?: { min?: number; max?: number; label?: string }): number {
  const raw = text(fd, key).replace(/[,\s]/g, '');
  const parsed = intSchema.safeParse(raw === '' ? NaN : raw);
  if (!parsed.success) throw new Error(`${opts?.label ?? key} 값은 정수로 입력해 주세요.`);
  const n = parsed.data;
  if (opts?.min !== undefined && n < opts.min) throw new Error(`${opts?.label ?? key} 값은 ${opts.min} 이상이어야 합니다.`);
  if (opts?.max !== undefined && n > opts.max) throw new Error(`${opts?.label ?? key} 값은 ${opts.max} 이하여야 합니다.`);
  return n;
}

/** 금액(BigInt). 빈 값은 허용하지 않는다. */
export function money(fd: FormData, key: string, label: string, opts?: { min?: bigint }): bigint {
  const raw = text(fd, key).replace(/[,\s원]/g, '');
  if (!/^\d{1,15}$/.test(raw)) throw new Error(`${label} 금액을 숫자로 입력해 주세요.`);
  const v = BigInt(raw);
  if (opts?.min !== undefined && v < opts.min) throw new Error(`${label} 금액이 너무 작습니다.`);
  return v;
}

/** 금액(BigInt). 빈 값이면 null (= 정책 기본값 사용) */
export function optMoney(fd: FormData, key: string, label: string): bigint | null {
  const raw = text(fd, key).replace(/[,\s원]/g, '');
  if (raw === '') return null;
  if (!/^\d{1,15}$/.test(raw)) throw new Error(`${label} 금액을 숫자로 입력해 주세요.`);
  return BigInt(raw);
}

/**
 * 퍼센트 문자열("5.5")을 Decimal 컬럼용 소수 문자열("0.055")로 바꾼다.
 *
 * 소수점을 두 칸 옮기는 계산을 문자열로 한다. Number 로 나누면 5.5/100 처럼
 * 이진 부동소수 오차가 그대로 Decimal 컬럼에 들어간다(0.055000000000000006).
 */
export function percentToDecimalString(raw: string): string {
  const [intPart, fracPart = ''] = raw.split('.');
  const digits = `${intPart}${fracPart}`;
  const pointFromRight = fracPart.length + 2;
  const padded = digits.padStart(pointFromRight + 1, '0');
  const cut = padded.length - pointFromRight;
  const joined = `${padded.slice(0, cut)}.${padded.slice(cut)}`;
  // 뒤쪽 0 과 남은 소수점을 정리한다. ("1.00" -> "1", "0.055" -> 그대로)
  return joined.replace(/0+$/, '').replace(/\.$/, '') || '0';
}

/**
 * 요율을 **퍼센트로** 입력받는다. (예: 5.5 = 5.5%)
 *
 * 운영에서 쓰는 단위가 퍼센트인데 소수(0.055)로 입력받으면 자릿수를 한 칸 잘못 찍기 쉽다.
 * 0.55 를 0.055 로 착각하면 요율이 10배가 되고, 그대로 정산이 나간다.
 *
 * 저장은 기존과 같이 소수 문자열로 한다. Decimal(10,6) 이므로 퍼센트 소수점은 4자리까지.
 */
export function percentRate(fd: FormData, key: string, label: string): string {
  const raw = text(fd, key).replace(/[\s%,]/g, '');
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(raw)) {
    throw new Error(`${label} 수수료율은 퍼센트로 입력해 주세요. (예: 5.5 = 5.5%, 소수점 4자리까지)`);
  }
  const n = Number(raw);
  if (!(n >= 0 && n <= 100)) throw new Error(`${label} 수수료율은 0 ~ 100% 사이여야 합니다.`);
  return percentToDecimalString(raw);
}

export function enumValue<T extends string>(fd: FormData, key: string, allowed: readonly T[], label: string): T {
  const v = text(fd, key) as T;
  if (!allowed.includes(v)) throw new Error(`${label} 값이 올바르지 않습니다.`);
  return v;
}

export function requiredId(fd: FormData, key: string, label: string): string {
  const v = text(fd, key);
  if (!v) throw new Error(`${label}을(를) 찾을 수 없습니다.`);
  return v;
}

/** 날짜 입력(YYYY-MM-DD 또는 datetime-local). 빈 값이면 null */
export function optDate(fd: FormData, key: string, label: string): Date | null {
  const raw = text(fd, key);
  if (raw === '') return null;
  const d = new Date(raw.length === 10 ? `${raw}T00:00:00+09:00` : raw);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} 날짜 형식이 올바르지 않습니다.`);
  return d;
}
