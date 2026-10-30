import { notFound } from 'next/navigation';
import { formatMoNumber } from '@/lib/mo-number';
import Link from 'next/link';
import { featureGoodsEnabled } from '@/lib/env';
import { ExternalLink, Info } from 'lucide-react';
import {
  Badge, Card, CardTitle, DataRow, Field, Input, LinkButton, Notice, SectionTitle, Select, Textarea, cx,
} from '@/components/ui';
import { DEFAULT_BANNERS, defaultBannerFor } from '@/lib/banners';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm, InlineActionForm } from '@/components/studio/action-form';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { ChargePageShare } from '@/components/studio/charge-page-share';
import { MtMessageSection } from '@/components/studio/mt-message-section';
import {
  updateChargeSettingsAction,
  updateChargePageAction,
  updateThanksMessageAction,
  updateMoGuideMessageAction,
  saveShippingPolicyAction,
  createApiKeyAction,
  revokeApiKeyAction,
  updateApiKeyIpsAction,
  saveMtTemplateAction,
  deleteMtTemplateAction,
  createWebhookAction,
  deleteWebhookAction,
  testWebhookAction,
} from '@/app/actions/studio';
import {
  THANKS_MT_MAX_LENGTH, THANKS_MT_VARIABLES, tplChargeSuccess,
  MO_GUIDE_MAX_LENGTH, MO_GUIDE_VARIABLES, tplSelectAmount,
} from '@/server/services/mt-templates';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { resolvePolicy } from '@/server/services/limits';
import { shippingPolicyOf } from '@/server/services/products';
import { env } from '@/lib/env';
import { formatKst } from '@/lib/datetime';
import { formatWon } from '@/lib/money';
import { MERCHANT_MT_MAX_LENGTH } from '@/server/services/merchant-mt';
import { WEBHOOK_EVENT_META } from '@/server/services/webhooks';
import { moNumberStatusLabel, paymentModeLabel } from '@/lib/labels';
import { getPublicBaseUrl } from '@/server/public-base-url';

export const dynamic = 'force-dynamic';

/**
 * 후원 설정.
 *
 * 후원 항목 관리(무엇을 파는가) · 주문 판매(어떻게 처리하는가) 와 짝이 되는 "어떤 조건으로 파는가" 다.
 * 배송 정책은 상품 설정에 있던 것을 여기로 옮겼다. 배송 업무가 두 메뉴에 갈라져 있으면
 * 기본값을 어디서 고치는지 매번 찾아야 한다.
 *
 * 읽기 전용 정보(결제 모드 · 수신번호)는 한 탭으로 합쳤다. 사회복지기관이 바꿀 수 없는 값에
 * 탭을 하나씩 주면 실제로 설정할 것이 어디 있는지 흐려진다.
 */

const ALL_TABS = [
  { key: 'amount', label: '후원 금액' },
  { key: 'shipping', label: '배송 정책' },
  { key: 'message', label: '안내 문자' },
  { key: 'page', label: '간편 후원 화면' },
  { key: 'api', label: '연동' },
  { key: 'channel', label: '수신·후원 방식' },
] as const;

type Tab = (typeof ALL_TABS)[number]['key'];

/** 감사 문자 미리보기 예시값. 실제 발송과 같은 템플릿 함수에 넣어 결과를 보여준다. */
const THANKS_PREVIEW = {
  payerName: '홍길동',
  merchantName: '기브싸인',
  amount: 3_000n,
  message: '늘 응원합니다',
  cumulative: 12_000n,
} as const;

