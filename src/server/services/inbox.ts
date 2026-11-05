import { cache } from 'react';
import { prisma } from '@/server/db';
import { env, featureContentEnabled, featureVolunteerEnabled } from '@/lib/env';
import { doneeVerified, issuerReadiness } from './receipts';
import { walletOverview } from './edoc-billing';
import { APPROVAL_KIND_LABEL, type ApprovalKind } from './approvals';
import { getStudioPendingCounts } from './studio-pending';

/**
 * 통합 승인 대기함 + 자동화 준비도.
 *
 * "AI 가 준비하고 사람은 승인만" 하려면 사람이 볼 곳이 한 곳이어야 한다.
 *  - 승인할 일(actions): 승인 요청(approval_request — 저니 승인 단계·영수증 일괄 발급 …),
 *    콘텐츠 검토, 자원봉사 신청, 제출된 문서 확인, 신고.
 *    원천 테이블을 복사하지 않고 그 자리에서 모은다(상태가 둘로 갈라지지 않게).
 *  - 기다리는 일(waiting): 후원자 차례인 전자서명·약정 미완료, 관리자 차례인 환불 요청.
 *  - 막힌 일(blocked): 자동 안내 실패, 게시 실패, 준비도에서 빠진 항목.
 */

export interface InboxItem {
  key: string;
  kind: string;
  kindLabel: string;
  title: string;
  summary?: string | null;
  at: Date;
  href: string;
  /** 대기함 안에서 바로 승인·반려할 수 있는 승인 요청 id */
  approvalId?: string;
  error?: string | null;
}

