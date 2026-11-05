import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Notice, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminInput, AdminSelect, FilterBar } from '@/components/admin/controls';
import { requireAdmin } from '@/server/auth';
import { prisma } from '@/server/db';
import { receiptAmountOf } from '@/server/services/bazaar';
import { reissueReceiptAction, voidReceiptAction } from '@/app/actions/admin/bazaar';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/**
 * 현물 기부금영수증 정정(무효·재발급).
 * 발급된 현물 영수증은 법정 서류라 서비스 스위치와 무관하게 이 화면에서 정정할 수 있다(2026-11-06 점검 낮음).
 * 꺼져 있을 때 다른 서비스 문구를 보이지 않도록 "현물 기부금영수증" 으로만 부른다. 처리는 최고관리자만.
 */
export default async function InKindReceiptsAdminPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const admin = await requireAdmin();
  const superAdmin = admin.adminPermission === 'SUPER_ADMIN';
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const status = sp.status === 'VOID' || sp.status === 'ISSUED' ? sp.status : undefined;
  const receipts = await prisma.inKindReceipt.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(q ? { OR: [{ receiptNo: { contains: q } }, { donation: { donationNo: { contains: q } } }] } : {}),
    },
    orderBy: { issuedAt: 'desc' },
    take: 100,
    include: {
      merchant: { select: { displayName: true } },
      donor: { select: { displayName: true } },
      donation: { select: { id: true, donationNo: true, status: true, items: { include: { product: { select: { returnedQty: true } } } } } },
    },
  });
  // 재발급 대상: 발급 상태 영수증이 없는 검수 확정 이후 기부 건(무효 처리만 된 건)
  const donationIds = [...new Set(receipts.map((r) => r.donationId))];
  const issued = new Set((await prisma.inKindReceipt.findMany({ where: { donationId: { in: donationIds }, status: 'ISSUED' }, select: { donationId: true } })).map((r) => r.donationId));
  const reissuable = new Set(['RECEIPTED', 'ON_SALE', 'SALE_ENDED', 'CLOSED']);

  return (
    <>
      <PageHeader title="현물 기부금영수증 정정" description="발급된 현물 기부금영수증을 무효 처리하고 현재 확정값(반환 수량 차감)으로 새 번호를 발급합니다. 번호는 다시 쓰지 않습니다." />
      {!superAdmin ? <div className="mb-4"><Notice tone="neutral">무효·재발급은 최고관리자만 할 수 있습니다.</Notice></div> : null}
      <FilterBar action="/admin/in-kind-receipts" resetHref="/admin/in-kind-receipts">
        <AdminInput name="q" defaultValue={q} placeholder="발급번호·기부번호" aria-label="검색" />
        <AdminSelect name="status" defaultValue={status ?? ''} aria-label="상태"><option value="">전체</option><option value="ISSUED">발급</option><option value="VOID">무효</option></AdminSelect>
      </FilterBar>
      <Card>
        {receipts.length === 0 ? <EmptyState title="현물 기부금영수증이 없습니다" /> : (
          <Table>
            <thead><tr><Th>발급번호</Th><Th>기관 · 기부자</Th><Th className="text-right">금액</Th><Th>발급일</Th><Th>상태</Th><Th>정정</Th></tr></thead>
            <tbody>{receipts.map((r) => {
              const expected = receiptAmountOf(r.donation.items.map((it) => ({ unitValue: it.unitValue, acceptedQty: it.acceptedQty, returnedQty: it.product?.returnedQty ?? 0 })));
              const mismatch = r.status === 'ISSUED' && expected !== r.totalAmount;
              return (
                <tr key={r.id}>
                  <Td className="font-mono text-[12px] font-bold">{r.receiptNo}<span className="block font-normal text-ink-400">{r.donation.donationNo}</span></Td>
                  <Td>{r.merchant.displayName}<span className="block text-[11px] text-ink-400">{r.donor.displayName}</span></Td>
                  <Td className="text-right tabular-nums">{formatWon(r.totalAmount)}{mismatch ? <span className="block text-[11px] text-warning-500">정정 필요 → {formatWon(expected)}</span> : null}</Td>
                  <Td className="text-[12px]">{formatKst(r.issuedAt, false)}</Td>
                  <Td>{r.status === 'ISSUED' ? <Badge tone="success">발급</Badge> : <Badge tone="danger">무효</Badge>}{r.voidReason ? <span className="block text-[11px] text-ink-400">{r.voidReason}</span> : null}</Td>
                  <Td>
                    {superAdmin && r.status === 'ISSUED' ? (
                      <ActionForm action={voidReceiptAction} submitLabel="무효 처리" variant="danger" compact confirm="영수증을 무효 처리할까요? 되돌릴 수 없고 번호는 다시 쓰지 않습니다.">
                        <input type="hidden" name="receiptId" value={r.id} />
                        <AdminInput name="reason" placeholder="무효 사유(예: 반환 수량 정정)" />
                      </ActionForm>
                    ) : null}
                    {superAdmin && r.status === 'VOID' && !issued.has(r.donationId) && reissuable.has(r.donation.status) ? (
                      <ActionForm action={reissueReceiptAction} submitLabel="재발급" variant="secondary" compact confirm={`${formatWon(expected)} 으로 새 번호의 영수증을 발급할까요?`}>
                        <input type="hidden" name="donationId" value={r.donationId} />
                      </ActionForm>
                    ) : null}
                  </Td>
                </tr>
              );
            })}</tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
