import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env, isLocal } from '@/lib/env';
import { logger } from '@/lib/logger';
import { generateToken, randomCodeString, tokenHash } from '@/lib/crypto';
import { hashPassword } from '@/server/auth';

/**
 * 비밀번호 재설정.
 *
 * 절대 원칙
 *  1) 토큰 원문은 DB 에 남기지 않는다. 세션 토큰과 같은 규칙(tokenHash 만 저장)이다.
 *  2) 재설정에 성공하면 그 계정의 **모든 세션을 폐기한다.** 비밀번호를 바꾸는 상황은
 *     계정이 탈취됐을 가능성을 전제하므로, 공격자의 로그인 상태가 남아 있으면 안 된다.
 *  3) 요청 화면은 가입 여부를 알려 주지 않는다(계정 열거 방지). 존재하지 않는 이메일도
 *     같은 문구로 응답한다.
 *  4) 이메일 발송은 아직 연동 전이다. mock 임을 화면에 명시하고, 로컬에서만 링크를 노출한다.
 */

/** 재설정 링크 유효시간 */
const TTL_MS = 60 * 60 * 1000;

/** 임시 비밀번호 알파벳. 사람이 받아 적을 수 있도록 혼동 문자를 제외한다. */
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export interface ResetRequestResult {
  /** 요청 접수 여부. 가입 여부와 무관하게 항상 true 다(계정 열거 방지). */
  accepted: boolean;
  /**
   * 발급된 재설정 링크. **로컬(APP_ENV=local)에서만 채워진다.**
   * 이메일 연동 전까지 개발·검수용으로만 노출한다.
   */
  devLink?: string;
}

function resetLink(token: string): string {
  return `${env.baseUrl}/reset-password/${token}`;
}

/**
 * 재설정 링크 발급.
 *
 * 같은 계정의 기존 미사용 토큰은 즉시 만료시킨다(링크가 여러 장 살아 있지 않게).
 */
export async function requestPasswordReset(
  email: string,
  requestIp: string | null,
): Promise<ResetRequestResult> {
  const normalized = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: normalized },
    select: { id: true, status: true, deletedAt: true },
  });

  // 가입되지 않았거나 이용할 수 없는 계정이면 아무것도 만들지 않고 같은 응답을 돌려준다.
  if (!user || user.deletedAt || user.status !== 'ACTIVE') {
    logger.info('비밀번호 재설정 요청 - 대상 없음', { emailKnown: Boolean(user) });
    return { accepted: true };
  }

  const token = generateToken(32);
  const now = new Date();

  await prisma.$transaction([
    // 기존 미사용 토큰 폐기: 이미 지난 시각으로 만료시킨다.
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    }),
    prisma.passwordResetToken.create({
      data: {
        id: newId(),
        userId: user.id,
        tokenHash: tokenHash(token),
        requestIp,
        expiresAt: new Date(now.getTime() + TTL_MS),
      },
    }),
  ]);

  const link = resetLink(token);

  // 링크는 로컬에서만 밖으로 내보낸다.
  //
  // 예전에는 환경과 무관하게 logger.info 로 링크를 남겼다. 그 한 줄이면
  // 로그를 볼 수 있는 사람(운영자, 로그 수집 서비스, 컨테이너 stdout 을 읽는 사이드카)이
  // 관리자 계정을 포함한 아무 계정의 비밀번호를 1시간 안에 바꿀 수 있었다.
  // DB 에 해시만 저장한다는 위 원칙 1) 이 로그에서 무너지고 있었다.
  //
  // 로컬 확인용 출력은 logger 대신 console 을 쓴다.
  // logger 는 이제 메시지에 담긴 URL 도 가리므로 링크가 보이지 않기 때문이다.
  if (isLocal) {
    console.log(`[MOCK 메일] 비밀번호 재설정 링크: ${link}`);
  } else {
    logger.warn('비밀번호 재설정 링크를 발급했지만 메일 발송이 연동되지 않아 전달되지 않았습니다.', {
      userId: user.id,
    });
  }

  return { accepted: true, devLink: isLocal ? link : undefined };
}

export type ResetTokenState = 'VALID' | 'NOT_FOUND' | 'EXPIRED' | 'USED';

export interface LoadedResetToken {
  state: ResetTokenState;
  /** VALID 일 때만 채워진다. */
  userId?: string;
  emailMasked?: string;
}

