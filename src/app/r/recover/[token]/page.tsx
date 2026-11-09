import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarClock, CircleAlert, CreditCard, PauseCircle, Wallet, XCircle } from 'lucide-react';
import { Badge, Card, Field, Input, Notice, Select } from '@/components/ui';
import { DonorActionForm } from '@/components/my/donor-action-form';
import { LinkShell } from '@/app/r/[token]/link-shell';
import { loadRecoveryView } from '@/server/services/recurring-recovery';
import { recurringIsMock, recurringStatusLabel, RECURRING_DAY_MAX, RECURRING_DAY_MIN } from '@/server/services/recurring';
import { recoveryCancelAction, recoveryChangeAction, recoveryPauseAction, recoveryRegisterAction } from '@/app/actions/recurring-recovery';
import { formatNumber, formatWon } from '@/lib/money';

/**
 * 정기후원 복구 화면 (2026-11-09). 출금 실패 안내 문자의 개인 링크로만 연다(로그인 없음, noindex).
 * 링크 하나는 그 후원자의 약정 1건만 다룬다. 한 화면에서: 왜 안 됐는지 · 무엇을 하면 되는지 · 다음 출금 예정일
 * + 결제수단 다시 등록 / 출금일·금액 바꾸기 / 이번 달 쉬기(재개 예정일) / 해지.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '기브싸인 정기후원 확인',
  robots: { index: false, follow: false },
};

const CANCEL_REASONS = ['경제적인 사정', '다른 기관을 후원하려고', '후원 금액을 정리하려고', '기타'];

export default async function RecurringRecoveryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const loaded = await loadRecoveryView(token);

  if (!loaded.ok) {
    return (
      <LinkShell>
        <Card>
          <div className="flex items-center gap-2 text-ink-500">
            <CircleAlert size={20} strokeWidth={1.7} />
            <h1 className="text-[16px] font-extrabold text-ink-900">링크를 열 수 없습니다</h1>
          </div>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">{loaded.reason}</p>
          <div className="mt-3">
            <Link href="/my/recurring" className="text-[13px] font-bold text-brand-700 underline">마이페이지 정기후원으로</Link>
          </div>
        </Card>
      </LinkShell>
    );
  }

  const v = loaded.view;
  const st = recurringStatusLabel[v.status];
  const actionRequired = v.recoveryState === 'ACTION_REQUIRED';

  return (
    <LinkShell>
      <div className="space-y-3">
        <Card>
          <p className="text-[12px] font-bold text-ink-400">정기후원</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-[18px] font-black text-ink-900">{v.merchantName}</h1>
            <Badge tone={st.tone}>{st.text}</Badge>
          </div>
          <p className="mt-1 text-[14px] font-bold tabular-nums text-ink-700">매월 {v.dayOfMonth}일 {formatWon(v.amount)}</p>

          <div className="mt-4 space-y-3">
            <div>
              <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-500">
                <CircleAlert size={15} strokeWidth={1.7} /> 왜 출금이 안 됐나요{v.failureLabel ? ` · ${v.failureLabel}` : ''}
              </p>
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink-800">{v.why}</p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-500">
                <Wallet size={15} strokeWidth={1.7} /> 무엇을 하면 되나요
              </p>
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink-800">{v.todo}</p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-500">
                <CalendarClock size={15} strokeWidth={1.7} /> 다음 출금
              </p>
              <p className={`mt-1 text-[13.5px] leading-relaxed ${actionRequired ? 'font-bold text-danger-500' : 'text-ink-800'}`}>{v.nextLine}</p>
            </div>
          </div>
        </Card>

        {recurringIsMock() ? <Notice tone="neutral">현재 mock 결제사입니다. 실제 출금 없이 흐름만 재현합니다.</Notice> : null}

        {v.canRegister ? (
          <Card>
            <h2 className="flex items-center gap-1.5 text-[15px] font-extrabold text-ink-900"><CreditCard size={17} strokeWidth={1.7} /> 결제수단 다시 등록</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
              {v.hasActiveToken ? '지금 쓰는 계좌가 막혔거나 바꾸고 싶다면 새로 등록해 주세요. 등록한 결제수단으로 다음 출금부터 출금합니다.' : '등록된 결제수단이 없습니다. 등록하면 바로 다음 출금 때 출금합니다.'}
            </p>
            <DonorActionForm action={recoveryRegisterAction} submitLabel="결제수단 등록하러 가기" variant={actionRequired ? 'primary' : 'secondary'} size="md" className="mt-3">
              <input type="hidden" name="token" value={token} />
            </DonorActionForm>
          </Card>
        ) : null}

        {v.canChange ? (
          <Card>
            <h2 className="flex items-center gap-1.5 text-[15px] font-extrabold text-ink-900"><CalendarClock size={17} strokeWidth={1.7} /> 출금일·금액 바꾸기</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">급여일 뒤로 출금일을 옮기면 잔액 부족을 줄일 수 있습니다. 바꾸면 약정서 새 판이 만들어집니다.</p>
            <DonorActionForm action={recoveryChangeAction} submitLabel="바꾸기" variant="secondary" size="md" className="mt-3">
              <input type="hidden" name="token" value={token} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="출금일">
                  <Select name="dayOfMonth" defaultValue={String(v.dayOfMonth)}>
                    {Array.from({ length: RECURRING_DAY_MAX - RECURRING_DAY_MIN + 1 }, (_, i) => i + RECURRING_DAY_MIN).map((d) => (
                      <option key={d} value={d}>매월 {d}일</option>
                    ))}
                  </Select>
                </Field>
                <Field label="매월 후원 금액(원)" hint={`${formatNumber(v.amountMin)}원 ~ ${formatNumber(v.amountMax)}원`}>
                  <Input name="amount" inputMode="numeric" defaultValue={String(v.amount)} />
                </Field>
              </div>
            </DonorActionForm>
          </Card>
        ) : null}

        {v.canPause ? (
          <Card>
            <h2 className="flex items-center gap-1.5 text-[15px] font-extrabold text-ink-900"><PauseCircle size={17} strokeWidth={1.7} /> 이번 달 쉬기</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
              다시 시작할 날을 고르면 그때까지 출금하지 않고, 그날 자동으로 다시 시작합니다. 하루 전에 문자로 알려 드립니다.
              {v.resumeOn ? ' 이미 쉬고 있다면 다시 시작할 날만 바뀝니다.' : ''}
            </p>
            <DonorActionForm action={recoveryPauseAction} submitLabel="쉬어 가기" variant="secondary" size="md" className="mt-3">
              <input type="hidden" name="token" value={token} />
              <Field label="다시 시작할 날" hint="그 달 출금일이 그날 이후면 그 달부터, 지났으면 다음 달부터 출금합니다.">
                <Input type="date" name="resumeOn" defaultValue={v.resumeOn ?? v.pauseDefault} min={v.pauseMin} max={v.pauseMax} required />
              </Field>
            </DonorActionForm>
          </Card>
        ) : null}

        {v.canCancel ? (
          <Card>
            <h2 className="flex items-center gap-1.5 text-[15px] font-extrabold text-ink-900"><XCircle size={17} strokeWidth={1.7} /> 해지</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">해지하면 이후 출금은 일어나지 않습니다. 사유는 고르지 않아도 됩니다.</p>
            <DonorActionForm
              action={recoveryCancelAction}
              submitLabel="정기후원 해지"
              variant="ghost"
              size="md"
              className="mt-3"
              confirmMessage={`${v.merchantName} 정기후원을 해지할까요? 이후 출금은 일어나지 않습니다.`}
            >
              <input type="hidden" name="token" value={token} />
              <Field label="해지 사유 (선택)">
                <Select name="reason" defaultValue="">
                  <option value="">고르지 않음</option>
                  {CANCEL_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </Select>
              </Field>
            </DonorActionForm>
          </Card>
        ) : null}

        <p className="text-center text-[12px] text-ink-400">
          로그인해서 보려면 <Link href="/my/recurring" className="font-bold underline">마이페이지 정기후원</Link>
        </p>
      </div>
    </LinkShell>
  );
}
