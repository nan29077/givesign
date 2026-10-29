import { prisma } from '@/server/db';
import { newId, newTransactionNo } from '@/lib/id';
import { encrypt } from '@/lib/crypto';
import { payerDisplayName } from '@/lib/payer-name';
import { filterContent } from './content-filter';
import { openCampaigns } from './fundraising';
import { checkLimits } from './limits';
import { acquireIdempotency } from './idempotency';
import { executePayment, loadBannedWords, resolvePaymentMode, startPinAuthorization } from './charge-flow';
import { allowLegacyWebInstantPay } from '@/lib/env';
import type { ChargeStatus } from '@/generated/prisma/enums';

/** 결제 안내 문자에 담기는 메시지 최대 길이 */
const MAX_MESSAGE_LEN = 80;

/**
 * 결제 페이지(웹, PC) 결제 파이프라인.
 *
 * 모바일 MO 문자 흐름과 동일한 안전장치(금칙어 필터, 한도, 멱등, 원장)를 그대로 거치되,
 * 접수 채널만 WEB 이다. 결제가 성공한 건만 사회복지기관에 후원으로 반영된다.
 *
 * 결제 단계는 두 갈래다.
 *  - `PIN`(기본): 결제사 PIN 입력 링크를 문자로 보내고, 후원자가 PIN 을 넣어야 결제된다.
 *                 MO 문자 흐름과 같은 startPinAuthorization() 을 그대로 재사용한다.
 *  - `LEGACY_INSTANT`(**deprecated**): 화면 버튼 클릭 즉시 빌키로 출금한다.
 *                 ALLOW_LEGACY_WEB_INSTANT_PAY=true 일 때만 사용한다.
 */

export type WebChargeChannel = 'PIN' | 'LEGACY_INSTANT';

export function resolveWebChargeChannel(
  allowLegacy: boolean = allowLegacyWebInstantPay(),
): WebChargeChannel {
  return allowLegacy ? 'LEGACY_INSTANT' : 'PIN';
}

export interface WebChargeInput {
  /** 전화번호 인증을 마친 후원자의 phoneHash */
  phoneHash: string;
  merchantId: string;
  amount: bigint;
  message: string;
  /** 중복 제출 방지용 클라이언트 멱등키 */
  requestId: string;
  /** 지정 캠페인(모금 중인 것만 유효) */
  campaignId?: string | null;
  anonymous?: boolean;
}

export interface WebChargeResult {
  ok: boolean;
  status?: ChargeStatus;
  chargeId?: string;
  transactionNo?: string;
  message: string;
  /** PIN 흐름에서만: 인증 링크 만료 시각 (대기 화면 카운트다운용) */
  pinExpiresAt?: Date;
  /** PIN 흐름에서만: 결제사 실연동이 아닌 mock 링크인지 */
  pinMock?: boolean;
}

