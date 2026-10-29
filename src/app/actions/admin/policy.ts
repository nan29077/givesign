'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, optText, money, int, bool, enumValue, requiredId, optDate, assertMoneyAdmin } from './shared';
import { bannedNeedle } from '@/server/services/content-filter';

/**
 * 한도 정책 / 약관 버전 / 신고·금칙어 운영 액션.
 */

// =========================================================== 한도 정책

function readLimitFields(fd: FormData) {
  const defaultAmount = money(fd, 'defaultAmount', '기본 결제 금액', { min: 1n });
  const minAmount = money(fd, 'minAmount', '1회 최소', { min: 1n });
  const maxAmount = money(fd, 'maxAmount', '1회 최대', { min: 1n });
  const payerDailyLimit = money(fd, 'payerDailyLimit', '후원자 일 한도', { min: 1n });
  const payerMonthlyLimit = money(fd, 'payerMonthlyLimit', '후원자 월 한도', { min: 1n });
  const perMerchantDailyLimit = money(fd, 'perMerchantDailyLimit', '사회복지기관별 일 한도', { min: 1n });
  const newPayerFirstDayLimit = money(fd, 'newPayerFirstDayLimit', '신규 후원자 첫날 한도', { min: 1n });
  const manualReviewAmount = money(fd, 'manualReviewAmount', '수동 검수 기준', { min: 1n });

  const payerDailyMaxCount = int(fd, 'payerDailyMaxCount', { min: 1, max: 10000, label: '1인 1일 최대 건수' });
  const velocityWindowSec = int(fd, 'velocityWindowSec', { min: 1, max: 86400, label: '속도 제한 구간(초)' });
  const velocityMaxCount = int(fd, 'velocityMaxCount', { min: 1, max: 1000, label: '속도 제한 건수' });
  const cooldownAfterCount = int(fd, 'cooldownAfterCount', { min: 1, max: 1000, label: '연속 결제 기준 건수' });
  const cooldownSec = int(fd, 'cooldownSec', { min: 1, max: 86400, label: '연속 결제 대기(초)' });
  const failureLockThreshold = int(fd, 'failureLockThreshold', { min: 1, max: 50, label: '결제 실패 허용' });

  if (minAmount > maxAmount) throw new Error('1회 최소 금액이 최대 금액보다 클 수 없습니다.');
  if (defaultAmount < minAmount || defaultAmount > maxAmount) {
    throw new Error('기본 결제 금액은 1회 최소~최대 범위 안에 있어야 합니다.');
  }
  if (payerDailyLimit > payerMonthlyLimit) throw new Error('후원자 일 한도가 월 한도보다 클 수 없습니다.');
  if (newPayerFirstDayLimit > payerDailyLimit) throw new Error('신규 후원자 첫날 한도가 일 한도보다 클 수 없습니다.');

  return {
    defaultAmount, minAmount, maxAmount,
    payerDailyLimit, payerMonthlyLimit, perMerchantDailyLimit, payerDailyMaxCount,
    velocityWindowSec, velocityMaxCount, cooldownAfterCount, cooldownSec,
    failureLockThreshold, newPayerFirstDayLimit, manualReviewAmount,
  };
}

