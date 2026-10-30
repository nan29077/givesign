import Link from 'next/link';
import { CalendarClock, Coins, Gift, Wallet } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Checkbox, EmptyState, Field, Input, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionForm, InlineActionForm } from '@/components/studio/action-form';
import { cancelEDocBillingAction, requestEDocBilling } from '@/app/actions/edoc';
import { upcomingEDocPlans, walletOverview } from '@/server/services/edoc-billing';
import { EDOC_MONTHLY_DAYS, EDOC_TOPUP_MIN, edocLedgerKindLabel, edocUseSourceLabel } from '@/lib/edoc-billing';
import { formatKst } from '@/lib/datetime';
import { newId } from '@/lib/id';

export const dynamic = 'force-dynamic';

const REQ_STATUS = {
  PENDING: { text: '입금 확인 대기', tone: 'warning' },
  APPROVED: { text: '반영 완료', tone: 'success' },
  REJECTED: { text: '반려', tone: 'danger' },
  CANCELLED: { text: '취소', tone: 'neutral' },
} as const;

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;

/**
 * 전자문서 이용요금 (기관).
 * 충전형(건당 차감)과 30일 정액형(제공 건수)을 함께 쓸 수 있다. 차감 순서는 정액 → 시범 → 충전 잔액.
 * 실결제 연동 전: 신청 → 입금 → 관리자 확인 후 반영. 자동 출금·자동 갱신은 하지 않는다.
 */
