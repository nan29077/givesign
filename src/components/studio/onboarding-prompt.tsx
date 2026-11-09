import Link from 'next/link';
import { ChevronRight, Rocket } from 'lucide-react';
import { Card } from '@/components/ui';
import { onboardingChecklist } from '@/server/services/onboarding';
import { logger } from '@/lib/logger';

/**
 * 대시보드 맨 위 "도입 체크리스트" 안내 (2026-11-12 4차 I2). 다 끝났거나 숨기면 보이지 않는다.
 * 불러오지 못해도 대시보드는 그대로 그린다.
 */
export async function OnboardingPrompt({ merchantId }: { merchantId: string }) {
  const list = await onboardingChecklist(merchantId).catch((e) => {
    logger.warn('도입 체크리스트 불러오기 실패', { message: (e as Error).message });
    return null;
  });
  if (!list || !list.showPrompt) return null;
  const next = list.steps.find((s) => !s.done && !s.skipped);
  return (
    <Card className="border-brand-200 bg-brand-50/60">
      <Link href="/studio/start" className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-start gap-3">
          <Rocket size={20} strokeWidth={1.7} className="mt-0.5 shrink-0 text-brand-700" />
          <span className="min-w-0">
            <span className="block text-[14px] font-extrabold text-ink-900">도입 체크리스트 {list.doneCount}/{list.total}</span>
            <span className="mt-0.5 block text-[12.5px] text-ink-500">{next ? `다음 할 일: ${next.label}` : '마무리만 남았습니다.'}</span>
          </span>
        </span>
        <ChevronRight size={18} strokeWidth={1.7} className="shrink-0 text-ink-400" />
      </Link>
    </Card>
  );
}
