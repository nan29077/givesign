import { prisma } from '@/server/db';
import { PAID_STATUSES } from '@/components/studio/shared';
import { automationReadiness, type ReadinessItem } from './inbox';

/**
 * 준비도 → 작동 점검 (2026-11-12 4차 I2-5).
 *
 * 자동화 준비도(automationReadiness — "설정됨")에 "작동 확인됨"(마지막으로 실제로 돌아간 시각)을 붙인다.
 * 원천 기록만 본다(따로 체크를 저장하지 않음):
 *  - MO 수신→회신 성공: 단계 측정 `funnel_step` REPLY_SENT(문자 흐름)
 *  - 결제 성공: 시험이 아닌 결제 건 PAID — 결제 거래 공급자가 mock 이면 "mock" 표시
 *  - 알림톡 전달 성공: `mt_outbound_message` channel=ALIMTALK · SENT
 *  - SNS 연결 토큰 유효: 실연동(mock 아님) CONNECTED 채널, 만료 시각이 지나지 않음
 *  - 전자문서 발송 성공: 서명 요청 봉투(취소·실패 제외) 또는 발급 문서 안내 발송
 * 도입 시험(onboarding_test_run)은 시뮬레이션이라 "작동 확인" 으로 치지 않고 "마지막 시험" 으로 따로 보인다.
 */

export interface OperationCheck {
  key: 'MO_REPLY' | 'PAYMENT' | 'ALIMTALK' | 'SOCIAL' | 'EDOC';
  /** 붙일 준비도 항목 키 */
  itemKey: string;
  label: string;
  /** 실제로 확인된 마지막 시각(없으면 null) */
  verifiedAt: Date | null;
  /** mock 공급자 결과라 실제 작동은 아님 */
  mock: boolean;
  note: string | null;
}

export interface LastTestSummary {
  at: Date;
  simulated: boolean;
  moOk: boolean;
  paymentOk: boolean;
  documentOk: boolean;
}

export async function operationChecks(merchantId: string, now = new Date()): Promise<OperationCheck[]> {
  const [reply, paidTx, alim, social, envelope, issued] = await Promise.all([
    prisma.funnelStep.findFirst({ where: { merchantId, step: 'REPLY_SENT', channel: 'MO' }, orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } }),
    prisma.paymentTransaction.findFirst({
      where: { status: 'APPROVED', charge: { merchantId, isTest: false, status: { in: PAID_STATUSES } } },
      orderBy: { approvedAt: 'desc' },
      select: { approvedAt: true, updatedAt: true, provider: true },
    }),
    prisma.mtOutboundMessage.findFirst({ where: { merchantId, channel: 'ALIMTALK', status: 'SENT' }, orderBy: { createdAt: 'desc' }, select: { sentAt: true, createdAt: true, providerCode: true } }),
    prisma.socialChannel.findMany({ where: { merchantId, status: 'CONNECTED' }, select: { platform: true, mock: true, expiresAt: true, refreshTokenEnc: true, refreshExpiresAt: true, updatedAt: true } }),
    prisma.eDocEnvelope.findFirst({ where: { merchantId, status: { notIn: ['CANCELLED'] } }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
    prisma.issuedDocument.findFirst({ where: { merchantId, sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
  ]);
  const live = social.filter((c) => !c.mock);
  const valid = live.filter((c) => {
    const until = c.refreshTokenEnc ? c.refreshExpiresAt : c.expiresAt;
    return !until || until.getTime() > now.getTime();
  });
  const edocAt = [envelope?.sentAt ?? null, issued?.sentAt ?? null].filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const payMock = paidTx ? paidTx.provider.toLowerCase() === 'mock' : false;
  const alimMock = alim ? (alim.providerCode ?? '').toLowerCase() === 'mock' : false;
  return [
    { key: 'MO_REPLY', itemKey: 'mo', label: 'MO 수신 → 회신 문자', verifiedAt: reply?.occurredAt ?? null, mock: false, note: reply ? null : '아직 실제 문자 수신·회신 기록이 없습니다.' },
    { key: 'PAYMENT', itemKey: 'mo', label: '결제 성공', verifiedAt: paidTx ? (paidTx.approvedAt ?? paidTx.updatedAt) : null, mock: payMock, note: payMock ? 'mock 결제사 결과 — 실제 출금이 아닙니다.' : paidTx ? null : '아직 결제 성공 기록이 없습니다.' },
    { key: 'ALIMTALK', itemKey: 'alimtalk', label: '알림톡 전달', verifiedAt: alim ? (alim.sentAt ?? alim.createdAt) : null, mock: alimMock, note: alimMock ? 'mock 공급자 결과 — 실제 전달이 아닙니다.' : alim ? null : '아직 알림톡 전달 성공 기록이 없습니다.' },
    {
      key: 'SOCIAL',
      itemKey: 'social',
      label: 'SNS 연결 토큰 유효',
      verifiedAt: valid.length ? now : null,
      mock: live.length === 0 && social.length > 0,
      note: social.length === 0 ? '연결된 채널이 없습니다.' : live.length === 0 ? 'mock 연결만 있습니다(실제 게시 불가).' : valid.length === live.length ? null : `${live.length - valid.length}개 채널 토큰이 만료됐습니다. 다시 연결해 주세요.`,
    },
    { key: 'EDOC', itemKey: 'edoc', label: '전자문서 발송', verifiedAt: edocAt, mock: false, note: edocAt ? null : '아직 전자문서를 보낸 기록이 없습니다.' },
  ];
}

export async function lastOnboardingTest(merchantId: string): Promise<LastTestSummary | null> {
  const r = await prisma.onboardingTestRun.findFirst({ where: { merchantId }, orderBy: { createdAt: 'desc' } });
  return r ? { at: r.createdAt, simulated: r.simulated, moOk: r.moOk, paymentOk: r.paymentOk, documentOk: r.documentOk } : null;
}

export type ReadinessWithChecks = ReadinessItem & { checks: OperationCheck[]; verified: boolean };

/** 준비도 + 작동 점검. verified = 설정됨이고 붙은 점검이 모두 실제(mock 아님)로 확인됨 */
export async function readinessWithChecks(merchantId: string, now = new Date()) {
  const [readiness, checks, lastTest] = await Promise.all([automationReadiness(merchantId), operationChecks(merchantId, now), lastOnboardingTest(merchantId)]);
  const items: ReadinessWithChecks[] = readiness.items.map((i) => {
    const mine = checks.filter((c) => c.itemKey === i.key);
    return { ...i, checks: mine, verified: i.ok && mine.length > 0 && mine.every((c) => c.verifiedAt && !c.mock) };
  });
  return { ...readiness, items, lastTest };
}
