'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 서버에서 준비 중인 일이 있는 동안 화면을 주기적으로 다시 불러온다(예: 숏폼 영상 재조립 — 2026-11-12).
 * active 가 false 가 되면(서버가 다시 그린 결과) 멈춘다. 최대 횟수를 넘기면 더 부르지 않는다.
 */
export function RefreshWhile({ active, intervalMs = 5000, maxTimes = 60 }: { active: boolean; intervalMs?: number; maxTimes?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      if (n > maxTimes || document.hidden) {
        if (n > maxTimes) clearInterval(t);
        return;
      }
      router.refresh();
    }, intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, maxTimes, router]);
  return null;
}