export async function saveLimitPolicy(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 한도 정책은 결제 금액·속도·잠금을 전부 정한다. 수수료 정책·정산 처리와 같은 기준으로 막는다.
    assertMoneyAdmin(admin, '한도 정책 변경은 운영/재무 권한에서만 가능합니다.');
    const id = optText(fd, 'id');
    const values = readLimitFields(fd);
    const active = bool(fd, 'active');
    const effectiveFrom = optDate(fd, 'effectiveFrom', '적용 시작일') ?? new Date();

    if (id) {
      const before = await prisma.chargeLimitPolicy.findUnique({ where: { id } });
      if (!before) throw new Error('한도 정책을 찾을 수 없습니다.');

      await prisma.chargeLimitPolicy.update({ where: { id }, data: { ...values, active, effectiveFrom } });
      await writeAudit({
        adminUserId: admin.id,
        action: 'LIMIT_POLICY_UPDATE',
        targetType: 'ChargeLimitPolicy',
        targetId: id,
        before: {
          scope: before.scope,
          defaultAmount: before.defaultAmount, minAmount: before.minAmount, maxAmount: before.maxAmount,
          payerDailyLimit: before.payerDailyLimit, payerMonthlyLimit: before.payerMonthlyLimit,
          perMerchantDailyLimit: before.perMerchantDailyLimit,
          payerDailyMaxCount: before.payerDailyMaxCount,
          velocityWindowSec: before.velocityWindowSec, velocityMaxCount: before.velocityMaxCount,
          cooldownAfterCount: before.cooldownAfterCount, cooldownSec: before.cooldownSec,
          failureLockThreshold: before.failureLockThreshold,
          newPayerFirstDayLimit: before.newPayerFirstDayLimit,
          manualReviewAmount: before.manualReviewAmount,
          active: before.active,
        },
        after: { ...values, active, effectiveFrom },
      });
      revalidatePath('/admin/policies');
      return '한도 정책을 저장했습니다.';
    }

    const scope = enumValue(fd, 'scope', ['GLOBAL', 'MERCHANT', 'PAYER'] as const, '적용 범위');
    const merchantId = scope === 'MERCHANT' ? requiredId(fd, 'merchantId', '사회복지기관') : null;
    const payerId = scope === 'PAYER' ? requiredId(fd, 'payerId', '후원자') : null;

    if (scope === 'GLOBAL' && active) {
      // 겹치는 기간만 막는다.
      //
      // 예전에는 "활성 전역 정책이 있으면" 무조건 거절했다. 그래서 시행일이 미래인 정책을
      // 등록하려면 현행 정책을 먼저 비활성화해야 했고, toggleLimitPolicy 가 effectiveTo 를
      // 즉시 박으므로 오늘~새 시행일 사이에 적용 가능한 전역 정책이 하나도 없는 구간이 생겼다.
      // 그 기간에는 코드 기본값(FALLBACK_POLICY)이 조용히 적용된다.
      const overlapping = await prisma.chargeLimitPolicy.count({
        where: {
          scope: 'GLOBAL',
          active: true,
          effectiveTo: null,
          effectiveFrom: { gte: effectiveFrom },
        },
      });
      if (overlapping > 0) {
        throw new Error('같은 날 또는 그 이후에 시행되는 전역 정책이 이미 있습니다. 그 정책을 먼저 마감해 주세요.');
      }
    }
    if (merchantId) {
      const merchant = await prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { id: true } });
      if (!merchant) throw new Error('사회복지기관을 찾을 수 없습니다.');
    }
    if (payerId) {
      const payer = await prisma.payerProfile.findUnique({ where: { id: payerId }, select: { id: true } });
      if (!payer) throw new Error('후원자를 찾을 수 없습니다.');
    }

    const created = await prisma.$transaction(async (tx) => {
      if (scope === 'GLOBAL' && active) {
        // 시행 중인 전역 정책은 새 정책의 시행일까지 그대로 살려 둔다(공백 구간 방지).
        await tx.chargeLimitPolicy.updateMany({
          where: { scope: 'GLOBAL', active: true, effectiveTo: null, effectiveFrom: { lt: effectiveFrom } },
          data: { effectiveTo: effectiveFrom },
        });
      }
      return tx.chargeLimitPolicy.create({
        data: { id: newId(), scope, merchantId, payerId, ...values, active, effectiveFrom },
      });
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'LIMIT_POLICY_CREATE',
      targetType: 'ChargeLimitPolicy',
      targetId: created.id,
      after: { scope, merchantId, payerId, ...values, active, effectiveFrom },
    });
    revalidatePath('/admin/policies');
    return '새 한도 정책을 등록했습니다.';
  });
}

export async function toggleLimitPolicy(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '한도 정책 변경은 운영/재무 권한에서만 가능합니다.');
    const id = requiredId(fd, 'id', '한도 정책');
    const before = await prisma.chargeLimitPolicy.findUnique({
      where: { id },
      select: { id: true, active: true, scope: true },
    });
    if (!before) throw new Error('한도 정책을 찾을 수 없습니다.');

    const active = !before.active;
    await prisma.chargeLimitPolicy.update({
      where: { id },
      data: { active, effectiveTo: active ? null : new Date() },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'LIMIT_POLICY_TOGGLE',
      targetType: 'ChargeLimitPolicy',
      targetId: id,
      before: { active: before.active, scope: before.scope },
      after: { active },
    });
    revalidatePath('/admin/policies');
    return active ? '정책을 활성화했습니다.' : '정책을 비활성화했습니다.';
  });
}

// =========================================================== 약관 버전

