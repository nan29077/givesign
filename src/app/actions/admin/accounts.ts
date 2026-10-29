'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { notifyUser } from '@/server/services/notifications';
import { newId, newMerchantCode } from '@/lib/id';
import { env } from '@/lib/env';
import type { AdminActionState } from '@/components/admin/state';
import { issueTemporaryPassword } from '@/server/services/password-reset';
import { run, text, optText, money, optMoney, enumValue, requiredId, assertMoneyAdmin } from './shared';

/**
 * 회원 / 후원자 / 사회복지기관 / 코드 / 관리자 권한 관련 서버 액션.
 * 모든 변경은 writeAudit 으로 변경 전/후 값을 남긴다.
 */

// =========================================================== 회원 상태

export async function updateUserStatus(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 회원 정지·탈퇴는 그 사람의 결제·정산 접근을 통째로 끊는 조치다.
    // 되돌리더라도 그 사이의 결제 시도는 이미 막힌 뒤라, 고객 응대(SUPPORT) 권한으로는 막는다.
    assertMoneyAdmin(admin, '회원 상태 변경은 최고관리자·운영·재무 권한에서만 가능합니다.');
    const userId = requiredId(fd, 'userId', '회원');
    const status = enumValue(fd, 'status', ['ACTIVE', 'SUSPENDED', 'WITHDRAWN'] as const, '회원 상태');

    const before = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true, role: true },
    });
    if (!before) throw new Error('회원을 찾을 수 없습니다.');
    if (before.id === admin.id) throw new Error('본인 계정의 상태는 변경할 수 없습니다.');
    // 관리자 계정의 상태 변경은 SUPER_ADMIN 만 할 수 있다.
    // 막지 않으면 하위 등급 관리자가 최고관리자를 전부 정지시킬 수 있고,
    // 등급 복구 액션이 SUPER_ADMIN 전용이라 DB 를 직접 고치기 전에는 되돌릴 수 없다.
    if (before.role === 'ADMIN' && admin.adminPermission !== 'SUPER_ADMIN') {
      throw new Error('관리자 계정의 상태 변경은 SUPER_ADMIN 만 수행할 수 있습니다.');
    }
    if (before.status === status) throw new Error('이미 해당 상태입니다.');
    // 마지막으로 쓸 수 있는 최고관리자를 정지시키면 아무도 권한을 되돌릴 수 없다.
    // 등급 강등과 같은 기준으로 막는다.
    if (before.role === 'ADMIN' && status !== 'ACTIVE') {
      const superLeft = await prisma.adminProfile.count({
        where: { permission: 'SUPER_ADMIN', user: { status: 'ACTIVE' }, userId: { not: userId } },
      });
      const target = await prisma.adminProfile.findUnique({
        where: { userId },
        select: { permission: true },
      });
      if (target?.permission === 'SUPER_ADMIN' && superLeft === 0) {
        throw new Error('마지막으로 사용 가능한 SUPER_ADMIN 계정은 정지·탈퇴 처리할 수 없습니다.');
      }
    }

    await prisma.user.update({ where: { id: userId }, data: { status } });
    if (status !== 'ACTIVE') {
      // 상태가 내려가면 활성 세션을 즉시 만료시킨다.
      await prisma.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await writeAudit({
      adminUserId: admin.id,
      action: 'USER_STATUS_UPDATE',
      targetType: 'User',
      targetId: userId,
      before: { status: before.status },
      after: { status },
    });
    revalidatePath('/admin/users');
    return `${before.email ?? userId} 회원 상태를 변경했습니다.`;
  });
}

/**
 * 임시 비밀번호 발급.
 *
 * 고객센터 경로로 **본인 확인을 마친 뒤에만** 사용한다. 발급 즉시 기존 비밀번호는
 * 사용할 수 없게 되고, 해당 계정의 모든 세션이 끊기며, 살아 있던 재설정 링크도 무효가 된다.
 *
 * 발급된 비밀번호는 이 응답에서 **한 번만** 볼 수 있다(해시만 저장한다).
 * 감사 로그에도 비밀번호 원문은 남기지 않는다.
 */
