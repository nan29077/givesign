import type { Metadata } from 'next';
import { CalendarClock, Receipt } from 'lucide-react';
import { DonorShell } from '@/components/public/donor-shell';
import { Badge } from '@/components/ui';
import { prisma } from '@/server/db';
import { getReceiptProfile, issuerReadiness, receiptStatusLabel } from '@/server/services/receipts';
import { receiptScheduleNote } from '@/server/services/receipt-schedule';
import { currentTermsDoc } from '@/server/services/terms';
import { hasStepUp } from '@/server/services/self-service-stepup';
import { memberReceiptOpenAction, memberReceiptSaveAction } from '@/app/actions/self-service';
import { SelfServiceForm, StepUpPanel } from '@/components/self-service/self-service-forms';
import { ReceiptProfileFields } from '@/components/self-service/receipt-profile-fields';
import { PAID_STATUSES } from '@/components/studio/shared';
import { formatKst } from '@/lib/datetime';
import { formatWon } from '@/lib/money';
import { MemberMyNav, NeedPhoneNotice, loadMemberSelf } from '../_member';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '기부금영수증', robots: { index: false } };

/**
 * 기관 후원 회원 — 기부금영수증 (2026-11-09 2차 F).
 * 영수증 정보 등록 상태·등록/수정(후원자 단위라 휴대폰 재확인 뒤), 이 기관의 발급 일정 안내, 이 기관이 발급한 영수증 열람.
 */
export default async function DonorReceiptsPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const { ctx, me, base, scope } = await loadMemberSelf(code, '/receipts');
  const merchant = await prisma.merchantProfile.findUniqueOrThrow({
    where: { id: ctx.org.id },
    select: { receiptCycle: true, businessNo: true, representativeName: true, address: true, designatedDonee: true, designatedDoneeVerifiedAt: true, designatedDoneeUntil: true },
  });
  const schedule = receiptScheduleNote(merchant.receiptCycle);
  const ready = issuerReadiness(merchant).ok;
  const [profile, receipts, pendingAgg, terms, verified] = scope
    ? await Promise.all([
        getReceiptProfile(scope.payerId),
        prisma.donationReceipt.findMany({ where: { payerId: scope.payerId, merchantId: scope.merchantId }, orderBy: [{ taxYear: 'desc' }, { issuedAt: 'desc' }], take: 50 }),
        prisma.charge.aggregate({ where: { payerId: scope.payerId, merchantId: scope.merchantId, isTest: false, status: { in: PAID_STATUSES }, receiptId: null }, _sum: { amount: true }, _count: { _all: true } }),
        currentTermsDoc('RECEIPT_ISSUANCE'),
        hasStepUp({ kind: 'MEMBER', memberId: me.id }),
      ])
    : [null, [], null, null, false] as const;

  return (
    <DonorShell org={ctx.shellOrg} viewer={me} active="my" color={ctx.color} backgroundUrl={ctx.backgroundUrl}>
      <div className="space-y-4 px-4 pt-6 text-[16px] sm:px-7">
        <MemberMyNav base={base} active="receipts" color={ctx.color} />
        <h1 className="text-[22px] font-black text-ink-900">기부금영수증</h1>

        <section className="rounded-[24px] border border-ink-100 bg-white p-5">
          <h2 className="flex items-center gap-2 text-[18px] font-black text-ink-900"><CalendarClock size={20} strokeWidth={1.7} /> 발급 일정</h2>
          <p className="mt-1.5 leading-relaxed text-ink-700">{schedule.text}</p>
          {!ready ? <p className="mt-1.5 leading-relaxed text-ink-500">지금은 기관의 영수증 발급 준비(공익법인 확인 등)가 끝나지 않아 발급되지 않습니다. 준비되면 위 일정대로 발급됩니다.</p> : null}
          {pendingAgg && pendingAgg._count._all > 0 ? (
            <p className="mt-2 rounded-xl bg-ink-50 px-3 py-2 leading-relaxed text-ink-900">아직 영수증에 담기지 않은 후원 {pendingAgg._count._all}건 · {formatWon(pendingAgg._sum.amount ?? 0n)}</p>
          ) : null}
        </section>

        {!scope ? <NeedPhoneNotice base={base} /> : (
          <>
            <section className="rounded-[24px] border border-ink-100 bg-white p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[18px] font-black text-ink-900">영수증 발급 정보</h2>
                {profile ? <Badge tone="success" className="text-[13px]">등록됨 · {formatKst(profile.updatedAt, false)}</Badge> : <Badge tone="warning" className="text-[13px]">미등록</Badge>}
              </div>
              <p className="mt-1.5 leading-relaxed text-ink-700">
                연말정산용 영수증에는 성명과 주민등록번호가 필요합니다. 이 정보는 후원한 모든 기관의 영수증에 함께 쓰입니다. 주민등록번호는 암호화해 저장합니다.
              </p>
              {profile ? (
                <div className="mt-3 rounded-xl bg-ink-50 p-3 text-[15px] leading-relaxed">
                  <p>성명 <strong>{profile.legalName}</strong> · 주민등록번호 <span className="font-mono">{profile.residentNoMasked}</span></p>
                  <p>연말정산 간소화 제출 {profile.hometaxOptIn ? '동의' : '종이 영수증만'}</p>
                </div>
              ) : null}
              <details className="mt-3" open={!profile}>
                <summary className="cursor-pointer text-[16px] font-bold" style={{ color: ctx.color }}>{profile ? '정보 수정하기' : '정보 등록하기'}</summary>
                <div className="mt-3 space-y-3">
                  <StepUpPanel code={ctx.org.code} verified={verified} phoneMasked={me.phoneMasked} />
                  <SelfServiceForm action={memberReceiptSaveAction} code={ctx.org.code} submitLabel={profile ? '수정 저장' : '동의하고 등록'}>
                    <ReceiptProfileFields profile={profile} terms={terms} />
                  </SelfServiceForm>
                </div>
              </details>
            </section>

            <section className="rounded-[24px] border border-ink-100 bg-white p-5">
              <h2 className="flex items-center gap-2 text-[18px] font-black text-ink-900"><Receipt size={20} strokeWidth={1.7} /> 발급된 영수증</h2>
              {receipts.length === 0 ? (
                <p className="mt-2 text-ink-500">아직 이 기관에서 발급된 영수증이 없습니다.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {receipts.map((r) => (
                    <li key={r.id} className="rounded-2xl bg-ink-50 p-4">
                      <p className="text-[17px] font-extrabold text-ink-900">{r.taxYear}년 귀속 {formatWon(r.totalAmount)} <Badge tone={receiptStatusLabel[r.status].tone} className="text-[13px]">{receiptStatusLabel[r.status].text}</Badge></p>
                      <p className="mt-0.5 text-[14px] text-ink-500">발급번호 <span className="font-mono">{r.receiptNo}</span> · {formatKst(r.issuedAt, false)}</p>
                      {r.status === 'ISSUED' ? (
                        <SelfServiceForm action={memberReceiptOpenAction} code={ctx.org.code} submitLabel="열람·내려받기" variant="secondary" size="md" className="mt-2">
                          <input type="hidden" name="receiptId" value={r.id} />
                        </SelfServiceForm>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-[14px] leading-relaxed text-ink-500">영수증 화면에서 인쇄하거나 PDF 로 저장할 수 있습니다. 환불된 후원은 영수증에서 빠지고, 금액이 바뀌면 기관이 다시 발급합니다.</p>
            </section>
          </>
        )}
      </div>
    </DonorShell>
  );
}