export async function createTermsVersion(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 현행 약관을 교체하는 동작이다(전자금융거래 약관 포함). 최고 관리자만 등록한다.
    if (admin.adminPermission !== 'SUPER_ADMIN') {
      throw new Error('약관 버전 등록은 최고 관리자만 가능합니다.');
    }
    const type = enumValue(
      fd,
      'type',
      ['TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM', 'MARKETING'] as const,
      '약관 유형',
    );
    const version = text(fd, 'version');
    const title = text(fd, 'title');
    const content = text(fd, 'content');
    const required = bool(fd, 'required');
    const effectiveFrom = optDate(fd, 'effectiveFrom', '시행일') ?? new Date();

    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$|^v?[0-9]+(\.[0-9]+)*$/.test(version)) {
      throw new Error('버전은 1.0 또는 2026-01-01 형식으로 입력해 주세요.');
    }
    if (title.length < 2) throw new Error('약관 제목을 입력해 주세요.');
    if (content.length < 10) throw new Error('약관 본문을 10자 이상 입력해 주세요.');

    const dup = await prisma.termsVersion.findUnique({ where: { type_version: { type, version } } });
    if (dup) throw new Error('같은 유형의 동일 버전이 이미 있습니다.');

    // 기존 버전을 여기서 내리지 않는다.
    // 시행일이 미래인 개정안을 등록하는 순간 현행 약관이 공개 화면과 결제 동의 목록에서
    // 사라지던 문제 때문이다. 현행 판단은 시행일로 한다(server/services/terms.ts).
    const created = await prisma.termsVersion.create({
      data: { id: newId(), type, version, title, content, required, effectiveFrom, active: true },
    });

    await writeAudit({
      adminUserId: admin.id,
      action: 'TERMS_VERSION_CREATE',
      targetType: 'TermsVersion',
      targetId: created.id,
      after: { type, version, title, required, effectiveFrom },
    });
    revalidatePath('/admin/terms');
    return `${type} ${version} 버전을 등록했습니다. 시행일(${effectiveFrom.toISOString().slice(0, 10)})이 지나면 자동으로 현행 약관이 됩니다.`;
  });
}

// =========================================================== 신고 / 금칙어

export async function updateReportStatus(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const reportId = requiredId(fd, 'reportId', '신고');
    const status = enumValue(fd, 'status', ['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED'] as const, '처리 상태');

    const before = await prisma.report.findUnique({
      where: { id: reportId },
      select: { id: true, status: true, category: true },
    });
    if (!before) throw new Error('신고를 찾을 수 없습니다.');
    if (before.status === status) throw new Error('이미 해당 상태입니다.');

    const closed = status === 'RESOLVED' || status === 'DISMISSED';
    await prisma.report.update({
      where: { id: reportId },
      data: { status, handledBy: admin.id, handledAt: closed ? new Date() : null },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'REPORT_STATUS_UPDATE',
      targetType: 'Report',
      targetId: reportId,
      before: { status: before.status },
      after: { status, handledBy: admin.id },
    });
    revalidatePath('/admin/moderation');
    return '신고 처리 상태를 변경했습니다.';
  });
}

export async function createBannedWord(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 전역 금칙어는 결제 흐름(charge-flow)에 그대로 반영된다. 정책 변경과 같은 기준으로 막는다.
    assertMoneyAdmin(admin, '전역 금칙어 변경은 운영/재무 권한에서만 가능합니다.');
    const word = text(fd, 'word');
    const action = enumValue(fd, 'action', ['BLOCK', 'MASK', 'FLAG'] as const, '처리 방식');
    if (word.length < 1 || word.length > 40) throw new Error('금칙어는 1 ~ 40자로 입력해 주세요.');
    // 비교에서 무시하는 문자(공백·구두점)만으로 된 단어는 금칙어 구실을 못 한다.
    if (!bannedNeedle(word)) throw new Error('공백이나 기호(. _ - * ~ = + /)만으로는 금칙어를 만들 수 없습니다.');

    const dup = await prisma.bannedWord.findFirst({ where: { scope: 'GLOBAL', word } });
    if (dup) throw new Error('이미 등록된 전역 금칙어입니다.');

    const created = await prisma.bannedWord.create({
      data: { id: newId(), word, action, scope: 'GLOBAL', active: true },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'BANNED_WORD_CREATE',
      targetType: 'BannedWord',
      targetId: created.id,
      after: { word, action, scope: 'GLOBAL' },
    });
    revalidatePath('/admin/moderation');
    return `금칙어 "${word}" 를 등록했습니다.`;
  });
}

export async function deleteBannedWord(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '전역 금칙어 변경은 운영/재무 권한에서만 가능합니다.');
    const id = requiredId(fd, 'id', '금칙어');
    const before = await prisma.bannedWord.findUnique({ where: { id } });
    if (!before) throw new Error('금칙어를 찾을 수 없습니다.');
    if (before.scope !== 'GLOBAL') throw new Error('사회복지기관 개별 금칙어는 통합 관리자에서 삭제할 수 없습니다.');

    await prisma.bannedWord.delete({ where: { id } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'BANNED_WORD_DELETE',
      targetType: 'BannedWord',
      targetId: id,
      before: { word: before.word, action: before.action, scope: before.scope },
    });
    revalidatePath('/admin/moderation');
    return `금칙어 "${before.word}" 를 삭제했습니다.`;
  });
}
