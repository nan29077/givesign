'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import type { AdminActionState } from '@/components/admin/state';
import { assertMoneyAdmin, optText, requiredId, run } from './shared';

/**
 * 공익법인(지정기부금단체) 지정 확인.
 * 기관이 스스로 체크한 값만으로는 영수증을 발급하지 못하게 하고, 관리자가 지정 서류를 확인한 뒤 확인 처리한다.
 * 영수증 발급은 세법상 효력이 있으므로 정산 권한(돈을 다루는 권한)이 있는 관리자만 할 수 있다.
 */
export async function verifyDesignatedDoneeAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '공익법인 지정 확인은 정산 권한이 있는 관리자만 할 수 있습니다.');
    const merchantId = requiredId(f, 'merchantId', '기관');
    const note = optText(f, 'note');
    const m = await prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { id: true, designatedDonee: true, designatedDoneeUntil: true, businessNo: true, designatedDoneeVerifiedAt: true },
    });
    if (!m) throw new Error('기관을 찾을 수 없습니다.');
    if (!m.designatedDonee) throw new Error('기관이 공익법인 지정 여부를 아직 등록하지 않았습니다.');
    if (!m.businessNo) throw new Error('기관 고유번호가 없어 확인할 수 없습니다.');
    const now = new Date();
    await prisma.merchantProfile.update({
      where: { id: merchantId },
      data: { designatedDoneeVerifiedAt: now, designatedDoneeVerifiedBy: admin.id, designatedDoneeNote: note?.slice(0, 200) ?? null },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'DESIGNATED_DONEE_VERIFY',
      targetType: 'MerchantProfile',
      targetId: merchantId,
      before: { verifiedAt: m.designatedDoneeVerifiedAt },
      after: { verifiedAt: now, until: m.designatedDoneeUntil, businessNo: m.businessNo, note },
    });
    revalidatePath('/admin/fundraising');
    revalidatePath('/donate', 'layout');
    return '공익법인 지정을 확인했습니다. 이제 이 기관은 기부금영수증을 발급할 수 있습니다.';
  });
}

export async function revokeDesignatedDoneeAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '공익법인 지정 확인 취소는 정산 권한이 있는 관리자만 할 수 있습니다.');
    const merchantId = requiredId(f, 'merchantId', '기관');
    const m = await prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { designatedDoneeVerifiedAt: true } });
    if (!m) throw new Error('기관을 찾을 수 없습니다.');
    await prisma.merchantProfile.update({
      where: { id: merchantId },
      data: { designatedDoneeVerifiedAt: null, designatedDoneeVerifiedBy: null },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'DESIGNATED_DONEE_REVOKE',
      targetType: 'MerchantProfile',
      targetId: merchantId,
      before: { verifiedAt: m.designatedDoneeVerifiedAt },
      after: { verifiedAt: null },
    });
    revalidatePath('/admin/fundraising');
    revalidatePath('/donate', 'layout');
    return '공익법인 지정 확인을 취소했습니다. 이 기관은 영수증을 새로 발급할 수 없습니다.';
  });
}
