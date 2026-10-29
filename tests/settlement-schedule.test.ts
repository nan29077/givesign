import { describe, it, expect } from 'vitest';
import {
  settlementDateFor,
  addBusinessDays,
  isBusinessDay,
  isValidDateKey,
  toDateKey,
  formatDateKeyKo,
} from '@/lib/business-day';

/**
 * 정산 주기: 결제일 다음날부터 영업일 5일째가 정산일.
 * 구영님이 제시한 실제 운영 규칙을 그대로 검증한다.
 */

// 2026년 공휴일 (마이그레이션 시드와 동일)
const H2026 = new Set([
  '2026-01-01',
  '2026-02-16', '2026-02-17', '2026-02-18',
  '2026-03-01', '2026-03-02',
  '2026-05-01', '2026-05-05', '2026-05-24', '2026-05-25',
  '2026-06-03', '2026-06-06',
  '2026-08-15', '2026-08-17',
  '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-28',
  '2026-10-03', '2026-10-05', '2026-10-09',
  '2026-12-25',
]);

describe('정산일 계산 — 지시하신 규칙 그대로', () => {
  it('2026-08-03(월) 결제 → 2026-08-10(월) 정산', () => {
    // 4·5·6·7 = 4영업일, 8(토)·9(일) 건너뜀, 10(월) = 5영업일
    expect(settlementDateFor('2026-08-03', H2026)).toBe('2026-08-10');
  });

  it('금·토·일 결제은 모두 다음 주 금요일로 모인다', () => {
    expect(settlementDateFor('2026-08-07', H2026)).toBe('2026-08-14'); // 금
    expect(settlementDateFor('2026-08-08', H2026)).toBe('2026-08-14'); // 토
    expect(settlementDateFor('2026-08-09', H2026)).toBe('2026-08-14'); // 일
  });

  it('정산일은 반드시 영업일이다 (1년 전수 확인)', () => {
    let cur = '2026-01-01';
    for (let i = 0; i < 365; i += 1) {
      const s = settlementDateFor(cur, H2026);
      expect(isBusinessDay(s, H2026)).toBe(true);
      expect(s > cur).toBe(true);
      const [y, m, d] = cur.split('-').map(Number);
      cur = toDateKey(new Date(Date.UTC(y, m - 1, d + 1) - 9 * 3600_000));
    }
  });

  it('공휴일이 끼면 그만큼 밀린다', () => {
    // 광복절(8/15 토) + 대체공휴일(8/17 월) 이 낀 주
    // 8/12(수) 결제 → 13(목)1, 14(금)2, 15·16 주말, 17 대체공휴일 건너뜀,
    //                 18(화)3, 19(수)4, 20(목)5
    expect(settlementDateFor('2026-08-12', H2026)).toBe('2026-08-20');
  });

  it('설 연휴처럼 긴 휴일도 정확히 건너뛴다', () => {
    // 2026-02-13(금) 결제 → 16·17·18 설 연휴 건너뜀
    //   19(목)1, 20(금)2, 23(월)3, 24(화)4, 25(수)5
    expect(settlementDateFor('2026-02-13', H2026)).toBe('2026-02-25');
  });

  it('근로자의 날(5/1)은 은행이 쉬므로 영업일에서 빠진다', () => {
    expect(isBusinessDay('2026-05-01', H2026)).toBe(false);
    // 4/28(화) 결제 → 29(수)1, 30(목)2, 5/1 제외, 5/4(월)3, 5/5 어린이날 제외,
    //                 5/6(수)4, 5/7(목)5
    expect(settlementDateFor('2026-04-28', H2026)).toBe('2026-05-07');
  });

  it('공휴일 표가 비어 있으면 주말만 제외한다 (미등록 연도 안전 동작)', () => {
    const none = new Set<string>();
    expect(settlementDateFor('2026-08-03', none)).toBe('2026-08-10');
    expect(isBusinessDay('2026-08-15', none)).toBe(false); // 토요일
  });

  it('영업일 0일이면 결제일 그대로가 아니라 다음날 이후를 세지 않는다', () => {
    expect(addBusinessDays('2026-08-03', 0, H2026)).toBe('2026-08-03');
  });
});

describe('날짜 유틸', () => {
  it('달력에 없는 날짜를 걸러낸다', () => {
    expect(isValidDateKey('2026-02-28')).toBe(true);
    expect(isValidDateKey('2026-02-31')).toBe(false);
    expect(isValidDateKey('2026-13-01')).toBe(false);
    expect(isValidDateKey('20260201')).toBe(false);
  });

  it('한국어 표기', () => {
    expect(formatDateKeyKo('2026-08-10')).toBe('8월 10일 (월)');
    expect(formatDateKeyKo('2026-08-14', false)).toBe('8월 14일');
  });

  it('서버 타임존과 무관하게 같은 날짜 키가 나온다', () => {
    // KST 2026-08-04 00:30 = UTC 2026-08-03 15:30
    expect(toDateKey(new Date('2026-08-03T15:30:00Z'))).toBe('2026-08-04');
    // KST 2026-08-03 23:59 = UTC 2026-08-03 14:59
    expect(toDateKey(new Date('2026-08-03T14:59:00Z'))).toBe('2026-08-03');
  });
});
