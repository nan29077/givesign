import { prisma } from '@/server/db';
import { initialPointStatus } from './point-status';
import { newId, newOrderNo, newTransactionNo } from '@/lib/id';
import { decrypt, encrypt, maskPhone, normalizePhone, phoneHash as hashPhone } from '@/lib/crypto';
import { payerDisplayName } from '@/lib/payer-name';
import { logger } from '@/lib/logger';
import { env, allowLegacyConfirmLink, featureVolunteerEnabled } from '@/lib/env';
import { reservedKeywordKind } from '@/lib/fundraising';
import { kv } from '@/server/redis';
import type { MoInbound } from '@/server/adapters/mo';
import { getMtAdapter, decideMessageType } from '@/server/adapters/mt';
import { getPaymentAdapter, MockPaymentTimeout } from '@/server/adapters/payment';
import { filterContent, normalizeKeyword, normalizeText, splitKeyword, type BannedWordRule } from './content-filter';
import { donationMeta, matchCampaignKeyword } from './fundraising';
import { campaignThanksText, endedCampaignRejectingSafe } from './campaign-after-end';
import { resolveAlimtalkRoute, sendAlimtalk } from './alimtalk';
import { emitMerchantEvent } from './webhooks';
import { emitChargePaid } from './charge-events';
import { checkLimits, commitCounters, rollbackCounters, registerFailure, clearFailures, resolvePolicy } from './limits';
import { withAdvisoryLock } from '@/server/db';
import { consumeRateLimit } from '@/server/rate-limit';
import { acquireIdempotency } from './idempotency';
import { issueSecureLink, LINK_TTL_SEC } from './secure-link';
import { DOCUMENT_LINK_TTL_DAYS, ensureDocumentSubmission, isDocumentProduct } from './documents';
import * as tpl from './mt-templates';
import { calculateFees, postChargeSettlement } from './settlement';
import { notifySuperAdmins } from './notifications';
import { recordChargeStatusStep, recordFunnelStep } from './funnel';
import { handleMoCommand, moIntentHint, recordCommandStep, suggestForUnknownRoute } from './mo-commands';
import { tagMoFlowPromo } from './promo-codes';
import { prefersSmsOnly } from './outbound/preferred-channel';
import { cardTransactionProvider, type CardPaymentAdapter } from '@/server/adapters/payment/card';
import { calculateCardFees } from './card-fees';
import type { ChargeStatus, MoProcessResult, PaymentMode, PaymentTxStatus } from '@/generated/prisma/enums';
import type { TemplateOutput } from './mt-templates';

/** 결제 안내 문자에 담기는 메시지 최대 길이 */
const MAX_MESSAGE_LEN = 80;

/**
 * MO 수신 → 결제 거래 → 결제 → 후원 반영으로 이어지는 핵심 흐름.
 *
 * 절대 원칙
 *  1) 결제 성공 건만 사회복지기관에 후원으로 반영한다.
 *  2) 결제 성공과 후원 반영 성공을 같은 상태로 취급하지 않는다.
 *  3) 같은 MO 가 재전송되어도 결제가 중복 승인되지 않는다.
 */

export interface MoHandleResult {
  result: MoProcessResult;
  moMessageId?: string;
  chargeId?: string;
  status?: ChargeStatus;
  message: string;
}

// ---------------------------------------------------------------------------
// 보조
// ---------------------------------------------------------------------------

/**
 * MT 문자 1건 발송 + 발송 이력(MtOutboundMessage) 기록.
 *
 * 발송 이력의 행 id 까지 돌려준다. 사회복지기관 API 발송은 이 id 로 상태를 조회하므로
 * boolean 만으로는 부족하다. 기존 호출부는 아래 `sendMt` 래퍼를 그대로 쓴다.
 * 어댑터 예외는 내부에서 흡수해 이력만 FAILED 로 남긴다.
 */
async function sendMtDetailed(input: {
  phone: string;
  template: TemplateOutput;
  chargeId?: string | null;
  merchantId?: string | null;
  /** 사회복지기관 API 발송의 멱등키. 시스템 발송에는 없다. */
  idempotencyKey?: string | null;
  /** 사회복지기관이 API 로 직접 보낸 문자인지. */
  merchantSent?: boolean;
  /**
   * 발송 이력에 남길 템플릿 코드. 지정하지 않으면 템플릿의 코드를 그대로 쓴다.
   * 사회복지기관 발송은 어느 사회복지기관 템플릿이었는지 남겨야 해서 따로 넘긴다.
   */
  templateCodeLabel?: string | null;
}): Promise<{ ok: boolean; id: string; channel: 'SMS' | 'ALIMTALK'; fallback: boolean }> {
  const adapter = getMtAdapter();
  // 관리자가 화면에서 저장한 본문이 있으면 그 문구로 바꿔 보낸다.
  // (조회 실패 시에는 원본 템플릿이 그대로 돌아오므로 발송 자체는 막히지 않는다)
  const template = await tpl.applyMtTemplateOverride(input.template);

  // 알림톡 경로: 기관 채널이 관리자 확인(ACTIVE)이고 템플릿 코드가 있으면 알림톡을 먼저 보낸다.
  // 기관이 API 로 직접 보내는 문자는 기관이 검수받은 문자 템플릿이라 알림톡으로 바꾸지 않는다.
  // 알림톡이 실패하면 아래 문자 경로로 그대로 대체 발송한다(fallback=true 로 기록).
  let fallback = false;
  let route = input.merchantSent ? null : await resolveAlimtalkRoute(input.merchantId, template.code).catch(() => null);
  // 후원자가 문자만 받겠다고 했으면 알림톡을 쓰지 않는다(preferred_channel, 2026-11-09 D2-4). 알림톡 경로가 있을 때만 조회한다.
  if (route && (await prefersSmsOnly(input.phone))) route = null;
  // 발송 이력 행은 **발송 전에** 만든다(문자 경로와 같은 순서). 보낸 뒤에 만들면 생성이 실패했을 때
  // "보냈지만 기록 없는" 건이 생기고, 예외가 호출부로 번져 월간 안내 등이 실패로 집계된다.
  // 알림톡이 실패하면 같은 행을 문자 대체 발송(fallback=true)으로 바꿔 이어 쓴다.
  let row: { id: string } | null = null;
  if (route) {
    row = await prisma.mtOutboundMessage.create({
      data: {
        id: newId(),
        phoneHash: hashPhone(input.phone),
        phoneEnc: encrypt(normalizePhone(input.phone)),
        phoneMasked: maskPhone(input.phone),
        fromNumber: env.mt.fromNumber,
        messageType: decideMessageType(template.text),
        templateCode: input.templateCodeLabel ?? template.code,
        bodyMasked: template.masked,
        chargeId: input.chargeId ?? null,
        merchantId: input.merchantId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        merchantSent: input.merchantSent ?? false,
        channel: 'ALIMTALK',
      },
    });
    // sendAlimtalk 은 어댑터 예외도 결과 값으로 돌려준다(예외를 던지지 않는다).
    const at = await sendAlimtalk(normalizePhone(input.phone), route, template.text);
    if (at.ok) {
      // 이미 발송(접수)됐다. 이후 기록 갱신이 실패해도 발송 결과를 바꾸지 않는다.
      // 솔라피처럼 접수만 하는 공급자는 ACCEPTED 로 두고, 전달 결과는 alimtalk-reports 배치가 확인한다.
      // 그 배치가 명시적 실패 코드를 받으면 같은 본문을 문자로 한 번 대체한다(fallback=true) — 그래서 원문 암호문을 잠시 둔다.
      // (2026-11-06 점검 A-5: 예전에는 접수 2000 을 SENT 로 적어 카카오 전달 실패가 묻혔다)
      const now = new Date();
      const accepted = at.pendingReport;
      await prisma.mtOutboundMessage
        .update({
          where: { id: row.id },
          data: accepted
            ? {
                status: 'ACCEPTED',
                providerCode: `alimtalk:${at.provider}`,
                providerMessageId: at.messageId,
                attempts: { increment: 1 },
                acceptedAt: now,
                bodyEnc: encrypt(template.text),
              }
            : {
                status: 'SENT',
                providerCode: `alimtalk:${at.provider}`,
                providerMessageId: at.messageId,
                attempts: { increment: 1 },
                sentAt: now,
              },
        })
        .catch((e) => logger.error('알림톡 발송 이력 갱신 실패', { id: row!.id, message: (e as Error).message }));
      if (input.chargeId) {
        await prisma.charge
          .update({ where: { id: input.chargeId }, data: { mtStatus: accepted ? 'ACCEPTED' : 'SENT' } })
          .catch((e) => logger.error('결제 건 문자 상태 갱신 실패', { chargeId: input.chargeId, message: (e as Error).message }));
      }
      return { ok: true, id: row.id, channel: 'ALIMTALK', fallback: false };
    }
    fallback = true;
    logger.warn('알림톡 발송 실패 — 문자로 대체합니다', { template: template.code, code: at.code });
    await prisma.mtOutboundMessage.update({
      where: { id: row.id },
      data: { channel: 'SMS', fallback: true },
    });
  }

  row ??= await prisma.mtOutboundMessage.create({
    data: {
      id: newId(),
      phoneHash: hashPhone(input.phone),
      phoneEnc: encrypt(normalizePhone(input.phone)),
      phoneMasked: maskPhone(input.phone),
      fromNumber: env.mt.fromNumber,
      messageType: decideMessageType(template.text),
      templateCode: input.templateCodeLabel ?? template.code,
      bodyMasked: template.masked,
      chargeId: input.chargeId ?? null,
      merchantId: input.merchantId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      merchantSent: input.merchantSent ?? false,
      channel: 'SMS',
      fallback,
    },
  });

  try {
    const res = await adapter.send({ to: normalizePhone(input.phone), text: template.text, templateCode: template.code });
    await prisma.mtOutboundMessage.update({
      where: { id: row.id },
      data: {
        status: res.ok ? 'SENT' : 'FAILED',
        providerCode: adapter.info().provider,
        providerMessageId: res.data?.providerMessageId ?? null,
        resultCode: res.code ?? null,
        resultMessage: res.message ?? null,
        attempts: { increment: 1 },
        sentAt: res.ok ? new Date() : null,
      },
    });
    if (input.chargeId) {
      await prisma.charge.update({
        where: { id: input.chargeId },
        data: { mtStatus: res.ok ? 'SENT' : 'FAILED' },
      });
    }
    return { ok: res.ok, id: row.id, channel: 'SMS', fallback };
  } catch (e) {
    await prisma.mtOutboundMessage.update({
      where: { id: row.id },
      data: { status: 'FAILED', resultMessage: (e as Error).message, attempts: { increment: 1 } },
    });
    logger.error('MT 발송 실패', { message: (e as Error).message });
    return { ok: false, id: row.id, channel: 'SMS', fallback };
  }
}

/**
 * 기존 호출부용 얇은 래퍼. 발송 성공 여부만 돌려준다.
 * (MO 흐름 외에 PC 웹 가입 안내에서도 같은 이력 규칙을 쓴다 — 파일 하단에서 export)
 */
async function sendMt(input: {
  phone: string;
  template: TemplateOutput;
  chargeId?: string | null;
  merchantId?: string | null;
}): Promise<boolean> {
  return (await sendMtDetailed(input)).ok;
}

/**
 * 결제 결과 미확인(UNKNOWN) 건을 관리자 확인 큐에 올린다.
 *
 * 출금이 실제로 일어났는지 앱이 알 수 없는 상태이므로, 사람이 결제사 원장과
 * 대사해서 승인/실패를 확정해야 한다. 같은 거래로 여러 번 올라오지 않도록
 * 미해결 건이 이미 있으면 새로 만들지 않는다.
 */
