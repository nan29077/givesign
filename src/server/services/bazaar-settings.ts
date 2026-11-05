import { notFound } from 'next/navigation';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { normalizeConfig, type BazaarConfig } from '@/lib/bazaar';

/**
 * 라이브 바자회 활성화 스위치와 운영 설정.
 *
 * 스위치는 system_setting 'live_bazaar.enabled' 하나다. 기본값은 꺼짐.
 * 꺼지면 바자회 관련 화면·메뉴·메인 섹션·공개 페이지·서버 액션이 모두 사라진다(404).
 * 예외(대표 결정 2026-11-05):
 *  - 확정된 기관 정산은 계속 지급한다(관리자 사이트 설정 화면의 "미지급 현물 판매 정산" 링크).
 *  - 발급된 현물 기부금영수증은 기관 기부금영수증 메뉴·홈택스 명세에 계속 포함한다.
 *
 * 여러 화면이 한 요청에서 여러 번 묻기 때문에 1초 동안 메모리에 둔다. 바꾸는 쪽은 즉시 무효화한다(라우트 묶음마다 모듈이 따로라 다른 화면은 최대 1초 늦을 수 있다).
 * (서버가 여러 대여도 최대 1초 늦게 반영된다)
 */

export const BAZAAR_ENABLED_KEY = 'live_bazaar.enabled';
export const BAZAAR_CONFIG_KEY = 'live_bazaar.config';
const TTL_MS = 1000;

let enabledCache: { value: boolean; at: number } | null = null;

export function invalidateBazaarCache() {
  enabledCache = null;
}

export async function isLiveBazaarEnabled(): Promise<boolean> {
  if (enabledCache && Date.now() - enabledCache.at < TTL_MS) return enabledCache.value;
  let value = false;
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: BAZAAR_ENABLED_KEY } });
    const v = row?.value as unknown;
    value = v === true || (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true);
  } catch {
    // DB 오류 시에는 닫는다(숨김이 안전한 쪽).
    value = false;
  }
  enabledCache = { value, at: Date.now() };
  return value;
}

export async function setLiveBazaarEnabled(enabled: boolean, adminUserId: string) {
  await prisma.systemSetting.upsert({
    where: { key: BAZAAR_ENABLED_KEY },
    create: { key: BAZAAR_ENABLED_KEY, value: { enabled } as Prisma.InputJsonValue, updatedBy: adminUserId, memo: '라이브 바자회 사용' },
    update: { value: { enabled } as Prisma.InputJsonValue, updatedBy: adminUserId },
  });
  invalidateBazaarCache();
}

export async function getBazaarConfig(): Promise<BazaarConfig> {
  const row = await prisma.systemSetting.findUnique({ where: { key: BAZAAR_CONFIG_KEY } }).catch(() => null);
  return normalizeConfig(row?.value);
}

export async function saveBazaarConfig(config: BazaarConfig, adminUserId: string) {
  const value = normalizeConfig(config);
  await prisma.systemSetting.upsert({
    where: { key: BAZAAR_CONFIG_KEY },
    create: { key: BAZAAR_CONFIG_KEY, value: value as unknown as Prisma.InputJsonValue, updatedBy: adminUserId, memo: '라이브 바자회 운영 설정' },
    update: { value: value as unknown as Prisma.InputJsonValue, updatedBy: adminUserId },
  });
  return value;
}

/** 화면(서버 컴포넌트) 가드: 꺼져 있으면 일반 404. 404 화면에는 바자회 문구가 없다. */
export async function bazaarPageGuard(): Promise<void> {
  if (!(await isLiveBazaarEnabled())) notFound();
}

export class BazaarDisabledError extends Error {
  constructor() {
    super('현재 이용할 수 없는 기능입니다.');
  }
}

/** 서버 액션·API 가드 */
export async function assertBazaarEnabled(): Promise<void> {
  if (!(await isLiveBazaarEnabled())) throw new BazaarDisabledError();
}
