import Link from 'next/link';
import { Download, TriangleAlert } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, DataRow, Input, Notice, Select, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { kstDateKey } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { INCOME_SOURCE_LABEL, LEGAL_NOTICE, legalSummary } from '@/server/services/legal-reports';
import { INTERNAL_FILE_KINDS, LEGAL_FILE_LABEL, legalYearOptions, type LegalFileKind } from '@/server/services/legal-report-files';
import { annualNoticeTargets } from '@/server/services/impact-legal-approvals';
import { addExpenseAction, archiveExpenseAction } from '@/app/actions/impact';
import { requestAnnualNoticeAction, saveLegalSettingAction } from '@/app/actions/legal-reports';

export const dynamic = 'force-dynamic';

const PUBLIC_KINDS: LegalFileKind[] = ['report-pdf', 'report-csv', 'public-pdf', 'public-csv'];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * 법정 서류 (2026-11-09 3차 H2) — 사회복지법인 및 사회복지시설 재무·회계 규칙 제41조의4~7 작성 보조.
 * 법령 서식과 대조 필요(확정 전). 제출·게시를 대신하지 않는다.
 */
export default async function LegalReportsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const years = legalYearOptions();
  const nowYear = years[0]!;
  const year = years.includes(Number(sp.year)) ? Number(sp.year) : nowYear - 1;
  const [s, notice, campaigns, openNotice] = await Promise.all([
    legalSummary(merchantId, year),
    annualNoticeTargets(merchantId, year),
    prisma.campaign.findMany({ where: { merchantId, status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'desc' }, select: { id: true, title: true } }),
    prisma.approvalRequest.findFirst({ where: { merchantId, kind: 'ANNUAL_NOTICE_SEND', subjectId: String(year), status: { in: ['PENDING', 'PROCESSING', 'QUEUED'] } }, select: { id: true, status: true, result: true } }),
  ]);
  const { income, usage, warnings, setting } = s;
  const excludedCount = Object.values(notice.excluded).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader title="법정 서류" description="후원금 수입·사용 명세와 결과 보고서, 영수증 발급 대장, 공개용 게시 판, 후원자 연 1회 통보를 한곳에서 준비합니다." />
      <div className="mb-4">
        <Notice tone="warning" title="법령 서식과 대조 필요 · 법무·세무 확인 필요">
          {LEGAL_NOTICE} 근거: 사회복지법인 및 사회복지시설 재무·회계 규칙 제41조의4(영수증·발급 대장), 제41조의5(연 1회 이상 통보), 제41조의6(별지 제19호서식 결과 보고·3개월 공개·후원자 성명 비공개), 제41조의7(지정 용도 외 사용 금지) — 작업자가 확인한 요약입니다.
        </Notice>
      </div>

      <nav className="mb-4 flex flex-wrap gap-2" aria-label="연도">
        {years.map((y) => (
          <Link key={y} href={`/studio/reports/legal?year=${y}`} aria-current={y === year ? 'page' : undefined} className={`rounded-xl px-3 py-1.5 text-[13px] font-bold ${y === year ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600 hover:text-ink-900'}`}>
            {y}년{y === nowYear ? '(진행 중)' : ''}
          </Link>
        ))}
      </nav>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="수입 합계" value={formatWon(income.total)} sub={`${formatNumber(income.rows.length)}건`} tone="brand" />
        <StatTile label="지정 / 비지정" value={formatWon(income.designated)} sub={`비지정 ${formatWon(income.undesignated)}`} />
        <StatTile label="사용 합계" value={formatWon(usage.total)} sub={`${formatNumber(usage.rows.length)}건`} />
        <StatTile label="용도 확인 필요" value={`${formatNumber(warnings.length)}건`} tone={warnings.length ? 'warning' : 'success'} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>수입 요약(출처별)</CardTitle>
          <div className="mt-2 space-y-1">
            {(['CHARGE', 'OFFLINE', 'IN_KIND'] as const).map((k) => (
              <DataRow key={k} label={INCOME_SOURCE_LABEL[k]} value={`${formatNumber(income.bySource[k].count)}건 · ${formatWon(income.bySource[k].amount)}`} />
            ))}
          </div>
          <p className="mt-2 text-[11.5px] text-ink-400">기브싸인 결제는 결제 성공 건(환불 제외, 기부금영수증과 같은 기준), 계좌이체는 입금 맞추기 확정분(영수증 합산 설정과 무관), 현물은 발급된 현물 기부금영수증입니다.</p>
        </Card>
        <Card>
          <CardTitle>지정 용도 확인</CardTitle>
          {warnings.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-ink-500">지정 후원금 용도와 사용이 어긋난 곳이 보이지 않습니다.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {warnings.map((w, i) => (
                <li key={`${w.kind}:${w.campaignId ?? ''}:${i}`} className="flex gap-2 rounded-xl bg-warning-50 p-2.5 text-[12.5px] text-ink-800">
                  <TriangleAlert size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-warning-500" aria-hidden />
                  <span>{w.message}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11.5px] text-ink-400">캠페인 지정 수입(그해 말까지 누적)보다 사용이 많거나, 비지정 사용이 비지정 수입보다 많거나, 진행 기록과 다른 용도로 적은 집행이 있으면 알려 드립니다. 막지는 않습니다.</p>
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle>서류 내려받기 — {year}년</CardTitle>
        <p className="mt-0.5 text-[12px] text-ink-400">내려받을 때마다 지금 원천으로 새로 만들고 감사로그를 남깁니다. 결과 보고서·공개용 판을 내려받으면 결산 시기 알림이 닫힙니다. 공개·제출용 판에는 후원자 이름이 없습니다.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {PUBLIC_KINDS.map((k) => (
            <form key={k} method="post" action="/api/studio/reports/legal">
              <input type="hidden" name="kind" value={k} />
              <input type="hidden" name="year" value={year} />
              <button type="submit" className="flex w-full items-center gap-2 rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-left text-[13px] font-semibold text-ink-900 hover:border-ink-400">
                <Download size={16} strokeWidth={1.7} aria-hidden />
                {LEGAL_FILE_LABEL[k]}
              </button>
            </form>
          ))}
        </div>
        <div className="mt-4 rounded-xl bg-ink-50 p-3">
          <p className="text-[13px] font-bold text-ink-900">내부용(외부 공개 금지) — 기관 계정만, 사유 필요</p>
          <p className="mt-0.5 text-[11.5px] text-ink-400">마스킹 이름·마스킹 주민등록번호만 들어갑니다(원문·연락처 없음).</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {INTERNAL_FILE_KINDS.map((k) => (
              <form key={k} method="post" action="/api/studio/reports/legal" className="flex flex-col gap-1.5">
                <input type="hidden" name="kind" value={k} />
                <input type="hidden" name="year" value={year} />
                <Input name="reason" required minLength={2} maxLength={200} placeholder="내려받는 사유(예: 결산 대조)" aria-label="내려받는 사유" className="h-10" />
                <button type="submit" className="flex items-center gap-2 rounded-xl border border-ink-200 bg-white px-3 py-2 text-left text-[13px] font-semibold text-ink-900 hover:border-ink-400">
                  <Download size={16} strokeWidth={1.7} aria-hidden />
                  {LEGAL_FILE_LABEL[k]}
                </button>
              </form>
            ))}
          </div>
        </div>
      </Card>

      <Card className="mt-4">
        <CardTitle>후원자 연 1회 통보 — {year}년</CardTitle>
        <p className="mt-0.5 text-[12px] text-ink-400">본인 후원 합계와 기관 전체 사용 요약을 전자문서(정보성, 서명 없음)로 보냅니다. 승인 대기함에서 표본·대상 수를 확인하고 승인하면 나눠 보냅니다. 같은 후원자에게는 한 해 한 번만 보냅니다. 정기간행물·홈페이지로 일괄 통보하는 기관은 보내지 않아도 됩니다(법령 서식과 대조 필요).</p>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          <DataRow label="그해 수입이 있는 후원자" value={`${formatNumber(notice.recipients.length)}명`} />
          <DataRow label="이미 받은 분" value={`${formatNumber(notice.alreadySent)}명`} />
          <DataRow label="보낼 대상" value={`${formatNumber(notice.pending.length)}명`} />
          <DataRow label="제외(탈퇴·차단·수신 거부)" value={`${formatNumber(excludedCount)}명`} />
        </div>
        <div className="mt-3">
          {openNotice ? (
            <Notice tone="brand" title="통보 요청이 승인 대기함에 있습니다">
              상태: {openNotice.status}{openNotice.result ? ` · ${openNotice.result}` : ''}. <Link href={`/studio/inbox/approvals/${openNotice.id}`} className="font-semibold underline">확인하러 가기</Link>
            </Notice>
          ) : year >= nowYear ? (
            <p className="text-[12.5px] text-ink-500">진행 중인 해는 끝난 뒤(다음 해)에 보낼 수 있습니다.</p>
          ) : (
            <ActionForm action={requestAnnualNoticeAction} submitLabel={`${year}년 통보 승인 요청`} confirmMessage="승인 대기함에 연간 통보 발송 요청을 올립니다.">
              <input type="hidden" name="year" value={year} />
            </ActionForm>
          )}
        </div>
      </Card>

      <Card className="mt-4">
        <CardTitle>후원금 사용 명세 — {year}년</CardTitle>
        <p className="mt-0.5 text-[12px] text-ink-400">사업 진행 기록의 집행 내역도 여기에 함께 보입니다(같은 표). 진행 기록과 상관없는 사용만 여기서 넣으세요.</p>
        <div className="mt-3 rounded-xl bg-ink-50 p-3">
          <ActionForm action={addExpenseAction} submitLabel="사용 내역 넣기" size="sm">
            <div className="grid gap-2 md:grid-cols-[140px_1fr_200px_140px]">
              <Input type="date" name="usedOn" required aria-label="사용일" />
              <Input name="description" required maxLength={120} placeholder="사용 내역" aria-label="사용 내역" />
              <Select name="campaignId" defaultValue="" aria-label="지정 용도">
                <option value="">비지정(기관 일반)</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </Select>
              <Input name="amount" required inputMode="numeric" placeholder="금액(원)" aria-label="금액" />
            </div>
          </ActionForm>
        </div>
        {usage.rows.length === 0 ? (
          <p className="mt-3 text-[12.5px] text-ink-400">{year}년 사용 내역이 없습니다.</p>
        ) : (
          <div className="mt-3">
            <Table className="min-w-[640px]">
              <thead>
                <tr><Th>사용일</Th><Th>사용 내역</Th><Th>지정 용도</Th><Th className="text-right">금액</Th><Th>관리</Th></tr>
              </thead>
              <tbody>
                {usage.rows.map((r) => (
                  <tr key={r.id}>
                    <Td>{r.date}</Td>
                    <Td>{r.description}</Td>
                    <Td>{r.designation}</Td>
                    <Td className="text-right tabular-nums">{formatWon(r.amount)}</Td>
                    <Td>
                      {r.impactUpdateId ? (
                        <Link href={`/studio/impact/${r.impactUpdateId}`} className="text-[12px] font-semibold text-brand-700 hover:underline">진행 기록</Link>
                      ) : (
                        <ActionForm action={archiveExpenseAction} submitLabel="보관" size="sm" variant="ghost">
                          <input type="hidden" name="id" value={r.id} />
                        </ActionForm>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      <Card className="mt-4">
        <CardTitle>수입 명세 미리보기(공개용 — 이름 없음)</CardTitle>
        {income.rows.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-ink-400">{year}년 수입이 없습니다.</p>
        ) : (
          <div className="mt-3">
            <Table className="min-w-[560px]">
              <thead>
                <tr><Th>일자</Th><Th>출처</Th><Th>후원자 구분</Th><Th>지정/비지정</Th><Th className="text-right">금액</Th></tr>
              </thead>
              <tbody>
                {income.rows.slice(0, 50).map((r, i) => (
                  <tr key={`${r.date}:${i}`}>
                    <Td>{r.date}</Td>
                    <Td><Badge tone={r.source === 'CHARGE' ? 'brand' : 'neutral'}>{INCOME_SOURCE_LABEL[r.source]}</Badge></Td>
                    <Td>{r.donorKind}</Td>
                    <Td>{r.designation}</Td>
                    <Td className="text-right tabular-nums">{formatWon(r.amount)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {income.rows.length > 50 ? <p className="mt-2 text-[11.5px] text-ink-400">앞 50건만 보입니다. 전체는 내려받아 확인하세요.</p> : null}
          </div>
        )}
        <p className="mt-2 text-[11.5px] text-ink-400">기브싸인 결제·계좌이체 후원자는 휴대폰 번호로 식별되는 개인으로 봅니다. 단체 구분은 아직 기록하지 않습니다(결정 필요).</p>
      </Card>

      <Card className="mt-4">
        <CardTitle>결산 시기 알림</CardTitle>
        <p className="mt-0.5 text-[12px] text-ink-400">이 기간에 지난해 결과 보고서를 내려받지 않았으면 승인 대기함에 「법정 서류 준비」가 보입니다. 지금 설정: {setting.seasonStartMonth}월~{setting.seasonEndMonth}월{setting.preparedYear ? ` · ${setting.preparedYear}년 준비 완료(${kstDateKey(setting.preparedAt ?? new Date())})` : ''}.</p>
        <div className="mt-3">
          <ActionForm action={saveLegalSettingAction} submitLabel="저장" size="sm">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <Select name="seasonStartMonth" defaultValue={String(setting.seasonStartMonth)} aria-label="시작 달" className="h-10 w-24">
                {MONTHS.map((m) => <option key={m} value={m}>{m}월</option>)}
              </Select>
              <span>부터</span>
              <Select name="seasonEndMonth" defaultValue={String(setting.seasonEndMonth)} aria-label="끝 달" className="h-10 w-24">
                {MONTHS.map((m) => <option key={m} value={m}>{m}월</option>)}
              </Select>
              <span>까지</span>
            </div>
          </ActionForm>
        </div>
      </Card>
    </>
  );
}
