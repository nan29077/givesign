import Link from 'next/link';
import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { prisma } from '@/server/db';
import { Badge, Card, Checkbox, EmptyState, Field, Input, LinkButton, Notice, Select } from '@/components/ui';
import { DonorActionForm } from '@/components/my/donor-action-form';
import { setRecurringStatusAction, updateRecurringAction } from '@/app/actions/donor';
import { recurringStatusLabel, recurringIsMock } from '@/server/services/recurring';
import { formatKst } from '@/lib/datetime';
import { formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * 내 정기후원.
 * 약정별로 금액·출금일 변경, 일시정지·재개·해지를 후원자가 직접 한다.
 */
export default async function MyRecurringPage() {
  const { payerId } = await requirePayerContext('/my/recurring');
  if (!payerId) {
    return (
      <>
        <EmptyState title={NO_PAYER_TITLE} description={NO_PAYER_DESC} />
        <div className="mt-4"><LinkButton href="/my/account#phone-link" size="md" className="w-full">휴대폰 번호 연결하기</LinkButton></div>
      </>
    );
  }
  const rows = await prisma.recurringDonation.findMany({
    where: { payerId },
    include: { merchant: { select: { displayName: true, code: true } }, campaign: { select: { title: true } }, runs: { orderBy: { ranAt: 'desc' }, take: 6 } },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });
  const hasToken = await prisma.paymentMethodToken.count({ where: { payerId, status: 'ACTIVE' } });

  return (
    <div className="space-y-4">
      {recurringIsMock() ? <Notice tone="neutral">현재 mock 결제사입니다. 실제 출금 없이 흐름만 재현됩니다.</Notice> : null}
      {!hasToken ? (
        <Notice tone="warning" title="등록된 결제수단이 없습니다">정기후원은 등록된 결제수단으로 매월 출금됩니다. 후원 기관의 MO 번호로 문자를 보내 결제수단을 먼저 등록해 주세요.</Notice>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="진행 중인 정기후원이 없습니다"
          description="기관 후원페이지의 '매월 후원하기' 에서 금액과 출금일을 정하면 매월 자동으로 후원됩니다."
          action={<LinkButton href="/" variant="secondary">기관 찾아보기</LinkButton>}
        />
      ) : (
        rows.map((r) => {
          const st = recurringStatusLabel[r.status];
          const editable = r.status !== 'CANCELED';
          return (
            <Card key={r.id} className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={st.tone}>{st.text}</Badge>
                <Link href={`/donate/${r.merchant.code}`} className="text-[15px] font-extrabold text-ink-900">{r.merchant.displayName}</Link>
                {r.campaign ? <span className="text-[12px] text-ink-500">· {r.campaign.title}</span> : null}
                <span className="ml-auto text-[18px] font-black tabular-nums text-ink-900">{formatWon(r.amount)}<span className="text-[12px] font-bold text-ink-400"> / 매월 {r.dayOfMonth}일</span></span>
              </div>
              <p className="text-[12.5px] text-ink-500">
                {r.status === 'ACTIVE' ? `다음 출금 ${r.nextChargeOn.toISOString().slice(0, 10)}` : r.status === 'SUSPENDED' ? `출금 실패로 멈춤 — ${r.lastFailure ?? ''}` : r.status === 'PAUSED' ? `${formatKst(r.pausedAt, false)} 부터 일시정지` : `${formatKst(r.canceledAt, false)} 해지`}
                {' · '}누적 {formatWon(r.totalAmount)} ({r.successCount}회) · 시작 {formatKst(r.createdAt, false)}
              </p>

              {editable ? (
                <details className="rounded-xl border border-ink-100 p-3">
                  <summary className="cursor-pointer text-[13px] font-bold text-ink-700">금액·출금일·메시지 바꾸기</summary>
                  <DonorActionForm action={updateRecurringAction} submitLabel="변경 저장" size="sm" className="mt-3">
                    <input type="hidden" name="id" value={r.id} />
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label="매월 후원 금액(원)"><Input name="amount" inputMode="numeric" defaultValue={String(r.amount)} /></Field>
                      <Field label="출금일" hint="1~28일">
                        <Select name="dayOfMonth" defaultValue={String(r.dayOfMonth)}>
                          {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}일</option>)}
                        </Select>
                      </Field>
                      <Field label="응원 메시지"><Input name="message" maxLength={80} defaultValue={r.message} /></Field>
                    </div>
                    <Checkbox name="anonymous" defaultChecked={r.anonymous} label="후원페이지에 익명으로 표시" />
                  </DonorActionForm>
                </details>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {r.status === 'ACTIVE' ? (
                  <DonorActionForm action={setRecurringStatusAction} submitLabel="일시정지" variant="secondary" size="sm" confirmMessage="정기후원을 일시정지할까요? 다시 시작할 때까지 출금되지 않습니다.">
                    <input type="hidden" name="id" value={r.id} /><input type="hidden" name="action" value="PAUSE" />
                  </DonorActionForm>
                ) : null}
                {r.status === 'PAUSED' || r.status === 'SUSPENDED' ? (
                  <DonorActionForm action={setRecurringStatusAction} submitLabel="다시 시작" variant="primary" size="sm">
                    <input type="hidden" name="id" value={r.id} /><input type="hidden" name="action" value="RESUME" />
                  </DonorActionForm>
                ) : null}
                {editable ? (
                  <DonorActionForm action={setRecurringStatusAction} submitLabel="해지" variant="ghost" size="sm" confirmMessage="정기후원을 해지할까요? 이후 출금은 일어나지 않습니다.">
                    <input type="hidden" name="id" value={r.id} /><input type="hidden" name="action" value="CANCEL" />
                  </DonorActionForm>
                ) : null}
              </div>

              {r.runs.length ? (
                <ul className="divide-y divide-ink-100 text-[12px] text-ink-500">
                  {r.runs.map((run) => (
                    <li key={run.id} className="flex justify-between py-1">
                      <span>{run.monthKey} {run.attempt > 1 ? `(${run.attempt}차)` : ''} · {formatKst(run.ranAt, false)}</span>
                      <span className={run.status === 'SUCCESS' ? 'font-bold text-success-500' : run.status === 'FAILED' ? 'font-bold text-danger-500' : run.status === 'PENDING' ? 'font-bold text-warning-500' : ''}>
                        {run.status === 'SUCCESS'
                          ? '출금 완료'
                          : run.status === 'FAILED'
                            ? `실패 — ${run.reason ?? ''}`
                            : run.status === 'PENDING'
                              ? '결과 확인 중 — 확인될 때까지 다시 출금하지 않습니다'
                              : `건너뜀 — ${run.reason ?? ''}`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          );
        })
      )}
    </div>
  );
}
