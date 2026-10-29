import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { maskPhone, merchantPayerRef, normalizePhone, phoneHash } from '@/lib/crypto';
import { formatNumber } from '@/lib/money';
import type { SandboxCharge } from '@/generated/prisma/client';

/**
 * 샌드박스(테스트 키) 처리.
 *
 * 원칙 하나만 지킨다 — **테스트 호출은 실제 세계에 아무 영향이 없다.**
 * 문자가 나가지 않고, 돈이 빠지지 않고, 정산·통계·한도 집계에 잡히지 않는다.
 *
 * 그래서 Charge 에 플래그를 두지 않고 `sandbox_charge` 라는 별도 테이블을 쓴다.
 * 플래그 방식은 집계 쿼리 한 곳만 빠뜨려도 테스트 금액이 실제 정산에 섞이는데,
 * 그런 사고는 정산일이 되어서야 드러난다. 물리적으로 분리해 두면 그럴 일이 없다.
 *
 * 대신 **응답 모양은 실제 API 와 같게** 유지한다(`serializeSandboxCharge`).
 * 사회복지기관은 테스트 키로 연동을 다 만든 뒤 키만 바꿔 운영으로 넘어갈 수 있어야 한다.
 */

/** 테스트 거래번호 접두사. 실제 거래번호(MP...)와 절대 겹치지 않는다. */
const TEST_TXN_PREFIX = 'TEST';

/** 사회복지기관당 보관하는 최대 테스트 건수. 넘으면 오래된 것부터 지운다. */
const MAX_SANDBOX_CHARGES = 500;
/** 사회복지기관당 보관하는 최대 테스트 문자 수. */
const MAX_SANDBOX_MESSAGES = 500;

export const SANDBOX_CHARGE_STATUS = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAYMENT_SUCCESS: 'PAYMENT_SUCCESS',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
} as const;

/** 테스트에 쓸 수 있는 전화번호인지. 실제 후원자에게 문자가 갈 일은 없지만, 남의 번호를 넣게 두지 않는다. */
export function isUsableTestPhone(phone: string): boolean {
  return /^01[016789]\d{7,8}$/.test(normalizePhone(phone));
}

