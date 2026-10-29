'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, optText, requiredId, assertMoneyAdmin } from './shared';

/**
 * 사회복지기관 발송 템플릿 검수.
 *
 * 사회복지기관이 등록한 템플릿은 자동 검사를 통과하면 바로 승인된다.
 * 광고성 표현이나 금칙어가 걸린 것만 여기로 올라온다.
 *
 * 승인하면 그 사회복지기관이 그 문구로 후원자에게 문자를 보낼 수 있게 된다.
 * 광고성 문구를 승인하면 사전 동의·야간 발송 제한 같은 의무가 따라오고,
 * 스팸 신고가 쌓이면 제재받는 것은 **우리 대표번호**다. 판단은 보수적으로 한다.
 */

export async function approveMerchantMtTemplate(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  return run(async (admin) => {
    // 템플릿 승인은 그 문구로 실제 문자가 나가게 하는 결정이다. 광고성 문구를 잘못 통과시키면
    // 표기 의무 위반의 책임이 발신자인 기브싸인에 온다. 고객 응대(SUPPORT) 권한으로는 막는다.
    assertMoneyAdmin(admin, '사회복지기관 문자 템플릿 검수는 최고관리자·운영·재무 권한에서만 가능합니다.');
    const id = requiredId(fd, 'templateId', '템플릿');
    const before = await prisma.merchantMtTemplate.findUnique({
      where: { id },
      select: { code: true, status: true, body: true, merchantId: true },
    });
    if (!before) throw new Error('존재하지 않는 템플릿입니다.');
    if (before.status === 'APPROVED') throw new Error('이미 승인된 템플릿입니다.');

    await prisma.merchantMtTemplate.update({
      where: { id },
      data: {
        status: 'APPROVED',
        reviewNote: optText(fd, 'note'),
        reviewedAt: new Date(),
        reviewedBy: admin.id,
      },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'MERCHANT_MT_TEMPLATE_APPROVE',
      targetType: 'MerchantMtTemplate',
      targetId: id,
      before: { status: before.status },
      after: { status: 'APPROVED', body: before.body },
    });

    revalidatePath('/admin/merchant-mt-templates');
    return `템플릿 "${before.code}" 를 승인했습니다. 이제 사회복지기관이 발송할 수 있습니다.`;
  });
}

export async function rejectMerchantMtTemplate(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '사회복지기관 문자 템플릿 검수는 최고관리자·운영·재무 권한에서만 가능합니다.');
    const id = requiredId(fd, 'templateId', '템플릿');
    const note = text(fd, 'note');
    // 사유 없이 반려하면 사회복지기관은 무엇을 고쳐야 하는지 알 수 없어 그대로 다시 올린다.
    if (!note) throw new Error('반려 사유를 입력해 주세요. 사회복지기관이 무엇을 고쳐야 하는지 알아야 합니다.');

    const before = await prisma.merchantMtTemplate.findUnique({
      where: { id },
      select: { code: true, status: true },
    });
    if (!before) throw new Error('존재하지 않는 템플릿입니다.');

    await prisma.merchantMtTemplate.update({
      where: { id },
      data: { status: 'REJECTED', reviewNote: note, reviewedAt: new Date(), reviewedBy: admin.id },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'MERCHANT_MT_TEMPLATE_REJECT',
      targetType: 'MerchantMtTemplate',
      targetId: id,
      before: { status: before.status },
      after: { status: 'REJECTED', note },
    });

    revalidatePath('/admin/merchant-mt-templates');
    return `템플릿 "${before.code}" 를 반려했습니다.`;
  });
}
