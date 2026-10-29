'use server';

import { cookies } from 'next/headers';
import { prisma } from '@/server/db';
import { kv, consumeAttempt } from '@/server/redis';
import { consumeIpRateLimit } from '@/server/rate-limit';
import { newId } from '@/lib/id';
import { decrypt, encrypt, generateNumericCode, hmac, maskPhone, normalizePhone, phoneHash, safeEqual } from '@/lib/crypto';
import { getMtAdapter } from '@/server/adapters/mt';
import { env, isLocal } from '@/lib/env';
import { logger } from '@/lib/logger';
import { issueSecureLink } from '@/server/services/secure-link';
import { createWebCharge } from '@/server/services/web-charge';
import { sendMt } from '@/server/services/charge-flow';
import * as tpl from '@/server/services/mt-templates';

/**
 * 결제 페이지 PC 웹 결제 서버 액션.
 *
 * 1) 전화번호로 인증번호 발송 → 2) 인증 성공 시 서버 KV 에 인증 세션 저장
 * 3) 등록 후원자(내통장결제 가입자)면 텍스트+금액 결제를 즉시 결제 실행
 *    미가입자면 가입 보안 링크를 발급해 팝업으로 안내하고, 같은 링크를 MT 문자로도 보낸다.
 *
 * 보안: 인증 코드는 HMAC 으로만 저장, 시도 5회 제한, 발송 3회/10분 제한,
 *       클라이언트에는 불투명 티켓만 전달, 세션 30분,
 *       KV 에 담는 전화번호(pn)는 암호화 저장하고 필요한 순간에만 복호화.
 */

const CODE_TTL_SEC = 300;
const MAX_ATTEMPTS = 5;
const SEND_WINDOW_SEC = 600;
const SEND_MAX = 3;
const SESSION_SEC = 1800;

const codeKey = (t: string) => `webdon:code:${t}`;
/** 오입력 횟수 카운터. 레코드와 분리해 원자적으로 센다. */
const attemptKey = (t: string) => `webdon:try:${t}`;
const sessionKey = (t: string) => `webdon:session:${t}`;
const sendPhoneKey = (ph: string) => `webdon:send:${ph}`;

/**
 * 인증 세션 토큰은 **HttpOnly 쿠키**로만 오간다.
 *
 * 예전에는 폼의 hidden 필드로 실어 날랐는데, 그러면 토큰이 DOM·화면공유·확장프로그램·
 * 브라우저 자동완성에 그대로 노출되고 쿠키·IP 어디에도 결속돼 있지 않아,
 * 값을 손에 넣은 사람이 유효시간(30분) 안에 그 전화번호로 결제할 수 있다.
 * 클라이언트에는 "인증됨" 여부만 알려주고, 실제 토큰은 서버만 읽는다.
 */
const SESSION_COOKIE = 'webdon_session';
/** 클라이언트 상태에 넣는 값. 실제 토큰이 아니라 단계 판정을 위한 표식이다. */
const SESSION_PRESENT = '1';

async function setSessionCookie(token: string) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !isLocal && env.baseUrl.startsWith('https'),
    path: '/',
    maxAge: SESSION_SEC,
  });
}

async function readSessionPhoneHash(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return kv.get(sessionKey(token));
}

function digest(code: string) {
  return hmac(code, env.crypto.sessionSecret);
}

function randomCode() {
  return generateNumericCode(6);
}

export interface WebDonateState {
  ok: boolean;
  step: 'phone' | 'code' | 'ready' | 'register' | 'done';
  message?: string;
  phoneMasked?: string;
  ticket?: string;
  /** 인증 완료 후 발급되는 세션 티켓 (결제 제출에 사용) */
  session?: string;
  /** 미가입자의 내통장결제 가입 링크 (팝업으로 연다) */
  registerUrl?: string;
  /** 비운영 mock 환경에서만 노출되는 인증번호 */
  devCode?: string;
  /** 결제 완료 정보 */
  transactionNo?: string;
}

// ---------------------------------------------------------------- 1) 인증번호 발송