export async function issueTemporaryPasswordAction(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission === 'READ_ONLY') throw new Error('읽기 전용 권한입니다.');
    // 임시 비밀번호는 그 계정으로 그대로 로그인할 수 있는 값이다(응답에 원문이 1회 노출된다).
    // 상담 등급까지 열어 두면 사회복지기관 계정을 탈취해 정산 요청·API 키 발급까지 할 수 있다.
    assertMoneyAdmin(admin, '임시 비밀번호 발급은 운영/재무 권한에서만 가능합니다.');
    const userId = requiredId(fd, 'userId', '회원');

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true, deletedAt: true, role: true },
    });
    if (!target) throw new Error('회원을 찾을 수 없습니다.');
    if (target.deletedAt || target.status !== 'ACTIVE') {
      throw new Error('활성 상태의 계정에만 임시 비밀번호를 발급할 수 있습니다.');
    }
    if (target.id === admin.id) {
      throw new Error('본인 계정에는 임시 비밀번호를 발급할 수 없습니다.');
    }
    // 관리자 계정 비밀번호 초기화는 최고관리자만 할 수 있게 한다(권한 상승 경로 차단).
    if (target.role === 'ADMIN' && admin.adminPermission !== 'SUPER_ADMIN') {
      throw new Error('관리자 계정의 임시 비밀번호 발급은 SUPER_ADMIN 만 수행할 수 있습니다.');
    }

    const { password } = await issueTemporaryPassword(userId);

    await writeAudit({
      adminUserId: admin.id,
      action: 'USER_TEMP_PASSWORD_ISSUE',
      targetType: 'User',
      targetId: userId,
      after: { email: target.email, sessionsRevoked: true },
    });
    revalidatePath('/admin/users');
    return {
      message: `${target.email ?? userId} 계정의 임시 비밀번호를 발급했습니다. 이 값은 지금 화면에서만 확인할 수 있습니다.`,
      detail: { tempPassword: password },
    };
  });
}

// =========================================================== 후원자

export async function unlockPayer(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const payerId = requiredId(fd, 'payerId', '후원자');
    const before = await prisma.payerProfile.findUnique({
      where: { id: payerId },
      select: { id: true, phoneMasked: true, failCount: true, lockedUntil: true },
    });
    if (!before) throw new Error('후원자를 찾을 수 없습니다.');

    await prisma.payerProfile.update({
      where: { id: payerId },
      data: { lockedUntil: null, failCount: 0 },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'PAYER_UNLOCK',
      targetType: 'PayerProfile',
      targetId: payerId,
      before: { lockedUntil: before.lockedUntil, failCount: before.failCount },
      after: { lockedUntil: null, failCount: 0 },
    });
    revalidatePath('/admin/payers');
    revalidatePath(`/admin/payers/${payerId}`);
    return `${before.phoneMasked} 후원자의 결제 실패 잠금을 해제했습니다.`;
  });
}

export async function setPayerBlock(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const payerId = requiredId(fd, 'payerId', '후원자');
    const next = enumValue(fd, 'next', ['BLOCK', 'UNBLOCK'] as const, '처리 구분');
    const reason = optText(fd, 'reason');
    if (next === 'BLOCK' && (!reason || reason.length < 2)) {
      throw new Error('이용 제한 사유를 2자 이상 입력해 주세요.');
    }

    const before = await prisma.payerProfile.findUnique({
      where: { id: payerId },
      select: { id: true, phoneMasked: true, blockedAt: true, blockedReason: true },
    });
    if (!before) throw new Error('후원자를 찾을 수 없습니다.');

    const after =
      next === 'BLOCK'
        ? { blockedAt: new Date(), blockedReason: reason }
        : { blockedAt: null, blockedReason: null };

    await prisma.payerProfile.update({ where: { id: payerId }, data: after });
    await writeAudit({
      adminUserId: admin.id,
      action: next === 'BLOCK' ? 'PAYER_BLOCK' : 'PAYER_UNBLOCK',
      targetType: 'PayerProfile',
      targetId: payerId,
      before: { blockedAt: before.blockedAt, blockedReason: before.blockedReason },
      after,
    });
    revalidatePath('/admin/payers');
    revalidatePath(`/admin/payers/${payerId}`);
    return next === 'BLOCK'
      ? `${before.phoneMasked} 후원자의 이용을 제한했습니다.`
      : `${before.phoneMasked} 후원자의 이용 제한을 해제했습니다.`;
  });
}

