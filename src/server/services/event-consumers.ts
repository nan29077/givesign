import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { formatWon } from '@/lib/money';
import { registerConsumer, emitDomainEvent, type StoredDomainEvent } from './events';
import { notifyUser } from './notifications';
import { campaignStats } from './fundraising';
import { registerJourneyEngine } from './journeys/engine';
import { registerReceiptBatchHandler } from './receipt-batch';
import { handleDocumentSigned } from './issued-documents';
import { chargeDonorLabel } from './charge-events';
import { registerRecurringRecoveryConsumer } from './recurring-recovery';
import { registerMarketingConsentConsumer } from './marketing-consent';
import { registerOfflineDepositConsumers } from './deposits';

/**
 * 기본 이벤트 소비자 (1단계).
 *
 *  - merchant-alert   : 후원·봉사 신청·목표 달성 → 기관 담당자 인앱 알림
 *  - supporter-link   : 첫 후원·봉사 신청 → 기관 명단(supporter_contact) 행을 같은 번호의 후원자에 연결
 *  - campaign-goal    : 후원 → 캠페인 모금액이 목표에 처음 닿으면 goal_reached_at 기록 + campaign.goal_reached
 *  - purpose-document-sign : 전자문서 봉투 완료·종료(document.signed / document.closed) → 발급 문서·약정서 상태 반영
 *
 * 저니(3단계)는 journey 소비자로 따로 등록된다. 이 파일은 /api/cron/events 가 import 한다.
 */

async function merchantUserId(merchantId: string): Promise<string | null> {
  const m = await prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { userId: true } });
  return m?.userId ?? null;
}

function num(v: unknown): bigint {
  try {
    return BigInt(String(v ?? '0'));
  } catch {
    return 0n;
  }
}

/** 같은 기관에 짧은 시간 안에 후원 알림이 몰리면 한 시간 단위로 묶는다(알림함이 후원 목록이 되지 않게). */
const ALERT_HOURLY_CAP = 20;

export async function handleMerchantAlert(ev: StoredDomainEvent) {
  const userId = await merchantUserId(ev.merchantId);
  if (!userId) return 'SKIPPED' as const;

  if (ev.type === 'charge.paid') {
    if (ev.payload.isTest === true) return 'SKIPPED' as const;
    const since = new Date(Date.now() - 3_600_000);
    const recent = await prisma.notification.count({ where: { userId, title: { startsWith: '새 후원' }, createdAt: { gte: since } } });
    if (recent >= ALERT_HOURLY_CAP) return 'SKIPPED' as const;
    const amount = num(ev.payload.amount);
    const campaign = typeof ev.payload.campaignTitle === 'string' ? ` · ${ev.payload.campaignTitle}` : '';
    const channel = ev.payload.channel === 'RECURRING' ? '정기후원' : ev.payload.channel === 'WEB' ? '웹 후원' : '문자 후원';
    // 이름은 payload 가 아니라 결제 건에서 읽는다. 익명 후원은 콘솔 목록과 같이 "익명의 후원자"(점검 A-M5).
    const charge = await prisma.charge.findUnique({ where: { id: ev.subjectId }, select: { anonymous: true, displayName: true } });
    const label = charge ? chargeDonorLabel(charge) : '후원자';
    await notifyUser({
      userId,
      title: `새 후원 ${formatWon(amount)}`,
      body: `${channel}${campaign} — ${label === '익명의 후원자' ? label : `${label}님`}`,
      linkUrl: '/studio/charges',
    });
    return;
  }
  if (ev.type === 'volunteer.applied') {
    await notifyUser({ userId, title: '새 자원봉사 신청', body: '승인 대기함에서 확인해 주세요.', linkUrl: '/studio/inbox' });
    return;
  }
  if (ev.type === 'campaign.goal_reached') {
    await notifyUser({
      userId,
      title: '캠페인 목표 달성',
      body: `${String(ev.payload.title ?? '캠페인')} 모금액이 목표 ${formatWon(num(ev.payload.goalAmount))}에 닿았습니다.`,
      linkUrl: `/studio/campaigns/${ev.subjectId}`,
    });
    return;
  }
  if (ev.type === 'recurring.pledged') {
    await notifyUser({
      userId,
      title: '새 정기후원 약정',
      body: `매월 ${formatWon(num(ev.payload.amount))} 약정이 등록되었습니다.`,
      linkUrl: '/studio/recurring',
    });
    return;
  }
  if (ev.type === 'receipt.batch_ready') {
    await notifyUser({
      userId,
      title: `${String(ev.payload.taxYear ?? '')}년 기부금영수증 발급 준비`,
      body: `발급할 수 있는 후원자 ${String(ev.payload.readyCount ?? 0)}명 — 승인 대기함에서 확인 후 발급해 주세요.`,
      linkUrl: '/studio/inbox',
    });
    return;
  }
  if (ev.type === 'agreement.signed') {
    await notifyUser({ userId, title: '전자서명 완료', body: `${String(ev.payload.title ?? '약정서')} 서명이 완료되었습니다.`, linkUrl: '/studio/agreements' });
    return;
  }
  return 'SKIPPED' as const;
}