export async function requestWebDonateCode(_prev: WebDonateState, formData: FormData): Promise<WebDonateState> {
  const phone = normalizePhone(String(formData.get('phone') ?? ''));
  if (!/^01[0-9]{8,9}$/.test(phone)) {
    return { ok: false, step: 'phone', message: '휴대전화 번호 형식을 확인해 주세요. (예: 010-1234-5678)' };
  }

  // 번호 버킷만으로는 번호를 바꿔 가며 무제한 발송할 수 있다(문자 비용 소진 + 우리 발신번호를 쓴 스팸).
  // 로그인 없이 문자를 보내는 입구이므로 IP 버킷도 함께 센다.
  const byIp = await consumeIpRateLimit('webcharge-otp', 20, SEND_WINDOW_SEC);
  if (!byIp.ok) {
    return { ok: false, step: 'phone', message: '요청이 너무 잦습니다. 10분 후 다시 시도해 주세요.' };
  }

  const ph = phoneHash(phone);
  const sent = await kv.incr(sendPhoneKey(ph), SEND_WINDOW_SEC);
  if (sent > SEND_MAX) {
    return { ok: false, step: 'phone', message: '인증번호 발송이 너무 잦습니다. 10분 후 다시 시도해 주세요.' };
  }

  const code = randomCode();
  const masked = maskPhone(phone);
  const ticket = newId();

  const adapter = getMtAdapter();
  const verifyTemplate = await tpl.applyMtTemplateOverride(tpl.tplPaymentVerify(code));
  const res = await adapter.send({ to: phone, text: verifyTemplate.text, templateCode: verifyTemplate.code });
  if (!res.ok) {
    return { ok: false, step: 'phone', message: '인증번호 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.' };
  }

  // pn(전화번호)은 Redis 에 평문으로 두지 않는다. 서버에서만 복호화해 사용한다.
  await kv.set(
    codeKey(ticket),
    JSON.stringify({ ph, pm: masked, pn: encrypt(phone), ch: digest(code), at: MAX_ATTEMPTS }),
    CODE_TTL_SEC,
  );
  logger.info('결제 페이지 웹 결제 인증번호 발송', { phone: masked });

  return {
    ok: true,
    step: 'code',
    phoneMasked: masked,
    ticket,
    message: `${masked} 번호로 인증번호를 발송했습니다.`,
    devCode: isLocal && adapter.info().provider === 'mock' ? code : undefined,
  };
}

// ---------------------------------------------------------------- 2) 인증 확인

