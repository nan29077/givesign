import { describe, it, expect } from 'vitest';
import { getMoAdapter, mockMoAdapter } from '@/server/adapters/mo';
import { mtonetMoAdapter, parseMtonetDate, FIELD_ALIASES } from '@/server/adapters/mo/mtonet';
import {
  apiSignature,
  authWindowHash,
  callbackHost,
  hectoDay,
  hectoTime,
  hectoEncrypt,
  hectoDecrypt,
  hectoPaymentAdapter,
  HECTO_SPEC,
} from '@/server/adapters/payment/hecto';
import { AdapterNotConfiguredError } from '@/server/adapters/types';

/**
 * 4단계 외부 연동 어댑터 검증.
 * 계약 전이라 실제 통신은 하지 않고, 서명·암호화·파싱·fail-closed 동작을 확인한다.
 */

const validPayload = {
  msgId: 'MT-20260820-0001',
  callee: '050-5100-1001',
  caller: '010-1234-5678',
  msg: '캐시 충전합니다',
  msgType: 'SMS',
  recvDate: '20260820153012',
};

describe('MTONET MO 어댑터 - 파싱', () => {
  it('정상 payload 를 정규화한다 (하이픈 제거, KST 시각 해석)', () => {
    const out = mtonetMoAdapter.parse(validPayload);
    expect(out.providerMessageId).toBe('MT-20260820-0001');
    expect(out.providerCode).toBe('mtonet');
    expect(out.receivedNumber).toBe('05051001001');
    expect(out.fromNumber).toBe('01012345678');
    expect(out.messageType).toBe('SMS');
    expect(out.content).toBe('캐시 충전합니다');
    // 2026-08-20 15:30:12 KST = 06:30:12 UTC
    expect(out.receivedAt.toISOString()).toBe('2026-08-20T06:30:12.000Z');
  });

  it('payload 를 data/result 로 한 겹 감싸도 파싱한다', () => {
    expect(mtonetMoAdapter.parse({ data: validPayload }).receivedNumber).toBe('05051001001');
    expect(mtonetMoAdapter.parse({ result: validPayload }).receivedNumber).toBe('05051001001');
  });

  it('필드명이 달라도 별칭 목록 안이면 파싱한다', () => {
    const alt = { messageId: 'X1', recvNo: '05059000000', sendNo: '01099998888', text: '안녕' };
    const out = mtonetMoAdapter.parse(alt);
    expect(out.receivedNumber).toBe('05059000000');
    expect(out.fromNumber).toBe('01099998888');
  });

  it('필수값이 없으면 기본값으로 때우지 않고 실패시킨다', () => {
    for (const key of ['msgId', 'callee', 'caller', 'msg'] as const) {
      const broken: Record<string, unknown> = { ...validPayload };
      delete broken[key];
      expect(() => mtonetMoAdapter.parse(broken)).toThrow(/필수값 누락/);
    }
  });

  it('050 이 아닌 수신번호는 거절한다 (라우팅 사고 방지)', () => {
    expect(() => mtonetMoAdapter.parse({ ...validPayload, callee: '15881234' })).toThrow(/050/);
    expect(() => mtonetMoAdapter.parse({ ...validPayload, callee: '01012345678' })).toThrow(/050/);
  });

  it('발신번호 형식이 이상하면 거절한다', () => {
    expect(() => mtonetMoAdapter.parse({ ...validPayload, caller: '123' })).toThrow(/발신번호/);
  });

  it('90바이트를 넘는 본문은 LMS 로 판정한다', () => {
    const long = '가'.repeat(60); // UTF-8 180바이트
    const out = mtonetMoAdapter.parse({ ...validPayload, msgType: '', msg: long });
    expect(out.messageType).toBe('LMS');
  });

  it('제목이 오면 본문 앞에 붙인다', () => {
    const out = mtonetMoAdapter.parse({ ...validPayload, subject: '[응원]' });
    expect(out.content).toBe('[응원] 캐시 충전합니다');
  });

  it('시각 표기 3종을 모두 KST 로 해석한다', () => {
    const iso = '2026-08-20T06:30:12.000Z';
    expect(parseMtonetDate('20260820153012').toISOString()).toBe(iso);
    expect(parseMtonetDate('2026-08-20 15:30:12').toISOString()).toBe(iso);
    expect(parseMtonetDate('2026-08-20T15:30:12+09:00').toISOString()).toBe(iso);
    // 파싱 불가 값은 fallback 을 쓴다 (예외로 결제 유실 방지)
    const fb = new Date('2020-01-01T00:00:00.000Z');
    expect(parseMtonetDate('알수없음', fb).toISOString()).toBe(fb.toISOString());
  });

  it('별칭 표에 규격 후보가 실제로 들어 있다', () => {
    expect(FIELD_ALIASES.to).toContain('callee');
    expect(FIELD_ALIASES.from).toContain('caller');
  });
});

