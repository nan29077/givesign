import Link from 'next/link';
import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { prisma } from '@/server/db';
import { Badge, Card, EmptyState } from '@/components/ui';
import { DonorActionForm } from '@/components/my/donor-action-form';
import { toggleNoticeOptOutAction } from '@/app/actions/volunteer';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/** 내 약정서·신청서 + 기관별 월간 안내 수신 설정 */
export default async function MyAgreementsPage() {
  const { payerId } = await requirePayerContext('/my/agreements');
  if (!payerId) return <EmptyState title={NO_PAYER_TITLE} description={NO_PAYER_DESC} />;
  const [docs, links] = await Promise.all([
    prisma.agreementDocument.findMany({ where: { payerId }, include: { merchant: { select: { displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.payerMerchantLink.findMany({ where: { payerId }, include: { merchant: { select: { id: true, displayName: true } } }, orderBy: { lastDonatedAt: 'desc' } }),
  ]);
  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-[16px] font-black text-ink-900">내 약정서·신청서</h2>
        <p className="mt-1 text-[13px] text-ink-500">정기후원 약정·자원봉사 신청 때 작성한 문서입니다. 약정을 바꾸면 새 판이 만들어집니다.</p>
        {docs.length === 0 ? <p className="mt-4 text-[13px] text-ink-400">아직 작성한 문서가 없습니다.</p> : (
          <ul className="mt-3 divide-y divide-ink-100">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-[14px] font-bold text-ink-900">{d.merchant.displayName} {d.title} <Badge className="ml-1">제{d.version}판</Badge></p>
                  <p className="text-[12px] text-ink-400">{d.docNo} · {formatKst(d.createdAt, false)}</p>
                </div>
                <Link href={`/my/agreements/${d.id}`} className="text-[13px] font-bold text-brand-700">열람</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <h2 className="text-[16px] font-black text-ink-900">월간 후원 안내 받기</h2>
        <p className="mt-1 text-[13px] text-ink-500">매월 1일 지난달 후원 내역과 올해 누적을 카카오 알림톡(또는 문자)으로 알려 드립니다. 출금·영수증 안내는 설정과 관계없이 계속 보내 드립니다.</p>
        <ul className="mt-3 divide-y divide-ink-100">
          {links.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 py-3">
              <span className="text-[14px] font-semibold">{l.merchant.displayName} {l.noticeOptOutAt ? <Badge>받지 않음</Badge> : <Badge tone="success">받음</Badge>}</span>
              <DonorActionForm action={toggleNoticeOptOutAction} submitLabel={l.noticeOptOutAt ? '다시 받기' : '그만 받기'} size="sm" variant="secondary">
                <input type="hidden" name="merchantId" value={l.merchant.id} />
                <input type="hidden" name="optOut" value={l.noticeOptOutAt ? '0' : '1'} />
              </DonorActionForm>
            </li>
          ))}
          {links.length === 0 ? <li className="py-3 text-[13px] text-ink-400">후원한 기관이 아직 없습니다.</li> : null}
        </ul>
      </Card>
    </div>
  );
}
