import Link from 'next/link';
import { CircleAlert, CircleCheck, Circle } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Input, Notice, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { automationReadiness, inboxItems, type InboxItem } from '@/server/services/inbox';
import { decideApprovalAction, retryApprovalAction } from '@/app/actions/journeys';

export const dynamic = 'force-dynamic';

/**
 * 승인 대기함.
 *
 * 기브싸인이 준비해 둔 일(자동 안내 승인 단계·영수증 일괄 발급)과 사람이 확인해야 하는 일(콘텐츠 검토·자원봉사 신청·제출 문서·신고)을
 * 한 곳에 모은다. 승인 요청은 여기서 바로 승인·반려하고, 나머지는 해당 화면으로 이동해 처리한다.
 * 위쪽 준비도는 자동화가 멈추는 이유(빠진 기관 정보·채널·서식)를 보여 준다.
 */
export default async function StudioInboxPage() {
  const { merchantId } = await requireMerchant();
  const [{ actions, waiting, blocked }, readiness] = await Promise.all([inboxItems(merchantId), automationReadiness(merchantId)]);
  const missing = readiness.items.filter((i) => !i.ok);

  return (
    <>
      <PageHeader
        title="승인 대기함"
        description="기브싸인이 자동으로 준비한 일 중 기관의 확인이 필요한 것과, 담당자가 처리해야 하는 일을 한 곳에 모았습니다."
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="승인·처리할 일" value={`${formatNumber(actions.length)}건`} tone={actions.length ? 'warning' : 'success'} />
        <StatTile label="기다리는 일" value={`${formatNumber(waiting.length)}건`} sub="후원자·관리자 차례" />
        <StatTile label="막힌 일" value={`${formatNumber(blocked.length)}건`} tone={blocked.length ? 'danger' : 'neutral'} />
        <StatTile
          label="자동화 준비"
          value={readiness.requiredMissing ? `필수 ${readiness.requiredMissing}개 빠짐` : '필수 항목 완료'}
          tone={readiness.requiredMissing ? 'danger' : 'success'}
          sub={readiness.recommendedMissing ? `권장 ${readiness.recommendedMissing}개` : undefined}
        />
      </div>

      {missing.length ? (
        <Card className="mb-5">
          <h2 className="text-[16px] font-black text-ink-900">자동화 준비도</h2>
          <p className="mt-1 text-[12.5px] text-ink-500">빠진 항목이 있으면 그 부분의 자동화가 멈추거나 대체 방식으로 동작합니다.</p>
          <ul className="mt-3 divide-y divide-ink-100">
            {readiness.items.map((i) => (
              <li key={i.key} className="flex items-start gap-3 py-2.5">
                {i.ok ? (
                  <CircleCheck size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-success-500" aria-hidden />
                ) : i.required ? (
                  <CircleAlert size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-danger-500" aria-hidden />
                ) : (
                  <Circle size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-300" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-ink-900">
                    {i.label} {!i.ok ? <Badge tone={i.required ? 'danger' : 'neutral'} className="ml-1">{i.required ? '필수' : '권장'}</Badge> : null}
                  </p>
                  {!i.ok && i.impact ? <p className="text-[12px] leading-relaxed text-ink-500">{i.impact}</p> : null}
                </div>
                {!i.ok ? <Link href={i.href} className="shrink-0 text-[12.5px] font-semibold text-brand-700 hover:underline">설정</Link> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Section title="승인·처리할 일" empty="지금 처리할 일이 없습니다." items={actions} />
      <Section title="기다리는 일" empty="기다리는 일이 없습니다." items={waiting} muted />
      <Section title="막힌 일 (최근 14일)" empty="막힌 일이 없습니다." items={blocked} muted />

      <Notice tone="neutral">
        자동 안내의 승인 단계와 기준은 <Link href="/studio/journeys" className="font-semibold underline">자동 안내</Link>에서 바꿀 수 있습니다.
        반려한 안내는 그 단계만 건너뛰고, 나머지 단계는 그대로 진행됩니다.
      </Notice>
    </>
  );
}

function Section({ title, items, empty, muted }: { title: string; items: InboxItem[]; empty: string; muted?: boolean }) {
  return (
    <Card className="mb-5">
      <h2 className="text-[16px] font-black text-ink-900">
        {title} <span className="text-[13px] font-semibold text-ink-400">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-400">{empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink-100">
          {items.map((it) => (
            <li key={it.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={muted ? 'neutral' : 'brand'}>{it.kindLabel}</Badge>
                  <span className="text-[12px] text-ink-400">{formatKst(it.at, false)}</span>
                </div>
                <p className="mt-1 text-[13.5px] font-semibold text-ink-900">{it.title}</p>
                {it.summary ? <p className="text-[12.5px] text-ink-500">{it.summary}</p> : null}
                {it.error ? <p className="text-[12px] text-danger-500">지난 처리 실패: {it.error}</p> : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {it.approvalId ? (
                  <>
                    <ActionForm action={decideApprovalAction} submitLabel="승인" size="sm" confirmMessage={`「${it.title}」 을(를) 승인합니다.`}>
                      <input type="hidden" name="id" value={it.approvalId} />
                      <input type="hidden" name="decision" value="APPROVE" />
                    </ActionForm>
                    <ActionForm action={decideApprovalAction} submitLabel="반려" variant="ghost" size="sm" confirmMessage="반려하면 이 단계는 보내지 않습니다.">
                      <input type="hidden" name="id" value={it.approvalId} />
                      <input type="hidden" name="decision" value="REJECT" />
                      <Input name="note" placeholder="반려 사유(선택)" aria-label="반려 사유" className="h-9 w-40" />
                    </ActionForm>
                  </>
                ) : null}
                {it.retryApprovalId ? (
                  <ActionForm action={retryApprovalAction} submitLabel="다시 실행" size="sm" confirmMessage="실패한 부분부터 다시 실행합니다. 이미 발급된 건은 다시 발급하지 않습니다.">
                    <input type="hidden" name="id" value={it.retryApprovalId} />
                  </ActionForm>
                ) : null}
                <Link href={it.href} className="text-[12.5px] font-semibold text-brand-700 hover:underline">열기</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
