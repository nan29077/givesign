'use server';

import { logger } from '@/lib/logger';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { requireMerchant, writeAudit } from '@/server/auth';
import { RETURN_SHIPMENT_STATUSES, shipmentStatusLabel } from '@/lib/labels';
import { newId } from '@/lib/id';
import { accountTail4, decrypt, encrypt, isValidResident, maskName, maskResident, normalizeResident } from '@/lib/crypto';
import { resolvePolicy } from '@/server/services/limits';
import { issueMerchantApiKey } from '@/server/services/partner-auth';
import { formatWon } from '@/lib/money';
import { loadBannedWords, sendMt } from '@/server/services/charge-flow';
import { requestRefund } from '@/server/services/refund';
import {
  THANKS_MT_MAX_LENGTH, THANKS_MT_VARIABLES, MO_GUIDE_MAX_LENGTH, MO_GUIDE_VARIABLES,
  tplChargeSuccess, tplSelectAmount, tplShipmentSent,
} from '@/server/services/mt-templates';
import { env } from '@/lib/env';
import { getPublicBaseUrl } from '@/server/public-base-url';
import { bannedNeedle, filterContent } from '@/server/services/content-filter';
import { upsertMerchantTemplate } from '@/server/services/merchant-mt';
import { WEBHOOK_EVENT_META, deliverOnce, registerWebhook } from '@/server/services/webhooks';
import {
  MAX_EXTRA_IMAGES, noticeCategoryOf, optionsToStorage, parseOptionLines, parseOptionsJson,
} from '@/server/services/products';
import { bankName } from '@/components/studio/banks';
import { Prisma } from '@/generated/prisma/client';
import type { DigitalProductType, FulfillmentMode, ProductKind } from '@/generated/prisma/enums';
import { MAX_CHARGE_PRODUCTS, PAID_STATUSES } from '@/components/studio/shared';

/**
 * 사회복지기관 관리자(/studio) 서버 액션.
 *
 * 공통 규칙
 *  - 모든 액션은 requireMerchant() 로 로그인/권한을 확인한다.
 *  - 대상 레코드의 merchantId 가 본인 것인지 반드시 재검증한 뒤에만 변경한다.
 *  - 입력은 zod 로 검증하고, 실패 사유는 사람이 읽을 수 있는 한국어로 반환한다.
 *  - 후원자 전화번호 원문/금융정보는 어떤 경로로도 반환하지 않는다.
 */

export interface StudioActionState {
  ok: boolean;
  message?: string;
  /** 1회만 노출하는 비밀값(API 키 등). 저장하지 않는다. */
  secret?: string;
  secretLabel?: string;
  secretHint?: string;
  /**
   * 처리 후 이동할 주소.
   *
   * 등록·복제·보관처럼 "이 화면에 더 있을 이유가 없는" 동작에서만 채운다.
   * 폼 컴포넌트가 알림을 보여 준 뒤 이동한다(서버에서 redirect 하면 결과 문구가 사라진다).
   */
  redirectTo?: string;
}

type Handler = (merchantId: string, userId: string) => Promise<StudioActionState>;

async function withMerchant(fn: Handler): Promise<StudioActionState> {
  let merchantId: string;
  let userId: string;
  try {
    const user = await requireMerchant();
    merchantId = user.merchantId;
    userId = user.id;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '사회복지기관 권한이 필요합니다.' };
  }
  try {
    return await fn(merchantId, userId);
  } catch (e) {
    return { ok: false, message: userFacingError(e) };
  }
}

/**
 * 서비스 계층이 던진 한국어 안내문은 그대로 보여 주고,
 * Prisma/복호화 등 내부 오류 메시지는 로그로만 남기고 일반 문구로 바꾼다.
 */
function userFacingError(e: unknown): string {
  const message = (e as Error)?.message ?? '';
  const internal = !message || /prisma|invocation|decrypt|ECONNREFUSED|ETIMEDOUT/i.test(message) || !/[가-힣]/.test(message);
  if (internal) {
    logger.error('스튜디오 액션 처리 오류', { message });
    return '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
  }
  return message;
}

function text(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function checked(formData: FormData, key: string): boolean {
  return formData.get(key) != null;
}

function parseAmount(input: string): bigint | null {
  const v = input.replace(/[,\s원]/g, '');
  if (!/^\d{1,12}$/.test(v)) return null;
  return BigInt(v);
}

// ===========================================================================
// 후원자 차단 / 해제
// ===========================================================================

/** 본인 채널과 실제로 연결된 후원자인지 확인한다. */
async function assertPayerLinked(merchantId: string, payerId: string) {
  const [charge, link] = await Promise.all([
    prisma.charge.findFirst({ where: { merchantId, payerId }, select: { id: true } }),
    prisma.payerMerchantLink.findUnique({
      where: { payerId_merchantId: { payerId, merchantId } },
      select: { id: true },
    }),
  ]);
  if (!charge && !link) throw new Error('본인 채널과 연결된 후원자가 아닙니다.');
}

export async function blockPayerAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const parsed = z
      .object({ payerId: z.string().min(1), reason: z.string().max(200).optional() })
      .safeParse({ payerId: text(formData, 'payerId'), reason: text(formData, 'reason') || undefined });
    if (!parsed.success) return { ok: false, message: '차단할 후원자 정보가 올바르지 않습니다.' };

    const { payerId, reason } = parsed.data;
    await assertPayerLinked(merchantId, payerId);

    await prisma.blockedPayer.upsert({
      where: { merchantId_payerId: { merchantId, payerId } },
      create: { id: newId(), merchantId, payerId, reason: reason ?? null, blockedBy: userId },
      update: { reason: reason ?? null, blockedBy: userId },
    });

    revalidatePath('/studio/moderation');
    revalidatePath('/studio/charges');
    revalidatePath('/studio/messages');
    return { ok: true, message: '해당 후원자를 차단했습니다. 이후 문자는 결제로 접수되지 않습니다.' };
  });
}

export async function unblockPayerAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const payerId = text(formData, 'payerId');
    if (!payerId) return { ok: false, message: '후원자 정보가 올바르지 않습니다.' };

    const deleted = await prisma.blockedPayer.deleteMany({ where: { merchantId, payerId } });
    if (deleted.count === 0) return { ok: false, message: '차단 목록에 없는 후원자입니다.' };

    revalidatePath('/studio/moderation');
    return { ok: true, message: '차단을 해제했습니다.' };
  });
}

// ===========================================================================
// ===========================================================================


// ===========================================================================
// ===========================================================================

// ===========================================================================
// 후원금 지급 처리
// ===========================================================================

/**
 * 후원금 지급은 사회복지기관이 자기 서비스에서 한다.
 * 기브싸인는 "이 결제 건을 처리했는가" 만 기록해, 빠뜨린 건과 환불 회수 대상을 알 수 있게 한다.
 *
 * 지급 대상은 결제가 완료된 건뿐이다. 결제되지 않은 건을 지급 완료로 표시하면
 * 사회복지기관이 받지도 않은 돈에 후원금를 주게 된다.
 */
const POINT_PAYABLE_STATUSES = PAID_STATUSES;

/** 한 번에 처리할 수 있는 건수 상한. 화면에서 실수로 전체를 누르는 사고를 막는다. */
const POINT_BULK_MAX = 200;

function chargeIdsOf(formData: FormData): string[] {
  const raw = formData.getAll('chargeIds').map((v) => String(v).trim()).filter(Boolean);
  return [...new Set(raw)];
}

/** 선택한 결제 건을 지급 완료로 표시한다(일괄). */
export async function markPointsGivenAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const ids = chargeIdsOf(formData);
    if (ids.length === 0) return { ok: false, message: '처리할 결제 건을 선택해 주세요.' };
    if (ids.length > POINT_BULK_MAX) {
      return { ok: false, message: `한 번에 최대 ${POINT_BULK_MAX}건까지 처리할 수 있습니다.` };
    }
    const note = text(formData, 'note').slice(0, 100);

    // 내 사회복지기관의, 결제가 완료된, 아직 지급하지 않은 건만 바꾼다.
    const result = await prisma.charge.updateMany({
      where: {
        id: { in: ids },
        merchantId,
        status: { in: POINT_PAYABLE_STATUSES },
        pointStatus: { in: ['PENDING', 'FAILED'] },
      },
      data: {
        pointStatus: 'SENT',
        pointGivenAt: new Date(),
        pointBy: userId,
        pointNote: note || null,
      },
    });

    revalidatePath('/studio/charges');
    revalidatePath('/studio');
    if (result.count === 0) {
      return { ok: false, message: '처리할 수 있는 건이 없습니다. 이미 처리됐거나 결제가 완료되지 않은 건입니다.' };
    }
    return { ok: true, message: `${result.count}건을 지급 완료로 표시했습니다.` };
  });
}

/** 지급을 보류한다(사유를 남긴다). */
export async function markPointsHeldAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const ids = chargeIdsOf(formData);
    const note = text(formData, 'note').slice(0, 100);
    if (ids.length === 0) return { ok: false, message: '처리할 결제 건을 선택해 주세요.' };
    if (!note) return { ok: false, message: '보류 사유를 입력해 주세요.' };

    const result = await prisma.charge.updateMany({
      where: { id: { in: ids }, merchantId, pointStatus: { in: ['PENDING', 'SENT'] } },
      // 지급 완료였던 건을 보류로 되돌릴 때 지급 시각을 지운다.
      // 남겨 두면 "보류 중인데 지급 시각이 있는" 건이 되어 지급 여부를 판단할 수 없다.
      data: { pointStatus: 'FAILED', pointNote: note, pointBy: userId, pointGivenAt: null },
    });

    revalidatePath('/studio/charges');
    if (result.count === 0) return { ok: false, message: '처리할 수 있는 건이 없습니다.' };
    return { ok: true, message: `${result.count}건을 보류로 표시했습니다.` };
  });
}

/** 지급 완료 표시를 되돌린다(잘못 눌렀을 때). */
export async function undoPointsGivenAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const ids = chargeIdsOf(formData);
    if (ids.length === 0) return { ok: false, message: '처리할 결제 건을 선택해 주세요.' };

    const result = await prisma.charge.updateMany({
      where: { id: { in: ids }, merchantId, pointStatus: 'SENT' },
      data: { pointStatus: 'PENDING', pointGivenAt: null, pointBy: userId, pointNote: null },
    });

    revalidatePath('/studio/charges');
    if (result.count === 0) return { ok: false, message: '되돌릴 수 있는 건이 없습니다.' };
    return { ok: true, message: `${result.count}건을 지급 대기로 되돌렸습니다.` };
  });
}

// ===========================================================================
// 후원 항목 · 결제 설정
// ===========================================================================

/**
 * 사회복지기관이 고를 수 있는 유효 금액 범위.
 * 관리자 지정 사회복지기관 범위 ∩ 한도 정책 범위 — 여기를 벗어난 금액은 결제 접수 시 AMOUNT_RANGE 로
 * 전부 실패하므로, 상품을 만드는 단계에서 미리 막는다.
 */
async function effectiveAmountRange(merchantId: string) {
  const [merchant, policy] = await Promise.all([
    prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { minAmount: true, maxAmount: true },
    }),
    resolvePolicy(merchantId, null),
  ]);
  if (!merchant) return null;
  const min = merchant.minAmount > policy.minAmount ? merchant.minAmount : policy.minAmount;
  const max = merchant.maxAmount < policy.maxAmount ? merchant.maxAmount : policy.maxAmount;
  return { min, max };
}

/**
 * 직접 입력 설정.
 *
 * 허용 여부뿐 아니라 사회복지기관 자체 범위·배수 단위까지 받는다.
 * 플랫폼 한도보다 넓힐 수는 없다(좁히는 용도).
 */
