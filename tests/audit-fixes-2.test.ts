import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import { bannedNeedle, containsBannedWord, filterContent } from '@/server/services/content-filter';
import { scrubText } from '@/lib/logger';
import { computeFees } from '@/server/services/settlement';
import { reconcileUnknownPayment } from '@/server/services/payment-reconcile';
import { kstDateKey } from '@/lib/datetime';

/**
 * 2026-08-28 전체 검수에서 확인된 결함들의 회귀 테스트.
 * 각 테스트는 "고치기 전이었다면 실패했을" 조건을 검사한다.
 */

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => inboundAndPay(p, fx.merchantId);

// ───────────────────── 1. 금칙어 정규식 폭주(ReDoS) ─────────────────────

describe('금칙어 판정은 항상 선형 시간이다', () => {
  it('구분자 문자로만 이뤄진 긴 금칙어도 즉시 끝난다', () => {
    // 예전 구현은 금칙어 글자 사이에 [\s._\-*~=+/]* 를 끼운 정규식을 만들었다.
    // 금칙어 자체가 그 문자로 이뤄지면 역추적이 지수적으로 폭발해,
    // 아래 조합에서 판정 한 번이 2분을 넘겼다(그동안 프로세스 전체가 멈춘다).
    const rules = [{ word: '.'.repeat(40), action: 'BLOCK' as const }];
    const message = '.'.repeat(60);

    const started = Date.now();
    filterContent(message, { bannedWords: rules });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('하이픈·밑줄로만 이뤄진 금칙어도 마찬가지다', () => {
    const rules = [
      { word: '-'.repeat(40), action: 'MASK' as const },
      { word: '_'.repeat(35), action: 'BLOCK' as const },
    ];
    const started = Date.now();
    filterContent('-'.repeat(80), { bannedWords: rules });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('비교에서 무시하는 문자만으로 된 단어는 금칙어로 쓰이지 않는다', () => {
    expect(bannedNeedle('......')).toBe('');
    expect(bannedNeedle('   ')).toBe('');
    // 규칙으로 넣어도 아무 문장에도 걸리지 않는다(모든 문장을 차단해 버리는 사고 방지).
    const r = filterContent('평범한 응원 메시지', { bannedWords: [{ word: '...', action: 'BLOCK' }] });
    expect(r.action).toBe('ALLOW');
  });
});

// ───────────────────── 2. 보이지 않는 문자 우회 ─────────────────────

describe('금칙어 우회 차단', () => {
  it('한글 채움 문자를 끼워 넣어도 잡는다', () => {
    // U+3164 는 화면에서 빈칸처럼 보이지만 공백이 아니라, 예전 필터를 그대로 통과했다.
    expect(containsBannedWord(`욕${'ㅤ'}설`, '욕설')).toBe(true);
    expect(containsBannedWord(`욕${'​'}설`, '욕설')).toBe(true);
  });

  it('전각 문자로 써도 잡는다', () => {
    expect(containsBannedWord('ｂａｄｗｏｒｄ 입니다', 'badword')).toBe(true);
  });

  it('기존 우회 차단과 오탐 방지는 그대로다', () => {
    expect(containsBannedWord('바 보', '바보')).toBe(true);
    expect(containsBannedWord('바.보', '바보')).toBe(true);
    // 사이에 다른 글자가 끼면 매칭하지 않는다.
    expect(containsBannedWord('노트북 출력', '노출')).toBe(false);
    // 정규식 특수문자는 글자 그대로 본다.
    expect(containsBannedWord('안전한 문장', 'a.c')).toBe(false);
  });

  it('마스킹은 우회에 쓰인 기호까지 함께 가린다', () => {
    const r = filterContent('바 보 최고', { bannedWords: [{ word: '바보', action: 'MASK' }] });
    expect(r.action).toBe('MASK');
    expect(r.clean).not.toContain('바 보');
    expect(r.clean).toContain('최고');
  });
});

// ───────────────────── 3. 로그에 남는 일회용 링크 ─────────────────────

describe('로그 마스킹', () => {
  it('메시지에 담긴 링크는 경로까지 가려진다', () => {
    // 예전에는 meta 만 걸러서, 비밀번호 재설정 링크를 메시지에 끼워 넣은 곳에서
    // 토큰 원문이 모든 환경의 로그에 그대로 남았다.
    const line = scrubText('[MOCK 메일] 비밀번호 재설정 링크: https://givesign.kr/reset-password/AbCdEf123456');
    expect(line).not.toContain('AbCdEf123456');
    expect(line).not.toContain('/reset-password/');
    expect(line).toContain('https://givesign.kr');
  });

  it('메시지에 담긴 전화번호도 가려진다', () => {
    expect(scrubText('수신 010-1234-5678 처리 완료')).not.toContain('1234-5678');
  });
});

// ───────────────────── 4. 수수료가 결제 금액을 넘는 경우 ─────────────────────

describe('수수료 계산은 결제 금액을 넘지 않는다', () => {
  it('요율을 잘못 넣어도 화면 금액과 원장이 어긋나지 않는다', () => {
    // 0.095 를 0.95 로 잘못 찍은 상황. 예전에는 net 만 0 으로 보정하고
    // pgFee·platformFee 는 보정 전 값이 그대로 원장에 들어가 잔액이 음수가 됐다.
    const fees = computeFees(3000n, {
      pgFeeRate: '0.03',
      platformFeeRate: '0.95',
      pgFixedFee: 0n,
      vatIncluded: false,
    });

    expect(fees.net).toBe(0n);
    // 원장 3분개의 합이 정확히 0 이어야 한다.
    expect(fees.gross - fees.pgFee - fees.platformFee).toBe(fees.net);
    expect(fees.pgFee + fees.platformFee).toBeLessThanOrEqual(fees.gross);
  });

  it('정상 요율에서는 기존 계산이 그대로다', () => {
    const fees = computeFees(3000n, {
      pgFeeRate: '0',
      platformFeeRate: '0.1',
      pgFixedFee: 0n,
      vatIncluded: false,
    });
    // 공급가액 300 + 부가세 30 = 330 차감
    expect(fees.platformFee).toBe(330n);
    expect(fees.net).toBe(2670n);
  });
});

// ───────────────────── 5. 서버 TTS 는 발행된 문장만 읽는다 ─────────────────────

// ───────────────────── 6. 수동 대사 이중 처리 ─────────────────────

describe('결과 미확인 결제의 수동 대사', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
    await seedRegisteredPayer(fx.payerPhone);
  });

  it('동시에 두 번 취소해도 한도 집계는 한 번만 되돌린다', async () => {
    await inbound(moPayload({ to: fx.moNumber, text: '대사 테스트' }));

    const charge = await prisma.charge.findFirstOrThrow();
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { chargeId: charge.id } });

    // 결과 미확인 상태를 만든다.
    await prisma.paymentTransaction.update({ where: { id: txn.id }, data: { status: 'UNKNOWN' } });
    await prisma.charge.update({ where: { id: charge.id }, data: { status: 'PENDING_PAYMENT' } });

    const key = {
      payerId_merchantId_periodType_periodKey: {
        payerId: charge.payerId!,
        merchantId: 'ALL',
        periodType: 'DAY',
        periodKey: kstDateKey(txn.requestedAt),
      },
    };
    const before = await prisma.chargeCounter.findUniqueOrThrow({ where: key });

    // 관리자 두 명이 같은 건을 동시에 취소로 확정한 상황.
    const results = await Promise.allSettled([
      reconcileUnknownPayment(txn.id, 'CANCEL', '동시 처리 1'),
      reconcileUnknownPayment(txn.id, 'CANCEL', '동시 처리 2'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);

    // 되돌림이 두 번 돌면 집계가 실제보다 더 깎여, 그만큼 한도를 넘겨 결제할 수 있게 된다.
    const after = await prisma.chargeCounter.findUniqueOrThrow({ where: key });
    expect(after.count).toBe(before.count - 1);
    expect(after.amount).toBe(before.amount - charge.amount);
  });

  it('이미 확정된 건은 다시 확정할 수 없다', async () => {
    await inbound(moPayload({ to: fx.moNumber, text: '대사 테스트' }));
    const charge = await prisma.charge.findFirstOrThrow();
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { chargeId: charge.id } });

    await prisma.paymentTransaction.update({ where: { id: txn.id }, data: { status: 'UNKNOWN' } });
    await prisma.charge.update({ where: { id: charge.id }, data: { status: 'PENDING_PAYMENT' } });

    await reconcileUnknownPayment(txn.id, 'CANCEL', '첫 처리');
    await expect(reconcileUnknownPayment(txn.id, 'CANCEL', '두 번째 처리')).rejects.toThrow();
  });
});
