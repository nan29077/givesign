import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, EmptyState, LinkButton, Notice, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect, AdminTextarea } from '@/components/admin/controls';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { adminBazaarContext, ADMIN_BAZAAR_TABS } from '@/server/admin-bazaar-context';
import { getBazaarConfig } from '@/server/services/bazaar-settings';
import { approveSaleBatchAction, createSaleBatchAction, rejectSaleBatchAction } from '@/app/actions/admin/bazaar';
import { SALE_CSV_HEADER, batchStatusLabel, lineRates, returnBearerLabel, settleLine } from '@/lib/bazaar';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/**
 * 판매 결과 입력(1단계: 셀러브릭스 연동 전 수기·파일 입력).
 * 입력자와 승인자가 달라야 원장에 반영된다(최고관리자는 사유를 적으면 단독 승인 가능).
 */
export default async function AdminBazaarSales() {
  const admin = await adminBazaarContext();
  const canOperate = ['SUPER_ADMIN', 'OPERATION', 'FINANCE'].includes(String(admin.adminPermission));
  const [batches, lives, cfg] = await Promise.all([
    prisma.bazaarSaleBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { lines: { include: { product: { select: { trackingCode: true, name: true } } } }, live: { select: { title: true } } } }),
    prisma.bazaarLive.findMany({ where: { status: { in: ['APPROVED', 'DONE'] } }, orderBy: { scheduledAt: 'desc' }, take: 50, select: { id: true, title: true, scheduledAt: true } }),
    getBazaarConfig(),
  ]);
  const userIds = [...new Set(batches.flatMap((b) => [b.createdBy, b.approvedBy].filter(Boolean) as string[]))];
  const users = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name ?? u.email ?? u.id]));
  return (
    <>
      <PageHeader title="판매 결과 입력" description="셀러브릭스 바자회 센터 창고의 주문 내역을 옮겨 적거나 파일로 올립니다. 승인하면 기관 정산 원장에 반영됩니다." action={<LinkButton href="/api/bazaar/export?kind=sale-template" variant="secondary">입력 양식 내려받기(판매 중 상품)</LinkButton>} />
      <BazaarSubNav items={ADMIN_BAZAAR_TABS} current="/admin/bazaar/sales" />
      <Card>
        <CardTitle>새 판매 결과</CardTitle>
        <p className="mt-1 text-[12.5px] text-ink-500">열 순서: {SALE_CSV_HEADER.join(', ')}({SALE_CSV_HEADER.length}개 열을 모두 맞춥니다). 한 줄에 상품 하나. 쉼표가 든 금액은 따옴표로 감싸거나 쉼표 없이 적습니다. 판매 금액이 수량 × 판매가와 크게 다르면 거절합니다. 반송비 부담은 기관/기브싸인/없음. 이전 판매의 환불 정정은 판매 0, 환불 금액만 적어 올립니다(환불 수수료 환입은 원래 판매 때 요율). 엑셀 CSV(UTF-8·CP949) 모두 읽습니다.</p>
        {!canOperate ? <div className="mt-3"><Notice tone="neutral">판매 결과 입력·승인·반려는 최고관리자·운영·재무 권한에서만 할 수 있습니다.</Notice></div> : null}
        {canOperate ? <div className="mt-3">
          <ActionForm action={createSaleBatchAction} submitLabel="판매 결과 등록(승인 대기)">
            <div className="grid gap-2 sm:grid-cols-2">
              <AdminField label="제목"><AdminInput name="title" placeholder="예: 11월 2주차 방송" /></AdminField>
              <AdminField label="방송(선택)"><AdminSelect name="liveId" defaultValue=""><option value="">선택 안 함</option>{lives.map((l) => <option key={l.id} value={l.id}>{formatKst(l.scheduledAt, false)} {l.title}</option>)}</AdminSelect></AdminField>
            </div>
            <AdminField label="CSV 파일(엑셀에서 CSV 로 저장)"><input type="file" name="file" accept=".csv,text/csv" className="text-[12px]" /></AdminField>
            <AdminField label="또는 직접 입력" hint="파일을 올리면 이 칸은 무시합니다."><AdminTextarea name="rowsText" rows={5} placeholder={'GSB-000001,20,100000,2,10000,3000,기관,\nGSB-000002,10,150000,0,0,0,없음,'} className="font-mono" /></AdminField>
            <AdminField label="메모"><AdminInput name="note" /></AdminField>
          </ActionForm>
        </div> : null}
      </Card>

      <Card className="mt-5">
        <CardTitle>등록된 판매 결과</CardTitle>
        {batches.length === 0 ? <div className="mt-3"><EmptyState title="등록된 판매 결과가 없습니다" /></div> : (
          <ul className="mt-3 space-y-3">
            {batches.map((b) => {
              let gross = 0n, refund = 0n, payout = 0n;
              for (const l of b.lines) { const r = lineRates(l, cfg); gross += l.grossAmount; refund += l.refundAmount; payout += settleLine(l, r.sale, r.refund).payout; }
              const mine = b.createdBy === admin.id;
              return (
                <li key={b.id} className="rounded-2xl border border-ink-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[14px] font-extrabold">{b.title} <span className="text-[12px] font-normal text-ink-400">{b.source === 'CSV' ? '파일' : '직접 입력'}{b.live ? ` · ${b.live.title}` : ''}</span></p>
                    <LabelBadge map={batchStatusLabel} value={b.status} />
                  </div>
                  <p className="mt-1 text-[12px] text-ink-500">입력 {users.get(b.createdBy)} · {formatKst(b.createdAt, false)}{b.approvedBy ? ` / 처리 ${users.get(b.approvedBy)} · ${formatKst(b.approvedAt, false)}` : ''}{b.month ? ` · 원장 ${b.month}` : ''}{b.rejectReason ? ` · 반려: ${b.rejectReason}` : ''}{b.note ? ` · ${b.note}` : ''}</p>
                  <details className="mt-2"><summary className="cursor-pointer text-[12.5px] font-bold text-brand-700">{b.lines.length}줄 · 판매 {formatWon(gross)} · 환불 {formatWon(refund)} · 기관 귀속(예상) {formatWon(payout)}</summary>
                    <Table><thead><tr><Th>추적 코드</Th><Th>상품</Th><Th className="text-right">판매</Th><Th className="text-right">환불</Th><Th className="text-right">반송비</Th></tr></thead>
                      <tbody>{b.lines.map((l) => <tr key={l.id}><Td className="font-mono text-[12px]">{l.product.trackingCode}</Td><Td>{l.product.name}</Td><Td className="text-right tabular-nums">{l.soldQty}개 · {formatWon(l.grossAmount)}</Td><Td className="text-right tabular-nums">{l.refundQty}개 · {formatWon(l.refundAmount)}</Td><Td className="text-right tabular-nums">{formatWon(l.returnCost)} ({returnBearerLabel[l.returnBearer]})</Td></tr>)}</tbody>
                    </Table>
                  </details>
                  {b.status === 'DRAFT' && canOperate ? (
                    <div className="mt-3 flex flex-wrap items-start gap-3">
                      {mine && admin.adminPermission !== 'SUPER_ADMIN' ? <Notice tone="neutral">직접 입력한 결과는 다른 관리자가 승인해야 합니다.</Notice> : (
                        <ActionForm action={approveSaleBatchAction} submitLabel="승인(원장 반영)" compact confirm="승인하면 정산 원장에 반영되고 되돌릴 수 없습니다(정정은 환불 줄로). 승인할까요?">
                          <input type="hidden" name="batchId" value={b.id} />
                          {mine ? <AdminInput name="soloReason" placeholder="단독 승인 사유(최고관리자)" /> : null}
                        </ActionForm>
                      )}
                      <ActionForm action={rejectSaleBatchAction} submitLabel="반려" variant="ghost" compact confirm="이 판매 결과를 반려할까요? 반려한 결과는 다시 승인할 수 없습니다(고쳐서 새로 등록)."><input type="hidden" name="batchId" value={b.id} /><AdminInput name="reason" placeholder="반려 사유" /></ActionForm>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
