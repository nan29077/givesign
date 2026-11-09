import { prisma } from '@/server/db';
import { decrypt } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { resolveReplyLink, replyLinkPayer, type ReplyLinkRow } from './mo-commands';
import type { SelfServiceScope } from './donor-self-service';
import { receiptScheduleNote } from './receipt-schedule';
import * as tpl from './mt-templates';

/**
 * 문자 명령 링크(/mo/[토큰]) 화면이 쓰는 범위·조회 (2026-11-12 4차 K3).
 *
 *  - 링크는 받은 번호의 후원자 + 그 기관으로만 한정한다(기관 후원 회원 화면과 같은 범위).
 *  - 본인 확인은 2차 F 재확인 기구(self-service-stepup, 대상 SMS_LINK)를 그대로 쓴다. 확인을 마친 브라우저만 화면을 연다(mo-link-cookie).
 *  - 정기후원 변경·해지는 2차 F 셀프서비스 함수(applyRecurringChange)만 부른다 — 문자 분류만으로 처리하지 않는다.
 *    처리 결과는 정보성 문자로 한 번 알린다(notifySmsRecurringResult).
 */

const SCOPE_KINDS = ['CHANGE', 'CANCEL'];

/** 정기후원 관리 범위(변경·해지 링크만). 링크 만료·후원자 없음이면 null. */
export async function smsReplyLinkScope(token: string): Promise<Extract<SelfServiceScope, { via: 'SMS' }> | null> {
  const r = await resolveReplyLink(token);
  if (!r.ok || !SCOPE_KINDS.includes(r.link.kind) || !r.link.merchantId) return null;
  const payer = await replyLinkPayer(r.link);
  if (!payer) return null;
  return { via: 'SMS', linkId: r.link.id, merchantId: r.link.merchantId, payerId: payer.id };
}

/** 정기후원 변경·해지 결과 문자(정보성). 실패해도 변경 결과는 그대로다. */
export async function notifySmsRecurringResult(scope: Extract<SelfServiceScope, { via: 'SMS' }>, recurringId: string, message: string): Promise<void> {
  try {
    const [payer, merchant] = await Promise.all([
      prisma.payerProfile.findUnique({ where: { id: scope.payerId }, select: { phoneEnc: true } }),
      prisma.merchantProfile.findUnique({ where: { id: scope.merchantId }, select: { displayName: true } }),
    ]);
    if (!payer?.phoneEnc || !merchant) return;
    const { sendMt } = await import('./charge-flow');
    await sendMt({ phone: decrypt(payer.phoneEnc), template: tpl.tplRecurringSelfResult({ merchantName: merchant.displayName, text: message }), merchantId: scope.merchantId });
  } catch (e) {
    logger.warn('정기후원 변경 결과 문자 실패 — 변경은 유지됩니다', { recurringId, message: (e as Error).message });
  }
}

/** 명령 링크 화면 공통 정보 */
export async function replyLinkContext(link: ReplyLinkRow) {
  const merchant = link.merchantId
    ? await prisma.merchantProfile.findUnique({ where: { id: link.merchantId }, select: { id: true, code: true, displayName: true, receiptCycle: true, status: true } })
    : null;
  const payer = await replyLinkPayer(link);
  return { merchant, payer };
}

/** 영수증 화면: 그 기관에서 이 후원자에게 발급한 영수증 + 영수증 정보 등록 여부 + 발급 시기 안내 */
export async function smsReceiptSummary(merchantId: string, payerId: string, receiptCycle: string | null) {
  const [receipts, profile] = await Promise.all([
    prisma.donationReceipt.findMany({
      where: { merchantId, payerId },
      orderBy: [{ taxYear: 'desc' }, { issuedAt: 'desc' }],
      take: 10,
      select: { id: true, taxYear: true, receiptNo: true, totalAmount: true, status: true, issuedAt: true },
    }),
    prisma.payerReceiptProfile.findUnique({ where: { payerId }, select: { payerId: true } }),
  ]);
  return { receipts, profileRegistered: Boolean(profile), schedule: receiptScheduleNote(receiptCycle) };
}