function maskEmail(email: string | null): string {
  if (!email) return '-';
  const [name, domain] = email.split('@');
  if (!domain) return '***';
  const head = name!.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, name!.length - 2))}@${domain}`;
}

/** 토큰 유효성 확인(비밀번호를 바꾸지는 않는다). 재설정 화면 진입 시 사용한다. */
export async function loadResetToken(token: string): Promise<LoadedResetToken> {
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: tokenHash(token) },
    select: {
      userId: true,
      usedAt: true,
      expiresAt: true,
      user: { select: { email: true, status: true, deletedAt: true } },
    },
  });
  if (!row) return { state: 'NOT_FOUND' };
  if (row.usedAt) return { state: 'USED' };
  if (row.expiresAt.getTime() < Date.now()) return { state: 'EXPIRED' };
  if (row.user.deletedAt || row.user.status !== 'ACTIVE') return { state: 'NOT_FOUND' };
  return { state: 'VALID', userId: row.userId, emailMasked: maskEmail(row.user.email) };
}

export interface ConsumeResult {
  ok: boolean;
  state: ResetTokenState;
  message: string;
}

/**
 * 재설정 실행.
 *
 * 토큰 선점(usedAt 이 비어 있는 행을 updateMany 로 잡기)에 성공한 요청만 비밀번호를 바꾼다.
 * 같은 링크를 두 번 눌러도 두 번 바뀌지 않는다.
 */
export async function consumePasswordReset(
  token: string,
  newPassword: string,
  usedIp: string | null,
): Promise<ConsumeResult> {
  const hash = tokenHash(token);
  const loaded = await loadResetToken(token);
  if (loaded.state !== 'VALID' || !loaded.userId) {
    return {
      ok: false,
      state: loaded.state,
      message:
        loaded.state === 'EXPIRED'
          ? '재설정 링크가 만료되었습니다. 다시 요청해 주세요.'
          : loaded.state === 'USED'
            ? '이미 사용된 링크입니다. 다시 요청해 주세요.'
            : '유효하지 않은 링크입니다. 다시 요청해 주세요.',
    };
  }

  const claimed = await prisma.passwordResetToken.updateMany({
    where: { tokenHash: hash, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date(), usedIp },
  });
  if (claimed.count !== 1) {
    return { ok: false, state: 'USED', message: '이미 사용된 링크입니다. 다시 요청해 주세요.' };
  }

  await applyNewPassword(loaded.userId, newPassword);
  logger.info('비밀번호 재설정 완료', { userId: loaded.userId });
  return { ok: true, state: 'VALID', message: '비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.' };
}

/**
 * 비밀번호 교체 + 전 세션 폐기 + 남은 재설정 토큰 무효화.
 * 셀프 재설정과 관리자 임시 비밀번호 발급이 같은 경로를 쓴다.
 */
async function applyNewPassword(userId: string, plain: string): Promise<void> {
  const passwordHash = await hashPassword(plain);
  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    // 비밀번호가 바뀌면 기존 로그인 상태는 전부 끊는다.
    prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    }),
    // 아직 남아 있는 다른 재설정 링크도 함께 무효화한다.
    prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    }),
  ]);
}

export interface TemporaryPasswordResult {
  /** 발급된 임시 비밀번호. 이 시점 이후로는 어디에서도 다시 볼 수 없다. */
  password: string;
}

/**
 * 관리자 임시 비밀번호 발급.
 *
 * 고객센터 경로로 본인 확인을 마친 뒤에만 사용한다. 발급 즉시
 *  - 기존 비밀번호는 사용할 수 없고
 *  - 해당 계정의 모든 세션이 끊기며
 *  - 살아 있던 재설정 링크도 무효화된다.
 */
export async function issueTemporaryPassword(userId: string): Promise<TemporaryPasswordResult> {
  const password = `${randomCodeString(TEMP_ALPHABET, 10)}!`;
  await applyNewPassword(userId, password);
  return { password };
}

/** 만료된 재설정 토큰 정리 (정리 배치에서 호출한다). */
export async function purgeExpiredResetTokens(now = new Date()): Promise<number> {
  // 사용 이력은 감사 목적으로 잠시 남겨 두고, 충분히 지난 행만 지운다.
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const r = await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return r.count;
}