/** 관리자가 손으로 올릴 수 있는 개인 한도 상한. 이상거래 방어선의 마지막 단이라 무한대로 두지 않는다. */
const PAYER_LIMIT_MAX = 10_000_000n;

export async function updatePayerLimitsByAdmin(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 한도는 이상거래 방어선이다. 다른 금전 액션과 같은 기준으로 상담 등급을 막는다.
    assertMoneyAdmin(admin, '후원자 한도 변경은 운영/재무 권한에서만 가능합니다.');
    const payerId = requiredId(fd, 'payerId', '후원자');
    const dailyLimit = optMoney(fd, 'dailyLimit', '일일 한도');
    const monthlyLimit = optMoney(fd, 'monthlyLimit', '월간 한도');
    if (dailyLimit !== null && dailyLimit > PAYER_LIMIT_MAX) {
      throw new Error(`일일 한도는 ${PAYER_LIMIT_MAX.toLocaleString('ko-KR')}원을 넘을 수 없습니다.`);
    }
    if (monthlyLimit !== null && monthlyLimit > PAYER_LIMIT_MAX) {
      throw new Error(`월간 한도는 ${PAYER_LIMIT_MAX.toLocaleString('ko-KR')}원을 넘을 수 없습니다.`);
    }
    if (dailyLimit !== null && monthlyLimit !== null && dailyLimit > monthlyLimit) {
      throw new Error('일일 한도는 월간 한도보다 클 수 없습니다.');
    }

    const before = await prisma.payerProfile.findUnique({
      where: { id: payerId },
      select: { id: true, phoneMasked: true, dailyLimit: true, monthlyLimit: true },
    });
    if (!before) throw new Error('후원자를 찾을 수 없습니다.');

    await prisma.payerProfile.update({ where: { id: payerId }, data: { dailyLimit, monthlyLimit } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'PAYER_LIMIT_UPDATE',
      targetType: 'PayerProfile',
      targetId: payerId,
      before: { dailyLimit: before.dailyLimit, monthlyLimit: before.monthlyLimit },
      after: { dailyLimit, monthlyLimit },
    });
    revalidatePath('/admin/payers');
    revalidatePath(`/admin/payers/${payerId}`);
    return `${before.phoneMasked} 후원자의 개인 한도를 저장했습니다.`;
  });
}

// =========================================================== 사회복지기관 심사

export async function updateMerchantStatus(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 사회복지기관 심사는 실제 소비자 결제를 받을 수 있게 하는 KYC 게이트다.
    // 상담 등급이 통과시킬 수 있으면 자기 명의 사회복지기관을 스스로 승인할 수 있다.
    assertMoneyAdmin(admin, '사회복지기관 심사는 운영/재무 권한에서만 가능합니다.');
    const merchantId = requiredId(fd, 'merchantId', '사회복지기관');
    const status = enumValue(fd, 'status', ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] as const, '심사 상태');

    const before = await prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { id: true, userId: true, displayName: true, status: true, approvedAt: true, suspendedAt: true },
    });
    if (before && before.status === status) throw new Error('이미 같은 심사 상태입니다.');
    if (!before) throw new Error('사회복지기관을 찾을 수 없습니다.');

    const now = new Date();
    const data =
      status === 'APPROVED'
        ? { status, approvedAt: before.approvedAt ?? now, suspendedAt: null }
        : status === 'SUSPENDED'
          ? { status, suspendedAt: now }
          : { status };

    await prisma.merchantProfile.update({ where: { id: merchantId }, data });

    // 감사로그를 먼저 남긴다.
    // 알림 저장이 실패하면 예외가 밖으로 나가는데, 그 사이에 두면
    // 사회복지기관 승인/정지라는 KYC 게이트 변경이 기록 없이 반영된다.
    await writeAudit({
      adminUserId: admin.id,
      action: 'MERCHANT_STATUS_UPDATE',
      targetType: 'MerchantProfile',
      targetId: merchantId,
      before: { status: before.status, approvedAt: before.approvedAt, suspendedAt: before.suspendedAt },
      after: data,
    });

    // 알림은 실패해도 상태 변경을 되돌리지 않는다(부가 통지).
    await notifyUser({
      userId: before.userId,
      title: status === 'APPROVED' ? '사회복지기관 승인이 완료되었습니다' : '사회복지기관 심사 상태가 변경되었습니다',
      body:
        status === 'APPROVED'
          ? '이제 사회복지기관 관리자에서 문자후원와 정산 정보를 설정할 수 있습니다.'
          : `${before.displayName} 사회복지기관의 심사 상태가 ${status}(으)로 변경되었습니다.`,
      linkUrl: '/studio',
    }).catch(() => undefined);
    revalidatePath('/admin/merchants');
    revalidatePath(`/admin/merchants/${merchantId}`);
    return status === 'APPROVED'
      ? `${before.displayName} 사회복지기관을 승인했습니다. MO 번호 배정을 이어서 진행해 주세요.`
      : `${before.displayName} 사회복지기관의 심사 상태를 변경했습니다.`;
  });
}