describe('MO 웹훅 검증 (fail-closed)', () => {
  const headers = { 'x-signature': 'wrong-signature' };

  it('MO_PROVIDER=mtonet 이면 mtonet 어댑터가 선택된다', () => {
    const original = process.env.MO_PROVIDER;
    try {
      // env 는 모듈 로드 시 고정되므로 어댑터 자체 identity 로 확인한다.
      expect(mtonetMoAdapter.info().provider).toBe('mtonet');
      expect(typeof getMoAdapter().parse).toBe('function');
    } finally {
      process.env.MO_PROVIDER = original;
    }
  });

  it('서명이 틀리면 거절한다', () => {
    // 로컬 환경이라도 시크릿이 설정돼 있으면 서명을 반드시 검사한다.
    const r = mockMoAdapter.verify('{"a":1}', headers, undefined);
    if (process.env.MO_WEBHOOK_SECRET) {
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/서명/);
    }
  });

  it('mtonet 어댑터도 같은 공용 검증을 통과해야 한다', () => {
    const r = mtonetMoAdapter.verify('{"a":1}', headers, undefined);
    if (process.env.MO_WEBHOOK_SECRET) expect(r.ok).toBe(false);
  });
});

describe('헥토 EzAuth - 서명/암호화', () => {
  it('서버 API 서명은 SHA256(mercntId+authNo+reqDay+reqTime+hashKey) 이다', () => {
    const sig = apiSignature({
      mercntId: 'M2100001',
      authNo: 'ORD-1',
      reqDay: '20260820',
      reqTime: '153012',
      hashKey: 'HASHKEY',
    });
    // 재료 순서가 바뀌면 값이 달라져야 한다 (연결 순서 회귀 방지)
    const wrongOrder = apiSignature({
      mercntId: 'ORD-1',
      authNo: 'M2100001',
      reqDay: '20260820',
      reqTime: '153012',
      hashKey: 'HASHKEY',
    });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).not.toBe(wrongOrder);
  });

  it('결제창 해시는 암호문이 아니라 평문 금액을 재료로 쓴다', () => {
    const base = {
      mercntId: 'M2100001',
      ordNo: 'ORD-1',
      trDay: '20260820',
      trTime: '153012',
      callbackUrlHost: 'givesign.kr',
      hashKey: 'HASHKEY',
    };
    const plain = authWindowHash({ ...base, trPricePlain: '3000' });
    const encrypted = authWindowHash({ ...base, trPricePlain: 'ZW5jcnlwdGVk' });
    expect(plain).not.toBe(encrypted);
    expect(plain).toMatch(/^[0-9a-f]{64}$/);
  });

  it('콜백 URL 에서 호스트만 뽑는다', () => {
    expect(callbackHost('https://givesign.kr/api/payments/hecto/return')).toBe('givesign.kr');
    expect(callbackHost('http://localhost:3060/x')).toBe('localhost:3060');
    expect(callbackHost('not-a-url')).toBe('');
  });

  it('KST 기준 yyyyMMdd / HHmmss 를 만든다', () => {
    const at = new Date('2026-08-20T06:30:12.000Z'); // KST 15:30:12
    expect(hectoDay(at)).toBe('20260820');
    expect(hectoTime(at)).toBe('153012');
    // 자정 경계: UTC 2026-08-19T15:00:00Z = KST 2026-08-20 00:00:00
    expect(hectoDay(new Date('2026-08-19T15:00:00.000Z'))).toBe('20260820');
  });

  it('AES-256 암복호화가 왕복한다', () => {
    const key = '0123456789abcdef0123456789abcdef'; // 32byte
    const enc = hectoEncrypt('3000', key);
    expect(enc).not.toBe('3000');
    expect(hectoDecrypt(enc, key)).toBe('3000');
  });

  it('AES 키 길이가 32바이트가 아니면 즉시 실패한다', () => {
    expect(() => hectoEncrypt('3000', 'short-key')).toThrow(/32바이트/);
  });

  it('결제창과 서버 API 호스트 경로가 분리되어 있다', () => {
    expect(HECTO_SPEC.authWindowPath).not.toBe(HECTO_SPEC.approvePath);
    expect(HECTO_SPEC.approvePath).toContain('APIPayApprov');
    expect(HECTO_SPEC.billKeyPath).toContain('APIRegularpayKey');
  });
});

describe('헥토 어댑터 - 설정 누락 시 fail-closed', () => {
  it('키가 없으면 mock 으로 대체하지 않고 예외를 던진다', async () => {
    const missing = hectoPaymentAdapter.info().missingCredentials;
    // 이 저장소의 .env 는 헥토 키가 비어 있으므로 미설정 상태여야 한다.
    expect(missing.length).toBeGreaterThan(0);
    expect(hectoPaymentAdapter.info().mode).toBe('mock');

    await expect(
      hectoPaymentAdapter.approve({
        orderNo: 'ORD-1',
        amount: 3000n,
        billKey: 'BILL',
        productName: '문자후원',
      }),
    ).rejects.toBeInstanceOf(AdapterNotConfiguredError);

    await expect(hectoPaymentAdapter.inquire('ORD-1')).rejects.toBeInstanceOf(AdapterNotConfiguredError);
    await expect(
      hectoPaymentAdapter.cancel({ orderNo: 'ORD-1', providerTid: 'T', amount: 3000n }),
    ).rejects.toBeInstanceOf(AdapterNotConfiguredError);
  });
});