export async function verifyWebDonateCode(_prev: WebDonateState, formData: FormData): Promise<WebDonateState> {
  const ticket = String(formData.get('ticket') ?? '');
  const code = String(formData.get('code') ?? '').replace(/\s/g, '');
  const merchantId = String(formData.get('merchantId') ?? '');
  if (!ticket) return { ok: false, step: 'phone', message: '인증 정보가 만료되었습니다. 처음부터 다시 시도해 주세요.' };
  if (!/^\d{6}$/.test(code)) return { ok: false, step: 'code', ticket, message: '인증번호 6자리를 입력해 주세요.' };

  const raw = await kv.get(codeKey(ticket));
  if (!raw) return { ok: false, step: 'phone', message: '인증 유효시간이 지났습니다. 인증번호를 다시 요청해 주세요.' };

  // pn 은 암호문이다. 평문 전화번호가 필요한 분기에서만 복호화한다.
  let rec: { ph: string; pm: string; pn: string; ch: string; at: number };
  try {
    rec = JSON.parse(raw);
  } catch {
    await kv.del(codeKey(ticket));
    return { ok: false, step: 'phone', message: '인증 정보가 손상되었습니다. 다시 시도해 주세요.' };
  }

  if (!safeEqual(digest(code), rec.ch)) {
    const remain = await consumeAttempt(attemptKey(ticket), MAX_ATTEMPTS, CODE_TTL_SEC);
    if (remain <= 0) {
      await kv.del(codeKey(ticket));
      await kv.del(attemptKey(ticket));
      return {
        ok: false,
        step: 'phone',
        message: `인증번호를 ${MAX_ATTEMPTS}회 잘못 입력했습니다. 처음부터 다시 시도해 주세요.`,
      };
    }
    return { ok: false, step: 'code', ticket, phoneMasked: rec.pm, message: `인증번호가 일치하지 않습니다. (남은 시도 ${remain}회)` };
  }

  await kv.del(codeKey(ticket));
  await kv.del(attemptKey(ticket));
  // 세션 토큰은 HttpOnly 쿠키로만 내려보낸다. 클라이언트 상태에는 표식만 담는다.
  const sessionToken = newId();
  await kv.set(sessionKey(sessionToken), rec.ph, SESSION_SEC);
  await setSessionCookie(sessionToken);
  const session = SESSION_PRESENT;

  // 등록(내통장결제 가입 + 활성 결제수단) 여부 확인
  const payer = await prisma.payerProfile.findUnique({
    where: { phoneHash: rec.ph },
    select: { id: true },
  });
  const token = payer
    ? await prisma.paymentMethodToken.findFirst({ where: { payerId: payer.id, status: 'ACTIVE' }, select: { id: true } })
    : null;

  if (payer && token) {
    return { ok: true, step: 'ready', session, phoneMasked: rec.pm, message: '인증이 완료되었습니다. 금액과 메시지를 확인한 뒤 결제해 주세요.' };
  }

  // 미가입: 내통장결제 가입 보안 링크 발급 (팝업 + 안내 문자)
  // 세션에는 암호화된 전화번호만 들어 있으므로 실제로 필요한 이 분기에서만 복호화한다.
  let phone: string;
  try {
    phone = normalizePhone(decrypt(rec.pn));
  } catch (error) {
    logger.error('결제 페이지 웹 인증 전화번호 복호화 실패', { message: (error as Error).message });
    return { ok: false, step: 'phone', message: '인증 정보를 확인할 수 없습니다. 처음부터 다시 시도해 주세요.' };
  }
  if (!/^01[0-9]{8,9}$/.test(phone)) {
    logger.error('결제 페이지 웹 인증 전화번호 형식 오류', { phone: rec.pm });
    return { ok: false, step: 'phone', message: '인증 정보를 확인할 수 없습니다. 처음부터 다시 시도해 주세요.' };
  }

  // 가입 화면(loadRegistrationContext)은 전화번호로 후원자 프로필을 찾으므로,
  // 문자를 한 번도 보낸 적 없는 번호는 여기서 프로필을 먼저 만들어 둔다.
  if (!payer) {
    await prisma.payerProfile.upsert({
      where: { phoneHash: rec.ph },
      update: {},
      create: { id: newId(), phoneHash: rec.ph, phoneEnc: encrypt(phone), phoneMasked: rec.pm },
    });
  }
  // 폼의 merchantId 는 검증되지 않은 값이므로 승인된 사회복지기관일 때만 링크에 연결한다.
  const linkedMerchant = merchantId
    ? await prisma.merchantProfile.findFirst({
        where: { id: merchantId, status: 'APPROVED' },
        select: { id: true, displayName: true },
      })
    : null;
  const link = await issueSecureLink({
    purpose: 'REGISTER_ACCOUNT',
    phoneHash: rec.ph,
    merchantId: linkedMerchant?.id,
    payload: { channel: 'WEB' },
  });

  // 팝업이 차단되거나 창을 닫아도 가입을 이어갈 수 있도록 MO 경로와 같은 안내 문자를 함께 보낸다.
  // 문자 발송 결과가 팝업 안내를 막으면 안 되므로 실패는 로그로만 남긴다. (이력은 MtOutboundMessage 에 남는다)
  let mtSent = false;
  try {
    mtSent = await sendMt({
      phone,
      template: tpl.tplRegisterGuide(linkedMerchant?.displayName ?? '기브싸인', link.url),
      merchantId: linkedMerchant?.id ?? null,
    });
  } catch (error) {
    logger.error('결제 페이지 웹 가입 안내 문자 발송 실패', { message: (error as Error).message });
  }

  return {
    ok: true,
    step: 'register',
    session,
    phoneMasked: rec.pm,
    registerUrl: link.url,
    message: mtSent
      ? '내통장결제 가입이 필요합니다. 가입 링크를 문자로도 보냈습니다. 가입 창에서 계좌 등록을 완료한 뒤 이 창에서 결제를 이어가 주세요.'
      : '내통장결제 가입이 필요합니다. 가입 창에서 계좌 등록을 완료한 뒤 이 창에서 결제를 이어가 주세요.',
  };
}