async function raiseUnknownPaymentAlert(
  chargeId: string,
  transactionId: string,
  orderNo: string,
  amount: bigint,
) {
  try {
    const existing = await prisma.riskDetection.findFirst({
      where: { chargeId, type: 'PAYMENT_UNKNOWN', resolved: false },
      select: { id: true },
    });
    if (existing) return;
    await prisma.riskDetection.create({
      data: {
        id: newId(),
        chargeId,
        type: 'PAYMENT_UNKNOWN',
        level: 'CRITICAL',
        detail: {
          transactionId,
          orderNo,
          amount: amount.toString(),
          note: '결제 승인 결과를 확인하지 못했습니다. 결제사 원장과 대사한 뒤 승인/실패를 확정해 주세요.',
        } as object,
      },
    });

    // 화면을 열어보기 전에도 알 수 있도록 최고관리자 알림함에도 올린다.
    // 이 건은 후원자 통장에서 돈이 빠졌을 수 있어 대사가 늦을수록 손해가 커진다.
    await notifySuperAdmins({
      title: '결제 결과를 확인하지 못한 건이 있습니다',
      body: `주문번호 ${orderNo} · ${amount.toString()}원. 결제사 원장과 대사한 뒤 승인/실패를 확정해 주세요.`,
      linkUrl: '/admin/payments',
    });
  } catch (e) {
    // 알림 생성 실패가 결제 처리 흐름을 막으면 안 된다. 로그로만 남긴다.
    logger.error('결제 미확인 알림 생성 실패', { chargeId, message: (e as Error).message });
  }
}

/** 승인 결과를 아직 모르는(결제사에 요청이 나갔을 수 있는) 결제 거래 상태 */
const IN_FLIGHT_TXN: PaymentTxStatus[] = ['REQUESTED', 'TIMEOUT', 'UNKNOWN'];
/** 승인 요청 전 단계의 결제 상태. 이 상태에서 진행 중 거래가 발견되면 PENDING_PAYMENT 로 올려 대사한다. */
const PRE_PAYMENT_STATUSES: ChargeStatus[] = ['RECEIVED', 'PENDING_PIN', 'PENDING_CONFIRM'];

/**
 * 결제 거래를 결과 미확인(UNKNOWN)으로 올리고 관리자 대사 큐에 넣는다.
 *
 * 돈이 빠졌을 수 있는 건이므로 실패로 닫지 않는다. 결제 건은 PENDING_PAYMENT 로 유지(사유만 기록)하고
 * 한도 예약도 되돌리지 않는다. 어떤 기록이 실패해도 예외를 던지지 않는다 — 여기서 던지면
 * 거래가 REQUESTED 에 남아 대사 큐에서 사라진다. 남은 건은 정리 배치(escalateStalePaymentTransactions)가 다시 올린다.
 */
async function markPaymentUnknown(
  chargeId: string,
  txn: { id: string; orderNo: string },
  amount: bigint,
  resultCode: string,
  resultMessage: string | null,
) {
  await prisma.paymentTransaction
    .updateMany({
      where: { id: txn.id, status: { in: IN_FLIGHT_TXN } },
      data: { status: 'UNKNOWN', resultCode, resultMessage: resultMessage?.slice(0, 500) ?? null },
    })
    .catch((e) => logger.error('결제 거래 UNKNOWN 전이 실패', { chargeId, transactionId: txn.id, message: (e as Error).message }));
  try {
    const cur = await prisma.charge.findUnique({ where: { id: chargeId }, select: { status: true } });
    if (cur && PRE_PAYMENT_STATUSES.includes(cur.status)) {
      // 수동 대사는 PENDING_PAYMENT 결제만 확정할 수 있다. 승인 단계 전 상태에 머문 건은 올려 둔다.
      await setStatus(chargeId, 'PENDING_PAYMENT', '결제 결과 미확인 — 관리자 확인 대기');
    } else if (cur?.status === 'PENDING_PAYMENT') {
      await prisma.charge.update({ where: { id: chargeId }, data: { statusReason: '결제 결과 미확인 — 관리자 확인 대기' } });
    }
  } catch (e) {
    logger.error('결제 건 미확인 사유 기록 실패', { chargeId, message: (e as Error).message });
  }
  await raiseUnknownPaymentAlert(chargeId, txn.id, txn.orderNo, amount);
}

async function setStatus(chargeId: string, to: ChargeStatus, reason?: string, actor = 'system') {
  const cur = await prisma.charge.findUnique({ where: { id: chargeId }, select: { status: true } });
  await prisma.$transaction([
    prisma.charge.update({ where: { id: chargeId }, data: { status: to, statusReason: reason ?? null } }),
    prisma.chargeStatusLog.create({
      data: { id: newId(), chargeId, fromStatus: cur?.status ?? null, toStatus: to, reason: reason ?? null, actor },
    }),
  ]);
  await recordChargeStatusStep(chargeId, to, reason); // 단계 측정(2026-11-09) — 실패해도 예외 없음
}

export async function loadBannedWords(merchantId: string): Promise<BannedWordRule[]> {
  const rows = await prisma.bannedWord.findMany({
    where: { active: true, OR: [{ scope: 'GLOBAL' }, { merchantId }] },
    select: { word: true, action: true },
  });
  // 금칙어는 더 이상 결제를 막지 않는다. 지난 정책으로 남아 있는 BLOCK 규칙도
  // 마스킹으로 취급해, 기록에서는 가리되 결제는 그대로 진행시킨다.
  return rows.map((r) => ({ word: r.word, action: r.action === 'BLOCK' ? 'MASK' : r.action }));
}

/** 수신번호(+키워드)로 사회복지기관을 찾는다. */

/**
 * 문자 본문 맨 앞의 "N원" 표기를 금액으로 해석하는 파서.
 *
 * 현재 MO 수신 흐름에서는 **호출하지 않는다.**
 * 모바일 문자 결제는 사회복지기관이 설정한 고정 금액만 사용하며, 본문의 금액 표기가
 * 결제 금액을 덮어쓰지 않도록 processMoRow 의 호출부를 비활성화했다.
 * 금액을 직접 지정하는 결제는 PC 웹 경로(web-charge)에서 화면 입력값으로 처리한다.
 * 파서 자체는 향후 재도입·이력 분석을 위해 남겨 둔다.
 *
 * 예) "5000원 오늘도 화이팅" → amount 5000, rest "오늘도 화이팅"
 *     "1,000원" → amount 1000, rest ""
 */
export function parseExplicitAmount(body: string): { amount: bigint | null; rest: string } {
  const m = body.match(/^\s*(\d{1,3}(?:,\d{3})+|\d{3,7})원(?=\s|$)/u);
  if (!m) return { amount: null, rest: body };
  const digits = m[1].replace(/,/g, '');
  try {
    return { amount: BigInt(digits), rest: body.slice(m[0].length).trim() };
  } catch {
    return { amount: null, rest: body };
  }
}

export async function routeMerchant(receivedNumber: string, content: string) {
  const number = normalizePhone(receivedNumber) || receivedNumber;

  // 같은 번호에 걸린 배정 행을 한 번에 읽는다.
  // 전용(DEDICATED)과 대표번호공유(SHARED_PREFIX)가 같은 번호에 공존하면
  // 전용이 먼저 매칭돼 대표번호를 쓰던 모든 사회복지기관의 결제가 전용 사회복지기관
  // 1명에게 흘러들어간다. 후원자도 사회복지기관도 알아챌 수 없는 사고이므로
  // 라우팅을 진행하지 않고 차단한 뒤 관리자에게 알린다.
  const rows = await prisma.merchantMoNumber.findMany({
    where: { phoneNumber: number, status: 'ASSIGNED', merchantId: { not: null } },
    include: { merchant: true },
    orderBy: { assignedAt: 'desc' },
  });

  const dedicatedRows = rows.filter((r) => r.mode === 'DEDICATED');
  const sharedRows = rows.filter((r) => r.mode === 'SHARED_PREFIX');

  if (dedicatedRows.length > 1 || (dedicatedRows.length > 0 && sharedRows.length > 0)) {
    logger.error('MO 번호 라우팅 충돌 — 배정 설정을 정리해야 합니다', {
      phoneNumber: number,
      dedicated: dedicatedRows.length,
      shared: sharedRows.length,
      merchants: rows.map((r) => r.merchant?.code).filter(Boolean),
    });
    return null;
  }

  // 1) 전용번호 우선
  const dedicated = dedicatedRows[0];
  if (dedicated?.merchant) {
    return { route: dedicated, merchant: dedicated.merchant, keyword: null as string | null, body: content };
  }

  // 2) 대표번호 + 키워드
  const { keyword, rest } = splitKeyword(content);
  if (keyword) {
    // 저장된 키워드도 같은 규칙으로 접어서 비교한다.
    // 정규화 규칙을 통일하기 전에 등록된 행("GIV-1234" 처럼 기호가 남은 값)도 그대로 매칭된다.
    const shared = sharedRows.find((r) => normalizeKeyword(r.keyword) === keyword);
    if (shared?.merchant) {
      return { route: shared, merchant: shared.merchant, keyword, body: rest };
    }
  }

  return null;
}

