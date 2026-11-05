import { newId } from '../src/lib/id';
import { SEED_TERMS, TERMS_VERSION, TERMS_EFFECTIVE_FROM } from './terms-content';
import type { PrismaClient } from '../src/generated/prisma/client';

/**
 * 기준 데이터 시드 — 운영에서도 반드시 있어야 하는 것.
 *
 *  - 필수 SystemSetting (결제 모드 기본값·확인 링크 유효시간·기본 금액·서비스명)
 *  - 현행 약관(TERMS_VERSION)
 *  - 전역 한도 정책·전역 수수료 정책 (없을 때만)
 *  - 전역 금칙어 (없을 때만)
 *
 * 공휴일은 마이그레이션(20260821140000_public_holiday)이 넣으므로 여기서 다루지 않는다.
 *
 * `overwrite=false`(운영)이면 이미 있는 행은 건드리지 않는다 — 관리자가 화면에서 바꾼 값·약관 문안을
 * 배포가 덮어쓰면 안 된다. 로컬·스테이징은 기존처럼 문안·설정을 최신으로 맞춘다.
 */
export async function seedBaseData(prisma: PrismaClient, { overwrite }: { overwrite: boolean }) {
  const created: string[] = [];

  const settings: Array<[string, unknown, string]> = [
    ['payment.mode', 'CONFIRM_LINK', '전역 기본 결제 모드. DIRECT_TRIGGER 는 금융사 서면승인 후에만 허용'],
    ['payment.confirmTtlSec', 300, '결제 확인 링크 유효시간(초). 헥토 10분 제한보다 짧게 유지'],
    ['charge.defaultAmount', 3000, '문자 1건당 기본 결제 금액'],
    ['service.name', '기브싸인', '서비스명'],
  ];
  for (const [key, value, memo] of settings) {
    const exists = await prisma.systemSetting.findUnique({ where: { key }, select: { key: true } });
    if (!exists) {
      await prisma.systemSetting.create({ data: { key, value: value as object, memo } });
      created.push(`setting:${key}`);
    } else if (overwrite) {
      await prisma.systemSetting.update({ where: { key }, data: { value: value as object, memo } });
    }
  }

  // 약관 본문은 prisma/terms-content.ts 에 둔다.
  for (const t of SEED_TERMS) {
    const where = { type_version: { type: t.type, version: TERMS_VERSION } };
    const exists = await prisma.termsVersion.findUnique({ where, select: { id: true } });
    if (!exists) {
      await prisma.termsVersion.create({
        data: {
          id: newId(),
          type: t.type,
          version: TERMS_VERSION,
          title: t.title,
          content: t.content,
          required: t.required,
          effectiveFrom: TERMS_EFFECTIVE_FROM,
        },
      });
      created.push(`terms:${t.type}@${TERMS_VERSION}`);
    } else if (overwrite) {
      // 로컬은 시드를 다시 돌리면 문안이 최신으로 맞춰진다.
      await prisma.termsVersion.update({ where, data: { title: t.title, content: t.content, required: t.required } });
    }
    // 이전 버전은 그대로 둔다. 현행본은 시행일 기준으로 고르고(terms.ts),
    // 이전 버전에 걸린 동의 기록이 남아 있어야 재동의(staleRequiredConsents)가 동작한다.
  }

  if (!(await prisma.chargeLimitPolicy.findFirst({ where: { scope: 'GLOBAL' }, select: { id: true } }))) {
    await prisma.chargeLimitPolicy.create({ data: { id: newId(), scope: 'GLOBAL' } });
    created.push('policy:limit:GLOBAL');
  }
  if (!(await prisma.feePolicy.findFirst({ where: { scope: 'GLOBAL' }, select: { id: true } }))) {
    await prisma.feePolicy.create({
      data: { id: newId(), scope: 'GLOBAL', pgFeeRate: '0.018', platformFeeRate: '0.15', smsCost: 20 },
    });
    created.push('policy:fee:GLOBAL');
  }

  const words: Array<[string, 'BLOCK' | 'MASK']> = [
    ['도박', 'BLOCK'], ['불법', 'BLOCK'], ['사기', 'MASK'],
    ['씨발', 'MASK'], ['개새끼', 'MASK'], ['죽여', 'BLOCK'],
  ];
  for (const [word, action] of words) {
    const exists = await prisma.bannedWord.findFirst({ where: { word, merchantId: null }, select: { id: true } });
    if (!exists) {
      await prisma.bannedWord.create({ data: { id: newId(), word, action, scope: 'GLOBAL' } });
      created.push(`banned:${word}`);
    }
  }

  return { created };
}