// ---------------------------------------------------------------- 3) 결제 제출 (즉시 결제)
//
// **deprecated** — 기본 경로는 PIN 인증(web-charge-pin.ts)이다.
// 이 액션은 ALLOW_LEGACY_WEB_INSTANT_PAY=true 일 때 쓰이는 구 화면 전용이다.

export async function submitWebCharge(_prev: WebDonateState, formData: FormData): Promise<WebDonateState> {
  const merchantId = String(formData.get('merchantId') ?? '');
  const requestId = String(formData.get('requestId') ?? '');
  const message = String(formData.get('message') ?? '').trim();
  const amountRaw = String(formData.get('amount') ?? '').replace(/[^\d]/g, '');

  // 폼으로 온 값은 신뢰하지 않는다. 인증 주체는 오직 HttpOnly 쿠키다.
  const ph = await readSessionPhoneHash();
  if (!ph) return { ok: false, step: 'phone', message: '인증이 만료되었습니다. 전화번호 인증을 다시 진행해 주세요.' };
  const session = SESSION_PRESENT;

  if (!merchantId || !requestId) return { ok: false, step: 'ready', session, message: '요청 정보가 올바르지 않습니다.' };
  if (!message) return { ok: false, step: 'ready', session, message: '결제 메시지를 입력해 주세요.' };
  if (message.length > 200) return { ok: false, step: 'ready', session, message: '결제 메시지는 200자 이내로 입력해 주세요.' };
  if (!/^\d{3,7}$/.test(amountRaw)) return { ok: false, step: 'ready', session, message: '결제 금액을 확인해 주세요.' };

  const result = await createWebCharge({
    phoneHash: ph,
    merchantId,
    amount: BigInt(amountRaw),
    message,
    requestId,
  });

  // 플래그가 중간에 꺼져 PIN 흐름으로 접수된 경우.
  // 아직 출금 전이므로 '완료'로 표시하지 않는다(결제 성공과 인증 대기를 같은 상태로 취급하지 않는다).
  if (result.ok && result.status === 'PENDING_PIN') {
    return { ok: true, step: 'ready', session, message: result.message };
  }

  if (!result.ok) {
    // 결제수단 미등록으로 실패한 경우 가입 단계로 되돌린다
    if (result.message.includes('가입')) {
      const link = await issueSecureLink({
        purpose: 'REGISTER_ACCOUNT',
        phoneHash: ph,
        merchantId,
        payload: { channel: 'WEB' },
      });
      return { ok: false, step: 'register', session, registerUrl: link.url, message: result.message };
    }
    return { ok: false, step: 'ready', session, message: result.message };
  }

  return { ok: true, step: 'done', session, transactionNo: result.transactionNo, message: result.message };
}

// ---------------------------------------------------------------- 가입 완료 후 재확인

export async function checkWebDonateRegistered(_prev: WebDonateState, _formData: FormData): Promise<WebDonateState> {
  const ph = await readSessionPhoneHash();
  if (!ph) return { ok: false, step: 'phone', message: '인증이 만료되었습니다. 처음부터 다시 시도해 주세요.' };
  const session = SESSION_PRESENT;

  const payer = await prisma.payerProfile.findUnique({ where: { phoneHash: ph }, select: { id: true } });
  const token = payer
    ? await prisma.paymentMethodToken.findFirst({ where: { payerId: payer.id, status: 'ACTIVE' }, select: { id: true } })
    : null;

  if (payer && token) {
    return { ok: true, step: 'ready', session, message: '가입이 확인되었습니다. 이제 결제할 수 있습니다.' };
  }
  return { ok: false, step: 'register', session, message: '아직 가입이 완료되지 않았습니다. 가입 창에서 계좌 등록을 마친 뒤 다시 확인해 주세요.' };
}
