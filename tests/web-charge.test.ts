import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PC 웹(결제 페이지) 전화번호 인증 서버 액션 검증.
 *
 *  - 인증 세션(Redis)에 전화번호 원문이 남지 않는다.
 *  - 미가입자에게 가입 링크를 발급할 때 팝업 URL 과 MT 문자를 함께 내보낸다.
 *
 * 서버 액션은 next/headers 의 쿠키 저장소를 사용하므로 테스트용 메모리 저장소로 대체한다.
 */

const cookieJar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));

import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { readMockOutbox } from '@/server/adapters/mt';
import { decrypt, normalizePhone, phoneHash } from '@/lib/crypto';
import { requestWebDonateCode, verifyWebDonateCode, type WebDonateState } from '@/app/actions/web-charge';
import { resetDb, seedBasics, type Fixture } from './helpers';

let fx: Fixture;

const initial: WebDonateState = { ok: false, step: 'phone' };
const WEB_PHONE = '01055556666';
// 인증번호 발송은 번호당 10분에 3회로 제한된다. 테스트마다 다른 번호를 써서 제한에 걸리지 않게 한다.
const ALT_PHONE_1 = '01055556601';
const ALT_PHONE_2 = '01055556602';

function fd(entries: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
}

/** mock 발송함에서 방금 나간 인증번호를 읽는다. */
function readSentCode(): string {
  const sent = readMockOutbox(5).find((m) => m.text.includes('인증번호'));
  expect(sent).toBeDefined();
  const m = sent!.text.match(/(\d{6})/);
  expect(m).not.toBeNull();
  return m![1];
}

async function readCodeSession(ticket: string) {
  const raw = await kv.get(`webdon:code:${ticket}`);
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as { ph: string; pm: string; pn: string; ch: string; at: number };
}

describe('결제 페이지 웹 인증 — 세션 전화번호 보호', () => {
  beforeEach(async () => {
    await resetDb();
    cookieJar.clear();
    fx = await seedBasics();
  });

  it('인증 세션에는 전화번호 원문이 저장되지 않고 복호화로만 읽을 수 있다', async () => {
    const state = await requestWebDonateCode(initial, fd({ phone: '010-5555-6666' }));
    expect(state.step).toBe('code');
    expect(state.ticket).toBeTruthy();

    const rec = await readCodeSession(state.ticket!);
    // 저장된 값 어디에도 전화번호 원문이 없다.
    expect(JSON.stringify(rec)).not.toContain(WEB_PHONE);
    expect(rec.pn).not.toBe(WEB_PHONE);
    expect(decrypt(rec.pn)).toBe(WEB_PHONE);
    // 검색용 해시와 마스킹만 평문으로 둔다.
    expect(rec.ph).toBe(phoneHash(WEB_PHONE));
    expect(rec.pm).toBe('010-****-6666');
  });

  it('손상된 암호문이 들어 있으면 인증을 진행하지 않고 처음부터 다시 안내한다', async () => {
    const state = await requestWebDonateCode(initial, fd({ phone: ALT_PHONE_1 }));
    const code = readSentCode();
    const rec = await readCodeSession(state.ticket!);

    // 복호화할 수 없는 값으로 바꿔 둔다.
    await kv.set(`webdon:code:${state.ticket!}`, JSON.stringify({ ...rec, pn: 'v1:local:zzz:zzz:zzz' }), 300);

    const verified = await verifyWebDonateCode(initial, fd({ ticket: state.ticket!, code, merchantId: fx.merchantId }));
    expect(verified.ok).toBe(false);
    expect(verified.step).toBe('phone');
    expect(verified.registerUrl).toBeUndefined();
    // 링크도 후원자 프로필도 만들지 않는다.
    expect(await prisma.secureLink.count()).toBe(0);
    expect(await prisma.payerProfile.count()).toBe(0);
  });
});

describe('결제 페이지 웹 인증 — 미가입자 가입 안내', () => {
  beforeEach(async () => {
    await resetDb();
    cookieJar.clear();
    fx = await seedBasics();
  });

  it('가입 링크를 팝업으로 돌려주면서 같은 링크를 MT 문자로도 발송한다', async () => {
    const state = await requestWebDonateCode(initial, fd({ phone: '010-5555-6666' }));
    const code = readSentCode();

    const verified = await verifyWebDonateCode(initial, fd({ ticket: state.ticket!, code, merchantId: fx.merchantId }));

    // 팝업 안내는 정상 동작한다.
    expect(verified.ok).toBe(true);
    expect(verified.step).toBe('register');
    expect(verified.registerUrl).toContain('/r/');
    expect(verified.message).toContain('문자');

    // 발송 이력이 남는다.
    const mt = await prisma.mtOutboundMessage.findFirstOrThrow({ where: { templateCode: 'REGISTER_GUIDE' } });
    expect(mt.status).toBe('SENT');
    expect(mt.phoneHash).toBe(phoneHash(WEB_PHONE));
    expect(mt.phoneMasked).toBe('010-****-6666');
    expect(mt.merchantId).toBe(fx.merchantId);
    // 보안 링크 원문은 이력 본문에 남기지 않는다.
    expect(mt.bodyMasked).toContain('[보안링크]');
    expect(mt.bodyMasked).not.toContain('/r/');

    // 실제 문자 본문에는 팝업과 같은 링크가 담긴다.
    const outbox = readMockOutbox(5).find((m) => m.text.includes('계좌 등록'));
    expect(outbox).toBeDefined();
    expect(outbox!.to).toBe(normalizePhone(WEB_PHONE));
    expect(outbox!.text).toContain(verified.registerUrl!);

    // 가입 화면이 찾을 수 있도록 후원자 프로필이 만들어지고, 전화번호는 암호화 저장된다.
    const payer = await prisma.payerProfile.findUniqueOrThrow({ where: { phoneHash: phoneHash(WEB_PHONE) } });
    expect(decrypt(payer.phoneEnc)).toBe(WEB_PHONE);
    expect(payer.phoneMasked).toBe('010-****-6666');
  });

  it('인증번호가 틀리면 링크도 문자도 나가지 않는다', async () => {
    const state = await requestWebDonateCode(initial, fd({ phone: ALT_PHONE_2 }));
    const code = readSentCode();
    const wrong = code === '000000' ? '111111' : '000000';

    const verified = await verifyWebDonateCode(initial, fd({ ticket: state.ticket!, code: wrong, merchantId: fx.merchantId }));
    expect(verified.ok).toBe(false);
    expect(verified.step).toBe('code');
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'REGISTER_GUIDE' } })).toBe(0);
    expect(await prisma.secureLink.count()).toBe(0);
  });
});
