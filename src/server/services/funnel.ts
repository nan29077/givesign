import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { isBotUserAgent } from './content-clicks';

/**
 * 문자·웹 후원 단계 기록 (2026-11-09 B1 — 측정만, 안내 발송 없음).
 *
 * 규칙
 *  - (흐름, 단계) 유니크로 **처음 도달만** 남긴다. 같은 링크를 여러 번 열어도 한 번이다.
 *    흐름 키: MO 수신 건 `mo:{수신 id}` (그 문자로 만든 결제 건도 같은 흐름) · 웹 후원 `charge:{결제 id}`.
 *  - 기록 실패가 결제 흐름을 막지 않는다. 모든 함수가 예외를 삼키고 로그만 남긴다(호출부는 한 줄 호출만).
 *  - 개인정보 원문을 남기지 않는다(전화·이름·문자 본문 없음). 기관·캠페인·유입 경로·채널·이유 분류만.
 *  - 정기후원 출금 건(channel RECURRING)·테스트 결제는 세지 않는다(후원자가 거치는 단계가 없다).
 *  - 링크 미리보기 수집기(카카오·네이버 등)는 `/go` 클릭 집계와 같은 봇 판정(isBotUserAgent)으로 뺀다.
 *  - 이 기능 전의 결제 건은 거꾸로 채우지 않는다. 집계는 "측정 시작 이후" 만이다(funnel-report.ts).
 */

export const FUNNEL_STEPS = ['MO_RECEIVED', 'REPLY_SENT', 'LINK_OPENED', 'AMOUNT_SELECTED', 'AUTH_STARTED', 'PAID'] as const;
export const FUNNEL_END_STEPS = ['FAILED', 'BLOCKED'] as const;
export type FunnelStepName = (typeof FUNNEL_STEPS)[number] | (typeof FUNNEL_END_STEPS)[number];

/** 끝 상태 이유 분류 */
export const FUNNEL_REASONS = ['LIMIT', 'UNREGISTERED', 'PAYMENT_FAILED', 'CONTENT_BLOCKED', 'EXPIRED'] as const;
export type FunnelReason = (typeof FUNNEL_REASONS)[number];

export type FunnelChannel = 'MO' | 'WEB' | 'QR';

export interface FunnelStepInput {
  step: FunnelStepName;
  /** 결제 건. 있으면 기관·캠페인·유입·채널·흐름 키를 결제 건에서 읽는다. */
  chargeId?: string | null;
  /** 결제 건이 아직 없는 MO 단계(수신·미등록·속도 제한)에서만 */
  moMessageId?: string | null;
  merchantId?: string | null;
  reason?: FunnelReason | null;
  at?: Date;
}

interface FlowContext {
  flowKey: string;
  merchantId: string;
  channel: FunnelChannel;
  campaignId: string | null;
  source: string | null;
  moMessageId: string | null;
  chargeId: string | null;
  promoId?: string | null;
}

function channelOf(charge: { channel: string; moMessageId: string | null; source: string | null }): FunnelChannel | null {
  if (charge.channel === 'RECURRING') return null;
  if (charge.moMessageId || charge.channel === 'MO') return 'MO';
  return charge.source === 'QR' ? 'QR' : 'WEB';
}

async function resolveContext(input: FunnelStepInput): Promise<FlowContext | null> {
  if (input.chargeId) {
    const c = await prisma.charge.findUnique({
      where: { id: input.chargeId },
      select: { id: true, merchantId: true, moMessageId: true, channel: true, campaignId: true, source: true, isTest: true, recurringId: true, promoId: true },
    });
    if (!c || c.isTest || c.recurringId) return null;
    const channel = channelOf(c);
    if (!channel) return null;
    return {
      flowKey: c.moMessageId ? `mo:${c.moMessageId}` : `charge:${c.id}`,
      merchantId: c.merchantId,
      channel,
      campaignId: c.campaignId,
      source: c.source,
      moMessageId: c.moMessageId,
      chargeId: c.id,
      promoId: c.promoId,
    };
  }
  if (input.moMessageId && input.merchantId) {
    return { flowKey: `mo:${input.moMessageId}`, merchantId: input.merchantId, channel: 'MO', campaignId: null, source: 'SMS', moMessageId: input.moMessageId, chargeId: null };
  }
  return null;
}

