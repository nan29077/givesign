import { env } from '@/lib/env';
import { cookies, headers } from 'next/headers';
import bcrypt from 'bcryptjs';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { generateToken, tokenHash } from '@/lib/crypto';
import { addDays } from '@/lib/datetime';
import type { UserRole, MerchantStatus } from '@/generated/prisma/enums';
import { clientIpFrom } from '@/server/rate-limit';

/**
 * 세션 기반 인증.
 * - 세션 토큰 원문은 쿠키에만 존재하고 DB 에는 해시만 저장한다.
 * - 관리자 화면은 role + permission 을 함께 검사한다.
 */

export const SESSION_COOKIE = 'givesign_session';
const SESSION_DAYS = 14;

export interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  role: UserRole;
  avatarIndex: number;
  merchantId?: string;
  /** 사회복지기관 캐릭터를 DB 재생성 후에도 동일하게 유지하는 고정 코드 */
  merchantCode?: string;
  merchantAvatarUrl?: string | null;
  /** 사회복지기관 프로필 상태. APPROVED 가 아니면 스튜디오 기능을 쓸 수 없다. */
  merchantStatus?: MerchantStatus;
  adminPermission?: string;
}

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string | null) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export async function createSession(userId: string) {
  const token = generateToken(32);
  const h = await headers();
  await prisma.userSession.create({
    data: {
      id: newId(),
      userId,
      tokenHash: tokenHash(token),
      ip: clientIpFrom((name) => h.get(name)),
      userAgent: h.get('user-agent') ?? null,
      expiresAt: addDays(new Date(), SESSION_DAYS),
    },
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // 프로덕션 빌드를 http(사내망 IP 등)로 접근하는 미리보기에서 세션이 떨어지지 않도록
    // 실제 서비스 주소가 https 일 때만 Secure 속성을 붙인다.
    secure: process.env.NODE_ENV === 'production' && env.baseUrl.startsWith('https'),
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  return token;
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.userSession.updateMany({
      where: { tokenHash: tokenHash(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  jar.delete(SESSION_COOKIE);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.userSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: {
      user: { include: { merchantProfile: true, adminProfile: true } },
    },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  const u = session.user;
  if (u.status !== 'ACTIVE') return null;

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    avatarIndex: u.avatarIndex,
    merchantId: u.merchantProfile?.id,
    merchantCode: u.merchantProfile?.code,
    merchantAvatarUrl: u.merchantProfile?.avatarUrl,
    merchantStatus: u.merchantProfile?.status,
    adminPermission: u.adminProfile?.permission,
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error('로그인이 필요합니다.');
  return user;
}

export async function requireRole(role: UserRole): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== role) throw new Error('접근 권한이 없습니다.');
  return user;
}

/**
 * 사회복지기관 전용 화면/액션 가드.
 *
 * 프로필 존재만으로는 부족하다. 심사 대기(PENDING)·반려(REJECTED)·정지(SUSPENDED) 상태에서도
 * 스튜디오에 접근되면 미승인 채널이 결제를 받거나, 정지된 채널이 정산을 신청할 수 있다.
 * 정지 상태는 세션 자체를 무효화해 모든 탭에서 즉시 로그아웃시킨다.
 */
export async function requireMerchant(): Promise<SessionUser & { merchantId: string }> {
  const user = await requireUser();
  if (!user.merchantId) throw new Error('사회복지기관 권한이 필요합니다.');

  const status = user.merchantStatus;
  if (status !== 'APPROVED') {
    if (status === 'SUSPENDED') {
      await destroySession().catch(() => undefined);
      throw new Error('정지된 채널입니다. 고객센터로 문의해 주세요.');
    }
    if (status === 'REJECTED') throw new Error('채널 심사가 반려되었습니다. 고객센터로 문의해 주세요.');
    throw new Error('채널 승인 후 이용할 수 있습니다. 심사가 완료되면 알려드립니다.');
  }

  return user as SessionUser & { merchantId: string };
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== 'ADMIN') throw new Error('관리자 권한이 필요합니다.');
  return user;
}

/** 관리자 변경 감사로그 */
export async function writeAudit(input: {
  adminUserId?: string;
  /** 관리자가 아닌 행위자(기관 담당자·후원자). 비우면 현재 세션 사용자로 채운다. */
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
}) {
  const h = await headers();
  let adminProfileId: string | null = null;
  if (input.adminUserId) {
    const p = await prisma.adminProfile.findUnique({ where: { userId: input.adminUserId }, select: { id: true } });
    adminProfileId = p?.id ?? null;
  }
  // 행위자. 예전에는 관리자만 기록돼 기관·후원자의 행위(주민번호 명세 다운로드 등)가 "시스템"으로 남았다.
  let actorUserId: string | null = input.actorUserId ?? input.adminUserId ?? null;
  if (!actorUserId) actorUserId = (await getSessionUser().catch(() => null))?.id ?? null;
  const actor = actorUserId
    ? await prisma.user.findUnique({ where: { id: actorUserId }, select: { email: true, name: true, role: true } })
    : null;
  await prisma.adminAuditLog.create({
    data: {
      id: newId(),
      adminId: adminProfileId,
      actorUserId,
      actorLabel: actor ? (actor.email ?? actor.name ?? actorUserId) : null,
      actorRole: actor?.role ?? 'SYSTEM',
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      beforeValue: (input.before ?? null) as object,
      afterValue: (input.after ?? null) as object,
      ip: clientIpFrom((name) => h.get(name)),
      userAgent: h.get('user-agent') ?? null,
    },
  });
}
