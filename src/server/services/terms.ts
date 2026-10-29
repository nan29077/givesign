import { prisma } from '@/server/db';
import type { ConsentType } from '@/generated/prisma/enums';

/**
 * 약관 버전 조회.
 *
 * `active` 는 "폐기하지 않았다" 는 뜻이고, **지금 적용 중인지는 시행일(effectiveFrom)로 판단한다.**
 *
 * 예전에는 새 버전을 등록할 때 같은 유형의 기존 버전을 곧바로 active=false 로 내렸다.
 * 그래서 시행일을 미래로 잡아 개정안을 미리 등록하면 그 순간 현행 약관이
 * 공개 약관 페이지와 결제 링크의 필수 동의 목록에서 통째로 사라졌다
 * (= 전자금융거래 약관을 게시하지 않은 상태로 결제가 계속 처리됨).
 *
 * 이제는 기존 버전을 그대로 두고, 시행일이 지난 것 중 가장 최신 1건을 현행으로 본다.
 * 새 버전의 시행일이 되면 자동으로 그 버전이 현행이 된다.
 */

/** 한 유형의 현재 시행본 1건(본문 포함). 없으면 null. */
export async function currentTermsDoc(type: ConsentType, now: Date = new Date()) {
  return prisma.termsVersion.findFirst({
    where: { type, active: true, effectiveFrom: { lte: now } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });
}

/**
 * 유형별 현재 시행본 목록.
 * 같은 유형에 여러 버전이 살아 있어도 유형당 1건만 남긴다.
 */
/**
 * 가입(결제수단 등록) 화면이 아니라 각자의 흐름에서 따로 받는 동의.
 * 기부금영수증 정보 수집은 영수증 신청 때, 정기후원 자동 출금은 약정 때 받는다.
 * 가입 화면에 섞어 두면 아직 신청하지도 않은 일에 대한 동의를 받게 된다.
 */
export const CONTEXTUAL_CONSENT_TYPES: ConsentType[] = ['RECEIPT_ISSUANCE', 'RECURRING_DEBIT'];

export async function currentTermsList(now: Date = new Date()) {
  const rows = await prisma.termsVersion.findMany({
    where: { active: true, effectiveFrom: { lte: now }, type: { notIn: CONTEXTUAL_CONSENT_TYPES } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });
  const latest = new Map<ConsentType, (typeof rows)[number]>();
  for (const r of rows) {
    if (!latest.has(r.type)) latest.set(r.type, r);
  }
  return [...latest.values()];
}
