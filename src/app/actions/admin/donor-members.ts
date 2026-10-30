'use server';

import { revalidatePath } from 'next/cache';
import { writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { setDonorMemberStatus } from '@/server/services/donor-members';
import type { AdminActionState } from '@/components/admin/state';
import { optText, requiredId, run, text } from './shared';

/** 기관 후원 회원 정지·해제. 정지하면 그 회원의 모든 세션을 끊는다. */
export async function setDonorMemberStatusAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const memberId = requiredId(f, 'memberId', '회원');
    const status = text(f, 'status');
    if (status !== 'ACTIVE' && status !== 'SUSPENDED') throw new Error('처리 방식을 확인해 주세요.');
    const note = optText(f, 'note')?.slice(0, 200) ?? null;
    if (status === 'SUSPENDED' && !note) throw new Error('정지 사유를 입력해 주세요.');
    const member = await prisma.donorMember.findUnique({ where: { id: memberId }, select: { merchantId: true } });
    if (!member) throw new Error('회원을 찾을 수 없습니다.');
    const before = await setDonorMemberStatus(memberId, status, note);
    await writeAudit({
      adminUserId: admin.id,
      action: status === 'SUSPENDED' ? 'DONOR_MEMBER_SUSPEND' : 'DONOR_MEMBER_ACTIVATE',
      targetType: 'DonorMember',
      targetId: memberId,
      before: { status: before },
      after: { status, merchantId: member.merchantId, note },
    });
    revalidatePath('/admin/donor-members');
    return status === 'SUSPENDED' ? '회원을 정지하고 로그인 세션을 모두 끊었습니다.' : '회원 정지를 해제했습니다.';
  });
}