export async function inboxItems(merchantId: string) {
  const [approvals, contents, volunteers, documents, reports, envelopes, refunds, failedRuns, failedPublishes] = await Promise.all([
    prisma.approvalRequest.findMany({
      where: { merchantId, status: 'PENDING', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'asc' },
      take: 200,
    }),
    featureContentEnabled()
      ? prisma.contentItem.findMany({ where: { merchantId, status: 'REVIEW' }, orderBy: { createdAt: 'asc' }, take: 50, select: { id: true, title: true, kind: true, createdAt: true, error: true } })
      : Promise.resolve([]),
    featureVolunteerEnabled()
      ? prisma.volunteerApplication.findMany({ where: { merchantId, status: 'RECEIVED' }, orderBy: { createdAt: 'asc' }, take: 50, select: { id: true, createdAt: true, wish: true, payer: { select: { displayName: true, phoneMasked: true } } } })
      : Promise.resolve([]),
    prisma.documentSubmission.findMany({ where: { merchantId, status: 'SUBMITTED' }, orderBy: { updatedAt: 'asc' }, take: 50, select: { id: true, updatedAt: true, template: { select: { name: true } } } }),
    prisma.report.findMany({ where: { merchantId, status: 'OPEN' }, orderBy: { createdAt: 'asc' }, take: 50, select: { id: true, createdAt: true } }),
    prisma.eDocEnvelope.findMany({ where: { merchantId, status: { in: ['SENT', 'IN_PROGRESS'] } }, orderBy: { createdAt: 'asc' }, take: 50, select: { id: true, title: true, createdAt: true, expiresAt: true } }),
    prisma.refund.findMany({ where: { charge: { merchantId }, status: { in: ['REQUESTED', 'APPROVED'] } }, orderBy: { requestedAt: 'asc' }, take: 50, select: { id: true, requestedAt: true, status: true, amount: true } }),
    prisma.journeyRun.findMany({ where: { merchantId, status: 'FAILED', finishedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } }, orderBy: { finishedAt: 'desc' }, take: 30, select: { id: true, journeyKey: true, lastError: true, finishedAt: true } }),
    prisma.contentPublish.findMany({ where: { item: { merchantId }, status: 'FAILED', updatedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } }, orderBy: { updatedAt: 'desc' }, take: 30, select: { id: true, itemId: true, platform: true, error: true, updatedAt: true, item: { select: { title: true } } } }),
  ]);

  const actions: InboxItem[] = [
    ...approvals.map((a) => ({
      key: `approval:${a.id}`,
      kind: a.kind,
      kindLabel: APPROVAL_KIND_LABEL[a.kind as ApprovalKind] ?? '승인 요청',
      title: a.title,
      summary: a.summary,
      at: a.createdAt,
      href: a.kind === 'RECEIPT_BATCH' ? '/studio/receipts' : '/studio/journeys',
      approvalId: a.id,
      error: a.error,
    })),
    ...contents.map((c) => ({
      key: `content:${c.id}`, kind: 'CONTENT_REVIEW', kindLabel: '콘텐츠 검토', title: c.title || '새 콘텐츠', summary: c.error, at: c.createdAt, href: `/studio/content/${c.id}`,
    })),
    ...volunteers.map((v) => ({
      key: `volunteer:${v.id}`, kind: 'VOLUNTEER_APPLICATION', kindLabel: '자원봉사 신청', title: `${v.payer.displayName ?? '신청자'} ${v.payer.phoneMasked}`, summary: v.wish, at: v.createdAt, href: '/studio/volunteers',
    })),
    ...documents.map((d) => ({
      key: `document:${d.id}`, kind: 'DOCUMENT_SUBMITTED', kindLabel: '제출 문서 확인', title: d.template?.name ?? '제출 문서', at: d.updatedAt, href: `/studio/documents/submissions/${d.id}`,
    })),
    ...reports.map((r) => ({ key: `report:${r.id}`, kind: 'REPORT', kindLabel: '신고', title: '처리할 신고', at: r.createdAt, href: '/studio/reports' })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const waiting: InboxItem[] = [
    ...envelopes.map((e) => ({
      key: `edoc:${e.id}`, kind: 'EDOC_SIGNING', kindLabel: '서명 대기(후원자 차례)', title: e.title, summary: e.expiresAt ? `기한 ${e.expiresAt.toISOString().slice(0, 10)}` : null, at: e.createdAt, href: `/studio/e-documents/${e.id}`,
    })),
    ...refunds.map((r) => ({
      key: `refund:${r.id}`, kind: 'REFUND', kindLabel: r.status === 'REQUESTED' ? '환불 요청(관리자 확인 중)' : '환불 승인(처리 중)', title: `환불 ${r.amount.toString()}원`, at: r.requestedAt, href: '/studio/charges',
    })),
  ];

  const blocked: InboxItem[] = [
    ...failedRuns.map((r) => ({ key: `run:${r.id}`, kind: 'JOURNEY_FAILED', kindLabel: '자동 안내 실패', title: r.journeyKey, summary: r.lastError, at: r.finishedAt ?? new Date(), href: '/studio/journeys' })),
    ...failedPublishes.map((p) => ({ key: `publish:${p.id}`, kind: 'PUBLISH_FAILED', kindLabel: 'SNS 게시 실패', title: `${p.item.title} · ${p.platform}`, summary: p.error, at: p.updatedAt, href: `/studio/content/${p.itemId}` })),
  ];

  return { actions, waiting, blocked };
}

/** 사이드바 배지용 — 승인할 일 건수(가벼운 count 만). 요청 단위 캐시. */
export const inboxActionCount = cache(async (merchantId: string) => {
  const [approvals, contents, volunteers, pending] = await Promise.all([
    prisma.approvalRequest.count({ where: { merchantId, status: 'PENDING', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }),
    featureContentEnabled() ? prisma.contentItem.count({ where: { merchantId, status: 'REVIEW' } }) : Promise.resolve(0),
    featureVolunteerEnabled() ? prisma.volunteerApplication.count({ where: { merchantId, status: 'RECEIVED' } }) : Promise.resolve(0),
    getStudioPendingCounts(merchantId),
  ]);
  return approvals + contents + volunteers + pending.documents + pending.reports;
});

// ---------------------------------------------------------------------------
// 자동화 준비도
// ---------------------------------------------------------------------------

export interface ReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  /** 빠지면 자동화가 멈추는 필수 항목(아니면 권장) */
  required: boolean;
  /** 빠졌을 때 무엇이 안 되는지 */
  impact: string;
  href: string;
}

export async function automationReadiness(merchantId: string): Promise<{ items: ReadinessItem[]; requiredMissing: number; recommendedMissing: number }> {
  const [m, mo, account, alimtalk, social, volunteerTerms, wallet, purposeTemplates] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({
      where: { id: merchantId },
      select: {
        fundraisingRegNo: true, thanksMtMessage: true, businessNo: true, representativeName: true, address: true,
        designatedDonee: true, designatedDoneeVerifiedAt: true, designatedDoneeUntil: true, receiptCycle: true,
      },
    }),
    prisma.merchantMoNumber.findFirst({ where: { merchantId, status: 'ASSIGNED' }, select: { id: true } }),
    prisma.settlementAccount.findUnique({ where: { merchantId }, select: { verified: true } }),
    prisma.merchantAlimtalkChannel.findUnique({ where: { merchantId }, select: { status: true } }),
    prisma.socialChannel.count({ where: { merchantId, status: 'CONNECTED' } }),
    prisma.termsVersion.count({ where: { type: 'VOLUNTEER_PRIVACY', effectiveFrom: { lte: new Date() } } }),
    walletOverview(merchantId).catch(() => null),
    countPurposeTemplates(merchantId),
  ]);
  const receiptOk = issuerReadiness(m).ok;
  const items: ReadinessItem[] = [
    { key: 'mo', label: '후원 문자 수신번호(MO) 배정', ok: Boolean(mo), required: true, impact: '문자 후원·예약어(정기·봉사) 회신이 동작하지 않습니다.', href: '/support' },
    { key: 'account', label: '정산 계좌 인증', ok: account?.verified ?? false, required: true, impact: '후원금 자동 정산(지급)이 멈춥니다.', href: '/studio/settlement' },
    { key: 'regNo', label: '기부금품 모집등록번호', ok: Boolean(m.fundraisingRegNo), required: featureContentEnabled(), impact: '콘텐츠 승인·자동 생성(캘린더)·자동 승인이 막힙니다.', href: '/studio/profile' },
    { key: 'donee', label: '공익법인 지정 — 관리자 확인', ok: doneeVerified(m), required: true, impact: '기부금영수증 발급·연간 영수증 준비·영수증 정보 안내가 멈춥니다.', href: '/studio/profile' },
    { key: 'issuer', label: '영수증 발급 기관 정보(고유번호·대표자·소재지)', ok: receiptOk, required: true, impact: '기부금영수증을 발급할 수 없습니다.', href: '/studio/profile' },
    { key: 'templates', label: '자동 발송 서식(감사장·확인서·약정서)', ok: purposeTemplates.ok, required: false, impact: purposeTemplates.ok ? '' : '기관 서식이 없으면 기브싸인 기본 서식으로 보냅니다. 기관 이름·직인이 들어간 서식으로 바꾸기를 권합니다.', href: '/studio/documents' },
    { key: 'edoc', label: '전자문서 이용 잔액(서명이 필요한 약정서·신청서)', ok: (wallet?.sendable ?? 0) > 0, required: false, impact: '서명이 필요한 문서는 잔액이 생길 때까지 보류됩니다(동의 기록 약정서는 그대로 남습니다).', href: '/studio/document-billing' },
    { key: 'alimtalk', label: '카카오 알림톡 채널(관리자 확인)', ok: env.automation.alimtalkEnabled && alimtalk?.status === 'ACTIVE', required: false, impact: '안내가 알림톡 대신 문자로 나갑니다.', href: '/studio/notices' },
    ...(featureContentEnabled()
      ? [{ key: 'social', label: 'SNS 채널 연결', ok: social > 0, required: false, impact: '콘텐츠를 자동 게시하지 못하고 내려받아 직접 올려야 합니다.', href: '/studio/channels' }]
      : []),
    ...(featureVolunteerEnabled()
      ? [{ key: 'volunteerTerms', label: '자원봉사 개인정보 동의 약관', ok: volunteerTerms > 0, required: true, impact: '자원봉사 신청을 받을 수 없습니다(관리자 약관 등록 필요).', href: '/support' }]
      : []),
    { key: 'thanks', label: '감사 문자 문구', ok: Boolean(m.thanksMtMessage), required: false, impact: '기본 감사 문구로 나갑니다.', href: '/studio/settings' },
  ];
  return {
    items,
    requiredMissing: items.filter((i) => i.required && !i.ok).length,
    recommendedMissing: items.filter((i) => !i.required && !i.ok).length,
  };
}

/**
 * 용도별 자동 발송 서식이 기관에 있는가. 용도(purpose) 열은 2단계에서 생긴다 —
 * 열이 아직 없거나 조회가 실패하면 "기본 서식 사용" 으로 본다(권장 항목이라 자동화를 막지 않음).
 */
async function countPurposeTemplates(merchantId: string): Promise<{ ok: boolean }> {
  try {
    const col = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM information_schema.columns WHERE table_name = 'document_template' AND column_name = 'purpose'`,
    );
    if (Number(col[0]?.n ?? 0) === 0) return { ok: false };
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM document_template WHERE merchant_id = $1 AND purpose IS NOT NULL AND template_type <> 'PRESET'`,
      merchantId,
    );
    return { ok: Number(rows[0]?.n ?? 0) > 0 };
  } catch {
    return { ok: false };
  }
}
