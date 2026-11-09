import Link from 'next/link';
import { ChevronLeft, FileStack, Layers } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, Select, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import {
  BUNDLE_ITEM_STATE_LABEL,
  listBundleSends,
  listBundles,
  type BundleItemState,
} from '@/server/services/document-bundles';
import { BUNDLE_TARGET_LABEL, bundleUnitsPerRecipient, edocForecastFor } from '@/server/services/document-bundle-approvals';
import { EDocForecastBox } from '@/components/studio/edoc-forecast';
import {
  requestBundleSendAction,
  resendBundleLinkAction,
  retryBundleSendAction,
  setBundleForRecurringAction,
  setBundleItemRequiredAction,
} from '@/app/actions/document-bundles';

export const dynamic = 'force-dynamic';

const SEND_STATUS: Record<string, { text: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  PREPARING: { text: '준비 중', tone: 'neutral' },
  BLOCKED: { text: '멈춤', tone: 'warning' },
  SENT: { text: '서명 대기', tone: 'brand' },
  COMPLETED: { text: '모두 서명', tone: 'success' },
  CLOSED: { text: '닫힘(거절·만료)', tone: 'danger' },
};

/**
 * 업무별 문서 묶음 (2026-11-12 4차 J2). 정기후원 신청·봉사 신청에 필요한 문서를 한 번의 본인확인으로 받는다.
 * 묶음 정의·약정 흐름 설정·대량 발송(승인 대기함 확인 → 배치)·발송별 문서 상태(미열람·열람 후 미서명·거절·입력 오류).
 */