export async function updateMerchantPaymentMode(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // MO 번호 배정과 같은 파괴력(결제 경로 자체를 바꾼다)이라 같은 기준으로 막는다.
    assertMoneyAdmin(admin, '결제 모드 변경은 운영/재무 권한에서만 가능합니다.');
    const merchantId = requiredId(fd, 'merchantId', '사회복지기관');
    const raw = text(fd, 'paymentMode');
    if (!['', 'CONFIRM_LINK', 'DIRECT_TRIGGER'].includes(raw)) throw new Error('결제 모드 값이 올바르지 않습니다.');
    const paymentMode = raw === '' ? null : (raw as 'CONFIRM_LINK' | 'DIRECT_TRIGGER');

    if (paymentMode === 'DIRECT_TRIGGER' && !env.safety.allowDirectTrigger) {
      throw new Error('금융사 서면승인이 등록되지 않아 즉시형 결제를 활성화할 수 없습니다.');
    }

    const before = await prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { id: true, displayName: true, paymentMode: true },
    });
    if (!before) throw new Error('사회복지기관을 찾을 수 없습니다.');

    await prisma.merchantProfile.update({ where: { id: merchantId }, data: { paymentMode } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'MERCHANT_PAYMENT_MODE_UPDATE',
      targetType: 'MerchantProfile',
      targetId: merchantId,
      before: { paymentMode: before.paymentMode },
      after: { paymentMode, allowDirectTrigger: env.safety.allowDirectTrigger },
    });
    revalidatePath(`/admin/merchants/${merchantId}`);
    return `${before.displayName} 님의 결제 모드를 ${paymentMode ?? '전역 설정'} 으로 변경했습니다.`;
  });
}


// =========================================================== 사회복지기관 1건 결제 금액 허용 범위

/**
 * 사회복지기관 1명의 후원 금액 허용 범위(최소/최대)를 변경한다.
 * 범위를 벗어난 후원 항목은 결제 시 AMOUNT_RANGE 로 전부 실패하므로 자동으로 비활성화한다.
 * 상품을 지우거나 금액을 임의로 바꾸지는 않는다(사회복지기관이 정한 가격이므로 판단을 대신하지 않는다).
 */
