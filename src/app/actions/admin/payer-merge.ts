'use server';

import { revalidatePath } from 'next/cache';
import type { AdminActionState } from '@/components/admin/state';
import { mergePayer, unmergePayer } from '@/server/services/payer-merge';
import { run, text, requiredId, assertMoneyAdmin } from './shared';

/**
 * 후원자 병합 / 병합 해제 (통합 관리자). 결제·약정·봉사·영수증 데이터는 옮기지 않고 조회·집계에서만 묶는다.
 * 감사로그(PAYER_MERGE / PAYER_UNMERGE)는 서비스가 남긴다.
 */

export async function mergePayerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '후원자 병합은 최고관리자·운영·재무 권한에서만 가능합니다.');
    const sourceId = requiredId(fd, 'sourceId', '후원자');
    const targetId = requiredId(fd, 'targetId', '대상 후원자');
    const r = await mergePayer({ sourceId, targetId, note: text(fd, 'note'), adminUserId: admin.id });
    revalidatePath('/admin/payers');
    revalidatePath(`/admin/payers/${sourceId}`);
    revalidatePath(`/admin/payers/${targetId}`);
    return `${r.sourceMasked} 후원자를 ${r.targetMasked} 후원자에 병합했습니다. 결제·영수증 데이터는 각자 명의 그대로입니다.`;
  });
}

export async function unmergePayerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '후원자 병합 해제는 최고관리자·운영·재무 권한에서만 가능합니다.');
    const sourceId = requiredId(fd, 'sourceId', '후원자');
    await unmergePayer({ sourceId, adminUserId: admin.id, note: text(fd, 'note') });
    revalidatePath('/admin/payers');
    revalidatePath(`/admin/payers/${sourceId}`);
    return '병합을 해제했습니다.';
  });
}
