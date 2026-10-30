import Link from 'next/link';
import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { prisma } from '@/server/db';
import { Badge, Card, EmptyState } from '@/components/ui';
import { DonorActionForm } from '@/components/my/donor-action-form';
import { withdrawVolunteerAction } from '@/app/actions/volunteer';
import { VOLUNTEER_STATUS_LABEL } from '@/server/services/volunteers';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/** 내 자원봉사 — 신청 상태 · 배정 안내 · 활동 기록 */
export default async function MyVolunteerPage() {
  const { payerId } = await requirePayerContext('/my/volunteer');
  if (!payerId) return <EmptyState title={NO_PAYER_TITLE} description={NO_PAYER_DESC} />;
  const [apps, acts] = await Promise.all([
    prisma.volunteerApplication.findMany({ where: { payerId }, include: { merchant: { select: { displayName: true, code: true } } }, orderBy: { createdAt: 'desc' } }),
    prisma.volunteerActivity.findMany({ where: { payerId }, include: { merchant: { select: { displayName: true } } }, orderBy: { activityDate: 'desc' }, take: 50 }),
  ]);
  const total = acts.reduce((a, r) => a + r.minutes, 0);
  return (
    <div className="space-y-4">
      <Card>
        <p className="text-[12px] font-bold text-ink-400">내 자원봉사</p>
        <p className="mt-1 text-[22px] font-black text-ink-900 tabular-nums">{(total / 60).toFixed(1)}시간</p>
        <p className="text-[12.5px] text-ink-500">기관이 기록한 활동 합계입니다. 공식 실적은 1365 자원봉사포털 기준입니다.</p>
      </Card>
      {apps.length === 0 ? (
        <EmptyState title="아직 신청한 자원봉사가 없습니다" description="기관 번호로 '봉사' 라고 문자를 보내거나 기관 후원페이지에서 신청할 수 있습니다." />
      ) : (
        apps.map((a) => (
          <Card key={a.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[15px] font-black text-ink-900">{a.merchant.displayName} <Badge tone={a.status === 'APPROVED' ? 'success' : a.status === 'RECEIVED' ? 'warning' : 'neutral'} className="ml-1">{VOLUNTEER_STATUS_LABEL[a.status]}</Badge></p>
                <p className="text-[12px] text-ink-400">{formatKst(a.createdAt, false)} 신청 {a.agreementDocId ? <>· <Link href={`/my/agreements/${a.agreementDocId}`} className="font-bold text-brand-700">신청서</Link></> : null}</p>
              </div>
              {a.status === 'RECEIVED' || a.status === 'APPROVED' ? (
                <DonorActionForm action={withdrawVolunteerAction} submitLabel="신청 철회" size="sm" variant="ghost" confirmMessage="자원봉사 신청을 철회할까요?">
                  <input type="hidden" name="id" value={a.id} />
                </DonorActionForm>
              ) : null}
            </div>
            {a.assignment ? <p className="mt-3 rounded-xl bg-brand-50 px-3 py-2 text-[13px] text-ink-800"><b>배정 안내</b> {a.assignment}</p> : a.status === 'RECEIVED' ? <p className="mt-3 text-[13px] text-ink-500">기관이 확인한 뒤 활동 일정을 문자로 안내해 드립니다.</p> : null}
          </Card>
        ))
      )}
      {acts.length ? (
        <Card>
          <h2 className="text-[15px] font-black text-ink-900">활동 기록</h2>
          <ul className="mt-2 divide-y divide-ink-100 text-[13px]">
            {acts.map((r) => (
              <li key={r.id} className="flex justify-between py-2.5"><span>{r.activityDate.toISOString().slice(0, 10)} · {r.merchant.displayName} · {r.title}</span><span className="tabular-nums font-semibold">{(r.minutes / 60).toFixed(1)}시간</span></li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