export async function updateChargeSettingsAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const allowCustomAmount = checked(formData, 'allowCustomAmount');

    if (!allowCustomAmount) {
      // 직접 입력을 끄는데 고를 상품이 하나도 없으면 결제가 아예 불가능해진다.
      const usable = await prisma.chargeProduct.count({
        where: { merchantId, active: true, archivedAt: null },
      });
      if (usable === 0) {
        return {
          ok: false,
          message: '직접 입력을 끄려면 노출 중인 상품이 최소 1개 있어야 합니다.',
        };
      }
    }

    const range = await effectiveAmountRange(merchantId);
    if (!range) return { ok: false, message: '사회복지기관 정보를 찾을 수 없습니다.' };

    const customMin = amountOrNull(formData, 'customMinAmount');
    if (customMin === 'ERR') return { ok: false, message: '직접 입력 최소 금액은 숫자만 입력해 주세요.' };
    const customMax = amountOrNull(formData, 'customMaxAmount');
    if (customMax === 'ERR') return { ok: false, message: '직접 입력 최대 금액은 숫자만 입력해 주세요.' };
    const step = intOrNull(formData, 'customAmountStep', 1_000_000);
    if (step === 'ERR') return { ok: false, message: '입력 단위는 0 이상 정수로 입력해 주세요.' };

    if (customMin !== null && customMin < range.min) {
      return { ok: false, message: `직접 입력 최소 금액은 ${formatWon(range.min)} 이상이어야 합니다. (플랫폼 한도)` };
    }
    if (customMax !== null && customMax > range.max) {
      return { ok: false, message: `직접 입력 최대 금액은 ${formatWon(range.max)} 이하여야 합니다. (플랫폼 한도)` };
    }
    // 최소값만 검사하면 "최대 100원" 처럼 플랫폼 하한보다 낮은 최대값이 저장된다.
    // 그러면 후원자가 입력할 수 있는 금액이 하나도 없는 화면이 된다.
    if (customMax !== null && customMax < range.min) {
      return { ok: false, message: `직접 입력 최대 금액은 ${formatWon(range.min)} 이상이어야 합니다. (플랫폼 한도)` };
    }
    if (customMin !== null && customMax !== null && customMin > customMax) {
      return { ok: false, message: '직접 입력 최소 금액이 최대 금액보다 큽니다.' };
    }
    // 단위가 범위와 어긋나면 어떤 값도 입력할 수 없는 화면이 된다.
    if (step !== null && step > 1) {
      const lo = customMin ?? range.min;
      const hi = customMax ?? range.max;
      const first = ((lo + BigInt(step) - 1n) / BigInt(step)) * BigInt(step);
      if (first > hi) {
        return {
          ok: false,
          message: `${step.toLocaleString('ko-KR')}원 단위로는 ${formatWon(lo)} ~ ${formatWon(hi)} 사이에 입력할 수 있는 금액이 없습니다.`,
        };
      }
    }

    await prisma.merchantProfile.update({
      where: { id: merchantId },
      data: {
        allowCustomAmount,
        customMinAmount: customMin,
        customMaxAmount: customMax,
        customAmountStep: step !== null && step > 1 ? step : null,
      },
    });
    revalidatePath('/studio/settings');
    revalidatePath('/studio');
    return {
      ok: true,
      message: allowCustomAmount ? '직접 입력 설정을 저장했습니다.' : '직접 입력을 끄고 등록된 상품만 노출합니다.',
    };
  });
}

/**
 * 안내 문자 테스트 발송.
 *
 * 저장만 하고 실제 문자를 못 받아 보면, 줄바꿈이 어떻게 끊기는지·치환자가 제대로 들어가는지
 * 실제로 나가 봐야 안다. 사회복지기관 담당자 번호로만 보낸다(임의 번호로 보내면 스팸 도구가 된다).
 */
export async function sendTestMtAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const kind = text(formData, 'kind');
    if (kind !== 'moGuide' && kind !== 'thanks') return { ok: false, message: '보낼 문자를 고르지 못했습니다.' };

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { phoneEnc: true, phoneMasked: true } });
    if (!user?.phoneEnc) {
      return { ok: false, message: '계정에 등록된 휴대폰 번호가 없습니다. 프로필 설정에서 번호를 먼저 등록해 주세요.' };
    }

    const merchant = await prisma.merchantProfile.findUniqueOrThrow({
      where: { id: merchantId },
      select: { displayName: true, code: true, thanksMtMessage: true, moGuideMtMessage: true },
    });
    const products = await prisma.chargeProduct.findMany({
      where: { merchantId, active: true, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }],
      select: { name: true },
    });

    const template =
      kind === 'moGuide'
        ? tplSelectAmount({
            merchantName: merchant.displayName,
            link: `${await getPublicBaseUrl()}/r/TESTTEST`,
            ttlMin: Math.floor(env.payment.selectTtlSec / 60),
            productNames: products.map((p) => p.name),
            custom: merchant.moGuideMtMessage,
          })
        : tplChargeSuccess({
            payerName: '홍길동',
            merchantName: merchant.displayName,
            amount: 3_000n,
            message: '테스트 발송입니다',
            cumulative: 12_000n,
            custom: merchant.thanksMtMessage,
          });

    const sent = await sendMt({ phone: decrypt(user.phoneEnc), template, merchantId });
    return sent
      ? { ok: true, message: `${user.phoneMasked ?? '등록된 번호'} 로 테스트 문자를 보냈습니다. 실제 발송 문구와 같습니다.` }
      : { ok: false, message: '테스트 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.' };
  });
}

/** 연동 키의 IP 허용목록 저장. 비우면 어디서나 호출할 수 있다. */
export async function updateApiKeyIpsAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const keyId = text(formData, 'keyId');
    if (!keyId) return { ok: false, message: '키를 찾을 수 없습니다.' };

    const key = await prisma.merchantApiKey.findFirst({
      where: { id: keyId, merchantId, revokedAt: null },
      select: { id: true, name: true },
    });
    if (!key) return { ok: false, message: '유효한 키를 찾을 수 없습니다.' };

    const raw = text(formData, 'allowedIps');
    const list = raw
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 20);
    // IPv4 주소 또는 CIDR 만 받는다. 형식이 틀린 값을 저장하면 조용히 전부 막힌다.
    const bad = list.find((v) => !isIpv4OrCidr(v));
    if (bad) return { ok: false, message: `IP 형식이 올바르지 않습니다: ${bad} (예: 203.0.113.10 또는 203.0.113.0/24)` };

    await prisma.merchantApiKey.update({
      where: { id: keyId },
      data: { allowedIps: list.length > 0 ? list.join(',') : null },
    });
    revalidatePath('/studio/settings');
    return {
      ok: true,
      message: list.length > 0 ? `${key.name} 은(는) 이제 ${list.length}개 IP 에서만 호출됩니다.` : `${key.name} 의 IP 제한을 해제했습니다.`,
    };
  });
}

// ---------------------------------------------------------------------------
// 상품 (비실물 · 실물)
// ---------------------------------------------------------------------------

/** 상품 설명 최대 길이. 상세 설명을 담을 수 있도록 넉넉히 둔다. */
const PRODUCT_DESCRIPTION_MAX = 2000;

/** 폼이 보낸 반복 필드를 문자열 배열로 읽는다. */
function textList(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
}

/** 0 이상 정수. 비어 있으면 null, 형식이 틀리면 'ERR'. */
/**
 * IPv4 주소 또는 CIDR 표기인지 확인한다.
 *
 * `/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/` 는 자릿수만 보기 때문에 `300.1.1.1` 이나
 * `10.0.0.0/99` 를 통과시킨다. 그런 값이 허용목록에 저장되면 어떤 주소와도 맞지 않아
 * 그 키로 오는 요청이 전부 조용히 막힌다 — 사회복지기관은 이유를 알 수 없다.
 * 그래서 각 자리 값과 프리픽스 길이까지 확인한다.
 */
function isIpv4OrCidr(value: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(value);
  if (!m) return false;
  for (let i = 1; i <= 4; i += 1) {
    const part = m[i]!;
    // 앞자리 0 은 8진수로 읽는 구현이 있어 해석이 갈린다. 받지 않는다.
    if (part.length > 1 && part.startsWith('0')) return false;
    if (Number(part) > 255) return false;
  }
  if (m[5] !== undefined) {
    if (m[5].length > 1 && m[5].startsWith('0')) return false;
    if (Number(m[5]) > 32) return false;
  }
  return true;
}

/**
 * 0 이상 정수. 비어 있으면 null, 형식이 틀리면 'ERR'.
 *
 * `Number.parseInt` 는 앞에서부터 읽다가 숫자가 아닌 글자를 만나면 **거기서 멈춘다.**
 * 그래서 "1,000" 은 오류가 아니라 조용히 1 이 되고, "10개" 는 10 이 된다.
 * 입력란이 숫자 전용(type=number)이 아니라 텍스트라 실제로 이런 값이 들어온다.
 * 전체가 숫자인지 먼저 확인하고, 천 단위 쉼표만 사람이 흔히 넣는 표기라 받아 준다.
 */
function intOrNull(formData: FormData, key: string, max: number): number | null | 'ERR' {
  const raw = text(formData, key);
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '');
  if (!/^\d+$/.test(cleaned)) return 'ERR';
  const n = Number(cleaned);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) return 'ERR';
  return n;
}

/** 0 이상 금액. 비어 있으면 null, 형식이 틀리면 'ERR'. */
function amountOrNull(formData: FormData, key: string): bigint | null | 'ERR' {
  const raw = text(formData, key);
  if (!raw) return null;
  const v = parseAmount(raw);
  if (v === null || v < 0n) return 'ERR';
  return v;
}

/**
 * 폼에서 상품 값을 읽어 검증한다.
 *
 * 비실물(후원금·상품권·이용권·컨텐츠)과 실물(배송비·재고·옵션·반품)은 필요한 값이 다르다.
 * 두 경로가 각각 검증하면 규칙이 갈라지므로 여기 한 곳에서만 판단한다.
 */
