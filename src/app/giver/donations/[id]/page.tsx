import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileText } from 'lucide-react';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, DataRow, Input, Field, Notice, Table, Td, Th, Checkbox, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { DonationTimeline } from '@/components/bazaar/donation-timeline';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { giverPageContext } from '@/server/giver-context';
import { getBazaarConfig } from '@/server/services/bazaar-settings';
import { DONOR_EVIDENCE_STATUSES, productSalesSummary } from '@/server/services/bazaar';
import { donorCancelAction, donorValuationAction, evidenceUploadAction, pledgeAction, shippingAction } from '@/app/actions/bazaar-giver';
import { BAZAAR_UPLOAD_MAX_FILES, DONOR_CANCELABLE, deliveryMethodLabel, donationStatusLabel, itemConditionLabel, productStatusLabel, unsoldActionLabel, valuationKindLabel, type DonationStatus } from '@/lib/bazaar';
import { formatNumber, formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

const actorLabel: Record<string, string> = { DONOR: '기부자', MERCHANT: '기관', ADMIN: '운영자' };

export default async function GiverDonationDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const { donor } = await giverPageContext();
  const { id } = await params;
  const sp = await searchParams;
  const d = await prisma.inKindDonation.findFirst({
    where: { id, donorId: donor.id },
    include: {
      items: { orderBy: { seq: 'asc' } },
      merchant: { select: { displayName: true } },
      valuations: { orderBy: { createdAt: 'asc' } },
      inbound: true,
      receipts: { orderBy: { issuedAt: 'desc' } },
      products: true,
      files: { orderBy: { createdAt: 'asc' } },
      logs: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!d) notFound();
  const cfg = await getBazaarConfig();
  const sales = await productSalesSummary(d.products.map((p) => p.id));
  const status = d.status as DonationStatus;
  const lastProposal = [...d.valuations].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).reverse().find((v) => v.kind === 'PROPOSE' || v.kind === 'COUNTER');
  const returned = d.products.reduce((n, p) => n + p.returnedQty, 0);
  const lastValues = (lastProposal?.itemValues ?? {}) as Record<string, string>;
  const pledgeClauses = [
    '위 물품을 기관에 무상으로 기부하며, 기관이 라이브 바자회로 판매(현금화)하는 데 동의합니다.',
    '판매 가격은 운영자가 정하며, 기부금영수증 가액보다 낮게 판매될 수 있습니다.',
    '기부금영수증은 입고·검수 후 기관이 검수를 확정한 수량과 확정 단가로 발급됩니다.',
    `판매되지 않은 물품은 '${unsoldActionLabel[d.unsoldAction]}' 방법으로 처리합니다.`,
  ];

  return (
    <>
      <PageHeader title={d.title} description={`기부번호 ${d.donationNo} · 접수 ${formatKst(d.createdAt, false)}`} />
      {sp.created ? <div className="mb-4"><Notice tone="success" title="기부가 접수되었습니다">기관 매칭이 진행되면 이 화면에서 알려 드립니다.</Notice></div> : null}
      <Card>
        <div className="flex flex-wrap items-center gap-2"><LabelBadge map={donationStatusLabel} value={d.status} /> <span className="text-[13px] text-ink-500">기관: {d.merchant?.displayName ?? '매칭 전'}</span></div>
        <div className="mt-3"><DonationTimeline status={d.status} /></div>
      </Card>

      <Card className="mt-4">
        <CardTitle>물품</CardTitle>
        <div className="mt-3"><Table>
          <thead><tr><Th>품명</Th><Th>상태</Th><Th className="text-right">수량</Th><Th className="text-right">제시 단가</Th><Th className="text-right">확정 단가</Th><Th className="text-right">검수 합격</Th></tr></thead>
          <tbody>
            {d.items.map((it) => (
              <tr key={it.id}>
                <Td>{it.name}<span className="block text-[11px] text-ink-400">{it.category}{it.expiryDate ? ` · 유통기한 ${it.expiryDate.toISOString().slice(0, 10)}` : ''}</span></Td>
                <Td>{itemConditionLabel[it.condition] ?? it.condition}</Td>
                <Td className="text-right tabular-nums">{formatNumber(it.quantity)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(it.declaredUnitValue)}</Td>
                <Td className="text-right tabular-nums">{it.unitValue != null ? formatNumber(it.unitValue) : '-'}</Td>
                <Td className="text-right tabular-nums">{it.acceptedQty ?? '-'}</Td>
              </tr>
            ))}
          </tbody>
        </Table></div>
        <div className="mt-3 grid gap-1 sm:grid-cols-2">
          <DataRow label="제시 합계" value={formatWon(d.declaredTotal)} />
          <DataRow label="확정 합계" value={d.confirmedTotal != null ? formatWon(d.confirmedTotal) : '협의 전'} />
          <DataRow label="판매 조건" value={`${d.brandPublic ? '브랜드 공개' : '익명'} · 최저가 ${d.minSalePrice ? formatWon(d.minSalePrice) : '운영 기준'}`} />
          <DataRow label="미판매 처리 · 전달" value={`${unsoldActionLabel[d.unsoldAction]} · ${deliveryMethodLabel[d.deliveryMethod]}`} />
        </div>
      </Card>

      {status === 'VALUATING' ? (
        <Card className="mt-4">
          <CardTitle>가액 협의</CardTitle>
          <ul className="mt-3 space-y-1.5 text-[13px]">
            {d.valuations.map((v) => (
              <li key={v.id} className="rounded-lg bg-ink-50 px-3 py-2">
                <strong>{actorLabel[v.actorType] ?? '시스템'}</strong> {valuationKindLabel[v.kind] ?? '기록'} · 합계 {formatWon(v.total)} · {formatKst(v.createdAt, false)}
                {v.note ? <span className="block text-ink-500">{v.note}</span> : null}
              </li>
            ))}
          </ul>
          {lastProposal?.actorType === 'MERCHANT' ? (
            <div className="mt-4 space-y-4">
              <Notice tone="brand">기관이 합계 {formatWon(lastProposal.total)} 을 제안했습니다. 수락하면 가액이 확정됩니다.</Notice>
              <ActionForm action={donorValuationAction} submitLabel="기관 제안 수락" confirm={`합계 ${formatWon(lastProposal.total)} 으로 확정할까요? 확정한 가액은 되돌릴 수 없고 기부금영수증 금액의 기준이 됩니다.`}>
                <input type="hidden" name="donationId" value={d.id} />
                <input type="hidden" name="mode" value="ACCEPT" />
                <input type="hidden" name="valuationId" value={lastProposal.id} />
              </ActionForm>
            </div>
          ) : (
            <p className="mt-3 text-[13px] text-ink-500">기관이 제안을 확인하고 있습니다. 필요하면 아래에서 다시 제안할 수 있습니다.</p>
          )}
          <details className="mt-4">
            <summary className="cursor-pointer text-[13px] font-bold text-brand-700">다른 가액으로 다시 제안하기</summary>
            <div className="mt-3">
              <ActionForm action={donorValuationAction} submitLabel="다시 제안" variant="secondary">
                <input type="hidden" name="donationId" value={d.id} />
                <input type="hidden" name="mode" value="PROPOSE" />
                {d.items.map((it) => (
                  <Field key={it.id} label={`${it.name} 개당 가액(원) × ${it.quantity}`}>
                    <Input name={`unit_${it.id}`} inputMode="numeric" defaultValue={lastValues[it.id] ?? it.declaredUnitValue.toString()} />
                  </Field>
                ))}
                <Field label="메모"><Textarea name="note" rows={2} maxLength={500} /></Field>
              </ActionForm>
            </div>
          </details>
        </Card>
      ) : null}

      {status === 'VALUE_CONFIRMED' ? (
        <Card className="mt-4">
          <CardTitle>기부 약정</CardTitle>
          <p className="mt-1 text-[13px] text-ink-500">확정 가액 {d.confirmedTotal != null ? formatWon(d.confirmedTotal) : '-'} · 기관 {d.merchant?.displayName}</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-ink-700">{pledgeClauses.map((c) => <li key={c}>{c}</li>)}</ol>
          <div className="mt-4">
            <ActionForm action={pledgeAction} submitLabel="약정에 동의합니다" confirm="약정에 동의하면 스스로 취소할 수 없습니다. 동의할까요?">
              <input type="hidden" name="donationId" value={d.id} />
              <Field label="약정자 이름" required><Input name="pledgeName" required maxLength={30} defaultValue={donor.contactName} /></Field>
              <Checkbox name="agree" label="위 내용을 확인했고 기부에 동의합니다." />
            </ActionForm>
          </div>
        </Card>
      ) : null}

      {status === 'PLEDGED' ? (
        <Card className="mt-4">
          <CardTitle>물품 보내기</CardTitle>
          {d.deliveryMethod === 'SEND' ? (
            <>
              <p className="mt-2 text-[13.5px] text-ink-700">아래 창고로 물품을 보내 주세요. 상자에 기부번호 <strong className="font-mono">{d.donationNo}</strong> 를 적어 주시면 빨리 확인할 수 있습니다.</p>
              <p className="mt-2 rounded-xl bg-ink-50 px-4 py-3 text-[14px] font-bold text-ink-900">{cfg.warehouseAddress || '창고 주소는 운영자가 따로 안내드립니다.'}</p>
            </>
          ) : (
            <p className="mt-2 text-[13.5px] text-ink-700">수거를 요청하셨습니다. 운영자가 연락드려 수거 일정을 잡습니다.</p>
          )}
          {d.shippingTrackingNo ? <p className="mt-2 text-[13px] text-ink-500">발송 정보: {d.shippingCarrier} {d.shippingTrackingNo} ({formatKst(d.shippedAt, false)})</p> : null}
          <div className="mt-4">
            <ActionForm action={shippingAction} submitLabel="발송 정보 저장" variant="secondary">
              <input type="hidden" name="donationId" value={d.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="택배사"><Input name="carrier" maxLength={30} defaultValue={d.shippingCarrier ?? ''} /></Field>
                <Field label="송장번호"><Input name="trackingNo" maxLength={40} defaultValue={d.shippingTrackingNo ?? ''} /></Field>
              </div>
            </ActionForm>
          </div>
        </Card>
      ) : null}

      {d.inbound ? (
        <Card className="mt-4">
          <CardTitle>입고·검수 결과</CardTitle>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            <DataRow label="입고일" value={formatKst(d.inbound.receivedAt, false)} />
            <DataRow label="결과" value={d.inbound.result === 'PASS' ? '합격' : d.inbound.result === 'PARTIAL' ? '일부 합격' : '불합격'} />
            <DataRow label="기관 검수 확정" value={d.inbound.merchantConfirmedAt ? formatKst(d.inbound.merchantConfirmedAt, false) : '대기'} />
            {d.inbound.note ? <DataRow label="메모" value={d.inbound.note} /> : null}
          </div>
        </Card>
      ) : null}

      {d.receipts.length ? (
        <Card className="mt-4">
          <CardTitle>기부금영수증</CardTitle>
          {returned > 0 ? <p className="mt-1 text-[12.5px] text-ink-500">판매되지 않은 {returned}개를 돌려받으셨습니다. 돌려받은 물품은 기부가 아니므로 영수증은 그 수량을 뺀 금액으로 다시 발급됩니다(이전 영수증은 무효).</p> : null}
          <ul className="mt-2 space-y-1.5">
            {d.receipts.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 text-[13.5px]">
                <Link href={`/giver/receipts/${r.id}`} className="font-mono font-bold text-brand-700 underline">{r.receiptNo}</Link>
                <span>{formatWon(r.totalAmount)} {r.status === 'VOID' ? '(무효)' : ''}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {d.products.length ? (
        <Card className="mt-4">
          <CardTitle>판매 결과</CardTitle>
          <div className="mt-3"><Table>
            <thead><tr><Th>상품</Th><Th>상태</Th><Th className="text-right">판매 수량</Th><Th className="text-right">순판매액</Th></tr></thead>
            <tbody>
              {d.products.map((p) => {
                const s = sales.get(p.id);
                return (
                  <tr key={p.id}>
                    <Td>{p.name}</Td>
                    <Td><LabelBadge map={productStatusLabel} value={p.status} /></Td>
                    <Td className="text-right tabular-nums">{(s?.soldQty ?? 0) - (s?.refundQty ?? 0)} / {p.quantity}</Td>
                    <Td className="text-right tabular-nums">{formatWon((s?.gross ?? 0n) - (s?.refund ?? 0n))}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table></div>
          <p className="mt-2 text-[12px] text-ink-400">판매 금액에서 수수료를 뺀 금액이 기관에 귀속됩니다. 판매 결과는 운영자 확인 후 반영됩니다.</p>
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardTitle>사진·근거 자료</CardTitle>
        {d.files.length ? (
          <ul className="mt-2 space-y-1">
            {d.files.map((f) => (
              <li key={f.id}><a href={`/api/bazaar/files/${f.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-[13px] text-brand-700 underline"><FileText size={16} strokeWidth={1.7} aria-hidden />{f.kind === 'PHOTO' ? '사진' : f.kind === 'EVIDENCE' ? '가액 근거' : '검수 사진'} · {f.fileName}</a></li>
            ))}
          </ul>
        ) : <p className="mt-2 text-[13px] text-ink-500">올린 파일이 없습니다.</p>}
        {DONOR_EVIDENCE_STATUSES.includes(status) ? (
          <div className="mt-3">
            <ActionForm action={evidenceUploadAction} submitLabel="근거 자료 올리기" variant="secondary">
              <input type="hidden" name="donationId" value={d.id} />
              <input type="file" name="evidence" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="text-[13px]" />
              <p className="text-[12px] text-ink-400">이미지 또는 PDF, 한 번에 {BAZAAR_UPLOAD_MAX_FILES}개까지·한 개 5MB 이하(기부 건당 20개)</p>
            </ActionForm>
          </div>
        ) : null}
      </Card>

      <Card className="mt-4">
        <CardTitle>진행 기록</CardTitle>
        <ul className="mt-2 space-y-1 text-[12.5px] text-ink-500">
          {d.logs.map((l) => <li key={l.id}>{formatKst(l.createdAt, false)} · {donationStatusLabel[l.toStatus as DonationStatus]?.text ?? l.toStatus}{l.note ? ` — ${l.note}` : ''}</li>)}
        </ul>
      </Card>

      {DONOR_CANCELABLE.includes(status) ? (
        <Card className="mt-4">
          <CardTitle>기부 취소</CardTitle>
          <div className="mt-3">
            <ActionForm action={donorCancelAction} submitLabel="기부 취소" variant="danger" confirm="이 기부를 취소할까요? 되돌릴 수 없습니다.">
              <input type="hidden" name="donationId" value={d.id} />
              <Field label="취소 사유"><Input name="reason" maxLength={200} /></Field>
            </ActionForm>
          </div>
        </Card>
      ) : null}
    </>
  );
}
