'use server';

import { cookies } from 'next/headers';
import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { consumeIpRateLimit, consumeRateLimit } from '@/server/rate-limit';
import { newId } from '@/lib/id';
import { encrypt, hmac, maskPhone, normalizePhone, phoneHash, safeEqual } from '@/lib/crypto';
import { env, isLocal } from '@/lib/env';
import { logger } from '@/lib/logger';
import { issueSecureLink } from '@/server/services/secure-link';
import { createWebCharge } from '@/server/services/web-charge';
import { sendMt } from '@/server/services/charge-flow';
import { expirePinSessionIfStale } from '@/server/services/pin-authorization';
import * as tpl from '@/server/services/mt-templates';

/**
 * 결제 페이지 PC 웹 결제 — PIN 인증 흐름 서버 액션.
 *
 *   금액·메시지 작성 → 휴대전화 번호 입력 → 결제사 PIN 링크 요청 → MT 발송
 *   → (후원자가 문자 링크에서 PIN 입력) → 콜백 → 결제 완료
 *
 * 이 경로에는 인증번호(SMS OTP) 단계가 없다. 결제를 확정하는 주체는
 * **문자를 받은 휴대전화 본인**이며, PIN 을 입력하지 않으면 출금은 일어나지 않는다.
 *
 * 그래도 남는 위험이 있어 아래 두 가지로 막는다.
 *  1) PIN 링크는 **이미 결제수단이 등록된 번호**로만 나간다. 임의의 번호로는 발송되지 않는다.
 *  2) 번호당 발송 횟수를 제한한다(문자 폭탄·한도 소모 방지).
 *
 * 진행 상태는 클라이언트가 보낸 값이 아니라 **HttpOnly 쿠키에 담긴 결제 ID**로만 조회한다.
 * (거래번호·결제 상태가 ID 를 아는 제3자에게 노출되지 않도록)
 */

/** 번호당 PIN 링크 발송 제한 (문자 폭탄과 한도 소모 방지) */
const PIN_SEND_WINDOW_SEC = 600;
const PIN_SEND_MAX = 3;
const pinSendKey = (ph: string) => `webdon:pinsend:${ph}`;

/**
 * 같은 번호로 하루에 보낼 수 있는 결제 요청 문자 수.
 *
 * 이 액션은 비로그인 상태에서 번호만 받는다. 10분 창(3건)만으로는 창이 지날 때마다
 * 다시 3건씩, 하루 400건 넘게 남의 번호로 결제 요청 문자를 보낼 수 있다.
 * 실제 후원자가 하루에 이 화면에서 결제를 시작하는 횟수를 훨씬 웃도는 선에서 하루치를 막는다.
 */
const PIN_SEND_DAILY_MAX = 10;
const PIN_SEND_DAY_SEC = 86_400;
const pinSendDayKey = (ph: string) => `webdon:pinsendday:${ph}`;

/** 진행 중인 웹 결제 ID. 상태 조회의 유일한 근거다. */
const PIN_COOKIE = 'webdon_pin';

/**
 * 쿠키에는 결제 ID 를 그대로 담지 않고 서명을 붙인다.
 *
 * HttpOnly 는 자바스크립트가 못 읽게 할 뿐, 브라우저 개발자도구나 다른 클라이언트로
 * 값을 **써 넣는** 것은 막지 못한다. 서명이 없으면 남의 결제 ID 를 적어 넣는 것만으로
 * 그 결제의 상태·거래번호를 들여다볼 수 있다.
 */
function signPinCookie(chargeId: string): string {
  return `${chargeId}.${hmac(`pincookie:${chargeId}`, env.crypto.sessionSecret)}`;
}

function readSignedPinCookie(raw: string | null): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const chargeId = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  return safeEqual(signature, hmac(`pincookie:${chargeId}`, env.crypto.sessionSecret)) ? chargeId : null;
}

