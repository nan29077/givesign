import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, DataRow, Field, Input, Notice, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { aiDraftAvailability } from '@/server/services/ai-drafts';
import {
  IMPACT_REPORT_MAX,
  IMPACT_STATUS_LABEL,
  RECIPIENT_EXCLUDE_LABEL,
  getImpactUpdate,
  impactFacts,
  impactRecipients,
  type RecipientExcludeReason,
} from '@/server/services/impact-reports';
import { ImpactForm } from '@/components/studio/impact/impact-form';
import {
  addExpenseAction,
  approveImpactAction,
  archiveExpenseAction,
  archiveImpactAction,
  generateImpactReportAction,
  reopenImpactAction,
  requestImpactSendAction,
  restoreImpactAction,
  saveImpactReportAction,
  setImpactPublicAction,
} from '@/app/actions/impact';

export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = { AI: 'AI 초안', RULE: '규칙 문안', EDITED: '담당자 수정' };

export default async function ImpactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const u = await getImpactUpdate(merchantId, id);
  if (!u) notFound();
  const [campaigns, facts, rec, sendRequests, issuedCount] = await Promise.all([
    prisma.campaign.findMany({ where: { merchantId, status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'desc' }, select: { id: true, title: true } }),
    impactFacts(u),
    impactRecipients(u),
    prisma.approvalRequest.findMany({ where: { merchantId, kind: 'IMPACT_REPORT_SEND', subjectId: u.id }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, status: true, result: true, createdAt: true } }),
    prisma.issuedDocument.count({ where: { merchantId, purpose: 'IMPACT_REPORT', subjectType: 'impact_update', subjectId: u.id } }),
  ]);
  const campaignTitle = u.campaignId ? (campaigns.find((c) => c.id === u.campaignId)?.title ?? (await prisma.campaign.findUnique({ where: { id: u.campaignId }, select: { title: true } }))?.title ?? '캠페인') : '기관 일반 후원';
  const st = IMPACT_STATUS_LABEL[u.status] ?? { text: u.status, tone: 'neutral' as const };
  const draft = u.status === 'DRAFT' && !u.archivedAt;
  const ai = aiDraftAvailability();
  const openSend = sendRequests.find((r) => ['PENDING', 'PROCESSING', 'QUEUED'].includes(r.status));
  const excluded = (Object.keys(rec.excluded) as RecipientExcludeReason[]).filter((k) => rec.excluded[k] > 0);
  const dk = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  return (
    <>
      <Link href="/studio/impact" className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900">
        <ChevronLeft size={15} strokeWidth={1.8} />
        사업 진행·결과 보고
      </Link>
      <PageHeader title={u.title} description={`${campaignTitle} · 만든 날 ${formatKst(u.createdAt, false)}`} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={st.tone}>{st.text}</Badge>
        {u.archivedAt ? <Badge tone="neutral">보관됨</Badge> : null}
        {u.publicVisible ? <Badge tone="success">후원페이지 공개</Badge> : <Badge tone="neutral">후원페이지 비공개</Badge>}
        {u.sentAt ? <span className="text-[12px] text-ink-400">발송 완료 {formatKst(u.sentAt, false)}</span> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          {draft ? (
            <Card>
              <CardTitle>진행 기록</CardTitle>
              <div className="mt-3">
                <ImpactForm
                  campaigns={campaigns}
                  initial={{ id: u.id, campaignId: u.campaignId, title: u.title, body: u.body, photos: u.photos, periodFrom: dk(u.periodFrom), periodTo: dk(u.periodTo), photoRuleAck: Boolean(u.photoRuleAckAt) }}
                />
              </div>
            </Card>
          ) : (
            <Card>
              <CardTitle>진행 기록</CardTitle>
              <p className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-800">{u.body}</p>
              {u.photos.length ? (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {u.photos.map((p) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={p} src={p} alt="진행 사진" className="aspect-square w-full rounded-xl object-cover" />
                  ))}
                </div>
              ) : null}
            </Card>
          )}

          <Card>
            <CardTitle>집행 내역</CardTitle>
            <p className="mt-0.5 text-[12px] text-ink-400">법정 서류의 후원금 사용 명세와 같은 표입니다(따로 다시 적지 않습니다). 지정 용도 = {campaignTitle}.</p>
            {u.expenses.length === 0 ? (
              <p className="mt-2 text-[12.5px] text-ink-400">아직 집행 내역이 없습니다.</p>
            ) : (
              <ul className="mt-2 divide-y divide-ink-100">
                {u.expenses.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
                    <span className="min-w-0 break-keep"><span className="text-ink-400">{dk(e.usedOn)}</span> {e.description}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-semibold tabular-nums">{formatWon(e.amount)}</span>
                      {draft ? (
                        <ActionForm action={archiveExpenseAction} submitLabel="보관" size="sm" variant="ghost">
                          <input type="hidden" name="id" value={e.id} />
                          <input type="hidden" name="impactUpdateId" value={u.id} />
                        </ActionForm>
                      ) : null}
                    </span>
                  </li>
                ))}
                <li className="flex justify-between py-2 text-[13px] font-bold"><span>집행 합계</span><span className="tabular-nums">{formatWon(facts.expenseTotal)}</span></li>
              </ul>
            )}
            {draft ? (
              <div className="mt-3 rounded-xl bg-ink-50 p-3">
                <ActionForm action={addExpenseAction} submitLabel="집행 내역 넣기" size="sm">
                  <input type="hidden" name="impactUpdateId" value={u.id} />
                  <div className="grid gap-2 sm:grid-cols-[140px_1fr_140px]">
                    <Input type="date" name="usedOn" required aria-label="사용일" />
                    <Input name="description" required maxLength={120} placeholder="사용 내역(예: 연탄 구입)" aria-label="사용 내역" />
                    <Input name="amount" required inputMode="numeric" placeholder="금액(원)" aria-label="금액" />
                  </div>
                </ActionForm>
              </div>
            ) : null}
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>후원자용 보고서</CardTitle>
              {u.reportSource ? <Badge tone="neutral">{SOURCE_LABEL[u.reportSource] ?? u.reportSource}</Badge> : null}
            </div>
            <p className="mt-0.5 text-[12px] text-ink-400">
              캠페인 전체 결과만 씁니다. 숫자는 기관이 입력한 값과 원천 합계만 씁니다(AI 가 새 숫자를 만들면 거절하고 규칙 문안으로 바꿉니다). 받는 분의 후원 횟수·합계는 보낼 때 따로 채웁니다.
              {ai.available ? '' : ' AI 공급자가 연결되지 않아 규칙 문안으로 만듭니다.'}
            </p>
            {draft ? (
              <>
                <div className="mt-3">
                  <ActionForm action={generateImpactReportAction} submitLabel={ai.available ? '보고서 초안 만들기(AI)' : '보고서 초안 만들기(규칙 문안)'} variant="secondary" size="sm" confirmMessage={u.report ? '지금 보고서 내용을 새 초안으로 바꿉니다.' : undefined}>
                    <input type="hidden" name="id" value={u.id} />
                  </ActionForm>
                </div>
                <div className="mt-3">
                  <ActionForm action={saveImpactReportAction} submitLabel="보고서 저장" size="sm">
                    <input type="hidden" name="id" value={u.id} />
                    <Field label="보고서 본문" hint={`${IMPACT_REPORT_MAX}자 이내 · 후원 권유 문구·링크·개인별 사용처 문장은 저장되지 않습니다.`}>
                      <Textarea name="report" rows={12} maxLength={IMPACT_REPORT_MAX} defaultValue={u.report ?? ''} />
                    </Field>
                  </ActionForm>
                </div>
              </>
            ) : (
              <p className="mt-3 whitespace-pre-wrap rounded-xl bg-ink-50 p-3 text-[13px] leading-relaxed text-ink-800">{u.report}</p>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardTitle>숫자 근거(원천)</CardTitle>
            <div className="mt-2 space-y-1">
              <DataRow label="기브싸인 후원(환불 제외)" value={`${formatNumber(facts.chargeCount)}건 · ${formatWon(facts.chargeTotal)}`} />
              <DataRow label="계좌이체 확정분" value={`${formatNumber(facts.offlineCount)}건 · ${formatWon(facts.offlineTotal)}`} />
              <DataRow label="집행 합계" value={`${formatNumber(facts.expenseCount)}건 · ${formatWon(facts.expenseTotal)}`} />
            </div>
            <p className="mt-2 text-[11.5px] text-ink-400">기브싸인 결제와 기관 통장 계좌이체는 합치지 않고 나눠 보입니다.</p>
          </Card>

          <Card>
            <CardTitle>승인·발송</CardTitle>
            <div className="mt-2 space-y-1">
              <DataRow label="보낼 대상(참여 후원자)" value={`${formatNumber(rec.recipients.length)}명`} />
              <DataRow label="이미 받은 분" value={`${formatNumber(issuedCount)}명`} />
              {excluded.map((k) => (
                <DataRow key={k} label={`제외: ${RECIPIENT_EXCLUDE_LABEL[k]}`} value={`${formatNumber(rec.excluded[k])}명`} />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {draft ? (
                <ActionForm action={approveImpactAction} submitLabel="담당자 승인" confirmMessage="이 내용으로 승인합니다. 승인 뒤에는 고치려면 '다시 고치기' 를 눌러야 합니다.">
                  <input type="hidden" name="id" value={u.id} />
                </ActionForm>
              ) : null}
              {!u.archivedAt && (u.status === 'APPROVED' || u.status === 'SENT') && !openSend ? (
                <ActionForm action={requestImpactSendAction} submitLabel={u.status === 'SENT' ? '새로 참여한 분께 보내기' : '참여 후원자에게 보내기'} confirmMessage="승인 대기함에 발송 요청을 올립니다. 표본 3건·대상 수를 확인하고 승인하면 배치가 나눠 보냅니다.">
                  <input type="hidden" name="id" value={u.id} />
                </ActionForm>
              ) : null}
              {u.status === 'APPROVED' && !openSend && !u.archivedAt ? (
                <ActionForm action={reopenImpactAction} submitLabel="다시 고치기" variant="ghost">
                  <input type="hidden" name="id" value={u.id} />
                </ActionForm>
              ) : null}
            </div>
            {openSend ? (
              <div className="mt-3">
                <Notice tone="brand" title="발송 요청이 승인 대기함에 있습니다">
                  상태: {openSend.status}{openSend.result ? ` · ${openSend.result}` : ''}. <Link href={`/studio/inbox/approvals/${openSend.id}`} className="font-semibold underline">확인하러 가기</Link>
                </Notice>
              </div>
            ) : null}
            {sendRequests.filter((r) => r !== openSend).slice(0, 3).map((r) => (
              <p key={r.id} className="mt-2 text-[11.5px] text-ink-400">{formatKst(r.createdAt, false)} 요청 · {r.status}{r.result ? ` · ${r.result}` : ''}</p>
            ))}
          </Card>

          <Card>
            <CardTitle>후원페이지 공개</CardTitle>
            <p className="mt-1 text-[12.5px] text-ink-500">공개하면 승인된 기록(보고서·사진)이 캠페인 상세에 보입니다. 기본은 공개하지 않습니다.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionForm action={setImpactPublicAction} submitLabel={u.publicVisible ? '공개 끄기' : '공개하기'} variant="secondary" size="sm" confirmMessage={u.publicVisible ? undefined : '승인된 기록을 후원페이지 캠페인 상세에 공개합니다. 수혜자 실사진·실명이 없는지 다시 확인해 주세요.'}>
                <input type="hidden" name="id" value={u.id} />
                <input type="hidden" name="visible" value={u.publicVisible ? '0' : '1'} />
              </ActionForm>
            </div>
            {u.publicVisible && u.status === 'DRAFT' ? <p className="mt-2 text-[11.5px] text-warning-500">작성 중이라 아직 보이지 않습니다(승인 뒤 보입니다).</p> : null}
          </Card>

          <Card>
            {u.archivedAt ? (
              <ActionForm action={restoreImpactAction} submitLabel="되살리기" variant="secondary" size="sm">
                <input type="hidden" name="id" value={u.id} />
              </ActionForm>
            ) : (
              <ActionForm action={archiveImpactAction} submitLabel="보관" variant="ghost" size="sm" confirmMessage="보관하면 목록·후원페이지에서 숨깁니다(되살릴 수 있습니다).">
                <input type="hidden" name="id" value={u.id} />
              </ActionForm>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
