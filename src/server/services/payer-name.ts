import { prisma } from '@/server/db';
import { containsBannedWord } from '@/server/services/content-filter';
import { checkPayerName, type PayerNameCheck } from '@/lib/payer-name';

/**
 * 후원자 닉네임 저장 전 검증 (서버 전용).
 *
 * 닉네임은 사회복지기관 화면과 후원 내역에 그대로 노출되므로
 * 결제 메시지와 같은 금칙어 기준을 적용한다.
 *
 * 메시지 필터(filterContent)와 달리 여기서는 마스킹하지 않고 **거절**한다.
 * 닉네임은 한 번 정하면 계속 쓰이는 값이라, 별표로 가려진 이름이 남는 것보다
 * 다시 입력하게 하는 편이 낫다.
 */

/** 전역 금칙어(사회복지기관별 금칙어는 적용하지 않는다 — 닉네임은 특정 채널 소유가 아니다) */
async function loadGlobalBannedWords(): Promise<string[]> {
  const rows = await prisma.bannedWord.findMany({
    where: { active: true, scope: 'GLOBAL' },
    select: { word: true, action: true },
  });
  // FLAG(기록만)는 거절 사유로 쓰지 않는다.
  return rows.filter((r) => r.action !== 'FLAG').map((r) => r.word);
}

/**
 * 형식 + 금칙어까지 확인한다.
 * 빈 값은 "설정하지 않음"이므로 통과시키고 value 를 빈 문자열로 돌려준다.
 */
export async function validatePayerName(raw: string): Promise<PayerNameCheck> {
  const basic = checkPayerName(raw);
  if (!basic.ok || basic.value.length === 0) return basic;

  const words = await loadGlobalBannedWords();
  for (const word of words) {
    if (!word.trim()) continue;
    if (containsBannedWord(basic.value, word)) {
      return { ok: false, value: basic.value, message: '닉네임에 사용할 수 없는 단어가 포함되어 있습니다.' };
    }
  }
  return basic;
}
