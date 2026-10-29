'use server';

import { prisma } from '@/server/db';
import { normalizeMerchantCode } from '@/lib/id';
import { consumeIpRateLimit } from '@/server/rate-limit';

/**
 * 사회복지기관 검색 / 코드 조회.
 * - 코드(GIV-XXXX)뿐 아니라 사회복지기관 이름·서비스명으로도 검색할 수 있다.
 * - 무차별 탐색을 막기 위해 IP 단위 요청 제한을 유지하고, 결과는 최대 8건까지만 반환한다.
 * - 승인(APPROVED)된 사회복지기관만 노출한다.
 */

const WINDOW_SEC = 60;
const MAX_TRIES = 20;

export interface MerchantSearchItem {
  code: string;
  userId: string;
  displayName: string;
  channelName: string | null;
  avatarUrl: string | null;
  avatarIndex: number;
}

const merchantSearchSelect = {
  code: true,
  userId: true,
  displayName: true,
  channelName: true,
  avatarUrl: true,
  user: { select: { avatarIndex: true } },
} as const;

function toSearchItem(merchant: {
  code: string;
  userId: string;
  displayName: string;
  channelName: string | null;
  avatarUrl: string | null;
  user: { avatarIndex: number };
}): MerchantSearchItem {
  return {
    code: merchant.code,
    userId: merchant.userId,
    displayName: merchant.displayName,
    channelName: merchant.channelName,
    avatarUrl: merchant.avatarUrl,
    avatarIndex: merchant.user.avatarIndex,
  };
}

export interface LookupResult {
  ok: boolean;
  /** 검색 결과. 1명이더라도 자동 이동하지 않고 선택 목록으로 반환한다. */
  matches?: MerchantSearchItem[];
  message?: string;
}

export async function lookupMerchantCode(input: string): Promise<LookupResult> {
  // consumeRateLimit 은 저장소 장애 시 예외를 흡수한다.
  // kv.incr 를 직접 부르면 Redis 순단에 사회복지기관 검색 자체가 실패한다.
  const limited = await consumeIpRateLimit('merchant-lookup', MAX_TRIES, WINDOW_SEC);
  if (!limited.ok) {
    return { ok: false, message: '조회 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' };
  }

  const raw = String(input ?? '').trim();
  if (raw.length < 2) {
    return { ok: false, message: '사회복지기관 코드 또는 이름을 2자 이상 입력해 주세요.' };
  }

  // 1) 코드 형태면 코드 우선 조회
  const code = normalizeMerchantCode(raw);
  if (/^GIV-[A-Z0-9]{4,8}$/.test(code)) {
    const byCode = await prisma.merchantProfile.findFirst({
      where: { code, status: 'APPROVED' },
      select: merchantSearchSelect,
    });
    if (byCode) return { ok: true, matches: [toSearchItem(byCode)] };
    // 코드 형태인데 없으면 이름 검색으로 넘어가지 않고 바로 안내한다 (오타 가능성)
    return {
      ok: false,
      message: '해당 코드의 사회복지기관을 찾을 수 없습니다. 코드를 다시 확인하거나 이름으로 검색해 보세요.',
    };
  }

  // 2) 이름 · 채널명 검색
  const matches = await prisma.merchantProfile.findMany({
    where: {
      status: 'APPROVED',
      OR: [
        { displayName: { contains: raw, mode: 'insensitive' } },
        { channelName: { contains: raw, mode: 'insensitive' } },
      ],
    },
    orderBy: { displayName: 'asc' },
    take: 8,
    select: merchantSearchSelect,
  });

  if (matches.length === 0) {
    return {
      ok: false,
      message: '검색 결과가 없습니다. 사회복지기관 코드(예: GIV-8K2M) 또는 정확한 채널명·이름으로 다시 검색해 주세요.',
    };
  }
  return { ok: true, matches: matches.map(toSearchItem) };
}
