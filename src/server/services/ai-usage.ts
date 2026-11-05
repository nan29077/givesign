import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { llmCostKrw, type LlmUsage } from '@/server/adapters/llm';
import { kstMonthKey } from '@/lib/datetime';
import { monthRange } from './monthly-notice';

/**
 * LLM 비용 기록(ai_usage). 콘텐츠 대본·AI 초안이 같은 표에 기능별로 쌓는다.
 * 실패한 시도도 공급자가 과금하므로 ok=false 로 남긴다. 기록 실패가 업무를 막지 않는다.
 */

export type AiFeature = 'content_script' | 'campaign_draft' | 'thanks_draft' | 'inquiry_draft' | 'content_insight';

export const AI_FEATURE_LABEL: Record<AiFeature, string> = {
  content_script: '콘텐츠 대본',
  campaign_draft: '캠페인 초안',
  thanks_draft: '감사 문구 초안',
  inquiry_draft: '문의 답변 초안',
  content_insight: '콘텐츠 성과 요약',
};

export async function recordAiUsage(input: {
  merchantId: string | null;
  feature: AiFeature;
  provider: string;
  model: string;
  usage: LlmUsage;
  ok: boolean;
}) {
  if (input.provider === 'mock') return 0;
  const costKrw = llmCostKrw(input.usage);
  await prisma.aiUsage
    .create({
      data: {
        id: newId(),
        merchantId: input.merchantId,
        feature: input.feature,
        provider: input.provider,
        model: input.model || '-',
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        costKrw,
        ok: input.ok,
      },
    })
    .catch((e) => logger.error('AI 사용량 기록 실패', { feature: input.feature, message: (e as Error).message }));
  return costKrw;
}

/** 이번 달(KST) 비용 합계. merchantId 를 주면 그 기관만. */
export async function aiUsageThisMonth(merchantId?: string, now = new Date()) {
  const { start, end } = monthRange(kstMonthKey(now));
  const rows = await prisma.aiUsage.groupBy({
    by: ['feature'],
    where: { createdAt: { gte: start, lt: end }, ...(merchantId ? { merchantId } : {}) },
    _sum: { costKrw: true, inputTokens: true, outputTokens: true },
    _count: { _all: true },
  });
  const total = rows.reduce((a, r) => a + (r._sum.costKrw ?? 0), 0);
  return { total, rows };
}
