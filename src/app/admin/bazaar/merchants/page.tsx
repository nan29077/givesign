import { PageHeader } from '@/components/layout/console-shell';
import { Card, EmptyState, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminInput } from '@/components/admin/controls';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { adminBazaarContext, ADMIN_BAZAAR_TABS } from '@/server/admin-bazaar-context';
import { doneeVerified } from '@/server/services/receipts';
import { decideParticipationAction } from '@/app/actions/admin/bazaar';
import { participationLabel } from '@/lib/bazaar';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function AdminBazaarMerchants() {
  await adminBazaarContext();
  const rows = await prisma.merchantBazaar.findMany({
    orderBy: [{ status: 'asc' }, { appliedAt: 'desc' }],
    include: { merchant: { select: { id: true, displayName: true, code: true, status: true, designatedDonee: true, designatedDoneeVerifiedAt: true, designatedDoneeUntil: true, businessNo: true } } },
  });
  return (
    <>
      <PageHeader title="참여 기관" description="위탁판매에 동의하고 참여를 신청한 기관입니다. 승인하고 공익법인 지정 확인이 끝난 기관만 매칭 대상이 됩니다." />
      <BazaarSubNav items={ADMIN_BAZAAR_TABS} current="/admin/bazaar/merchants" />
      <Card>
        {rows.length === 0 ? <EmptyState title="참여 신청한 기관이 없습니다" description="기관 콘솔 > 라이브 바자회에서 신청합니다." /> : (
          <Table>
            <thead><tr><Th>기관</Th><Th>공익법인 확인</Th><Th>위탁판매 동의</Th><Th>필요 물품</Th><Th>상태</Th><Th>처리</Th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.merchantId}>
                <Td>{r.merchant.displayName}<span className="block font-mono text-[11px] text-ink-400">{r.merchant.code}{r.mailOrderRegNo ? ` · 통신판매 ${r.mailOrderRegNo}` : ''}</span></Td>
                <Td>{doneeVerified(r.merchant) ? '확인됨' : <span className="text-danger-500">미확인</span>}</Td>
                <Td className="text-[12px]">{r.consignmentName}<span className="block text-ink-400">{formatKst(r.consignmentAgreedAt, false)} (판 {r.consignmentVersion})</span></Td>
                <Td className="max-w-[220px] text-[12px]">{r.neededItems ?? '-'}</Td>
                <Td><LabelBadge map={participationLabel} value={r.status} />{r.note ? <span className="block text-[11px] text-ink-400">{r.note}</span> : null}</Td>
                <Td>
                  <div className="flex flex-col gap-2">
                    {r.status !== 'APPROVED' ? <ActionForm action={decideParticipationAction} submitLabel="승인" compact><input type="hidden" name="merchantId" value={r.merchantId} /><input type="hidden" name="decision" value="APPROVED" /></ActionForm> : null}
                    {r.status === 'APPLIED' ? <ActionForm action={decideParticipationAction} submitLabel="반려" variant="secondary" compact confirm="참여 신청을 반려할까요?"><input type="hidden" name="merchantId" value={r.merchantId} /><input type="hidden" name="decision" value="REJECTED" /><AdminInput name="note" placeholder="반려 사유" /></ActionForm> : null}
                    {r.status === 'APPROVED' ? <ActionForm action={decideParticipationAction} submitLabel="정지" variant="danger" compact confirm="이 기관의 바자회 참여를 정지할까요? 새 매칭에서 빠지고, 응답 대기 중인 매칭 제안은 철회됩니다. 진행 중인 건의 가액 확정·검수 확정·편성 승인도 멈춥니다."><input type="hidden" name="merchantId" value={r.merchantId} /><input type="hidden" name="decision" value="SUSPENDED" /><AdminInput name="note" placeholder="정지 사유" /></ActionForm> : null}
                  </div>
                </Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