/**
 * 단계 기록(안전 래퍼). 처음 도달이면 true, 이미 있거나 대상이 아니거나 실패하면 false. 예외를 던지지 않는다.
 */
export async function recordFunnelStep(input: FunnelStepInput): Promise<boolean> {
  try {
    const ctx = await resolveContext(input);
    if (!ctx) return false;
    const created = await prisma.funnelStep.createMany({
      data: [
        {
          id: newId(),
          flowKey: ctx.flowKey,
          step: input.step,
          merchantId: ctx.merchantId,
          channel: ctx.channel,
          campaignId: ctx.campaignId,
          source: ctx.source,
          moMessageId: ctx.moMessageId,
          chargeId: ctx.chargeId,
          promoId: ctx.promoId ?? null,
          reason: input.reason ?? null,
          occurredAt: input.at ?? new Date(),
        },
      ],
      skipDuplicates: true,
    });
    // 캠페인은 금액 선택 화면에서 바뀔 수 있다. 결제 건 단계마다 흐름 전체의 캠페인·결제 건을 지금 값으로 맞춘다
    // (캠페인별 집계가 흐름 단위로 일관되게). 흐름당 행은 8개 이하다.
    if (ctx.chargeId) {
      await prisma.funnelStep.updateMany({ where: { flowKey: ctx.flowKey }, data: { campaignId: ctx.campaignId, chargeId: ctx.chargeId, promoId: ctx.promoId ?? null } });
    }
    return created.count > 0;
  } catch (e) {
    logger.warn('후원 단계 기록 실패 — 결제 흐름은 계속합니다', { step: input.step, message: (e as Error).message });
    return false;
  }
}

/** 결제 상태 → 끝 상태 이유. 시간 초과·만료는 EXPIRED, 그 외 결제 실패는 PAYMENT_FAILED. */
export function failureReasonOf(status: string, reason: string | null | undefined): { step: 'FAILED' | 'BLOCKED'; reason: FunnelReason } | null {
  if (status === 'LIMIT_BLOCKED') return { step: 'BLOCKED', reason: 'LIMIT' };
  if (status === 'UNREGISTERED') return { step: 'BLOCKED', reason: 'UNREGISTERED' };
  if (status === 'CONTENT_BLOCKED') return { step: 'BLOCKED', reason: 'CONTENT_BLOCKED' };
  if (status === 'PAYMENT_FAILED') {
    return { step: 'FAILED', reason: /시간 초과|만료|시간이 지나/.test(reason ?? '') ? 'EXPIRED' : 'PAYMENT_FAILED' };
  }
  return null;
}

/**
 * 결제 상태 전이에서 단계 기록(charge-flow setStatus 등 공용 한 줄 호출). 인증 시작·끝 상태만 남긴다.
 * 예외를 던지지 않는다.
 */
export async function recordChargeStatusStep(chargeId: string, status: string, reason?: string | null): Promise<void> {
  if (status === 'PENDING_PIN') {
    await recordFunnelStep({ step: 'AUTH_STARTED', chargeId });
    return;
  }
  const end = failureReasonOf(status, reason);
  if (end) await recordFunnelStep({ step: end.step, chargeId, reason: end.reason });
}

/** 확인 링크(금액 선택 화면) 열람. 봇·미리보기 수집기는 세지 않는다. */
export async function recordFunnelLinkOpened(chargeId: string, userAgent: string | null | undefined): Promise<boolean> {
  try {
    if (isBotUserAgent(userAgent)) return false;
  } catch {
    return false;
  }
  return recordFunnelStep({ step: 'LINK_OPENED', chargeId });
}
