import { describe, it, expect } from 'vitest';
import { normalizeKeyword, isValidKeyword, splitKeyword } from '@/server/services/content-filter';
import { normalizeIp, isAllowedIp } from '@/server/rate-limit';
import { merchantPayerRef, phoneHash } from '@/lib/crypto';
import { restoreMoNumber, splitMoNumber, formatMoNumber, isUsableSubCode } from '@/server/emma';

/**
 * 2026-09-04 점검 수정 검증 (DB 불필요한 순수 로직).
 *
 * 각 테스트가 "무엇이 잘못돼서 고쳤는지" 를 함께 적어 둔다. 회귀하면 여기서 잡힌다.
 */

describe('키워드 정규화 — 등록과 매칭이 같은 규칙을 쓴다', () => {
  /**
   * 이전: 등록은 `toUpperCase() + 공백 제거`, 매칭은 `toUpperCase() + 하이픈 제거`.
   * "GIV-1234" 로 등록하면 DB 에는 `GIV-1234`, 수신 파싱값은 `MSG1234` 가 되어
   * 그 사회복지기관의 문자후원가 전건 UNKNOWN_ROUTE 로 떨어졌다.
   */
  it('구분 기호·대소문자·전각을 같은 표준형으로 접는다', () => {
    expect(normalizeKeyword('GIV-1234')).toBe('MSG1234');
    expect(normalizeKeyword('msg 1234')).toBe('MSG1234');
    expect(normalizeKeyword('msg_1234')).toBe('MSG1234');
    expect(normalizeKeyword('ＭＳＧ１２３４')).toBe('MSG1234');
  });

  it('한글 키워드도 정규화한다', () => {
    expect(normalizeKeyword('충 전')).toBe('충전');
  });

  it('수신 문자 파싱 결과가 등록 정규화 결과와 일치한다', () => {
    expect(splitKeyword('GIV-1234 안녕하세요').keyword).toBe(normalizeKeyword('msg 1234'));
    expect(splitKeyword('GIV-1234 안녕하세요').rest).toBe('안녕하세요');
  });

  it('한글 키워드도 매칭된다 (이전 정규식은 ASCII 만 봤다)', () => {
    expect(splitKeyword('충전 만원').keyword).toBe('충전');
    expect(splitKeyword('충전 만원').rest).toBe('만원');
  });

  it('기존 영문+숫자 키워드는 그대로 동작한다', () => {
    expect(splitKeyword('MSG3QP7 캐시 충전').keyword).toBe('MSG3QP7');
    expect(splitKeyword('MSG3QP7 캐시 충전').rest).toBe('캐시 충전');
  });

  it('키워드만 있고 본문이 없으면 키워드로 보지 않는다', () => {
    expect(splitKeyword('MSG3QP7').keyword).toBeNull();
  });

  it('기호만으로 이뤄진 키워드는 거부한다 (어떤 문장과도 비교 불가)', () => {
    expect(isValidKeyword('--')).toBe(false);
    expect(isValidKeyword('.')).toBe(false);
    expect(isValidKeyword('AB')).toBe(true);
    expect(isValidKeyword('충전')).toBe(true);
  });
});

describe('IP 허용목록 — IPv4-mapped IPv6 를 같은 주소로 본다', () => {
  /**
   * 이전: `env.mo.allowedIps.includes(ip)` 문자열 완전일치.
   * 프록시가 `::ffff:203.0.113.10` 형태로 넘기면 허용목록에 적어 둔 주소인데도
   * MO 웹훅이 전건 401 이 되어 수신이 통째로 멈춘다.
   */
  it('매핑 표기를 IPv4 로 되돌린다', () => {
    expect(normalizeIp('::ffff:203.0.113.10')).toBe('203.0.113.10');
    expect(normalizeIp('0:0:0:0:0:ffff:203.0.113.10')).toBe('203.0.113.10');
  });

  it('포트·대괄호·대소문자를 정규화한다', () => {
    expect(normalizeIp('203.0.113.10:51514')).toBe('203.0.113.10');
    expect(normalizeIp('[2001:DB8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('허용목록 비교가 표기 차이를 넘어선다', () => {
    expect(isAllowedIp('::ffff:203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(isAllowedIp('203.0.113.10', ['::ffff:203.0.113.10'])).toBe(true);
  });

  it('다른 주소·빈 값은 여전히 거절한다 (fail-closed)', () => {
    expect(isAllowedIp('203.0.113.11', ['203.0.113.10'])).toBe(false);
    expect(isAllowedIp(undefined, ['203.0.113.10'])).toBe(false);
    expect(isAllowedIp('', ['203.0.113.10'])).toBe(false);
  });
});

describe('payerRef — 사회복지기관별 파생 식별자', () => {
  /**
   * 이전: 파트너 API 가 전역 phoneHash 를 그대로 내보냈다.
   * 사회복지기관 A 와 B 가 받은 값을 맞춰 보는 것만으로 같은 사람임을 알 수 있어,
   * 두 곳의 데이터가 합쳐지면 후원자 내역이 통째로 연결된다.
   */
  const ph = phoneHash('010-1234-5678');

  it('같은 사회복지기관 안에서는 결정적이다 (회원 매칭 유지)', () => {
    expect(merchantPayerRef('merchant-a', ph)).toBe(merchantPayerRef('merchant-a', ph));
  });

  it('사회복지기관이 다르면 다른 값이 나온다 (사회복지기관 간 추적 차단)', () => {
    expect(merchantPayerRef('merchant-a', ph)).not.toBe(merchantPayerRef('merchant-b', ph));
  });

  it('전역 phoneHash 를 그대로 노출하지 않는다', () => {
    expect(merchantPayerRef('merchant-a', ph)).not.toBe(ph);
  });

  it('입력이 비면 빈 문자열을 돌려준다', () => {
    expect(merchantPayerRef('', ph)).toBe('');
    expect(merchantPayerRef('merchant-a', '')).toBe('');
  });
});

describe('EMMA 수신번호 복원', () => {
  /**
   * 사업자가 mo_recipient / emo_recipient 를 어디서 끊어 담는지는 통신망 등록 방식에 달려 있다.
   * 세 경우(A/B/C)와, emo 에 전체번호를 통째로 넣어 주는 변형까지 같은 결과여야 한다.
   */
  it('세 가지 분할 방식이 모두 같은 번호로 복원된다', () => {
    expect(restoreMoNumber('16881234', '5678')).toBe('168812345678');
    expect(restoreMoNumber('1688', '12345678')).toBe('168812345678');
    expect(restoreMoNumber('168812345678', null)).toBe('168812345678');
  });

  it('emo 에 전체번호가 들어온 변형에서 대표번호가 두 번 반복되지 않는다', () => {
    expect(restoreMoNumber('16881234', '168812345678')).toBe('168812345678');
  });

  it('대표번호와 서브번호로 나눈다', () => {
    expect(splitMoNumber('168812345678')).toEqual({ base: '16881234', sub: '5678' });
    expect(splitMoNumber('5678')).toEqual({ base: '5678', sub: '' });
  });

  it('050 안심번호 표기를 유지한다 (현재 전용번호 체계)', () => {
    expect(formatMoNumber('05051001001')).toBe('0505-100-1001');
  });

  it('오입력이 몰리는 서브번호는 배정하지 않는다', () => {
    expect(isUsableSubCode('1234')).toBe(false);
    expect(isUsableSubCode('0000')).toBe(false);
    expect(isUsableSubCode('3947')).toBe(true);
    expect(isUsableSubCode('39')).toBe(false);
  });
});
