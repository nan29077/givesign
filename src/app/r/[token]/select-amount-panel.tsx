'use client';

import * as React from 'react';
import { FileSignature, Pencil, Package, Truck } from 'lucide-react';
import { cx } from '@/components/ui';
import { formatWon } from '@/lib/money';
import { confirmChargeAmountAction, type SelectAmountState } from '@/app/actions/charge-select';

/**
 * 상품·금액 선택 화면.
 *
 * 상품을 고르거나 직접 입력한 뒤 버튼을 누르면 그 자리에서 결제사 PIN 입력 화면으로 넘어간다.
 * 문자를 한 번 더 보내지 않는다.
 *
 * 실물 상품은 수량·옵션·배송지를 함께 받는다.
 * **여기서 보여주는 금액은 서버가 같은 규칙으로 다시 계산해 확정한다.**
 * (화면 값을 그대로 믿으면 폼을 고쳐 배송비를 0원으로 만들 수 있다)
 */

const initial: SelectAmountState = { ok: false };

export interface PanelOptionValue {
  label: string;
  /** 이 값을 고르면 상품 1개 가격에 더해지는 금액(원, 문자열) */
  addPrice: string;
  soldOut: boolean;
}

export interface PanelProduct {
  id: string;
  kind: 'DIGITAL' | 'PHYSICAL' | 'DOCUMENT';
  /** 문서 상품이면 결제 뒤 작성할 서식 이름. 다른 종류는 null 이다. */
  documentName: string | null;
  digitalType: 'POINT' | 'VOUCHER' | 'PASS' | 'CONTENT' | null;
  name: string;
  amount: string;
  description: string | null;
  imageUrl: string | null;
  images: string[];
  give: string | null;
  withdrawalNotice: string | null;
  stock: number | null;
  soldOut: boolean;
  maxPerOrder: number | null;
  options: Array<{ name: string; values: PanelOptionValue[] }>;
  shippingFee: string;
  freeReason: string | null;
  freeShortfall: string | null;
  dispatchDays: number;
  returnFee: string;
  exchangeFee: string;
  payable: boolean;
}

const KIND_BADGE: Record<string, string> = {
  POINT: '포인트',
  VOUCHER: '상품권',
  PASS: '이용권',
  CONTENT: '컨텐츠',
};