export default async function DocumentBundlesPage() {
  const { merchantId } = await requireMerchant();
  const bundles = await listBundles(merchantId);
  const sends = await listBundleSends(merchantId, { take: 60 });
  const units = new Map(await Promise.all(bundles.map(async (b) => [b.id, await bundleUnitsPerRecipient(b.id)] as const)));
  const oneForecast = await edocForecastFor(merchantId, Math.max(...[...units.values(), 1]));
  const totals = Object.fromEntries(Object.keys(BUNDLE_ITEM_STATE_LABEL).map((k) => [k, sends.reduce((a, s) => a + s.counts[k as BundleItemState], 0)])) as Record<BundleItemState, number>;

  return (
    <>
      <Link href="/studio/agreements" className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900">
        <ChevronLeft size={15} strokeWidth={1.8} />
        약정서·신청서
      </Link>
      <PageHeader
        title="업무별 문서 묶음"
        description="정기후원 신청·자원봉사 신청에 필요한 문서를 묶어 보냅니다. 후원자는 본인확인 한 번으로 한 화면에서 순서대로 확인·서명합니다."
      />
      <Notice tone="neutral" title="이용요금">
        묶음 안 서명 문서마다 전자문서 1건이 차감됩니다(현재 요금 규칙 그대로). 약정서는 약정 흐름이 보낸 서명 요청을 함께 보여 줄 뿐 새로 차감하지 않습니다.
      </Notice>

      <div className="my-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="미열람" value={`${formatNumber(totals.UNVIEWED)}건`} />
        <StatTile label="열람 후 미서명" value={`${formatNumber(totals.VIEWED)}건`} tone="warning" />
        <StatTile label="거절" value={`${formatNumber(totals.DECLINED)}건`} tone="danger" />
        <StatTile label="입력 오류·발송 대기" value={`${formatNumber(totals.INPUT_ERROR + totals.WAITING)}건`} sub="최근 묶음 발송 60건 기준" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {bundles.map((b) => (
          <Card key={b.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-1.5">
                <Layers size={18} strokeWidth={1.7} className="text-brand-700" /> {b.name}
              </CardTitle>
              <Badge tone="neutral">{b.kindLabel}</Badge>
            </div>
            <p className="mt-1 text-[12px] text-ink-400">
              발송 {formatNumber(b.sends.total)}건 · 모두 서명 {formatNumber(b.sends.completed)} · 서명 대기 {formatNumber(b.sends.open)} · 멈춤 {formatNumber(b.sends.blocked)}
            </p>
            <ol className="mt-3 space-y-1.5">
              {b.items.map((it, i) => (
                <li key={it.purpose} className="flex flex-wrap items-center gap-2 rounded-xl border border-ink-100 px-3 py-2 text-[12.5px]">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-ink-100 text-[11px] font-bold text-ink-600">{i + 1}</span>
                  <span className="min-w-0 flex-1 font-semibold text-ink-900">{it.label}</span>
                  <Badge tone={it.required ? 'brand' : 'neutral'}>{it.required ? '필수' : '선택'}</Badge>
                  {it.template ? (
                    <Link href={`/studio/documents/${it.template.id}`} className="text-[11.5px] font-bold text-ink-500 underline">
                      서식{it.template.active ? '' : ' (중지)'}
                    </Link>
                  ) : (
                    <span className="text-[11.5px] text-ink-400">{it.purpose === 'SUPPORT_AGREEMENT' ? '약정 흐름' : '기본 서식'}</span>
                  )}
                  {it.problem ? <p className="w-full pl-7 text-[11.5px] text-warning-500">{it.problem}</p> : null}
                  {i > 0 ? (
                    <div className="w-full pl-7">
                      <ActionForm action={setBundleItemRequiredAction} submitLabel={it.required ? '선택 문서로' : '필수 문서로'} variant="ghost" className="space-y-0">
                        <input type="hidden" name="bundleId" value={b.id} />
                        <input type="hidden" name="purpose" value={it.purpose} />
                        <input type="hidden" name="required" value={it.required ? '0' : '1'} />
                      </ActionForm>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>

            {b.kind === 'RECURRING_SIGNUP' ? (
              <div className="mt-3 rounded-xl bg-ink-50 px-3 py-2.5 text-[12.5px]">
                <p className="font-bold text-ink-800">정기후원 약정 때 함께 보내기: {b.useForRecurring ? '켜짐' : '꺼짐(기본 — 약정서만)'}</p>
                <p className="mt-0.5 text-[11.5px] text-ink-500">켜면 새 정기후원 약정마다 이 묶음 링크를 보냅니다. 약정서는 약정 흐름이 보낸 서명 요청을 묶음 화면에서 함께 보여 줍니다.</p>
                <div className="mt-2">
                  <ActionForm
                    action={setBundleForRecurringAction}
                    submitLabel={b.useForRecurring ? '끄기' : '켜기'}
                    variant={b.useForRecurring ? 'secondary' : 'primary'}
                    confirmMessage={b.useForRecurring ? '끄면 새 약정에는 약정서만 보냅니다.' : '켜면 새 정기후원 약정마다 묶음 문서가 함께 나가고, 문서마다 이용요금이 차감됩니다.'}
                  >
                    <input type="hidden" name="bundleId" value={b.id} />
                    <input type="hidden" name="on" value={b.useForRecurring ? '0' : '1'} />
                  </ActionForm>
                </div>
              </div>
            ) : null}

            <div className="mt-3 border-t border-ink-100 pt-3">
              <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-800">
                <FileStack size={16} strokeWidth={1.7} /> 지금 있는 분들께 보내기
              </p>
              <p className="mt-0.5 text-[11.5px] text-ink-500">
                이미 이 묶음을 받은 분·탈퇴·차단된 분은 빠집니다. 승인 대기함에서 대상 수와 이용요금 예측을 확인한 뒤 승인하면 보냅니다. 1명당 서명 문서 {units.get(b.id) ?? 0}건.
              </p>
              <ActionForm action={requestBundleSendAction} submitLabel="승인 대기함에 올리기" className="mt-2">
                <input type="hidden" name="bundleId" value={b.id} />
                <Select name="target" defaultValue={b.kind === 'VOLUNTEER_SIGNUP' ? 'VOLUNTEER_APPROVED' : 'RECURRING_ACTIVE'} aria-label="보낼 대상" className="h-10 text-[13px]">
                  {b.kind === 'VOLUNTEER_SIGNUP' ? (
                    <option value="VOLUNTEER_APPROVED">{BUNDLE_TARGET_LABEL.VOLUNTEER_APPROVED}</option>
                  ) : (
                    <option value="RECURRING_ACTIVE">{BUNDLE_TARGET_LABEL.RECURRING_ACTIVE}</option>
                  )}
                </Select>
              </ActionForm>
            </div>
          </Card>
        ))}
      </div>

      <Card className="mt-4">
        <CardTitle>지금 잔액으로 한 명에게 보내면</CardTitle>
        <EDocForecastBox forecast={oneForecast} className="mt-2" />
      </Card>

      <h2 className="mb-2 mt-8 text-[15px] font-bold text-ink-900">최근 묶음 발송</h2>
      {sends.length === 0 ? (
        <EmptyState title="아직 보낸 묶음이 없습니다" description="위에서 대상에게 보내거나, 정기후원 약정 때 함께 보내기를 켜면 여기에 쌓입니다." />
      ) : (
        <ul className="space-y-2">
          {sends.map((s) => {
            const st = SEND_STATUS[s.status] ?? { text: s.status, tone: 'neutral' as const };
            return (
              <li key={s.id} className="card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold text-ink-900">{s.payerLabel}</span>
                  <Badge tone={st.tone}>{st.text}</Badge>
                  <span className="text-[11.5px] text-ink-400">{s.bundleName} · {formatKst(s.sentAt ?? s.createdAt, false)}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.items.map((it) => (
                    <span key={it.id} className="inline-flex items-center gap-1 rounded-lg border border-ink-100 px-2 py-1 text-[11.5px]">
                      <span className="font-semibold text-ink-700">{it.label}</span>
                      <Badge tone={BUNDLE_ITEM_STATE_LABEL[it.state].tone}>{BUNDLE_ITEM_STATE_LABEL[it.state].text}</Badge>
                      {it.latest === false ? <Badge tone="warning">이전 판</Badge> : null}
                    </span>
                  ))}
                </div>
                {s.missing.length && s.status !== 'COMPLETED' ? (
                  <p className="mt-1.5 text-[11.5px] text-ink-500">빠진 문서: {s.missing.join(', ')}</p>
                ) : null}
                {s.blockedReason ? <p className="mt-1 text-[11.5px] text-warning-500">{s.blockedReason}</p> : null}
                {s.items.filter((i) => i.state === 'INPUT_ERROR' && i.error).map((i) => (
                  <p key={i.id} className="mt-0.5 text-[11.5px] text-danger-500">{i.label}: {i.error}</p>
                ))}
                <div className="mt-2 flex flex-wrap gap-2">
                  {s.status === 'SENT' ? (
                    <ActionForm action={resendBundleLinkAction} submitLabel="링크 다시 보내기" variant="secondary" confirmMessage="새 링크를 보내면 이전 링크는 열리지 않습니다(하루 3번까지)." className="space-y-0">
                      <input type="hidden" name="sendId" value={s.id} />
                    </ActionForm>
                  ) : null}
                  {s.status === 'BLOCKED' && s.blocked !== 'EDOC_BALANCE' ? (
                    <ActionForm action={retryBundleSendAction} submitLabel="고친 뒤 다시 보내기" variant="secondary" className="space-y-0">
                      <input type="hidden" name="sendId" value={s.id} />
                    </ActionForm>
                  ) : null}
                  {s.status === 'BLOCKED' && s.blocked === 'EDOC_BALANCE' ? (
                    <Link href="/studio/document-billing" className="text-[12px] font-bold text-brand-700 underline">충전하면 자동으로 이어서 보냅니다</Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
