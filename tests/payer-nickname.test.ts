import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import {
  defaultPayerName,
  payerDisplayName,
  isDefaultPayerName,
  displayPayerName,
  checkPayerName,
  normalizePayerName,
  PAYER_NAME_MAX,
} from '@/lib/payer-name';
import { validatePayerName } from '@/server/services/payer-name';

/**
 * 후원자 표시 이름.
 *  - 설정 전에는 번호 끝 4자리로 만든 기본 이름(후원자5678)을 쓴다.
 *  - 설정하면 그 이름이 결제 시점에 박제된다(나중에 바꿔도 과거 내역은 그대로).
 */

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => inboundAndPay(p, fx.merchantId);

describe('후원 내역에 실제로 남는 이름', () => {
  it('자동 생성된 기본 이름은 끝 4자리로만 불린다', () => {
    // "후원자5678님이 3,000원을 결제하셨습니다" 는 읽을 때 어색하다.
    expect(displayPayerName('후원자5678')).toBe('5678');
  });

  it('직접 정한 닉네임은 그대로 부른다', () => {
    expect(displayPayerName('밤톨이')).toBe('밤톨이');
    // 숫자로만 된 닉네임이라도 사용자가 정한 것이면 손대지 않는다.
    expect(displayPayerName('9호실')).toBe('9호실');
  });

  it('번호가 남아 있는 예전 데이터도 끝 4자리로 줄인다', () => {
    expect(displayPayerName('010-****-5678')).toBe('5678');
    expect(displayPayerName('01012345678')).toBe('5678');
  });

  it('끝 4자리를 못 얻으면 원래 값을 그대로 둔다', () => {
    expect(displayPayerName('후원자')).toBe('후원자');
    expect(displayPayerName('')).toBe('');
  });

  it('닉네임 설정 화면 미리보기와 실제 송출이 같은 규칙을 쓴다', () => {
    // 규칙이 서버에만 있으면 화면에서 약속한 이름과 실제 기록이 어긋난다.
    // (실제로 그랬다 — 화면은 "후원자5678", 기록은 "5678")
    const saved = defaultPayerName('010-1234-5678');
    expect(displayPayerName(saved)).toBe('5678');
  });
});

describe('기본 닉네임 (번호 끝 4자리)', () => {
  it('번호에서 끝 4자리를 뽑아 후원자5678 형태로 만든다', () => {
    expect(defaultPayerName('010-1234-5678')).toBe('후원자5678');
    expect(defaultPayerName('01012345678')).toBe('후원자5678');
    expect(defaultPayerName('+821012345678')).toBe('후원자5678');
  });

  it('마스킹된 번호에서도 끝 4자리를 그대로 뽑는다', () => {
    // 웹 결제 경로는 phoneMasked(010-****-5678) 만 들고 있다
    expect(defaultPayerName('010-****-5678')).toBe('후원자5678');
  });

  it('번호가 너무 짧으면 접두사만 돌려준다', () => {
    expect(defaultPayerName('123')).toBe('후원자');
    expect(defaultPayerName('')).toBe('후원자');
  });

  it('닉네임이 있으면 닉네임을, 없으면 기본 이름을 쓴다', () => {
    expect(payerDisplayName('밤톨이', '010-1234-5678')).toBe('밤톨이');
    expect(payerDisplayName(null, '010-1234-5678')).toBe('후원자5678');
    expect(payerDisplayName('   ', '010-1234-5678')).toBe('후원자5678');
  });

  it('자동 생성된 이름인지 구분한다', () => {
    expect(isDefaultPayerName('후원자5678')).toBe(true);
    expect(isDefaultPayerName('후원자')).toBe(true);
    expect(isDefaultPayerName('밤톨이')).toBe(false);
    expect(isDefaultPayerName('후원자밤톨')).toBe(false);
  });
});

describe('닉네임 형식 검사 (2~10자)', () => {
  it('빈 값은 "설정하지 않음"이라 통과시킨다', () => {
    expect(checkPayerName('').ok).toBe(true);
    expect(checkPayerName('   ').value).toBe('');
  });

  it('2자 미만은 거절한다', () => {
    const r = checkPayerName('밤');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('2자 이상');
  });

  it(`${PAYER_NAME_MAX}자까지 허용하고 초과하면 거절한다`, () => {
    expect(checkPayerName('가'.repeat(PAYER_NAME_MAX)).ok).toBe(true);
    const over = checkPayerName('가'.repeat(PAYER_NAME_MAX + 1));
    expect(over.ok).toBe(false);
    expect(over.message).toContain(`${PAYER_NAME_MAX}자 이내`);
  });

  it('이모지는 코드포인트 기준으로 길이를 센다', () => {
    // 서로게이트 페어를 2자로 세면 5자짜리가 10자로 잡혀 억울하게 거절된다
    expect(checkPayerName('😀😀😀😀😀').ok).toBe(true);
  });

  it('링크와 연락처처럼 보이는 숫자는 막는다', () => {
    expect(checkPayerName('http://a.io').ok).toBe(false);
    expect(checkPayerName('www.aa.io').ok).toBe(false);
    expect(checkPayerName('01012345').ok).toBe(false);
  });

  it('보이지 않는 문자로 길이 제한을 우회할 수 없다', () => {
    const sneaky = `밤톨이${'​'.repeat(30)}`;
    expect(normalizePayerName(sneaky)).toBe('밤톨이');
    expect(checkPayerName(sneaky).ok).toBe(true);
  });

  it('연속 공백은 하나로 줄이고 앞뒤 공백은 없앤다', () => {
    expect(checkPayerName('  밤   톨이 ').value).toBe('밤 톨이');
  });
});

