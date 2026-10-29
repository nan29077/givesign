import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { Notice } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ProductForm } from '@/components/studio/product-form';
import { createChargeProductAction } from '@/app/actions/studio';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { resolvePolicy } from '@/server/services/limits';
import { shippingPolicyOf } from '@/server/services/products';
import { MAX_CHARGE_PRODUCTS } from '@/components/studio/shared';
import { featureGoodsEnabled } from '@/lib/env';
import type { ProductKind } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

/** 종류별 화면 문구. 상품 종류가 셋이 되면서 삼항 중첩이 읽히지 않게 표로 뺀다. */
const KIND_TEXT: Record<ProductKind, { title: string; what: string }> = {
  DIGITAL: { title: '비실물(컨텐츠)', what: '포인트 · 상품권 · 이용권 · 컨텐츠' },
  PHYSICAL: { title: '실물', what: '배송이 필요한 상품' },
  DOCUMENT: { title: '문서', what: '결제 뒤 후원자가 작성해 제출하는 약정서 · 주문서 · 계약서' },
};

/** 상품 등록. 종류는 주소로 받아 폼 구성을 바꾼다(등록 후에는 바꿀 수 없다). */
export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  // 종류는 등록 후 바꿀 수 없다. 오타(?kind=Digital)를 조용히 실물로 처리하면
  // 잘못 등록한 상품을 보관하고 다시 만들어야 한다.
  const goods = featureGoodsEnabled();
  // 상품 기능이 꺼져 있으면 후원 항목(비실물)만 만든다(점검 M-18).
  const kindRaw = goods ? (sp.kind ?? '').trim() : 'digital';
  if (kindRaw !== 'digital' && kindRaw !== 'physical' && kindRaw !== 'document') redirect('/studio/products');
  const kind: ProductKind =
    kindRaw === 'digital' ? 'DIGITAL' : kindRaw === 'document' ? 'DOCUMENT' : 'PHYSICAL';

  const [merchant, policy, shippingRow, count, documentTemplates] = await Promise.all([
    prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { minAmount: true, maxAmount: true },
    }),
    resolvePolicy(merchantId, null),
    prisma.merchantShippingPolicy.findUnique({ where: { merchantId } }),
    prisma.chargeProduct.count({ where: { merchantId, kind, archivedAt: null } }),
    // 문서 상품에 연결할 서식. 중지·보관된 서식은 고를 수 없다.
    kind === 'DOCUMENT'
      ? prisma.documentTemplate.findMany({
          where: { merchantId, active: true, archivedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  if (!merchant) notFound();

  const effMin = merchant.minAmount > policy.minAmount ? merchant.minAmount : policy.minAmount;
  const effMax = merchant.maxAmount < policy.maxAmount ? merchant.maxAmount : policy.maxAmount;
  const full = count >= MAX_CHARGE_PRODUCTS;

  return (
    <>
      <Link
        href={`/studio/products?tab=${kindRaw}`}
        className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900"
      >
        <ChevronLeft size={15} strokeWidth={1.8} />
        후원 항목 관리로
      </Link>

      <PageHeader
        title={goods ? `${KIND_TEXT[kind].title} 상품 등록` : '후원 항목 등록'}
        description={
          goods
            ? `${KIND_TEXT[kind].what} 을(를) 등록합니다. 종류는 등록 후 바꿀 수 없습니다. (${count}/${MAX_CHARGE_PRODUCTS}개 사용)`
            : `후원자가 고를 금액과 용도를 등록합니다. (${count}/${MAX_CHARGE_PRODUCTS}개 사용)`
        }
      />

      {full ? (
        <Notice tone="warning" title={`${goods ? `${KIND_TEXT[kind].title} 상품` : '후원 항목'}이 이미 ${MAX_CHARGE_PRODUCTS}개입니다`}>
          후원 화면이 감당할 수 있는 선택지 수라 종류별로 {MAX_CHARGE_PRODUCTS}개까지만 등록할 수 있습니다. 먼저 쓰지
          않는 항목을 보관해 주세요.
        </Notice>
      ) : kind === 'DOCUMENT' && documentTemplates.length === 0 ? (
        <Notice tone="warning" title="먼저 문서 서식을 등록해 주세요">
          문서 상품은 작성할 서식을 가리킵니다. 서식이 없으면 후원자는 결제만 하고 작성할 곳이 없습니다.{' '}
          <Link href="/studio/documents/new" className="font-bold text-brand-700">
            문서 관리 &gt; 서식 등록
          </Link>{' '}
          에서 서식을 만든 뒤 다시 와 주세요.
        </Notice>
      ) : (
        <ProductForm
          action={createChargeProductAction}
          kind={kind}
          product={null}
          options={[]}
          notice={null}
          images={[]}
          shipping={shippingPolicyOf(shippingRow)}
          effMin={effMin}
          effMax={effMax}
          submitLabel={goods ? '상품 등록' : '후원 항목 등록'}
          documentTemplates={documentTemplates}
          donationMode={!goods && kind === 'DIGITAL'}
        />
      )}
    </>
  );
}