export async function updateMerchantAmountBounds(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '결제 금액 범위 변경은 운영/재무 권한에서만 가능합니다.');
    const merchantId = requiredId(fd, 'merchantId', '사회복지기관');
    const minAmount = money(fd, 'minAmount', '1건 최소 결제 금액', { min: 100n });
    const maxAmount = money(fd, 'maxAmount', '1건 최대 결제 금액', { min: 100n });
    if (minAmount > maxAmount) throw new Error('최소 금액이 최대 금액보다 클 수 없습니다.');

    const before = await prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { id: true, displayName: true, minAmount: true, maxAmount: true },
    });
    if (!before) throw new Error('사회복지기관을 찾을 수 없습니다.');

    await prisma.merchantProfile.update({
      where: { id: merchantId },
      data: { minAmount, maxAmount },
    });
    const deactivated = await prisma.chargeProduct.updateMany({
      where: {
        merchantId,
        active: true,
        archivedAt: null,
        OR: [{ amount: { lt: minAmount } }, { amount: { gt: maxAmount } }],
      },
      data: { active: false },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'MERCHANT_AMOUNT_BOUNDS_UPDATE',
      targetType: 'MerchantProfile',
      targetId: merchantId,
      before: { minAmount: before.minAmount, maxAmount: before.maxAmount },
      after: { minAmount, maxAmount, deactivatedProducts: deactivated.count },
    });
    revalidatePath(`/admin/merchants/${merchantId}`);
    revalidatePath('/admin/merchants');
    return deactivated.count > 0
      ? `${before.displayName} 님의 후원 금액 허용 범위를 변경했고, 범위를 벗어난 후원 항목 ${deactivated.count}개를 비활성화했습니다.`
      : `${before.displayName} 님의 후원 금액 허용 범위를 변경했습니다.`;
  });
}

/**
 * 모든 사회복지기관의 후원 금액 허용 범위를 공통으로 일괄 적용한다.
 * 범위를 벗어난 후원 항목은 비활성화한다(금액은 바꾸지 않는다).
 */
export async function applyGlobalAmountBounds(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 버튼 한 번으로 전 사회복지기관의 결제 상한이 바뀌고 범위 밖 상품이 전부 꺼진다(매출이 즉시 멈춘다).
    assertMoneyAdmin(admin, '전체 사회복지기관 금액 범위 일괄 적용은 운영/재무 권한에서만 가능합니다.');
    const minAmount = money(fd, 'minAmount', '1건 최소 결제 금액', { min: 100n });
    const maxAmount = money(fd, 'maxAmount', '1건 최대 결제 금액', { min: 100n });
    if (minAmount > maxAmount) throw new Error('최소 금액이 최대 금액보다 클 수 없습니다.');

    const result = await prisma.$transaction(async (tx) => {
      const total = await tx.merchantProfile.count();
      // 되돌릴 수 있어야 한다. updateMany 는 이전 값을 남기지 않으므로 먼저 스냅샷을 뜬다.
      const before = await tx.merchantProfile.findMany({
        select: { id: true, code: true, minAmount: true, maxAmount: true },
        orderBy: { createdAt: 'asc' },
        take: 500,
      });
      await tx.merchantProfile.updateMany({ data: { minAmount, maxAmount } });
      const off = await tx.chargeProduct.updateMany({
        where: {
          active: true,
          archivedAt: null,
          OR: [{ amount: { lt: minAmount } }, { amount: { gt: maxAmount } }],
        },
        data: { active: false },
      });
      return { total, clamped: off.count, before };
    });

    await writeAudit({
      adminUserId: admin.id,
      action: 'MERCHANT_AMOUNT_BOUNDS_APPLY_ALL',
      targetType: 'MerchantProfile',
      targetId: 'ALL',
      before: {
        merchants: result.before.map((m) => ({
          code: m.code,
          minAmount: m.minAmount.toString(),
          maxAmount: m.maxAmount.toString(),
        })),
        truncated: result.total > result.before.length,
      },
      after: { minAmount, maxAmount, appliedTo: result.total, deactivatedProducts: result.clamped },
    });
    revalidatePath('/admin/merchants');
    revalidatePath('/studio/settings');
    return `사회복지기관 ${result.total}명 전체에 후원 금액 허용 범위 ${minAmount.toString()}원 ~ ${maxAmount.toString()}원을 적용했습니다.` +
      (result.clamped > 0 ? ` 범위를 벗어난 후원 항목 ${result.clamped}개를 비활성화했습니다.` : '');
  });
}

// =========================================================== 정산 계좌 실명확인