describe('닉네임 금칙어 (서버 검증)', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('전역 금칙어가 들어간 닉네임은 거절한다', async () => {
    await prisma.bannedWord.create({
      data: { id: newId(), scope: 'GLOBAL', word: '비속어', action: 'BLOCK', active: true },
    });
    const r = await validatePayerName('비속어짱');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('사용할 수 없는 단어');
  });

  it('글자 사이에 기호를 끼운 우회도 잡는다', async () => {
    await prisma.bannedWord.create({
      data: { id: newId(), scope: 'GLOBAL', word: '비속어', action: 'MASK', active: true },
    });
    expect((await validatePayerName('비.속.어')).ok).toBe(false);
  });

  it('FLAG(기록만) 금칙어는 거절 사유로 쓰지 않는다', async () => {
    await prisma.bannedWord.create({
      data: { id: newId(), scope: 'GLOBAL', word: '관찰어', action: 'FLAG', active: true },
    });
    expect((await validatePayerName('관찰어짱')).ok).toBe(true);
  });

  it('사회복지기관 개인 금칙어는 닉네임에 적용하지 않는다', async () => {
    // 닉네임은 특정 채널 소유가 아니므로 전역 기준만 본다
    await prisma.bannedWord.create({
      data: { id: newId(), scope: 'MERCHANT', merchantId: fx.merchantId, word: '경쟁사', action: 'BLOCK', active: true },
    });
    expect((await validatePayerName('경쟁사팬')).ok).toBe(true);
  });

  it('멀쩡한 닉네임은 정리된 값을 그대로 돌려준다', async () => {
    const r = await validatePayerName('  밤톨이  ');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('밤톨이');
  });
});

describe('결제 표시 이름 반영', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
    await seedRegisteredPayer(fx.payerPhone);
  });

  it('닉네임이 없으면 결제에 기본 이름이 박힌다', async () => {
    await prisma.payerProfile.updateMany({ data: { displayName: null } });
    await inbound(moPayload({ to: fx.moNumber, text: '응원합니다' }));

    const charge = await prisma.charge.findFirstOrThrow();
    expect(charge.displayName).toBe(defaultPayerName(fx.payerPhone));
    // 번호 앞자리가 노출되지 않아야 한다
    expect(charge.displayName).not.toContain('010');
  });

  it('닉네임을 정하면 그 이름이 결제에 박힌다', async () => {
    await prisma.payerProfile.updateMany({ data: { displayName: '밤톨이' } });
    await inbound(moPayload({ to: fx.moNumber, text: '응원합니다' }));

    const charge = await prisma.charge.findFirstOrThrow();
    expect(charge.displayName).toBe('밤톨이');
  });

  it('닉네임을 바꿔도 과거 후원 내역은 그대로 남는다 (스냅샷)', async () => {
    await prisma.payerProfile.updateMany({ data: { displayName: '밤톨이' } });
    await inbound(moPayload({ to: fx.moNumber, text: '첫 결제' }));

    await prisma.payerProfile.updateMany({ data: { displayName: '겨울밤' } });
    await inbound(moPayload({ to: fx.moNumber, text: '두 번째 결제' }));

    const rows = await prisma.charge.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.length).toBe(2);
    expect(rows[0].displayName).toBe('밤톨이');
    expect(rows[1].displayName).toBe('겨울밤');
  });

  it('감사 문자에도 닉네임이 쓰인다', async () => {
    await prisma.payerProfile.updateMany({ data: { displayName: '밤톨이' } });
    await inbound(moPayload({ to: fx.moNumber, text: '응원합니다' }));

    const mt = await prisma.mtOutboundMessage.findFirst({
      where: { templateCode: 'CHARGE_SUCCESS' },
      orderBy: { createdAt: 'desc' },
    });
    expect(mt?.bodyMasked).toContain('밤톨이');
  });
});
