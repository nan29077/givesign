import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { generateToken, hmac, phoneHash, sha256 } from '@/lib/crypto';
import { contractIntegrations, env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getIdentityAdapter } from '@/server/adapters/identity';

/**
 * 본인인증 서비스 (2026-11-13 5차 L1). 쓰는 곳은 모두 `IDENTITY_REQUIRED_FOR_*` 플래그(기본 꺼짐)로만 켠다 —
 * 꺼져 있으면 이 파일의 확인 함수는 DB 를 읽지 않고 통과한다(지금 동작 그대로).
 *
 *  - RECEIPT   기부금영수증 정보 등록: 인증한 이름 = 입력한 성명, 인증한 생년월일 = 주민번호 앞자리·성별 자리
 *  - ESIGN     전자서명 서명자 확인: 문자 인증에 더해, 서명자 번호로 본인인증(이름 일치 여부는 기록)
 *  - RECURRING 정기후원 해지·변경: 휴대폰 재확인(2차 F)에 **더해** 그 번호 본인인증
 *
 * 결과 원문(이름·생년월일·CI)은 저장하지 않는다. HMAC(phoneHashSecret, 영역 접두어)만 둔다.
 * 인증은 휴대폰 해시와 묶인다 — 같은 번호의 후원자·서명자 확인에만 쓰고, 정해진 시간(VALID_SEC) 안에만 유효하다.
 */

export type IdentityPurpose = 'RECEIPT' | 'ESIGN' | 'RECURRING';
export const IDENTITY_PURPOSES: IdentityPurpose[] = ['RECEIPT', 'ESIGN', 'RECURRING'];

export const IDENTITY_PURPOSE_LABEL: Record<IdentityPurpose, string> = {
  RECEIPT: '기부금영수증 정보 등록',
  ESIGN: '전자서명 서명자 확인',
  RECURRING: '정기후원 해지·변경',
};

/** 인증 뒤 이 시간 안에 그 일을 마쳐야 한다(초) */
export const IDENTITY_VALID_SEC: Record<IdentityPurpose, number> = { RECEIPT: 600, ESIGN: 1800, RECURRING: 600 };
/** 인증창을 연 뒤 이 시간 안에 끝내야 한다(초) */
const REQUEST_TTL_SEC = 600;

export class IdentityRequiredError extends Error {
  constructor(public purpose: IdentityPurpose, message?: string) {
    super(message ?? `${IDENTITY_PURPOSE_LABEL[purpose]}에는 휴대폰 본인인증이 필요합니다. 본인인증을 먼저 해 주세요.`);
  }
}

export function identityRequired(purpose: IdentityPurpose): boolean {
  const r = contractIntegrations().identityRequired;
  return purpose === 'RECEIPT' ? r.receipt : purpose === 'ESIGN' ? r.esign : r.recurring;
}

const normName = (v: string) => (v ?? '').normalize('NFC').replace(/\s+/g, '');
export const identityNameHash = (name: string) => hmac(`identity:name:${normName(name)}`);
export const identityBirthHash = (yyyymmdd: string) => hmac(`identity:birth:${yyyymmdd}`);
export const identityCiHash = (ci: string) => hmac(`identity:ci:${ci}`);

/** 주민등록번호 13자리 → 생년월일 YYYYMMDD (성별 자리로 세기 판단). 형식이 아니면 null */
export function residentBirthDate(resident: string): string | null {
  const d = (resident ?? '').replace(/\D/g, '');
  if (d.length !== 13) return null;
  const g = d[6]!;
  const century = '1256'.includes(g) ? '19' : '3478'.includes(g) ? '20' : '90'.includes(g) ? '18' : null;
  return century ? `${century}${d.slice(0, 6)}` : null;
}

/** 인증창으로 갈 내부 경로만 받는다(열린 이동 방지) */
export function safeReturnPath(p: string | null | undefined): string {
  const v = (p ?? '').trim();
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  return v.slice(0, 500);
}

export function identityStartHref(purpose: IdentityPurpose, next: string): string {
  return `/identity/start?purpose=${purpose}&next=${encodeURIComponent(safeReturnPath(next))}`;
}

export function isIdentityPurpose(v: unknown): v is IdentityPurpose {
  return typeof v === 'string' && (IDENTITY_PURPOSES as string[]).includes(v);
}

/** 인증 시작 → 공급자 인증창 주소. 원문 토큰은 주소에만 있고 DB 에는 해시만 남는다. */
export async function startIdentityVerification(input: { purpose: IdentityPurpose; returnPath: string; now?: Date }): Promise<{ redirectUrl: string; mock: boolean }> {
  const now = input.now ?? new Date();
  const adapter = getIdentityAdapter();
  const requestToken = generateToken(24);
  const returnPath = safeReturnPath(input.returnPath);
  await prisma.identityVerification.create({
    data: {
      id: newId(),
      purpose: input.purpose,
      provider: adapter.info().provider,
      mock: adapter.info().mode === 'mock',
      requestTokenHash: sha256(requestToken),
      returnPath,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_SEC * 1000),
    },
  });
  const started = await adapter.start({ requestToken, returnUrl: `${env.baseUrl}/identity/return` });
  if (!started.ok || !started.data) throw new Error(started.message ?? '본인인증을 시작하지 못했습니다.');
  return { redirectUrl: started.data.redirectUrl, mock: adapter.info().mode === 'mock' };
}