function newTestTransactionNo(): string {
  // 시각 + 난수. 실제 거래번호 채번과 섞이지 않게 별도 규칙을 쓴다.
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${TEST_TXN_PREFIX}${stamp}${rand}`;
}

/**
 * 응답 직렬화.
 *
 * 실제 `/charges` 응답과 필드 이름·타입을 맞춘다. 여기서 어긋나면 사회복지기관이
 * 테스트로 통과한 코드가 운영에서 깨진다. 필드를 바꿀 때는 실제 라우트와 함께 고칠 것.
 */
export function serializeSandboxCharge(row: SandboxCharge) {
  return {
    transactionNo: row.transactionNo,
    amount: Number(row.amount),
    points: Number(row.amount),
    currency: 'KRW',
    payerPhoneMasked: row.payerPhoneMasked,
    payerRef: row.payerRef,
    message: row.message,
    channel: 'MO',
    chargeStatus: row.status,
    pointStatus: row.pointStatus,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    test: true,
    product: row.productName
      ? {
          id: null,
          kind: row.productKind,
          digitalType: null,
          name: row.productName,
          sku: null,
          giveAmount: null,
          giveUnit: null,
          validDays: null,
        }
      : null,
    quantity: 1,
    optionText: null,
    shippingFee: Number(row.shippingFee),
    goodsAmount: Number(row.amount - row.shippingFee),
    shipping:
      row.shipmentStatus || row.carrier || row.trackingNo
        ? {
            receiver: '테스트 수령인',
            phone: row.payerPhoneMasked,
            zipCode: '00000',
            address: '테스트 배송지',
            memo: null,
            remote: false,
            status: row.shipmentStatus,
            carrier: row.carrier,
            trackingNo: row.trackingNo,
          }
        : null,
  };
}

/** 테스트 문자함에 한 줄 남긴다. 실제로는 아무것도 발송되지 않는다. */
async function writeSandboxMessage(input: {
  merchantId: string;
  direction: 'MO' | 'MT';
  phoneMasked: string;
  body: string;
  templateCode?: string | null;
  transactionNo?: string | null;
}) {
  await prisma.sandboxMessage.create({
    data: {
      id: newId(),
      merchantId: input.merchantId,
      direction: input.direction,
      phoneMasked: input.phoneMasked,
      body: input.body,
      templateCode: input.templateCode ?? null,
      transactionNo: input.transactionNo ?? null,
    },
  });
}

/** 보관 한도를 넘은 오래된 테스트 데이터를 지운다. 실패해도 호출을 막지 않는다. */
async function trimSandbox(merchantId: string) {
  const staleCharges = await prisma.sandboxCharge.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
    skip: MAX_SANDBOX_CHARGES,
    select: { id: true },
  });
  if (staleCharges.length > 0) {
    await prisma.sandboxCharge.deleteMany({ where: { id: { in: staleCharges.map((r) => r.id) } } });
  }

  const staleMessages = await prisma.sandboxMessage.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
    skip: MAX_SANDBOX_MESSAGES,
    select: { id: true },
  });
  if (staleMessages.length > 0) {
    await prisma.sandboxMessage.deleteMany({ where: { id: { in: staleMessages.map((r) => r.id) } } });
  }
}

/**
 * 모의 MO 주입.
 *
 * 후원자가 수신번호로 문자를 보낸 상황을 만든다. 통신망을 거치지 않으며,
 * 결제는 아직 일어나지 않은 상태(PENDING_PAYMENT)로 남는다.
 * 실제 흐름과 같게, 이 시점에 "아직 결제되지 않았습니다" 안내 문자가 나갔을 것으로 기록한다.
 */
export async function sandboxInjectMo(input: {
  merchantId: string;
  merchantName: string;
  phone: string;
  text: string;
  amount: bigint;
  productName?: string | null;
  productKind?: 'DIGITAL' | 'PHYSICAL' | null;
}) {
  const masked = maskPhone(input.phone);
  const transactionNo = newTestTransactionNo();

  const row = await prisma.sandboxCharge.create({
    data: {
      id: newId(),
      merchantId: input.merchantId,
      transactionNo,
      amount: input.amount,
      message: input.text.slice(0, 200),
      payerPhoneMasked: masked,
      payerRef: merchantPayerRef(input.merchantId, phoneHash(input.phone)),
      productName: input.productName ?? null,
      productKind: input.productKind ?? null,
      status: SANDBOX_CHARGE_STATUS.PENDING_PAYMENT,
    },
  });

  await writeSandboxMessage({
    merchantId: input.merchantId,
    direction: 'MO',
    phoneMasked: masked,
    body: input.text.slice(0, 200),
    transactionNo,
  });
  await writeSandboxMessage({
    merchantId: input.merchantId,
    direction: 'MT',
    phoneMasked: masked,
    templateCode: 'SELECT_AMOUNT',
    body: `[기브싸인] ${input.merchantName} 결제를 진행합니다. 아직 결제되지 않았습니다. (샌드박스 — 실제로 발송되지 않았습니다)`,
    transactionNo,
  });

  await trimSandbox(input.merchantId).catch(() => undefined);
  return row;
}

/** 모의 결제 성공. 실제 결제사를 호출하지 않으며 돈이 움직이지 않는다. */
export async function sandboxSucceed(input: { merchantId: string; merchantName: string; transactionNo: string }) {
  const row = await prisma.sandboxCharge.findFirst({
    where: { merchantId: input.merchantId, transactionNo: input.transactionNo },
  });
  if (!row) return null;
  // 이미 확정된 건은 다시 바꾸지 않는다(실제 흐름과 같다).
  if (row.status !== SANDBOX_CHARGE_STATUS.PENDING_PAYMENT) return row;

  const updated = await prisma.sandboxCharge.update({
    where: { id: row.id },
    data: { status: SANDBOX_CHARGE_STATUS.PAYMENT_SUCCESS, paidAt: new Date() },
  });

  await writeSandboxMessage({
    merchantId: input.merchantId,
    direction: 'MT',
    phoneMasked: row.payerPhoneMasked,
    templateCode: 'CHARGE_SUCCESS',
    body: `[기브싸인] ${input.merchantName} 사회복지기관에 ${formatNumber(row.amount)}원이 후원되었습니다. (샌드박스 — 실제로 발송되지 않았습니다)`,
    transactionNo: row.transactionNo,
  });

  return updated;
}

/** 모의 결제 실패. 실패 분기 처리를 시험하기 위한 것이다. */
export async function sandboxFail(input: {
  merchantId: string;
  merchantName: string;
  transactionNo: string;
  reason?: string | null;
}) {
  const row = await prisma.sandboxCharge.findFirst({
    where: { merchantId: input.merchantId, transactionNo: input.transactionNo },
  });
  if (!row) return null;
  if (row.status !== SANDBOX_CHARGE_STATUS.PENDING_PAYMENT) return row;

  const reason = (input.reason ?? '테스트 실패').slice(0, 100);
  const updated = await prisma.sandboxCharge.update({
    where: { id: row.id },
    data: { status: SANDBOX_CHARGE_STATUS.PAYMENT_FAILED, failReason: reason },
  });

  await writeSandboxMessage({
    merchantId: input.merchantId,
    direction: 'MT',
    phoneMasked: row.payerPhoneMasked,
    templateCode: 'CHARGE_FAILED',
    body: `[기브싸인] ${input.merchantName} 사회복지기관 결제가 완료되지 않았습니다. 사유: ${reason} (샌드박스 — 실제로 발송되지 않았습니다)`,
    transactionNo: row.transactionNo,
  });

  return updated;
}

/** 테스트 문자함. 나갔을 문자와 받은 것으로 친 문자를 최신순으로 돌려준다. */
export async function sandboxOutbox(merchantId: string, limit: number) {
  const rows = await prisma.sandboxMessage.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    phoneMasked: r.phoneMasked,
    templateCode: r.templateCode,
    body: r.body,
    transactionNo: r.transactionNo,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** 테스트 데이터 초기화. 운영 데이터는 건드리지 않는다. */
export async function sandboxReset(merchantId: string) {
  const [messages, charges] = await prisma.$transaction([
    prisma.sandboxMessage.deleteMany({ where: { merchantId } }),
    prisma.sandboxCharge.deleteMany({ where: { merchantId } }),
  ]);
  return { charges: charges.count, messages: messages.count };
}

/**
 * 테스트 키로 들어온 `/charges` 조회.
 *
 * 실제 라우트와 같은 파라미터를 받고 같은 모양으로 돌려준다.
 * 커서는 실제와 마찬가지로 행 id 를 쓴다.
 */
export async function sandboxListCharges(input: {
  merchantId: string;
  status: 'pending' | 'all';
  since?: Date;
  limit: number;
  cursor?: string;
}) {
  const rows = await prisma.sandboxCharge.findMany({
    where: {
      merchantId: input.merchantId,
      status: SANDBOX_CHARGE_STATUS.PAYMENT_SUCCESS,
      paidAt: input.since ? { gte: input.since } : { not: null },
      ...(input.status === 'pending' ? { pointStatus: { in: ['PENDING', 'FAILED'] } } : {}),
    },
    orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    take: input.limit,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  return {
    items: rows.map(serializeSandboxCharge),
    nextCursor: rows.length === input.limit ? (rows[rows.length - 1]?.id ?? null) : null,
  };
}

/** 커서로 넘어온 id 가 이 사회복지기관의 테스트 건인지. 실제 라우트의 소유 확인과 같은 역할이다. */
export async function sandboxOwnsCharge(merchantId: string, id: string): Promise<boolean> {
  const row = await prisma.sandboxCharge.findFirst({ where: { id, merchantId }, select: { id: true } });
  return row !== null;
}

/** 테스트 키로 들어온 `/charges/ack`. 실제 라우트와 같은 규칙(멱등·이미 SENT 는 불변)을 따른다. */
export async function sandboxAck(input: {
  merchantId: string;
  transactionNos: string[];
  status: 'SENT' | 'FAILED';
  note: string | null;
  keyId: string;
}) {
  const before = await prisma.sandboxCharge.findMany({
    where: { transactionNo: { in: input.transactionNos }, merchantId: input.merchantId },
    select: { transactionNo: true, status: true, pointStatus: true },
  });
  const known = new Set(before.map((b) => b.transactionNo));
  const targets = before
    .filter(
      (b) =>
        b.status === SANDBOX_CHARGE_STATUS.PAYMENT_SUCCESS &&
        (b.pointStatus === 'PENDING' || b.pointStatus === 'FAILED'),
    )
    .map((b) => b.transactionNo);

  const result = await prisma.sandboxCharge.updateMany({
    where: {
      transactionNo: { in: targets },
      merchantId: input.merchantId,
      status: SANDBOX_CHARGE_STATUS.PAYMENT_SUCCESS,
      pointStatus: { in: ['PENDING', 'FAILED'] },
    },
    data: { pointStatus: input.status, pointNote: input.note },
  });

  return {
    updated: result.count,
    unknown: input.transactionNos.filter((no) => !known.has(no)),
    unchanged: input.transactionNos.filter((no) => known.has(no) && !targets.includes(no)),
  };
}

/** 테스트 키로 들어온 `/charges/shipment`. */
export async function sandboxShipment(input: {
  merchantId: string;
  transactionNo: string;
  status: string;
  carrier: string | null;
  trackingNo: string | null;
}) {
  const row = await prisma.sandboxCharge.findFirst({
    where: { merchantId: input.merchantId, transactionNo: input.transactionNo },
    select: { id: true, payerPhoneMasked: true, transactionNo: true, productName: true },
  });
  if (!row) return null;

  const updated = await prisma.sandboxCharge.update({
    where: { id: row.id },
    data: { shipmentStatus: input.status, carrier: input.carrier, trackingNo: input.trackingNo },
  });

  if (input.status === 'SHIPPED') {
    await writeSandboxMessage({
      merchantId: input.merchantId,
      direction: 'MT',
      phoneMasked: row.payerPhoneMasked,
      templateCode: 'SHIPMENT_SENT',
      body: `[기브싸인] 주문하신 ${row.productName ?? '상품'} 이(가) 발송되었습니다. ${input.carrier ?? ''} ${input.trackingNo ?? ''} (샌드박스 — 실제로 발송되지 않았습니다)`.trim(),
      transactionNo: row.transactionNo,
    });
  }

  return updated;
}

/**
 * 테스트 키로 들어온 사회복지기관 문자 발송.
 *
 * 템플릿 검수 규칙은 운영과 같은 것을 쓰고(같은 테이블을 본다), 실제 발송만 하지 않는다.
 * 나갔을 문자는 테스트 문자함에 남는다.
 */
export async function sandboxSendMerchantMt(input: {
  merchantId: string;
  phoneMasked: string;
  templateCode: string;
  body: string;
  transactionNo?: string | null;
}) {
  const row = await prisma.sandboxMessage.create({
    data: {
      id: newId(),
      merchantId: input.merchantId,
      direction: 'MT',
      phoneMasked: input.phoneMasked,
      templateCode: `MERCHANT:${input.templateCode}`,
      body: `${input.body} (샌드박스 — 실제로 발송되지 않았습니다)`,
      transactionNo: input.transactionNo ?? null,
    },
  });
  return row;
}

/**
 * 테스트 키 발송의 수신자 해석.
 * 샌드박스 결제 건에 남아 있는 payerRef / 거래번호로 찾는다.
 */
export async function sandboxResolveRecipient(
  merchantId: string,
  query: { payerRef?: string | null; transactionNo?: string | null },
) {
  const row = await prisma.sandboxCharge.findFirst({
    where: {
      merchantId,
      ...(query.transactionNo ? { transactionNo: query.transactionNo.trim() } : {}),
      ...(query.payerRef ? { payerRef: query.payerRef.trim() } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { payerPhoneMasked: true, transactionNo: true },
  });
  return row;
}