async function parseProductForm(
  merchantId: string,
  formData: FormData,
): Promise<{ ok: false; message: string } | { ok: true; data: Prisma.ChargeProductUncheckedCreateInput }> {
  const kindRaw = text(formData, 'kind').toUpperCase();
  if (kindRaw !== 'DIGITAL' && kindRaw !== 'PHYSICAL' && kindRaw !== 'DOCUMENT') {
    return { ok: false, message: '상품 종류를 선택해 주세요.' };
  }
  const kind = kindRaw as ProductKind;

  const name = text(formData, 'name').slice(0, 40);
  if (!name) return { ok: false, message: '상품 이름을 입력해 주세요.' };

  const amount = parseAmount(text(formData, 'amount'));
  if (amount === null || amount <= 0n) return { ok: false, message: '판매 금액은 숫자만 입력해 주세요.' };

  const range = await effectiveAmountRange(merchantId);
  if (!range) return { ok: false, message: '사회복지기관 정보를 찾을 수 없습니다.' };
  if (range.min > range.max) {
    return { ok: false, message: '관리자 설정과 한도 정책이 충돌해 만들 수 있는 금액이 없습니다. 고객센터로 문의해 주세요.' };
  }
  if (amount < range.min || amount > range.max) {
    // 실물은 여기에 배송비까지 더해져 결제되므로, 상품값만으로도 한도를 넘으면 아예 팔 수 없다.
    return {
      ok: false,
      message:
        kind === 'PHYSICAL'
          ? `실물 상품 가격은 ${formatWon(range.min)} ~ ${formatWon(range.max)} 사이여야 합니다. (결제 시 배송비가 더해지므로 한도를 꽉 채우지 마세요)`
          : `판매 금액은 ${formatWon(range.min)} ~ ${formatWon(range.max)} 사이여야 합니다.`,
    };
  }

  const description = text(formData, 'description').slice(0, PRODUCT_DESCRIPTION_MAX) || null;
  // 상품 이미지 주소도 프로필·배너와 같은 기준으로 검증한다.
  // 무검증으로 저장하면 결제 화면의 <img src> 가 제3자 도메인을 가리키게 되어
  // 그 화면을 여는 모든 후원자의 IP·UA 가 새어 나가고, javascript: 같은 스킴도 그대로 남는다.
  const imageUrl = safeImageUrl(text(formData, 'imageUrl').slice(0, 500), '상품 이미지 주소');

  // 추가 이미지도 같은 기준으로 검증한다. 하나라도 형식이 틀리면 safeImageUrl 이 던진다.
  const extra = textList(formData, 'extraImage')
    .slice(0, MAX_EXTRA_IMAGES)
    .map((v) => safeImageUrl(v.slice(0, 500), '상품 추가 이미지 주소'))
    .filter((v): v is string => Boolean(v));

  // 상품정보 제공 고시. 라벨/값을 쌍으로 받아 저장한다(값이 빈 항목은 남기되 경고만 한다).
  const noticeCategory = noticeCategoryOf(text(formData, 'noticeCategory')).key;
  const noticeLabels = formData.getAll('noticeLabel').map((v) => String(v ?? '').trim());
  const noticeValues = formData.getAll('noticeValue').map((v) => String(v ?? '').trim());
  const noticeItems = noticeLabels
    .map((label, i) => ({ label: label.slice(0, 40), value: (noticeValues[i] ?? '').slice(0, 200) }))
    .filter((it) => it.label.length > 0);

  const base = {
    id: newId(),
    merchantId,
    kind,
    name,
    amount,
    description,
    imageUrl,
    images: extra.length > 0 ? (extra as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    taxFree: checked(formData, 'taxFree'),
    noticeInfo:
      kind === 'PHYSICAL' && noticeItems.length > 0
        ? ({ category: noticeCategory, items: noticeItems } as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
    // 노출 순서(sortOrder)는 여기서 다루지 않는다.
    // 폼에 입력칸이 없으므로 읽으면 항상 0 이 되어, 저장할 때마다 진열 순서가 초기화된다.
    // 순서는 등록 시점과 목록의 위/아래 버튼(moveChargeProductAction)에서만 정한다.
    active: formData.has('activePresent') ? checked(formData, 'active') : true,
  } satisfies Partial<Prisma.ChargeProductUncheckedCreateInput> as Prisma.ChargeProductUncheckedCreateInput;

  if (kind === 'DIGITAL') {
    const typeRaw = text(formData, 'digitalType').toUpperCase();
    if (typeRaw !== 'POINT' && typeRaw !== 'VOUCHER' && typeRaw !== 'PASS' && typeRaw !== 'CONTENT') {
      return { ok: false, message: '비실물 상품 유형(후원금·상품권·이용권·컨텐츠)을 선택해 주세요.' };
    }
    const digitalType = typeRaw as DigitalProductType;

    // 후원금는 금액과 1:1 이 원칙이다. 보너스를 주려면 지급 수량을 따로 적는다.
    const giveRaw = text(formData, 'giveAmount');
    let giveAmount = giveRaw ? parseAmount(giveRaw) : null;
    if (giveRaw && (giveAmount === null || giveAmount <= 0n)) {
      return { ok: false, message: '지급 수량은 숫자만 입력해 주세요.' };
    }
    if (digitalType === 'POINT' && giveAmount === null) giveAmount = amount;

    const validRaw = text(formData, 'validDays');
    let validDays: number | null = null;
    if (validRaw) {
      // parseInt 의 "앞부분만 읽기" 를 쓰지 않는다. ("30일" 이 30 으로 조용히 통과한다)
      const n = /^\d+$/.test(validRaw.replace(/,/g, '')) ? Number(validRaw.replace(/,/g, '')) : NaN;
      if (!Number.isSafeInteger(n) || n < 1 || n > 3650) {
        return { ok: false, message: '유효기간은 1~3650일 사이 정수로 입력해 주세요.' };
      }
      validDays = n;
    }
    if (digitalType === 'PASS' && validDays === null) {
      return { ok: false, message: '이용권은 유효기간(일)을 입력해 주세요.' };
    }

    const modeRaw = text(formData, 'fulfillment').toUpperCase() || 'MANUAL';
    if (modeRaw !== 'MANUAL' && modeRaw !== 'API' && modeRaw !== 'INSTANT') {
      return { ok: false, message: '지급 방식을 선택해 주세요.' };
    }
    const fulfillment = modeRaw as FulfillmentMode;
    const fulfillmentNote = text(formData, 'fulfillmentNote').slice(0, 300) || null;
    if (fulfillment === 'INSTANT' && !fulfillmentNote) {
      return {
        ok: false,
        message: '결제 즉시 문자로 발급하려면 문자에 넣을 안내 문구(코드·다운로드 주소 등)를 입력해 주세요.',
      };
    }
    // 즉시 발급 문자에는 결제 링크와 같은 규칙을 적용한다. 개인정보·계좌번호는 넣을 수 없다.
    if (fulfillmentNote && /\d{2,3}-?\d{3,4}-?\d{4}/.test(fulfillmentNote)) {
      return { ok: false, message: '지급 안내 문구에 전화번호·계좌번호는 넣을 수 없습니다.' };
    }

    const withdrawalNotice = text(formData, 'withdrawalNotice').slice(0, 300) || null;
    // 디지털 콘텐츠는 사용 개시 시 청약철회가 제한된다. 고지를 강제한다.
    if (digitalType === 'CONTENT' && !withdrawalNotice) {
      return {
        ok: false,
        message: '컨텐츠 상품은 청약철회 제한 안내를 입력해야 합니다. (예: 다운로드·재생을 시작하면 환불이 제한됩니다)',
      };
    }

    return {
      ok: true,
      data: {
        ...base,
        digitalType,
        giveAmount,
        giveUnit: text(formData, 'giveUnit').slice(0, 10) || null,
        validDays,
        fulfillment,
        fulfillmentNote,
        withdrawalNotice,
      },
    };
  }

  // ── 문서 (약정서·주문서·계약서) ────────────────────────────────────
  //
  // 결제만으로 끝나지 않는 상품이다. 결제가 완료되면 연결된 서식으로 작성 링크를 만들어
  // 문자로 보낸다. 서식이 없으면 후원자는 결제만 하고 작성할 곳이 없으므로 필수로 받는다.
  if (kind === 'DOCUMENT') {
    const templateId = text(formData, 'documentTemplateId');
    if (!templateId) {
      return { ok: false, message: '연결할 문서 서식을 골라 주세요. 문서 관리에서 먼저 서식을 등록해야 합니다.' };
    }
    // 남의 서식을 붙일 수 없도록 merchantId 를 조건에 함께 건다.
    const template = await prisma.documentTemplate.findFirst({
      where: { id: templateId, merchantId, archivedAt: null },
      select: { id: true, name: true, active: true },
    });
    if (!template) return { ok: false, message: '문서 서식을 찾을 수 없습니다.' };
    // 이미 이 상품에 붙어 있던 서식은 중지 상태여도 그대로 저장할 수 있게 둔다.
    // 그러지 않으면 서식을 잠시 중지해 둔 사이에 상품 가격 하나 고치는 것조차 막힌다.
    // (중지된 서식을 쓰는 상품은 결제 화면 목록에서 빠진다 — charge-select)
    const keeping = text(formData, 'currentDocumentTemplateId') === template.id;
    if (!template.active && !keeping) {
      return {
        ok: false,
        message: `${template.name} 서식이 중지 상태입니다. 문서 관리에서 사용을 켠 뒤 연결해 주세요.`,
      };
    }

    return {
      ok: true,
      data: {
        ...base,
        documentTemplateId: template.id,
        // 문서 상품은 후원금·상품권을 주는 거래가 아니다. 지급 대기 목록에 섞이지 않게
        // 결제 확정(charge-select)에서 pointStatus 를 SKIPPED 로 둔다.
        fulfillment: 'MANUAL',
      },
    };
  }

  // ── 실물 ──────────────────────────────────────────────────────────
  const stock = intOrNull(formData, 'stock', 1_000_000);
  if (stock === 'ERR') return { ok: false, message: '재고는 0 이상 1,000,000 이하 정수로 입력해 주세요. (비우면 무제한)' };
  const stockAlert = intOrNull(formData, 'stockAlert', 1_000_000);
  if (stockAlert === 'ERR') return { ok: false, message: '재고 경고 기준은 0 이상 정수로 입력해 주세요.' };
  const maxPerOrder = intOrNull(formData, 'maxPerOrder', 999);
  if (maxPerOrder === 'ERR') return { ok: false, message: '1회 주문 최대 수량은 1~999 사이 정수로 입력해 주세요.' };
  if (maxPerOrder !== null && maxPerOrder < 1) {
    return { ok: false, message: '1회 주문 최대 수량은 1 이상이어야 합니다. (비우면 제한 없음)' };
  }
  const dispatchDays = intOrNull(formData, 'dispatchDays', 30);
  if (dispatchDays === 'ERR') return { ok: false, message: '출고 소요일은 0~30일 사이 정수로 입력해 주세요. (비우면 기본 배송정책)' };

  const freeShipping = checked(formData, 'freeShipping');

  const shippingFee = amountOrNull(formData, 'shippingFee');
  if (shippingFee === 'ERR') return { ok: false, message: '배송비는 0 이상 숫자로 입력해 주세요. (비우면 기본 배송정책)' };

  const overRaw = text(formData, 'freeShipOver');
  let freeShipOver: bigint | null = null;
  if (overRaw) {
    const v = parseAmount(overRaw);
    if (v === null || v <= 0n) return { ok: false, message: '조건부 무료 기준 금액은 0보다 큰 숫자로 입력해 주세요.' };
    freeShipOver = v;
  }

  const returnFee = amountOrNull(formData, 'returnFee');
  if (returnFee === 'ERR') return { ok: false, message: '반품 배송비는 0 이상 숫자로 입력해 주세요. (비우면 기본 배송정책)' };
  const exchangeFee = amountOrNull(formData, 'exchangeFee');
  if (exchangeFee === 'ERR') return { ok: false, message: '교환 배송비는 0 이상 숫자로 입력해 주세요. (비우면 기본 배송정책)' };

  // 옵션은 편집기가 보낸 JSON 을 먼저 보고, 없으면 여러 줄 텍스트로 되돌아간다.
  const optionsJson = text(formData, 'optionsJson');
  const options = optionsJson ? parseOptionsJson(optionsJson) : parseOptionLines(text(formData, 'options'));

  // 옵션 추가금이 붙으면 결제 금액이 한도를 넘을 수 있다. 가장 비싼 조합으로 미리 막는다.
  const maxAdd = options.reduce(
    (sum, o) => sum + o.values.reduce((m, v) => (v.addPrice > m ? v.addPrice : m), 0n),
    0n,
  );
  if (amount + maxAdd > range.max) {
    return {
      ok: false,
      message: `옵션 추가금을 모두 더하면 ${formatWon(amount + maxAdd)} 이 되어 결제 한도(${formatWon(range.max)})를 넘습니다. 추가금을 줄여 주세요.`,
    };
  }

  return {
    ok: true,
    data: {
      ...base,
      sku: text(formData, 'sku').slice(0, 40) || null,
      stock,
      stockAlert,
      maxPerOrder,
      dispatchDays,
      freeShipping,
      shippingFee,
      freeShipOver,
      returnFee,
      exchangeFee,
      options:
        options.length > 0 ? (optionsToStorage(options) as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    },
  };
}

/** 상품 추가 (비실물·실물 공용). */
export async function createChargeProductAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const parsed = await parseProductForm(merchantId, formData);
    if (!parsed.ok) return { ok: false, message: parsed.message };

    const count = await prisma.chargeProduct.count({
      where: { merchantId, kind: parsed.data.kind, archivedAt: null },
    });
    if (count >= MAX_CHARGE_PRODUCTS) {
      return { ok: false, message: `상품은 종류별로 최대 ${MAX_CHARGE_PRODUCTS}개까지 등록할 수 있습니다.` };
    }

    // 같은 이름이 둘이면 후원자가 결제 화면에서 무엇을 고르는지 알 수 없다.
    const dup = await prisma.chargeProduct.findFirst({
      where: { merchantId, name: parsed.data.name, archivedAt: null },
      select: { id: true },
    });
    if (dup) return { ok: false, message: '같은 이름의 상품이 이미 있습니다.' };

    const created = await prisma.chargeProduct.create({
      // 새 상품은 목록 맨 뒤에 붙인다(수정 저장은 순서를 건드리지 않는다).
      data: { ...parsed.data, sortOrder: count },
    });
    revalidateProducts();
    return { ok: true, message: `${created.name} 상품을 추가했습니다.`, redirectTo: `/studio/products/${created.id}` };
  });
}

/** 상품 수정. 종류(비실물/실물)는 바꿀 수 없다. */
export async function updateChargeProductAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'productId');
    if (!id) return { ok: false, message: '상품을 찾을 수 없습니다.' };

    // 남의 상품을 수정할 수 없도록 merchantId 를 조건에 함께 건다.
    const current = await prisma.chargeProduct.findFirst({
      where: { id, merchantId, archivedAt: null },
      select: { id: true, kind: true, documentTemplateId: true },
    });
    if (!current) return { ok: false, message: '상품을 찾을 수 없습니다.' };

    // 종류가 바뀌면 이미 팔린 주문의 배송 유무가 뒤집힌다. 폼 값 대신 저장된 종류를 쓴다.
    formData.set('kind', current.kind);
    // 지금 붙어 있는 서식이 무엇인지 알려 준다(중지된 서식을 유지하는 저장을 허용하기 위함).
    formData.set('currentDocumentTemplateId', current.documentTemplateId ?? '');
    const parsed = await parseProductForm(merchantId, formData);
    if (!parsed.ok) return { ok: false, message: parsed.message };

    const dup = await prisma.chargeProduct.findFirst({
      where: { merchantId, name: parsed.data.name, archivedAt: null, id: { not: id } },
      select: { id: true },
    });
    if (dup) return { ok: false, message: '같은 이름의 상품이 이미 있습니다.' };

    const { id: _newId, merchantId: _m, kind: _k, ...rest } = parsed.data;
    await prisma.chargeProduct.update({ where: { id }, data: rest });
    revalidateProducts();
    return { ok: true, message: '상품을 저장했습니다.' };
  });
}

