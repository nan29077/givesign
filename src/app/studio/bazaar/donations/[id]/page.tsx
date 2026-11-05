import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileText } from 'lucide-react';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, DataRow, Field, Input, Notice, Table, Td, Th, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { DonationTimeline } from '@/components/bazaar/donation-timeline';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { studioBazaarContext } from '@/server/studio-bazaar-context';
import { productSalesSummary, receiptAmountOf } from '@/server/services/bazaar';
import { issuerReadiness } from '@/server/services/receipts';
import { confirmInspectionAction, merchantValuationAction } from '@/app/actions/bazaar-studio';
import { deliveryMethodLabel, donationStatusLabel, donorTypeLabel, formatBizNo, itemConditionLabel, productStatusLabel, unsoldActionLabel, type DonorType } from '@/lib/bazaar';
import { formatNumber, formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

const actorLabel: Record<string, string> = { DONOR: '기부자', MERCHANT: '기관', ADMIN: '운영자' };
const kindLabel: Record<string, string> = { PROPOSE: '제안', COUNTER: '역제안', CONFIRM: '확정', ACCEPT: '수락' };

export default async function StudioBazaarDonationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { merchant } = await studioBazaarContext();
  const { id } = await params;
  const mid = merchant.merchantId;
  const d = await prisma.inKindDonation.findUnique({
    where: { id },
    include: {
      donor: true,
      items: { orderBy: { seq: 'asc' } },
      valuations: { orderBy: { createdAt: 'asc' } },
      inbound: true,
      receipts: { orderBy: { issuedAt: 'desc' } },
      products: true,
      files: { orderBy: { createdAt: 'asc' } },
      matches: { where: { merchantId: mid }, orderBy: { proposedAt: 'desc' }, take: 1 },
    },
  });
  if (!d) notFound();
  const mine = d.merchantId === mid;
  const proposedToMe = d.matches[0]?.status === 'PROPOSED';
  if (!mine && !proposedToMe) notFound();
  const profile = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: mid } });
  const readiness = issuerReadiness(profile);
  const sales = await productSalesSummary(d.products.map((p) => p.id));
  const lastProposal = [...d.valuations].reverse().find((v) => v.kind === 'PROPOSE' || v.kind === 'COUNTER');
  const lastValues = (lastProposal?.itemValues ?? {}) as Record<string, string>;
  const receiptPreview = receiptAmountOf(d.items);
  const donorBlock = d.donor.donorType === 'CORPORATE'
    ? `${d.donor.displayName} (사업자 ${formatBizNo(d.donor.businessNo)}, 대표 ${d.donor.representativeName ?? '-'})`
    : `${d.donor.displayName}${d.donor.residentNoMasked ? '' : ' — 영수증 정보 미등록'}`;

  return (
    <>
      <PageHeader title={d.title} description={`기부번호 ${d.donationNo} · 접수 ${formatKst(d.createdAt, false)}`} action={<Link href="/studio/bazaar/donations" className="text-[13px] font-bold text-brand-700 underline">기부 접수함으로</Link>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2"><LabelBadge map={donationStatusLabel} value={d.status} /></div>
        <div className="mt-3"><DonationTimeline status={d.status} /></div>
        <div className="mt-3 grid gap-1 sm:grid-cols-2">
          <DataRow label="기부자" value={`${donorTypeLabel[d.donor.donorType as DonorType]} · ${mine ? donorBlock : d.donor.donorType === 'CORPORATE' ? d.donor.displayName : '개인 기부자'}`} />
          {mine ? <DataRow label="연락처" value={`${d.donor.contactName} · ${d.donor.phoneMasked}`} /> : null}
          <DataRow label="판매 조건" value={`${d.brandPublic ? '브랜드 공개' : '익명'} · 최저가 ${d.minSalePrice ? formatWon(d.minSalePrice) : '운영 기준'}`} />
          <DataRow label="미판매 처리 · 전달" value={`${unsoldActionLabel[d.unsoldAction]} · ${deliveryMethodLabel[d.deliveryMethod]}`} />
          {d.donorMessage ? <DataRow label="기부자 메시지" value={d.donorMessage} /> : null}
        </div>
      </Card>

      <Card className="mt-4">
        <CardTitle>물품</CardTitle>
        <div className="mt-3"><Table>
          <thead><tr><Th>품명</Th><Th>상태</Th><Th className="text-right">수량</Th><Th className="text-right">제시 단가</Th><Th className="text-right">확정 단가</Th><Th className="text-right">입고 / 합격</Th></tr></thead>
          <tbody>
            {d.items.map((it) => (
              <tr key={it.id}>
                <Td>{it.name}<span className="block text-[11px] text-ink-400">{it.category}{it.expiryDate ? ` · 유통기한 ${it.expiryDate.toISOString().slice(0, 10)}` : ''}</span></Td>
                <Td>{itemConditionLabel[it.condition]}</Td>
                <Td className="text-right tabular-nums">{formatNumber(it.quantity)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(it.declaredUnitValue)}</Td>
                <Td className="text-right tabular-nums">{it.unitValue != null ? formatNumber(it.unitValue) : '-'}</Td>
                <Td className="text-right tabular-nums">{it.receivedQty ?? '-'} / {it.acceptedQty ?? '-'}{it.inspectNote ? <span className="block text-[11px] text-ink-400">{it.inspectNote}</span> : null}</Td>
              </tr>
            ))}
          </tbody>
        </Table></div>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          <DataRow label="제시 합계" value={formatWon(d.declaredTotal)} />
          <DataRow label="확정 합계" value={d.confirmedTotal != null ? formatWon(d.confirmedTotal) : '협의 전'} />
        </div>
      </Card>

      {mine && d.status === 'VALUATING' ? (
        <Card className="mt-4">
          <CardTitle>가액 협의</CardTitle>
          <p className="mt-1 text-[12.5px] text-ink-500">현물 기부금영수증은 확정한 단가 × 검수 합격 수량으로 발급됩니다. 세금계산서·거래명세서 등 근거 자료를 확인하고 정해 주세요.</p>
          <ul className="mt-3 space-y-1.5 text-[13px]">
            {d.valuations.map((v) => (
              <li key={v.id} className="rounded-lg bg-ink-50 px-3 py-2"><strong>{actorLabel[v.actorType]}</strong> {kindLabel[v.kind] ?? v.kind} · 합계 {formatWon(v.total)} · {formatKst(v.createdAt, false)}{v.note ? <span className="block text-ink-500">{v.note}</span> : null}</li>
            ))}
          </ul>
          {lastProposal?.actorType === 'DONOR' ? (
            <div className="mt-4">
              <ActionForm action={merchantValuationAction} submitLabel={`기부자 제시 가액 ${formatWon(lastProposal.total)} 으로 확정`} confirm="이 가액으로 확정할까요? 확정 뒤에는 기부자가 약정에 동의합니다.">
                <input type="hidden" name="donationId" value={d.id} />
                <input type="hidden" name="mode" value="CONFIRM" />
              </ActionForm>
            </div>
          ) : <div className="mt-3"><Notice tone="brand">기관이 낸 제안에 기부자가 응답하기를 기다리고 있습니다.</Notice></div>}
          <details className="mt-4">
            <summary className="cursor-pointer text-[13px] font-bold text-brand-700">다른 가액 제안하기(역제안)</summary>
            <div className="mt-3">
              <ActionForm action={merchantValuationAction} submitLabel="역제안 보내기" variant="secondary">
                <input type="hidden" name="donationId" value={d.id} />
                <input type="hidden" name="mode" value="COUNTER" />
                {d.items.map((it) => (
                  <Field key={it.id} label={`${it.name} 개당 가액(원) × ${it.quantity}`}><Input name={`unit_${it.id}`} inputMode="numeric" defaultValue={lastValues[it.id] ?? it.declaredUnitValue.toString()} /></Field>
                ))}
                <Field label="기부자에게 남길 말"><Textarea name="note" rows={2} maxLength={500} placeholder="예: 시중 판매가를 기준으로 조정했습니다." /></Field>
              </ActionForm>
            </div>
          </details>
        </Card>
      ) : null}

      {mine && d.status === 'INSPECTED' && d.inbound ? (
        <Card className="mt-4">
          <CardTitle>검수 확정 · 영수증 발급</CardTitle>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            <DataRow label="입고" value={`${d.inbound.warehouse} · ${formatKst(d.inbound.receivedAt, false)}`} />
            <DataRow label="결과" value={d.inbound.result === 'PASS' ? '합격' : '일부 합격'} />
            <DataRow label="반송비" value={d.inbound.returnCost > 0n ? `${formatWon(d.inbound.returnCost)} (${d.inbound.returnCostBearer === 'MERCHANT' ? '기관 부담 — 정산에서 공제' : '기브싸인 부담'})` : '없음'} />
            <DataRow label="발급될 영수증 금액" value={formatWon(receiptPreview)} />
          </div>
          {!readiness.ok ? <div className="mt-3"><Notice tone="danger">영수증을 발급할 수 없습니다: {readiness.missing.join(', ')}</Notice></div> : null}
          {d.donor.donorType === 'INDIVIDUAL' && !d.donor.residentNoEnc ? <div className="mt-3"><Notice tone="warning">개인 기부자가 영수증 정보(성명·주민등록번호)를 아직 등록하지 않았습니다. 등록 후 확정할 수 있습니다.</Notice></div> : null}
          <div className="mt-4">
            <ActionForm action={confirmInspectionAction} submitLabel="검수 확정하고 기부금영수증 발급" confirm="검수 결과를 확정하고 현물 기부금영수증을 발급합니다. 계속할까요?">
              <input type="hidden" name="donationId" value={d.id} />
            </ActionForm>
          </div>
        </Card>
      ) : null}

      {d.receipts.length ? (
        <Card className="mt-4">
          <CardTitle>현물 기부금영수증</CardTitle>
          <ul className="mt-2 space-y-1">{d.receipts.map((r) => <li key={r.id} className="text-[13.5px]"><Link href={`/studio/receipts/in-kind/${r.id}`} className="font-mono font-bold text-brand-700 underline">{r.receiptNo}</Link> · {formatWon(r.totalAmount)} {r.status === 'VOID' ? '(무효)' : ''}</li>)}</ul>
        </Card>
      ) : null}

      {d.products.length ? (
        <Card className="mt-4">
          <CardTitle>판매 상품</CardTitle>
          <div className="mt-3"><Table>
            <thead><tr><Th>추적 코드</Th><Th>상품</Th><Th className="text-right">판매가</Th><Th>상태</Th><Th className="text-right">판매 / 수량</Th><Th className="text-right">순판매액</Th></tr></thead>
            <tbody>{d.products.map((p) => { const s = sales.get(p.id); return (
              <tr key={p.id}><Td className="font-mono text-[12px]">{p.trackingCode}</Td><Td>{p.name}</Td><Td className="text-right tabular-nums">{formatWon(p.salePrice)}</Td><Td><LabelBadge map={productStatusLabel} value={p.status} /></Td><Td className="text-right tabular-nums">{(s?.soldQty ?? 0) - (s?.refundQty ?? 0)} / {p.quantity}</Td><Td className="text-right tabular-nums">{formatWon((s?.gross ?? 0n) - (s?.refund ?? 0n))}</Td></tr>
            ); })}</tbody>
          </Table></div>
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardTitle>사진·근거 자료</CardTitle>
        {d.files.length ? (
          <ul className="mt-2 space-y-1">{d.files.map((f) => <li key={f.id}><a href={`/api/bazaar/files/${f.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-[13px] text-brand-700 underline"><FileText size={16} strokeWidth={1.7} aria-hidden />{f.kind === 'PHOTO' ? '물품 사진' : f.kind === 'EVIDENCE' ? '가액 근거' : '검수 사진'} · {f.fileName}</a></li>)}</ul>
        ) : <p className="mt-2 text-[13px] text-ink-500">올라온 파일이 없습니다.</p>}
      </Card>
    </>
  );
}
