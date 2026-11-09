import { prisma } from '@/server/db';
import { phoneHash } from '@/lib/crypto';

/**
 * 후원자 안내 채널 선호(2026-11-09 D2-4). `payer_profile.preferred_channel`:
 *  - ALIMTALK(기본): 지금처럼 알림톡 우선(기관 채널·승인 코드가 없으면 문자)
 *  - SMS: 문자만
 * 셀프서비스 화면은 2차 F. 발송 쪽 반영은 sendMtDetailed 의 알림톡 경로 결정 한 곳이다.
 */
export const PREFERRED_CHANNELS = ['ALIMTALK', 'SMS'] as const;
export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number];

/** 이 번호의 후원자가 문자만 받겠다고 했는가. 후원자가 없거나 조회에 실패하면 false(지금 동작). */
export async function prefersSmsOnly(phone: string): Promise<boolean> {
  try {
    const p = await prisma.payerProfile.findUnique({ where: { phoneHash: phoneHash(phone) }, select: { preferredChannel: true } });
    return p?.preferredChannel === 'SMS';
  } catch {
    return false;
  }
}