/**
 * 상품 보관(소프트 삭제).
 * 과거 주문이 상품을 참조하므로 실제로 지우지 않는다.
 */
export async function archiveChargeProductAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'productId');
    if (!id) return { ok: false, message: '상품을 찾을 수 없습니다.' };

    const current = await prisma.chargeProduct.findFirst({
      where: { id, merchantId, archivedAt: null },
      select: { id: true, name: true, active: true },
    });
    if (!current) return { ok: false, message: '상품을 찾을 수 없습니다.' };

    const merchant = await prisma.merchantProfile.findUniqueOrThrow({
      where: { id: merchantId },
      select: { allowCustomAmount: true },
    });
    const remain = await prisma.chargeProduct.count({
      where: { merchantId, active: true, archivedAt: null, id: { not: id } },
    });
    // 이미 판매를 끈(active=false) 상품은 결제 페이지에 노출되지 않으므로, 보관해도
    // 후원자가 고를 수 있는 항목이 줄지 않는다. 그런데도 막으면 "판매 중인 상품이 하나도
    // 없는데 마지막 상품이라 보관도 못 하는" 상태가 된다.
    if (remain === 0 && current.active && !merchant.allowCustomAmount) {
      return {
        ok: false,
        message: '마지막 판매 중인 상품입니다. 먼저 직접 입력을 허용하거나 다른 상품을 추가해 주세요.',
      };
    }

    await prisma.chargeProduct.update({
      where: { id },
      data: { archivedAt: new Date(), active: false },
    });
    revalidateProducts();
    return { ok: true, message: `${current.name} 상품을 보관했습니다. 보관함에서 되살릴 수 있습니다.`, redirectTo: '/studio/products' };
  });
}

/**
 * 보관한 상품을 되살린다.
 *
 * 보관이 단방향이면 잘못 누른 사회복지기관이 상품을 통째로 다시 입력해야 한다.
 * 되살릴 때는 숨김(active=false) 상태로 돌려, 확인한 뒤 직접 노출하게 한다.
 */
export async function restoreChargeProductAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'productId');
    if (!id) return { ok: false, message: '상품을 찾을 수 없습니다.' };

    const current = await prisma.chargeProduct.findFirst({
      where: { id, merchantId, archivedAt: { not: null } },
      select: { id: true, name: true, kind: true },
    });
    if (!current) return { ok: false, message: '보관된 상품을 찾을 수 없습니다.' };

    // 되살리면 다시 상한을 차지한다. 상한을 넘으면 되돌릴 수 없다.
    const count = await prisma.chargeProduct.count({
      where: { merchantId, kind: current.kind, archivedAt: null },
    });
    if (count >= MAX_CHARGE_PRODUCTS) {
      return { ok: false, message: `사용 중인 상품이 이미 ${MAX_CHARGE_PRODUCTS}개입니다. 먼저 다른 상품을 보관해 주세요.` };
    }
    const dup = await prisma.chargeProduct.findFirst({
      where: { merchantId, name: current.name, archivedAt: null },
      select: { id: true },
    });
    if (dup) return { ok: false, message: '같은 이름의 상품이 이미 있습니다. 되살리기 전에 이름을 정리해 주세요.' };

    await prisma.chargeProduct.update({
      where: { id },
      data: { archivedAt: null, active: false },
    });
    revalidateProducts();
    return { ok: true, message: `${current.name} 상품을 되살렸습니다. 숨김 상태이니 확인 후 노출해 주세요.` };
  });
}

/**
 * 상품 복제.
 * 옵션만 다른 변형 상품을 만들 때 전부 다시 입력하지 않게 한다.
 */
export async function duplicateChargeProductAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'productId');
    if (!id) return { ok: false, message: '상품을 찾을 수 없습니다.' };

    const src = await prisma.chargeProduct.findFirst({ where: { id, merchantId, archivedAt: null } });
    if (!src) return { ok: false, message: '상품을 찾을 수 없습니다.' };

    const count = await prisma.chargeProduct.count({
      where: { merchantId, kind: src.kind, archivedAt: null },
    });
    if (count >= MAX_CHARGE_PRODUCTS) {
      return { ok: false, message: `상품은 종류별로 최대 ${MAX_CHARGE_PRODUCTS}개까지 등록할 수 있습니다.` };
    }

    // 이름이 겹치면 결제 화면에서 구분되지 않는다. 빈 번호를 찾아 붙인다.
    let name = '';
    for (let i = 2; i <= 20; i += 1) {
      const candidate = `${src.name} (${i})`.slice(0, 40);
      const exists = await prisma.chargeProduct.findFirst({
        where: { merchantId, name: candidate, archivedAt: null },
        select: { id: true },
      });
      if (!exists) {
        name = candidate;
        break;
      }
    }
    if (!name) return { ok: false, message: '복제본 이름을 만들지 못했습니다. 기존 복제본을 정리해 주세요.' };

    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src;
    const created = await prisma.chargeProduct.create({
      data: {
        ...rest,
        id: newId(),
        name,
        sku: null,
        // 복제본은 항상 숨김으로 만든다. 값을 고치기 전에 팔리면 안 된다.
        active: false,
        sortOrder: count,
        options: (src.options ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
        images: (src.images ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
        noticeInfo: (src.noticeInfo ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
      },
    });
    revalidateProducts();
    return {
      ok: true,
      message: `${created.name} 으로 복제했습니다. 숨김 상태이니 값을 확인한 뒤 노출해 주세요.`,
      redirectTo: `/studio/products/${created.id}`,
    };
  });
}

/**
 * 노출 순서를 한 칸 올리거나 내린다.
 *
 * 숫자를 직접 적게 하면 상품마다 저장을 눌러야 하고, 같은 숫자가 겹치면
 * 결제 화면 순서가 예측 불가능해진다. 같은 종류 안에서 자리만 맞바꾼다.
 */
export async function moveChargeProductAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'productId');
    const dir = text(formData, 'direction');
    if (!id || (dir !== 'up' && dir !== 'down')) return { ok: false, message: '이동 방향이 올바르지 않습니다.' };

    const target = await prisma.chargeProduct.findFirst({
      where: { id, merchantId, archivedAt: null },
      select: { id: true, kind: true },
    });
    if (!target) return { ok: false, message: '상품을 찾을 수 없습니다.' };

    const siblings = await prisma.chargeProduct.findMany({
      where: { merchantId, kind: target.kind, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    const index = siblings.findIndex((r) => r.id === id);
    const swapWith = dir === 'up' ? index - 1 : index + 1;
    if (index < 0 || swapWith < 0 || swapWith >= siblings.length) {
      return { ok: false, message: dir === 'up' ? '이미 첫 번째입니다.' : '이미 마지막입니다.' };
    }

    const reordered = [...siblings];
    [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
    // 순서를 0..n 으로 다시 매겨 중복·구멍을 없앤다.
    await prisma.$transaction(
      reordered.map((row, i) =>
        prisma.chargeProduct.update({ where: { id: row.id }, data: { sortOrder: i } }),
      ),
    );
    revalidateProducts();
    return { ok: true, message: '노출 순서를 바꿨습니다.' };
  });
}

/** 실물 상품 재고만 빠르게 조정한다(입고·조정). */
export async function adjustProductStockAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'productId');
    const raw = text(formData, 'stock');
    if (!id) return { ok: false, message: '상품을 찾을 수 없습니다.' };

    const current = await prisma.chargeProduct.findFirst({
      where: { id, merchantId, kind: 'PHYSICAL', archivedAt: null },
      select: { id: true, name: true },
    });
    if (!current) return { ok: false, message: '실물 상품을 찾을 수 없습니다.' };

    // 비우면 '무제한'으로 되돌린다.
    if (!raw) {
      await prisma.chargeProduct.update({ where: { id }, data: { stock: null } });
      revalidateProducts();
      return { ok: true, message: `${current.name} 재고를 무제한으로 바꿨습니다.` };
    }

    // "1,000" 이 1 로 저장되던 자리다. 전체가 숫자인지 보고, 천 단위 쉼표만 받아 준다.
    const n = /^\d+$/.test(raw.replace(/,/g, '')) ? Number(raw.replace(/,/g, '')) : NaN;
    if (!Number.isSafeInteger(n) || n < 0 || n > 1_000_000) {
      return { ok: false, message: '재고는 0 이상 1,000,000 이하 정수로 입력해 주세요.' };
    }
    await prisma.chargeProduct.update({ where: { id }, data: { stock: n } });
    revalidateProducts();
    return { ok: true, message: `${current.name} 재고를 ${n.toLocaleString('ko-KR')}개로 맞췄습니다.` };
  });
}

/** 상품 노출/숨김 토글. 목록에서 바로 쓴다. */
export async function toggleChargeProductActiveAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'productId');
    if (!id) return { ok: false, message: '상품을 찾을 수 없습니다.' };

    const current = await prisma.chargeProduct.findFirst({
      where: { id, merchantId, archivedAt: null },
      select: { id: true, name: true, active: true },
    });
    if (!current) return { ok: false, message: '상품을 찾을 수 없습니다.' };

    if (current.active) {
      // 마지막 노출 상품을 숨기면서 직접 입력도 꺼져 있으면 결제가 아예 막힌다.
      const merchant = await prisma.merchantProfile.findUniqueOrThrow({
        where: { id: merchantId },
        select: { allowCustomAmount: true },
      });
      const remain = await prisma.chargeProduct.count({
        where: { merchantId, active: true, archivedAt: null, id: { not: id } },
      });
      if (remain === 0 && !merchant.allowCustomAmount) {
        return { ok: false, message: '마지막 노출 상품입니다. 먼저 직접 입력을 허용하거나 다른 상품을 노출해 주세요.' };
      }
    }

    await prisma.chargeProduct.update({ where: { id }, data: { active: !current.active } });
    revalidateProducts();
    return {
      ok: true,
      message: current.active ? `${current.name} 을(를) 숨겼습니다.` : `${current.name} 을(를) 결제 화면에 노출합니다.`,
    };
  });
}

/** 사회복지기관 기본 배송·반품 정책 저장. 상품별 값이 없으면 이 값이 쓰인다. */
export async function saveShippingPolicyAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const baseFee = parseAmount(text(formData, 'baseFee'));
    if (baseFee === null || baseFee < 0n) return { ok: false, message: '기본 배송비는 0 이상 숫자로 입력해 주세요.' };
    if (baseFee > 100_000n) return { ok: false, message: '기본 배송비가 너무 큽니다. 100,000원 이하로 입력해 주세요.' };

    const overRaw = text(formData, 'freeOver');
    let freeOver: bigint | null = null;
    if (overRaw) {
      const v = parseAmount(overRaw);
      if (v === null || v <= 0n) return { ok: false, message: '조건부 무료 기준 금액은 0보다 큰 숫자로 입력해 주세요.' };
      freeOver = v;
    }

    const remoteFee = amountOrNull(formData, 'remoteFee');
    if (remoteFee === 'ERR') return { ok: false, message: '도서산간 추가 배송비는 0 이상 숫자로 입력해 주세요.' };
    const returnFee = amountOrNull(formData, 'returnFee');
    if (returnFee === 'ERR') return { ok: false, message: '반품 배송비는 0 이상 숫자로 입력해 주세요.' };
    const exchangeFee = amountOrNull(formData, 'exchangeFee');
    if (exchangeFee === 'ERR') return { ok: false, message: '교환 배송비는 0 이상 숫자로 입력해 주세요.' };

    const dispatchDays = intOrNull(formData, 'dispatchDays', 30);
    if (dispatchDays === 'ERR') return { ok: false, message: '출고 소요일은 0~30일 사이 정수로 입력해 주세요.' };

    const returnZip = text(formData, 'returnZipCode').replace(/[^\d]/g, '').slice(0, 5) || null;
    const returnAddress = text(formData, 'returnAddress').slice(0, 200) || null;
    // 반품지는 주소만 있고 우편번호가 없으면 택배사 접수가 안 된다. 둘 다 받거나 둘 다 비운다.
    if ((returnZip && !returnAddress) || (!returnZip && returnAddress)) {
      return { ok: false, message: '반품지는 우편번호와 주소를 함께 입력해 주세요.' };
    }

    const data = {
      baseFee,
      freeOver,
      remoteFee: remoteFee ?? 0n,
      returnFee: returnFee ?? 0n,
      exchangeFee: exchangeFee ?? 0n,
      dispatchDays: dispatchDays ?? 2,
      carrier: text(formData, 'carrier').slice(0, 30) || null,
      guide: text(formData, 'guide').slice(0, 300) || null,
      returnReceiver: text(formData, 'returnReceiver').slice(0, 30) || null,
      returnPhone: text(formData, 'returnPhone').replace(/[^\d-]/g, '').slice(0, 20) || null,
      returnZipCode: returnZip,
      returnAddress,
    };

    await prisma.merchantShippingPolicy.upsert({
      where: { merchantId },
      create: { id: newId(), merchantId, ...data },
      update: data,
    });
    revalidateProducts();
    revalidatePath('/studio/settings');
    return {
      ok: true,
      message: freeOver
        ? `배송정책을 저장했습니다. ${formatWon(baseFee)} · ${formatWon(freeOver)} 이상 무료배송`
        : `배송정책을 저장했습니다. 기본 배송비 ${formatWon(baseFee)}`,
    };
  });
}

