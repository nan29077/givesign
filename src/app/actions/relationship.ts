'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { requireMerchant, writeAudit } from '@/server/auth';
import { clientIpFrom } from '@/server/rate-limit';
import { RelationshipError, optOutRelationship, saveRelationshipSetting } from '@/server/services/relationship-messages';

export interface RelationshipActionState {
  ok: boolean;
  message?: string;
}

/** 기관 관계 안내 설정(2026-11-13 5차 L4). 전역 스위치가 꺼져 있으면 거절한다. */
export async function saveRelationshipSettingAction(_p: RelationshipActionState, fd: FormData): Promise<RelationshipActionState> {
  const user = await requireMerchant();
  try {
    const enabled = fd.get('enabled') === 'on';
    const kinds = fd.getAll('kinds').map(String);
    await saveRelationshipSetting(user.merchantId, { enabled, kinds }, user.id);
    await writeAudit({ actorUserId: user.id, action: 'RELATIONSHIP_SETTING_CHANGE', targetType: 'relationship_message_setting', targetId: user.merchantId, after: { enabled, kinds } });
    revalidatePath('/studio/relationship');
    return { ok: true, message: enabled ? '관계 안내를 켰습니다. 매주 대상 묶음이 승인 대기함에 올라옵니다(승인해야 발송).' : '관계 안내를 껐습니다.' };
  } catch (e) {
    return { ok: false, message: e instanceof RelationshipError ? e.message : '저장하지 못했습니다.' };
  }
}

/** 무료 수신 거부(/u/[토큰]) — 버튼을 눌러야 철회한다(링크 미리보기 수집기가 철회하지 않게). */
export async function optOutAction(_p: RelationshipActionState, fd: FormData): Promise<RelationshipActionState> {
  const h = await headers();
  const r = await optOutRelationship(String(fd.get('token') ?? ''), { ip: clientIpFrom((n) => h.get(n)), userAgent: h.get('user-agent') });
  return r.ok ? { ok: true, message: `${r.merchantName ?? '기관'} 소식·후원 안내 수신을 거부했습니다. 더 이상 이 안내를 보내지 않습니다.` } : { ok: false, message: '링크가 올바르지 않거나 만료되었습니다.' };
}