async function getOrCreatePayer(phone: string) {
  const ph = hashPhone(phone);
  // upsert 는 이 형태에서 원자적이지 않다(조회 → 없으면 INSERT). 같은 새 번호로 MO 가
  // 동시에 들어오면 두 요청이 모두 "행 없음" 을 보고 INSERT 해 유니크 위반이 난다.
  // 먼저 조회하고, 생성이 유니크 위반으로 실패하면 이긴 쪽이 만든 행을 다시 읽는다.
  const existing = await prisma.payerProfile.findUnique({ where: { phoneHash: ph } });
  if (existing) return existing;

  try {
    return await prisma.payerProfile.create({
      data: {
        id: newId(),
        phoneHash: ph,
        phoneEnc: encrypt(normalizePhone(phone)),
        phoneMasked: maskPhone(phone),
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    return prisma.payerProfile.findUniqueOrThrow({ where: { phoneHash: ph } });
  }
}

/** 같은 전화번호의 동시 MO 중 한 요청만 최초 가입 안내 발송권을 얻는다. */
async function claimRegistrationGuide(payerId: string) {
  const claimedAt = new Date();
  const claimed = await prisma.payerProfile.updateMany({
    where: { id: payerId, onboardingStatus: 'UNREGISTERED' },
    data: { onboardingStatus: 'LINK_SENT', registrationLinkSentAt: claimedAt },
  });
  return { claimed: claimed.count === 1, claimedAt };
}

async function releaseRegistrationGuideClaim(payerId: string, claimedAt: Date) {
  await prisma.payerProfile.updateMany({
    where: { id: payerId, onboardingStatus: 'LINK_SENT', registrationLinkSentAt: claimedAt },
    data: { onboardingStatus: 'UNREGISTERED', registrationLinkSentAt: null },
  });
}

/**
 * 등록 후원자의 MO 속도 제한.
 *
 * 두 겹으로 본다.
 *
 *  1) **직전 링크가 아직 유효한가** (정확한 판정)
 *     같은 사회복지기관·같은 후원자에게 이미 금액 선택 대기(PENDING_AMOUNT) 결제가 있고 그 링크가
 *     아직 만료되지 않았다면, 문자를 한 통 더 보낼 이유가 없다. 후원자는 이미 링크를 들고 있다.
 *     링크가 만료된 뒤의 문자는 정상적으로 새 링크를 받는다(막다른 길을 만들지 않는다).
 *
 *  2) **폭주 상한** (안전판)
 *     1)만으로는 링크를 매번 소진(결제/실패)시키며 문자를 반복하는 경우를 막지 못한다.
 *     사회복지기관 × 번호 단위로 창(기본 30분) 안의 건수를 세어 상한(기본 10건)을 넘으면 끊는다.
 *     정상 후원자가 닿을 수 없는 값으로 잡아, 실수로 결제를 막는 일이 없게 한다.
 *     `MO_CHARGE_THROTTLE_MAX=0` 이면 이 상한을 쓰지 않는다.
 *
 * @returns 제한에 걸렸으면 기록·응답 문구, 통과면 null
 */
async function checkMoThrottle(
  merchantId: string,
  payerId: string,
  phoneHashValue: string,
  fromNumber: string,
): Promise<{ detail: string; message: string } | null> {
  // (1) 아직 유효한 금액 선택 링크가 있는가.
  const liveSince = new Date(Date.now() - env.payment.selectTtlSec * 1000);
  const pending = await prisma.charge.findFirst({
    where: {
      merchantId,
      payerId,
      status: 'PENDING_AMOUNT',
      createdAt: { gt: liveSince },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, transactionNo: true },
  });
  if (pending) {
    logger.info('MO 속도 제한 — 유효한 금액 선택 링크가 이미 있음', {
      merchantId,
      transactionNo: pending.transactionNo,
      from: maskPhone(fromNumber),
    });
    return {
      detail: `직전 금액 선택 링크 유효 (${pending.transactionNo})`,
      message: '직전에 보낸 결제 링크가 아직 유효합니다. 새 링크를 보내지 않았습니다.',
    };
  }

  // (2) 폭주 상한.
  if (env.mo.chargeThrottleMax <= 0) return null;
  const flood = await consumeRateLimit(
    'mo-charge',
    `${merchantId}:${phoneHashValue}`,
    env.mo.chargeThrottleMax,
    env.mo.chargeThrottleWindowSec,
  );
  if (flood.ok) return null;

  const windowMin = Math.max(1, Math.round(env.mo.chargeThrottleWindowSec / 60));
  logger.warn('MO 속도 제한 — 폭주 상한 초과', {
    merchantId,
    from: maskPhone(fromNumber),
    count: flood.count,
  });
  return {
    detail: `MO 폭주 상한 초과 (${windowMin}분 ${env.mo.chargeThrottleMax}건 / 현재 ${flood.count}건)`,
    message: '단시간에 너무 많은 문자를 보냈습니다. 잠시 후 다시 시도해 주세요.',
  };
}

export function resolvePaymentMode(
  merchantMode: PaymentMode | null,
  allowDirectTrigger: boolean = env.safety.allowDirectTrigger,
): PaymentMode {
  const desired = merchantMode ?? 'CONFIRM_LINK';
  if (desired === 'DIRECT_TRIGGER' && !allowDirectTrigger) {
    // 금융사 서면승인 등록 전에는 DIRECT_TRIGGER 를 사용할 수 없다.
    return 'CONFIRM_LINK';
  }
  return desired;
}

/**
 * CONFIRM_LINK 모드에서 후원자에게 무엇을 보낼지 결정한다.
 *
 *  - `PIN`(기본): 결제사(헥토/카드)가 발급한 PIN 입력 링크를 보낸다.
 *                 PIN 을 입력해야 결제사가 콜백을 보내고 그때 승인이 실행된다.
 *  - `LEGACY_LINK`(**deprecated**): 기브싸인 자체 확인 페이지 링크를 보낸다.
 *                 확인 버튼을 누르면 빌키로 곧바로 승인한다.
 *                 되돌림이 필요한 경우에만 ALLOW_LEGACY_CONFIRM_LINK=true 로 연다.
 */
export type ConfirmChannel = 'PIN' | 'LEGACY_LINK';

export function resolveConfirmChannel(allowLegacy: boolean = allowLegacyConfirmLink()): ConfirmChannel {
  return allowLegacy ? 'LEGACY_LINK' : 'PIN';
}

// ---------------------------------------------------------------------------
// MO 수신 처리
// ---------------------------------------------------------------------------

export async function handleMoInbound(inbound: MoInbound): Promise<MoHandleResult> {
  const ph = hashPhone(inbound.fromNumber);

  // (1) 사업자 메시지 ID 기준 중복 차단
  //     사업자 코드를 함께 봐야 한다. 사업자마다 채번 체계가 달라 값이 겹칠 수 있고,
  //     겹치면 다른 사람의 새 문자가 DUPLICATE 로 조용히 버려진다.
  const providerKey = {
    providerCode_providerMessageId: {
      providerCode: inbound.providerCode,
      providerMessageId: inbound.providerMessageId,
    },
  };
  const dup = await prisma.moInboundMessage.findUnique({
    where: providerKey,
    select: { id: true, result: true, charge: { select: { id: true, status: true } } },
  });
  // 이전 수신이 결제 생성 전에 예외로 끝난 건(result=ERROR, 결제 없음)은 사업자 재전송 시 다시 처리한다.
  // 그 외에는 모두 중복으로 막는다.
  const retryable = Boolean(dup && dup.result === 'ERROR' && !dup.charge);
  if (dup && !retryable) {
    return {
      result: 'DUPLICATE',
      moMessageId: dup.id,
      chargeId: dup.charge?.id,
      status: dup.charge?.status,
      message: '이미 처리된 문자입니다. 중복 결제는 발생하지 않습니다.',
    };
  }

  const routed = await routeMerchant(inbound.receivedNumber, inbound.content);

  let moRow;
  try {
    moRow = await createOrReuseMoRow(inbound, routed, ph, dup?.id ?? null);
  } catch (error) {
    // 동시 재전송 경합만 중복으로 본다(유니크 위반 P2002 + 이긴 쪽 행이 실제로 있을 때).
    // DB 순단·암호화 실패 같은 다른 예외를 중복으로 돌려주면, "예외 = 재시도" 로 설계된
    // EMMA 폴링 수신기가 저장되지 않은 문자를 처리 완료로 소비해 문자가 사라진다.
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const again = await prisma.moInboundMessage.findUnique({
      where: providerKey,
      select: { id: true },
    });
    if (!again) throw error;
    return { result: 'DUPLICATE', moMessageId: again.id, message: '중복 수신(경합)으로 무시되었습니다.' };
  }

  try {
    return await processMoRow(inbound, routed, ph, moRow);
  } catch (error) {
    // 예외로 끝난 행을 PENDING 으로 남기면 재전송이 영원히 DUPLICATE 로 막힌다.
    // 결제가 만들어지기 전에 실패한 행만 ERROR 로 표시해 관리자 화면에 드러내고 재전송을 허용한다.
    // (결제가 이미 생긴 뒤의 예외는 결제 상태·결제 기록이 진실이므로 수신 결과를 덮어쓰지 않는다)
    await prisma.moInboundMessage
      .updateMany({
        where: { id: moRow.id, charge: null },
        data: {
          result: 'ERROR',
          resultDetail: `처리 오류: ${(error as Error).message}`.slice(0, 500),
          processedAt: new Date(),
        },
      })
      .catch(() => undefined);
    throw error;
  }
}

type RoutedMerchant = Awaited<ReturnType<typeof routeMerchant>>;

async function createOrReuseMoRow(inbound: MoInbound, routed: RoutedMerchant, ph: string, reuseId: string | null) {
  if (reuseId) {
    return prisma.moInboundMessage.update({
      where: { id: reuseId },
      data: {
        result: 'PENDING',
        resultDetail: null,
        processedAt: null,
        merchantId: routed?.merchant.id ?? null,
        matchedKeyword: routed?.keyword ?? null,
      },
    });
  }
  return prisma.moInboundMessage.create({
      data: {
        id: newId(),
        providerMessageId: inbound.providerMessageId,
        providerCode: inbound.providerCode,
        receivedNumber: inbound.receivedNumber,
        phoneHash: ph,
        phoneEnc: encrypt(normalizePhone(inbound.fromNumber)),
        phoneMasked: maskPhone(inbound.fromNumber),
        messageType: inbound.messageType,
        contentEnc: encrypt(inbound.content),
        attachmentInfo: (inbound.attachments ?? []) as object,
        merchantId: routed?.merchant.id ?? null,
        matchedKeyword: routed?.keyword ?? null,
        receivedAt: inbound.receivedAt,
      },
    });
}

async function processMoRow(
  inbound: MoInbound,
  routed: RoutedMerchant,
  ph: string,
  moRow: { id: string },
): Promise<MoHandleResult> {
  // (2) 라우팅 실패
  if (!routed) {
    await prisma.moInboundMessage.update({
      where: { id: moRow.id },
      data: { result: 'UNKNOWN_ROUTE', resultDetail: '배정된 사회복지기관 없음', processedAt: new Date() },
    });
    // 2026-11-12 4차 K2: 대표번호 공유 문자에서 비슷한 기관·캠페인을 찾으면 고르기 링크로 답한다(결제 건 없음).
    const suggested = await suggestForUnknownRoute({
      receivedNumber: normalizePhone(inbound.receivedNumber) || inbound.receivedNumber,
      body: inbound.content,
      phoneHash: ph,
      moRowId: moRow.id,
      send: (template) => sendMt({ phone: inbound.fromNumber, template }),
    });
    if (suggested.sent) {
      await prisma.moInboundMessage.update({ where: { id: moRow.id }, data: { resultDetail: `배정된 사회복지기관 없음 · 비슷한 캠페인 ${suggested.count}건 고르기 안내` } });
      return { result: 'UNKNOWN_ROUTE', moMessageId: moRow.id, message: '키워드를 알아보지 못해 비슷한 캠페인 고르기 링크를 보냈습니다. 후원 건은 만들지 않았습니다.' };
    }
    await sendMt({ phone: inbound.fromNumber, template: tpl.tplUnknownRoute() });
    return { result: 'UNKNOWN_ROUTE', moMessageId: moRow.id, message: '사회복지기관을 찾을 수 없습니다.' };
  }

  const merchant = routed.merchant;
  // 사회복지기관주 계정이 정지·탈퇴됐으면 결제를 받지 않는다.
  // 공개 결제 페이지(/c/[code])는 이미 user.status 를 확인하는데 문자 경로만 빠져 있으면,
  // 관리자가 계정을 제재해도 문자후원으로 계속 돈이 쌓인다.
  const merchantUser = await prisma.user.findUnique({
    where: { id: merchant.userId },
    select: { status: true, deletedAt: true },
  });
  if (!merchantUser || merchantUser.deletedAt || merchantUser.status !== 'ACTIVE') {
    await prisma.moInboundMessage.update({
      where: { id: moRow.id },
      data: { result: 'BLOCKED', resultDetail: '사회복지기관 계정 정지', processedAt: new Date() },
    });
    await sendMt({ phone: inbound.fromNumber, template: tpl.tplUnknownRoute() });
    return { result: 'BLOCKED', moMessageId: moRow.id, message: '이용할 수 없는 사회복지기관입니다.' };
  }
  if (merchant.status !== 'APPROVED') {
    await prisma.moInboundMessage.update({
      where: { id: moRow.id },
      data: { result: 'BLOCKED', resultDetail: `사회복지기관 상태: ${merchant.status}`, processedAt: new Date() },
    });
    await sendMt({ phone: inbound.fromNumber, template: tpl.tplUnknownRoute() });
    return { result: 'BLOCKED', moMessageId: moRow.id, message: '이용할 수 없는 사회복지기관입니다.' };
  }

  const payer = await getOrCreatePayer(inbound.fromNumber);

  // (2-1) 문자 예약어: '정기' → 정기후원 약정 링크, '봉사' → 자원봉사 신청 링크.
  // 후원(결제) 건을 만들지 않는다. 결제수단 등록 여부와 상관없이 안내 링크만 보낸다
  // (약정 화면이 등록·로그인을 이어서 안내한다).
  const reserved = await handleReservedMoKeyword({ inbound, routed, moRowId: moRow.id, ph });
  if (reserved) return reserved;
  // (2-2) 문자 명령어(2026-11-12 4차 K3): 영수증·내역·변경·해지·문의 → 본인 확인 화면 링크만. 결제 건을 만들지 않는다.
  const command = await handleMoCommand({
    merchant,
    body: routed.body,
    moRowId: moRow.id,
    phoneHash: ph,
    send: (template) => sendMt({ phone: inbound.fromNumber, template, merchantId: merchant.id }),
  });
  if (command) {
    await prisma.moInboundMessage.update({ where: { id: moRow.id }, data: { result: 'ROUTED', resultDetail: command.detail, processedAt: new Date() } });
    return { result: 'ROUTED', moMessageId: moRow.id, message: command.message };
  }
  await recordFunnelStep({ step: 'MO_RECEIVED', moMessageId: moRow.id, merchantId: merchant.id }); // 단계 측정(2026-11-09)
  await tagMoFlowPromo(moRow.id, merchant.id, routed.body); // 홍보물별 수신 집계(2026-11-12 4차 K1, 안전 래퍼)

  // (3) 실제 활성 빌키가 있을 때만 결제 결제로 진행한다.
  const token = await prisma.paymentMethodToken.findFirst({
    where: { payerId: payer.id, status: 'ACTIVE' },
    orderBy: { registeredAt: 'desc' },
  });

  if (!token) {
    await recordFunnelStep({ step: 'BLOCKED', moMessageId: moRow.id, merchantId: merchant.id, reason: 'UNREGISTERED' }); // 단계 측정
    const current = await prisma.payerProfile.findUniqueOrThrow({ where: { id: payer.id } });
    await prisma.moInboundMessage.update({
      where: { id: moRow.id },
      data: {
        result: 'UNREGISTERED_DONOR',
        resultDetail:
          current.onboardingStatus === 'LINK_SENT' ? '가입 안내 발송 완료·가입 대기' : `가입 상태: ${current.onboardingStatus}`,
        processedAt: new Date(),
      },
    });

    // 이전 안내 링크(30분)가 만료됐는데도 LINK_SENT 에 머물면 이후 모든 문자가 영원히 안내 없이 끝난다.
    // 만료 뒤 첫 문자에서 UNREGISTERED 로 되돌려 새 링크를 한 번 더 보낸다.
    if (current.onboardingStatus === 'LINK_SENT' && current.registrationLinkSentAt) {
      const expiredAt = current.registrationLinkSentAt.getTime() + LINK_TTL_SEC.REGISTER_ACCOUNT * 1000;
      if (expiredAt < Date.now()) {
        await prisma.payerProfile.updateMany({
          where: { id: payer.id, onboardingStatus: 'LINK_SENT', registrationLinkSentAt: current.registrationLinkSentAt },
          data: { onboardingStatus: 'UNREGISTERED', registrationLinkSentAt: null },
        });
      }
    }

    const claim = await claimRegistrationGuide(payer.id);
    if (claim.claimed) {
      try {
        const link = await issueSecureLink({
          purpose: 'REGISTER_ACCOUNT',
          phoneHash: ph,
          merchantId: merchant.id,
          payload: { moMessageId: moRow.id },
        });
        const sent = await sendMt({
          phone: inbound.fromNumber,
          template: tpl.tplRegisterGuide(merchant.displayName, link.url),
          merchantId: merchant.id,
        });
        if (!sent) await releaseRegistrationGuideClaim(payer.id, claim.claimedAt);
      } catch (error) {
        await releaseRegistrationGuideClaim(payer.id, claim.claimedAt);
        throw error;
      }
      return {
        result: 'UNREGISTERED_DONOR',
        moMessageId: moRow.id,
        message: '미등록 후원자입니다. 최초 가입 안내를 발송했습니다. 이 문자는 결제 처리되지 않습니다.',
      };
    }

    if (
      current.onboardingStatus === 'REGISTERED' ||
      current.onboardingStatus === 'SUSPENDED' ||
      current.onboardingStatus === 'WITHDRAWN'
    ) {
      if (current.onboardingStatus === 'REGISTERED') {
        await prisma.payerProfile.update({
          where: { id: payer.id },
          data: { onboardingStatus: 'SUSPENDED' },
        });
      }
      await sendMt({
        phone: inbound.fromNumber,
        template: tpl.tplAccountInactive(merchant.displayName),
        merchantId: merchant.id,
      });
      return {
        result: 'UNREGISTERED_DONOR',
        moMessageId: moRow.id,
        message: '내통장결제 이용이 중지된 번호입니다. 결제는 진행되지 않았습니다.',
      };
    }

    return {
      result: 'UNREGISTERED_DONOR',
      moMessageId: moRow.id,
      message: '가입 안내가 이미 발송된 번호입니다. 가입 완료 전 문자는 결제 처리되지 않으며 링크를 다시 보내지 않습니다.',
    };
  }

  // 기존 데이터 이관·복구 상황에서도 활성 빌키가 실제 결제 가능 상태의 기준이다.
  if (payer.onboardingStatus !== 'REGISTERED') {
    await prisma.payerProfile.update({
      where: { id: payer.id },
      data: { onboardingStatus: 'REGISTERED', registeredAt: payer.registeredAt ?? token.registeredAt },
    });
  }

  // (3-1) 등록 후원자의 MO 속도 제한.
  //
  // 미등록 후원자는 onboardingStatus(LINK_SENT)로 안내 문자가 한 번만 나가도록 이미 막혀 있는데,
  // 등록 후원자에게는 그런 장치가 없었다. MO 1건마다 금액 선택 링크 MT 가 한 통 나가므로,
  // 같은 번호가 문자를 연달아 보내면(오해·장난·단말 자동 재전송) 그대로 문자가 폭주하고
  // 쓸 수 없는 PENDING_AMOUNT 결제 행이 함께 쌓인다.
  //
  // 제한에 걸리면 **아무 문자도 보내지 않는다.** "너무 잦습니다" 안내를 보내면 그 자체가
  // 또 한 통이라 제한의 의미가 없다. 수신 기록만 남겨 관리자 화면에 드러낸다.
  const throttled = await checkMoThrottle(merchant.id, payer.id, ph, inbound.fromNumber);
  if (throttled) {
    await recordFunnelStep({ step: 'BLOCKED', moMessageId: moRow.id, merchantId: merchant.id, reason: 'LIMIT' }); // 단계 측정
    await prisma.moInboundMessage.update({
      where: { id: moRow.id },
      data: { result: 'BLOCKED', resultDetail: throttled.detail, processedAt: new Date() },
    });
    return { result: 'BLOCKED', moMessageId: moRow.id, message: throttled.message };
  }

  // (4) 콘텐츠 필터
  // 문자 본문은 외부에 노출되지 않고 사회복지기관·최고관리자만 문자 관리에서 본다.
  // 그래서 금칙어는 결제를 막지 않고 기록만 마스킹한다(filtered.clean 이 마스킹된 값이다).
  // (4-1) 캠페인 키워드. 문자 맨 앞에 모금 중인 캠페인의 키워드가 있으면 지정후원으로 잡고
  // 키워드는 메시지에서 떼어 낸다. 키워드가 없거나 모금이 끝났으면 기관 일반 후원이다.
  const campaignMatch = await matchCampaignKeyword(merchant.id, routed.body);
  // (4-2) 끝난 캠페인 중 "종료 후 받지 않기"(REJECT)를 고른 캠페인 키워드면 결제를 만들지 않고 안내만 보낸다(2026-11-12 4차 I).
  // 기본(GENERAL)·판단 실패는 예전처럼 기관 일반 후원으로 처리된다.
  if (!campaignMatch.campaign) {
    const ended = await endedCampaignRejectingSafe(merchant.id, routed.body);
    if (ended) {
      await prisma.moInboundMessage.update({
        where: { id: moRow.id },
        data: { result: 'BLOCKED', resultDetail: `CAMPAIGN_ENDED: 종료 후 후원을 받지 않는 캠페인(${ended.code})`, processedAt: new Date() },
      });
      await sendMt({ phone: inbound.fromNumber, template: tpl.tplCampaignEnded(merchant.displayName, ended.title), merchantId: merchant.id });
      return { result: 'BLOCKED', moMessageId: moRow.id, message: '모금이 끝난 캠페인 키워드입니다. 후원으로 처리하지 않고 안내 문자만 보냈습니다.' };
    }
  }
  const messageBody = campaignMatch.campaign ? campaignMatch.rest : routed.body;

  const bannedWords = await loadBannedWords(merchant.id);
  const filtered = filterContent(messageBody, {
    bannedWords,
    maxLength: MAX_MESSAGE_LEN,
  });

  // 이름을 설정하지 않았으면 번호 끝 4자리로 만든 기본 이름을 쓴다 (예: 후원자5678).
  // 이 값은 결제 시점에 박제되므로, 나중에 이름을 바꿔도 과거 내역은 그대로 남는다.
  const displayName = payerDisplayName(payer.displayName, inbound.fromNumber);

  // (5) 결제 거래 생성 (멱등)
  //
  // MO 문자에는 금액이 없다. 후원자가 링크에서 후원 금액을 고른 뒤에야 금액이 정해지므로
  // 여기서는 금액 0 · PENDING_AMOUNT 로 만들어 두고, 금액 확정 시점에 채운다.
  // 한도 확인도 금액이 정해지는 그때 한다(금액 없이 한도를 볼 수 없다).
  // 멱등키에도 사업자 코드를 넣는다. 사업자별 채번이 겹칠 때 서로 다른 문자가
  // 같은 키를 만들어 두 번째 결제가 DUPLICATE 로 사라지는 것을 막는다.
  const idem = await acquireIdempotency(
    'charge',
    `${merchant.id}:${inbound.providerCode}:${inbound.providerMessageId}`,
  );
  if (idem.status === 'DUPLICATE') {
    return {
      result: 'DUPLICATE',
      moMessageId: moRow.id,
      chargeId: idem.resourceId ?? undefined,
      message: '이미 생성된 결제 거래입니다.',
    };
  }

  let charge;
  try {
    charge = await prisma.charge.create({
      data: {
        id: newId(),
        transactionNo: newTransactionNo(),
        merchantId: merchant.id,
        payerId: payer.id,
        moMessageId: moRow.id,
        amount: 0n,
        displayName,
        message: filtered.clean,
        messageRawEnc: encrypt(routed.body),
        status: 'PENDING_AMOUNT',
        statusReason: campaignMatch.campaign ? `후원 금액 선택 대기 (캠페인 ${campaignMatch.campaign.code})` : '후원 금액 선택 대기',
        paymentMode: 'CONFIRM_LINK',
        pointStatus: initialPointStatus(),
        campaignId: campaignMatch.campaign?.id ?? null,
        promoId: campaignMatch.promo?.id ?? null, // 홍보물 키워드(2026-11-12 4차 K1)
        // 유입 경로: 문자 후원은 캠페인 키워드 매칭 여부와 무관하게 SMS 로 남긴다(CLAUDE.md 11항).
        source: 'SMS',
      },
    });
  } catch (error) {
    // 결제 생성에 실패했는데 멱등키를 IN_PROGRESS 로 남기면 TTL(7일) 동안
    // 재전송이 전부 DUPLICATE 로 막혀 문자가 유실된다. 키를 지워 재시도를 허용한다.
    await idem.abort();
    throw error;
  }
  await idem.release(charge.id);

  await prisma.moInboundMessage.update({
    where: { id: moRow.id },
    data: { result: 'ROUTED', contentFiltered: filtered.clean, processedAt: new Date() },
  });

  // 웹훅. 이 시점에는 아직 결제가 일어나지 않았다(후원자가 문자를 보낸 단계).
  await emitMerchantEvent(merchant.id, 'mo.received', {
    transactionNo: charge.transactionNo,
    text: filtered.clean,
    receivedAt: new Date().toISOString(),
  });

  // (6) 후원자가 차단됐는지 먼저 본다.
  // 금액과 무관하게 결정되므로 링크를 보내기 전에 확인해 헛걸음을 막는다.
  const blocked = await prisma.blockedPayer.findUnique({
    where: { merchantId_payerId: { merchantId: merchant.id, payerId: payer.id } },
  });
  if (blocked) {
    await setStatus(charge.id, 'LIMIT_BLOCKED', 'BLOCKED_DONOR: 사회복지기관이 차단한 후원자');
    await sendMt({
      phone: inbound.fromNumber,
      template: tpl.tplLimitBlocked(merchant.displayName, '사회복지기관이 차단한 번호입니다.'),
      chargeId: charge.id,
      merchantId: merchant.id,
    });
    return {
      result: 'BLOCKED',
      moMessageId: moRow.id,
      chargeId: charge.id,
      status: 'LIMIT_BLOCKED',
      message: '사회복지기관이 차단한 번호입니다.',
    };
  }

  // (7) 고를 수 있는 금액이 하나도 없으면 링크를 보내도 막다른 길이다.
  const usableProducts = await prisma.chargeProduct.count({
    where: { merchantId: merchant.id, active: true, archivedAt: null },
  });
  if (usableProducts === 0 && !merchant.allowCustomAmount) {
    await setStatus(charge.id, 'PAYMENT_FAILED', '후원 항목 미설정');
    await sendMt({
      phone: inbound.fromNumber,
      template: tpl.tplChargeFailed(merchant.displayName, '후원 항목이 준비되지 않았습니다.'),
      chargeId: charge.id,
      merchantId: merchant.id,
    });
    return {
      result: 'BLOCKED',
      moMessageId: moRow.id,
      chargeId: charge.id,
      status: 'PAYMENT_FAILED',
      message: '사회복지기관의 후원 항목이 준비되지 않았습니다.',
    };
  }

  // (8) 상품·금액 선택 링크 발송. 이 문자만으로는 출금이 일어나지 않는다.
  // 금액 선택 화면에 미리 골라 둘 캠페인·금액(2026-11-12 4차 K2 — 미리 선택만, 확정은 후원자가 화면에서)
  const intentHint = await moIntentHint(merchant.id, routed.body, campaignMatch);
  const link = await issueSecureLink({
    purpose: 'SELECT_AMOUNT',
    phoneHash: ph,
    merchantId: merchant.id,
    chargeId: charge.id,
    ...(intentHint ? { payload: { intent: intentHint } } : {}),
  });
  // 안내 문자에 상품 이름을 몇 개 넣어 "무엇을 살 수 있는지" 를 링크를 열기 전에 알린다.
  const productNames = await prisma.chargeProduct.findMany({
    where: { merchantId: merchant.id, active: true, archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { amount: 'asc' }],
    take: 4,
    select: { name: true },
  });
  const replied = await sendMt({
    phone: inbound.fromNumber,
    template: tpl.tplSelectAmount({
      merchantName: merchant.displayName,
      link: link.url,
      ttlMin: Math.floor(env.payment.selectTtlSec / 60),
      productNames: productNames.map((p) => p.name),
      // 사회복지기관이 설정한 MO 안내 문구. 감사 문자와는 다른 문자다.
      custom: merchant.moGuideMtMessage,
    }),
    chargeId: charge.id,
    merchantId: merchant.id,
  });
  if (replied) await recordFunnelStep({ step: 'REPLY_SENT', chargeId: charge.id }); // 단계 측정(2026-11-09)

  return {
    result: 'ROUTED',
    moMessageId: moRow.id,
    chargeId: charge.id,
    status: 'PENDING_AMOUNT',
    message: '후원 금액 선택 링크를 발송했습니다.',
  };
}

// ---------------------------------------------------------------------------
// PIN 인증 링크 발급
// ---------------------------------------------------------------------------

export interface PinStartOutcome {
  ok: boolean;
  status: ChargeStatus;
  message: string;
  /** 결제사 인증 세션 ID (있을 때만) */
  sessionId?: string;
  expiresAt?: Date;
  /** 결제사 실연동이 아닌 mock 링크인지 */
  mock?: boolean;
  /**
   * 결제사 PIN 입력 화면 주소.
   * notify: false 로 호출했을 때만 채워진다(문자를 보내지 않고 화면을 그대로 이어 갈 때 쓴다).
   * 문자로 보내는 경로에서는 URL 원문을 밖으로 내보내지 않는다.
   */
  pinUrl?: string;
}

/** 링크 원문을 DB 에 남기지 않는다. 세션 토큰이 들어 있는 쿼리스트링을 지운다. */
function maskPinUrl(url: string): string {
  const cut = url.indexOf('?');
  return cut < 0 ? url : `${url.slice(0, cut)}?[마스킹]`;
}

/** 어댑터가 상대경로(mock 화면)를 주면 문자로 보낼 수 있게 절대 URL 로 바꾼다. */
function toAbsolutePinUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${env.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * 결제사에 PIN 입력 링크를 요청하고, 받은 링크를 후원자에게 MT 로 보낸다.
 *
 * 이 함수는 **출금을 일으키지 않는다.** 후원자가 PIN 을 입력하면 결제사가
 * `/api/webhooks/pin-callback` 으로 통지하고, 그때 executePayment() 가 실행된다.
 *
 * 멱등: 결제 1건당 인증 세션은 1건(payment_pin_session.charge_id UNIQUE)이다.
 * 같은 결제로 두 번 들어와도 링크를 두 장 발급하지 않는다.
 */
export async function startPinAuthorization(
  chargeId: string,
  options: { notify?: boolean } = {},
): Promise<PinStartOutcome> {
  // notify: false 면 PIN 링크를 문자로 보내지 않고 호출한 화면이 그대로 이어 간다.
  // (후원 금액 선택 화면 → PIN 입력. 문자를 두 번 보내지 않기 위한 경로다)
  const notify = options.notify !== false;
  const charge = await prisma.charge.findUnique({
    where: { id: chargeId },
    include: { merchant: true, payer: true },
  });
  if (!charge) return { ok: false, status: 'PAYMENT_FAILED', message: '결제 거래를 찾을 수 없습니다.' };
  if (!charge.payer) return { ok: false, status: 'UNREGISTERED', message: '후원자 정보가 없습니다.' };

  // 이미 발급된 세션이 있으면 새로 만들지 않는다(문자 재수신 시 링크가 늘어나는 것을 막는다).
  const existing = await prisma.paymentPinSession.findUnique({ where: { chargeId } });
  if (existing && existing.status === 'PENDING' && existing.expiresAt.getTime() < Date.now()) {
    // 유효시간이 지난 세션은 만료 배치를 기다리지 않고 그 자리에서 닫는다.
    // "이미 발송된 링크가 있습니다" 로 성공을 돌려주면 쓸 수 없는 링크를 기다리게 된다.
    // (순환 import 를 피하려고 필요할 때만 불러온다)
    const { expirePinSessionIfStale } = await import('./pin-authorization');
    await expirePinSessionIfStale(chargeId);
    const after = await prisma.charge.findUnique({ where: { id: chargeId }, select: { status: true } });
    return {
      ok: false,
      status: after?.status ?? 'PAYMENT_FAILED',
      message: 'PIN 입력 시간이 지나 결제가 취소되었습니다. 결제는 진행되지 않았습니다. 사회복지기관 번호로 문자를 다시 보내 주세요.',
    };
  }
  if (existing) {
    return {
      ok: existing.status === 'PENDING',
      status: charge.status,
      message:
        existing.status === 'PENDING'
          ? // notify:false 로 시작한 흐름(금액 선택 화면)에서는 이 결제로 문자를 보낸 적이 없다.
            // "받으신 문자에서 진행하세요" 라고 하면 오지 않을 문자를 기다리게 된다.
            notify
            ? '이미 발송된 PIN 입력 링크가 있습니다. 받으신 문자에서 진행해 주세요.'
            : '이미 진행 중인 결제가 있습니다. 잠시 후 다시 시도하거나, 사회복지기관 번호로 문자를 다시 보내 주세요.'
          : '이미 처리된 결제입니다.',
      sessionId: existing.sessionId,
      expiresAt: existing.expiresAt,
      mock: existing.mock,
    };
  }

  const token = await prisma.paymentMethodToken.findFirst({
    where: { payerId: charge.payerId!, status: 'ACTIVE' },
    orderBy: { registeredAt: 'desc' },
  });
  if (!token) {
    await setStatus(chargeId, 'UNREGISTERED', '활성 결제수단 없음');
    return { ok: false, status: 'UNREGISTERED', message: '등록된 결제수단이 없습니다.' };
  }

  await setStatus(chargeId, 'PENDING_PIN', 'PIN 인증 대기');

  const adapter = getPaymentAdapter();
  const phone = decrypt(charge.payer.phoneEnc);

  let issued: Awaited<ReturnType<typeof adapter.requestPinLink>>;
  try {
    issued = await adapter.requestPinLink(chargeId, charge.amount, phone, token.method);
  } catch (e) {
    issued = { ok: false, code: 'ERROR', message: (e as Error).message };
  }

  if (!issued.ok || !issued.data) {
    // 링크 발급 실패는 출금이 없는 실패다. 한도 카운터도 아직 쓰지 않았다.
    const reason = issued.message ?? 'PIN 인증창을 생성하지 못했습니다.';
    await setStatus(chargeId, 'PAYMENT_FAILED', `PIN 링크 발급 실패: ${reason}`);
    await sendMtForPayer(
      charge.payerId!,
      tpl.tplChargeFailed(charge.merchant.displayName, reason),
      chargeId,
      charge.merchantId,
    );
    logger.warn('PIN 링크 발급 실패', { chargeId, code: issued.code, phone: charge.payer.phoneMasked });
    return { ok: false, status: 'PAYMENT_FAILED', message: reason };
  }

  const pinUrl = toAbsolutePinUrl(issued.data.pinUrl);
  const ttlMin = Math.max(1, Math.floor((issued.data.expiresAt.getTime() - Date.now()) / 60_000));

  try {
    await prisma.paymentPinSession.create({
      data: {
        id: newId(),
        chargeId,
        provider: adapter.info().provider,
        method: token.method,
        sessionId: issued.data.sessionId,
        pinUrlMasked: maskPinUrl(pinUrl),
        amount: charge.amount,
        mock: issued.data.mock,
        expiresAt: issued.data.expiresAt,
      },
    });
  } catch (error) {
    // 동시 요청 경합: charge_id UNIQUE 에 걸린 쪽은 링크를 또 보내지 않는다.
    // 유니크 위반이 아닌 오류(DB 순단 등)면 세션 없이 PENDING_PIN 에 남는 고아가 된다.
    // 세션이 없으면 결제사 콜백도 승인으로 이어지지 않으므로(세션 조회 실패) 출금 없는 실패로 닫는다.
    const now = await prisma.paymentPinSession.findUnique({ where: { chargeId } }).catch(() => null);
    if (!now && (error as { code?: string }).code !== 'P2002') {
      logger.error('PIN 인증 세션 저장 실패 — 결제를 실패로 닫습니다', {
        chargeId,
        message: (error as Error).message,
      });
      await setStatus(chargeId, 'PAYMENT_FAILED', 'PIN 인증 세션 저장 실패').catch(() => undefined);
      return {
        ok: false,
        status: 'PAYMENT_FAILED',
        message: 'PIN 인증을 준비하지 못했습니다. 결제는 진행되지 않았습니다. 잠시 후 사회복지기관 번호로 문자를 다시 보내 주세요.',
      };
    }
    return {
      ok: Boolean(now),
      status: 'PENDING_PIN',
      message: notify
        ? '이미 발송된 PIN 입력 링크가 있습니다. 받으신 문자에서 진행해 주세요.'
        : '이미 진행 중인 결제가 있습니다. 잠시 후 다시 시도하거나, 사회복지기관 번호로 문자를 다시 보내 주세요.',
      sessionId: now?.sessionId,
      expiresAt: now?.expiresAt,
      mock: now?.mock,
    };
  }

  const sent = notify
    ? await sendMt({
        phone,
        template: tpl.tplPinRequest({
          merchantName: charge.merchant.displayName,
          amount: charge.amount,
          pinUrl,
          ttlMin,
          mock: issued.data.mock,
        }),
        chargeId,
        merchantId: charge.merchantId,
      })
    : true;

  if (!sent) {
    // 링크를 받지 못한 후원자가 결제될 수는 없다. 세션을 닫고 실패로 확정한다.
    // (아직 승인 전이므로 출금은 발생하지 않았다)
    await prisma.paymentPinSession.updateMany({
      where: { chargeId, status: 'PENDING' },
      data: { status: 'FAILED', resultNote: 'PIN 링크 문자 발송 실패' },
    });
    await setStatus(chargeId, 'PAYMENT_FAILED', 'PIN 링크 문자 발송 실패');
    return { ok: false, status: 'PAYMENT_FAILED', message: 'PIN 입력 안내 문자를 보내지 못했습니다.' };
  }

  if (issued.data.mock) {
    logger.warn('[MOCK] PIN 인증 링크 발송 — 실제 결제사 연동이 아닙니다.', {
      chargeId,
      provider: adapter.info().provider,
      phone: charge.payer.phoneMasked,
    });
  }

  return {
    ok: true,
    status: 'PENDING_PIN',
    message: issued.data.mock
      ? '[MOCK] PIN 입력 링크를 발송했습니다. PIN 입력 후 결제가 완료됩니다.'
      : 'PIN 입력 링크를 발송했습니다. PIN 입력 후 결제가 완료됩니다.',
    sessionId: issued.data.sessionId,
    expiresAt: issued.data.expiresAt,
    mock: issued.data.mock,
    pinUrl: notify ? undefined : pinUrl,
  };
}

// ---------------------------------------------------------------------------
// 결제 실행
// ---------------------------------------------------------------------------

export interface PaymentOutcome {
  ok: boolean;
  status: ChargeStatus;
  message: string;
}

/**
 * 카드 일시후원 승인 문맥(2026-11-13 5차 L2). 카드 결제창 완료 지점(card-payment.ts completeCardCheckout)만 넘긴다.
 * 없으면(기존 호출 전부) 예전과 완전히 같은 계좌 빌키 승인 경로다.
 */
export interface CardApproveContext {
  adapter: CardPaymentAdapter;
  /** 결제창 인증 결과(승인에 쓰는 값). 저장·로그하지 않는다. */
  authToken: string;
}

export async function executePayment(chargeId: string, opts: { card?: CardApproveContext } = {}): Promise<PaymentOutcome> {
  const card = opts.card ?? null;
  const charge = await prisma.charge.findUnique({
    where: { id: chargeId },
    include: { merchant: true, payer: true },
  });
  if (!charge) return { ok: false, status: 'PAYMENT_FAILED', message: '결제 거래를 찾을 수 없습니다.' };
  if (!charge.payer) return { ok: false, status: 'UNREGISTERED', message: '후원자 정보가 없습니다.' };
  const payer = charge.payer;

  if (['PAYMENT_SUCCESS', 'BROADCAST_PENDING', 'BROADCASTED', 'PARTIAL_DELIVERY_FAILED', 'SETTLEMENT_PENDING', 'SETTLED'].includes(charge.status)) {
    return { ok: true, status: charge.status, message: '이미 결제가 완료된 거래입니다.' };
  }

  // 카드 결제 건은 카드 결제창 완료 지점에서만 승인한다(계좌 빌키로 승인하지 않는다). 계좌 결제 건(paymentMethod 비어 있음)은 영향 없음.
  if (charge.paymentMethod === 'CARD' && !card) {
    return { ok: false, status: charge.status, message: '카드 결제 건은 카드 결제창에서만 승인합니다.' };
  }
  // 카드 수수료 정책은 승인 **전에** 확인한다(승인 뒤 정책이 없어 원장을 못 쓰는 일이 없게).
  let cardFees: Awaited<ReturnType<typeof calculateCardFees>> | null = null;
  if (card) {
    cardFees = await calculateCardFees(charge.merchantId, charge.amount).catch(() => null);
    if (!cardFees) {
      await setStatus(chargeId, 'PAYMENT_FAILED', '카드 수수료 정책 없음(승인 전 중단, 출금 없음)');
      return { ok: false, status: 'PAYMENT_FAILED', message: '카드 결제를 준비하지 못했습니다. 결제는 진행되지 않았습니다.' };
    }
  }

  const token = card
    ? null
    : await prisma.paymentMethodToken.findFirst({
        where: { payerId: charge.payerId!, status: 'ACTIVE' },
        orderBy: { registeredAt: 'desc' },
      });
  if (!card && !token) {
    await setStatus(chargeId, 'UNREGISTERED', '활성 결제수단 없음');
    return { ok: false, status: 'UNREGISTERED', message: '등록된 결제수단이 없습니다.' };
  }

  // 결제 직전 한도 재검사 + 결제 판정.
  // 카운터는 결제 성공 시에만 증가하므로, 확인 링크를 여러 장 받아 두었다가 한꺼번에 누르면
  // 접수 시점 검사만으로는 일/월 한도를 얼마든지 넘길 수 있다. 실제 출금 직전에 다시 확인한다.
  //
  // 재검사부터 결제 판정(집계 예약 + 결제 트랜잭션 확정)까지를 하나의 트랜잭션으로 묶고,
  // 그 안에서 후원자 행을 FOR UPDATE 로 잠근다. 같은 후원자가 동시에 두 번 눌러도
  // 뒤 요청은 앞 트랜잭션이 끝날 때까지 대기했다가, 예약이 반영된 집계를 보고 한도 판정을 받는다.
  const reservedAt = new Date();
  const decision = await prisma.$transaction(async (tx) => {
    // 결제 트랜잭션은 거래당 1건만 "진행 중" 일 수 있다.
    // 승인 결과를 아직 모르는 행(REQUESTED·TIMEOUT·UNKNOWN)이 있으면 한도 집계·재고는 이미 예약돼 있고,
    // 결제사에 승인 요청이 나갔을 수도 있다. 다시 예약하거나 다시 승인을 부르지 않는다(아래에서 대사 큐로 보낸다).
    const existing = await tx.paymentTransaction.findFirst({
      where: { chargeId },
      orderBy: { requestedAt: 'desc' },
    });
    if (existing?.status === 'APPROVED') {
      return { limit: null, txn: existing, alreadyApproved: true, inFlight: false, stockError: null, reservedAt };
    }
    if (existing && IN_FLIGHT_TXN.includes(existing.status)) {
      return { limit: null, txn: existing, alreadyApproved: false, inFlight: true, stockError: null, reservedAt: existing.requestedAt };
    }

    const blockedNow = await tx.blockedPayer.findUnique({
      where: { merchantId_payerId: { merchantId: charge.merchantId, payerId: payer.id } },
    });
    const limit = await checkLimits({
      payer,
      merchantId: charge.merchantId,
      amount: charge.amount,
      blockedByMerchant: Boolean(blockedNow),
      // 접수 시점에 이미 속도 제한 카운터를 소진했다. 여기서 또 올리면 1건이 2건으로 세어진다.
      consumeVelocity: false,
      tx,
    });
    if (!limit.ok) return { limit, txn: null, alreadyApproved: false, inFlight: false, stockError: null, reservedAt };

    // 실물 상품은 여기서 재고를 잡는다(예약).
    //
    // 승인 응답을 받은 뒤에 줄이면, 마지막 1개를 두 사람이 동시에 결제했을 때
    // 둘 다 승인되고 재고만 음수가 된다 — 돈은 받았는데 보낼 물건이 없다.
    // 그래서 승인 요청을 보내기 전에 상품 단위 잠금 안에서 확인하고 줄인다.
    // 결제가 실패하면 아래에서 되돌린다(한도 집계와 같은 방식).
    if (charge.productId && charge.quantity > 0) {
      const stockError = await withAdvisoryLock(tx, `stock:${charge.productId}`, async () => {
        const product = await tx.chargeProduct.findUnique({
          where: { id: charge.productId! },
          select: { kind: true, stock: true, name: true },
        });
        if (!product || product.kind !== 'PHYSICAL' || product.stock === null) return null;
        if (product.stock < charge.quantity) {
          return product.stock <= 0
            ? `${product.name} 상품이 품절되었습니다.`
            : `${product.name} 재고가 ${product.stock}개 남아 주문 수량(${charge.quantity}개)을 채울 수 없습니다.`;
        }
        await tx.chargeProduct.update({
          where: { id: charge.productId! },
          data: { stock: { decrement: charge.quantity } },
        });
        return null;
      });
      if (stockError) return { limit, txn: null, alreadyApproved: false, inFlight: false, stockError, reservedAt };
    }

    // 이전 거래가 실패·취소로 끝났으면(예약도 이미 되돌렸다) 새 주문번호로 새 행을 만든다.
    const row = await tx.paymentTransaction.create({
        data: {
          id: newId(),
          chargeId,
          orderNo: newOrderNo(),
          // 설정값이 아니라 실제로 이 건을 처리하는 어댑터를 남긴다.
          // SAFE_MODE=true 면 PAYMENT_PROVIDER 가 hecto 여도 mock 이 승인한다.
          // 설정값을 남기면 모의 승인을 실승인으로 오인해 정산·환불을 진행하게 된다.
          provider: card ? cardTransactionProvider(card.adapter) : getPaymentAdapter().info().provider,
          amount: charge.amount,
          // 한도 집계를 되돌릴 때 이 값을 기준 시각으로 쓴다(환불·대사 경로 포함).
          // DB 기본값(now())에 맡기면 예약에 쓴 reservedAt 과 KST 날짜가 갈릴 수 있고,
          // 그러면 A월에 잡은 한도를 B월에서 빼게 된다.
          requestedAt: reservedAt,
        },
      });

    // 승인 결과를 기다리지 않고 집계를 먼저 잡아둔다(예약).
    // 잠금 밖에서 승인 후에 반영하면, 그사이 들어온 같은 후원자의 요청이
    // 이 건이 빠진 집계를 읽고 함께 통과해 한도를 넘긴다. 실패하면 아래에서 되돌린다.
    await commitCounters(payer.id, charge.merchantId, charge.amount, reservedAt, tx);
    return { limit, txn: row, alreadyApproved: false, inFlight: false, stockError: null, reservedAt };
  }, {
    // 기본값(5초)에 기대지 않고 명시한다.
    // 이 트랜잭션은 후원자 행을 FOR UPDATE 로 잠그므로, 같은 후원자가 연속으로 누르면
    // 뒤 요청은 앞 트랜잭션이 끝날 때까지 줄을 선다. 잠금 대기와 실행 시간을 나눠서 잡아 둔다.
    maxWait: 5_000,
    timeout: 10_000,
  });

  // 재고 부족은 한도와 별개다. 돈을 빼기 전에 막고, 후원자에게 이유를 알린다.
  if (decision.stockError) {
    await setStatus(chargeId, 'PAYMENT_FAILED', decision.stockError);
    await sendMtForPayer(
      charge.payerId!,
      tpl.tplChargeFailed(charge.merchant.displayName, decision.stockError),
      chargeId,
      charge.merchantId,
    );
    logger.warn('재고 부족으로 결제 중단', { chargeId, productId: charge.productId, reason: decision.stockError });
    return { ok: false, status: 'PAYMENT_FAILED', message: decision.stockError };
  }

  // 정기후원 결제는 약정 서비스(recurring.ts)가 전용 안내 문자(실패·재시도·정지)를 보낸다.
  // 여기서 일반 실패 문자를 함께 보내면 한 번의 실패에 문자가 두 통 나간다.
  const recurringCharge = charge.channel === 'RECURRING';

  if (decision.alreadyApproved) {
    return { ok: true, status: 'PAYMENT_SUCCESS', message: '이미 승인된 결제입니다.' };
  }

  // 결과를 모르는 진행 중 거래로 재진입했다. 승인을 다시 부르면 이중 출금 위험이 있고,
  // 실패로 닫으면 출금된 돈이 정산되지 않는다. 결과 미확인(UNKNOWN)으로 대사 큐에 올린다.
  if (decision.inFlight) {
    const t = decision.txn!;
    await markPaymentUnknown(chargeId, t, charge.amount, 'REENTRY_IN_FLIGHT', '진행 중인 결제로 다시 요청됨 — 결제사 원장과 대사가 필요합니다.');
    return {
      ok: false,
      status: 'PENDING_PAYMENT',
      message: '결제 결과를 확인하는 중입니다. 확인되는 대로 문자로 안내드립니다.',
    };
  }

  const limitNow = decision.limit!;
  if (!limitNow.ok) {
    await setStatus(chargeId, 'LIMIT_BLOCKED', `${limitNow.code}: ${limitNow.message}`);
    await prisma.riskDetection.create({
      data: {
        id: newId(),
        payerId: charge.payerId!,
        merchantId: charge.merchantId,
        chargeId: charge.id,
        type: limitNow.code === 'VELOCITY' || limitNow.code === 'COOLDOWN' ? 'VELOCITY' : 'DAILY_LIMIT',
        level: 'MEDIUM',
        detail: { code: limitNow.code, message: limitNow.message, stage: 'PRE_PAYMENT' } as object,
      },
    });
    if (!recurringCharge) {
      await sendMtForPayer(
        charge.payerId!,
        tpl.tplLimitBlocked(charge.merchant.displayName, limitNow.message ?? '이용 한도'),
        chargeId,
        charge.merchantId,
      );
    }
    return { ok: false, status: 'LIMIT_BLOCKED', message: limitNow.message ?? '이용 한도를 초과했습니다.' };
  }

  const txn = decision.txn!;

  // 여기부터 결제대행 호출 직전까지의 구간.
  //
  // 판정 트랜잭션은 이미 커밋돼 한도와 재고가 "예약" 된 상태다. 이 구간에서 예외가 나면
  // 결제대행은 부르지도 않았는데 예약만 잡힌 채 거래가 PENDING 으로 남는다.
  // 수동 대사(payment-reconcile)는 UNKNOWN·TIMEOUT 만 다루므로 이 건은 아무도 풀지 못한다.
  //
  // 결제대행을 부르기 전이라는 것이 확실한 구간이므로, 여기서는 조용히 되돌리는 것이 안전하다.
  // 카드 승인(2026-11-13 5차 L2)은 같은 판정·조회·미확인 규칙을 타되 승인·조회만 카드 어댑터로 한다.
  const adapter: Pick<ReturnType<typeof getPaymentAdapter>, 'approve' | 'inquire'> = card
    ? {
        approve: (req) => card.adapter.approve({ orderNo: req.orderNo, amount: req.amount, authToken: card.authToken }),
        inquire: (orderNo) => card.adapter.inquire(orderNo),
      }
    : getPaymentAdapter();
  const started = Date.now();
  let attemptNo: number;
  try {
    await setStatus(chargeId, 'PENDING_PAYMENT', '결제 승인 요청');
    attemptNo = (await prisma.paymentAttempt.count({ where: { transactionId: txn.id } })) + 1;
  } catch (e) {
    logger.error('결제 승인 요청 준비 중 오류 — 예약을 되돌립니다', {
      chargeId, transactionId: txn.id, message: (e as Error).message,
    });
    await prisma.paymentTransaction
      .update({
        where: { id: txn.id },
        data: { status: 'FAILED', resultCode: 'PREPARE_ERROR', resultMessage: (e as Error).message.slice(0, 200) },
      })
      .catch(() => undefined);
    await rollbackCounters(payer.id, charge.merchantId, charge.amount, reservedAt).catch(() => undefined);
    await restoreStock(charge.productId, charge.quantity).catch(() => undefined);
    await setStatus(chargeId, 'PAYMENT_FAILED', '결제 준비 중 오류가 발생했습니다.').catch(() => undefined);
    return { ok: false, status: 'PAYMENT_FAILED', message: '결제를 준비하는 중 오류가 발생했습니다. 다시 시도해 주세요.' };
  }

  let approved: { providerTid: string; approvedAt: Date } | null = null;
  let failure: { code?: string; message?: string } | null = null;

  // 이 구간의 기록(시도 이력 등)은 실패해도 예외를 밖으로 내보내지 않는다.
  // 승인 요청이 이미 나간 뒤라, 여기서 throw 하면 거래가 REQUESTED 로 남아 대사 큐에도 잡히지 않는다.
  const safeWrite = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      logger.error(`결제 기록 실패(${what}) — 결과 판정은 계속합니다`, { chargeId, transactionId: txn.id, message: (e as Error).message });
    }
  };

  /** 거래결과조회로 최종 상태를 확정한다. 조회 불가·알 수 없는 상태는 UNKNOWN(대사)이다. */
  type Settled = { approved: { providerTid: string; approvedAt: Date } | null; failure: { code?: string; message?: string } | null };
  const settleByInquiry = async (): Promise<Settled> => {
    let inq: Awaited<ReturnType<typeof adapter.inquire>> | null = null;
    try {
      inq = await adapter.inquire(txn.orderNo);
    } catch (inqErr) {
      logger.error('거래결과조회 실패', { chargeId, orderNo: txn.orderNo, message: (inqErr as Error).message });
    }
    const inquiryAttempt = attemptNo;
    attemptNo += 1;
    await safeWrite('조회 이력', () =>
      prisma.paymentAttempt.create({
        data: {
          id: newId(), transactionId: txn.id, attemptNo: inquiryAttempt, operation: 'INQUIRE',
          responseMasked: { status: inq?.data?.status ?? 'UNKNOWN' } as object,
          errorCode: inq ? null : 'INQUIRE_ERROR',
        },
      }),
    );
    if (inq?.ok && inq.data?.status === 'APPROVED') {
      return { approved: { providerTid: inq.data.providerTid ?? txn.orderNo, approvedAt: new Date() }, failure: null };
    }
    if (inq?.ok && inq.data?.status === 'FAILED') {
      return { approved: null, failure: { code: 'TIMEOUT_FAILED', message: '결제가 완료되지 않았습니다.' } };
    }
    return { approved: null, failure: { code: 'UNKNOWN', message: '결제 결과를 확인할 수 없습니다. 관리자 확인이 필요합니다.' } };
  };

  let res: Awaited<ReturnType<typeof adapter.approve>> | null = null;
  let thrown: unknown = null;
  try {
    res = await adapter.approve({
      orderNo: txn.orderNo,
      amount: charge.amount,
      billKey: token ? decryptBillKey(token.billKeyEnc) : '',
      productName: `${charge.merchant.displayName} 문자후원`,
      buyerName: charge.displayName,
    });
  } catch (e) {
    thrown = e;
  }

  if (res) {
    const r = res;
    const approveAttempt = attemptNo;
    attemptNo += 1;
    await safeWrite('승인 이력', () =>
      prisma.paymentAttempt.create({
        data: {
          id: newId(), transactionId: txn.id, attemptNo: approveAttempt, operation: 'APPROVE',
          responseMasked: { ok: r.ok, code: r.code ?? null, message: r.message ?? null } as object,
          latencyMs: Date.now() - started,
          errorCode: r.ok ? null : r.code ?? null,
          errorMessage: r.ok ? null : r.message ?? null,
        },
      }),
    );
    if (r.ok && r.data) approved = { providerTid: r.data.providerTid, approvedAt: r.data.approvedAt };
    else if (r.code === 'UNKNOWN') {
      // 결제사 응답이 5xx·해석 불가(결과 불확실)다. 바로 사람 손으로 넘기지 않고 예외 경로처럼 한 번 조회한다.
      await safeWrite('거래 상태(TIMEOUT)', () =>
        prisma.paymentTransaction.update({ where: { id: txn.id }, data: { status: 'TIMEOUT' } }),
      );
      ({ approved, failure } = await settleByInquiry());
    } else failure = { code: r.code, message: r.message };
  } else {
    // 타임아웃/네트워크 오류: 반드시 거래결과조회로 최종 상태를 확정한다.
    const e = thrown as Error;
    const isTimeout = e instanceof MockPaymentTimeout || /timeout|ETIMEDOUT|ECONNRESET/i.test(e?.message ?? '');
    const approveAttempt = attemptNo;
    attemptNo += 1;
    await safeWrite('승인 예외 이력', () =>
      prisma.paymentAttempt.create({
        data: {
          id: newId(), transactionId: txn.id, attemptNo: approveAttempt, operation: 'APPROVE',
          latencyMs: Date.now() - started, errorCode: isTimeout ? 'TIMEOUT' : 'ERROR',
          errorMessage: e?.message ?? String(thrown),
        },
      }),
    );
    await safeWrite('거래 상태(TIMEOUT)', () =>
      prisma.paymentTransaction.update({ where: { id: txn.id }, data: { status: 'TIMEOUT' } }),
    );
    // 거래결과조회 자체가 실패해도 예외를 밖으로 내보내지 않는다(settleByInquiry 안에서 흡수).
    // 조회 불가 = "결과 미확인(UNKNOWN)" 으로 확정하고 관리자 확인 큐로 보낸다.
    ({ approved, failure } = await settleByInquiry());
  }

  const phone = charge.payer.phoneMasked;

  if (!approved) {
    // ── 결과 미확인(UNKNOWN) ────────────────────────────────────────────
    // 출금이 실제로 일어났을 수 있으므로 "실패"로 확정하면 안 된다.
    // FAILED 로 덮으면 (1) 원장 분개가 없어 사회복지기관에 정산되지 않고
    // (2) 후원자에게 실패 문자가 나가며 (3) 실패 카운터로 정상 후원자가 잠기고
    // (4) 관리자 '확인 필요' 큐(status IN UNKNOWN,TIMEOUT)가 영구히 비어 대사 자체가 불가능해진다.
    // 따라서 UNKNOWN 은 UNKNOWN 그대로 남기고 사람이 판단하도록 넘긴다.
    if (failure?.code === 'UNKNOWN') {
      // 결제 상태는 PENDING_PAYMENT 로 유지한다(실패 아님). 거래만 UNKNOWN 으로 올려 대사 큐에 넣는다.
      // 이 기록들이 실패해도 예외를 던지지 않는다 — 남은 REQUESTED·TIMEOUT 은 정리 배치가 UNKNOWN 으로 올린다.
      await markPaymentUnknown(chargeId, txn, charge.amount, 'UNKNOWN', failure.message ?? null);
      // 실패 카운터를 올리지 않는다. 실패 문자도 보내지 않는다(이중청구 오해 방지).
      // 예약해 둔 한도 집계도 되돌리지 않는다. 실제로 출금되었을 수 있으므로
      // 되돌렸다가 다시 결제가 통과하면 그날 한도를 넘겨 이중으로 빠져나간다.
      logger.error('결제 결과 미확인 — 수동 대사 필요', {
        chargeId, transactionId: txn.id, orderNo: txn.orderNo, phone,
      });
      return {
        ok: false,
        status: 'PENDING_PAYMENT',
        message: '결제 결과를 확인하는 중입니다. 확인되는 대로 문자로 안내드립니다.',
      };
    }

    await prisma.paymentTransaction.update({
      where: { id: txn.id },
      data: { status: 'FAILED', resultCode: failure?.code ?? null, resultMessage: failure?.message ?? null },
    });
    await setStatus(chargeId, 'PAYMENT_FAILED', failure?.message ?? '결제 실패');
    // 결제 판정 트랜잭션에서 잡아둔 집계 예약을 되돌린다(실패한 건은 한도를 쓰지 않는다).
    await rollbackCounters(payer.id, charge.merchantId, charge.amount, reservedAt);
    // 잡아둔 재고도 함께 돌려놓는다. 여기서 빠뜨리면 결제 실패가 쌓일수록 팔 수 있는 물건이 줄어든다.
    await restoreStock(charge.productId, charge.quantity);
    // 정기후원 자동 출금 실패(잔액 부족 등)는 후원자가 직접 시도한 실패가 아니다.
    // 실패 카운터에 쌓으면 정기후원 실패만으로 문자후원까지 잠긴다. 안내 문자는 약정 서비스가 보낸다.
    let locked = false;
    if (!recurringCharge) {
      const policy = await resolvePolicy(charge.merchantId, charge.payerId);
      locked = await registerFailure(charge.payerId!, policy.failureLockThreshold);
      await sendMtForPayer(charge.payerId!, tpl.tplChargeFailed(charge.merchant.displayName, failure?.message), chargeId, charge.merchantId);
    }
    await emitMerchantEvent(charge.merchantId, 'charge.failed', {
      transactionNo: charge.transactionNo,
      amount: Number(charge.amount),
      reason: failure?.message ?? null,
      code: failure?.code ?? null,
    });
    logger.warn('결제 실패', { chargeId, phone, locked, code: failure?.code });
    return { ok: false, status: 'PAYMENT_FAILED', message: failure?.message ?? '결제에 실패했습니다.' };
  }

  // ── 승인 성공 ──────────────────────────────────────────────────────
  // 승인 기록과 정산 원장 분개는 반드시 같은 트랜잭션이어야 한다.
  // 둘이 갈라져 있으면 그 사이에 프로세스가 죽었을 때
  // "결제는 성공인데 원장에는 없는" 상태가 되고, 앞쪽 조기 return 가드가
  // 재시도를 '이미 완료'로 되돌려 보내 사회복지기관이 그 금액을 영영 못 받는다.
  const fees = cardFees ?? (await calculateFees(charge.merchantId, charge.amount));
  try {
    await prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.update({
        where: { id: txn.id },
        data: { status: 'APPROVED', providerTid: approved!.providerTid, approvedAt: approved!.approvedAt },
      });
      await tx.charge.update({
        where: { id: chargeId },
        data: {
          status: 'SETTLEMENT_PENDING',
          statusReason: '정산 대기',
          paidAt: approved!.approvedAt,
          pgFee: fees.pgFee,
          platformFee: fees.platformFee,
          feeVat: fees.vat,
          netAmount: fees.net,
        },
      });
      await tx.chargeStatusLog.createMany({
        data: [
          { id: newId(), chargeId, fromStatus: 'PENDING_PAYMENT', toStatus: 'PAYMENT_SUCCESS', actor: 'system' },
          { id: newId(), chargeId, fromStatus: 'PAYMENT_SUCCESS', toStatus: 'SETTLEMENT_PENDING', reason: '정산 대기', actor: 'system' },
        ],
      });
      await tx.payerMerchantLink.upsert({
        where: { payerId_merchantId: { payerId: charge.payerId!, merchantId: charge.merchantId } },
        create: {
          id: newId(), payerId: charge.payerId!, merchantId: charge.merchantId,
          consentedAt: new Date(), totalAmount: charge.amount, totalCount: 1, lastDonatedAt: approved!.approvedAt,
        },
        update: {
          totalAmount: { increment: charge.amount },
          totalCount: { increment: 1 },
          lastDonatedAt: approved!.approvedAt,
        },
      });
      await postChargeSettlement(
        {
          merchantId: charge.merchantId,
          chargeId,
          amount: charge.amount,
          fees,
          occurredAt: approved!.approvedAt,
        },
        tx,
      );
      // 후속 자동화(기관 알림·명단 연결·목표 달성·저니)의 출발점. 승인 기록과 같은 트랜잭션이라
      // "결제는 됐는데 후속이 영영 안 도는" 틈이 없다. 소비자 실패는 이 결제 결과를 바꾸지 않는다.
      // payload 는 관리자 수동 확정(payment-reconcile)과 같은 공용 함수로 만든다(표시 이름은 넣지 않는다 — 점검 A-M5).
      await emitChargePaid(tx, { ...charge, id: chargeId }, approved!.approvedAt);
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    // 출금은 이미 끝났다. 여기서 그냥 던지면 거래가 REQUESTED 로 남는데,
    // 수동 대사는 UNKNOWN·TIMEOUT 만 받으므로 자동으로도 사람 손으로도 회수할 수 없게 된다.
    // 결과를 모르는 상태로 표시해 관리자 대사 큐에 올린다.
    logger.error('승인 후 정산 기록 실패 — 대사 필요', {
      chargeId,
      transactionId: txn.id,
      providerTid: approved!.providerTid,
      message: (error as Error).message,
    });
    await prisma.paymentTransaction
      .update({
        where: { id: txn.id },
        data: {
          status: 'UNKNOWN',
          providerTid: approved!.providerTid,
          approvedAt: approved!.approvedAt,
          resultCode: 'SETTLEMENT_WRITE_FAILED',
          resultMessage: `승인은 되었으나 정산 기록에 실패했습니다: ${(error as Error).message}`.slice(0, 500),
        },
      })
      .catch(() => undefined);
    await raiseUnknownPaymentAlert(chargeId, txn.id, txn.orderNo, charge.amount);
    return {
      ok: false,
      status: 'PENDING_PAYMENT',
      message: '결제 결과를 확인하는 중입니다. 확인되는 대로 문자로 안내드립니다.',
    };
  }

  await recordFunnelStep({ step: 'PAID', chargeId }); // 단계 측정(2026-11-09) — 승인 트랜잭션 커밋 뒤, 실패해도 예외 없음
  // 집계는 결제 판정 트랜잭션에서 이미 반영(예약)했다. 여기서 다시 더하면 두 번 세어진다.
  await clearFailures(charge.payerId!);

  // 누적 결제 금액 안내
  const link = await prisma.payerMerchantLink.findUnique({
    where: { payerId_merchantId: { payerId: charge.payerId!, merchantId: charge.merchantId } },
    select: { totalAmount: true },
  });
  await sendMtForPayer(
    charge.payerId!,
    tpl.tplChargeSuccess({
      payerName: charge.displayName,
      merchantName: charge.merchant.displayName,
      amount: charge.amount,
      message: charge.message,
      cumulative: link?.totalAmount ?? charge.amount,
      // 사회복지기관이 스튜디오에서 설정한 감사 문자 본문. 없으면 기본 문구가 쓰인다.
      // 캠페인에 감사 문구를 따로 정했으면 그 문구가 먼저다(2026-11-12 4차 I — 없거나 읽지 못하면 예전 그대로).
      custom: (await campaignThanksText(charge.campaignId)) ?? charge.merchant.thanksMtMessage,
    }),
    chargeId,
    charge.merchantId,
  );

  // 포인트 지급(상품 기능)은 사회복지기관이 한다. 기브싸인은 결제·정산까지만 책임지고,
  // 사회복지기관이 콘솔(또는 조회 API)에서 이 결제 건을 보고 자기 서비스에 포인트를 넣는다.
  // 그래서 여기서 외부를 호출하지 않는다. 지급 여부는 charge.pointStatus 로 추적한다.
  //
  // 예외는 지급 방식이 INSTANT 인 비실물 상품이다. 코드·다운로드 주소처럼
  // 사회복지기관이 미리 적어 둔 안내를 그대로 보내면 끝나는 상품이라, 사람이 개입할 필요가 없다.
  await deliverInstantFulfillment(chargeId);

  // 문서 상품(약정서·주문서)은 결제만으로 끝나지 않는다. 작성 링크를 따로 보낸다.
  // 감사 문자에 끼워 넣지 않는 이유는 그 본문을 사회복지기관이 바꿀 수 있어서다 —
  // 문구를 고치는 순간 링크가 사라지면 후원자는 문서를 쓸 방법이 없다.
  await deliverDocumentRequest(chargeId);

  // 웹훅. 발행은 적재까지만 하고 전송은 따로 돌기 때문에 여기서 지연되지 않는다.
  // emitMerchantEvent 는 어떤 경우에도 예외를 던지지 않는다(결제 성공 처리를 막지 않는다).
  await emitMerchantEvent(charge.merchantId, 'charge.succeeded', {
    transactionNo: charge.transactionNo,
    amount: Number(charge.amount),
    points: Number(charge.amount),
    message: charge.message,
    paidAt: new Date().toISOString(),
    ...(await donationMeta(chargeId)),
  });

  return { ok: true, status: 'PAYMENT_SUCCESS', message: '결제가 완료되었습니다.' };
}

// ---------------------------------------------------------------------------

/**
 * 잡아둔 재고를 돌려놓는다.
 *
 * 결제 판정 트랜잭션에서 미리 줄여둔 재고를, 결제가 실패했을 때 되돌리는 용도다.
 * 무제한(stock=null) 상품은 아무 것도 하지 않는다.
 * 실패해도 예외를 밖으로 내보내지 않는다 — 여기서 throw 하면 실패 처리 자체가 멈춘다.
 */
/**
 * 비실물 상품의 즉시 지급(INSTANT) 처리.
 *
 * 문자 발송이 실패해도 결제 자체를 되돌리지 않는다(원칙 3: 결제 성공과 지급 성공은 다른 상태다).
 * 실패하면 pointStatus 를 FAILED 로 남겨 사회복지기관이 판매 내역에서 다시 처리할 수 있게 한다.
 */
async function deliverInstantFulfillment(chargeId: string): Promise<void> {
  try {
    const charge = await prisma.charge.findUnique({
      where: { id: chargeId },
      select: {
        id: true,
        merchantId: true,
        payerId: true,
        pointStatus: true,
        merchant: { select: { displayName: true } },
        product: { select: { kind: true, name: true, fulfillment: true, fulfillmentNote: true } },
      },
    });
    const product = charge?.product;
    if (!charge || !product) return;
    if (product.kind !== 'DIGITAL' || product.fulfillment !== 'INSTANT' || !product.fulfillmentNote) return;
    // 이미 지급 처리된 건은 다시 보내지 않는다(재시도·중복 승인 방어).
    if (charge.pointStatus === 'SENT') return;

    const sent = await sendMtForPayer(
      charge.payerId!,
      tpl.tplFulfillmentInstant({
        merchantName: charge.merchant.displayName,
        productName: product.name,
        note: product.fulfillmentNote,
      }),
      null,
      charge.merchantId,
    );

    await prisma.charge.update({
      where: { id: chargeId },
      data: sent
        ? { pointStatus: 'SENT', pointGivenAt: new Date(), pointBy: 'system:instant', pointNote: '즉시 지급 문자 발송' }
        : { pointStatus: 'FAILED', pointNote: '즉시 지급 문자 발송 실패 — 판매 내역에서 다시 처리해 주세요.' },
    });
  } catch (e) {
    logger.error('즉시 지급 처리 실패', { chargeId, message: (e as Error).message });
  }
}

/**
 * 문서 상품의 작성 링크 발송.
 *
 * 문자 발송이 실패해도 결제를 되돌리지 않는다(원칙 3: 결제 성공과 그 뒤 처리는 다른 상태다).
 * 제출 기록은 이미 만들어져 있으므로, 문자가 안 갔더라도 사회복지기관이 콘솔에서
 * 작성 링크를 다시 보낼 수 있다.
 */
async function deliverDocumentRequest(chargeId: string): Promise<void> {
  try {
    const charge = await prisma.charge.findUnique({
      where: { id: chargeId },
      select: {
        payerId: true,
        merchantId: true,
        merchant: { select: { displayName: true } },
        product: { select: { kind: true, documentTemplateId: true } },
      },
    });
    if (!charge?.payerId || !isDocumentProduct(charge.product)) return;

    const ensured = await ensureDocumentSubmission(chargeId);
    // 이미 만들어 둔 기록이면 토큰 원문을 알 수 없다(해시만 저장한다). 문자를 다시 보내지 않는다.
    if (!ensured.ok || !ensured.url) return;

    await sendMtForPayer(
      charge.payerId,
      tpl.tplDocumentRequest({
        merchantName: charge.merchant.displayName,
        documentName: ensured.templateName,
        link: ensured.url,
        ttlDays: DOCUMENT_LINK_TTL_DAYS,
      }),
      chargeId,
      charge.merchantId,
    );
  } catch (e) {
    logger.error('문서 작성 안내 발송 실패', { chargeId, message: (e as Error).message });
  }
}

export async function restoreStock(productId: string | null, quantity: number): Promise<void> {
  if (!productId || quantity <= 0) return;
  try {
    await prisma.chargeProduct.updateMany({
      where: { id: productId, kind: 'PHYSICAL', stock: { not: null } },
      data: { stock: { increment: quantity } },
    });
  } catch (e) {
    logger.error('재고 복구 실패', { productId, quantity, message: (e as Error).message });
  }
}

/** 빌키 복호화는 결제 실행 지점에서만 수행한다. 반환값은 로그에 남기지 않는다. */
function decryptBillKey(enc: string): string {
  return decrypt(enc);
}

async function sendMtForPayer(payerId: string, template: TemplateOutput, chargeId?: string | null, merchantId?: string) {
  const payer = await prisma.payerProfile.findUnique({ where: { id: payerId } });
  if (!payer) return false;
  const phone = decrypt(payer.phoneEnc);
  return sendMt({ phone, template, chargeId, merchantId });
}

/**
 * 문자 예약어 처리. 예약어가 아니면 null 을 돌려주고 일반 후원 흐름으로 넘어간다.
 *
 * 같은 번호가 같은 예약어를 10분 안에 다시 보내면 링크를 다시 보내지 않는다(문자 폭주 방지).
 * 기록은 수신 문자(resultDetail)에 남겨 기관 콘솔 '약정 미완료 재안내'의 근거로 쓴다.
 */
export const RESERVED_DETAIL = { PLEDGE: 'PLEDGE_REQUEST', VOLUNTEER: 'VOLUNTEER_REQUEST' } as const;

async function handleReservedMoKeyword(input: {
  inbound: MoInbound;
  routed: NonNullable<RoutedMerchant>;
  moRowId: string;
  ph: string;
}): Promise<MoHandleResult | null> {
  const body = normalizeTextForReserved(input.routed.body);
  const m = body.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  if (!m) return null;
  const kind = reservedKeywordKind(m[1]!);
  if (!kind) return null;
  if (kind === 'VOLUNTEER' && !featureVolunteerEnabled()) return null;

  const merchant = input.routed.merchant;
  // 예약어 뒤에 캠페인 키워드가 오면 약정을 그 캠페인으로 지정한다 (예: "정기 김장").
  const rest = (m[2] ?? '').trim();
  const campaign = kind === 'PLEDGE' && rest ? (await matchCampaignKeyword(merchant.id, rest)).campaign : null;

  await recordCommandStep(input.moRowId, merchant.id, kind); // 명령 문자 종류별 수(2026-11-12 4차 K3)
  const throttleKey = `mo:reserved:${merchant.id}:${input.ph}:${kind}`;
  const first = await kv.setnx(throttleKey, '1', 600).catch(() => true);
  await prisma.moInboundMessage.update({
    where: { id: input.moRowId },
    data: {
      result: 'ROUTED',
      resultDetail: `${RESERVED_DETAIL[kind]}${campaign ? `:${campaign.code}` : ''}${first ? '' : ' (10분 내 재요청·링크 생략)'}`,
      processedAt: new Date(),
    },
  });
  if (!first) {
    return { result: 'ROUTED', moMessageId: input.moRowId, message: '같은 안내를 방금 보냈습니다. 링크를 다시 보내지 않았습니다.' };
  }

  const qs = new URLSearchParams({ merchant: merchant.code, src: 'sms' });
  if (campaign) qs.set('campaign', campaign.id);
  const link =
    kind === 'PLEDGE'
      ? `${env.baseUrl}/my/recurring/new?${qs.toString()}`
      : `${env.baseUrl}/my/volunteer/apply?${qs.toString()}`;
  const template =
    kind === 'PLEDGE'
      ? tpl.tplPledgeLink({ merchantName: merchant.displayName, link })
      : tpl.tplVolunteerLink({ merchantName: merchant.displayName, link });
  await sendMt({ phone: input.inbound.fromNumber, template, merchantId: merchant.id });
  return {
    result: 'ROUTED',
    moMessageId: input.moRowId,
    message: kind === 'PLEDGE' ? '정기후원 약정 링크를 보냈습니다. 후원 건은 만들지 않았습니다.' : '자원봉사 신청 링크를 보냈습니다.',
  };
}

function normalizeTextForReserved(v: string) {
  return normalizeText(v ?? '');
}

export { sendMt, sendMtDetailed, sendMtForPayer, setStatus, markPaymentUnknown, IN_FLIGHT_TXN };