export default async function DocumentBillingPage() {
  const { merchantId } = await requireMerchant();
  const [o, requests, ledger, upcoming] = await Promise.all([
    walletOverview(merchantId),
    prisma.eDocBillingRequest.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.eDocLedger.findMany({ where: { merchantId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 }),
    upcomingEDocPlans(),
  ]);
  const plan = o.plan;
  const next = upcoming[0];

  return (
    <>
      <PageHeader title="전자문서 이용요금" description="서명 요청을 보낼 때 1건씩 차감합니다. 정액 제공량 → 시범 제공량 → 충전 잔액 순서로 씁니다. 이용 잔액은 후원금과 별개입니다." />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="충전 잔액" value={won(o.wallet.balance)} sub={`약 ${o.prepaidDocs.toLocaleString('ko-KR')}건`} tone="brand" />
        <StatTile label="정액 남은 건수" value={o.subscription ? `${o.monthlyLeft.toLocaleString('ko-KR')}건` : '-'} sub={o.subscription ? `${formatKst(o.subscription.endsAt, false).slice(0, 10)}까지` : '이용 중인 정액 없음'} />
        <StatTile label="시범 제공" value={`${o.wallet.trialRemaining}건`} />
        <StatTile label="누적 발송" value={`${o.wallet.totalUsed.toLocaleString('ko-KR')}건`} />
      </div>

      <Notice tone="neutral" title="결제는 아직 연동 전입니다">
        신청하면 관리자가 안내하는 계좌로 입금해 주세요. 입금이 확인되면 반영합니다. 자동 출금이나 자동 갱신은 없습니다. 세금계산서가 필요하면 신청할 때 체크해 주세요.
      </Notice>

      {next ? (
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-ink-500">
          <CalendarClock size={16} strokeWidth={1.7} /> {formatKst(next.effectiveFrom, false).slice(0, 10)}부터 요금이 바뀝니다: 건당 {won(next.perDocument)} · 30일 {won(next.monthlyPrice)}/{next.monthlyQuota.toLocaleString('ko-KR')}건
        </p>
      ) : null}

      <div className="my-5 grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-center gap-2"><Coins size={18} strokeWidth={1.7} className="text-brand-700" /><CardTitle>충전형</CardTitle></div>
          <p className="mt-2 text-[22px] font-black text-ink-900">건당 {won(plan.perDocument)}</p>
          <p className="mt-1 text-[12.5px] text-ink-500">필요할 때만 보내는 기관에 맞습니다. 남은 잔액은 기한 없이 씁니다.</p>
          {plan.topupBonus.length ? (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-600">
              <Gift size={16} strokeWidth={1.7} className="text-accent-500" />
              {plan.topupBonus.map((r) => `${won(r.min)} 이상 ${r.percent}% 추가`).join(' · ')}
            </p>
          ) : null}
          <ActionForm action={requestEDocBilling} submitLabel="충전 신청" className="mt-4">
            <input type="hidden" name="nonce" value={newId()} />
            <input type="hidden" name="kind" value="TOPUP" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="충전 금액(원, 부가세 포함)" required hint="1,000원 단위">
                <Input name="amount" type="number" min={EDOC_TOPUP_MIN} step={1000} defaultValue={30000} required />
              </Field>
              <Field label="입금자명">
                <Input name="depositorName" maxLength={30} />
              </Field>
            </div>
            <Checkbox name="wantsTaxInvoice" defaultChecked label="세금계산서 발행을 요청합니다" />
          </ActionForm>
        </Card>

        <Card>
          <div className="flex items-center gap-2"><CalendarClock size={18} strokeWidth={1.7} className="text-brand-700" /><CardTitle>30일 정액형</CardTitle></div>
          <p className="mt-2 text-[22px] font-black text-ink-900">{won(plan.monthlyPrice)} <span className="text-[14px] font-bold text-ink-500">/ {plan.monthlyQuota.toLocaleString('ko-KR')}건</span></p>
          <p className="mt-1 text-[12.5px] text-ink-500">
            건당 약 {won(Math.round(plan.monthlyPrice / Math.max(1, plan.monthlyQuota)))}. 승인일부터 {EDOC_MONTHLY_DAYS}일 동안 쓰며, 남은 제공량은 기간이 끝나면 사라집니다. 자동 갱신하지 않습니다.
          </p>
          {o.subscription ? (
            <p className="mt-4 rounded-xl bg-brand-50 px-3 py-2.5 text-[12.5px] font-semibold text-brand-800">이용 중: {o.monthlyLeft}건 남음 · {formatKst(o.subscription.endsAt, false)} 종료. 기간이 끝난 뒤 다시 신청할 수 있습니다.</p>
          ) : (
            <ActionForm action={requestEDocBilling} submitLabel="정액 이용 신청" className="mt-4">
              <input type="hidden" name="nonce" value={newId()} />
              <input type="hidden" name="kind" value="MONTHLY" />
              <Field label="입금자명">
                <Input name="depositorName" maxLength={30} />
              </Field>
              <Checkbox name="wantsTaxInvoice" defaultChecked label="세금계산서 발행을 요청합니다" />
            </ActionForm>
          )}
        </Card>
      </div>

      <Card className="mb-5">
        <CardTitle>신청 내역</CardTitle>
        {requests.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-500">신청 내역이 없습니다.</p>
        ) : (
          <Table className="mt-3 min-w-[680px]">
            <thead><tr><Th>신청일</Th><Th>구분</Th><Th>금액</Th><Th>상태</Th><Th /></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-[12px] text-ink-500">{formatKst(r.createdAt, false)}</Td>
                  <Td>{r.kind === 'TOPUP' ? '충전' : `30일 정액 ${r.quota.toLocaleString('ko-KR')}건`}</Td>
                  <Td className="tabular-nums">{won(r.amount)}{r.bonus ? <span className="block text-[11.5px] text-accent-500">+ 보너스 {won(r.bonus)}</span> : null}</Td>
                  <Td>
                    <Badge tone={REQ_STATUS[r.status].tone}>{REQ_STATUS[r.status].text}</Badge>
                    {r.rejectReason ? <span className="mt-0.5 block text-[11.5px] text-ink-500">{r.rejectReason}</span> : null}
                    {r.taxInvoiceIssued ? <span className="mt-0.5 block text-[11.5px] text-ink-400">세금계산서 발행</span> : null}
                  </Td>
                  <Td>{r.status === 'PENDING' ? <InlineActionForm action={cancelEDocBillingAction} submitLabel="신청 취소" fields={{ requestId: r.id }} confirmMessage="이 신청을 취소할까요?" /> : null}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <div className="flex items-center gap-2"><Wallet size={18} strokeWidth={1.7} className="text-brand-700" /><CardTitle>이용 원장</CardTitle></div>
        <p className="mt-1 text-[12px] text-ink-400">모든 충전·차감·환원은 지울 수 없는 원장으로 남습니다. 금액은 공급가액과 부가세를 나눠 기록합니다.</p>
        {ledger.length === 0 ? (
          <div className="mt-3"><EmptyState title="아직 기록이 없습니다" /></div>
        ) : (
          <Table className="mt-3 min-w-[820px]">
            <thead><tr><Th>일시</Th><Th>구분</Th><Th>변화</Th><Th>공급가액 · 부가세</Th><Th>잔액 후</Th><Th>내용</Th></tr></thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.id}>
                  <Td className="whitespace-nowrap text-[12px] text-ink-500">{formatKst(l.createdAt, false)}</Td>
                  <Td>{edocLedgerKindLabel[l.kind] ?? l.kind}{l.source ? <span className="block text-[11px] text-ink-400">{edocUseSourceLabel[l.source]}</span> : null}</Td>
                  <Td className="tabular-nums">
                    {l.amount ? <span className={l.amount < 0 ? 'text-danger-500' : 'text-[#0b7d59]'}>{l.amount > 0 ? '+' : ''}{won(l.amount)}</span> : null}
                    {l.units ? <span className="block text-[12px] text-ink-600">{l.units > 0 ? '+' : ''}{l.units}건</span> : null}
                  </Td>
                  <Td className="tabular-nums text-[12px] text-ink-500">{l.supplyAmount || l.vatAmount ? `${won(l.supplyAmount)} · ${won(l.vatAmount)}` : '-'}</Td>
                  <Td className="tabular-nums text-[12px]">{won(l.balanceAfter)}<span className="block text-ink-400">시범 {l.trialAfter}건</span></Td>
                  <Td className="text-[12px] text-ink-500">
                    {l.memo}
                    {l.envelopeId ? <Link href={`/studio/e-documents/${l.envelopeId}`} className="ml-1 font-bold underline">문서</Link> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
