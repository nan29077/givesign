import Link from 'next/link';
import {
  Card, CardTitle, Field, Input, Notice, Select, Textarea,
} from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { GalleryField } from '@/components/studio/gallery-field';
import { OptionEditor, type EditorOption } from '@/components/studio/option-editor';
import { NoticeInfoField } from '@/components/studio/notice-info-field';
import {
  MAX_EXTRA_IMAGES, NOTICE_CATEGORIES, OPTION_LIMIT, fulfillmentLabel,
  type NoticeInfo, type ProductOption, type ShippingPolicyView,
} from '@/server/services/products';
import { formatWon } from '@/lib/money';
import type { ChargeProduct } from '@/generated/prisma/client';
import type { ProductKind } from '@/generated/prisma/enums';
import type { StudioActionState } from '@/app/actions/studio';

/**
 * 상품 등록·수정 폼 (실물 · 비실물 공용).
 *
 * 일반적인 판매자 콘솔처럼 섹션으로 끊어 놓는다. 한 화면에 입력칸을 20개 늘어놓으면
 * 무엇이 필수인지, 무엇이 배송에 영향을 주는지 사회복지기관이 구분하지 못한다.
 */

type Action = (prev: StudioActionState, formData: FormData) => Promise<StudioActionState>;

/** 폼이 다루는 값만 추린 상품. 새 상품이면 null 을 넘긴다. */
export type ProductFormValue = ChargeProduct;

function Section({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-brand-100 text-[12px] font-black text-brand-800">
          {step}
        </span>
        <div>
          <CardTitle>{title}</CardTitle>
          {description ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{description}</p> : null}
        </div>
      </div>
      <div className="space-y-3.5">{children}</div>
    </Card>
  );
}