async function setPinCookie(chargeId: string) {
  const jar = await cookies();
  jar.set(PIN_COOKIE, signPinCookie(chargeId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: !isLocal && env.baseUrl.startsWith('https'),
    path: '/',
    // 링크 유효시간이 지난 뒤에도 결과 화면(만료 안내)을 볼 수 있도록 조금 더 길게 잡는다.
    maxAge: env.payment.pinTtlSec + 600,
  });
}

async function readPinCookie(): Promise<string | null> {
  const jar = await cookies();
  return readSignedPinCookie(jar.get(PIN_COOKIE)?.value ?? null);
}

export type WebPinStep = 'compose' | 'phone' | 'register' | 'waiting' | 'done' | 'failed';

export interface WebPinState {
  ok: boolean;
  step: WebPinStep;
  message?: string;
  phoneMasked?: string;
  /** 미가입자의 결제수단 등록 링크 (팝업으로 연다) */

  /** PIN 링크 만료 시각 (ISO). 대기 화면 카운트다운에 쓴다. */
  expiresAt?: string;
  /** 결제사 실연동이 아닌 mock 링크인지 */
  mock?: boolean;
  transactionNo?: string;
}

// ---------------------------------------------------------------- 1) PIN 링크 요청

export async function startWebPinCharge(_prev: WebPinState, formData: FormData): Promise<WebPinState> {
  const phoneRaw = String(formData.get('phone') ?? '');
  const merchantId = String(formData.get('merchantId') ?? '');
  const requestId = String(formData.get('requestId') ?? '');
  const message = String(formData.get('message') ?? '').trim();
  const amountRaw = String(formData.get('amount') ?? '').replace(/[^\d]/g, '');
  const campaignId = String(formData.get('campaignId') ?? '').trim() || null;
  const anonymous = String(formData.get('anonymous') ?? '') === '1';

  const phone = normalizePhone(phoneRaw);
  if (!/^01[0-9]{8,9}$/.test(phone)) {
    return { ok: false, step: 'phone', message: '휴대전화 번호 형식을 확인해 주세요. (예: 010-1234-5678)' };
  }
  if (!merchantId || !requestId) return { ok: false, step: 'phone', message: '요청 정보가 올바르지 않습니다.' };
  if (message.length > 200) return { ok: false, step: 'phone', message: '결제 메시지는 200자 이내로 입력해 주세요.' };
  if (!/^\d{3,7}$/.test(amountRaw)) return { ok: false, step: 'phone', message: '결제 금액을 확인해 주세요.' };

  const ph = phoneHash(phone);
  const masked = maskPhone(phone);

  // 이 액션은 문자만 보내는 게 아니라 Charge · PaymentPinSession 행과 한도 카운터까지 만든다.
  // 로그인 없이 호출되므로 IP·사회복지기관 버킷을 함께 센다(번호만 세면 번호를 바꿔 무제한 호출된다).
  const byIp = await consumeIpRateLimit('webpin', 20, PIN_SEND_WINDOW_SEC);
  if (!byIp.ok) {
    return { ok: false, step: 'phone', phoneMasked: masked, message: '요청이 너무 잦습니다. 10분 후 다시 시도해 주세요.' };
  }
  const byMerchant = await consumeRateLimit('webpin-merchant', merchantId, 200, PIN_SEND_WINDOW_SEC);
  if (!byMerchant.ok) {
    return { ok: false, step: 'phone', phoneMasked: masked, message: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' };
  }

  const daily = await kv.incr(pinSendDayKey(ph), PIN_SEND_DAY_SEC);
  if (daily > PIN_SEND_DAILY_MAX) {
    return {
      ok: false,
      step: 'phone',
      phoneMasked: masked,
      message: '오늘은 이 번호로 결제를 더 시작할 수 없습니다. 내일 다시 시도해 주세요.',
    };
  }

  const sent = await kv.incr(pinSendKey(ph), PIN_SEND_WINDOW_SEC);
  if (sent > PIN_SEND_MAX) {
    return {
      ok: false,
      step: 'phone',
      phoneMasked: masked,
      message: '결제 문자 발송이 너무 잦습니다. 10분 후 다시 시도해 주세요.',
    };
  }

  // 결제수단이 등록된 번호인지 먼저 확인한다.
  // 등록되지 않은 번호로는 PIN 링크를 만들 수 없으므로 가입 안내로 보낸다.
  const payer = await prisma.payerProfile.findUnique({ where: { phoneHash: ph }, select: { id: true } });
  const token = payer
    ? await prisma.paymentMethodToken.findFirst({ where: { payerId: payer.id, status: 'ACTIVE' }, select: { id: true } })
    : null;

  if (!payer || !token) {
    return registerGuide({ phone, ph, masked, merchantId, payerExists: Boolean(payer) });
  }

  const result = await createWebCharge({
    phoneHash: ph,
    merchantId,
    amount: BigInt(amountRaw),
    message,
    requestId,
    campaignId,
    anonymous,
  });

  if (!result.ok || !result.chargeId) {
    // 결제수단 문제로 막힌 경우에는 가입 안내로 되돌린다.
    if (result.message.includes('가입')) {
      return registerGuide({ phone, ph, masked, merchantId, payerExists: true, reason: result.message });
    }
    return { ok: false, step: 'phone', phoneMasked: masked, message: result.message };
  }

  await setPinCookie(result.chargeId);
  logger.info('결제 페이지 웹 결제 PIN 링크 발송', { phone: masked, chargeId: result.chargeId });

  return {
    ok: true,
    step: 'waiting',
    phoneMasked: masked,
    expiresAt: result.pinExpiresAt?.toISOString(),
    mock: result.pinMock,
    message: result.message,
  };
}

/**
 * 미가입 번호: 결제수단 등록 링크를 **문자로만** 보낸다.
 *
 * 이 액션은 비로그인 상태에서 전화번호만 받고, 본인확인(SMS 인증번호)을 거치지 않는다.
 * 그래서 발급한 가입 링크를 응답으로 돌려주면 남의 번호를 적어 넣은 사람이
 * 그 번호에 묶인 링크를 그대로 받아 가게 된다. 그 링크로는 피해자의 마스킹 번호를 보고,
 * 자기 카드로 등록을 마치고, 로그인 상태라면 그 후원자 프로필을 자기 계정에 붙일 수도 있다.
 *
 * 그래서 링크는 번호의 실제 소유자만 받을 수 있는 문자로만 내보낸다.
 * (인증번호를 확인하는 web-charge.ts 경로는 본인확인을 마친 뒤라 팝업으로 열어 준다)
 */
async function registerGuide(input: {
  phone: string;
  ph: string;
  masked: string;
  merchantId: string;
  payerExists: boolean;
  reason?: string;
}): Promise<WebPinState> {
  // 가입 화면(loadRegistrationContext)은 전화번호로 후원자 프로필을 찾으므로,
  // 문자를 한 번도 보낸 적 없는 번호는 여기서 프로필을 먼저 만들어 둔다.
  if (!input.payerExists) {
    await prisma.payerProfile.upsert({
      where: { phoneHash: input.ph },
      update: {},
      create: { id: newId(), phoneHash: input.ph, phoneEnc: encrypt(input.phone), phoneMasked: input.masked },
    });
  }

  // 폼의 merchantId 는 검증되지 않은 값이므로 승인된 사회복지기관일 때만 링크에 연결한다.
  const linkedMerchant = input.merchantId
    ? await prisma.merchantProfile.findFirst({
        where: { id: input.merchantId, status: 'APPROVED' },
        select: { id: true, displayName: true },
      })
    : null;

  const link = await issueSecureLink({
    purpose: 'REGISTER_ACCOUNT',
    phoneHash: input.ph,
    merchantId: linkedMerchant?.id,
    payload: { channel: 'WEB' },
  });

  // 팝업이 차단되거나 창을 닫아도 가입을 이어갈 수 있도록 같은 링크를 문자로도 보낸다.
  // 문자 발송 실패가 팝업 안내를 막으면 안 되므로 실패는 로그로만 남긴다.
  let mtSent = false;
  try {
    mtSent = await sendMt({
      phone: input.phone,
      template: tpl.tplRegisterGuide(linkedMerchant?.displayName ?? '기브싸인', link.url),
      merchantId: linkedMerchant?.id ?? null,
    });
  } catch (error) {
    logger.error('결제 페이지 웹 가입 안내 문자 발송 실패', { message: (error as Error).message });
  }

  return {
    ok: true,
    step: 'register',
    phoneMasked: input.masked,
    // registerUrl 은 일부러 담지 않는다. 위 주석 참고.
    message:
      (input.reason ? `${input.reason} ` : '') +
      (mtSent
        ? '결제수단 등록이 필요합니다. 등록 링크를 문자로 보냈습니다. 등록을 마친 뒤 이 창에서 다시 결제해 주세요.'
        : '결제수단 등록이 필요합니다. 잠시 뒤 도착하는 등록 안내 문자의 링크로 등록을 마친 뒤 이 창에서 다시 결제해 주세요.'),
  };
}

// ---------------------------------------------------------------- 2) 결제 완료 폴링

/** 결제가 승인되어 후원 반영·정산으로 넘어간 상태들 */
const PAID_STATUSES = [
  'PAYMENT_SUCCESS',
  'BROADCAST_PENDING',
  'BROADCASTED',
  'PARTIAL_DELIVERY_FAILED',
  'SETTLEMENT_PENDING',
  'SETTLED',
];

/**
 * 대기 화면 폴링.
 *
 * 조회 대상은 HttpOnly 쿠키에 담긴 결제 ID 뿐이다. 클라이언트가 결제 ID 를 보내
 * 남의 거래 상태를 들여다보는 일이 생기지 않는다.
 */
export async function checkWebPinChargeStatus(): Promise<WebPinState> {
  const chargeId = await readPinCookie();
  if (!chargeId) {
    return { ok: false, step: 'phone', message: '진행 중인 결제가 없습니다. 처음부터 다시 시도해 주세요.' };
  }

  // 배치가 돌기 전이라도 만료를 화면에 바로 반영한다.
  await expirePinSessionIfStale(chargeId);

  const charge = await prisma.charge.findUnique({
    where: { id: chargeId },
    select: {
      status: true,
      statusReason: true,
      transactionNo: true,
      pinSession: { select: { status: true, expiresAt: true, mock: true } },
    },
  });
  if (!charge) {
    return { ok: false, step: 'phone', message: '결제 정보를 찾을 수 없습니다. 처음부터 다시 시도해 주세요.' };
  }

  if (PAID_STATUSES.includes(charge.status)) {
    return {
      ok: true,
      step: 'done',
      transactionNo: charge.transactionNo,
      message: '결제가 완료되었습니다. 결제된 건만 사회복지기관에 후원으로 반영됩니다.',
    };
  }

  if (charge.status === 'PENDING_PIN' || charge.status === 'PENDING_PAYMENT') {
    return {
      ok: true,
      step: 'waiting',
      expiresAt: charge.pinSession?.expiresAt.toISOString(),
      mock: charge.pinSession?.mock,
      message:
        charge.status === 'PENDING_PAYMENT'
          ? 'PIN 인증이 확인되어 결제를 진행하고 있습니다.'
          : undefined,
    };
  }

  // 만료·실패·차단 등 진행할 수 없는 상태
  const expired = charge.pinSession?.status === 'EXPIRED';
  return {
    ok: false,
    step: 'failed',
    message: expired
      ? 'PIN 입력 시간이 지나 결제가 취소되었습니다. 결제는 진행되지 않았습니다. 다시 시도해 주세요.'
      : charge.statusReason || '결제가 완료되지 않았습니다. 결제는 진행되지 않았습니다.',
  };
}
