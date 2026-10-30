import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { canManageMoney, canWrite } from '@/components/admin/constants';
import { OrgLogo } from '@/components/brand/org-logo';
import {
  adjustEDocWalletAction,
  approveEDocBillingAction,
  cancelEDocPlanAction,
  rejectEDocBillingAction,
  runEDocBatchAction,
  saveEDocPlanAction,
  verifyEDocAction,
} from '@/app/actions/admin/edoc';
import { requireAdmin } from '@/server/auth';
import { prisma } from '@/server/db';
import { currentEDocPlan } from '@/server/services/edoc-billing';
import { edocEnvelopeStatusLabel, edocStats } from '@/server/services/edoc';
import { topupBonusText } from '@/lib/edoc-billing';
import { formatKst, kstStartOfMonth } from '@/lib/datetime';
import { newId } from '@/lib/id';

export const dynamic = 'force-dynamic';

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;

/**
 * 전자문서 운영·이용요금 (통합 관리자).
 * 요금제 버전(시행일 기준) · 충전/정액 신청 승인 · 기관별 이용 현황과 정정 · 만료 배치 · 감사추적 검증.
 */
export default async function AdminEDocumentsPage() {
  const admin = await requireAdmin();
  const writable = canWrite(admin.adminPermission);
  const money = canManageMoney(admin.adminPermission);
  const superAdmin = admin.adminPermission === 'SUPER_ADMIN';
  const now = new Date();

  const [plan, plans, pending, resolved, wallets, subs, monthUse, stats, envelopes, merchants, revenue] = await Promise.all([
    currentEDocPlan(now),
    prisma.eDocPlan.findMany({ orderBy: { effectiveFrom: 'desc' }, take: 12 }),
    prisma.eDocBillingRequest.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, include: { merchant: { select: { displayName: true, code: true, avatarUrl: true } } } }),
    prisma.eDocBillingRequest.findMany({ where: { status: { not: 'PENDING' } }, orderBy: { resolvedAt: 'desc' }, take: 20, include: { merchant: { select: { displayName: true } } } }),
    prisma.eDocWallet.findMany({ orderBy: { updatedAt: 'desc' }, take: 100, include: { merchant: { select: { displayName: true, code: true, avatarUrl: true } } } }),
    prisma.eDocSubscription.findMany({ where: { status: 'ACTIVE', endsAt: { gt: now } } }),
    prisma.eDocLedger.groupBy({ by: ['merchantId'], where: { kind: 'USE', createdAt: { gte: kstStartOfMonth() } }, _count: { _all: true } }),
    edocStats(),
    prisma.eDocEnvelope.findMany({ orderBy: { createdAt: 'desc' }, take: 30, include: { merchant: { select: { displayName: true } }, _count: { select: { signers: true } } } }),
    prisma.merchantProfile.findMany({ where: { status: 'APPROVED' }, select: { id: true, displayName: true }, orderBy: { displayName: 'asc' } }),
    prisma.eDocLedger.aggregate({ where: { kind: { in: ['TOPUP', 'PLAN_GRANT'] }, createdAt: { gte: kstStartOfMonth() } }, _sum: { supplyAmount: true, vatAmount: true } }),
  ]);
  const subOf = new Map(subs.map((s) => [s.merchantId, s]));
  const useOf = new Map(monthUse.map((u) => [u.merchantId, u._count._all]));
  const totalBalance = wallets.reduce((a, w) => a + w.balance, 0);

  return (
    <>
      <PageHeader title="전자문서·이용요금" description="기관 전자문서 서명 요청과 이용요금(충전형·30일 정액형)을 관리합니다. 요금제는 시행일 기준 버전으로 바뀝니다." />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        <StatTile label="확인 대기 신청" value={`${pending.length}건`} tone={pending.length ? 'brand' : 'neutral'} />
        <StatTile label="서명 대기" value={`${stats.open.toLocaleString('ko-KR')}건`} />
        <StatTile label="이번 달 발송" value={`${stats.thisMonth.toLocaleString('ko-KR')}건`} sub={`누적 완료 ${stats.completed.toLocaleString('ko-KR')}건`} />
        <StatTile label="이번 달 이용료 입금" value={won((revenue._sum.supplyAmount ?? 0) + (revenue._sum.vatAmount ?? 0))} sub={`공급가 ${won(revenue._sum.supplyAmount ?? 0)} · 부가세 ${won(revenue._sum.vatAmount ?? 0)}`} />
        <StatTile label="기관 충전 잔액 합계" value={won(totalBalance)} sub="선수금 성격(후원금 아님)" />
      </div>

      <Notice tone="warning" title="실결제·공인 인증 연동 전">
        충전·정액 승인은 실제 입금이나 계약을 따로 확인한 뒤에만 처리하세요. 서명 문자는 설정된 문자 사업자(현재 설정이 mock 이면 실제 발송 안 됨)로 나가며, 서명 기록은 기브싸인 내부 감사추적입니다.
        공동인증서·공인전자문서 중계·시점확인(TSA)은 연동하지 않았습니다.
      </Notice>

      <section className="mt-5">
        <h2 className="mb-2.5 text-[15px] font-black text-ink-900">충전·정액 신청 확인</h2>
        {pending.length === 0 ? (
          <EmptyState title="확인 대기 중인 신청이 없습니다" />
        ) : (
          <div className="space-y-2.5">
            {pending.map((r) => (
              <Card key={r.id}>
                <div className="flex flex-wrap items-center gap-3">
                  <OrgLogo code={r.merchant.code} name={r.merchant.displayName} logoUrl={r.merchant.avatarUrl} className="h-9 w-9" />
                  <div className="min-w-0">
                    <p className="font-bold text-ink-900">{r.merchant.displayName} · {r.kind === 'TOPUP' ? '충전' : `30일 정액 ${r.quota.toLocaleString('ko-KR')}건`} {won(r.amount)}{r.bonus ? ` (+보너스 ${won(r.bonus)})` : ''}</p>
                    <p className="text-[12px] text-ink-500">신청 {formatKst(r.createdAt, false)} · 입금자 {r.depositorName ?? '-'} · 세금계산서 {r.wantsTaxInvoice ? '요청' : '요청 안 함'}</p>
                  </div>
                </div>
                {money ? (
                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <ActionForm action={approveEDocBillingAction} submitLabel="입금 확인 후 승인" confirm="실제 입금·계약을 확인했습니까? 승인하면 바로 이용량에 반영됩니다.">
                      <input type="hidden" name="requestId" value={r.id} />
                      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="paymentConfirmed" required /> 실제 입금 또는 계약을 확인했습니다</label>
                      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="taxInvoiceIssued" /> 세금계산서를 발행했습니다</label>
                    </ActionForm>
                    <ActionForm action={rejectEDocBillingAction} submitLabel="반려" variant="danger">
                      <input type="hidden" name="requestId" value={r.id} />
                      <AdminInput name="reason" placeholder="반려 사유 (기관에 보입니다)" maxLength={200} />
                    </ActionForm>
                  </div>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-[15px] font-black text-ink-900">기관별 이용 현황</h2>
          {writable ? <ActionButton action={runEDocBatchAction} values={{}} label="만료 처리 지금 실행" /> : null}
        </div>
        {wallets.length === 0 ? (
          <EmptyState title="아직 전자문서를 쓴 기관이 없습니다" />
        ) : (
          <Table className="min-w-[1080px]">
            <thead><tr><Th>기관</Th><Th>충전 잔액</Th><Th>정액</Th><Th>시범</Th><Th>이번 달 · 누적</Th><Th>정정 · 검증</Th></tr></thead>
            <tbody>
              {wallets.map((w) => {
                const s = subOf.get(w.merchantId);
                return (
                  <tr key={w.merchantId}>
                    <Td>
                      <span className="flex items-center gap-2">
                        <OrgLogo code={w.merchant.code} name={w.merchant.displayName} logoUrl={w.merchant.avatarUrl} className="h-8 w-8" />
                        <span><span className="block font-bold text-ink-900">{w.merchant.displayName}</span><span className="font-mono text-[11px] text-ink-400">{w.merchant.code}</span></span>
                      </span>
                    </Td>
                    <Td className="tabular-nums">{won(w.balance)}</Td>
                    <Td className="text-[12.5px]">{s ? `${s.quota - s.used}/${s.quota}건 · ${formatKst(s.endsAt, false).slice(5, 10)}까지` : '-'}</Td>
                    <Td className="tabular-nums">{w.trialRemaining}건</Td>
                    <Td className="tabular-nums">{useOf.get(w.merchantId) ?? 0}건 · {w.totalUsed}건</Td>
                    <Td className="min-w-[320px]">
                      {money ? (
                        <ActionForm action={adjustEDocWalletAction} submitLabel="정정" compact confirm="원장에 조정 기록을 남깁니다. 진행할까요?">
                          <input type="hidden" name="merchantId" value={w.merchantId} />
                          <input type="hidden" name="nonce" value={newId()} />
                          <div className="grid grid-cols-[1fr_80px] gap-1.5">
                            <AdminInput name="amount" placeholder="금액 ±원" inputMode="numeric" />
                            <AdminInput name="units" placeholder="시범 ±건" inputMode="numeric" />
                          </div>
                          <AdminInput name="reason" placeholder="조정 사유 (필수)" maxLength={200} />
                        </ActionForm>
                      ) : null}
                      <div className="mt-1.5"><ActionButton action={verifyEDocAction} values={{ merchantId: w.merchantId }} label="원장 대조" /></div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <p className="mt-2 text-[12px] text-ink-400">지갑이 없는 기관은 처음 이용 화면을 열 때 시범 제공량과 함께 만들어집니다. 승인 기관 {merchants.length}곳.</p>
      </section>

      <section className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card>
          <CardTitle>요금제</CardTitle>
          <p className="mt-1 text-[12.5px] text-ink-500">
            지금 적용: 건당 {won(plan.perDocument)} · 30일 {won(plan.monthlyPrice)}/{plan.monthlyQuota.toLocaleString('ko-KR')}건 · 시범 {plan.trialQuota}건 · 잔액 알림 {won(plan.lowBalance)}
            {plan.topupBonus.length ? ` · 보너스 ${plan.topupBonus.map((b) => `${won(b.min)}↑ ${b.percent}%`).join(', ')}` : ''}
          </p>
          <Table className="mt-3 min-w-[620px]">
            <thead><tr><Th>시행일</Th><Th>건당</Th><Th>30일 정액</Th><Th>시범</Th><Th>메모</Th><Th /></tr></thead>
            <tbody>
              {plans.map((p) => {
                const future = p.effectiveFrom > now;
                return (
                  <tr key={p.id}>
                    <Td className="whitespace-nowrap text-[12px]">{formatKst(p.effectiveFrom, false)}{p.id === plan.id ? <Badge tone="success" className="ml-1.5">적용 중</Badge> : future ? <Badge tone="brand" className="ml-1.5">예약</Badge> : null}</Td>
                    <Td className="tabular-nums">{won(p.perDocument)}</Td>
                    <Td className="tabular-nums">{won(p.monthlyPrice)} / {p.monthlyQuota}건</Td>
                    <Td className="tabular-nums">{p.trialQuota}건</Td>
                    <Td className="text-[12px] text-ink-500">{p.note}</Td>
                    <Td>{future && superAdmin ? <ActionButton action={cancelEDocPlanAction} values={{ planId: p.id }} label="예약 취소" variant="danger" /> : null}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>

        {superAdmin ? (
          <Card>
            <CardTitle>새 요금제 등록</CardTitle>
            <p className="mt-1 text-[12px] text-ink-400">지난 요금제는 고치지 않습니다. 시행일부터 새 요금제가 적용되고, 이미 접수한 신청 금액은 바뀌지 않습니다. 금액은 부가세 포함입니다.</p>
            <ActionForm action={saveEDocPlanAction} submitLabel="요금제 등록" confirm="새 요금제를 등록할까요?" className="mt-3">
              <div className="grid grid-cols-2 gap-2.5">
                <AdminField label="건당 금액(원)"><AdminInput name="perDocument" type="number" min={1} defaultValue={plan.perDocument} /></AdminField>
                <AdminField label="시범 제공(건)"><AdminInput name="trialQuota" type="number" min={0} defaultValue={plan.trialQuota} /></AdminField>
                <AdminField label="30일 정액 요금(원)"><AdminInput name="monthlyPrice" type="number" min={1000} defaultValue={plan.monthlyPrice} /></AdminField>
                <AdminField label="30일 제공(건)"><AdminInput name="monthlyQuota" type="number" min={1} defaultValue={plan.monthlyQuota} /></AdminField>
                <AdminField label="잔액 알림 기준(원)"><AdminInput name="lowBalance" type="number" min={0} defaultValue={plan.lowBalance} /></AdminField>
                <AdminField label="시행일시(한국 시간)"><AdminInput name="effectiveFrom" type="datetime-local" /></AdminField>
              </div>
              <AdminField label="충전 보너스(금액:퍼센트)"><AdminInput name="topupBonus" placeholder="100000:5, 300000:10" defaultValue={topupBonusText(plan.topupBonus)} /></AdminField>
              <AdminField label="메모"><AdminInput name="note" maxLength={100} /></AdminField>
            </ActionForm>
          </Card>
        ) : null}
      </section>

      <section className="mt-6">
        <h2 className="mb-2.5 text-[15px] font-black text-ink-900">최근 서명 요청</h2>
        {envelopes.length === 0 ? (
          <EmptyState title="아직 서명 요청이 없습니다" />
        ) : (
          <Table className="min-w-[860px]">
            <thead><tr><Th>기관</Th><Th>문서</Th><Th>상태</Th><Th>보낸 날</Th><Th>감사추적</Th></tr></thead>
            <tbody>
              {envelopes.map((e) => (
                <tr key={e.id}>
                  <Td className="font-bold text-ink-900">{e.merchant.displayName}</Td>
                  <Td>{e.title}<span className="block text-[11.5px] text-ink-400">서명자 {e._count.signers}명 · <span className="font-mono">{e.id}</span></span></Td>
                  <Td><Badge tone={edocEnvelopeStatusLabel[e.status].tone}>{edocEnvelopeStatusLabel[e.status].text}</Badge></Td>
                  <Td className="whitespace-nowrap text-[12px] text-ink-500">{formatKst(e.createdAt, false)}</Td>
                  <Td><ActionButton action={verifyEDocAction} values={{ envelopeId: e.id }} label="해시 검증" /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="mt-2 text-[12px] text-ink-400">서명자 입력값은 이 화면에서 열람하지 않습니다(기관 담당자 열람만 허용, 감사로그 기록).</p>
      </section>

      {resolved.length ? (
        <section className="mt-6">
          <h2 className="mb-2.5 text-[15px] font-black text-ink-900">처리한 신청</h2>
          <Table className="min-w-[760px]">
            <thead><tr><Th>처리일</Th><Th>기관</Th><Th>구분</Th><Th>금액</Th><Th>결과</Th></tr></thead>
            <tbody>
              {resolved.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-[12px] text-ink-500">{r.resolvedAt ? formatKst(r.resolvedAt, false) : '-'}</Td>
                  <Td>{r.merchant.displayName}</Td>
                  <Td>{r.kind === 'TOPUP' ? '충전' : '30일 정액'}</Td>
                  <Td className="tabular-nums">{won(r.amount)}</Td>
                  <Td>{r.status === 'APPROVED' ? '승인' : r.status === 'REJECTED' ? `반려 — ${r.rejectReason ?? ''}` : '기관 취소'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}

      <Link href="/admin/audit" className="mt-6 block text-[13px] font-bold underline">전자문서 관리 감사로그 보기</Link>
    </>
  );
}
