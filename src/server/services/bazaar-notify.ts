import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { decrypt } from '@/lib/crypto';
import { formatWon } from '@/lib/money';
import { logger } from '@/lib/logger';
import { notifySuperAdmins, notifyUser } from './notifications';
import * as tpl from './mt-templates';

/**
 * 라이브 바자회 단계 알림 (2026-11-13 점검 B-M2).
 *
 * 예전에는 매칭 제안·가액 제안·약정·입고·영수증·편성·정산 어느 단계에서도 알림이 없어, 기관이 콘솔을 열지 않으면
 * 매칭 제안이 기한을 넘겨 조용히 접수 상태로 돌아갔다.
 *  - 기관·관리자: 콘솔 알림(인앱). 기부자: 콘솔 알림 + 꼭 필요한 세 단계(가액 제안·약정 요청·영수증 발급)만 정보성 문자.
 *  - 모든 알림은 업무 트랜잭션이 끝난 뒤 부르고, 실패해도 업무 결과를 바꾸지 않는다(이 파일의 함수는 예외를 던지지 않는다).
 *  - 개인정보 원문을 알림 본문에 넣지 않는다(기부 제목·기관명·금액만).
 */

type Ctx = {
  id: string;
  title: string;
  donationNo: string;
  merchantId: string | null;
  donor: { userId: string; phoneEnc: string };
  merchant: { userId: string; displayName: string } | null;
};

async function load(donationId: string): Promise<Ctx | null> {
  return prisma.inKindDonation.findUnique({
    where: { id: donationId },
    select: {
      id: true,
      title: true,
      donationNo: true,
      merchantId: true,
      donor: { select: { userId: true, phoneEnc: true } },
      merchant: { select: { userId: true, displayName: true } },
    },
  });
}

const giverLink = (id: string) => `/giver/donations/${id}`;
const studioLink = (id: string) => `/studio/bazaar/donations/${id}`;
const adminLink = (id: string) => `/admin/bazaar/donations/${id}`;

async function safe(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    logger.warn('바자회 알림 실패', { label, message: (e as Error).message });
  }
}

async function smsGiver(c: Ctx, template: tpl.TemplateOutput) {
  const { sendMt } = await import('./charge-flow');
  await sendMt({ phone: decrypt(c.donor.phoneEnc), template, merchantId: c.merchantId });
}

async function merchantUser(merchantId: string) {
  return (await prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { userId: true, displayName: true } })) ?? null;
}

export async function notifyMatchProposed(donationId: string, merchantId: string, deadline: Date) {
  await safe('match-proposed', async () => {
    const c = await load(donationId);
    const m = await merchantUser(merchantId);
    if (!c || !m) return;
    await notifyUser({
      userId: m.userId,
      title: '현물 기부 매칭 제안이 왔습니다',
      body: `'${c.title}' — ${deadline.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}까지 수락·거절해 주세요. 기한이 지나면 다른 기관에 제안될 수 있습니다.`,
      linkUrl: studioLink(c.id),
    });
  });
}

export async function notifyMatchResponded(donationId: string, merchantId: string, accepted: boolean) {
  await safe('match-responded', async () => {
    const c = await load(donationId);
    const m = await merchantUser(merchantId);
    if (!c || !m) return;
    if (accepted) {
      await notifyUser({ userId: c.donor.userId, title: '기관이 기부를 수락했습니다', body: `'${c.title}' — ${m.displayName} 과(와) 기부 가액을 정합니다.`, linkUrl: giverLink(c.id) });
    } else {
      await notifySuperAdmins({ title: '현물 기부 매칭 거절', body: `${c.donationNo} '${c.title}' — ${m.displayName} 이(가) 거절했습니다. 다른 기관에 매칭해 주세요.`, linkUrl: adminLink(c.id) });
    }
  });
}

export async function notifyMatchExpired(donationId: string) {
  await safe('match-expired', async () => {
    const c = await load(donationId);
    if (!c) return;
    await notifySuperAdmins({ title: '현물 기부 매칭 기한 만료', body: `${c.donationNo} '${c.title}' — 기관이 기한 안에 응답하지 않아 접수 상태로 돌아갔습니다. 다시 매칭해 주세요.`, linkUrl: adminLink(c.id) });
  });
}

export async function notifyValuationProposed(donationId: string, by: 'DONOR' | 'MERCHANT', total: bigint) {
  await safe('valuation-proposed', async () => {
    const c = await load(donationId);
    if (!c?.merchant) return;
    if (by === 'MERCHANT') {
      await notifyUser({ userId: c.donor.userId, title: '기관이 기부 가액을 제안했습니다', body: `'${c.title}' — 합계 ${formatWon(total)}. 수락하거나 다시 제안해 주세요.`, linkUrl: giverLink(c.id) });
      await smsGiver(c, tpl.tplBazaarValuation({ donationTitle: c.title, merchantName: c.merchant.displayName, link: `${env.baseUrl}${giverLink(c.id)}` }));
    } else {
      await notifyUser({ userId: c.merchant.userId, title: '기부자가 가액을 제안했습니다', body: `'${c.title}' — 합계 ${formatWon(total)}. 확정하거나 다시 제안해 주세요.`, linkUrl: studioLink(c.id) });
    }
  });
}

