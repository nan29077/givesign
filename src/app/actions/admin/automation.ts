'use server';

import { revalidatePath } from 'next/cache';
import { writeAudit } from '@/server/auth';
import type { AdminActionState } from '@/components/admin/state';
import { setAlimtalkChannelStatus } from '@/server/services/alimtalk';
import { optText, requiredId, run } from './shared';

/**
 * 카카오 알림톡 채널 확인.
 * 기관이 등록한 발신프로필·템플릿 코드가 카카오에서 승인됐는지 관리자가 확인한 뒤 '사용 중' 으로 바꾼다.
 * 사용 중이 아니면 같은 안내가 문자로 나간다.
 */
export async function setAlimtalkStatusAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const merchantId = requiredId(f, 'merchantId', '기관');
    const status = String(f.get('status') ?? '');
    if (!['ACTIVE', 'SUSPENDED', 'PENDING'].includes(status)) throw new Error('알 수 없는 상태입니다.');
    const note = optText(f, 'note');
    await setAlimtalkChannelStatus(merchantId, status as 'ACTIVE' | 'SUSPENDED' | 'PENDING', admin.id, note ?? undefined);
    await writeAudit({ adminUserId: admin.id, action: 'ALIMTALK_CHANNEL_STATUS', targetType: 'MerchantProfile', targetId: merchantId, after: { status, note } });
    revalidatePath('/admin/automation');
    return status === 'ACTIVE' ? '알림톡 채널을 사용 중으로 바꿨습니다.' : status === 'SUSPENDED' ? '알림톡 발송을 중지했습니다. 안내는 문자로 나갑니다.' : '승인 대기로 되돌렸습니다.';
  });
}
