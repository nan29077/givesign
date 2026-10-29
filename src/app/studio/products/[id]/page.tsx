import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, FileSignature, Package } from 'lucide-react';
import { Badge, Card, CardTitle, DataRow, Field, Input, Notice, cx } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm, InlineActionForm } from '@/components/studio/action-form';
import { ProductForm } from '@/components/studio/product-form';
import { featureGoodsEnabled } from '@/lib/env';
import {
  adjustProductStockAction,
  archiveChargeProductAction,
  duplicateChargeProductAction,
  updateChargeProductAction,
} from '@/app/actions/studio';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { resolvePolicy } from '@/server/services/limits';
import {
  digitalTypeLabel, effectiveDelivery, fulfillmentLabel, giveText, noticeCategoryOf, noticeMissing,
  parseImages, parseNoticeInfo, parseOptions, productKindLabel, quoteShipping, shippingPolicyOf,
} from '@/server/services/products';
import { formatNumber, formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

/** 상품 수정. 왼쪽은 폼, 오른쪽은 후원자에게 보이는 모습 미리보기. */
export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;

  const [product, merchant, policy, shippingRow, sold, documentTemplates] = await Promise.all([
    prisma.chargeProduct.findFirst({
      where: { id, merchantId },
      include: { documentTemplate: { select: { id: true, name: true, active: true } } },
    }),
    prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { displayName: true, minAmount: true, maxAmount: true },
    }),
    resolvePolicy(merchantId, null),
    prisma.merchantShippingPolicy.findUnique({ where: { merchantId } }),
    prisma.charge.count({ where: { merchantId, productId: id } }),
    prisma.documentTemplate.findMany({
      where: { merchantId, active: true, archivedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  if (!product || !merchant) notFound();
  // 상품 기능이 꺼져 있으면 실물·문서 항목은 편집 화면도 열지 않는다(점검 M-18).
  const goods = featureGoodsEnabled();
  if (!goods && product.kind !== 'DIGITAL') notFound();

  const shipping = shippingPolicyOf(shippingRow);
  const effMin = merchant.minAmount > policy.minAmount ? merchant.minAmount : policy.minAmount;
  const effMax = merchant.maxAmount < policy.maxAmount ? merchant.maxAmount : policy.maxAmount;

  const options = parseOptions(product.options);
  const notice = parseNoticeInfo(product.noticeInfo);
  const images = parseImages(product.images);
  const isPhysical = product.kind === 'PHYSICAL';
  const isDocument = product.kind === 'DOCUMENT';
  // 수정 화면에서는 현재 연결된 서식도 목록에 남아 있어야 한다.
  // 그 서식이 중지되면 드롭다운에서 사라져, 저장할 때마다 다른 서식으로 바뀔 위험이 생긴다.
  const templateOptions =
    product.documentTemplate && !documentTemplates.some((t) => t.id === product.documentTemplate!.id)
      ? [...documentTemplates, { id: product.documentTemplate.id, name: `${product.documentTemplate.name} (중지)` }]
      : documentTemplates;
  const delivery = effectiveDelivery(product, shipping);

  // 미리보기 금액: 1개 주문 + 가장 비싼 옵션 조합 기준.
  const maxAdd = options.reduce(
    (sum, o) => sum + o.values.reduce((m, v) => (v.addPrice > m ? v.addPrice : m), 0n),
    0n,
  );
  const quote = quoteShipping(product, 1, shipping);
  const quoteMax = quoteShipping(product, 1, shipping, false, maxAdd);
  const missing = isPhysical ? noticeMissing(notice) : [];

  return (
    <>
      <Link
        href={`/studio/products?tab=${isPhysical ? 'physical' : isDocument ? 'document' : 'digital'}`}
        className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900"
      >
        <ChevronLeft size={15} strokeWidth={1.8} />
        후원 항목 관리로
      </Link>

      <PageHeader
        title={product.name}
        description={`${productKindLabel[product.kind]} 상품 · 판매 ${formatNumber(sold)}건${
          product.archivedAt ? ' · 보관됨' : ''
        }`}
      />

      {product.archivedAt ? (
        <Notice tone="warning" title="보관된 상품입니다">
          보관 중에는 수정할 수 없습니다.{' '}
          <Link href="/studio/products?tab=archived" className="font-bold text-brand-700">
            보관함
          </Link>{' '}
          에서 먼저 되살려 주세요.
        </Notice>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            <ProductForm
              action={updateChargeProductAction}
              kind={product.kind}
              product={product}
              options={options}
              notice={notice}
              images={images}
              shipping={shipping}
              effMin={effMin}
              effMax={effMax}
              submitLabel={goods ? '상품 저장' : '저장'}
              documentTemplates={templateOptions}
              donationMode={!goods && product.kind === 'DIGITAL'}
            />

            <Card className="mt-4">
              <CardTitle>이 후원 항목 관리</CardTitle>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                {isPhysical ? (
                  <ActionForm action={adjustProductStockAction} submitLabel="재고 맞추기" variant="secondary" size="sm">
                    <input type="hidden" name="productId" value={product.id} />
                    <Field label="재고 즉시 조정" hint="입고·실사 반영용. 비우고 저장하면 무제한.">
                      <Input
                        name="stock"
                        inputMode="numeric"
                        defaultValue={product.stock != null ? String(product.stock) : ''}
                        className="w-28 tabular-nums"
                      />
                    </Field>
                  </ActionForm>
                ) : null}
                <InlineActionForm
                  action={duplicateChargeProductAction}
                  submitLabel="복제"
                  variant="secondary"
                  fields={{ productId: product.id }}
                  confirmMessage="이 상품을 그대로 복제합니다. 복제본은 숨김 상태로 만들어집니다."
                />
                <InlineActionForm
                  action={archiveChargeProductAction}
                  submitLabel="보관"
                  variant="danger"
                  fields={{ productId: product.id }}
                  confirmMessage="선택 화면에서 사라지며, 지난 후원 내역은 그대로 남습니다. 보관함에서 되살릴 수 있습니다."
                />
              </div>
            </Card>
          </div>

          {/* ── 미리보기 ─────────────────────────────────────────── */}
          <aside className="min-w-0 xl:sticky xl:top-20 xl:self-start">
            <Card>
              <CardTitle>후원자에게 보이는 모습</CardTitle>
              <p className="mb-3 mt-0.5 text-[11.5px] leading-relaxed text-ink-400">
                저장한 값 기준입니다. 수정 후 저장하면 이 미리보기도 함께 바뀝니다.
              </p>

              <div
                className={cx(
                  'rounded-2xl px-3.5 py-2.5',
                  product.active ? 'bg-ink-900 text-brand-400' : 'bg-ink-50 text-ink-400',
                )}
              >
                <span className="flex items-center gap-2">
                  {product.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={product.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
                  ) : isPhysical ? (
                    <Package size={13} strokeWidth={1.6} className="shrink-0 opacity-70" />
                  ) : isDocument ? (
                    <FileSignature size={13} strokeWidth={1.6} className="shrink-0 opacity-70" />
                  ) : null}
                  <span className="block text-[13.5px] font-bold leading-tight">{product.name}</span>
                </span>
                <span className="mt-0.5 block text-[12px] font-semibold opacity-80">
                  {formatWon(product.amount)}
                  {isPhysical ? (
                    <span className="ml-1 opacity-70">
                      {quote.freeReason ? '· 배송비 무료' : `· 배송비 ${formatWon(quote.fee)}`}
                    </span>
                  ) : isDocument ? (
                    <span className="ml-1 opacity-70">· 문서 작성</span>
                  ) : product.digitalType ? (
                    <span className="ml-1 opacity-70">· {digitalTypeLabel[product.digitalType]}</span>
                  ) : null}
                </span>
                {giveText(product) ? (
                  <span className="mt-0.5 block text-[11px] opacity-70">{giveText(product)} 지급</span>
                ) : null}
              </div>

              <div className="mt-3">
                <DataRow label="결제 금액 (1개)" value={formatWon(quote.total)} />
                {maxAdd > 0n ? (
                  <DataRow label="옵션 최대 선택 시" value={formatWon(quoteMax.total)} />
                ) : null}
                <DataRow
                  label="결제 한도 통과"
                  value={
                    quoteMax.total > effMax ? (
                      <Badge tone="danger">한도 초과</Badge>
                    ) : quoteMax.total < effMin ? (
                      <Badge tone="danger">최소 금액 미만</Badge>
                    ) : (
                      <Badge tone="success">정상</Badge>
                    )
                  }
                />
                {isPhysical ? (
                  <>
                    <DataRow label="출고 소요" value={`영업일 ${delivery.dispatchDays}일`} />
                    <DataRow
                      label="반품 / 교환 배송비"
                      value={`${delivery.returnFee === 0n ? '무료' : formatWon(delivery.returnFee)} / ${
                        delivery.exchangeFee === 0n ? '무료' : formatWon(delivery.exchangeFee)
                      }`}
                    />
                    <DataRow label="고시 품목" value={notice ? noticeCategoryOf(notice.category).label : '미작성'} />
                  </>
                ) : isDocument ? (
                  <>
                    <DataRow
                      label="연결된 서식"
                      value={
                        product.documentTemplate ? (
                          <Link
                            href={`/studio/documents/${product.documentTemplate.id}`}
                            className="text-brand-700 hover:underline"
                          >
                            {product.documentTemplate.name}
                          </Link>
                        ) : (
                          <Badge tone="danger">미연결</Badge>
                        )
                      }
                    />
                    <DataRow
                      label="서식 상태"
                      value={
                        product.documentTemplate?.active ? (
                          <Badge tone="success">사용 중</Badge>
                        ) : (
                          <Badge tone="danger">중지</Badge>
                        )
                      }
                    />
                  </>
                ) : (
                  <DataRow label="지급 방식" value={fulfillmentLabel[product.fulfillment].text} />
                )}
              </div>

              {isDocument && !product.documentTemplate?.active ? (
                <div className="mt-3">
                  <Notice tone="danger" title="이 상품은 결제되지 않습니다">
                    연결된 문서 서식이 없거나 중지 상태입니다. 결제해도 후원자가 작성할 문서가 없으므로 결제 화면
                    목록에서 빠집니다.{' '}
                    <Link href="/studio/documents" className="font-bold text-brand-700">
                      문서 관리
                    </Link>{' '}
                    에서 서식 사용을 켜 주세요.
                  </Notice>
                </div>
              ) : null}

              {quoteMax.total > effMax ? (
                <div className="mt-3">
                  <Notice tone="danger" title="이 상품은 결제되지 않습니다">
                    배송비·옵션 추가금까지 더한 금액이 결제 한도({formatWon(effMax)})를 넘습니다. 가격이나 추가금을
                    낮춰 주세요.
                  </Notice>
                </div>
              ) : null}

              {missing.length > 0 ? (
                <div className="mt-3">
                  <Notice tone="warning" title="고시 항목이 비어 있습니다">
                    {missing.slice(0, 3).join(' · ')}
                    {missing.length > 3 ? ` 외 ${missing.length - 3}개` : ''} 가 비어 있습니다. 전자상거래법상 실물
                    상품에는 표시가 필요합니다.
                  </Notice>
                </div>
              ) : null}

              {!product.active ? (
                <div className="mt-3">
                  <Notice tone="neutral">
                    지금은 숨김 상태라 결제 화면에 나오지 않습니다. 위 [기본 정보] 에서 노출을 켜 주세요.
                  </Notice>
                </div>
              ) : null}
            </Card>
          </aside>
        </div>
      )}
    </>
  );
}