/**
 * 정산 계좌 실명확인 처리.
 *
 * 예금주 실명확인 API 가 아직 연동 전이라, 통합 관리자가 증빙(사업자등록증·통장사본 등)을
 * 확인한 뒤 수동으로 인증 상태를 전환한다. 인증되지 않은 계좌로는 정산을 요청할 수 없다.
 * 계좌를 변경하면 저장 시점에 verified 가 다시 false 로 내려가므로 재확인이 필요하다.
 */
export async function setSettlementAccountVerified(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '정산 계좌 실명확인은 재무/운영 권한에서만 가능합니다.');
    const merchantId = requiredId(fd, 'merchantId', '사회복지기관');
    const verified = text(fd, 'verified') === 'true';

    const before = await prisma.settlementAccount.findUnique({
      where: { merchantId },
      select: { id: true, verified: true, verifiedAt: true, bankName: true, accountTail4: true, holderMasked: true },
    });
    if (!before) throw new Error('등록된 정산 계좌가 없습니다. 사회복지기관이 계좌를 먼저 등록해야 합니다.');
    if (before.verified === verified) {
      throw new Error(verified ? '이미 인증된 계좌입니다.' : '이미 미인증 상태입니다.');
    }

    const verifiedAt = verified ? new Date() : null;
    await prisma.settlementAccount.update({
      where: { merchantId },
      data: { verified, verifiedAt },
    });

    await writeAudit({
      adminUserId: admin.id,
      action: verified ? 'SETTLEMENT_ACCOUNT_VERIFY' : 'SETTLEMENT_ACCOUNT_UNVERIFY',
      targetType: 'SettlementAccount',
      targetId: before.id,
      before: { verified: before.verified, verifiedAt: before.verifiedAt },
      after: {
        verified,
        verifiedAt,
        bankName: before.bankName,
        accountTail4: before.accountTail4,
        holderMasked: before.holderMasked,
      },
    });

    revalidatePath(`/admin/merchants/${merchantId}`);
    revalidatePath('/admin/settlements');
    revalidatePath('/studio/settlement');
    return verified
      ? '정산 계좌를 실명확인 완료로 처리했습니다. 이제 사회복지기관이 정산을 요청할 수 있습니다.'
      : '정산 계좌 인증을 해제했습니다. 재확인 전까지 정산 요청이 차단됩니다.';
  });
}

// =========================================================== 사회복지기관 코드

async function generateUniqueCode(): Promise<string> {
  for (let i = 0; i < 30; i += 1) {
    const candidate = newMerchantCode();
    const [dupCode, dupProfile] = await Promise.all([
      prisma.merchantCode.findUnique({ where: { code: candidate }, select: { id: true } }),
      prisma.merchantProfile.findUnique({ where: { code: candidate }, select: { id: true } }),
    ]);
    if (!dupCode && !dupProfile) return candidate;
  }
  throw new Error('사용 가능한 코드를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.');
}

export async function reissueMerchantCode(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 결제 링크(/c/코드)가 즉시 무효화된다. 안내문·배너에 박힌 링크가 전부 죽는다.
    assertMoneyAdmin(admin, '사회복지기관 코드 재발급은 운영/재무 권한에서만 가능합니다.');
    const merchantId = requiredId(fd, 'merchantId', '사회복지기관');
    const before = await prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { id: true, displayName: true, code: true },
    });
    if (!before) throw new Error('사회복지기관을 찾을 수 없습니다.');

    const nextCode = await generateUniqueCode();
    const now = new Date();

    await prisma.$transaction([
      prisma.merchantCode.updateMany({
        where: { merchantId, active: true },
        data: { active: false, revokedAt: now },
      }),
      prisma.merchantCode.create({
        data: { id: newId(), merchantId, code: nextCode, active: true, issuedAt: now },
      }),
      prisma.merchantProfile.update({ where: { id: merchantId }, data: { code: nextCode } }),
    ]);

    await writeAudit({
      adminUserId: admin.id,
      action: 'MERCHANT_CODE_REISSUE',
      targetType: 'MerchantProfile',
      targetId: merchantId,
      before: { code: before.code },
      after: { code: nextCode },
    });
    revalidatePath('/admin/codes');
    revalidatePath(`/admin/merchants/${merchantId}`);
    return `${before.displayName} 님의 코드를 ${nextCode} 로 재발급했습니다. 기존 링크(/c/${before.code})는 더 이상 동작하지 않습니다.`;
  });
}

