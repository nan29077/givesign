import { prisma } from '@/server/db';
import { isMarketingConsented } from './marketing-consent';

/**
 * 후원자 "알림 설정" 한 곳 (2026-11-09 2차 F).
 *
 * 세 가지를 따로 저장하고 한 화면에서 보여 준다(서로 다른 것이다):
 *  1) 연락 선호 `payer_profile.preferred_channel` — ALIMTALK_FIRST(알림톡 우선, 안 되면 문자) · SMS_ONLY(문자만).
 *     후원자 단위. 컬럼 정의는 2차 D 와 같다(발송 경로가 이 값을 읽는 것은 D 의 몫).
 *     결제 링크·인증번호는 원래 문자로만 보낸다(이 설정과 무관).
 *  2) 월간 후원 안내 수신 거부 `payer_merchant_link.notice_opt_out_at` — 기관별. 출금·영수증 안내는 계속 나간다.
 *  3) (선택) 기관 소식·후원 안내 수신 동의(1차, marketing-consent.ts) — 기관별. 아직 이것으로 보내는 것은 없다.
 */

export const PREFERRED_CHANNELS = ['ALIMTALK_FIRST', 'SMS_ONLY'] as const;
export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number];
export const DEFAULT_PREFERRED_CHANNEL: PreferredChannel = 'ALIMTALK_FIRST';

export const PREFERRED_CHANNEL_LABEL: Record<PreferredChannel, { title: string; desc: string }> = {
  ALIMTALK_FIRST: { title: '카카오 알림톡 우선', desc: '안내를 카카오톡 알림톡으로 먼저 보내고, 받지 못하면 같은 내용을 문자로 보냅니다.' },
  SMS_ONLY: { title: '문자만', desc: '카카오톡 대신 모든 안내를 문자로만 받습니다.' },
};

export const NOTIFICATION_SETTING_HELP = {
  channel: '안내를 어떤 방법으로 받을지 정합니다. 결제 링크와 인증번호는 설정과 관계없이 항상 문자로 보냅니다.',
  notice: '매월 초 지난달 후원 내역과 올해 누적을 알려 드리는 안내입니다. 꺼도 출금·영수증 안내는 계속 받습니다.',
  marketing: '기관의 소식과 후원 안내를 받을지 정하는 선택 동의입니다. 동의하지 않아도 후원·영수증·출금 안내는 그대로 받습니다.',
} as const;

export function isPreferredChannel(v: unknown): v is PreferredChannel {
  return typeof v === 'string' && (PREFERRED_CHANNELS as readonly string[]).includes(v);
}

export async function getPreferredChannel(payerId: string): Promise<PreferredChannel> {
  const p = await prisma.payerProfile.findUnique({ where: { id: payerId }, select: { preferredChannel: true } });
  return isPreferredChannel(p?.preferredChannel) ? p!.preferredChannel as PreferredChannel : DEFAULT_PREFERRED_CHANNEL;
}

/** 연락 선호 저장. 이미 같은 값이면 바꾸지 않는다. */
export async function setPreferredChannel(payerId: string, value: string): Promise<{ changed: boolean; value: PreferredChannel }> {
  if (!isPreferredChannel(value)) throw new Error('알 수 없는 연락 방법입니다.');
  const r = await prisma.payerProfile.updateMany({ where: { id: payerId, NOT: { preferredChannel: value } }, data: { preferredChannel: value } });
  return { changed: r.count > 0, value };
}

/** 월간 안내 수신 거부/재개 — 이미 이어진 기관만(연결 행을 새로 만들지 않는다) */
export async function setNoticeOptOut(payerId: string, merchantId: string, optOut: boolean): Promise<boolean> {
  const r = await prisma.payerMerchantLink.updateMany({ where: { payerId, merchantId }, data: { noticeOptOutAt: optOut ? new Date() : null } });
  return r.count > 0;
}

export interface MerchantNoticeSetting {
  merchantId: string;
  merchantName: string;
  noticeOptOut: boolean;
  marketingAgreed: boolean;
  marketingSince: Date | null;
}

/** 알림 설정 화면 데이터. merchantId 를 주면 그 기관만(기관 후원 회원 화면). */
export async function notificationSettings(payerId: string, merchantId?: string): Promise<{ channel: PreferredChannel; merchants: MerchantNoticeSetting[] }> {
  const [channel, links] = await Promise.all([
    getPreferredChannel(payerId),
    prisma.payerMerchantLink.findMany({
      where: { payerId, ...(merchantId ? { merchantId } : {}) },
      include: { merchant: { select: { displayName: true } } },
      orderBy: { lastDonatedAt: 'desc' },
      take: 100,
    }),
  ]);
  return {
    channel,
    merchants: links.map((l) => {
      const agreed = isMarketingConsented(l);
      return {
        merchantId: l.merchantId,
        merchantName: l.merchant.displayName,
        noticeOptOut: Boolean(l.noticeOptOutAt),
        marketingAgreed: agreed,
        marketingSince: agreed ? l.marketingConsentAt : null,
      };
    }),
  };
}