export function SelectAmountPanel({
  token,
  merchantName,
  products,
  allowCustom,
  minAmount,
  maxAmount,
  customMin,
  customMax,
  customStep,
  message,
  paymentMock,
  shippingGuide,
  carrier,
  remoteFee,
  campaigns = [],
  defaultCampaignId = null,
  reconsent = [],
  closedCampaignTitle = null,
}: {
  token: string;
  merchantName: string;
  products: PanelProduct[];
  allowCustom: boolean;
  minAmount: string;
  maxAmount: string;
  /** 직접 입력 전용 범위·단위. 서버가 같은 값으로 다시 검사한다. */
  customMin: string;
  customMax: string;
  customStep: number | null;
  message: string;
  paymentMock: boolean;
  shippingGuide: string | null;
  carrier: string | null;
  remoteFee: string;
  /** 모금 중 캠페인. 비어 있으면 선택 UI 를 숨긴다. */
  campaigns?: { id: string; title: string; code: string }[];
  /** MO 키워드로 이미 지정된 캠페인 */
  defaultCampaignId?: string | null;
  /** MO 로 지정했던 캠페인이 그 사이 끝나 일반 후원으로 바뀐 경우 안내할 제목 */
  closedCampaignTitle?: string | null;
  /** 개정되어 다시 동의가 필요한 필수 약관. 모두 체크해야 후원을 진행할 수 있다. */
  reconsent?: Array<{ type: string; title: string; version: string; content: string }>;
}) {
  const [campaignId, setCampaignId] = React.useState(defaultCampaignId ?? '');
  const [anonymous, setAnonymous] = React.useState(false);
  const [agreedTypes, setAgreedTypes] = React.useState<string[]>([]);
  const [openTerms, setOpenTerms] = React.useState<string | null>(null);
  const reconsentDone = reconsent.every((t) => agreedTypes.includes(t.type));
  const min = BigInt(minAmount);
  const max = BigInt(maxAmount);
  // 직접 입력은 사회복지기관이 좁혀 둔 범위·단위를 따른다(서버도 같은 값으로 다시 검사한다).
  const cMin = BigInt(customMin);
  const cMax = BigInt(customMax);

  const [state, formAction, pending] = React.useActionState(confirmChargeAmountAction, initial);

  const firstSelectable = products.find((p) => p.payable && !p.soldOut) ?? products[0];
  const [productId, setProductId] = React.useState<string>(firstSelectable?.id ?? '');
  const [custom, setCustom] = React.useState('');
  // 직접 입력을 받지 않는 사회복지기관인데 mode 를 custom 으로 시작하면,
  // 금액 입력칸이 보이는데 서버는 항상 거절하는 화면이 된다.
  const [mode, setMode] = React.useState<'preset' | 'custom'>(
    products.length > 0 || !allowCustom ? 'preset' : 'custom',
  );
  const [qty, setQty] = React.useState(1);
  const [opts, setOpts] = React.useState<Record<string, string>>({});
  const [addr, setAddr] = React.useState({
    receiver: '',
    phone: '',
    zipCode: '',
    address1: '',
    address2: '',
    memo: '',
  });

  // 결제사 PIN 화면으로 이동. 성공 응답에 담긴 주소는 1회용이다.
  React.useEffect(() => {
    if (state.ok && state.pinUrl) window.location.href = state.pinUrl;
  }, [state.ok, state.pinUrl]);

  const selected = products.find((p) => p.id === productId) ?? null;
  const isPhysical = mode === 'preset' && selected?.kind === 'PHYSICAL';

  // 상품이 바뀌면 수량·옵션을 초기화한다. 이전 상품의 옵션이 남으면 서버 검증에서 막힌다.
  // 이펙트에서 setState 를 부르면 렌더가 두 번 도는 연쇄가 생기므로,
  // "prop 이 바뀌면 렌더 중에 상태를 조정한다" 는 React 공식 패턴을 쓴다.
  const [lastProductId, setLastProductId] = React.useState(productId);
  if (lastProductId !== productId) {
    setLastProductId(productId);
    setQty(1);
    setOpts({});
  }

  const customAmount = React.useMemo(() => {
    const digits = custom.replace(/[^\d]/g, '');
    if (!digits) return null;
    try {
      return BigInt(digits);
    } catch {
      return null;
    }
  }, [custom]);

  const maxQty = React.useMemo(() => {
    if (!selected || selected.kind !== 'PHYSICAL') return 1;
    const limits = [selected.maxPerOrder ?? 99, selected.stock ?? 99, 99];
    return Math.max(1, Math.min(...limits));
  }, [selected]);

  /** 고른 옵션값의 추가금 합계(1개당). 서버가 같은 값을 다시 계산한다. */
  const optionAdd = React.useMemo(() => {
    if (!selected) return 0n;
    let sum = 0n;
    for (const o of selected.options) {
      const picked = o.values.find((v) => v.label === (opts[o.name] ?? ''));
      if (picked) sum += BigInt(picked.addPrice);
    }
    return sum;
  }, [selected, opts]);

  /** 화면에 보여줄 금액. 서버가 같은 규칙으로 다시 계산한다. */
  const preview = React.useMemo(() => {
    if (mode === 'custom') return { goods: customAmount, fee: 0n, total: customAmount };
    if (!selected) return { goods: null, fee: 0n, total: null };
    const unit = BigInt(selected.amount) + optionAdd;
    const goods = unit * BigInt(qty);
    if (selected.kind !== 'PHYSICAL') return { goods, fee: 0n, total: goods };
    // 수량이 늘면 조건부 무료 기준을 넘을 수 있다. 1개 기준 배송비에서 다시 판단한다.
    const shortfall = selected.freeShortfall !== null ? BigInt(selected.freeShortfall) : null;
    const oneGoods = BigInt(selected.amount);
    const free = selected.freeReason !== null || (shortfall !== null && goods >= oneGoods + shortfall);
    const fee = free ? 0n : BigInt(selected.shippingFee);
    return { goods, fee, total: goods + fee };
  }, [mode, selected, qty, customAmount, optionAdd]);

  const optionsFilled =
    !isPhysical ||
    (selected?.options ?? []).every((o) => {
      const picked = o.values.find((v) => v.label === (opts[o.name] ?? ''));
      return Boolean(picked) && !picked!.soldOut;
    });
  const addressFilled =
    !isPhysical ||
    (addr.receiver.trim().length >= 2 &&
      /^01[016789]\d{7,8}$/.test(addr.phone.replace(/[^\d]/g, '')) &&
      addr.zipCode.replace(/[^\d]/g, '').length === 5 &&
      addr.address1.trim().length >= 5);

  const amountValid =
    preview.total !== null &&
    (mode === 'custom'
      ? preview.total >= cMin &&
        preview.total <= cMax &&
        (customStep === null || preview.total % BigInt(customStep) === 0n)
      : preview.total >= min && preview.total <= max);
  // 프리셋도 직접입력도 쓸 수 없는 상태(전 상품 품절·한도 초과 + 직접입력 불가)
  const nothingSelectable = !allowCustom && !products.some((p) => p.payable && !p.soldOut);
  const valid =
    amountValid &&
    optionsFilled &&
    addressFilled &&
    (mode === 'custom' || (selected !== null && selected.payable && !selected.soldOut));

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[13px] font-bold text-ink-900">상품 선택</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
          {merchantName} 에서 구매할 상품을 골라 주세요.
        </p>

        {nothingSelectable ? (
          // 한도 정책이 좁아지거나 전 상품이 품절이면 고를 수 있는 것이 하나도 없다.
          // 안내가 없으면 후원자는 빈 화면과 영구 비활성 버튼만 보고 이유를 알 수 없다.
          <div className="mt-3 rounded-2xl border border-warning-200 bg-warning-50 px-3.5 py-3">
            <p className="text-[13px] font-bold text-ink-900">지금은 결제할 수 있는 상품이 없습니다</p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-600">
              {products.length === 0
                ? '사회복지기관이 등록한 상품이 없거나, 결제 한도 범위에 맞는 상품이 없습니다.'
                : '등록된 상품이 모두 품절이거나 결제 한도를 넘습니다.'}{' '}
              결제는 진행되지 않았습니다. 사회복지기관에 문의하거나 잠시 후 다시 시도해 주세요.
            </p>
          </div>
        ) : null}

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {products.map((p) => {
            const active = mode === 'preset' && productId === p.id;
            const disabled = p.soldOut || !p.payable;
            return (
              <button
                key={p.id}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setMode('preset');
                  setProductId(p.id);
                }}
                className={cx(
                  'min-h-16 rounded-2xl px-3.5 py-2.5 text-left transition-colors',
                  disabled
                    ? 'cursor-not-allowed bg-ink-50 text-ink-300'
                    : active
                      ? 'bg-ink-900 text-brand-400'
                      : 'bg-ink-50 text-ink-800 hover:bg-ink-100',
                )}
              >
                <span className="flex items-center gap-2">
                  {p.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.imageUrl}
                      alt=""
                      className={cx('h-10 w-10 shrink-0 rounded-lg object-cover', disabled && 'opacity-40')}
                    />
                  ) : p.kind === 'PHYSICAL' ? (
                    <Package size={13} strokeWidth={1.6} className="shrink-0 opacity-70" />
                  ) : p.kind === 'DOCUMENT' ? (
                    <FileSignature size={13} strokeWidth={1.6} className="shrink-0 opacity-70" />
                  ) : null}
                  <span className="block text-[13.5px] font-bold leading-tight">{p.name}</span>
                </span>
                <span className="mt-0.5 block text-[12px] font-semibold opacity-80">
                  {formatWon(BigInt(p.amount))}
                  {p.kind === 'PHYSICAL' ? (
                    <span className="ml-1 opacity-70">
                      {p.freeReason ? '· 배송비 무료' : `· 배송비 ${formatWon(BigInt(p.shippingFee))}`}
                    </span>
                  ) : p.kind === 'DOCUMENT' ? (
                    <span className="ml-1 opacity-70">· 문서 작성</span>
                  ) : p.digitalType ? (
                    <span className="ml-1 opacity-70">· {KIND_BADGE[p.digitalType]}</span>
                  ) : null}
                </span>
                {p.soldOut ? (
                  <span className="mt-0.5 block text-[11px] font-bold text-danger-500">품절</span>
                ) : !p.payable ? (
                  <span className="mt-0.5 block text-[11px] font-bold text-danger-500">결제 한도 초과</span>
                ) : p.give ? (
                  <span className="mt-0.5 block text-[11px] opacity-70">{p.give} 지급</span>
                ) : p.stock !== null && p.stock <= 5 ? (
                  <span className="mt-0.5 block text-[11px] font-bold opacity-80">{p.stock}개 남음</span>
                ) : null}
              </button>
            );
          })}

          {allowCustom ? (
            <button
              type="button"
              onClick={() => setMode('custom')}
              className={cx(
                'flex min-h-16 items-center justify-center gap-1.5 rounded-2xl px-3.5 text-[13.5px] font-bold transition-colors',
                mode === 'custom' ? 'bg-ink-900 text-brand-400' : 'bg-ink-50 text-ink-700 hover:bg-ink-100',
              )}
            >
              <Pencil size={14} strokeWidth={1.9} />
              직접 입력
            </button>
          ) : null}
        </div>

        {mode === 'preset' && selected ? (
          <div className="mt-2 space-y-2">
            {selected.imageUrl ? (
              <div className="overflow-hidden rounded-2xl bg-ink-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={selected.imageUrl} alt={selected.name} className="h-auto w-full object-cover" />
              </div>
            ) : null}

            {selected.images.length > 0 ? (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {selected.images.map((src) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={src}
                    src={src}
                    alt=""
                    className="h-20 w-20 shrink-0 rounded-xl object-cover"
                  />
                ))}
              </div>
            ) : null}

            {selected.description ? (
              <p className="whitespace-pre-wrap rounded-xl bg-ink-50 px-3.5 py-2 text-[12px] leading-relaxed text-ink-600">
                {selected.description}
              </p>
            ) : null}

            {selected.kind === 'DOCUMENT' ? (
              // 결제만으로 끝나지 않는 상품이다. 무엇을 더 해야 하는지 결제 전에 알려야 한다.
              <p className="rounded-xl border border-brand-300/50 bg-brand-50 px-3.5 py-2 text-[12px] leading-relaxed text-ink-700">
                결제가 끝나면 {selected.documentName ?? '문서'} 작성 링크를 문자로 보내 드립니다. 링크에서 내용을
                확인하고 작성해 주세요.
              </p>
            ) : null}

            {selected.kind === 'DIGITAL' && selected.withdrawalNotice ? (
              // 디지털 콘텐츠는 사용을 시작하면 청약철회가 제한된다. 결제 전에 반드시 보여야 한다.
              <p className="rounded-xl border border-warning-500/30 bg-warning-50 px-3.5 py-2 text-[12px] leading-relaxed text-ink-700">
                {selected.withdrawalNotice}
              </p>
            ) : null}
          </div>
        ) : null}

        {mode === 'custom' ? (
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <input
                inputMode="numeric"
                value={custom}
                onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={`${cMin.toString()} ~ ${cMax.toString()}`}
                aria-label="직접 입력 결제 금액"
                className="h-12 w-44 rounded-xl border border-ink-200 px-3.5 text-right text-[15px] font-bold tabular-nums outline-none focus:border-brand-400"
              />
              <span className="text-[14px] font-bold text-ink-700">원</span>
            </div>
            {!amountValid && custom ? (
              <p className="mt-1.5 text-[12px] font-semibold text-danger-500">
                {formatWon(cMin)} ~ {formatWon(cMax)} 사이
                {customStep !== null ? `, ${customStep.toLocaleString('ko-KR')}원 단위` : ''}
                로 입력해 주세요.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ── 실물 상품: 수량 · 옵션 · 배송지 ───────────────────────── */}
      {isPhysical && selected ? (
        <div className="space-y-3 rounded-2xl border border-ink-100 p-3.5">
          <div className="flex items-center gap-1.5">
            <Truck size={15} strokeWidth={1.9} className="text-brand-700" />
            <p className="text-[13px] font-bold text-ink-900">주문 정보</p>
          </div>

          <div>
            <label className="text-[12px] font-semibold text-ink-600" htmlFor="qty">
              수량
            </label>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                className="h-10 w-10 rounded-xl bg-ink-50 text-[16px] font-bold text-ink-700 hover:bg-ink-100"
                aria-label="수량 줄이기"
              >
                −
              </button>
              <input
                id="qty"
                inputMode="numeric"
                value={qty}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value.replace(/[^\d]/g, ''), 10);
                  setQty(Number.isFinite(n) ? Math.max(1, Math.min(maxQty, n)) : 1);
                }}
                className="h-10 w-16 rounded-xl border border-ink-200 text-center text-[15px] font-bold tabular-nums outline-none focus:border-brand-400"
              />
              <button
                type="button"
                onClick={() => setQty((q) => Math.min(maxQty, q + 1))}
                className="h-10 w-10 rounded-xl bg-ink-50 text-[16px] font-bold text-ink-700 hover:bg-ink-100"
                aria-label="수량 늘리기"
              >
                +
              </button>
              <span className="text-[11.5px] text-ink-400">
                최대 {maxQty}개
                {selected.stock !== null ? ` · 재고 ${selected.stock}개` : ''}
              </span>
            </div>
          </div>

          {selected.options.map((o) => (
            <div key={o.name}>
              <label className="text-[12px] font-semibold text-ink-600" htmlFor={`opt-${o.name}`}>
                {o.name}
              </label>
              <select
                id={`opt-${o.name}`}
                value={opts[o.name] ?? ''}
                onChange={(e) => setOpts((prev) => ({ ...prev, [o.name]: e.target.value }))}
                className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3 text-[14px] outline-none focus:border-brand-400"
              >
                <option value="">선택해 주세요</option>
                {o.values.map((v) => (
                  <option key={v.label} value={v.label} disabled={v.soldOut}>
                    {v.label}
                    {BigInt(v.addPrice) > 0n ? ` (+${formatWon(BigInt(v.addPrice))})` : ''}
                    {v.soldOut ? ' - 품절' : ''}
                  </option>
                ))}
              </select>
            </div>
          ))}

          <div className="grid gap-2 sm:grid-cols-2">
            <Text label="받는 분" value={addr.receiver} onChange={(v) => setAddr((a) => ({ ...a, receiver: v }))} placeholder="홍길동" maxLength={30} autoComplete="name" />
            <Text
              label="연락처"
              value={addr.phone}
              onChange={(v) => setAddr((a) => ({ ...a, phone: v.replace(/[^\d-]/g, '') }))}
              placeholder="01012345678"
              maxLength={13}
              inputMode="numeric"
              type="tel"
              autoComplete="tel"
            />
            <Text
              label="우편번호"
              value={addr.zipCode}
              onChange={(v) => setAddr((a) => ({ ...a, zipCode: v.replace(/[^\d]/g, '') }))}
              placeholder="06236"
              maxLength={5}
              inputMode="numeric"
              autoComplete="postal-code"
            />
            <Text label="상세주소" value={addr.address2} onChange={(v) => setAddr((a) => ({ ...a, address2: v }))} placeholder="101동 1001호" maxLength={60} autoComplete="address-line2" />
          </div>
          <Text label="주소" value={addr.address1} onChange={(v) => setAddr((a) => ({ ...a, address1: v }))} placeholder="서울특별시 강남구 테헤란로 1" maxLength={120} autoComplete="street-address" />
          <Text label="배송 메모 (선택)" value={addr.memo} onChange={(v) => setAddr((a) => ({ ...a, memo: v }))} placeholder="부재 시 경비실에 맡겨 주세요" maxLength={100} />

          <div className="rounded-xl bg-ink-50 px-3.5 py-2.5">
            <Row label={`상품 ${qty}개`} value={formatWon(preview.goods ?? 0n)} />
            <Row
              label="배송비"
              value={preview.fee === 0n ? '무료' : formatWon(preview.fee)}
            />
            <div className="mt-1.5 flex items-center justify-between border-t border-ink-200 pt-1.5">
              <span className="text-[13px] font-bold text-ink-900">결제 금액</span>
              <span className="text-[15px] font-extrabold tabular-nums text-ink-900">
                {formatWon(preview.total ?? 0n)}
              </span>
            </div>
            {BigInt(remoteFee) > 0n ? (
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
                제주·도서산간은 {formatWon(BigInt(remoteFee))} 이 추가됩니다. 우편번호로 자동 판단되며, 최종 금액은
                다음 화면에서 다시 안내됩니다.
              </p>
            ) : null}
          </div>

          <div className="space-y-1 text-[11.5px] leading-relaxed text-ink-400">
            {shippingGuide || carrier ? (
              <p>
                {carrier ? `${carrier} · ` : ''}
                {shippingGuide ?? '발송 일정은 사회복지기관 안내를 따릅니다.'}
              </p>
            ) : null}
            <p>
              결제 후 영업일 기준 {selected.dispatchDays}일 이내 출고됩니다.
              {' '}반품 배송비 {BigInt(selected.returnFee) === 0n ? '무료' : formatWon(BigInt(selected.returnFee))}
              {' · '}교환 배송비 {BigInt(selected.exchangeFee) === 0n ? '무료' : formatWon(BigInt(selected.exchangeFee))}
            </p>
            <p>
              단순 변심 반품은 수령 후 7일 이내에 사회복지기관으로 신청할 수 있습니다(상품 훼손 시 제한).
            </p>
          </div>
        </div>
      ) : null}

      {message ? (
        <div className="rounded-xl bg-ink-50 px-3.5 py-2.5">
          <p className="text-[11.5px] font-semibold text-ink-400">보낸 문자</p>
          <p className="mt-0.5 break-words text-[13px] leading-relaxed text-ink-700">{message}</p>
        </div>
      ) : null}

      {paymentMock ? (
        <p className="rounded-xl bg-warning-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-700">
          [MOCK] 결제사 실연동 전입니다. 실제 출금은 일어나지 않습니다.
        </p>
      ) : null}

      {state.message && !state.ok ? (
        // 버튼은 화면 아래, 오류는 위쪽에 렌더된다. role=alert 이 없으면
        // 스크린리더 후원자에게는 아무 일도 일어나지 않은 것으로 들린다.
        <p role="alert" aria-live="assertive" className="text-[13px] font-semibold text-danger-500">
          {state.message}
        </p>
      ) : null}

      {campaigns.length > 0 ? (
        <div className="rounded-xl border border-ink-200 p-3">
          <p className="text-[13px] font-bold text-ink-900">후원할 곳</p>
          <select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            className="mt-2 h-11 w-full rounded-xl border border-ink-200 bg-white px-3 text-[14px] outline-none focus:border-brand-400"
          >
            <option value="">{merchantName} 일반 후원</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.title} (키워드 {c.code})</option>
            ))}
          </select>
          {defaultCampaignId ? <p className="mt-1 text-[11.5px] text-ink-400">문자 키워드로 지정된 캠페인입니다. 바꿀 수 있습니다.</p> : null}
        </div>
      ) : null}
      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-700">
        <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="h-4 w-4 rounded border-ink-300" />
        후원페이지 최근 후원에 익명으로 표시
      </label>

      {closedCampaignTitle ? (
        <p className="rounded-xl bg-warning-50 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-800">
          문자로 지정하신 <strong>{closedCampaignTitle}</strong> 캠페인은 모금이 끝났습니다.
          {campaigns.length > 0 ? ' 아래에서 다른 캠페인을 고르거나, 그대로 진행하면 기관 일반 후원으로 처리됩니다.' : ' 그대로 진행하면 기관 일반 후원으로 처리됩니다.'}
        </p>
      ) : null}

      {reconsent.length > 0 ? (
        <div className="rounded-2xl border border-brand-200 bg-brand-50/60 p-3.5">
          <p className="text-[13px] font-bold text-ink-900">약관이 개정되었습니다. 계속하려면 동의해 주세요.</p>
          <p className="mt-0.5 text-[11.5px] text-ink-500">후원 서비스에 맞게 내용을 고쳤습니다. 동의 내역은 마이페이지에서 확인할 수 있습니다.</p>
          <ul className="mt-2.5 space-y-2">
            {reconsent.map((t) => (
              <li key={t.type}>
                <label className="flex cursor-pointer items-start gap-2 text-[13px] text-ink-800">
                  <input
                    type="checkbox"
                    checked={agreedTypes.includes(t.type)}
                    onChange={(e) =>
                      setAgreedTypes((prev) => (e.target.checked ? [...prev, t.type] : prev.filter((x) => x !== t.type)))
                    }
                    className="mt-0.5 h-4 w-4 rounded border-ink-300"
                  />
                  <span>
                    [필수] {t.title} <span className="text-ink-400">v{t.version}</span>{' '}
                    <button
                      type="button"
                      onClick={() => setOpenTerms(openTerms === t.type ? null : t.type)}
                      className="font-bold text-brand-700 underline"
                    >
                      {openTerms === t.type ? '접기' : '내용 보기'}
                    </button>
                  </span>
                </label>
                {openTerms === t.type ? (
                  <pre className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-xl bg-white p-3 font-sans text-[11.5px] leading-relaxed text-ink-600">
                    {t.content}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form action={formAction}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="reconsentTypes" value={agreedTypes.join(',')} />
        <input type="hidden" name="campaignId" value={campaignId} />
        <input type="hidden" name="campaignTouched" value="1" />
        <input type="hidden" name="anonymous" value={anonymous ? '1' : ''} />
        <input type="hidden" name="productId" value={mode === 'preset' ? productId : ''} />
        <input
          type="hidden"
          name="customAmount"
          value={mode === 'custom' && customAmount !== null ? customAmount.toString() : ''}
        />
        {isPhysical ? (
          <>
            <input type="hidden" name="quantity" value={String(qty)} />
            <input type="hidden" name="optionValues" value={JSON.stringify(opts)} />
            <input type="hidden" name="receiver" value={addr.receiver} />
            <input type="hidden" name="phone" value={addr.phone} />
            <input type="hidden" name="zipCode" value={addr.zipCode} />
            <input type="hidden" name="address1" value={addr.address1} />
            <input type="hidden" name="address2" value={addr.address2} />
            <input type="hidden" name="memo" value={addr.memo} />
          </>
        ) : null}
        <button
          type="submit"
          disabled={!valid || !reconsentDone || pending || state.ok}
          className="inline-flex h-14 w-full items-center justify-center rounded-2xl bg-brand-400 text-[16px] font-extrabold text-ink-900 transition-colors hover:bg-brand-500 disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-300"
        >
          {state.ok
            ? 'PIN 입력 화면으로 이동합니다'
            : pending
              ? '처리 중'
              : valid && !reconsentDone
                ? '개정 약관에 동의해 주세요'
              : valid && preview.total !== null
                ? `${formatWon(preview.total)} 결제하기`
                : isPhysical && !addressFilled
                  ? '배송지를 입력해 주세요'
                  : isPhysical && !optionsFilled
                    ? '옵션을 선택해 주세요'
                    : '상품을 선택해 주세요'}
        </button>
      </form>

      <p className="text-[11.5px] leading-relaxed text-ink-400">
        아직 결제되지 않았습니다. 다음 화면에서 결제 PIN 을 입력해야 출금이 진행됩니다.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[12px] text-ink-500">{label}</span>
      <span className="text-[12.5px] font-semibold tabular-nums text-ink-800">{value}</span>
    </div>
  );
}

function Text({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  inputMode,
  autoComplete,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  inputMode?: 'numeric' | 'text';
  /** 모바일 자동완성용. 배송지를 6칸 손으로 치게 만들면 그대로 이탈 지점이 된다. */
  autoComplete?: string;
  type?: 'text' | 'tel';
}) {
  const id = React.useId();
  return (
    <div>
      <label className="text-[12px] font-semibold text-ink-600" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        inputMode={inputMode}
        autoComplete={autoComplete}
        className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3 text-[14px] outline-none focus:border-brand-400"
      />
    </div>
  );
}
