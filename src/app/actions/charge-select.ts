'use server';

import { headers } from 'next/headers';
import { confirmChargeAmount } from '@/server/services/charge-select';
import { clientIpFrom } from '@/server/rate-limit';

/**
 * 상품·금액 확정.
 *
 * 성공하면 결제사 PIN 입력 화면 주소를 돌려준다. 화면은 그 주소로 그대로 이동하므로
 * 후원자는 문자를 한 번 더 받지 않는다.
 *
 * 실물 상품은 수량·옵션·배송지를 함께 받는다.
 * 금액과 배송비는 **여기서 믿지 않고** 서버가 상품·배송정책을 다시 읽어 계산한다.
 */

export interface SelectAmountState {
  ok: boolean;
  message?: string;
  pinUrl?: string;
  mock?: boolean;
}

/** 옵션 선택값은 JSON 으로 온다. 모양이 이상하면 빈 값으로 떨어뜨린다(서버가 다시 검증한다). */
function parseOptionValues(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[String(k).slice(0, 20)] = v.slice(0, 40);
    }
    return out;
  } catch {
    return {};
  }
}

export async function confirmChargeAmountAction(
  _prev: SelectAmountState,
  formData: FormData,
): Promise<SelectAmountState> {
  const token = String(formData.get('token') ?? '');
  const productId = String(formData.get('productId') ?? '').trim();
  const customRaw = String(formData.get('customAmount') ?? '').replace(/[^\d]/g, '');

  if (!token) return { ok: false, message: '유효하지 않은 요청입니다.' };
  if (!productId && !customRaw) return { ok: false, message: '상품 또는 결제 금액을 선택해 주세요.' };
  if (!productId && !/^\d{3,9}$/.test(customRaw)) {
    return { ok: false, message: '결제 금액을 확인해 주세요.' };
  }

  const s = (key: string) => String(formData.get(key) ?? '').trim();
  const receiver = s('receiver');
  const quantityRaw = Number.parseInt(s('quantity') || '1', 10);

  // 배송지 항목이 하나라도 오면 실물 주문으로 본다.
  // 실제로 실물 상품인지, 값이 온전한지는 서버(confirmChargeAmount)가 다시 판단한다.
  const address = receiver
    ? {
        receiver,
        phone: s('phone'),
        zipCode: s('zipCode'),
        address1: s('address1'),
        address2: s('address2') || undefined,
        memo: s('memo') || undefined,
      }
    : null;

  const h = await headers();
  const result = await confirmChargeAmount({
    token,
    productId: productId || null,
    customAmount: productId ? null : BigInt(customRaw),
    quantity: Number.isFinite(quantityRaw) ? quantityRaw : 1,
    optionValues: parseOptionValues(s('optionValues')),
    address,
    // XFF 의 첫 홉은 클라이언트가 임의로 써 넣을 수 있다.
    // 이 값은 SecureLink.usedIp 로 저장되어 "누가 이 결제를 확정했는가" 의 유일한 증거가 된다.
    ip: clientIpFrom((name) => h.get(name)) ?? undefined,
    userAgent: h.get('user-agent') ?? undefined,
  });

  return {
    ok: result.ok,
    message: result.message,
    pinUrl: result.pinUrl,
    mock: result.mock,
  };
}