/** 상품을 건드리는 액션이 공통으로 다시 그려야 하는 화면들. */
function revalidateProducts() {
  revalidatePath('/studio/products');
  revalidatePath('/studio/settings');
  revalidatePath('/studio');
}

// ===========================================================================
// 감사 문자 내용
// ===========================================================================

/** 감사 문자 본문에 허용하는 치환자 이름 */
const THANKS_TOKENS = THANKS_MT_VARIABLES.map((v) => v.token.slice(1, -1));

/**
 * 결제 감사 MT 문자 본문 저장.
 *
 * 검증 규칙
 *  - 200자 이내. 비우면 기본 문구로 돌아간다.
 *  - 링크(http/https/www) 금지. 감사 문자를 빌려 후원자를 외부로 유인하는 것을 막는다.
 *  - 정의되지 않은 치환자를 남기면 후원자에게 `{...}` 가 그대로 발송되므로 저장 단계에서 막는다.
 *  - 금칙어 필터는 후원자 메시지와 같은 규칙을 적용한다.
 */
export async function updateThanksMessageAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const raw = text(formData, 'thanksMtMessage');

    if (raw.length === 0) {
      await prisma.merchantProfile.update({ where: { id: merchantId }, data: { thanksMtMessage: null } });
      revalidatePath('/studio/settings');
      return { ok: true, message: '감사 문자를 기본 문구로 되돌렸습니다.' };
    }

    if (raw.length > THANKS_MT_MAX_LENGTH) {
      return { ok: false, message: `감사 문자는 ${THANKS_MT_MAX_LENGTH}자 이내로 입력해 주세요. (현재 ${raw.length}자)` };
    }
    if (/https?:\/\/|www\./i.test(raw)) {
      return { ok: false, message: '감사 문자에는 링크를 넣을 수 없습니다. 링크가 포함된 문자는 스팸으로 차단됩니다.' };
    }

    const unknown = [...raw.matchAll(/\{([^{}]*)\}/g)]
      .map((m) => m[1])
      .filter((name) => !THANKS_TOKENS.includes(name));
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `사용할 수 없는 치환자입니다: {${unknown[0]}} — ${THANKS_MT_VARIABLES.map((v) => v.token).join(' ')} 만 사용할 수 있습니다.`,
      };
    }

    // 후원자에게 발송되는 문구이므로 결제 메시지와 같은 금칙어 기준을 적용한다.
    const rules = await loadBannedWords(merchantId);
    const filtered = filterContent(raw, { bannedWords: rules, maxLength: THANKS_MT_MAX_LENGTH });
    // loadBannedWords 가 BLOCK 규칙을 MASK 로 내려 주므로 filtered.action 은 BLOCK 이 될 수 없다.
    // (예전에 있던 BLOCK 분기는 도달할 수 없는 코드라 제거했다)
    if (filtered.containsPersonalInfo) {
      return { ok: false, message: '전화번호·계좌번호 등 개인정보는 감사 문자에 넣을 수 없습니다.' };
    }

    await prisma.merchantProfile.update({ where: { id: merchantId }, data: { thanksMtMessage: raw } });
    revalidatePath('/studio/settings');
    return { ok: true, message: '감사 문자 내용을 저장했습니다. 다음 결제부터 적용됩니다.' };
  });
}

// ===========================================================================
// MO 안내 문자 (감사 문자와 별개)
// ===========================================================================

const MO_GUIDE_TOKENS = MO_GUIDE_VARIABLES.map((v) => v.token.slice(1, -1));

/**
 * MO 를 받았을 때 보내는 안내 문자 본문 저장.
 *
 * 결제가 끝난 뒤 보내는 감사 문자와는 **다른 문자**다. 이 문자에는 결제 링크가 붙는다.
 *
 * 검증 규칙 (감사 문자보다 엄격하다 — 링크가 붙는 문자라 사칭·피싱 위험이 크다)
 *  - 160자 이내. 비우면 기본 문구로 돌아간다.
 *  - 사회복지기관이 링크를 직접 넣을 수 없다. 결제 링크는 시스템이 본문 끝에 붙인다.
 *  - "아직 결제되지 않았습니다" 고지도 시스템이 붙이므로 지울 수 없다.
 *  - 정의되지 않은 치환자를 남기면 후원자에게 `{...}` 가 그대로 발송된다.
 */
export async function updateMoGuideMessageAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const raw = text(formData, 'moGuideMtMessage');

    if (raw.length === 0) {
      await prisma.merchantProfile.update({ where: { id: merchantId }, data: { moGuideMtMessage: null } });
      revalidatePath('/studio/settings');
      return { ok: true, message: 'MO 안내 문자를 기본 문구로 되돌렸습니다.' };
    }

    if (raw.length > MO_GUIDE_MAX_LENGTH) {
      return { ok: false, message: `안내 문자는 ${MO_GUIDE_MAX_LENGTH}자 이내로 입력해 주세요. (현재 ${raw.length}자) 결제 링크가 뒤에 붙으므로 여유를 두세요.` };
    }
    if (/https?:\/\/|www\./i.test(raw)) {
      return { ok: false, message: '안내 문자에는 링크를 넣을 수 없습니다. 결제 링크는 기브싸인가 본문 끝에 자동으로 붙입니다.' };
    }

    const unknown = [...raw.matchAll(/\{([^{}]*)\}/g)]
      .map((m) => m[1])
      .filter((name) => !MO_GUIDE_TOKENS.includes(name));
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `사용할 수 없는 치환자입니다: {${unknown[0]}} — ${MO_GUIDE_VARIABLES.map((v) => v.token).join(' ')} 만 사용할 수 있습니다.`,
      };
    }

    const rules = await loadBannedWords(merchantId);
    const filtered = filterContent(raw, { bannedWords: rules, maxLength: MO_GUIDE_MAX_LENGTH });
    // 위와 같은 이유로 BLOCK 은 도달 불가하다.
    if (filtered.containsPersonalInfo) {
      return { ok: false, message: '전화번호·계좌번호 등 개인정보는 안내 문자에 넣을 수 없습니다.' };
    }

    await prisma.merchantProfile.update({ where: { id: merchantId }, data: { moGuideMtMessage: raw } });
    revalidatePath('/studio/settings');
    return { ok: true, message: 'MO 안내 문자를 저장했습니다. 다음 문자부터 적용됩니다.' };
  });
}

// ===========================================================================
// 금칙어
// ===========================================================================

const WORD_ACTIONS = ['BLOCK', 'MASK', 'FLAG'] as const;

export async function createBannedWordAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const parsed = z
      .object({ word: z.string().trim().min(1).max(40), action: z.enum(WORD_ACTIONS) })
      .safeParse({ word: text(formData, 'word'), action: text(formData, 'action') });
    if (!parsed.success) return { ok: false, message: '금칙어는 1~40자로 입력하고 처리 방식을 선택해 주세요.' };

    const word = parsed.data.word;
    // 공백·구두점처럼 비교에서 무시하는 문자만으로 된 단어는 금칙어 구실을 못 한다.
    // (예전 정규식 구현에서는 이런 단어가 서버를 멈추게 만드는 입력이기도 했다)
    if (!bannedNeedle(word)) {
      return { ok: false, message: '공백이나 기호(. _ - * ~ = + /)만으로는 금칙어를 만들 수 없습니다.' };
    }

    const exists = await prisma.bannedWord.findFirst({ where: { merchantId, word, scope: 'MERCHANT' } });
    if (exists) return { ok: false, message: '이미 등록된 금칙어입니다.' };

    await prisma.bannedWord.create({
      data: { id: newId(), word, action: parsed.data.action, scope: 'MERCHANT', merchantId, active: true },
    });

    revalidatePath('/studio/moderation');
    return { ok: true, message: `금칙어 "${word}"를 등록했습니다.` };
  });
}

export async function toggleBannedWordAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'id');
    const row = await prisma.bannedWord.findUnique({ where: { id }, select: { merchantId: true, scope: true, active: true } });
    if (!row || row.merchantId !== merchantId || row.scope !== 'MERCHANT') {
      return { ok: false, message: '본인이 등록한 금칙어만 변경할 수 있습니다.' };
    }

    await prisma.bannedWord.update({ where: { id }, data: { active: !row.active } });
    revalidatePath('/studio/moderation');
    return { ok: true, message: row.active ? '금칙어를 사용 중지했습니다.' : '금칙어를 다시 사용합니다.' };
  });
}

export async function deleteBannedWordAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'id');
    const row = await prisma.bannedWord.findUnique({ where: { id }, select: { merchantId: true, scope: true } });
    if (!row || row.merchantId !== merchantId || row.scope !== 'MERCHANT') {
      return { ok: false, message: '본인이 등록한 금칙어만 삭제할 수 있습니다.' };
    }

    await prisma.bannedWord.delete({ where: { id } });
    revalidatePath('/studio/moderation');
    return { ok: true, message: '금칙어를 삭제했습니다.' };
  });
}

/** 자주 쓰는 기본 금칙어 세트(비속어 위주). 마스킹으로 등록한다. */
const DEFAULT_BANNED_WORDS = [
  '씨발', '시발', '개새끼', '병신', '지랄', '좆', '존나', '썅', '엿먹어', '닥쳐',
  '창녀', '보지', '자지', '섹스', '느금마', '니미', '꺼져', '죽어', '새끼',
];

/**
 * 기본 금칙어 세트를 한 번에 추가한다.
 * 이미 등록된 단어는 건너뛴다. 등록 후 개별로 처리 방식·사용 여부를 조정할 수 있다.
 */
export async function addDefaultBannedWordsAction(
  _prev: StudioActionState,
  _formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const existing = new Set(
      (await prisma.bannedWord.findMany({ where: { merchantId, scope: 'MERCHANT' }, select: { word: true } })).map((w) => w.word),
    );
    const toAdd = DEFAULT_BANNED_WORDS.filter((w) => !existing.has(w));
    if (toAdd.length === 0) return { ok: true, message: '기본 금칙어가 이미 모두 등록되어 있습니다.' };

    await prisma.bannedWord.createMany({
      data: toAdd.map((word) => ({ id: newId(), word, action: 'MASK' as const, scope: 'MERCHANT' as const, merchantId, active: true })),
    });
    revalidatePath('/studio/moderation');
    return { ok: true, message: `기본 금칙어 ${toAdd.length}개를 마스킹으로 추가했습니다. 필요에 따라 차단으로 바꿀 수 있습니다.` };
  });
}

/**
 * 금칙어 미리보기 — 입력 문장에 내 금칙어/전역 금칙어를 적용한 결과를 돌려준다.
 * 실제 결제를 만들지 않고 필터 결과만 확인한다.
 */
