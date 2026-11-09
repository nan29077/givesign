'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, money, percentRate, optDate, assertMoneyAdmin } from './shared';
import { setRelationshipGloballyEnabled } from '@/server/services/relationship-messages';

/** 2026-11-13 5차 L — 관계 확장 안내 전역 스위치(최고관리자) · 카드 결제 수수료 정책(재무·운영). */

export async function setRelationshipSwitchAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission !== 'SUPER_ADMIN') throw new Error('최고관리자만 바꿀 수 있습니다.');
    const enabled = text(fd, 'enabled') === 'on';
    if (enabled && text(fd, 'confirmText') !== '법무 확인 완료') throw new Error("켜려면 확인란에 '법무 확인 완료' 를 입력해 주세요.");
    await setRelationshipGloballyEnabled(enabled, admin.id);
    await writeAudit({ adminUserId: admin.id, action: enabled ? 'RELATIONSHIP_MESSAGES_ENABLE' : 'RELATIONSHIP_MESSAGES_DISABLE', targetType: 'system_setting', targetId: 'relationship_messages.enabled', after: { enabled } });
    revalidatePath('/admin/site-settings');
    return enabled ? '관계 확장 안내를 켰습니다. 기관이 각자 켜고 승인해야 발송됩니다.' : '관계 확장 안내를 껐습니다. 대상 계산·발송이 모두 멈춥니다.';
  });
}

export async function createCardFeePolicyAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '카드 수수료 정책은 재무/운영 권한에서만 등록할 수 있습니다.');
    const code = text(fd, 'merchantCode').toUpperCase();
    const merchant = code ? await prisma.merchantProfile.findUnique({ where: { code }, select: { id: true } }) : null;
    if (code && !merchant) throw new Error('기관 코드를 찾을 수 없습니다.');
    const scope = merchant ? 'MERCHANT' : 'GLOBAL';
    // 입력은 퍼센트("3.3"), 저장은 소수("0.033") — 절대 규칙 8
    const pgFeeRate = percentRate(fd, 'pgFeeRate', '카드 결제');
    const platformFeeRate = percentRate(fd, 'platformFeeRate', '플랫폼');
    const pgFixedFee = money(fd, 'pgFixedFee', '건당 고정비');
    const vatIncluded = text(fd, 'vatIncluded') === 'on';
    const effectiveFrom = optDate(fd, 'effectiveFrom', '적용 시작일') ?? new Date();
    if (effectiveFrom.getTime() < Date.now() - 86_400_000) throw new Error('적용 시작일을 과거로 잡을 수 없습니다(원장은 소급 계산하지 않습니다).');
    if (Number(pgFeeRate) + Number(platformFeeRate) >= 1) throw new Error('카드 결제 수수료와 플랫폼 수수료의 합이 100% 이상입니다.');
    const merchantId = merchant?.id ?? null;
    const created = await prisma.$transaction(async (tx) => {
      // 같은 범위의 열린 정책은 새 시행일까지 살려 둔다(이력 보존 + 공백 방지 — 계좌 정책과 같은 방식).
      await tx.cardFeePolicy.updateMany({ where: { scope, merchantId, effectiveTo: null, effectiveFrom: { lt: effectiveFrom } }, data: { effectiveTo: effectiveFrom } });
      await tx.cardFeePolicy.updateMany({ where: { scope, merchantId, effectiveTo: null, effectiveFrom: { gte: effectiveFrom } }, data: { effectiveTo: effectiveFrom } });
      return tx.cardFeePolicy.create({ data: { id: newId(), scope, merchantId, pgFeeRate, pgFixedFee, platformFeeRate, vatIncluded, effectiveFrom, createdBy: admin.id } });
    });
    await writeAudit({ adminUserId: admin.id, action: 'CARD_FEE_POLICY_CREATE', targetType: 'CardFeePolicy', targetId: created.id, after: { scope, merchantId, pgFeeRate, platformFeeRate, pgFixedFee, vatIncluded, effectiveFrom } });
    revalidatePath('/admin/site-settings');
    return '카드 결제 수수료 정책을 등록했습니다.';
  });
}