/**
 * 기관 명단 사후 연결. 명단 업로드 때는 아직 후원자가 아니었던 번호가 나중에 후원하면
 * 명단 행(supporter_contact.payer_id)이 비어 있어 같은 사람이 두 줄로 보였다.
 */
export async function handleSupporterLink(ev: StoredDomainEvent) {
  if (!ev.payerId) return 'SKIPPED' as const;
  const payer = await prisma.payerProfile.findUnique({ where: { id: ev.payerId }, select: { phoneHash: true } });
  if (!payer) return 'SKIPPED' as const;
  const r = await prisma.supporterContact.updateMany({
    where: { merchantId: ev.merchantId, phoneHash: payer.phoneHash, payerId: null },
    data: { payerId: ev.payerId },
  });
  return r.count > 0 ? undefined : ('SKIPPED' as const);
}

/** 목표 달성. goal_reached_at 이 비어 있을 때만 조건부로 채우므로 동시 후원이 겹쳐도 이벤트는 한 번이다. */
export async function handleCampaignGoal(ev: StoredDomainEvent) {
  const campaignId = typeof ev.payload.campaignId === 'string' ? ev.payload.campaignId : null;
  if (!campaignId) return 'SKIPPED' as const;
  const c = await prisma.campaign.findFirst({
    where: { id: campaignId, merchantId: ev.merchantId },
    select: { id: true, title: true, goalAmount: true, goalReachedAt: true },
  });
  if (!c || c.goalReachedAt || c.goalAmount <= 0n) return 'SKIPPED' as const;
  const stats = (await campaignStats([c.id])).get(c.id)!;
  if (stats.raised < c.goalAmount) return 'SKIPPED' as const;

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const r = await tx.campaign.updateMany({ where: { id: c.id, goalReachedAt: null }, data: { goalReachedAt: now } });
    if (r.count === 0) return;
    await emitDomainEvent(
      {
        merchantId: ev.merchantId,
        type: 'campaign.goal_reached',
        subjectType: 'campaign',
        subjectId: c.id,
        payload: { title: c.title, goalAmount: c.goalAmount, raised: stats.raised, donorCount: stats.donorCount },
      },
      tx,
    );
  });
}

let registered = false;
export function registerDefaultConsumers() {
  if (registered) return;
  registered = true;
  registerConsumer({
    name: 'merchant-alert',
    types: ['charge.paid', 'volunteer.applied', 'campaign.goal_reached', 'recurring.pledged', 'receipt.batch_ready', 'agreement.signed'],
    handle: handleMerchantAlert,
  });
  registerConsumer({ name: 'supporter-link', types: ['charge.paid', 'volunteer.applied', 'recurring.pledged'], handle: handleSupporterLink });
  registerConsumer({ name: 'campaign-goal', types: ['charge.paid'], handle: handleCampaignGoal });
  // 저니(자동 안내 흐름) — 3단계
  registerJourneyEngine();
  registerReceiptBatchHandler();
  // 2단계: 전자문서 봉투 완료 → 용도별 발급 문서·내부 전자서명 약정서 반영(완료 지점에서 이미 반영했으면 바뀌지 않는다)
  // 거절·만료·취소(document.closed)도 같은 반영 — 완료 지점의 바로 반영이 실패해도 재시도된다(점검 A-M7).
  registerConsumer({ name: 'purpose-document-sign', types: ['document.signed', 'document.closed'], handle: handleDocumentSigned });
  // 2026-11-09: 결제수단 새로 등록 → 조치 필요 정기후원 바로 재시도 / 결제 성공 → 후원 화면에서 체크한 (선택) 소식 수신 동의 반영
  registerRecurringRecoveryConsumer();
  registerMarketingConsentConsumer();
  // 2026-11-09 E: 계좌이체 후원 확정 → 기관 알림(여러 건이면 묶음 1건)
  registerOfflineDepositConsumers();
  logger.debug?.('기본 이벤트 소비자 등록');
}