export async function testBannedWordsAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const sample = text(formData, 'sample');
    if (!sample) return { ok: false, message: '테스트할 문장을 입력해 주세요.' };

    const rules = await loadBannedWords(merchantId);
    const result = filterContent(sample, { bannedWords: rules, maxLength: 200 });

    // 금칙어는 결제를 막지 않는다. '차단됨' 은 나올 수 없는 결과라 표시하지 않는다.
    const verdict =
      result.action === 'MASK'
        ? '마스킹 적용됨 (일부가 가려집니다. 결제는 그대로 접수됩니다)'
        : '통과 (그대로 노출됩니다)';

    return {
      ok: true,
      message: `[${verdict}] 노출 결과: "${result.clean}"${result.reasons.length ? ` · 적용: ${result.reasons.join(', ')}` : ''}`,
    };
  });
}

// ===========================================================================
// 정산
// ===========================================================================

/**
 * 원천징수 신고용 주민등록번호 사전 등록.
 *
 * 자동 정산으로 바뀌면서 사회복지기관이 "정산 요청"을 하는 단계가 사라졌다.
 * 지급 회차는 배치가 만들기 때문에, 개인 사회복지기관은 신고용 번호를 미리 등록해 둬야
 * 지급 시점에 원천징수 신고 정보가 회차에 남는다.
 *
 * 사업자등록번호가 등록된 사회복지기관은 세금계산서 대상이라 원천징수하지 않으므로 등록 대상이 아니다.
 */
export async function saveWithholdingResidentAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const account = await prisma.settlementAccount.findUnique({
      where: { merchantId },
      select: { id: true },
    });
    if (!account) return { ok: false, message: '정산 계좌를 먼저 등록해 주세요.' };

    const profile = await prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { businessNo: true },
    });
    if (profile?.businessNo) {
      return { ok: false, message: '사업자 사회복지기관은 원천징수 대상이 아닙니다. 주민등록번호를 등록할 수 없습니다.' };
    }

    const residentRaw = text(formData, 'resident');
    // 마스킹 값이 그대로 넘어온 경우(재사용)는 변경 없음으로 본다.
    if (residentRaw.includes('*')) {
      return { ok: true, message: '등록된 원천징수 신고 정보를 그대로 사용합니다.' };
    }
    if (!residentRaw) return { ok: false, message: '주민등록번호 13자리를 입력해 주세요.' };
    if (!checked(formData, 'residentAgree')) {
      return { ok: false, message: '주민등록번호 수집·이용에 동의해 주세요.' };
    }

    const norm = normalizeResident(residentRaw);
    if (!norm) return { ok: false, message: '주민등록번호 13자리를 정확히 입력해 주세요.' };
    if (!isValidResident(norm)) return { ok: false, message: '주민등록번호가 올바르지 않습니다. 다시 확인해 주세요.' };

    const masked = maskResident(norm);
    await prisma.settlementAccount.update({
      where: { merchantId },
      data: { residentEnc: encrypt(norm), residentMasked: masked },
    });

    // 개인정보 등록 기록. 원문·암호문은 남기지 않고 마스킹 값만 남긴다.
    await writeAudit({
      adminUserId: userId,
      action: 'WITHHOLDING_RESIDENT_SAVE',
      targetType: 'settlement_account',
      targetId: account.id,
      after: { merchantId, by: 'merchant', userId, residentMasked: masked },
    });

    revalidatePath('/studio/settlement');
    return { ok: true, message: '원천징수 신고 정보를 저장했습니다. 지급 회차 생성 시 자동으로 사용됩니다.' };
  });
}

export async function saveSettlementAccountAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const parsed = z
      .object({
        bankCode: z.string().min(2).max(4),
        account: z.string().regex(/^[0-9]{8,20}$/u, '계좌번호 형식이 올바르지 않습니다.'),
        holderName: z.string().trim().min(2).max(30),
      })
      .safeParse({
        bankCode: text(formData, 'bankCode'),
        account: text(formData, 'account').replace(/[-\s]/g, ''),
        holderName: text(formData, 'holderName'),
      });
    if (!parsed.success) {
      return { ok: false, message: '은행, 계좌번호(숫자 8~20자리), 예금주(2~30자)를 정확히 입력해 주세요.' };
    }

    const name = bankName(parsed.data.bankCode);
    if (!name) return { ok: false, message: '지원하지 않는 은행입니다.' };

    const data = {
      bankCode: parsed.data.bankCode,
      bankName: name,
      accountEnc: encrypt(parsed.data.account),
      accountTail4: accountTail4(parsed.data.account),
      holderNameEnc: encrypt(parsed.data.holderName),
      holderMasked: maskName(parsed.data.holderName),
      // 계좌 실명확인은 아직 mock 이다. 임의로 인증 성공 처리하지 않는다.
      verified: false,
      verifiedAt: null,
    };

    const before = await prisma.settlementAccount.findUnique({
      where: { merchantId },
      select: { id: true, bankCode: true, bankName: true, accountTail4: true, holderMasked: true },
    });

    const saved = await prisma.settlementAccount.upsert({
      where: { merchantId },
      create: { id: newId(), merchantId, ...data },
      update: data,
    });

    // 돈이 나가는 계좌다. 언제·어느 IP 에서 무엇이 무엇으로 바뀌었는지 남긴다.
    // 원문·암호문은 넣지 않고 은행 / 끝 4자리 / 마스킹 예금주만 기록한다.
    await writeAudit({
      adminUserId: userId,
      action: 'SETTLEMENT_ACCOUNT_CHANGE',
      targetType: 'settlement_account',
      targetId: saved.id,
      before: before
        ? {
            bankCode: before.bankCode,
            bankName: before.bankName,
            accountTail4: before.accountTail4,
            holderMasked: before.holderMasked,
          }
        : null,
      after: {
        merchantId,
        by: 'merchant',
        userId,
        bankCode: data.bankCode,
        bankName: data.bankName,
        accountTail4: data.accountTail4,
        holderMasked: data.holderMasked,
      },
    });

    revalidatePath('/studio/settlement/account');
    revalidatePath('/studio/settlement');
    return {
      ok: true,
      message: '정산 계좌를 저장했습니다. 예금주 실명확인은 통합 관리자 승인 후 완료됩니다.',
    };
  });
}

// ===========================================================================
// 프로필
// ===========================================================================

/**
 * 이미지 주소 검증(폼 파서용).
 * http(s) 절대주소 또는 사이트 내 경로(/로 시작)만 허용한다.
 */
function safeImageUrl(value: string, label: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch {
    // 아래에서 공통 오류로 처리한다.
  }
  throw new Error(`${label}는 http(s) 주소 또는 / 로 시작하는 경로여야 합니다.`);
}

/** http(s) 주소 또는 사이트 내 경로(/로 시작)를 허용하는 이미지 주소 검증 */
const imageUrlSchema = z.union([
  z.literal(''),
  z.url(),
  z.string().regex(/^\/[^\s]*$/u, '이미지 주소는 http(s) 주소 또는 / 로 시작하는 경로여야 합니다.'),
]);

export async function updateMerchantProfileAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    // 소개(description)는 결제 페이지 관리에서만 수정한다.
    // 여기서 함께 저장하면 프로필만 저장했을 때 결제 페이지 소개가 지워진다.
    const parsed = z
      .object({
        displayName: z.string().trim().min(1).max(30),
        channelName: z.string().trim().max(50),
        avatarUrl: imageUrlSchema,
      })
      .safeParse({
        displayName: text(formData, 'displayName'),
        channelName: text(formData, 'channelName'),
        avatarUrl: text(formData, 'avatarUrl'),
      });
    if (!parsed.success) {
      return {
        ok: false,
        message:
          '표시명(1~30자), 채널명(50자 이내)을 확인하고 아바타 주소는 http(s) 주소 또는 / 로 시작하는 경로로 입력해 주세요.',
      };
    }

    await prisma.merchantProfile.update({
      where: { id: merchantId },
      data: {
        displayName: parsed.data.displayName,
        channelName: parsed.data.channelName || null,
        avatarUrl: parsed.data.avatarUrl || null,
      },
    });

    revalidatePath('/studio/profile');
    revalidatePath('/studio');
    return { ok: true, message: '프로필을 저장했습니다.' };
  });
}

/**
 * 결제 페이지 설정 (배너 · 소개).
 * 후원자에게 보이는 결제 페이지의 겉모습을 정한다.
 *
 */
export async function updateChargePageAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const bannerPreset = text(formData, 'bannerPreset');
    const parsed = z
      .object({
        bannerUrl: imageUrlSchema,
        description: z.string().trim().max(300),
      })
      .safeParse({
        bannerUrl: text(formData, 'bannerUrl'),
        description: text(formData, 'description'),
        // 예전 단일 필드(liveUrl)로 저장하던 폼과도 호환되게 받는다.
      });
    if (!parsed.success) {
      return {
        ok: false,
        message: '배너 주소는 http(s) 주소 또는 / 로 시작하는 경로, 소개는 300자 이내로 입력해 주세요.',
      };
    }

    // 'auto' 는 배너를 고정하지 않는다(사회복지기관마다 정해진 기본 배너가 쓰인다).
    // 예전에는 이 선택지가 없어서, 자동 상태로 저장을 누르면 그때 보이던 기본 배너가
    // 고정 값으로 굳어 다시 자동으로 되돌릴 방법이 없었다.
    if (
      bannerPreset &&
      bannerPreset !== 'custom' &&
      bannerPreset !== 'auto' &&
      !/^\/banners\/[a-z0-9-]+\.png$/.test(bannerPreset)
    ) {
      return { ok: false, message: '배너 선택 값이 올바르지 않습니다.' };
    }
    const bannerUrl =
      bannerPreset === 'auto' ? null
      : bannerPreset === 'custom' ? parsed.data.bannerUrl || null
      : bannerPreset ? bannerPreset
      : null;

    await prisma.merchantProfile.update({
      where: { id: merchantId },
      data: {
        bannerUrl,
        description: parsed.data.description || null,
      },
    });

    revalidatePath('/studio/settings');
    revalidatePath('/studio/profile');
    revalidatePath('/studio');
    return {
      ok: true,
      message: '결제 페이지 설정을 저장했습니다.',
    };
  });
}

// ===========================================================================
// 연동 API 키 (선택 기능)
// ===========================================================================

/** 사회복지기관당 동시에 유효한 키 개수 상한. 키가 늘어날수록 유출 위험도 커진다. */
const API_KEY_MAX_ACTIVE = 3;

/**
 * 연동 API 키 발급.
 * 키 원문과 서명 비밀키는 이 응답에서 1회만 보여주고 저장하지 않는다.
 */
export async function createApiKeyAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const active = await prisma.merchantApiKey.count({ where: { merchantId, revokedAt: null } });
    if (active >= API_KEY_MAX_ACTIVE) {
      return { ok: false, message: `유효한 키는 최대 ${API_KEY_MAX_ACTIVE}개까지 둘 수 있습니다. 쓰지 않는 키를 먼저 폐기해 주세요.` };
    }

    const name = text(formData, 'name').slice(0, 40) || '연동 키';
    // 모드는 발급 시에만 정하고 나중에 바꿀 수 없다. 운영 키가 조용히 테스트로
    // 바뀌면(또는 그 반대면) 어느 쪽 데이터를 건드리는지 아무도 알 수 없게 된다.
    const mode = text(formData, 'mode') === 'TEST' ? 'TEST' : 'LIVE';

    // 발급과 동시에 IP 를 제한할 수 있게 한다(나중에 따로 저장할 수도 있다).
    // 형식이 틀린 값을 조용히 버리면(filter) 사회복지기관은 IP 를 제한했다고 믿는데 실제로는
    // 아무 제한도 걸리지 않는다. 수정 화면과 같게 오류로 알려 준다.
    // 검사는 **발급 전에** 한다. 발급 뒤에 오류를 내면 쓰지 못할 키만 남는다.
    const ips = text(formData, 'allowedIps')
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 20);
    const badIp = ips.find((v) => !isIpv4OrCidr(v));
    if (badIp) {
      return { ok: false, message: `IP 형식이 올바르지 않습니다: ${badIp} (예: 203.0.113.10 또는 203.0.113.0/24)` };
    }

    const issued = await issueMerchantApiKey(merchantId, name, mode);
    if (ips.length > 0) {
      await prisma.merchantApiKey.update({ where: { id: issued.id }, data: { allowedIps: ips.join(',') } });
    }

    revalidatePath('/studio/settings');
    return {
      ok: true,
      message:
        mode === 'TEST'
          ? `테스트 키 "${issued.name}" 를 발급했습니다. 이 키로는 문자가 나가지 않고 결제도 일어나지 않습니다. 아래 값은 지금만 볼 수 있습니다.`
          : `운영 키 "${issued.name}" 를 발급했습니다. 실제 결제·정산에 영향을 줍니다. 아래 값은 지금만 볼 수 있습니다.`,
      secret: `API 키\n${issued.apiKey}\n\n서명 비밀키\n${issued.signingSecret}`,
      secretLabel: '연동 키 (지금만 확인 가능)',
      secretHint: '이 화면을 벗어나면 다시 볼 수 없습니다. 안전한 곳에 보관하고, 유출되면 즉시 폐기 후 재발급하세요.',
    };
  });
}