export function ProductForm({
  action,
  kind,
  product,
  options,
  notice,
  images,
  shipping,
  effMin,
  effMax,
  submitLabel,
  documentTemplates = [],
  donationMode = false,
}: {
  action: Action;
  kind: ProductKind;
  product: ProductFormValue | null;
  options: ProductOption[];
  notice: NoticeInfo | null;
  images: string[];
  shipping: ShippingPolicyView;
  effMin: bigint;
  effMax: bigint;
  submitLabel: string;
  /** 문서 상품에 연결할 수 있는 서식. 문서 종류에서만 쓴다. */
  documentTemplates?: Array<{ id: string; name: string }>;
  /**
   * 상품 기능(FEATURE_GOODS)이 꺼진 기본 설정. 비실물 항목을 "후원 항목"(금액·용도)으로만 다루고
   * 지급 유형·지급 수량·지급 방식처럼 상품 판매에만 쓰는 입력은 감춘다(점검 M-18).
   */
  donationMode?: boolean;
}) {
  const isPhysical = kind === 'PHYSICAL';
  const isDocument = kind === 'DOCUMENT';
  const editorOptions: EditorOption[] = options.map((o) => ({
    name: o.name,
    values: o.values.map((v) => ({ label: v.label, addPrice: v.addPrice.toString(), soldOut: v.soldOut })),
  }));
  const noticeValues = Object.fromEntries((notice?.items ?? []).map((i) => [i.label, i.value]));

  return (
    <ActionForm action={action} submitLabel={submitLabel} size="lg" className="space-y-4">
      <input type="hidden" name="kind" value={kind} />
      {product ? <input type="hidden" name="productId" value={product.id} /> : null}

      {/* ── 1. 기본 정보 ───────────────────────────────────────── */}
      <Section step={1} title="기본 정보" description="후원 화면에 그대로 보이는 이름과 노출 여부입니다.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={donationMode ? '항목 이름' : '상품 이름'} hint="40자 이내. 같은 이름은 쓸 수 없습니다." required>
            <Input
              name="name"
              maxLength={40}
              defaultValue={product?.name ?? ''}
              placeholder={isPhysical ? '기념 굿즈 티셔츠' : donationMode ? '김장 나눔 1만원' : '10,000원 이용권'}
            />
          </Field>

          {isPhysical ? (
            <Field label="상품 코드 (SKU)" hint="사회복지기관 내부 관리용. 주문서 엑셀에 함께 나갑니다.">
              <Input name="sku" maxLength={40} defaultValue={product?.sku ?? ''} placeholder="TS-001" />
            </Field>
          ) : isDocument ? (
            <Field
              label="연결할 문서 서식"
              hint="결제가 끝나면 이 서식의 작성 링크를 문자로 보냅니다."
              required
            >
              {documentTemplates.length === 0 ? (
                <p className="rounded-xl border border-dashed border-ink-200 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-400">
                  사용 중인 서식이 없습니다.{' '}
                  <Link href="/studio/documents/new" className="font-bold text-brand-700">
                    문서 관리
                  </Link>{' '}
                  에서 서식을 먼저 등록해 주세요.
                </p>
              ) : (
                <Select name="documentTemplateId" defaultValue={product?.documentTemplateId ?? ''}>
                  <option value="">서식을 골라 주세요</option>
                  {documentTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : donationMode ? (
            <input type="hidden" name="digitalType" value={product?.digitalType ?? 'POINT'} />
          ) : (
            <Field label="유형" required>
              <Select name="digitalType" defaultValue={product?.digitalType ?? 'POINT'}>
                <option value="POINT">포인트</option>
                <option value="VOUCHER">상품권</option>
                <option value="PASS">이용권</option>
                <option value="CONTENT">컨텐츠</option>
              </Select>
            </Field>
          )}
        </div>

        {/*
          체크박스는 해제하면 FormData 에 아예 담기지 않는다.
          그래서 "값이 안 왔다"와 "꺼서 안 왔다"를 구분할 짝(hidden)이 반드시 있어야 한다.
          이 hidden 이 없으면 서버는 항상 노출(true)로 저장한다.
        */}
        <input type="hidden" name="activePresent" value="1" />
        <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-800">
          <input type="checkbox" name="active" defaultChecked={product ? product.active : true} className="h-4 w-4" />
          후원 화면에 노출
        </label>
      </Section>

      {/* ── 2. 판매 정보 ───────────────────────────────────────── */}
      <Section
        step={2}
        title={donationMode ? '후원 금액' : '판매 정보'}
        description={`등록 가능한 금액은 ${formatWon(effMin)} ~ ${formatWon(effMax)} 입니다.`}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={donationMode ? '후원 금액 (원)' : '판매 금액 (원)'}
            hint={isPhysical ? '배송비를 뺀 상품 1개 가격' : undefined}
            required
          >
            <Input
              name="amount"
              inputMode="numeric"
              defaultValue={product?.amount.toString() ?? ''}
              placeholder={isPhysical ? '19000' : '10000'}
              className="tabular-nums"
            />
          </Field>

          {donationMode ? null : (
            <div className="flex items-end">
              <label className="flex items-center gap-2 pb-3 text-[13px] font-semibold text-ink-800">
                <input type="checkbox" name="taxFree" defaultChecked={product?.taxFree ?? false} className="h-4 w-4" />
                면세 상품
                <span className="font-normal text-ink-400">(정산 부가세 계산 기준)</span>
              </label>
            </div>
          )}
        </div>

        {isDocument || donationMode ? null : isPhysical ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="재고" hint="비우면 무제한. 결제 승인 시 차감됩니다.">
              <Input
                name="stock"
                inputMode="numeric"
                defaultValue={product?.stock != null ? String(product.stock) : ''}
                placeholder="50"
                className="tabular-nums"
              />
            </Field>
            <Field label="재고 경고 기준" hint="이 수량 이하면 목록에서 경고합니다.">
              <Input
                name="stockAlert"
                inputMode="numeric"
                defaultValue={product?.stockAlert != null ? String(product.stockAlert) : ''}
                placeholder="5"
                className="tabular-nums"
              />
            </Field>
            <Field label="1회 주문 최대 수량" hint="비우면 결제 한도까지">
              <Input
                name="maxPerOrder"
                inputMode="numeric"
                defaultValue={product?.maxPerOrder != null ? String(product.maxPerOrder) : ''}
                placeholder="2"
                className="tabular-nums"
              />
            </Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="지급 수량" hint="비우면 포인트는 금액과 1:1">
              <Input
                name="giveAmount"
                inputMode="numeric"
                defaultValue={product?.giveAmount != null ? product.giveAmount.toString() : ''}
                placeholder="11000"
                className="tabular-nums"
              />
            </Field>
            <Field label="지급 단위" hint="포인트 · 매 · 개월 · 개">
              <Input name="giveUnit" maxLength={10} defaultValue={product?.giveUnit ?? ''} placeholder="포인트" />
            </Field>
            <Field label="유효기간 (일)" hint="이용권은 필수. 비우면 무기한.">
              <Input
                name="validDays"
                inputMode="numeric"
                defaultValue={product?.validDays != null ? String(product.validDays) : ''}
                placeholder="30"
                className="tabular-nums"
              />
            </Field>
          </div>
        )}
      </Section>

      {/* ── 3. 옵션 / 지급 방식 / 문서 작성 ────────────────────── */}
      {isPhysical ? (
        <Section step={3} title="옵션" description="색상·사이즈처럼 후원자가 고르는 항목입니다.">
          <OptionEditor
            name="optionsJson"
            defaultValue={editorOptions}
            maxGroups={OPTION_LIMIT.groups}
            maxValues={OPTION_LIMIT.values}
          />
        </Section>
      ) : isDocument ? (
        <Section
          step={3}
          title="문서 작성"
          description="결제가 끝난 뒤 후원자가 무엇을 하게 되는지 정리한 내용입니다."
        >
          <Notice tone="neutral" title="결제 완료 즉시 작성 링크가 문자로 갑니다">
            후원자는 링크에서 서식 내용을 확인하고 작성·서명해 제출합니다. 제출된 문서는{' '}
            <Link href="/studio/documents?tab=submissions" className="font-bold text-brand-700">
              문서 관리 &gt; 제출된 문서
            </Link>{' '}
            에서 확인합니다. 배송과 지급은 일어나지 않습니다.
          </Notice>
          <Notice tone="warning" title="서식을 중지하면 결제할 수 없습니다">
            연결한 서식을 중지·보관하면 이 상품은 결제 화면에서 고를 수 없습니다. 판매 중에는 서식을 그대로 두세요.
          </Notice>
        </Section>
      ) : donationMode ? (
        <input type="hidden" name="fulfillment" value="MANUAL" />
      ) : (
        <Section step={3} title="지급 방식" description="결제가 끝난 뒤 후원자에게 무엇을 어떻게 주는지 정합니다.">
          <Field label="지급 방식" required>
            <Select name="fulfillment" defaultValue={product?.fulfillment ?? 'MANUAL'}>
              {(['MANUAL', 'API', 'INSTANT'] as const).map((m) => (
                <option key={m} value={m}>
                  {fulfillmentLabel[m].text}
                </option>
              ))}
            </Select>
          </Field>
          <ul className="space-y-1 rounded-xl bg-ink-50 px-3.5 py-2.5">
            {(['MANUAL', 'API', 'INSTANT'] as const).map((m) => (
              <li key={m} className="text-[11.5px] leading-relaxed text-ink-500">
                <span className="font-bold text-ink-700">{fulfillmentLabel[m].text}</span> — {fulfillmentLabel[m].hint}
              </li>
            ))}
          </ul>
          <Field
            label="즉시 발급 안내 문구"
            hint="지급 방식이 [결제 즉시 문자 발급] 일 때만 쓰입니다. 300자 이내. 전화번호·계좌번호는 넣을 수 없습니다."
          >
            <Textarea
              name="fulfillmentNote"
              rows={2}
              maxLength={300}
              defaultValue={product?.fulfillmentNote ?? ''}
              placeholder="쿠폰번호 ABCD-1234 를 앱 [쿠폰등록] 에 입력해 주세요."
            />
          </Field>
          <Field
            label="청약철회 제한 안내"
            hint="컨텐츠 상품은 필수입니다. 결제 화면에 그대로 보여집니다."
          >
            <Textarea
              name="withdrawalNotice"
              rows={2}
              maxLength={300}
              defaultValue={product?.withdrawalNotice ?? ''}
              placeholder="다운로드 또는 재생을 시작하면 청약철회가 제한됩니다."
            />
          </Field>
        </Section>
      )}

      {/* ── 4. 이미지 ─────────────────────────────────────────── */}
      <Section step={donationMode ? 3 : 4} title="이미지" description="후원 화면 목록의 썸네일과 상세 이미지로 쓰입니다.">
        <ImageUploadField
          name="imageUrl"
          label="대표 이미지"
          aspect="square"
          defaultValue={product?.imageUrl ?? ''}
          hint="목록의 썸네일과 상세 상단에 쓰입니다. 정사각형 권장."
        />
        <GalleryField
          name="extraImage"
          label="추가 이미지"
          max={MAX_EXTRA_IMAGES}
          defaultValue={images}
          hint="상세 화면에서 가로로 넘겨 볼 수 있습니다."
        />
      </Section>

      {/* ── 5. 상세 설명 ──────────────────────────────────────── */}
      <Section step={donationMode ? 4 : 5} title="상세 설명" description="후원 화면에서 항목을 고르면 펼쳐집니다.">
        <Field label={donationMode ? '항목 설명' : '상품 설명'} hint="2,000자 이내. 줄바꿈이 그대로 유지됩니다.">
          <Textarea
            name="description"
            rows={6}
            maxLength={2000}
            defaultValue={product?.description ?? ''}
            placeholder={donationMode ? '후원금이 어디에 어떻게 쓰이는지 적어 주세요.' : '소재 · 사용법 · 주의사항 등을 적어 주세요.'}
          />
        </Field>
      </Section>

      {/* ── 6. 배송 · 반품 (실물 전용) ─────────────────────────── */}
      {isPhysical ? (
        <>
          <Section
            step={6}
            title="배송 · 반품"
            description="비워 두면 후원 설정의 기본 배송정책을 따릅니다."
          >
            <Notice tone="neutral" title="지금 기본 정책">
              배송비 {formatWon(shipping.baseFee)}
              {shipping.freeOver != null ? ` · ${formatWon(shipping.freeOver)} 이상 무료` : ' · 조건부 무료 없음'}
              {' · '}출고 {shipping.dispatchDays}일
              {' · '}반품 {shipping.returnFee === 0n ? '무료' : formatWon(shipping.returnFee)}
              {' · '}교환 {shipping.exchangeFee === 0n ? '무료' : formatWon(shipping.exchangeFee)}
            </Notice>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="배송비 (원)" hint="비우면 기본 배송정책">
                <Input
                  name="shippingFee"
                  inputMode="numeric"
                  defaultValue={product?.shippingFee != null ? product.shippingFee.toString() : ''}
                  placeholder="3000"
                  className="tabular-nums"
                />
              </Field>
              <Field label="조건부 무료 기준 (원)" hint="비우면 기본 배송정책">
                <Input
                  name="freeShipOver"
                  inputMode="numeric"
                  defaultValue={product?.freeShipOver != null ? product.freeShipOver.toString() : ''}
                  placeholder="50000"
                  className="tabular-nums"
                />
              </Field>
              <Field label="출고 소요일 (영업일)" hint="비우면 기본 배송정책">
                <Input
                  name="dispatchDays"
                  inputMode="numeric"
                  defaultValue={product?.dispatchDays != null ? String(product.dispatchDays) : ''}
                  placeholder="2"
                  className="tabular-nums"
                />
              </Field>
              <div className="flex items-end">
                <label className="flex items-center gap-2 pb-3 text-[13px] font-semibold text-ink-800">
                  <input
                    type="checkbox"
                    name="freeShipping"
                    defaultChecked={product?.freeShipping ?? false}
                    className="h-4 w-4"
                  />
                  항상 무료배송
                </label>
              </div>
              <Field label="반품 배송비 (원)" hint="편도. 비우면 기본 배송정책">
                <Input
                  name="returnFee"
                  inputMode="numeric"
                  defaultValue={product?.returnFee != null ? product.returnFee.toString() : ''}
                  placeholder="3000"
                  className="tabular-nums"
                />
              </Field>
              <Field label="교환 배송비 (원)" hint="왕복. 비우면 기본 배송정책">
                <Input
                  name="exchangeFee"
                  inputMode="numeric"
                  defaultValue={product?.exchangeFee != null ? product.exchangeFee.toString() : ''}
                  placeholder="6000"
                  className="tabular-nums"
                />
              </Field>
            </div>

            {!shipping.returnAddress ? (
              <Notice tone="warning" title="반품지가 등록되어 있지 않습니다">
                반품·교환을 받을 주소가 없으면 후원자가 어디로 보낼지 알 수 없습니다.{' '}
                <Link href="/studio/settings?tab=shipping" className="font-bold text-brand-700">
                  후원 설정 &gt; 배송 정책
                </Link>{' '}
                에서 먼저 등록해 주세요.
              </Notice>
            ) : null}
          </Section>

          {/* ── 7. 고시 ─────────────────────────────────────────── */}
          <Section step={7} title="상품정보 제공 고시" description="전자상거래법상 실물 상품에 필요한 정보입니다.">
            <NoticeInfoField
              categories={NOTICE_CATEGORIES}
              defaultCategory={notice?.category}
              defaultValues={noticeValues}
            />
          </Section>
        </>
      ) : null}
    </ActionForm>
  );
}