export async function notifyValuationConfirmed(donationId: string, total: bigint) {
  await safe('valuation-confirmed', async () => {
    const c = await load(donationId);
    if (!c) return;
    await notifyUser({ userId: c.donor.userId, title: '기부 가액이 확정되었습니다 — 약정 동의 필요', body: `'${c.title}' — ${formatWon(total)}. 약정에 동의하시면 물품 발송 안내를 드립니다.`, linkUrl: giverLink(c.id) });
    await smsGiver(c, tpl.tplBazaarPledgeRequest({ donationTitle: c.title, link: `${env.baseUrl}${giverLink(c.id)}` }));
    if (c.merchant) await notifyUser({ userId: c.merchant.userId, title: '기부 가액 확정', body: `'${c.title}' — ${formatWon(total)}. 기부자 약정 뒤 물품이 입고됩니다.`, linkUrl: studioLink(c.id) });
  });
}

export async function notifyPledged(donationId: string) {
  await safe('pledged', async () => {
    const c = await load(donationId);
    if (!c) return;
    await notifySuperAdmins({ title: '현물 기부 약정 — 입고 대기', body: `${c.donationNo} '${c.title}' 이(가) 약정되었습니다. 물품이 들어오면 입고·검수를 등록해 주세요.`, linkUrl: adminLink(c.id) });
    if (c.merchant) await notifyUser({ userId: c.merchant.userId, title: '기부자가 약정했습니다', body: `'${c.title}' — 물품이 입고·검수되면 검수 확정을 요청드립니다.`, linkUrl: studioLink(c.id) });
  });
}

export async function notifyInbound(donationId: string, result: 'PASS' | 'PARTIAL' | 'FAIL') {
  await safe('inbound', async () => {
    const c = await load(donationId);
    if (!c) return;
    if (result === 'FAIL') {
      await notifyUser({ userId: c.donor.userId, title: '입고 검수 결과 — 불합격', body: `'${c.title}' 물품이 검수를 통과하지 못했습니다. 상세 화면에서 처리 결과를 확인해 주세요.`, linkUrl: giverLink(c.id) });
      if (c.merchant) await notifyUser({ userId: c.merchant.userId, title: '입고 검수 불합격', body: `'${c.title}' — 반송·폐기로 끝났습니다.`, linkUrl: studioLink(c.id) });
      return;
    }
    if (c.merchant) await notifyUser({ userId: c.merchant.userId, title: '검수 확정이 필요합니다', body: `'${c.title}' 입고·검수가 끝났습니다(${result === 'PASS' ? '합격' : '일부 합격'}). 확정하면 현물 기부금영수증이 발급됩니다.`, linkUrl: studioLink(c.id) });
  });
}

export async function notifyReceiptIssued(donationId: string, amount: bigint) {
  await safe('receipt-issued', async () => {
    const c = await load(donationId);
    if (!c?.merchant) return;
    await notifyUser({ userId: c.donor.userId, title: '현물 기부금영수증이 발급되었습니다', body: `'${c.title}' — ${c.merchant.displayName} ${formatWon(amount)}.`, linkUrl: '/giver/receipts' });
    await smsGiver(c, tpl.tplBazaarReceiptIssued({ merchantName: c.merchant.displayName, amount, link: `${env.baseUrl}/giver/receipts` }));
  });
}

export async function notifyLiveProposed(merchantId: string, title: string) {
  await safe('live-proposed', async () => {
    const m = await merchantUser(merchantId);
    if (!m) return;
    await notifyUser({ userId: m.userId, title: '바자회 방송 편성 승인 요청', body: `'${title}' — 편성을 확인하고 승인·반려해 주세요.`, linkUrl: '/studio/bazaar/lives' });
  });
}

export async function notifySettlement(merchantId: string, month: string, kind: 'CONFIRMED' | 'PAID' | 'CARRIED', payout: bigint) {
  await safe('settlement', async () => {
    const m = await merchantUser(merchantId);
    if (!m) return;
    const body =
      kind === 'PAID' ? `${month} 판매 정산 ${formatWon(payout)}을 지급했습니다.` : kind === 'CARRIED' ? `${month} 판매 정산은 지급할 금액이 없어 다음 달로 넘어갔습니다.` : `${month} 판매 정산 ${formatWon(payout)}이 확정되었습니다. 지급일에 정산 계좌로 보내 드립니다.`;
    await notifyUser({ userId: m.userId, title: '현물 판매 정산 안내', body, linkUrl: '/studio/bazaar/sales' });
  });
}

/** 키 하나에 한 번만(system_setting 선점). 선점에 성공하면 true. */
export async function claimOnce(key: string, memo: string): Promise<boolean> {
  const r = await prisma.systemSetting
    .createMany({ data: [{ key, value: { at: new Date().toISOString() } as Prisma.InputJsonValue, memo }], skipDuplicates: true })
    .catch(() => ({ count: 0 }));
  return r.count === 1;
}

/** 매칭 수락 기한 하루 전 재알림(기관, 제안당 1회) */
export async function remindExpiringMatches(now = new Date()) {
  const soon = await prisma.inKindMatch.findMany({
    where: { status: 'PROPOSED', deadline: { gt: now, lte: new Date(now.getTime() + 86_400_000) } },
    select: { id: true, donationId: true, merchantId: true, deadline: true },
    take: 200,
  });
  let sent = 0;
  for (const m of soon) {
    if (!(await claimOnce(`bazaar-match-remind:${m.id}`, '바자회 매칭 기한 재알림 1회'))) continue;
    await notifyMatchProposed(m.donationId, m.merchantId, m.deadline);
    sent += 1;
  }
  return sent;
}