export async function createWebCharge(input: WebChargeInput): Promise<WebChargeResult> {
  const merchant = await prisma.merchantProfile.findFirst({
    // 사회복지기관주 계정이 정지·탈퇴되면 결제 페이지가 닫힌다(/c/[code]). 이 경로도 같은 기준을 쓴다.
    where: { id: input.merchantId, status: 'APPROVED', user: { status: 'ACTIVE', deletedAt: null } },
  });
  if (!merchant) return { ok: false, message: '결제할 수 없는 사회복지기관입니다.' };

  const payer = await prisma.payerProfile.findUnique({ where: { phoneHash: input.phoneHash } });
  if (!payer) return { ok: false, message: '등록된 후원자 정보가 없습니다. 내통장결제 가입을 먼저 완료해 주세요.' };

  const token = await prisma.paymentMethodToken.findFirst({
    where: { payerId: payer.id, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!token) {
    return { ok: false, message: '등록된 결제수단(내통장결제)이 없습니다. 가입을 먼저 완료해 주세요.' };
  }

  // 캠페인은 모금 중인 것만. 화면 값이 틀리면 조용히 일반 후원으로 돌리지 않고 거절한다.
  let campaignId: string | null = null;
  if (input.campaignId) {
    const open = await openCampaigns(merchant.id);
    if (!open.some((c) => c.id === input.campaignId)) {
      return { ok: false, message: '모금이 끝났거나 고를 수 없는 캠페인입니다.' };
    }
    campaignId = input.campaignId;
  }

  // 콘텐츠 필터 (금칙어 차단/마스킹)
  const bannedWords = await loadBannedWords(merchant.id);
  const filtered = filterContent(input.message, {
    bannedWords,
    maxLength: MAX_MESSAGE_LEN,
  });

  // 한도 확인 (결제 생성 전에 먼저 확인해 불필요한 레코드를 만들지 않는다)
  const blocked = await prisma.blockedPayer.findUnique({
    where: { merchantId_payerId: { merchantId: merchant.id, payerId: payer.id } },
  });
  const limit = await checkLimits({
    payer,
    merchantId: merchant.id,
    amount: input.amount,
    blockedByMerchant: Boolean(blocked),
  });
  if (!limit.ok) {
    // 금액 범위 오류는 입력 실수라 이상거래로 기록하지 않는다.
    if (limit.code !== 'AMOUNT_RANGE') await prisma.riskDetection.create({
      data: {
        id: newId(),
        payerId: payer.id,
        merchantId: merchant.id,
        type: limit.code === 'VELOCITY' || limit.code === 'COOLDOWN' ? 'VELOCITY' : 'DAILY_LIMIT',
        level: 'MEDIUM',
        detail: { code: limit.code, message: limit.message, channel: 'WEB' } as object,
      },
    });
    return { ok: false, message: limit.message ?? '이용 한도를 초과했습니다.' };
  }

  // 멱등: 같은 requestId 로 두 번 제출돼도 결제가 중복 생성되지 않는다
  const idem = await acquireIdempotency('charge', `web:${merchant.id}:${payer.id}:${input.requestId}`);
  if (idem.status === 'DUPLICATE') {
    return { ok: false, message: '이미 처리 중인 결제입니다. 잠시 후 후원 내역에서 확인해 주세요.' };
  }

  let charge;
  try {
    charge = await prisma.charge.create({
      data: {
        id: newId(),
        transactionNo: newTransactionNo(),
        merchantId: merchant.id,
        payerId: payer.id,
        channel: 'WEB',
        amount: input.amount,
        // 닉네임을 설정하지 않았으면 번호 끝 4자리로 만든 기본 이름을 쓴다 (예: 후원자5678).
        // phoneMasked(010-****-5678)에도 끝 4자리는 남아 있어 그대로 재료로 쓸 수 있다.
        displayName: payerDisplayName(payer.displayName, payer.phoneMasked),
        message: filtered.clean,
        messageRawEnc: encrypt(input.message),
        status: 'RECEIVED',
        statusReason: '후원 페이지 웹 후원',
        paymentMode: resolvePaymentMode(merchant.paymentMode),
        campaignId,
        anonymous: Boolean(input.anonymous),
      },
    });
  } catch (error) {
    // 결제 생성에 실패했는데 멱등키를 IN_PROGRESS 로 남기면 TTL(7일) 동안
    // 같은 requestId 재제출이 전부 DUPLICATE 로 막힌다. 키를 지워 재시도를 허용한다.
    await idem.abort();
    throw error;
  }
  await idem.release(charge.id);

  // 기본 경로: 결제사 PIN 입력 링크를 문자로 보낸다. 이 시점에는 출금이 일어나지 않는다.
  if (resolveWebChargeChannel() === 'PIN') {
    const pin = await startPinAuthorization(charge.id);
    return {
      ok: pin.ok,
      status: pin.status,
      chargeId: charge.id,
      transactionNo: charge.transactionNo,
      message: pin.message,
      pinExpiresAt: pin.expiresAt,
      pinMock: pin.mock,
    };
  }

  // ── deprecated: 즉시 결제 ─────────────────────────────────────────────
  // 화면에서 금액을 확인하고 버튼을 눌렀다는 것만으로 곧바로 출금한다.
  // ALLOW_LEGACY_WEB_INSTANT_PAY=true 일 때만 이 경로를 탄다.
  const paid = await executePayment(charge.id);
  return {
    ok: paid.ok,
    status: paid.status,
    chargeId: charge.id,
    transactionNo: charge.transactionNo,
    message: paid.ok
      ? '결제가 완료되었습니다. 결제된 건만 사회복지기관에 후원으로 반영됩니다.'
      : paid.message,
  };
}