/** 연동 API 키 폐기. 폐기 즉시 해당 키로는 인증되지 않는다. */
export async function revokeApiKeyAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'keyId');
    if (!id) return { ok: false, message: '폐기할 키를 선택해 주세요.' };

    // 본인 사회복지기관 키인지 반드시 확인한다.
    const result = await prisma.merchantApiKey.updateMany({
      where: { id, merchantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) return { ok: false, message: '이미 폐기되었거나 존재하지 않는 키입니다.' };

    revalidatePath('/studio/settings');
    return { ok: true, message: '연동 키를 폐기했습니다.' };
  });
}

// ===========================================================================
// 주문 · 배송 (실물 상품)
// ===========================================================================

/** 배송(반품 포함) 상태 값. 화면 드롭다운과 검증이 같은 목록을 본다. */
const SHIPMENT_STATUSES = [
  'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELED',
  'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'EXCHANGE_REQUESTED', 'EXCHANGE_SHIPPED',
] as const;

type ShipmentStatusValue = (typeof SHIPMENT_STATUSES)[number];

/** 발송(=송장이 있어야 하는) 상태 */
const NEEDS_TRACKING: ShipmentStatusValue[] = ['SHIPPED', 'EXCHANGE_SHIPPED'];

/** 반품·교환 흐름 상태 */
const RETURN_FLOW: ShipmentStatusValue[] = [
  'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'EXCHANGE_REQUESTED', 'EXCHANGE_SHIPPED',
];

/**
 * 상태별로 넘어갈 수 있는 다음 상태.
 *
 * 이 표가 없으면 드롭다운의 아홉 값 사이를 아무렇게나 오갈 수 있다. 그때 실제로 벌어지는 일:
 *  - DELIVERED → PREPARING 으로 되돌리면 발송·완료 시각이 null 로 지워진다.
 *    배송 지연 통계의 근거와 분쟁 대응 자료가 함께 사라진다.
 *  - 그 상태에서 다시 SHIPPED 로 바꾸면 "처음 발송" 으로 인식돼 후원자에게 발송 안내
 *    문자가 한 번 더 나간다. 받는 사람에게는 중복 청구로 읽힌다.
 *  - 반품이 끝난(RETURNED) 주문을 발송 완료로 덮으면 반품 탭에서 사라진다.
 *
 * 같은 상태로 다시 저장하는 것(송장·메모만 고치기)은 언제나 허용한다.
 */
const SHIPMENT_TRANSITIONS: Record<ShipmentStatusValue, ShipmentStatusValue[]> = {
  // 준비 중에는 발송하거나, 주문 자체를 취소하거나, 후원자 요청으로 반품·교환을 받을 수 있다.
  PREPARING: ['SHIPPED', 'CANCELED', 'RETURN_REQUESTED', 'EXCHANGE_REQUESTED'],
  // 발송했으면 배송 완료로 가거나, 도착 전에 반품·교환 요청이 들어올 수 있다.
  SHIPPED: ['DELIVERED', 'RETURN_REQUESTED', 'EXCHANGE_REQUESTED'],
  // 배송이 끝난 뒤에는 반품·교환만 남는다. 준비 중으로 되돌릴 수 없다.
  DELIVERED: ['RETURN_REQUESTED', 'EXCHANGE_REQUESTED'],
  // 취소한 주문은 되살리지 않는다. 다시 팔려면 새 주문이어야 한다.
  CANCELED: [],
  RETURN_REQUESTED: ['RETURNING', 'RETURNED', 'DELIVERED'],
  RETURNING: ['RETURNED'],
  // 반품이 끝나면 그것으로 종결이다. 환불은 별도 절차(환불 요청)로 처리한다.
  RETURNED: [],
  EXCHANGE_REQUESTED: ['EXCHANGE_SHIPPED', 'RETURNING', 'RETURNED'],
  EXCHANGE_SHIPPED: ['DELIVERED', 'RETURN_REQUESTED'],
};

/** 이 상태로 바꾸려면 결제가 살아 있어야 한다(환불된 주문을 발송할 수는 없다). */
const NEEDS_LIVE_PAYMENT: ShipmentStatusValue[] = ['SHIPPED', 'DELIVERED', 'EXCHANGE_SHIPPED'];

function shipmentTimestamps(
  status: ShipmentStatusValue,
  current: { shippedAt: Date | null; deliveredAt: Date | null; returnRequestedAt: Date | null; returnClosedAt: Date | null },
  now: Date,
) {
  return {
    // 발송 시각은 처음 발송으로 바꾼 때만 기록한다(수정할 때마다 갱신하면 배송 지연을 못 본다).
    shippedAt: status === 'SHIPPED' ? current.shippedAt ?? now : status === 'PREPARING' ? null : current.shippedAt,
    // 배송 완료 시각도 최초 1회만 기록한다. 메모·송장번호만 고치려고 다시 저장할 때마다
    // 갱신되면 실제 배송 완료일이 사라져 배송 지연 통계와 분쟁 대응 근거가 어긋난다.
    deliveredAt:
      status === 'DELIVERED'
        ? current.deliveredAt ?? now
        : status === 'PREPARING'
          ? null
          : current.deliveredAt,
    // 반품·교환 접수 시각도 최초 1회.
    returnRequestedAt: RETURN_FLOW.includes(status) ? current.returnRequestedAt ?? now : current.returnRequestedAt,
    returnClosedAt: status === 'RETURNED' ? current.returnClosedAt ?? now : status === 'PREPARING' ? null : current.returnClosedAt,
  };
}

/**
 * 배송 정보 저장 (송장 입력 · 상태 변경 · 반품/교환 접수).
 *
 * 발송(SHIPPED)으로 바꾸려면 택배사와 송장번호가 있어야 한다.
 * 송장 없이 발송 처리하면 후원자가 조회할 수 없고, 분쟁 시 발송 사실을 증명하지 못한다.
 * 발송으로 처음 바뀌는 순간에는 후원자에게 발송 안내 문자를 보낸다.
 */
export async function updateShipmentAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const chargeId = text(formData, 'chargeId');
    if (!chargeId) return { ok: false, message: '주문을 찾을 수 없습니다.' };

    const statusRaw = text(formData, 'status').toUpperCase();
    if (!SHIPMENT_STATUSES.includes(statusRaw as ShipmentStatusValue)) {
      return { ok: false, message: '배송 상태를 선택해 주세요.' };
    }
    const status = statusRaw as ShipmentStatusValue;

    // 남의 사회복지기관 주문을 건드릴 수 없도록 merchantId 를 조건에 함께 건다.
    const current = await prisma.chargeShipment.findFirst({
      where: { chargeId, merchantId },
      select: {
        id: true, status: true, shippedAt: true, deliveredAt: true,
        returnRequestedAt: true, returnClosedAt: true,
        charge: { select: { status: true } },
      },
    });
    if (!current) return { ok: false, message: '주문을 찾을 수 없습니다.' };

    // 허용된 전이인지 먼저 본다(같은 상태로 다시 저장하는 것은 송장·메모 수정이므로 통과).
    if (status !== current.status && !SHIPMENT_TRANSITIONS[current.status].includes(status)) {
      return {
        ok: false,
        message:
          `${shipmentStatusLabel[current.status].text} 상태에서 ${shipmentStatusLabel[status].text} 로는 바꿀 수 없습니다. ` +
          '되돌리기가 필요하면 고객센터로 문의해 주세요. (배송 시각과 발송 안내 문자 이력이 어긋나지 않도록 막고 있습니다)',
      };
    }
    // 환불되었거나 환불 요청 중인 주문은 발송 단계로 보낼 수 없다.
    // 막지 않으면 이미 돈을 돌려준 주문에 물건이 나가고, 후원자에게 발송 안내 문자까지 간다.
    if (NEEDS_LIVE_PAYMENT.includes(status) && !PAID_STATUSES.includes(current.charge.status)) {
      return {
        ok: false,
        message: '환불되었거나 환불 요청 중인 주문은 발송 처리할 수 없습니다.',
      };
    }

    const carrier = text(formData, 'carrier').slice(0, 30) || null;
    const trackingNo = text(formData, 'trackingNo').replace(/[^0-9A-Za-z-]/g, '').slice(0, 40) || null;
    const returnTrackingNo = text(formData, 'returnTrackingNo').replace(/[^0-9A-Za-z-]/g, '').slice(0, 40) || null;
    const returnReason = text(formData, 'returnReason').slice(0, 200) || null;

    if (NEEDS_TRACKING.includes(status) && (!carrier || !trackingNo)) {
      return { ok: false, message: '발송 처리에는 택배사와 송장번호가 필요합니다.' };
    }
    if (RETURN_FLOW.includes(status) && !returnReason) {
      return { ok: false, message: '반품·교환은 사유를 남겨야 합니다. 분쟁 시 근거가 됩니다.' };
    }

    const now = new Date();
    await prisma.chargeShipment.update({
      where: { chargeId },
      data: {
        status,
        carrier,
        trackingNo,
        returnTrackingNo,
        returnReason,
        // 후원자가 남긴 배송 요청(memo)은 건드리지 않는다. 사회복지기관 메모는 별도 컬럼이다.
        merchantMemo: text(formData, 'merchantMemo').slice(0, 100) || null,
        ...shipmentTimestamps(status, current, now),
      },
    });

    // 발송으로 "처음" 바뀐 순간에만 안내 문자를 보낸다. 저장할 때마다 보내면 문자 폭탄이 된다.
    let notified = false;
    if (status === 'SHIPPED' && current.status !== 'SHIPPED' && !checked(formData, 'skipNotify')) {
      notified = await notifyShipment(chargeId, carrier!, trackingNo!);
    }

    revalidatePath('/studio/orders');
    revalidatePath('/studio');
    return {
      ok: true,
      message:
        status === 'SHIPPED'
          ? `발송 처리했습니다. (${carrier} ${trackingNo})${notified ? ' 후원자에게 발송 안내 문자를 보냈습니다.' : ''}`
          : status === 'DELIVERED'
            ? '배송 완료로 표시했습니다.'
            : status === 'CANCELED'
              ? '배송을 취소 상태로 표시했습니다. 결제 환불이 필요하면 아래 [환불 요청] 을 눌러 주세요.'
              : RETURN_FLOW.includes(status)
                ? '반품·교환 상태를 저장했습니다. 환불이 필요하면 [환불 요청] 을 눌러 주세요.'
                : '배송 준비 상태로 되돌렸습니다.',
    };
  });
}

/** 발송 안내 문자. 실패해도 배송 저장 자체를 되돌리지는 않는다. */
async function notifyShipment(chargeId: string, carrier: string, trackingNo: string): Promise<boolean> {
  try {
    const charge = await prisma.charge.findUnique({
      where: { id: chargeId },
      select: {
        id: true,
        merchantId: true,
        merchant: { select: { displayName: true } },
        payer: { select: { phoneEnc: true } },
        product: { select: { name: true } },
      },
    });
    if (!charge?.payer) return false;
    const phone = decrypt(charge.payer.phoneEnc);
    if (!phone) return false;
    return await sendMt({
      phone,
      template: tplShipmentSent({
        merchantName: charge.merchant.displayName,
        productName: charge.product?.name ?? '주문 상품',
        carrier,
        trackingNo,
      }),
      // 발송 안내는 결제 결과가 아니다. chargeId 를 넘기면 charge.mtStatus 가 이 문자 결과로 덮인다.
      merchantId: charge.merchantId,
    });
  } catch (e) {
    logger.warn('발송 안내 문자 실패', { chargeId, message: (e as Error).message });
    return false;
  }
}

/**
 * 여러 주문을 한 번에 발송 처리한다.
 *
 * 하루 수십 건을 한 건씩 저장하게 두면 실수로 빠뜨리는 주문이 반드시 생긴다.
 * 입력은 "거래번호,송장번호" 를 줄바꿈으로 나열한 형식이다(엑셀에서 그대로 붙여 넣을 수 있다).
 */