// =========================================================== 관리자 권한

export async function updateAdminPermission(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission !== 'SUPER_ADMIN') {
      throw new Error('관리자 권한 변경은 SUPER_ADMIN 만 수행할 수 있습니다.');
    }
    const profileId = requiredId(fd, 'profileId', '관리자');
    const permission = enumValue(
      fd,
      'permission',
      ['SUPER_ADMIN', 'OPERATION', 'FINANCE', 'SUPPORT', 'READ_ONLY'] as const,
      '권한',
    );

    const before = await prisma.adminProfile.findUnique({
      where: { id: profileId },
      select: { id: true, permission: true, userId: true, user: { select: { email: true } } },
    });
    if (!before) throw new Error('관리자를 찾을 수 없습니다.');
    if (before.userId === admin.id && permission !== before.permission) {
      throw new Error('본인의 권한은 변경할 수 없습니다. 다른 SUPER_ADMIN 에게 요청해 주세요.');
    }
    if (before.permission === permission) throw new Error('이미 해당 권한입니다.');

    if (before.permission === 'SUPER_ADMIN' && permission !== 'SUPER_ADMIN') {
      // **쓸 수 있는** SUPER_ADMIN 만 센다. 정지·탈퇴된 계정까지 세면
      // "정지된 SUPER_ADMIN 한 명 + 활성 한 명" 일 때 활성 쪽을 강등할 수 있고,
      // 그 순간 권한을 되돌릴 사람이 아무도 없어 DB 를 직접 고쳐야 한다.
      const superCount = await prisma.adminProfile.count({
        where: { permission: 'SUPER_ADMIN', user: { status: 'ACTIVE' } },
      });
      if (superCount <= 1) throw new Error('마지막으로 사용 가능한 SUPER_ADMIN 의 권한은 강등할 수 없습니다.');
    }

    await prisma.adminProfile.update({ where: { id: profileId }, data: { permission } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'ADMIN_PERMISSION_UPDATE',
      targetType: 'AdminProfile',
      targetId: profileId,
      before: { permission: before.permission },
      after: { permission },
    });
    revalidatePath('/admin/admins');
    return `${before.user.email ?? profileId} 의 권한을 ${permission} 으로 변경했습니다.`;
  });
}

// =========================================================== 관리자 추가 (기존 계정 승격)

export async function createAdminByEmail(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission !== 'SUPER_ADMIN') {
      throw new Error('관리자 추가는 SUPER_ADMIN 만 수행할 수 있습니다.');
    }
    const email = text(fd, 'email').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('이메일 형식을 확인해 주세요.');
    const permission = enumValue(
      fd,
      'permission',
      ['SUPER_ADMIN', 'OPERATION', 'FINANCE', 'SUPPORT', 'READ_ONLY'] as const,
      '권한',
    );

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true, status: true, adminProfile: { select: { id: true } } },
    });
    if (!user) throw new Error('해당 이메일로 가입된 계정이 없습니다. 먼저 일반 회원가입을 완료해 주세요.');
    if (user.adminProfile) throw new Error('이미 관리자로 등록된 계정입니다.');
    if (user.role === 'MERCHANT') {
      throw new Error('사회복지기관 계정은 관리자를 겸할 수 없습니다. 별도 계정으로 등록해 주세요.');
    }
    if (user.status !== 'ACTIVE') throw new Error('활성 상태의 계정만 관리자로 등록할 수 있습니다.');

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } }),
      prisma.adminProfile.create({ data: { id: newId(), userId: user.id, permission } }),
    ]);

    await writeAudit({
      adminUserId: admin.id,
      action: 'ADMIN_CREATE',
      targetType: 'User',
      targetId: user.id,
      before: { role: user.role },
      after: { role: 'ADMIN', permission },
    });
    revalidatePath('/admin/admins');
    revalidatePath('/admin/users');
    return `${email} 계정을 ${permission} 권한의 관리자로 등록했습니다.`;
  });
}
