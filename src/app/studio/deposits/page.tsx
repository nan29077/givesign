import Link from 'next/link';
import { Landmark } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Checkbox, EmptyState, Field, Input, Notice, SectionTitle, Select, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionForm, InlineActionForm } from '@/components/studio/action-form';
import { DepositUploadForm } from '@/components/studio/deposits/upload-form';
import { DepositReviewForm, type ReviewRow } from '@/components/studio/deposits/review-form';
import {
  depositIgnoreOneAction,
  depositNewDonorAction,
  depositUnignoreAction,
  offlinePledgeArchiveAction,
  offlinePledgeSaveAction,
  offlineRevertAction,
  receiptIncludeOfflineAction,
} from '@/app/actions/deposits';
import { depositOverview, loadMatchContext, offlineMonthTotal, pledgeStatusThisMonth } from '@/server/services/deposits';
import { formatKst, kstMonthKey } from '@/lib/datetime';
import { bankFeedStatus } from '@/server/services/bank-feed';
import { formatNumber, formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

const PLEDGE_STATUS = {
  RECEIVED: { text: '입금됨', tone: 'success' as const },
  MISSING: { text: '이번 달 입금 안 됨', tone: 'danger' as const },
  NOT_YET: { text: '입금일 전', tone: 'neutral' as const },
};

/**
 * 입금 맞추기 (2026-11-09 E).
 *
 * 기관 통장으로 바로 들어온 계좌이체·CMS 후원을 거래내역 파일로 후원자와 맞춘다.
 * 파일 올리기 → 결과 요약(자동 확정·확인 필요·모름) → 확인 필요 한 번에 확정·무시 → 이번 달 계좌이체 약정 미입금.
 * 기브싸인이 받은 돈이 아니라 정산·후원 내역(결제)·캠페인 모금액 숫자는 바뀌지 않는다.
 */
export default async function StudioDepositsPage() {
  const { merchantId } = await requireMerchant();
  const [ov, month, pledges, ctx, campaigns] = await Promise.all([
    depositOverview(merchantId),
    offlineMonthTotal(merchantId),
    pledgeStatusThisMonth(merchantId),
    loadMatchContext(merchantId),
    prisma.campaign.findMany({ where: { merchantId, status: { in: ['ACTIVE', 'CLOSED'] }, archivedAt: null }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, title: true } }),
  ]);
  const suggested = ov.pending.filter((d) => d.status === 'SUGGESTED');
  const unmatched = ov.pending.filter((d) => d.status === 'UNMATCHED');
  const reviewRows: ReviewRow[] = suggested.map((d) => ({
    id: d.id,
    occurredAt: formatKst(d.occurredAt, false),
    depositorName: d.depositorName,
    memo: d.memo,
    amount: d.amount.toString(),
    duplicateWarning: d.duplicateWarning,
    candidates: d.candidates.map((c) => ({ key: c.key, name: c.name, phoneMasked: c.phoneMasked, reason: c.reason })),
  }));
  const payerOptions = [...ctx.candidates.values()]
    .filter((c) => c.payerId)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    .slice(0, 500);
  const missing = pledges.filter((p) => p.status === 'MISSING');
  const feed = await bankFeedStatus(merchantId).catch(() => null); // 5차 L3 계좌 자동 조회 상태

  return (
    <>
      <PageHeader
        title="입금 맞추기"
        description="기관 통장 거래내역 파일을 올리면 계좌이체·CMS 입금을 후원자와 맞춰 기록합니다. 확정한 입금만 후원자 기록에 남습니다."
      />

      <div className="mb-4">
        <Notice tone="brand" title="기브싸인 결제와 따로 셉니다">
          통장으로 바로 들어온 돈은 기브싸인이 받은 돈이 아니어서 정산·후원 내역·캠페인 모금액에는 들어가지 않습니다. 후원자별 현황과 대시보드에는 &quot;계좌이체&quot; 로 나눠 보입니다. 감사 안내는{' '}
          <Link href="/studio/journeys" className="font-bold underline">자동 안내</Link> 의 &quot;계좌이체 확인분에도 보내기&quot; 를 켰을 때만 나갑니다(기본 끔).
        </Notice>
      </div>

      {feed ? (
        <div className="mb-4">
          <Notice tone="neutral" title="계좌 거래내역 자동 조회">
            {!feed.enabled || feed.mock
              ? '연동 안 됨 — 오픈뱅킹·펌뱅킹 계약 전이라 거래내역 파일을 올려 주세요. 연동되면 하루 한 번 자동으로 가져와 같은 규칙으로 맞춥니다.'
              : feed.link?.enabled
                ? `마지막 조회 ${feed.link.lastSyncedAt ? formatKst(feed.link.lastSyncedAt, false) : '-'} · ${feed.link.lastMessage ?? feed.link.lastResult ?? ''}`
                : '이 기관은 자동 조회가 연결되지 않았습니다. 관리자에게 연결을 요청해 주세요.'}
          </Notice>
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="확인 필요" value={`${formatNumber(suggested.length)}건`} tone={suggested.length ? 'warning' : 'neutral'} sub="후보가 있는 입금" />
        <StatTile label="맞는 후원자 없음" value={`${formatNumber(unmatched.length)}건`} sub="연결하거나 무시" />
        <StatTile label={`${kstMonthKey()} 계좌이체 확정`} value={formatWon(month.amount)} tone="brand" sub={`${formatNumber(month.count)}건`} />
        <StatTile label="이번 달 약정 미입금" value={`${formatNumber(missing.length)}명`} tone={missing.length ? 'danger' : 'neutral'} sub={`계좌이체 약정 ${formatNumber(pledges.length)}명`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <SectionTitle title="거래내역 파일 올리기" description="국민·신한·우리·하나·농협 등 내보내기 형식의 열 이름을 자동으로 알아봅니다. 같은 파일·같은 입금은 두 번 들어가지 않습니다." />
            <DepositUploadForm />
          </Card>

          <Card>
            <SectionTitle title={`확인 필요 ${suggested.length}건`} description="이름이 같거나 비슷한 후원자가 있지만 자동으로 확정하지 않은 입금입니다. 맞으면 체크해서 한 번에 확정하세요." />
            {reviewRows.length ? (
              <DepositReviewForm rows={reviewRows} campaigns={campaigns} />
            ) : (
              <EmptyState title="확인할 입금이 없습니다" />
            )}
          </Card>

          <Card>
            <SectionTitle title="맞는 후원자 없음 · 다른 후원자로 연결" description="이름·휴대폰 번호를 적으면 같은 번호의 후원자와 잇고, 없으면 새로 등록합니다(기관 명단에도 남습니다). 후원이 아닌 입금은 무시로 표시하세요." />
            {ov.pending.length === 0 ? (
              <EmptyState title="남은 입금이 없습니다" />
            ) : (
              <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100">
                {[...unmatched, ...suggested].map((d) => (
                  <li key={d.id} className="p-3">
                    <details open={d.status === 'UNMATCHED' && unmatched.length <= 5}>
                      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-[13px]">
                        <span className="font-bold text-ink-900">{d.depositorName}</span>
                        <span className="tabular-nums text-ink-700">{formatWon(d.amount)}</span>
                        <span className="text-[11.5px] text-ink-400">{formatKst(d.occurredAt, false)}{d.memo ? ` · ${d.memo}` : ''}</span>
                        <Badge tone={d.status === 'UNMATCHED' ? 'neutral' : 'warning'}>{d.status === 'UNMATCHED' ? '모름' : '확인 필요'}</Badge>
                      </summary>
                      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                        <ActionForm action={depositNewDonorAction} submitLabel="후원자 연결·확정" size="sm" className="grid gap-2 sm:grid-cols-2">
                          <input type="hidden" name="depositId" value={d.id} />
                          <Field label="이름">
                            <Input name="name" defaultValue={d.depositorName.startsWith('(') ? '' : d.depositorName} maxLength={30} required />
                          </Field>
                          <Field label="휴대폰 번호">
                            <Input name="phone" inputMode="tel" placeholder="010-0000-0000" required />
                          </Field>
                        </ActionForm>
                        <InlineActionForm action={depositIgnoreOneAction} submitLabel="후원 아님" fields={{ depositId: d.id }} />
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card padded={false} className="overflow-hidden">
            <div className="p-4 pb-2">
              <SectionTitle title="최근 확정한 계좌이체" description="잘못 맞췄으면 되돌리세요. 기록은 지우지 않고 '되돌림' 으로 남습니다. 이미 발급된 기부금영수증에 들어간 건이면 영수증 정정 필요로 표시됩니다." />
            </div>
            {ov.matched.length === 0 ? (
              <div className="p-4 pt-0">
                <EmptyState title="확정한 계좌이체가 없습니다" />
              </div>
            ) : (
              <Table className="min-w-[760px]">
                <thead>
                  <tr>
                    <Th>후원일</Th>
                    <Th>후원자</Th>
                    <Th>금액</Th>
                    <Th>방법</Th>
                    <Th>상태</Th>
                    <Th>되돌리기</Th>
                  </tr>
                </thead>
                <tbody>
                  {ov.matched.map((m) => (
                    <tr key={m.id}>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(m.donatedAt, false)}</Td>
                      <Td>
                        <span className="font-semibold text-ink-900">{m.donorName}</span>
                        <span className="block text-[11.5px] text-ink-400">{m.payer.phoneMasked}{m.deposit ? ` · 통장 ${m.deposit.depositorName}` : ''}</span>
                      </Td>
                      <Td className="tabular-nums font-semibold">{formatWon(m.amount)}</Td>
                      <Td>{m.source === 'MANUAL' ? '직접 입력' : m.autoMatched ? <Badge tone="success">자동 확정</Badge> : '담당자 확정'}</Td>
                      <Td>
                        {m.status === 'CONFIRMED' ? <Badge tone="brand">확정</Badge> : <Badge tone="neutral">되돌림</Badge>}
                        {m.receipt ? <span className="block text-[11px] text-ink-400">영수증 {m.receipt.receiptNo}{m.status === 'REVERTED' && m.receipt.status === 'ISSUED' ? ' · 정정 필요' : ''}</span> : null}
                      </Td>
                      <Td>
                        {m.status === 'CONFIRMED' ? (
                          <ActionForm action={offlineRevertAction} submitLabel="되돌리기" variant="secondary" size="sm" confirmMessage="이 계좌이체 확정을 취소합니다. 진행 중인 감사 안내도 멈춥니다." className="flex flex-wrap items-end gap-1.5 space-y-0">
                            <input type="hidden" name="offlineDonationId" value={m.id} />
                            <Input name="reason" placeholder="이유" maxLength={200} required className="h-9 w-[130px] text-[12.5px]" />
                          </ActionForm>
                        ) : (
                          <span className="text-[11.5px] text-ink-400">{m.revertReason}</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <SectionTitle title="이번 달 계좌이체 약정" description="기관이 받아 둔 '매월 N일 경 M원 계좌이체' 약속입니다. 자동 확정의 근거와 미입금 확인에만 쓰고 출금은 하지 않습니다." />
            {pledges.length === 0 ? (
              <p className="text-[12.5px] text-ink-400">등록한 약정이 없습니다.</p>
            ) : (
              <ul className="space-y-2">
                {pledges.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-2 rounded-xl border border-ink-100 p-2.5">
                    <span className="min-w-0 text-[12.5px]">
                      <span className="block font-bold text-ink-900">{p.name} <span className="font-normal text-ink-400">{p.phoneMasked}</span></span>
                      <span className="block text-ink-500">매월 {p.dayOfMonth}일 경 {formatWon(p.amount)}</span>
                      <Badge tone={PLEDGE_STATUS[p.status].tone}>{PLEDGE_STATUS[p.status].text}</Badge>
                    </span>
                    <InlineActionForm action={offlinePledgeArchiveAction} submitLabel="보관" variant="ghost" fields={{ pledgeId: p.id }} confirmMessage="이 약정을 보관합니다. 지난 입금 기록은 그대로 남습니다." />
                  </li>
                ))}
              </ul>
            )}
            <details className="mt-3">
              <summary className="cursor-pointer text-[13px] font-bold text-ink-700">약정 등록·고치기</summary>
              <ActionForm action={offlinePledgeSaveAction} submitLabel="약정 저장" size="sm" className="mt-3">
                <Field label="후원자" hint="목록에 없으면 비워 두고 아래에 이름·휴대폰 번호를 적으세요. 이미 약정이 있는 후원자는 금액·날짜를 고칩니다.">
                  <Select name="payerId" defaultValue="">
                    <option value="">직접 입력</option>
                    {payerOptions.map((c) => (
                      <option key={c.key} value={c.payerId!}>
                        {c.name} · {c.phoneMasked}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="이름">
                    <Input name="name" maxLength={30} />
                  </Field>
                  <Field label="휴대폰">
                    <Input name="phone" inputMode="tel" />
                  </Field>
                  <Field label="금액(원)" required>
                    <Input name="amount" inputMode="numeric" required />
                  </Field>
                  <Field label="매월 입금일" required>
                    <Input name="dayOfMonth" type="number" min={1} max={31} required />
                  </Field>
                </div>
                {campaigns.length ? (
                  <Field label="캠페인(선택)">
                    <Select name="campaignId" defaultValue="">
                      <option value="">없음</option>
                      {campaigns.map((c) => (
                        <option key={c.id} value={c.id}>{c.title}</option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <Field label="메모(선택)">
                  <Input name="memo" maxLength={100} />
                </Field>
              </ActionForm>
            </details>
          </Card>

          <Card>
            <SectionTitle title="기부금영수증 합산" description="기관이 이미 다른 곳에서 계좌이체분 영수증을 발급했을 수 있어 기본은 끔입니다." />
            <ActionForm action={receiptIncludeOfflineAction} submitLabel="저장" size="sm" variant="secondary">
              <Checkbox
                name="receiptIncludeOffline"
                defaultChecked={ov.receiptIncludeOffline}
                label="확정한 계좌이체 후원을 기부금영수증에 합산"
                description="켜면 영수증 발급·연간 준비·홈택스 명세에 포함됩니다. 이미 발급된 영수증은 바뀌지 않고, 확정 취소된 건은 '정정 필요' 로 표시됩니다(자동 무효 없음)."
              />
            </ActionForm>
          </Card>

          <Card>
            <SectionTitle title="올린 파일" />
            {ov.imports.length === 0 ? (
              <p className="flex items-center gap-2 text-[12.5px] text-ink-400"><Landmark size={16} strokeWidth={1.7} /> 아직 올린 파일이 없습니다.</p>
            ) : (
              <ul className="space-y-2 text-[12px]">
                {ov.imports.map((i) => (
                  <li key={i.id} className="rounded-xl border border-ink-100 p-2.5">
                    <span className="block truncate font-semibold text-ink-900">{i.fileName}</span>
                    <span className="block text-ink-500">
                      {formatKst(i.createdAt, false)} · {i.format} · 입금 {i.rowCount}건 (새로 {i.newCount} · 중복 {i.duplicateCount})
                    </span>
                    <span className="block text-ink-400">자동 확정 {i.autoMatchedCount} · 확인 필요 {i.suggestedCount} · 모름 {i.unmatchedCount}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {ov.ignored.length ? (
            <Card>
              <SectionTitle title="무시한 입금" description="최근 20건" />
              <ul className="space-y-2 text-[12px]">
                {ov.ignored.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{d.depositorName} · {formatWon(d.amount)} · {formatKst(d.occurredAt, false)}</span>
                    <InlineActionForm action={depositUnignoreAction} submitLabel="되살리기" variant="ghost" fields={{ depositId: d.id }} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