export async function bulkShipAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const carrier = text(formData, 'carrier').slice(0, 30);
    if (!carrier) return { ok: false, message: '택배사를 입력해 주세요.' };

    const raw = text(formData, 'rows');
    if (!raw) return { ok: false, message: '거래번호와 송장번호를 입력해 주세요.' };

    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
    if (lines.length === 0) return { ok: false, message: '처리할 줄이 없습니다.' };

    const notify = checked(formData, 'notify');
    const done: string[] = [];
    const failed: string[] = [];

    for (const line of lines) {
      // 쉼표·탭·연속 공백 모두 구분자로 받는다(엑셀 붙여넣기는 탭이다).
      const [noRaw, trackRaw] = line.split(/[,\t]|\s{2,}/).map((v) => (v ?? '').trim());
      const transactionNo = (noRaw ?? '').toUpperCase();
      const trackingNo = (trackRaw ?? '').replace(/[^0-9A-Za-z-]/g, '');
      if (!transactionNo || !trackingNo) {
        failed.push(`${line} (형식 오류)`);
        continue;
      }

      const charge = await prisma.charge.findFirst({
        where: { transactionNo, merchantId, status: { in: PAID_STATUSES } },
        select: { id: true, shipment: { select: { status: true } } },
      });
      if (!charge?.shipment) {
        failed.push(`${transactionNo} (주문 없음)`);
        continue;
      }
      if (charge.shipment.status === 'SHIPPED') {
        failed.push(`${transactionNo} (이미 발송됨)`);
        continue;
      }
      // 반품·교환이 진행 중인 주문을 발송 완료로 덮으면 반품 탭에서 사라진다.
      // 붙여넣기에 섞여 들어온 거래번호를 조용히 처리하지 않는다.
      if (RETURN_SHIPMENT_STATUSES.includes(charge.shipment.status)) {
        failed.push(`${transactionNo} (반품·교환 진행 중)`);
        continue;
      }
      // 배송이 끝났거나 취소된 주문도 마찬가지다. 단건 화면과 같은 전이표를 쓴다.
      // (전에는 SHIPPED 와 반품만 걸러 DELIVERED·CANCELED 주문을 조용히 덮었다)
      if (!SHIPMENT_TRANSITIONS[charge.shipment.status].includes('SHIPPED')) {
        failed.push(`${transactionNo} (${shipmentStatusLabel[charge.shipment.status].text} 상태라 발송 처리할 수 없음)`);
        continue;
      }

      const cur = await prisma.chargeShipment.findUniqueOrThrow({
        where: { chargeId: charge.id },
        select: { shippedAt: true, deliveredAt: true, returnRequestedAt: true, returnClosedAt: true },
      });
      await prisma.chargeShipment.update({
        where: { chargeId: charge.id },
        data: {
          status: 'SHIPPED',
          carrier,
          trackingNo,
          ...shipmentTimestamps('SHIPPED', cur, new Date()),
        },
      });
      if (notify) await notifyShipment(charge.id, carrier, trackingNo);
      done.push(transactionNo);
    }

    revalidatePath('/studio/orders');
    if (done.length === 0) {
      return { ok: false, message: `처리된 건이 없습니다. ${failed.slice(0, 3).join(' / ')}` };
    }
    return {
      ok: true,
      message:
        failed.length === 0
          ? `${done.length}건을 발송 처리했습니다.`
          : `${done.length}건 처리, ${failed.length}건 실패 — ${failed.slice(0, 3).join(' / ')}${failed.length > 3 ? ' 외' : ''}`,
    };
  });
}

/**
 * 배송지 원문 확인.
 *
 * 목록에는 마스킹만 보여 주고, 실제 배송 작업을 할 때만 원문을 연다.
 * 누가 언제 누구의 배송지를 열었는지 감사로그로 남긴다(개인정보 열람 기록).
 */
export async function revealShipmentAddressAction(
  chargeId: string,
): Promise<
  | { ok: true; receiver: string; phone: string; address: string; zipCode: string }
  | { ok: false; message: string }
> {
  let merchantId: string;
  let userId: string;
  try {
    const user = await requireMerchant();
    merchantId = user.merchantId;
    userId = user.id;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '사회복지기관 권한이 필요합니다.' };
  }

  try {
    const row = await prisma.chargeShipment.findFirst({
      where: { chargeId, merchantId },
      select: {
        id: true, receiverEnc: true, phoneEnc: true, addressEnc: true, zipCode: true,
        charge: { select: { transactionNo: true } },
      },
    });
    if (!row) return { ok: false, message: '주문을 찾을 수 없습니다.' };

    await writeAudit({
      adminUserId: userId,
      action: 'SHIPMENT_ADDRESS_VIEW',
      targetType: 'charge_shipment',
      targetId: row.id,
      // writeAudit 은 관리자 프로필이 없는 주체를 adminId 에 남기지 못한다.
      // 사회복지기관 담당자가 여럿이면 "어느 사회복지기관" 까지만 남아 추적이 불가능하므로 계정을 함께 남긴다.
      after: { transactionNo: row.charge.transactionNo, by: 'merchant', merchantId, userId },
    });

    return {
      ok: true,
      receiver: decrypt(row.receiverEnc),
      phone: decrypt(row.phoneEnc),
      address: decrypt(row.addressEnc),
      zipCode: row.zipCode,
    };
  } catch (e) {
    return { ok: false, message: userFacingError(e) };
  }
}

/**
 * 사회복지기관이 올리는 환불 요청.
 *
 * 실제 환불 실행은 통합 관리자가 승인해야 한다(결제사 취소·정산 원장 반대분개가 함께 일어난다).
 * 그래도 품절·배송불가처럼 사회복지기관만 아는 사유를 접수할 통로는 있어야 한다.
 */
export async function requestChargeRefundAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const chargeId = text(formData, 'chargeId');
    const reason = text(formData, 'reason').slice(0, 200);
    if (!chargeId) return { ok: false, message: '결제 건을 찾을 수 없습니다.' };
    if (reason.length < 5) return { ok: false, message: '환불 사유를 5자 이상 적어 주세요. 관리자 승인 근거가 됩니다.' };

    const charge = await prisma.charge.findFirst({
      where: { id: chargeId, merchantId },
      select: { id: true, transactionNo: true },
    });
    if (!charge) return { ok: false, message: '결제 건을 찾을 수 없습니다.' };

    await requestRefund({ chargeId: charge.id, reason: `[사회복지기관] ${reason}`, requestedBy: userId });

    revalidatePath('/studio/orders');
    revalidatePath('/studio/charges');
    revalidatePath(`/studio/charges/${charge.id}`);
    return {
      ok: true,
      message: `${charge.transactionNo} 환불을 요청했습니다. 통합 관리자 승인 후 처리됩니다.`,
    };
  });
}

// ===========================================================================
// 발송 템플릿 (MT 발송 v1)
// ===========================================================================

/**
 * 사회복지기관 발송 템플릿 등록·수정.
 *
 * 검수는 등록할 때 한 번만 한다. 자동 검사를 통과하면 바로 승인되고,
 * 광고성 표현이나 금칙어가 걸리면 검수 대기로 저장돼 관리자가 본다.
 * 같은 코드로 다시 저장하면 본문이 바뀌고 검수를 다시 받는다.
 */
export async function saveMtTemplateAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const result = await upsertMerchantTemplate({
      merchantId,
      code: text(formData, 'code'),
      name: text(formData, 'name'),
      body: text(formData, 'body'),
    });
    if (!result.ok) return { ok: false, message: result.message };

    revalidatePath('/studio/settings');
    return {
      ok: true,
      message:
        result.template.status === 'APPROVED'
          ? `템플릿 "${result.template.code}" 을 등록했습니다. 바로 발송에 쓸 수 있습니다.`
          : `템플릿 "${result.template.code}" 을 등록했습니다. 검수가 필요해 지금은 발송에 쓸 수 없습니다. ${result.reviewNote ?? ''}`.trim(),
    };
  });
}

/** 발송 템플릿 삭제. 이미 나간 문자 이력은 남는다. */
export async function deleteMtTemplateAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'templateId');
    if (!id) return { ok: false, message: '삭제할 템플릿을 선택해 주세요.' };

    // 본인 사회복지기관 템플릿인지 반드시 확인한다.
    const result = await prisma.merchantMtTemplate.deleteMany({ where: { id, merchantId } });
    if (result.count === 0) return { ok: false, message: '이미 삭제되었거나 존재하지 않는 템플릿입니다.' };

    revalidatePath('/studio/settings');
    return { ok: true, message: '템플릿을 삭제했습니다.' };
  });
}

// ===========================================================================
// 웹훅 (이벤트 구독)
// ===========================================================================

/** 사회복지기관당 등록할 수 있는 수신 URL 수. API 라우트와 같은 값을 쓴다. */
const WEBHOOK_MAX = 5;

/**
 * 수신 URL 등록.
 *
 * 서명 비밀키는 이 응답에서 한 번만 보여 주고 저장하지 않는다.
 * 이벤트를 하나도 고르지 않으면 전부 받는다.
 */
export async function createWebhookAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const count = await prisma.merchantWebhook.count({ where: { merchantId } });
    if (count >= WEBHOOK_MAX) {
      return { ok: false, message: `수신 URL 은 최대 ${WEBHOOK_MAX}개까지 등록할 수 있습니다.` };
    }

    // 체크박스로 고른 이벤트만 받는다. 아무것도 고르지 않으면 전체 구독이다.
    const events = WEBHOOK_EVENT_META.map((e) => e.type).filter((type) => formData.get(`event:${type}`) === 'on');

    const result = await registerWebhook({
      merchantId,
      url: text(formData, 'url'),
      events,
      description: text(formData, 'description') || null,
    });
    if (!result.ok) return { ok: false, message: result.message };

    revalidatePath('/studio/settings');
    return {
      ok: true,
      message: '수신 URL 을 등록했습니다. 아래 서명 비밀키는 지금만 볼 수 있습니다.',
      secret: result.secret,
      secretLabel: '웹훅 서명 비밀키 (지금만 확인 가능)',
      secretHint:
        '받은 요청이 진짜 기브싸인가 보낸 것인지 확인할 때 씁니다. 검증하지 않으면 누구나 가짜 결제 완료 이벤트를 보낼 수 있습니다.',
    };
  });
}

/** 수신 URL 해제. 전송 이력도 함께 지워진다. */
export async function deleteWebhookAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'webhookId');
    if (!id) return { ok: false, message: '해제할 수신 URL 을 선택해 주세요.' };

    const result = await prisma.merchantWebhook.deleteMany({ where: { id, merchantId } });
    if (result.count === 0) return { ok: false, message: '이미 해제되었거나 존재하지 않는 수신 URL 입니다.' };

    revalidatePath('/studio/settings');
    return { ok: true, message: '수신 URL 을 해제했습니다.' };
  });
}

/** 테스트 이벤트 1건 발송. 수신 처리와 서명 검증이 되는지 확인한다. */
export async function testWebhookAction(
  _prev: StudioActionState,
  formData: FormData,
): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(formData, 'webhookId');
    const hook = await prisma.merchantWebhook.findFirst({ where: { id, merchantId } });
    if (!hook) return { ok: false, message: '존재하지 않는 수신 URL 입니다.' };

    const eventId = newId();
    const delivery = await prisma.merchantWebhook.update({ where: { id: hook.id }, data: {} }).then(() =>
      prisma.webhookDelivery.create({
        data: {
          id: newId(),
          merchantId,
          webhookId: hook.id,
          eventId,
          eventType: 'webhook.test',
          payload: JSON.stringify({
            eventId,
            type: 'webhook.test',
            occurredAt: new Date().toISOString(),
            merchantId,
            data: { message: '기브싸인 웹훅 테스트입니다.' },
          }),
          nextAttemptAt: new Date(),
        },
      }),
    );

    const ok = await deliverOnce(delivery.id);
    const after = await prisma.webhookDelivery.findUnique({
      where: { id: delivery.id },
      select: { responseStatus: true, error: true },
    });

    revalidatePath('/studio/settings');
    return ok
      ? { ok: true, message: `테스트 이벤트를 보냈고 정상 응답(${after?.responseStatus})을 받았습니다.` }
      : {
          ok: false,
          message: `테스트 이벤트를 보냈지만 응답이 정상이 아닙니다. ${after?.responseStatus ?? ''} ${after?.error ?? ''}`.trim(),
        };
  });
}