export type IdentityCompleteResult = { ok: true; returnPath: string; mock: boolean } | { ok: false; returnPath: string | null; message: string };

/** 공급자 결과 반영. 같은 요청으로 두 번 와도 한 번만 반영된다(PENDING 조건부). */
export async function completeIdentityVerification(input: { requestToken: string; payload: Record<string, unknown>; now?: Date }): Promise<IdentityCompleteResult> {
  const now = input.now ?? new Date();
  const row = await prisma.identityVerification.findUnique({ where: { requestTokenHash: sha256(input.requestToken) } });
  if (!row) return { ok: false, returnPath: null, message: '본인인증 요청을 찾을 수 없습니다.' };
  if (row.status !== 'PENDING') return row.status === 'VERIFIED' ? { ok: true, returnPath: row.returnPath, mock: row.mock } : { ok: false, returnPath: row.returnPath, message: '이미 끝난 본인인증 요청입니다. 다시 시도해 주세요.' };
  if (row.expiresAt.getTime() < now.getTime()) {
    await prisma.identityVerification.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    return { ok: false, returnPath: row.returnPath, message: '본인인증 시간이 지났습니다. 다시 시도해 주세요.' };
  }
  const adapter = getIdentityAdapter();
  const res = await adapter.fetchResult({ requestToken: input.requestToken, payload: input.payload });
  if (!res.ok || !res.data) {
    await prisma.identityVerification.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'FAILED', failureReason: (res.message ?? '본인인증 실패').slice(0, 200) } });
    return { ok: false, returnPath: row.returnPath, message: res.message ?? '본인인증에 실패했습니다.' };
  }
  const d = res.data;
  await prisma.identityVerification.updateMany({
    where: { id: row.id, status: 'PENDING' },
    data: {
      status: 'VERIFIED',
      mock: d.mock,
      phoneHash: phoneHash(d.phone),
      nameHash: identityNameHash(d.name),
      birthHash: identityBirthHash(d.birthDate),
      ciHash: identityCiHash(d.ci),
      verifiedAt: now,
    },
  });
  logger.info('본인인증 완료', { purpose: row.purpose, provider: row.provider, mock: d.mock });
  return { ok: true, returnPath: row.returnPath, mock: d.mock };
}

/** 그 번호·목적의 유효한(시간 안) 최근 인증 */
export async function latestIdentity(purpose: IdentityPurpose, phoneHashValue: string, now = new Date()) {
  return prisma.identityVerification.findFirst({
    where: { purpose, phoneHash: phoneHashValue, status: 'VERIFIED', verifiedAt: { gte: new Date(now.getTime() - IDENTITY_VALID_SEC[purpose] * 1000) } },
    orderBy: { verifiedAt: 'desc' },
  });
}

/** 기부금영수증 정보 등록 확인: 꺼짐이면 통과. 켜짐이면 그 번호 인증 + 성명·생년월일 일치. */
export async function receiptIdentityCheck(payerPhoneHash: string, legalName: string, resident: string, now = new Date()): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!identityRequired('RECEIPT')) return { ok: true };
  const row = await latestIdentity('RECEIPT', payerPhoneHash, now);
  if (!row) return { ok: false, message: new IdentityRequiredError('RECEIPT').message };
  const birth = residentBirthDate(resident);
  if (row.nameHash !== identityNameHash(legalName)) return { ok: false, message: '본인인증한 이름과 입력한 성명이 다릅니다. 본인 명의로만 등록할 수 있습니다.' };
  if (!birth || row.birthHash !== identityBirthHash(birth)) return { ok: false, message: '본인인증한 생년월일과 주민등록번호가 다릅니다. 본인 번호로만 등록할 수 있습니다.' };
  return { ok: true };
}

/** 정기후원 해지·변경 확인: 꺼짐이면 통과. 켜짐이면 그 후원자 번호로 10분 안 본인인증. */
export async function assertIdentityForRecurring(payerId: string, now = new Date()): Promise<void> {
  if (!identityRequired('RECURRING')) return;
  const payer = await prisma.payerProfile.findUnique({ where: { id: payerId }, select: { phoneHash: true } });
  if (!payer || !(await latestIdentity('RECURRING', payer.phoneHash, now))) throw new IdentityRequiredError('RECURRING');
}

/** 전자서명 서명자 확인 결과(서명 트랜잭션에서 해시 체인 사건으로 남긴다). 꺼짐이면 null. 켜짐인데 없으면 IdentityRequiredError. */
export async function identityForSigner(signer: { phoneHash: string; name: string }, now = new Date()) {
  if (!identityRequired('ESIGN')) return null;
  const row = await latestIdentity('ESIGN', signer.phoneHash, now);
  if (!row) throw new IdentityRequiredError('ESIGN');
  return {
    verificationId: row.id,
    method: `휴대폰 본인인증(${row.provider})`,
    provider: row.provider,
    mock: row.mock,
    verifiedAt: row.verifiedAt!.toISOString(),
    ciHashPrefix: (row.ciHash ?? '').slice(0, 8),
    nameMatch: row.nameHash === identityNameHash(signer.name),
  };
}