export default async function StudioSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { merchantId } = await requireMerchant();
  const requested = (await searchParams).tab;
  // 배송 정책은 상품 기능(FEATURE_GOODS)을 켠 기관에만 보인다(점검 M-18).
  const TABS = featureGoodsEnabled() ? ALL_TABS : ALL_TABS.filter((t) => t.key !== 'shipping');
  const tab: Tab = TABS.some((t) => t.key === requested) ? (requested as Tab) : 'amount';

  const [merchant, products, moNumbers, policy, apiKeys, shippingRow, callLogs, mtTemplates, webhooks, deliveries] =
    await Promise.all([
    prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: {
        id: true, code: true, displayName: true, description: true,
        allowCustomAmount: true, minAmount: true, maxAmount: true,
        customMinAmount: true, customMaxAmount: true, customAmountStep: true,
        paymentMode: true, thanksMtMessage: true, moGuideMtMessage: true, bannerUrl: true,
      },
    }),
    prisma.chargeProduct.findMany({
      where: { merchantId, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { amount: 'asc' }],
      select: { id: true, name: true, kind: true, active: true, amount: true },
    }),
    prisma.merchantMoNumber.findMany({
      where: { merchantId },
      orderBy: { assignedAt: 'desc' },
      select: { id: true, phoneNumber: true, keyword: true, mode: true, status: true, assignedAt: true },
    }),
    resolvePolicy(merchantId, null),
    prisma.merchantApiKey.findMany({
      where: { merchantId },
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
      take: 20,
      select: { id: true, name: true, prefix: true, mode: true, allowedIps: true, lastUsedAt: true, revokedAt: true, createdAt: true },
    }),
    prisma.merchantShippingPolicy.findUnique({ where: { merchantId } }),
    prisma.merchantApiCallLog.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.merchantMtTemplate.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    prisma.merchantWebhook.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.webhookDelivery.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  if (!merchant) notFound();

  const shipping = shippingPolicyOf(shippingRow);
  const effectiveMode = merchant.paymentMode ?? 'CONFIRM_LINK';
  // 설정 가능 범위 = 관리자 지정 범위 ∩ 한도 정책 범위
  const effMin = merchant.minAmount > policy.minAmount ? merchant.minAmount : policy.minAmount;
  const effMax = merchant.maxAmount < policy.maxAmount ? merchant.maxAmount : policy.maxAmount;
  const chargePageUrl = `${await getPublicBaseUrl()}/c/${merchant.code}`;

  // 지금 설정으로 실제 발송되는 문장과, 설정을 비웠을 때의 기본 문장.
  const thanksPreview = tplChargeSuccess({
    ...THANKS_PREVIEW,
    merchantName: merchant.displayName,
    custom: merchant.thanksMtMessage,
  }).text;
  const thanksDefaultPreview = tplChargeSuccess({
    ...THANKS_PREVIEW,
    merchantName: merchant.displayName,
  }).text;

  const moGuideArgs = {
    merchantName: merchant.displayName,
    link: `${chargePageUrl.replace(/\/c\/.*$/, '')}/r/XXXXXXXX`,
    ttlMin: Math.floor(env.payment.selectTtlSec / 60),
    productNames: products.filter((p) => p.active).map((p) => p.name),
  };
  const moGuidePreview = tplSelectAmount({ ...moGuideArgs, custom: merchant.moGuideMtMessage }).text;
  const moGuideDefaultPreview = tplSelectAmount(moGuideArgs).text;

  const customBanner =
    merchant.bannerUrl && !DEFAULT_BANNERS.includes(merchant.bannerUrl as (typeof DEFAULT_BANNERS)[number])
      ? merchant.bannerUrl
      : '';

  return (
    <>
      <PageHeader title="후원 설정" description="후원 금액·안내 문자·간편 후원 화면·연동 등 후원 받는 조건을 관리합니다." />

      <nav
        aria-label="후원 설정 메뉴"
        className="mb-5 grid grid-cols-3 overflow-hidden rounded-2xl border border-ink-100 bg-white p-1 shadow-[0_8px_24px_rgba(23,22,26,0.05)] sm:grid-cols-6"
      >
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/studio/settings?tab=${t.key}`}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cx(
              'flex min-h-11 items-center justify-center rounded-xl px-1 text-center text-[12px] font-bold transition-colors sm:px-2 sm:text-[12.5px]',
              tab === t.key ? 'bg-brand-400 text-ink-900 shadow-sm' : 'text-ink-400 hover:bg-ink-50 hover:text-ink-800',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <div className="space-y-5">
        {/* ── 결제·금액 ────────────────────────────────────────── */}
        {tab === 'amount' ? (
          <section>
            <SectionTitle
              title="결제 · 금액"
              description="상품 목록에 없는 금액을 후원자가 직접 넣을 수 있게 할지 정합니다."
            />

            <Card>
              <CardTitle>직접 입력</CardTitle>
              <p className="mb-3 mt-1 text-[12.5px] leading-relaxed text-ink-500">
                허용하면 후원자가 등록된 상품 외의 금액을 넣어 결제할 수 있습니다. 실물 상품에는 적용되지 않습니다.
                범위와 단위를 비우면 아래 플랫폼 한도를 그대로 씁니다.
              </p>
              <ActionForm action={updateChargeSettingsAction} submitLabel="저장">
                <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-800">
                  <input
                    type="checkbox"
                    name="allowCustomAmount"
                    defaultChecked={merchant.allowCustomAmount}
                    className="h-4 w-4"
                  />
                  직접 입력 허용
                </label>

                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="최소 금액 (원)" hint={`${formatWon(effMin)} 이상`}>
                    <Input
                      name="customMinAmount"
                      inputMode="numeric"
                      defaultValue={merchant.customMinAmount?.toString() ?? ''}
                      placeholder={effMin.toString()}
                      className="tabular-nums"
                    />
                  </Field>
                  <Field label="최대 금액 (원)" hint={`${formatWon(effMax)} 이하`}>
                    <Input
                      name="customMaxAmount"
                      inputMode="numeric"
                      defaultValue={merchant.customMaxAmount?.toString() ?? ''}
                      placeholder={effMax.toString()}
                      className="tabular-nums"
                    />
                  </Field>
                  <Field label="입력 단위 (원)" hint="예: 1000 이면 천원 단위만 입력 가능">
                    <Input
                      name="customAmountStep"
                      inputMode="numeric"
                      defaultValue={merchant.customAmountStep != null ? String(merchant.customAmountStep) : ''}
                      placeholder="1000"
                      className="tabular-nums"
                    />
                  </Field>
                </div>
              </ActionForm>

              <div className="mt-4">
                <DataRow label="플랫폼 허용 범위" value={`${formatWon(effMin)} ~ ${formatWon(effMax)}`} />
                <DataRow
                  label="지금 적용되는 직접 입력 범위"
                  value={`${formatWon(merchant.customMinAmount ?? effMin)} ~ ${formatWon(merchant.customMaxAmount ?? effMax)}${
                    merchant.customAmountStep ? ` · ${merchant.customAmountStep.toLocaleString('ko-KR')}원 단위` : ''
                  }`}
                />
                <DataRow label="후원자 1인 1일 한도" value={formatWon(policy.payerDailyLimit)} />
                <DataRow label="내 서비스 기준 후원자 1일 한도" value={formatWon(policy.perMerchantDailyLimit)} />
              </div>
            </Card>

            <Card className="mt-4">
              <CardTitle>판매 중인 상품</CardTitle>
              <p className="mb-3 mt-1 text-[12.5px] leading-relaxed text-ink-500">
                상품 등록·수정은 후원 항목 관리에서 합니다. 여기서는 몇 개가 노출 중인지만 확인합니다.
              </p>
              {products.length === 0 ? (
                <Notice tone="warning">
                  등록된 상품이 없습니다. 상품이 없고 직접 입력도 꺼져 있으면 후원자가 결제를 진행할 수 없습니다.
                </Notice>
              ) : (
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="rounded-xl border border-ink-100 px-3.5 py-2.5">
                    <p className="text-[11.5px] font-bold text-ink-400">실물</p>
                    <p className="mt-1 text-[18px] font-black tabular-nums text-ink-900">
                      {products.filter((p) => p.kind === 'PHYSICAL' && p.active).length}
                      <span className="ml-1 text-[12px] font-semibold text-ink-400">
                        / {products.filter((p) => p.kind === 'PHYSICAL').length}개 노출
                      </span>
                    </p>
                  </div>
                  <div className="rounded-xl border border-ink-100 px-3.5 py-2.5">
                    <p className="text-[11.5px] font-bold text-ink-400">비실물(컨텐츠)</p>
                    <p className="mt-1 text-[18px] font-black tabular-nums text-ink-900">
                      {products.filter((p) => p.kind === 'DIGITAL' && p.active).length}
                      <span className="ml-1 text-[12px] font-semibold text-ink-400">
                        / {products.filter((p) => p.kind === 'DIGITAL').length}개 노출
                      </span>
                    </p>
                  </div>
                </div>
              )}
              <div className="mt-3">
                <LinkButton href="/studio/products" variant="secondary">
                  후원 항목 관리로 이동
                </LinkButton>
              </div>
            </Card>
          </section>
        ) : null}

        {/* ── 배송 정책 ────────────────────────────────────────── */}
        {tab === 'shipping' ? (
          <section>
            <SectionTitle
              title="배송 · 반품 정책"
              description="상품별로 값을 지정하지 않았을 때 적용되는 기본값입니다."
            />

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardTitle>기본값</CardTitle>
                <div className="mt-3">
                  <ActionForm action={saveShippingPolicyAction} submitLabel="배송 정책 저장">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="기본 배송비 (원)" required>
                        <Input name="baseFee" inputMode="numeric" defaultValue={shipping.baseFee.toString()} className="tabular-nums" />
                      </Field>
                      <Field label="조건부 무료 기준 (원)" hint="이 금액 이상이면 배송비 무료. 비우면 없음.">
                        <Input
                          name="freeOver"
                          inputMode="numeric"
                          defaultValue={shipping.freeOver != null ? shipping.freeOver.toString() : ''}
                          className="tabular-nums"
                        />
                      </Field>
                      <Field label="도서산간 추가 배송비 (원)" hint="제주·도서 지역 주문에 더해집니다.">
                        <Input name="remoteFee" inputMode="numeric" defaultValue={shipping.remoteFee.toString()} className="tabular-nums" />
                      </Field>
                      <Field label="출고 소요일 (영업일)" hint="결제 후 발송까지. 결제 화면에 안내됩니다." required>
                        <Input name="dispatchDays" inputMode="numeric" defaultValue={String(shipping.dispatchDays)} className="tabular-nums" />
                      </Field>
                      <Field label="반품 배송비 (원)" hint="편도. 단순 변심 반품 시 후원자 부담분.">
                        <Input name="returnFee" inputMode="numeric" defaultValue={shipping.returnFee.toString()} className="tabular-nums" />
                      </Field>
                      <Field label="교환 배송비 (원)" hint="왕복.">
                        <Input name="exchangeFee" inputMode="numeric" defaultValue={shipping.exchangeFee.toString()} className="tabular-nums" />
                      </Field>
                      <Field label="택배사" hint="배송 안내와 송장 등록 기본값에 쓰입니다.">
                        <Input name="carrier" defaultValue={shipping.carrier ?? ''} maxLength={30} placeholder="CJ대한통운" />
                      </Field>
                    </div>

                    <Field label="배송 안내 문구" hint="결제 화면과 주문 안내에 그대로 보여집니다. 300자 이내.">
                      <Textarea
                        name="guide"
                        rows={3}
                        maxLength={300}
                        defaultValue={shipping.guide ?? ''}
                        placeholder="영업일 기준 2~3일 내 발송됩니다. 주말·공휴일은 발송이 어렵습니다."
                      />
                    </Field>

                    <div className="rounded-2xl border border-ink-100 p-3">
                      <p className="mb-2 text-[13px] font-bold text-ink-900">반품 · 교환 받을 주소</p>
                      <p className="mb-2.5 text-[11.5px] leading-relaxed text-ink-400">
                        전자상거래법상 표시해야 하는 정보입니다. 비어 있으면 후원자가 어디로 보낼지 알 수 없습니다.
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="받는 분 / 담당">
                          <Input name="returnReceiver" maxLength={30} defaultValue={shipping.returnReceiver ?? ''} placeholder="반품 담당" />
                        </Field>
                        <Field label="연락처">
                          <Input name="returnPhone" maxLength={20} defaultValue={shipping.returnPhone ?? ''} placeholder="02-000-0000" />
                        </Field>
                        <Field label="우편번호">
                          <Input
                            name="returnZipCode"
                            inputMode="numeric"
                            maxLength={5}
                            defaultValue={shipping.returnZipCode ?? ''}
                            placeholder="06236"
                            className="tabular-nums"
                          />
                        </Field>
                        <Field label="주소">
                          <Input name="returnAddress" maxLength={200} defaultValue={shipping.returnAddress ?? ''} placeholder="서울특별시 강남구 ..." />
                        </Field>
                      </div>
                    </div>
                  </ActionForm>
                </div>
              </Card>

              <Card>
                <CardTitle>지금 적용되는 값</CardTitle>
                <div className="mt-3">
                  <DataRow label="기본 배송비" value={formatWon(shipping.baseFee)} />
                  <DataRow
                    label="조건부 무료"
                    value={shipping.freeOver != null ? `${formatWon(shipping.freeOver)} 이상 무료` : '없음'}
                  />
                  <DataRow label="도서산간 추가" value={shipping.remoteFee > 0n ? formatWon(shipping.remoteFee) : '없음'} />
                  <DataRow label="출고 소요" value={`영업일 ${shipping.dispatchDays}일`} />
                  <DataRow label="반품 배송비" value={shipping.returnFee > 0n ? formatWon(shipping.returnFee) : '무료'} />
                  <DataRow label="교환 배송비" value={shipping.exchangeFee > 0n ? formatWon(shipping.exchangeFee) : '무료'} />
                  <DataRow label="택배사" value={shipping.carrier ?? '미지정'} />
                  <DataRow
                    label="반품지"
                    value={
                      shipping.returnAddress ? (
                        `(${shipping.returnZipCode ?? '-'}) ${shipping.returnAddress}`
                      ) : (
                        <Badge tone="warning">미등록</Badge>
                      )
                    }
                  />
                </div>

                <div className="mt-3">
                  <Notice tone="neutral" title="상품별 설정이 우선입니다">
                    상품에 배송비·조건부 무료·출고일·반품비를 직접 넣으면 그 값이 먼저 적용됩니다. &ldquo;항상
                    무료배송&rdquo;을 켠 상품은 배송비 관련 두 값 모두 무시하고 0원입니다. 도서산간 추가 배송비는
                    무료배송이어도 붙습니다(실제 택배 요금 구조와 같습니다).
                  </Notice>
                </div>
              </Card>
            </div>
          </section>
        ) : null}

        {/* ── 안내 문자 ────────────────────────────────────────── */}
        {tab === 'message' ? (
          <section className="space-y-4">
            <SectionTitle
              title="안내 문자"
              description="후원자가 받는 두 가지 문자입니다. 하나는 결제 전, 하나는 결제 후에 나갑니다."
            />

            <Notice tone="brand" title="두 문자는 나가는 시점이 다릅니다">
              <strong>MO 안내 문자</strong>는 후원자가 문자를 보낸 <strong>직후</strong> 나가고 결제 링크가 붙습니다.
              <strong> 감사 문자</strong>는 결제가 <strong>끝난 뒤</strong> 나갑니다.
            </Notice>

            <MtMessageSection
              kind="moGuide"
              title="MO 안내 문자"
              description="후원자가 문자를 보내면 곧바로 나가는 문자입니다. 상품 선택·결제 링크가 여기에 붙습니다."
              action={updateMoGuideMessageAction}
              fieldName="moGuideMtMessage"
              maxLength={MO_GUIDE_MAX_LENGTH}
              defaultValue={merchant.moGuideMtMessage ?? ''}
              placeholder={'{사회복지기관} 상품을 고르고 결제해 주세요. 판매 중: {상품목록} (유효시간 {유효시간}분)'}
              variables={MO_GUIDE_VARIABLES}
              preview={moGuidePreview}
              defaultPreview={moGuideDefaultPreview}
              notice={
                <Notice tone="warning" title="링크는 직접 넣을 수 없습니다">
                  안내 문자에는 링크(http, www)나 전화번호·계좌번호를 넣을 수 없습니다. 결제 링크는 기브싸인이 본문
                  끝에 자동으로 붙이며, <strong>&ldquo;아직 결제되지 않았습니다&rdquo;</strong> 고지도 시스템이 함께
                  붙입니다. 이 고지는 오인 결제 민원을 막기 위한 것이라 사회복지기관이 지울 수 없습니다.
                </Notice>
              }
            />

            <MtMessageSection
              kind="thanks"
              title="감사 문자"
              description="결제가 완료됐을 때 후원자에게 발송되는 문자입니다."
              action={updateThanksMessageAction}
              fieldName="thanksMtMessage"
              maxLength={THANKS_MT_MAX_LENGTH}
              defaultValue={merchant.thanksMtMessage ?? ''}
              placeholder={'{후원자}님 감사합니다! {금액} 결제 잘 받았어요. 남겨주신 말: {메시지}'}
              variables={THANKS_MT_VARIABLES}
              preview={thanksPreview}
              defaultPreview={thanksDefaultPreview}
              notice={
                <Notice tone="warning" title="링크와 개인정보는 넣을 수 없습니다">
                  감사 문자에 링크(http, www)나 전화번호·계좌번호를 넣으면 저장되지 않습니다. 통신사 스팸 차단으로
                  문자 자체가 전달되지 않거나 후원자가 피싱으로 오인할 수 있기 때문입니다. 발신 주체 표기
                  [기브싸인] 는 항상 문장 앞에 자동으로 붙습니다.
                </Notice>
              }
            />

            <SectionTitle
              title="발송 템플릿"
              description="사회복지기관 사이트에서 연동 API 로 직접 보내는 문자입니다. 쓰지 않으셔도 됩니다."
            />

            <Notice tone="brand" title="거래 안내 문자만 보낼 수 있습니다">
              주문·배송·지급처럼 <strong>거래와 직접 관련된 안내</strong>만 보낼 수 있고, 광고·홍보 문구는 보낼 수
              없습니다. 발신번호는 기브싸인 번호로 고정되며, 수신자는 <strong>이 사회복지기관에 거래 이력이 있는 후원자</strong>
              만 지정할 수 있습니다. 그래서 사회복지기관이 따로 준비하실 것이 없습니다.
            </Notice>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Card>
                <CardTitle>템플릿 등록</CardTitle>
                <p className="mb-3 mt-1 text-[12px] leading-relaxed text-ink-400">
                  검수는 등록할 때 한 번만 합니다. 통과하면 바로 쓸 수 있고, 광고성 표현이 있으면 검수 대기로
                  저장됩니다. 같은 코드로 다시 저장하면 본문이 바뀌고 검수를 다시 받습니다.
                </p>
                <ActionForm action={saveMtTemplateAction} submitLabel="등록">
                  <Field label="템플릿 코드" hint="사회복지기관 서버에서 이 코드로 템플릿을 고릅니다. 영문·숫자·_- 2~40자.">
                    <Input name="code" maxLength={40} placeholder="ORDER_DELAY" autoComplete="off" />
                  </Field>
                  <Field label="템플릿 이름" hint="어떤 안내인지 알아볼 수 있게 적어 주세요.">
                    <Input name="name" maxLength={40} placeholder="출고 지연 안내" autoComplete="off" />
                  </Field>
                  <Field
                    label="본문"
                    hint={`${MERCHANT_MT_MAX_LENGTH}자 이내. {사회복지기관} 은 자동으로 채워지고, 그 밖의 {이름} 은 발송할 때 값을 넘겨야 합니다. 링크는 넣을 수 없습니다.`}
                  >
                    <Textarea
                      name="body"
                      rows={4}
                      maxLength={MERCHANT_MT_MAX_LENGTH}
                      placeholder={'{사회복지기관} 주문하신 {상품} 출고가 {일수}일 늦어집니다. 불편을 드려 죄송합니다.'}
                    />
                  </Field>
                </ActionForm>
              </Card>

              <Card>
                <CardTitle>등록된 템플릿</CardTitle>
                {mtTemplates.length === 0 ? (
                  <p className="mt-3 text-[13px] text-ink-400">등록된 템플릿이 없습니다.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {mtTemplates.map((t) => (
                      <li key={t.id} className="rounded-xl border border-ink-200 bg-white px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-bold text-ink-900">{t.name}</span>
                          {t.status === 'APPROVED' ? (
                            <Badge tone="success">사용 가능</Badge>
                          ) : t.status === 'PENDING' ? (
                            <Badge tone="warning">검수 대기</Badge>
                          ) : (
                            <Badge tone="danger">반려</Badge>
                          )}
                          <code className="font-mono text-[11.5px] text-ink-500">{t.code}</code>
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-700">
                          {t.body}
                        </p>
                        {t.variables ? (
                          <p className="mt-1 text-[11.5px] text-ink-400">
                            발송 시 넘겨야 할 값: {t.variables.split(',').filter(Boolean).join(', ')}
                          </p>
                        ) : null}
                        {t.reviewNote ? (
                          <p className="mt-1 text-[11.5px] leading-relaxed text-warning-500">{t.reviewNote}</p>
                        ) : null}
                        <div className="mt-2 flex items-center justify-between">
                          <span className="text-[11.5px] text-ink-400">발송 {t.sentCount}건</span>
                          <InlineActionForm
                            action={deleteMtTemplateAction}
                            fields={{ templateId: t.id }}
                            submitLabel="삭제"
                            variant="danger"
                            confirmMessage="이 템플릿으로는 더 이상 발송할 수 없습니다. 삭제할까요?"
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </section>
        ) : null}

        {/* ── 결제페이지 ───────────────────────────────────────── */}
        {tab === 'page' ? (
          <section>
            <SectionTitle
              title="간편 후원 화면 꾸미기"
              description="문자 링크로 바로 여는 간편 후원 화면(/c)의 배너와 소개입니다."
            />
            <Notice tone="neutral" title="기관 소개·캠페인을 담은 후원페이지는 따로 있습니다">
              기관 소개, 캠페인, 정기후원 안내를 담은 공개 후원페이지(/donate)는{' '}
              <Link href="/studio/donation-page" className="font-bold text-brand-700">후원페이지</Link> 메뉴에서 꾸밉니다.
              홍보용으로 공유할 주소는 후원페이지 주소를 권장합니다.
            </Notice>
            <Card className="mt-3">
              <div className="mb-5">
                <ChargePageShare url={chargePageUrl} merchantName={merchant.displayName} />
              </div>

              <div className="mb-4">
                <LinkButton href={`/c/${merchant.code}`} target="_blank" rel="noreferrer" variant="secondary" size="sm" prefetch={false}>
                  <ExternalLink size={14} strokeWidth={1.9} />
                  실제 페이지 열어 보기
                </LinkButton>
              </div>

              <ActionForm action={updateChargePageAction} submitLabel="간편 후원 화면 설정 저장">
                <div>
                  <p className="text-[13px] font-bold text-ink-900">상단 배너</p>
                  <p className="mb-2 mt-0.5 text-[12px] text-ink-400">
                    자동으로 두면 사회복지기관마다 정해진 기본 배너가 쓰입니다. 특정 배너로 고정하거나 직접 올릴 수 있습니다.
                  </p>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    {/* "자동" 을 명시적인 선택지로 둔다. 예전에는 저장하는 순간
                        지금 보이던 기본 배너가 고정 값으로 굳어 되돌릴 방법이 없었다. */}
                    <label className="flex cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-ink-200 py-4 text-[12.5px] font-bold text-ink-500 transition-colors has-[:checked]:border-brand-500 has-[:checked]:text-brand-700">
                      <input
                        type="radio"
                        name="bannerPreset"
                        value="auto"
                        defaultChecked={!merchant.bannerUrl}
                        className="sr-only"
                      />
                      자동 (기본 배너)
                    </label>

                    {DEFAULT_BANNERS.map((b, i) => (
                      <label key={b} className="group relative cursor-pointer">
                        <input
                          type="radio"
                          name="bannerPreset"
                          value={b}
                          defaultChecked={merchant.bannerUrl === b}
                          className="peer sr-only"
                        />
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={b}
                          alt={`기본 배너 ${i + 1}`}
                          className="h-16 w-full rounded-xl border-2 border-transparent object-cover transition-all peer-checked:border-brand-500 peer-checked:shadow-[0_4px_14px_rgba(237,166,0,0.35)]"
                        />
                        <span className="absolute left-1.5 top-1.5 rounded bg-ink-900/60 px-1.5 py-0.5 text-[10px] font-bold text-white">
                          기본 {i + 1}
                        </span>
                      </label>
                    ))}

                    <label className="flex cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-ink-200 text-[12.5px] font-bold text-ink-500 transition-colors has-[:checked]:border-brand-500 has-[:checked]:text-brand-700">
                      <input
                        type="radio"
                        name="bannerPreset"
                        value="custom"
                        defaultChecked={Boolean(customBanner)}
                        className="sr-only"
                      />
                      직접 입력
                    </label>
                  </div>
                  <div className="mt-3">
                    <ImageUploadField
                      name="bannerUrl"
                      label="직접 입력 배너 (파일 업로드 또는 URL)"
                      aspect="wide"
                      defaultValue={customBanner}
                      hint="위에서 '직접 입력'을 선택한 경우 적용됩니다. 권장 비율 3:1 이상."
                    />
                  </div>
                  <p className="mt-2 text-[11.5px] text-ink-400">
                    지금 적용 중: {merchant.bannerUrl ? '고정 배너' : `자동 (${defaultBannerFor(merchant.id)})`}
                  </p>
                </div>

                <Field label="사회복지기관 소개" hint="결제페이지 상단 프로필 아래에 표시됩니다. 300자 이내.">
                  <Textarea name="description" rows={3} maxLength={300} defaultValue={merchant.description ?? ''} />
                </Field>
              </ActionForm>
            </Card>
          </section>
        ) : null}

        {/* ── 연동 ────────────────────────────────────────────── */}
        {tab === 'api' ? (
          <section>
            <SectionTitle
              title="연동 API"
              description="선택 기능입니다. 연동하지 않아도 후원 처리 화면에서 지급 처리를 모두 할 수 있습니다."
            />

            <Card>
              <CardTitle>이 API 가 필요한 경우</CardTitle>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-500">
                사회복지기관 사이트에서 <strong>후원 내역을 자동으로 가져가</strong>거나, 자체 물류 시스템에서{' '}
                <strong>배송 상태를 올려보내고</strong> 싶을 때 사용합니다. 사회복지기관 서버가 결제 건을 주기적으로
                가져가(pull) 처리한 뒤 결과를 기브싸인에 알려주는 방식이라, 사회복지기관 쪽에 수신 서버를 두지 않아도
                됩니다.
              </p>
              <div className="mt-3">
                <DataRow label="조회" value={<code className="font-mono text-[12px]">GET /api/partner/v1/charges?status=pending</code>} />
                <DataRow label="지급 결과 통보" value={<code className="font-mono text-[12px]">POST /api/partner/v1/charges/ack</code>} />
                <DataRow label="배송 상태 갱신" value={<code className="font-mono text-[12px]">POST /api/partner/v1/charges/shipment</code>} />
                <DataRow label="연결 점검" value={<code className="font-mono text-[12px]">GET /api/partner/v1/ping</code>} />
                <DataRow label="후원자 식별" value="마스킹 번호(payerPhoneMasked) 또는 사회복지기관 전용 고정 식별자(payerRef)" />
              </div>
              <div className="mt-3">
                <LinkButton href="/studio/docs/partner-api" variant="secondary" size="sm" prefetch={false}>
                  <ExternalLink size={14} strokeWidth={1.9} />
                  연동 규격서 보기
                </LinkButton>
              </div>
            </Card>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Card>
                <CardTitle>새 키 발급</CardTitle>
                <p className="mb-3 mt-1 text-[12px] leading-relaxed text-ink-400">
                  키 원문과 서명 비밀키는 <strong>발급 직후 한 번만</strong> 표시됩니다. 저장하지 않으므로 다시 볼 수
                  없고, 분실하면 폐기 후 재발급해야 합니다.
                </p>
                <ActionForm action={createApiKeyAction} submitLabel="키 발급">
                  <Field
                    label="키 모드"
                    hint="테스트 키는 문자가 나가지 않고 돈도 빠지지 않습니다. 정산에도 잡히지 않습니다."
                  >
                    <Select name="mode" defaultValue="LIVE">
                      <option value="LIVE">운영 (gs_live_) — 실제 결제·정산</option>
                      <option value="TEST">테스트 (gs_test_) — 샌드박스 전용</option>
                    </Select>
                  </Field>
                  <Field label="키 이름" hint="어디에 쓰는 키인지 적어 두세요. (예: 운영 서버)">
                    <Input name="name" maxLength={40} placeholder="운영 서버" autoComplete="off" />
                  </Field>
                  <Field
                    label="허용 IP (선택)"
                    hint="쉼표로 구분. 예: 203.0.113.10, 203.0.113.0/24 — 비우면 어디서나 호출할 수 있습니다."
                  >
                    <Input name="allowedIps" maxLength={300} placeholder="203.0.113.10" autoComplete="off" />
                  </Field>
                </ActionForm>
              </Card>

              <Card>
                <CardTitle>발급된 키</CardTitle>
                {apiKeys.length === 0 ? (
                  <p className="mt-3 text-[13px] text-ink-400">발급된 연동 키가 없습니다.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {apiKeys.map((k) => (
                      <li
                        key={k.id}
                        className={cx(
                          'rounded-xl border px-3 py-2.5',
                          k.revokedAt ? 'border-ink-100 bg-ink-50/60' : 'border-ink-200 bg-white',
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-bold text-ink-900">{k.name}</span>
                          {k.mode === 'TEST' ? <Badge tone="warning">테스트</Badge> : <Badge tone="brand">운영</Badge>}
                          {k.revokedAt ? <Badge tone="neutral">폐기됨</Badge> : <Badge tone="success">사용 중</Badge>}
                          {k.allowedIps ? <Badge tone="brand">IP 제한</Badge> : null}
                        </div>
                        <p className="mt-1 font-mono text-[12px] text-ink-500">{k.prefix}…</p>
                        <p className="mt-0.5 text-[11.5px] text-ink-400">
                          마지막 사용 {k.lastUsedAt ? formatKst(k.lastUsedAt) : '없음'}
                        </p>
                        {!k.revokedAt ? (
                          <div className="mt-2 space-y-2">
                            <ActionForm action={updateApiKeyIpsAction} submitLabel="IP 저장" variant="secondary" size="sm">
                              <input type="hidden" name="keyId" value={k.id} />
                              <Field label="허용 IP" hint="쉼표 구분. 비우면 제한 없음.">
                                <Input name="allowedIps" defaultValue={k.allowedIps ?? ''} maxLength={300} />
                              </Field>
                            </ActionForm>
                            <InlineActionForm
                              action={revokeApiKeyAction}
                              fields={{ keyId: k.id }}
                              submitLabel="폐기"
                              variant="danger"
                              confirmMessage="이 키로는 즉시 인증되지 않습니다. 폐기할까요?"
                            />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <SectionTitle
              title="웹훅 (이벤트 구독)"
              description="결제가 완료되거나 문자가 오면 사회복지기관 서버로 바로 알려 드립니다. 선택 기능입니다."
            />

            <Notice tone="warning" title="받은 요청은 반드시 서명을 검증하세요">
              검증하지 않으면 누구나 가짜 결제 완료 이벤트를 보낼 수 있습니다. 서명 비밀키는{' '}
              <strong>등록 직후 한 번만</strong> 보여 드립니다. 같은 이벤트가 두 번 도착할 수 있으니(실패 시
              재전송) 받는 쪽에서 이벤트 id 로 걸러 주세요. 검증 예제는 API 문서 → 웹훅에 있습니다.
            </Notice>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Card>
                <CardTitle>수신 URL 등록</CardTitle>
                <p className="mb-3 mt-1 text-[12px] leading-relaxed text-ink-400">
                  https 주소만 등록할 수 있습니다. 이벤트를 하나도 고르지 않으면 전부 받습니다.
                </p>
                <ActionForm action={createWebhookAction} submitLabel="등록">
                  <Field label="수신 URL" hint="예: https://example.com/givesign/webhook">
                    <Input name="url" maxLength={300} placeholder="https://" autoComplete="off" />
                  </Field>
                  <Field label="메모 (선택)">
                    <Input name="description" maxLength={100} placeholder="운영 서버" autoComplete="off" />
                  </Field>
                  <div className="mt-1">
                    <p className="mb-1.5 text-[12.5px] font-bold text-ink-700">받을 이벤트</p>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {WEBHOOK_EVENT_META.map((e) => (
                        <label key={e.type} className="flex items-start gap-2 text-[12px] text-ink-700">
                          <input type="checkbox" name={`event:${e.type}`} className="mt-0.5" />
                          <span>
                            <code className="font-mono text-[11.5px]">{e.type}</code>
                            <span className="block text-[11px] text-ink-400">
                              {e.label}
                              {e.live ? '' : ' (아직 발생하지 않습니다)'}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </ActionForm>
              </Card>

              <Card>
                <CardTitle>등록된 수신 URL</CardTitle>
                {webhooks.length === 0 ? (
                  <p className="mt-3 text-[13px] text-ink-400">등록된 수신 URL 이 없습니다.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {webhooks.map((w) => (
                      <li key={w.id} className="rounded-xl border border-ink-200 bg-white px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          {w.active ? <Badge tone="success">사용 중</Badge> : <Badge tone="neutral">중지</Badge>}
                          {w.lastStatus ? (
                            <Badge tone={w.lastStatus < 300 ? 'success' : 'danger'}>{`최근 ${w.lastStatus}`}</Badge>
                          ) : null}
                          {w.description ? <span className="text-[12px] text-ink-500">{w.description}</span> : null}
                        </div>
                        <p className="mt-1 break-all font-mono text-[11.5px] text-ink-700">{w.url}</p>
                        <p className="mt-0.5 text-[11.5px] text-ink-400">
                          {w.events ? w.events.split(',').filter(Boolean).join(', ') : '모든 이벤트'}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <InlineActionForm
                            action={testWebhookAction}
                            fields={{ webhookId: w.id }}
                            submitLabel="테스트 발송"
                            variant="secondary"
                          />
                          <InlineActionForm
                            action={deleteWebhookAction}
                            fields={{ webhookId: w.id }}
                            submitLabel="해제"
                            variant="danger"
                            confirmMessage="이 주소로는 더 이상 이벤트가 가지 않습니다. 해제할까요?"
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            {deliveries.length > 0 ? (
              <Card className="mt-4">
                <CardTitle>최근 웹훅 전송</CardTitle>
                <p className="mb-3 mt-1 text-[12px] leading-relaxed text-ink-400">
                  최근 10건입니다. 실패한 건은 간격을 늘려 가며 자동으로 다시 보냅니다.
                </p>
                <ul className="space-y-1.5">
                  {deliveries.map((d) => (
                    <li
                      key={d.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-100 px-3 py-2 text-[12px]"
                    >
                      <Badge tone={d.status === 'SENT' ? 'success' : d.status === 'DEAD' ? 'danger' : 'warning'}>
                        {d.status === 'SENT' ? '성공' : d.status === 'DEAD' ? '실패(중단)' : '재시도 대기'}
                      </Badge>
                      <span className="font-mono text-[11.5px] font-bold text-ink-700">{d.eventType}</span>
                      <span className="text-ink-400">{`${d.attempts}회 시도`}</span>
                      {d.responseStatus ? <span className="text-ink-400">{`응답 ${d.responseStatus}`}</span> : null}
                      {d.error ? <span className="min-w-0 flex-1 truncate text-danger-500">{d.error}</span> : null}
                      <span className="ml-auto tabular-nums text-ink-400">{formatKst(d.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            <Card className="mt-4">
              <CardTitle>최근 호출 기록</CardTitle>
              <p className="mb-3 mt-1 text-[12px] leading-relaxed text-ink-400">
                최근 20건입니다. 연동이 안 될 때 무엇이 왜 막혔는지 여기서 확인하세요. 응답 본문은 남기지 않습니다.
              </p>
              {callLogs.length === 0 ? (
                <p className="text-[13px] text-ink-400">아직 호출 기록이 없습니다.</p>
              ) : (
                <ul className="space-y-1.5">
                  {callLogs.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-100 px-3 py-2 text-[12px]">
                      <Badge tone={l.status < 300 ? 'success' : l.status < 500 ? 'warning' : 'danger'}>{l.status}</Badge>
                      <span className="font-mono text-[11.5px] font-bold text-ink-700">{l.method}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-500">{l.path}</span>
                      {l.errorCode ? <span className="font-mono text-[11px] font-bold text-danger-500">{l.errorCode}</span> : null}
                      <span className="tabular-nums text-ink-400">{formatKst(l.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        ) : null}

        {/* ── 수신·결제 방식 (읽기 전용) ────────────────────────── */}
        {tab === 'channel' ? (
          <section className="space-y-4">
            <SectionTitle
              title="수신 · 결제 방식"
              description="이 두 가지는 사회복지기관이 바꿀 수 없습니다. 변경은 고객센터로 신청해 주세요."
            />

            <Card>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <CardTitle>MO 수신번호</CardTitle>
                <Badge tone="neutral">읽기 전용</Badge>
              </div>
              {moNumbers.length === 0 ? (
                <Notice tone="warning">
                  배정된 수신번호가 없습니다. 번호가 배정되기 전에는 문자후원을 받을 수 없습니다. 고객센터로 배정을
                  요청해 주세요.
                </Notice>
              ) : (
                <div className="space-y-3">
                  {moNumbers.map((mo) => (
                    <div key={mo.id} className="rounded-xl border border-ink-100 px-3 py-2">
                      <DataRow label="수신번호" value={<span className="font-mono">{formatMoNumber(mo.phoneNumber)}</span>} />
                      <DataRow
                        label="수신 방식"
                        value={mo.mode === 'DEDICATED' ? '전용번호 (문자 내용만 전송)' : '대표번호 + 키워드'}
                      />
                      <DataRow label="키워드" value={mo.keyword ? <span className="font-mono">{mo.keyword}</span> : '없음'} />
                      <DataRow
                        label="상태"
                        value={<Badge tone={moNumberStatusLabel[mo.status].tone}>{moNumberStatusLabel[mo.status].text}</Badge>}
                      />
                      <DataRow label="배정일" value={formatKst(mo.assignedAt, false)} />
                      <div className="pt-2">
                        <p className="mb-1 text-[11.5px] font-bold text-ink-400">후원자 안내 문구</p>
                        <p className="rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] text-ink-700">
                          {mo.keyword
                            ? `${formatMoNumber(mo.phoneNumber)} 로 "${mo.keyword}" 를 문자로 보내주세요.`
                            : `${formatMoNumber(mo.phoneNumber)} 로 문자를 보내주세요.`}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <CardTitle>결제 모드 — {paymentModeLabel[effectiveMode]}</CardTitle>
                <Badge tone="neutral">읽기 전용</Badge>
              </div>
              <div className="mb-3">
                <DataRow label="확인형 (CONFIRM_LINK)" value={paymentModeLabel.CONFIRM_LINK} />
                <DataRow label="즉시형 (DIRECT_TRIGGER)" value={paymentModeLabel.DIRECT_TRIGGER} />
                <DataRow
                  label="즉시형 허용 여부"
                  value={
                    env.safety.allowDirectTrigger ? (
                      <Badge tone="success">플랫폼 허용</Badge>
                    ) : (
                      <Badge tone="warning">전체 비활성</Badge>
                    )
                  }
                />
              </div>
              <Notice tone="warning" title="즉시형은 사회복지기관이 켤 수 없습니다">
                즉시형(DIRECT_TRIGGER)은 금융사 서면승인 등록 후 통합 관리자만 활성화할 수 있습니다. 문자 수신 즉시
                출금이 일어나는 방식이므로, 서면승인 없이 사용하면 전자금융거래 관련 규정을 위반할 수 있습니다.
              </Notice>
            </Card>

            <Card>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <CardTitle>카드 결제 수단</CardTitle>
                <Badge tone="neutral">준비 중</Badge>
              </div>
              <div className="flex items-start gap-2.5 rounded-xl border border-brand-200/60 bg-brand-50/50 px-4 py-3">
                <Info size={16} strokeWidth={1.6} className="mt-0.5 shrink-0 text-brand-700" />
                <p className="text-[13px] leading-relaxed text-ink-700">
                  카드 결제 수단 연동은 현재 준비 중입니다. 현재는 계좌 빌링키(계좌이체) 방식만 지원합니다.
                  카드 결제가 필요하시면 고객센터로 문의해 주세요.
                </p>
              </div>
            </Card>
          </section>
        ) : null}
      </div>
    </>
  );
}
