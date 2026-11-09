import Link from 'next/link';
import { CalendarClock, CreditCard, History, PauseCircle, PlayCircle, Repeat, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui';
import { formatKst, kstDateKey } from '@/lib/datetime';
import { formatWon } from '@/lib/money';
import { recurringStatusLabel } from '@/server/services/recurring';
import { describeRecurringChange, koDay } from '@/server/services/recurring-change-text';
import { changeActorLabel, changeKindLabel, changeViaLabel } from '@/server/services/recurring-change-log';
import type { SelfServiceRecurringItem } from '@/server/services/donor-self-service';
import {
  RecurringCancelForm,
  RecurringChangeForm,
  RecurringPauseForm,
  RecurringRegisterForm,
  RecurringResumeForm,
} from './self-service-forms';

/**
 * 정기후원 관리 한 화면 — 약정 1건 카드 (2026-11-09 2차 F). 서버 컴포넌트.
 * 금액·출금일 변경 · 쉬어 가기(재개 예정일) · 일시정지 · 다시 시작 · 해지 · 결제수단 다시 등록 · 변경 이력.
 * 정지·재개·해지 미리보기 문장은 여기서 describeRecurringChange 로 계산해 내려 준다.
 */

function addDays(key: string, n: number) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-2xl border border-ink-100 bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-4 text-[17px] font-extrabold text-ink-900">
        {icon}
        <span>{title}</span>
        <span className="ml-auto text-[14px] font-bold text-ink-400 group-open:hidden">열기</span>
        <span className="ml-auto hidden text-[14px] font-bold text-ink-400 group-open:inline">닫기</span>
      </summary>
      <div className="border-t border-ink-100 px-4 pb-4 pt-3">{children}</div>
    </details>
  );
}

const RUN_TEXT: Record<string, string> = { SUCCESS: '출금 완료', FAILED: '실패', PENDING: '결과 확인 중', SKIPPED: '건너뜀' };

