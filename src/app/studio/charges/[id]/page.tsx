import { notFound } from 'next/navigation';
import { Badge, Card, CardTitle, DataRow, EmptyState, LinkButton, Notice, SectionTitle, Table, Td, Th } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { AddressReveal } from '@/components/studio/address-reveal';
import { blockPayerAction, requestChargeRefundAction } from '@/app/actions/studio';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { Field, Input } from '@/components/ui';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import {
  deliveryStatusLabel,
  chargeStatusLabel,
  paymentModeLabel,
  paymentTxStatusLabel,
  pointStatusLabel,
  refundStatusLabel,
  shipmentStatusLabel,
} from '@/lib/labels';
import { digitalTypeLabel, fulfillmentLabel, productKindLabel } from '@/server/services/products';
import { PAID_STATUSES } from '@/components/studio/shared';

export const dynamic = 'force-dynamic';

export default async function StudioChargeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;

  const charge = await prisma.charge.findFirst({
    where: { id, merchantId },
    include: {
      payer: { select: { id: true, phoneMasked: true, displayName: true } },
      statusLogs: { orderBy: { createdAt: 'asc' } },
      transactions: {
        orderBy: { requestedAt: 'desc' },
        include: { attempts: { orderBy: { attemptNo: 'asc' } } },
      },
      mtMessages: { orderBy: { createdAt: 'desc' } },
      refunds: { orderBy: { requestedAt: 'desc' } },
      product: {
        select: { id: true, name: true, sku: true, kind: true, digitalType: true, fulfillment: true, imageUrl: true },
      },
      shipment: true,
    },
  });

  if (!charge) notFound();

  const st = chargeStatusLabel[charge.status];
  const blocked = charge.payer
    ? await prisma.blockedPayer.findUnique({
        where: { merchantId_payerId: { merchantId, payerId: charge.payer.id } },
        select: { createdAt: true },
      })
    : null;

  return (
    <>
      <PageHeader
        title="결제 상세"
        description={charge.transactionNo}
        action={
          <LinkButton href="/studio/charges" variant="secondary" size="sm">
            목록으로
          </LinkButton>
        }
      />

      <div className="space-y-5">
        <div className="grid gap-2.5 lg:grid-cols-3">
          <Card>
            <CardTitle>거래 정보</CardTitle>
            <div className="mt-2">
              <DataRow label="거래번호" value={<span className="font-mono text-[12px]">{charge.transactionNo}</span>} />
              <DataRow label="결제 상태" value={<Badge tone={st.tone}>{st.text}</Badge>} />
              <DataRow label="결제 금액" value={formatWon(charge.amount)} />
              <DataRow label="결제 모드" value={paymentModeLabel[charge.paymentMode]} />
              <DataRow label="수신시각" value={formatKst(charge.receivedAt)} />
              <DataRow label="결제시각" value={formatKst(charge.paidAt)} />
              {charge.statusReason ? <DataRow label="상태 사유" value={charge.statusReason} /> : null}
              {charge.isTest ? <DataRow label="테스트 여부" value={<Badge tone="warning">테스트 거래</Badge>} /> : null}
            </div>
          </Card>

          <Card>
            <CardTitle>후원자 · 메시지</CardTitle>
            <div className="mt-2">
              <DataRow label="후원자 번호" value={charge.payer?.phoneMasked ?? '-'} />
              <DataRow label="표시명" value={charge.anonymous ? '익명의 후원자' : charge.displayName} />
              <DataRow label="익명 처리" value={charge.anonymous ? '사용' : '미사용'} />
            </div>
            <p className="mt-3 rounded-xl bg-ink-50 px-3 py-2.5 text-[13px] leading-relaxed text-ink-700">
              {charge.message || '(내용 없음)'}
            </p>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-400">
              필터링 결과만 표시됩니다. 문자 원문과 후원자 전화번호 전체는 사회복지기관에 제공되지 않습니다.
            </p>
          </Card>

          <Card>
            <CardTitle>정산 금액</CardTitle>
            <div className="mt-2">
              <DataRow label="결제 총액" value={formatWon(charge.amount)} />
              <DataRow label="결제수수료" value={formatWon(charge.pgFee)} />
              <DataRow label="플랫폼수수료" value={formatWon(charge.platformFee)} />
              {charge.feeVat > 0n ? (
                <DataRow label="수수료 부가세" value={`${formatWon(charge.feeVat)} (위 수수료에 포함)`} />
              ) : null}
              <DataRow label="정산 예정금" value={formatWon(charge.netAmount)} />
            </div>
            <div className="mt-2">
              <DataRow label="MT 안내" value={<Badge tone={deliveryStatusLabel[charge.mtStatus].tone}>{deliveryStatusLabel[charge.mtStatus].text}</Badge>} />
              <DataRow
                label="지급 처리"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <Badge tone={pointStatusLabel[charge.pointStatus].tone}>
                      {pointStatusLabel[charge.pointStatus].text}
                    </Badge>
                    {charge.pointNote ? (
                      <span className="text-[12px] text-ink-400">{charge.pointNote}</span>
                    ) : null}
                  </span>
                }
              />
            </div>
          </Card>
        </div>

        {/* ── 주문 정보 ─────────────────────────────────────────
            상품·수량·옵션·배송 상태가 없으면 주문 화면에서 여기로 들어왔을 때
            오히려 정보가 줄어든다. 실물이면 배송지까지 여기서 확인·처리할 수 있어야 한다. */}
        {charge.product || charge.shipment ? (
          <section>
            <SectionTitle title="주문 정보" description="이 결제로 팔린 상품과 배송 상태입니다." />
            <div className="grid gap-2.5 lg:grid-cols-2">
              <Card>
                <CardTitle>상품</CardTitle>
                <div className="mt-2 flex items-start gap-3">
                  {charge.product?.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={charge.product.imageUrl}
                      alt=""
                      className="h-14 w-14 shrink-0 rounded-xl border border-ink-100 object-cover"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <DataRow
                      label="상품"
                      value={
                        charge.product ? (
                          <a href={`/studio/products/${charge.product.id}`} className="font-bold text-brand-700 hover:underline">
                            {charge.product.name}
                          </a>
                        ) : (
                          '직접 입력 결제'
                        )
                      }
                    />
                    {charge.product ? (
                      <DataRow
                        label="종류"
                        value={
                          charge.product.kind === 'DIGITAL'
                            ? `${productKindLabel.DIGITAL} · ${digitalTypeLabel[charge.product.digitalType ?? 'POINT']} · ${fulfillmentLabel[charge.product.fulfillment].text}`
                            : productKindLabel[charge.product.kind]
                        }
                      />
                    ) : null}
                    {charge.product?.sku ? (
                      <DataRow label="SKU" value={<span className="font-mono text-[12px]">{charge.product.sku}</span>} />
                    ) : null}
                    <DataRow label="수량" value={`${charge.quantity}개`} />
                    {charge.optionText ? <DataRow label="옵션" value={charge.optionText} /> : null}
                    <DataRow label="상품 금액" value={formatWon(charge.amount - charge.shippingFee)} />
                    <DataRow
                      label="배송비"
                      value={charge.shippingFee === 0n ? '무료 · 해당 없음' : formatWon(charge.shippingFee)}
                    />
                  </div>
                </div>
              </Card>

              {charge.shipment ? (
                <Card>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <CardTitle>배송</CardTitle>
                    <Badge tone={shipmentStatusLabel[charge.shipment.status].tone}>
                      {shipmentStatusLabel[charge.shipment.status].text}
                    </Badge>
                    {charge.shipment.remote ? <Badge tone="warning">도서산간</Badge> : null}
                  </div>
                  <div className="mb-3">
                    <AddressReveal
                      chargeId={charge.id}
                      receiverMasked={charge.shipment.receiverMasked}
                      phoneMasked={charge.shipment.phoneMasked}
                      addressMasked={charge.shipment.addressMasked}
                      zipCode={charge.shipment.zipCode}
                    />
                  </div>
                  <DataRow label="택배사" value={charge.shipment.carrier ?? '미등록'} />
                  <DataRow
                    label="송장번호"
                    value={
                      charge.shipment.trackingNo ? (
                        <span className="font-mono text-[12px]">{charge.shipment.trackingNo}</span>
                      ) : (
                        '미등록'
                      )
                    }
                  />
                  <DataRow label="발송시각" value={formatKst(charge.shipment.shippedAt)} />
                  <DataRow label="배송완료시각" value={formatKst(charge.shipment.deliveredAt)} />
                  {charge.shipment.returnReason ? (
                    <DataRow label="반품·교환 사유" value={charge.shipment.returnReason} />
                  ) : null}
                  <div className="mt-3">
                    <LinkButton href="/studio/orders" variant="secondary" size="sm">
                      후원 처리에서 처리
                    </LinkButton>
                  </div>
                </Card>
              ) : null}
            </div>
          </section>
        ) : null}

        <section>
          <SectionTitle title="조치" description="아래 동작은 결제 상태를 변경하지 않습니다." />
          <div className="grid gap-2.5 lg:grid-cols-2">
            <Card>
              <CardTitle>후원자 차단</CardTitle>
              {charge.payer ? (
                blocked ? (
                  <Notice tone="warning">
                    이미 차단된 후원자입니다. ({formatKst(blocked.createdAt, false)} 차단) 해제는 금칙어·차단 메뉴에서
                    할 수 있습니다.
                  </Notice>
                ) : (
                  <>
                    <p className="mb-3 mt-1 text-[12.5px] leading-relaxed text-ink-500">
                      차단하면 이 후원자({charge.payer.phoneMasked})의 이후 문자는 결제로 접수되지 않습니다.
                    </p>
                    <ActionForm
                      action={blockPayerAction}
                      submitLabel="후원자 차단"
                      variant="danger"
                      size="sm"
                      confirmMessage="이 후원자를 차단하시겠습니까? 이후 문자는 결제로 접수되지 않습니다."
                    >
                      <input type="hidden" name="payerId" value={charge.payer.id} />
                      <input type="hidden" name="reason" value={`결제 상세(${charge.transactionNo})에서 차단`} />
                    </ActionForm>
                  </>
                )
              ) : (
                <Notice tone="neutral">연결된 후원자 프로필이 없어 차단할 수 없습니다.</Notice>
              )}
            </Card>

            {/* 사회복지기관은 환불을 직접 실행할 수 없다(결제사 취소·정산 반대분개가 함께 일어난다).
                그래도 품절·배송불가처럼 사회복지기관만 아는 사유를 올릴 통로는 있어야 한다. */}
            <Card>
              <CardTitle>환불 요청</CardTitle>
              {charge.status === 'REFUNDED' ? (
                <Notice tone="neutral">이미 환불이 완료된 거래입니다.</Notice>
              ) : charge.refunds.some((r) => ['REQUESTED', 'APPROVED', 'DONE'].includes(r.status)) ? (
                <Notice tone="warning">
                  이미 환불이 요청된 거래입니다. 아래 환불 내역에서 진행 상태를 확인하실 수 있습니다.
                </Notice>
              ) : !PAID_STATUSES.includes(charge.status) ? (
                <Notice tone="neutral">결제가 완료된 거래만 환불을 요청할 수 있습니다.</Notice>
              ) : (
                <>
                  <p className="mb-3 mt-1 text-[12.5px] leading-relaxed text-ink-500">
                    요청하면 통합 관리자가 확인 후 결제사 취소와 정산 정정을 처리합니다. 요청만으로 환불이 완료되지는
                    않습니다.
                  </p>
                  <ActionForm
                    action={requestChargeRefundAction}
                    submitLabel="환불 요청"
                    variant="danger"
                    size="sm"
                    confirmMessage="통합 관리자 승인 후 실제 환불이 처리됩니다. 요청하시겠습니까?"
                  >
                    <input type="hidden" name="chargeId" value={charge.id} />
                    <Field label="사유" hint="품절 · 배송불가 · 후원자 요청 등. 5자 이상." required>
                      <Input name="reason" maxLength={200} placeholder="재고 소진으로 배송 불가" />
                    </Field>
                  </ActionForm>
                </>
              )}
            </Card>
          </div>
        </section>

        <section>
          <SectionTitle title="상태 이력" />
          {charge.statusLogs.length === 0 ? (
            <EmptyState title="상태 이력이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>시각</Th>
                  <Th>이전 상태</Th>
                  <Th>변경 상태</Th>
                  <Th>사유</Th>
                  <Th>처리자</Th>
                </tr>
              </thead>
              <tbody>
                {charge.statusLogs.map((log) => (
                  <tr key={log.id}>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(log.createdAt)}</Td>
                    <Td>{log.fromStatus ? chargeStatusLabel[log.fromStatus].text : '-'}</Td>
                    <Td>
                      <Badge tone={chargeStatusLabel[log.toStatus].tone}>{chargeStatusLabel[log.toStatus].text}</Badge>
                    </Td>
                    <Td>{log.reason ?? '-'}</Td>
                    <Td>{log.actor ?? '-'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <section>
          <SectionTitle title="결제 시도" description="카드번호·계좌 등 금융정보는 표시되지 않습니다." />
          {charge.transactions.length === 0 ? (
            <EmptyState title="결제 시도 내역이 없습니다" />
          ) : (
            <div className="space-y-2.5">
              {charge.transactions.map((tx) => {
                const tone = paymentTxStatusLabel[tx.status];
                return (
                  <Card key={tx.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[12px] font-semibold text-ink-900">{tx.orderNo}</span>
                        <Badge tone={tone.tone}>{tone.text}</Badge>
                        <span className="text-[12px] text-ink-400">{tx.provider}</span>
                      </div>
                      <span className="text-[13px] font-semibold tabular-nums">{formatWon(tx.amount)}</span>
                    </div>
                    <div className="mt-2">
                      <DataRow label="요청시각" value={formatKst(tx.requestedAt)} />
                      <DataRow label="승인시각" value={formatKst(tx.approvedAt)} />
                      {tx.resultCode || tx.resultMessage ? (
                        <DataRow label="결과" value={`${tx.resultCode ?? '-'} ${tx.resultMessage ?? ''}`.trim()} />
                      ) : null}
                    </div>
                    {tx.attempts.length > 0 ? (
                      <ul className="mt-2 space-y-1.5">
                        {tx.attempts.map((a) => (
                          <li key={a.id} className="rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] text-ink-700">
                            <span className="font-semibold">
                              {a.attemptNo}차 · {a.operation}
                            </span>
                            <span className="ml-2 text-ink-400">{formatKst(a.createdAt)}</span>
                            {a.latencyMs != null ? <span className="ml-2 text-ink-400">{a.latencyMs}ms</span> : null}
                            {a.errorCode ? (
                              <span className="ml-2 text-danger-500">
                                {a.errorCode} {a.errorMessage ?? ''}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <SectionTitle title="MT 발송 로그" description="발송 본문은 보안 링크 토큰이 제거된 마스킹 값입니다." />
          {charge.mtMessages.length === 0 ? (
            <EmptyState title="MT 발송 내역이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>시각</Th>
                  <Th>상태</Th>
                  <Th>수신번호</Th>
                  <Th>템플릿</Th>
                  <Th>본문(마스킹)</Th>
                  <Th>결과</Th>
                </tr>
              </thead>
              <tbody>
                {charge.mtMessages.map((m) => {
                  const tone = deliveryStatusLabel[m.status];
                  return (
                    <tr key={m.id}>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(m.sentAt ?? m.createdAt)}</Td>
                      <Td>
                        <Badge tone={tone.tone}>{tone.text}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap">{m.phoneMasked}</Td>
                      <Td>{m.templateCode ?? '-'}</Td>
                      <Td className="max-w-[320px]">
                        <span className="line-clamp-2">{m.bodyMasked}</span>
                      </Td>
                      <Td>{m.resultCode ? `${m.resultCode} ${m.resultMessage ?? ''}`.trim() : '-'}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>

        {charge.refunds.length > 0 ? (
          <section>
            <SectionTitle title="환불 내역" />
            <Table>
              <thead>
                <tr>
                  <Th>요청시각</Th>
                  <Th>상태</Th>
                  <Th className="text-right">금액</Th>
                  <Th>사유</Th>
                  <Th>처리시각</Th>
                </tr>
              </thead>
              <tbody>
                {charge.refunds.map((r) => {
                  const tone = refundStatusLabel[r.status];
                  return (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(r.requestedAt)}</Td>
                      <Td>
                        <Badge tone={tone.tone}>{tone.text}</Badge>
                      </Td>
                      <Td className="text-right tabular-nums">{formatWon(r.amount)}</Td>
                      <Td>{r.reason ?? '-'}</Td>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(r.processedAt)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </section>
        ) : null}
      </div>
    </>
  );
}
