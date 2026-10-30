import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { featureVolunteerEnabled } from '@/lib/env';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Field, Input, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst, kstDateKey } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { displayPayerName } from '@/lib/payer-name';
import { sourceLabel } from '@/lib/attribution';
import { VOLUNTEER_STATUS_LABEL } from '@/server/services/volunteers';
import { dayLabel, slotLabel } from '@/server/services/agreements';
import { decideVolunteerAction, recordActivityAction } from '@/app/actions/automation';

export const dynamic = 'force-dynamic';

/**
 * 자원봉사 관리 — 신청 승인·배정 → 활동 기록 → 1365 등록 자료 내려받기.
 * 신청은 기관 번호로 "봉사" 문자, 후원페이지, SNS 게시물 링크로 들어온다.
 */
export default async function StudioVolunteersPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  if (!featureVolunteerEnabled()) notFound();
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const tab = sp.tab === 'active' || sp.tab === 'closed' ? sp.tab : 'received';
  const statusFilter = tab === 'received' ? ['RECEIVED'] : tab === 'active' ? ['APPROVED'] : ['REJECTED', 'WITHDRAWN'];
  const today = kstDateKey();
  const monthStart = `${today.slice(0, 7)}-01`;

  const [apps, counts, monthActs, recentActs] = await Promise.all([
    prisma.volunteerApplication.findMany({
      where: { merchantId, status: { in: statusFilter as never } },
      include: { payer: { select: { id: true, displayName: true, phoneMasked: true, volunteerProfile: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.volunteerApplication.groupBy({ by: ['status'], where: { merchantId }, _count: { _all: true } }),
    prisma.volunteerActivity.aggregate({ where: { merchantId, activityDate: { gte: new Date(`${monthStart}T00:00:00Z`) } }, _sum: { minutes: true }, _count: { _all: true } }),
    prisma.volunteerActivity.findMany({ where: { merchantId }, include: { payer: { select: { displayName: true, phoneMasked: true } } }, orderBy: [{ activityDate: 'desc' }, { createdAt: 'desc' }], take: 10 }),
  ]);
  const c = (s: string) => counts.find((x) => x.status === s)?._count._all ?? 0;
  const minutesByPayer = new Map(
    (await prisma.volunteerActivity.groupBy({ by: ['payerId'], where: { merchantId, payerId: { in: apps.map((a) => a.payerId) } }, _sum: { minutes: true } })).map((m) => [m.payerId, m._sum.minutes ?? 0]),
  );

  return (
    <>
      <PageHeader
        title="자원봉사"
        description="문자 '봉사'·후원페이지·SNS 링크로 들어온 신청을 승인하고 일정을 안내합니다. 활동을 기록하면 1365 자원봉사포털 등록 자료로 내려받을 수 있습니다."
        action={<a href={`/api/studio/volunteers/export?from=${monthStart}&to=${today}`} className="text-[13px] font-bold text-brand-700">이번 달 활동 CSV</a>}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="새 신청" value={`${formatNumber(c('RECEIVED'))}건`} tone={c('RECEIVED') ? 'warning' : 'neutral'} />
        <StatTile label="활동 중" value={`${formatNumber(c('APPROVED'))}명`} tone="brand" />
        <StatTile label="이번 달 활동" value={`${formatNumber(monthActs._count._all)}회`} sub={`${((monthActs._sum.minutes ?? 0) / 60).toFixed(1)}시간`} />
        <StatTile label="종료·철회" value={`${formatNumber(c('REJECTED') + c('WITHDRAWN'))}건`} />
      </div>

      <div className="mb-4 flex gap-2">
        {[['received', `새 신청 ${c('RECEIVED')}`], ['active', `활동 중 ${c('APPROVED')}`], ['closed', '종료·철회']].map(([k, label]) => (
          <Link key={k} href={`/studio/volunteers?tab=${k}`} className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold ${tab === k ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600'}`}>{label}</Link>
        ))}
      </div>

      {apps.length === 0 ? (
        <EmptyState title="해당하는 신청이 없습니다" description="기관 번호로 '봉사' 라고 문자를 보내면 신청 링크가 자동으로 회신됩니다." />
      ) : (
        <div className="space-y-3">
          {apps.map((a) => {
            const vp = a.payer.volunteerProfile;
            return (
              <Card key={a.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[15px] font-black text-ink-900">
                      {displayPayerName(a.payer.displayName ?? '')} <span className="ml-1 font-mono text-[12px] font-normal text-ink-400">{a.payer.phoneMasked}</span>
                      <Badge tone={a.status === 'APPROVED' ? 'success' : a.status === 'RECEIVED' ? 'warning' : 'neutral'} className="ml-2">{VOLUNTEER_STATUS_LABEL[a.status]}</Badge>
                    </p>
                    <p className="mt-1 text-[12.5px] text-ink-500">
                      {formatKst(a.createdAt, false)} 신청 · 유입 {sourceLabel(a.source)} {a.agreementDocId ? <>· <Link href={`/studio/agreements/${a.agreementDocId}`} className="font-bold text-brand-700">신청서 보기</Link></> : null}
                    </p>
                  </div>
                  {a.status === 'APPROVED' ? <span className="text-[12.5px] tabular-nums text-ink-500">누적 {((minutesByPayer.get(a.payerId) ?? 0) / 60).toFixed(1)}시간</span> : null}
                </div>
                <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-4">
                  <div><dt className="text-ink-400">분야</dt><dd className="font-semibold">{vp?.interests.join(', ') || '-'}</dd></div>
                  <div><dt className="text-ink-400">가능 요일·시간</dt><dd className="font-semibold">{vp?.availableDays.map(dayLabel).join(' ') || '-'} · {slotLabel(vp?.timeSlot)}</dd></div>
                  <div><dt className="text-ink-400">희망 활동</dt><dd className="font-semibold">{a.wish ?? '-'}</dd></div>
                  <div><dt className="text-ink-400">비상연락처</dt><dd className="font-semibold">{vp?.emergencyName ? `${vp.emergencyName} ${vp.emergencyPhoneMasked ?? ''}` : '-'}</dd></div>
                </dl>
                {a.message ? <p className="mt-2 rounded-xl bg-ink-50 px-3 py-2 text-[13px] text-ink-700">{a.message}</p> : null}
                {vp?.experience ? <p className="mt-2 text-[12.5px] text-ink-500">경력: {vp.experience}</p> : null}
                {a.assignment ? <p className="mt-2 text-[13px] text-ink-700"><b>배정 안내</b> {a.assignment}</p> : null}

                {a.status === 'RECEIVED' ? (
                  <div className="mt-4 grid gap-3 border-t border-ink-100 pt-4 lg:grid-cols-[1fr_auto]">
                    <ActionForm action={decideVolunteerAction} submitLabel="승인하고 안내 보내기" size="sm">
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="decision" value="APPROVE" />
                      <Field label="활동 일정·장소 안내 (문자로 나갑니다)"><Input name="assignment" maxLength={120} placeholder="예: 11/8(토) 10시 복지관 1층 급식실, 앞치마 지참" /></Field>
                      <Field label="내부 메모 (후원자에게 보이지 않음)"><Input name="memo" maxLength={300} /></Field>
                    </ActionForm>
                    <ActionForm action={decideVolunteerAction} submitLabel="반려" variant="ghost" size="sm" confirmMessage="이 신청을 반려합니다. 신청자에게 문자는 보내지 않습니다.">
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="decision" value="REJECT" />
                    </ActionForm>
                  </div>
                ) : null}
                {a.status === 'APPROVED' ? (
                  <div className="mt-4 border-t border-ink-100 pt-4">
                    <ActionForm action={recordActivityAction} submitLabel="활동 기록" size="sm" variant="secondary">
                      <input type="hidden" name="payerId" value={a.payerId} />
                      <div className="grid gap-3 sm:grid-cols-[160px_120px_1fr]">
                        <Field label="활동일"><Input type="date" name="date" defaultValue={today} max={today} /></Field>
                        <Field label="시간"><Input name="hours" inputMode="decimal" defaultValue="2" /></Field>
                        <Field label="활동 내용"><Input name="title" maxLength={100} placeholder="예: 어르신 말벗·도시락 배달" /></Field>
                      </div>
                    </ActionForm>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <Card className="mt-6">
        <h2 className="text-[16px] font-black text-ink-900">최근 활동 기록</h2>
        {recentActs.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-400">아직 기록이 없습니다.</p>
        ) : (
          <><div className="mt-3" /><Table>
            <thead><tr><Th>활동일</Th><Th>봉사자</Th><Th>시간</Th><Th>내용</Th></tr></thead>
            <tbody>
              {recentActs.map((r) => (
                <tr key={r.id}>
                  <Td className="tabular-nums">{r.activityDate.toISOString().slice(0, 10)}</Td>
                  <Td>{displayPayerName(r.payer.displayName ?? '')} <span className="font-mono text-[12px] text-ink-400">{r.payer.phoneMasked}</span></Td>
                  <Td className="tabular-nums">{(r.minutes / 60).toFixed(1)}시간</Td>
                  <Td>{r.title}</Td>
                </tr>
              ))}
            </tbody>
          </Table></>
        )}
        <div className="mt-4"><Notice tone="neutral">1365 자원봉사포털·VMS 는 공개 연동 API 가 없어 기브싸인이 실적을 대신 등록하지 않습니다. 내려받은 CSV 를 참고해 포털에 등록해 주세요. 휴대폰은 마스킹 번호만 담깁니다.</Notice></div>
      </Card>
    </>
  );
}
