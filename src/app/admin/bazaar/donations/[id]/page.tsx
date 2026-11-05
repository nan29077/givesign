import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileText } from 'lucide-react';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, DataRow, Notice, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect, AdminTextarea } from '@/components/admin/controls';
import { DonationTimeline } from '@/components/bazaar/donation-timeline';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { adminBazaarContext } from '@/server/admin-bazaar-context';
import { eligibleMerchants, receiptAmountOf, receiptCorrectionNeeded } from '@/server/services/bazaar';
import { getBazaarConfig } from '@/server/services/bazaar-settings';
import {
  cancelDonationAction,
  closeDonationAction,
  proposeMatchAction,
  registerInboundAction,
  reissueReceiptAction,
  voidReceiptAction,
  withdrawMatchAction,
} from '@/app/actions/admin/bazaar';
import {
  ADMIN_CANCELABLE,
  deliveryMethodLabel,
  donationStatusLabel,
  donorTypeLabel,
  formatBizNo,
  itemConditionLabel,
  matchModeLabel,
  matchStatusLabel,
  productStatusLabel,
  unsoldActionLabel,
  valuationKindLabel,
  type DonationStatus,
  type DonorType,
} from '@/lib/bazaar';
import { formatNumber, formatWon } from '@/lib/money';
import { formatKst, kstDateKey } from '@/lib/datetime';

export const dynamic = 'force-dynamic';
const actorLabel: Record<string, string> = { DONOR: '기부자', MERCHANT: '기관', ADMIN: '운영자', SYSTEM: '시스템' };
const fileKindLabel: Record<string, string> = { PHOTO: '물품 사진', EVIDENCE: '가액 근거', INSPECTION: '검수 사진' };