export function RecurringManagerCard({ item, code, hasActiveToken, agreementHref }: {
  item: SelfServiceRecurringItem;
  /** 기관 후원 회원 화면이면 기관 코드 */
  code?: string;
  hasActiveToken: boolean;
  agreementHref?: string | null;
}) {
  const today = kstDateKey();
  const st = recurringStatusLabel[item.status];
  const live = item.status !== 'CANCELED';
  const pausePreview = item.status === 'ACTIVE' ? describeRecurringChange(item.before, { action: 'PAUSE' }) : null;
  const resumePreview = item.status === 'PAUSED' || item.status === 'SUSPENDED' ? describeRecurringChange(item.before, { action: 'RESUME' }) : null;
  const cancelPreview = live ? describeRecurringChange(item.before, { action: 'CANCEL' }) : null;
  const pauseDefault = (() => {
    const [y, m] = today.split('-').map(Number);
    return new Date(Date.UTC(y, m, item.dayOfMonth)).toISOString().slice(0, 10);
  })();

  let nowLine: string;
  if (item.status === 'ACTIVE') nowLine = `다음 출금 ${koDay(item.nextChargeOn < today ? today : item.nextChargeOn, today)} · ${formatWon(item.amount)}`;
  else if (item.status === 'PAUSED') nowLine = item.resumeOn ? `쉬는 중 · ${koDay(item.resumeOn, today)}에 다시 시작` : '쉬는 중 · 다시 시작할 때까지 출금하지 않습니다';
  else if (item.status === 'SUSPENDED') nowLine = `출금 실패로 멈춤${item.lastFailure ? ` · ${item.lastFailure}` : ''}`;
  else nowLine = `${formatKst(item.canceledAt, false)} 해지`;

  return (
    <article className="space-y-3 rounded-[24px] border border-ink-100 bg-[#fffdf9] p-4 sm:p-5">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={st.tone} className="text-[13px]">{st.text}</Badge>
          {code ? <span className="text-[17px] font-extrabold text-ink-900">{item.merchantName}</span> : (
            <Link href={`/donate/${item.merchantCode}`} className="text-[17px] font-extrabold text-ink-900">{item.merchantName}</Link>
          )}
          {item.campaignTitle ? <span className="text-[15px] text-ink-500">· {item.campaignTitle}</span> : null}
        </div>
        <p className="text-[22px] font-black tabular-nums text-ink-900">매월 {item.dayOfMonth}일 {formatWon(item.amount)}</p>
        <p className="text-[16px] leading-relaxed text-ink-700">{nowLine}</p>
        <p className="text-[14px] text-ink-500">누적 {formatWon(item.totalAmount)} ({item.successCount}회) · 시작 {formatKst(item.createdAt, false)}{agreementHref ? <> · <Link href={agreementHref} className="font-bold text-brand-700 underline">약정서 보기</Link></> : null}</p>
        {item.before.pending ? <p className="rounded-xl bg-warning-50 px-3 py-2 text-[15px] leading-relaxed text-ink-900">지난 출금 결과를 확인하는 중입니다. 확인될 때까지 다시 출금하지 않고, 금액·출금일 변경은 잠시 보류됩니다.</p> : null}
        {item.recoveryState === 'ACTION_REQUIRED' ? <p className="rounded-xl bg-danger-50 px-3 py-2 text-[15px] leading-relaxed text-danger-500">결제수단에 문제가 있어 출금하지 못했습니다. 아래에서 결제수단을 다시 등록해 주세요.</p> : null}
      </header>

      {live ? (
        <div className="space-y-2">
          <Section icon={<Repeat size={20} strokeWidth={1.7} />} title="금액·출금일 바꾸기">
            <RecurringChangeForm id={item.id} code={code} amount={item.amount.toString()} dayOfMonth={item.dayOfMonth} amountMin={item.amountMin.toString()} amountMax={item.amountMax.toString()} changesLeft={item.changesLeft} />
          </Section>
          {item.status === 'ACTIVE' || item.status === 'PAUSED' ? (
            <Section icon={<PauseCircle size={20} strokeWidth={1.7} />} title={item.status === 'PAUSED' ? '다시 시작할 날 바꾸기' : '잠시 쉬기'}>
              <RecurringPauseForm
                id={item.id}
                code={code}
                defaultDate={item.resumeOn ?? pauseDefault}
                min={addDays(today, 1)}
                max={addDays(today, 180)}
                staticPausePreview={pausePreview?.allowed ? pausePreview.text : null}
                canPauseWithoutDate={item.status === 'ACTIVE'}
              />
            </Section>
          ) : null}
          {resumePreview ? (
            <Section icon={<PlayCircle size={20} strokeWidth={1.7} />} title="다시 시작">
              <RecurringResumeForm id={item.id} code={code} previewText={resumePreview.text} />
              {!hasActiveToken ? <p className="mt-2 text-[15px] text-danger-500">등록된 결제수단이 없어 다시 시작할 수 없습니다. 먼저 결제수단을 등록해 주세요.</p> : null}
            </Section>
          ) : null}
          <Section icon={<CreditCard size={20} strokeWidth={1.7} />} title="결제수단 다시 등록">
            <p className="mb-3 text-[16px] leading-relaxed text-ink-700">{hasActiveToken ? '지금 쓰는 계좌를 바꾸거나 다시 등록할 수 있습니다. 등록한 결제수단으로 다음 출금부터 출금합니다.' : '등록된 결제수단이 없습니다. 등록해야 출금할 수 있습니다.'}</p>
            <RecurringRegisterForm id={item.id} code={code} label="결제수단 등록하러 가기" />
          </Section>
          {cancelPreview?.allowed ? (
            <Section icon={<XCircle size={20} strokeWidth={1.7} />} title="해지">
              <RecurringCancelForm id={item.id} code={code} merchantName={item.merchantName} previewText={cancelPreview.text} />
            </Section>
          ) : null}
        </div>
      ) : null}

      {item.history.length || item.runs.length ? (
        <Section icon={<History size={20} strokeWidth={1.7} />} title="변경·출금 이력">
          {item.history.length ? (
            <div>
              <p className="text-[14px] font-bold text-ink-500">내가 바꾼 내용 (최근 순)</p>
              <ol className="mt-2 space-y-2">
                {item.history.map((h) => (
                  <li key={h.id} className="rounded-xl bg-ink-50 px-3 py-2.5">
                    <p className="text-[15px] font-bold text-ink-900">{formatKst(h.createdAt)} · {changeKindLabel(h.kind)}</p>
                    <p className="mt-0.5 text-[15px] leading-relaxed text-ink-700">{h.summary}</p>
                    <p className="mt-0.5 text-[13px] text-ink-500">{changeActorLabel(h.actor)} · {changeViaLabel(h.via)}{h.reason ? ` · 사유: ${h.reason}` : ''}</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {item.runs.length ? (
            <div className="mt-3">
              <p className="flex items-center gap-1.5 text-[14px] font-bold text-ink-500"><CalendarClock size={16} strokeWidth={1.7} /> 최근 출금</p>
              <ul className="mt-1 divide-y divide-ink-100">
                {item.runs.map((run) => (
                  <li key={run.id} className="flex flex-wrap justify-between gap-2 py-2 text-[15px]">
                    <span className="text-ink-700">{run.monthKey}{run.attempt > 1 ? ` (${run.attempt}차)` : ''} · {formatKst(run.ranAt, false)}</span>
                    <span className={run.status === 'SUCCESS' ? 'font-bold text-success-500' : run.status === 'FAILED' ? 'font-bold text-danger-500' : run.status === 'PENDING' ? 'font-bold text-warning-500' : 'text-ink-500'}>
                      {RUN_TEXT[run.status] ?? run.status}{run.status === 'FAILED' || run.status === 'SKIPPED' ? (run.reason ? ` — ${run.reason}` : '') : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
      ) : null}
    </article>
  );
}
