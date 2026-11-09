import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, DataRow, EmptyState, Table, Td, Th } from '@/components/ui';
import { NextActionCard } from '@/components/studio/next-action-card';
import { PAID_STATUSES } from '@/components/studio/shared';
import { formatKst } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { displayPayerName } from '@/lib/payer-name';
import { MT_TEMPLATE_META, type MtTemplateCode } from '@/server/services/mt-templates';
import { nextActionForPayer } from '@/server/services/next-action';
import { OUTBOUND_BUNDLE_TEMPLATE } from '@/server/services/outbound/classify';
import { VOLUNTEER_STATUS_LABEL } from '@/server/services/volunteers';

export const dynamic = 'force-dynamic';

const MT_STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  PENDING: { label: '보내는 중', tone: 'neutral' },
  ACCEPTED: { label: '접수', tone: 'brand' },
  SENT: { label: '전달', tone: 'success' },
  FAILED: { label: '실패', tone: 'danger' },
  SKIPPED: { label: '건너뜀', tone: 'neutral' },
  UNKNOWN: { label: '결과 미확인', tone: 'warning' },
};

function templateLabel(code: string | null) {
  if (!code) return '-';
  if (code === OUTBOUND_BUNDLE_TEMPLATE) return '안내 묶음';
  return MT_TEMPLATE_META[code as MtTemplateCode]?.label ?? code;
}

/**
 * 후원자 상세 (2026-11-09 D1). 다음 할 일 카드 + 후원·정기·영수증·봉사 요약 + 최근 안내.
 * 이 기관과 이어진 후원자만 연다. 전화번호 원문·주민등록번호는 보여 주지 않는다(마스킹 번호만).
 */
export default async function StudioDonorDetailPage({ params }: { params: Promise<{ payerId: string }> }) {
  const { merchantId } = await requireMerchant();
  const { payerId } = await params;
  const link = await prisma.payerMerchantLink.findUnique({ where: { payerId_merchantId: { payerId, merchantId } }, select: { noticeOptOutAt: true, createdAt: true } });
  if (!link) notFound();
  const payer = await prisma.payerProfile.findUnique({ where: { id: payerId }, select: { displayName: true, phoneMasked: true, phoneHash: true, onboardingStatus: true, mergedIntoId: true } });
  if (!payer) notFound();

  const [action, agg, recurring, receiptProfile, volunteer, messages] = await Promise.all([
    nextActionForPayer(merchantId, payerId),
    prisma.charge.aggregate({ where: { merchantId, payerId, isTest: false, status: { in: PAID_STATUSES } }, _sum: { amount: true }, _count: { _all: true }, _min: { paidAt: true }, _max: { paidAt: true } }),
    prisma.recurringDonation.findFirst({ where: { merchantId, payerId, status: { in: ['ACTIVE', 'PAUSED', 'SUSPENDED'] } }, select: { status: true, amount: true, dayOfMonth: true, recoveryState: true } }),
    prisma.payerReceiptProfile.findUnique({ where: { payerId }, select: { payerId: true } }),
    prisma.volunteerApplication.findFirst({ where: { merchantId, payerId }, orderBy: { createdAt: 'desc' }, select: { status: true } }),
    prisma.mtOutboundMessage.findMany({
      where: { merchantId, phoneHash: payer.phoneHash, merchantSent: false },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, templateCode: true, status: true, channel: true, fallback: true, createdAt: true },
    }),
  ]);
  const name = displayPayerName(payer.displayName ?? '');

  return (
    <>
      <PageHeader
        title={name}
        description={`${payer.phoneMasked} · 이 기관과 이어진 날 ${formatKst(link.createdAt, false).slice(0, 10)}`}
        action={<Link href="/studio/donors" className="text-[13px] font-bold text-brand-700">후원자 목록</Link>}
      />
      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <NextActionCard action={action} />
        <Card>
          <h2 className="text-[15px] font-black text-ink-900">요약</h2>
          <div className="mt-2">
            <DataRow label="누적 후원" value={`${formatWon(agg._sum.amount ?? 0n)} · ${formatNumber(agg._count._all)}회`} />
            <DataRow label="첫 후원 / 최근 후원" value={`${agg._min.paidAt ? formatKst(agg._min.paidAt, false).slice(0, 10) : '-'} / ${agg._max.paidAt ? formatKst(agg._max.paidAt, false).slice(0, 10) : '-'}`} />
            <DataRow label="정기후원" value={recurring ? `매월 ${recurring.dayOfMonth}일 ${formatWon(recurring.amount)} · ${recurring.status === 'ACTIVE' ? (recurring.recoveryState === 'NONE' ? '진행 중' : recurring.recoveryState === 'RETRYING' ? '재시도 중' : '조치 필요') : recurring.status === 'PAUSED' ? '일시정지' : '정지'}` : '없음'} />
            <DataRow label="영수증 정보" value={receiptProfile ? '등록' : '미등록'} />
            <DataRow label="자원봉사" value={volunteer ? (VOLUNTEER_STATUS_LABEL[volunteer.status] ?? volunteer.status) : '-'} />
            <DataRow label="안내 수신" value={payer.onboardingStatus === 'WITHDRAWN' ? '탈퇴' : link.noticeOptOutAt ? '이 기관 안내 수신 거부' : '받음'} />
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <h2 className="text-[15px] font-black text-ink-900">최근 안내</h2>
        <p className="mt-1 text-[12.5px] text-ink-500">이 기관 이름으로 이 후원자에게 나간 최근 안내 10건입니다(본문은 표시하지 않습니다).</p>
        {messages.length === 0 ? (
          <EmptyState title="아직 보낸 안내가 없습니다" />
        ) : (
          <div className="mt-3">
            <Table>
              <thead>
                <tr><Th>보낸 때</Th><Th>안내</Th><Th>채널</Th><Th>상태</Th></tr>
              </thead>
              <tbody>
                {messages.map((m) => {
                  const st = MT_STATUS[m.status] ?? { label: m.status, tone: 'neutral' as const };
                  return (
                    <tr key={m.id}>
                      <Td className="whitespace-nowrap text-[12px]">{formatKst(m.createdAt, false)}</Td>
                      <Td className="text-[12.5px]">{templateLabel(m.templateCode)}</Td>
                      <Td className="text-[12px]">{m.channel === 'ALIMTALK' ? '알림톡' : m.fallback ? '문자(대체)' : '문자'}</Td>
                      <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}