export default async function AdminBazaarDonationDetail({ params }: { params: Promise<{ id: string }> }) {
  const admin = await adminBazaarContext();
  const { id } = await params;
  const d = await prisma.inKindDonation.findUnique({
    where: { id },
    include: {
      donor: { include: { user: { select: { email: true, status: true } } } },
      merchant: { select: { id: true, displayName: true } },
      items: { orderBy: { seq: 'asc' } },
      valuations: { orderBy: { createdAt: 'asc' } },
      matches: { orderBy: { proposedAt: 'desc' } },
      logs: { orderBy: { createdAt: 'asc' } },
      files: { orderBy: { createdAt: 'asc' } },
      inbound: true,
      receipts: { orderBy: { issuedAt: 'desc' } },
      products: true,
    },
  });
  if (!d) notFound();
  const status = d.status as DonationStatus;
  const [eligible, cfg, correction] = await Promise.all([eligibleMerchants(), getBazaarConfig(), receiptCorrectionNeeded(d.id)]);
  const canOperate = ['SUPER_ADMIN', 'OPERATION', 'FINANCE'].includes(String(admin.adminPermission));
  const rejected = new Set(d.matches.filter((m) => m.status === 'REJECTED').map((m) => m.merchantId));
  const mNames = new Map((await prisma.merchantProfile.findMany({ where: { id: { in: d.matches.map((m) => m.merchantId) } }, select: { id: true, displayName: true } })).map((m) => [m.id, m.displayName]));
  const superAdmin = admin.adminPermission === 'SUPER_ADMIN';
  const preferred = d.preferredMerchantId ? eligible.find((m) => m.id === d.preferredMerchantId) : null;

  return (
    <>
      <PageHeader title={d.title} description={`기부번호 ${d.donationNo} · 접수 ${formatKst(d.createdAt, false)}`} action={<Link href="/admin/bazaar/donations" className="text-[13px] font-bold text-brand-700 underline">목록으로</Link>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2"><LabelBadge map={donationStatusLabel} value={d.status} /></div>
        <div className="mt-3"><DonationTimeline status={d.status} /></div>
        <div className="mt-3 grid gap-1 sm:grid-cols-2">
          <DataRow label="기부자" value={<Link href={`/admin/bazaar/givers?q=${encodeURIComponent(d.donor.displayName)}`} className="text-brand-700 underline">{d.donor.displayName}</Link>} />
          <DataRow label="구분·연락처" value={`${donorTypeLabel[d.donor.donorType as DonorType]} · ${d.donor.contactName} ${d.donor.phoneMasked} · ${d.donor.user.email ?? ''}`} />
          {d.donor.donorType === 'CORPORATE' ? <DataRow label="사업자등록번호" value={formatBizNo(d.donor.businessNo)} /> : <DataRow label="영수증 정보" value={d.donor.residentNoMasked ? `${d.donor.legalName} ${d.donor.residentNoMasked}` : '미등록'} />}
          <DataRow label="기관" value={d.merchant?.displayName ?? '매칭 전'} />
          <DataRow label="기관 선택" value={`${matchModeLabel[d.matchMode]}${preferred ? ` — ${preferred.displayName}` : ''}`} />
          <DataRow label="판매 조건" value={`${d.brandPublic ? '브랜드 공개' : '익명'} · 최저가 ${d.minSalePrice ? formatWon(d.minSalePrice) : '운영 기준'} · 미판매 ${unsoldActionLabel[d.unsoldAction]}`} />
          <DataRow label="전달" value={`${deliveryMethodLabel[d.deliveryMethod]}${d.shippingTrackingNo ? ` · ${d.shippingCarrier} ${d.shippingTrackingNo}` : ''}`} />
          {d.pledgedAt ? <DataRow label="약정" value={`${d.pledgeName} · ${formatKst(d.pledgedAt, false)} · sha256 ${d.pledgeHash?.slice(0, 12)}…`} /> : null}
          {d.donorMessage ? <DataRow label="기부자 메시지" value={d.donorMessage} /> : null}
          {d.cancelReason ? <DataRow label="취소 사유" value={d.cancelReason} /> : null}
        </div>
      </Card>

      <Card className="mt-4">
        <CardTitle>물품</CardTitle>
        <div className="mt-3"><Table>
          <thead><tr><Th>#</Th><Th>품명</Th><Th>상태</Th><Th className="text-right">수량</Th><Th className="text-right">제시 단가</Th><Th className="text-right">확정 단가</Th><Th className="text-right">입고/합격</Th></tr></thead>
          <tbody>{d.items.map((it) => (
            <tr key={it.id}><Td>{it.seq}</Td><Td>{it.name}<span className="block text-[11px] text-ink-400">{it.category}{it.expiryDate ? ` · 유통기한 ${it.expiryDate.toISOString().slice(0, 10)}` : ''}</span></Td><Td>{itemConditionLabel[it.condition]}</Td><Td className="text-right tabular-nums">{formatNumber(it.quantity)}</Td><Td className="text-right tabular-nums">{formatNumber(it.declaredUnitValue)}</Td><Td className="text-right tabular-nums">{it.unitValue != null ? formatNumber(it.unitValue) : '-'}</Td><Td className="text-right tabular-nums">{it.receivedQty ?? '-'} / {it.acceptedQty ?? '-'}</Td></tr>
          ))}</tbody>
        </Table></div>
        <div className="mt-2 grid gap-1 sm:grid-cols-3">
          <DataRow label="제시 합계" value={formatWon(d.declaredTotal)} />
          <DataRow label="확정 합계" value={d.confirmedTotal != null ? formatWon(d.confirmedTotal) : '-'} />
          <DataRow label="영수증 예상(합격 기준)" value={formatWon(receiptAmountOf(d.items))} />
        </div>
      </Card>

      {status === 'SUBMITTED' ? (
        <Card className="mt-4">
          <CardTitle>기관 매칭 제안</CardTitle>
          <p className="mt-1 text-[12.5px] text-ink-500">참여 승인·공익법인 지정 확인이 끝난 기관만 보입니다. 기관이 {cfg.matchDeadlineDays}일 안에 수락해야 확정됩니다.</p>
          {eligible.length === 0 ? <div className="mt-3"><Notice tone="warning">매칭할 수 있는 기관이 없습니다. 참여 기관 메뉴에서 승인해 주세요.</Notice></div> : (
            <div className="mt-3">
              <ActionForm action={proposeMatchAction} submitLabel="매칭 제안">
                <input type="hidden" name="donationId" value={d.id} />
                <AdminField label="기관">
                  <AdminSelect name="merchantId" defaultValue={d.preferredMerchantId && !rejected.has(d.preferredMerchantId) ? d.preferredMerchantId : ''}>
                    <option value="">기관 선택</option>
                    {eligible.map((m) => <option key={m.id} value={m.id} disabled={rejected.has(m.id)}>{m.displayName}{rejected.has(m.id) ? ' (거절함)' : ''}{m.neededItems ? ` — 필요: ${m.neededItems.slice(0, 40)}` : ''}</option>)}
                  </AdminSelect>
                </AdminField>
              </ActionForm>
            </div>
          )}
        </Card>
      ) : null}
      {status === 'MATCH_PROPOSED' ? (
        <Card className="mt-4">
          <CardTitle>매칭 제안 중</CardTitle>
          <p className="mt-1 text-[13px] text-ink-500">{mNames.get(d.matches[0]?.merchantId ?? '') ?? ''} 의 응답을 기다립니다(기한 {formatKst(d.matches[0]?.deadline, false)}).</p>
          <div className="mt-3"><ActionForm action={withdrawMatchAction} submitLabel="제안 철회" variant="secondary" confirm="제안을 철회하고 접수 상태로 되돌릴까요?"><input type="hidden" name="donationId" value={d.id} /></ActionForm></div>
        </Card>
      ) : null}

      {canOperate && (status === 'PLEDGED' || (status === 'INSPECTED' && !d.inbound?.merchantConfirmedAt)) ? (
        <Card className="mt-4">
          <CardTitle>{d.inbound ? '입고·검수 수정' : '입고·검수 등록'}</CardTitle>
          <p className="mt-1 text-[12.5px] text-ink-500">합격 수량 × 확정 단가로 영수증이 발급됩니다. 기관이 검수를 확정하기 전까지 고칠 수 있습니다. 불합격이면 기부 건이 반송·폐기로 끝납니다.</p>
          <div className="mt-3">
            <ActionForm action={registerInboundAction} submitLabel="검수 결과 저장" confirm="검수 결과를 저장할까요? 불합격이면 되돌릴 수 없습니다.">
              <input type="hidden" name="donationId" value={d.id} />
              <div className="grid gap-3 sm:grid-cols-3">
                <AdminField label="입고 창고"><AdminInput name="warehouse" defaultValue={d.inbound?.warehouse ?? '기브싸인 바자회 센터'} /></AdminField>
                <AdminField label="입고일"><AdminInput type="date" name="receivedAt" defaultValue={d.inbound ? kstDateKey(d.inbound.receivedAt) : kstDateKey()} /></AdminField>
                <AdminField label="검수 결과">
                  <AdminSelect name="result" defaultValue={d.inbound?.result ?? 'PASS'}><option value="PASS">합격</option><option value="PARTIAL">일부 합격</option><option value="FAIL">불합격(반송·폐기)</option></AdminSelect>
                </AdminField>
              </div>
              <Table>
                <thead><tr><Th>품명</Th><Th>약정 수량</Th><Th>입고 수량</Th><Th>합격 수량</Th><Th>메모</Th></tr></thead>
                <tbody>{d.items.map((it) => (
                  <tr key={it.id}><Td>{it.name}</Td><Td className="tabular-nums">{it.quantity}</Td>
                    <Td><AdminInput name={`received_${it.id}`} inputMode="numeric" defaultValue={String(it.receivedQty ?? it.quantity)} className="w-24" /></Td>
                    <Td><AdminInput name={`accepted_${it.id}`} inputMode="numeric" defaultValue={String(it.acceptedQty ?? it.quantity)} className="w-24" /></Td>
                    <Td><AdminInput name={`note_${it.id}`} defaultValue={it.inspectNote ?? ''} placeholder="파손 등" /></Td></tr>
                ))}</tbody>
              </Table>
              <div className="grid gap-3 sm:grid-cols-3">
                <AdminField label="반송비(원)"><AdminInput name="returnCost" inputMode="numeric" defaultValue={d.inbound?.returnCost.toString() ?? '0'} /></AdminField>
                <AdminField label="반송비 부담"><AdminSelect name="returnCostBearer" defaultValue={d.inbound?.returnCostBearer ?? 'NONE'}><option value="NONE">없음</option><option value="MERCHANT">기관 부담(정산 공제)</option><option value="GIVESIGN">기브싸인 부담</option></AdminSelect></AdminField>
                <AdminField label="불합격 처리"><AdminSelect name="disposition" defaultValue="RETURNED"><option value="RETURNED">기부자에게 반송</option><option value="DISPOSED">폐기(기부자 동의)</option></AdminSelect></AdminField>
              </div>
              <AdminField label="검수 메모"><AdminTextarea name="note" rows={2} defaultValue={d.inbound?.note ?? ''} /></AdminField>
              <AdminField label="검수 사진(선택)"><input type="file" name="photos" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="text-[12px]" /></AdminField>
            </ActionForm>
          </div>
        </Card>
      ) : null}
      {status === 'INSPECTED' && d.inbound ? <div className="mt-4"><Notice tone="brand">기관이 검수를 확정하면 현물 기부금영수증이 발급되고 판매 상품(등록 대기)이 만들어집니다.</Notice></div> : null}

      {d.receipts.length ? (
        <Card className="mt-4">
          <CardTitle>현물 기부금영수증</CardTitle>
          {correction ? (
            <div className="mt-2"><Notice tone="warning" title="영수증 정정 필요">
              기부자에게 돌려준 수량이 있어 발급 금액 {formatWon(correction.issued)} 이 실제 기부 {formatWon(correction.expected)} 보다 많습니다. 영수증 {correction.receiptNo} 를 무효 처리한 뒤 재발급하면 반환 수량을 뺀 금액으로 발급됩니다. 정정 전에는 종결할 수 없습니다.
            </Notice></div>
          ) : null}
          <ul className="mt-2 space-y-3">
            {d.receipts.map((r) => (
              <li key={r.id} className="rounded-xl border border-ink-200 p-3 text-[13px]">
                <span className="font-mono font-bold">{r.receiptNo}</span> · {formatWon(r.totalAmount)} · {formatKst(r.issuedAt, false)} {r.status === 'VOID' ? <span className="font-bold text-danger-500">무효 — {r.voidReason}</span> : null}
                {r.status === 'ISSUED' && superAdmin ? (
                  <div className="mt-2"><ActionForm action={voidReceiptAction} submitLabel="무효 처리" variant="danger" compact confirm="영수증을 무효 처리할까요? 번호는 다시 쓰지 않습니다."><input type="hidden" name="receiptId" value={r.id} /><AdminInput name="reason" placeholder="무효 사유(예: 가액 정정)" /></ActionForm></div>
                ) : null}
              </li>
            ))}
          </ul>
          {superAdmin && !d.receipts.some((r) => r.status === 'ISSUED') && ['RECEIPTED', 'ON_SALE', 'SALE_ENDED', 'CLOSED'].includes(status) ? (
            <div className="mt-3"><ActionForm action={reissueReceiptAction} submitLabel="현재 확정값으로 재발급" variant="secondary" confirm="확정 단가 × (합격 수량 - 반환 수량)으로 새 번호의 영수증을 발급합니다. 계속할까요?"><input type="hidden" name="donationId" value={d.id} /></ActionForm></div>
          ) : null}
        </Card>
      ) : null}

      {d.products.length ? (
        <Card className="mt-4">
          <CardTitle>판매 상품</CardTitle>
          <ul className="mt-2 space-y-1 text-[13px]">{d.products.map((p) => <li key={p.id}><span className="font-mono">{p.trackingCode}</span> {p.name} · {formatWon(p.salePrice)} × {p.quantity} <LabelBadge map={productStatusLabel} value={p.status} />{p.returnedQty ? <span className="ml-1 text-[12px] text-warning-500">기부자 반환 {p.returnedQty}개</span> : null}</li>)}</ul>
          <p className="mt-2 text-[12.5px]"><Link href="/admin/bazaar/products" className="font-bold text-brand-700 underline">판매 상품에서 가격·등록 처리</Link></p>
          {status === 'SALE_ENDED' ? <div className="mt-3"><ActionForm action={closeDonationAction} submitLabel="기부 건 종결" variant="secondary" confirm="기부 건을 종결할까요? 종결한 건은 다시 열 수 없습니다."><input type="hidden" name="donationId" value={d.id} /></ActionForm></div> : null}
        </Card>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>가액 협의 이력</CardTitle>
          <ul className="mt-2 space-y-1 text-[12.5px]">{d.valuations.map((v) => <li key={v.id}>{formatKst(v.createdAt, false)} · {actorLabel[v.actorType] ?? '시스템'} {valuationKindLabel[v.kind] ?? '기록'} · {formatWon(v.total)}{v.note ? ` — ${v.note}` : ''}</li>)}</ul>
          <CardTitle className="mt-4">매칭 이력</CardTitle>
          <ul className="mt-2 space-y-1 text-[12.5px]">{d.matches.map((m) => <li key={m.id}>{formatKst(m.proposedAt, false)} · {mNames.get(m.merchantId)} <LabelBadge map={matchStatusLabel} value={m.status} />{m.reason ? ` — ${m.reason}` : ''}</li>)}</ul>
        </Card>
        <Card>
          <CardTitle>상태 이력</CardTitle>
          <ul className="mt-2 space-y-1 text-[12.5px]">{d.logs.map((l) => <li key={l.id}>{formatKst(l.createdAt, false)} · {actorLabel[l.actorType]} · {donationStatusLabel[l.toStatus as DonationStatus]?.text ?? l.toStatus}{l.note ? ` — ${l.note}` : ''}</li>)}</ul>
          <CardTitle className="mt-4">파일</CardTitle>
          <ul className="mt-2 space-y-1">{d.files.map((f) => <li key={f.id}><a href={`/api/bazaar/files/${f.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-[12.5px] text-brand-700 underline"><FileText size={16} strokeWidth={1.7} aria-hidden />{fileKindLabel[f.kind] ?? '파일'} · {f.fileName}</a></li>)}</ul>
        </Card>
      </div>

      {ADMIN_CANCELABLE.includes(status) ? (
        <Card className="mt-4">
          <CardTitle>기부 건 취소</CardTitle>
          <div className="mt-3"><ActionForm action={cancelDonationAction} submitLabel="취소" variant="danger" confirm="이 기부 건을 취소할까요?"><input type="hidden" name="donationId" value={d.id} /><AdminInput name="reason" placeholder="취소 사유(기부자에게 보입니다)" /></ActionForm></div>
        </Card>
      ) : null}
    </>
  );
}
