import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { mockMoAdapter } from '@/server/adapters/mo';
import { mockPaymentAdapter, resetMockPaymentState } from '@/server/adapters/payment';
import { readMockAlimtalkOutbox } from '@/server/adapters/alimtalk';
import { resolvePinSuccessCodes } from '@/lib/env';
import {
  executePayment,
  handleMoInbound,
  sendMtDetailed,
  startPinAuthorization,
} from '@/server/services/charge-flow';
import { acquireIdempotency } from '@/server/services/idempotency';
import { reconcileUnknownPayment } from '@/server/services/payment-reconcile';
import { closeOrphanPreparedCharges, escalateStalePaymentTransactions } from '@/server/services/payment-recovery';
import { emitMerchantEvent, drainWebhookQueue } from '@/server/services/webhooks';
import { saveAlimtalkChannel, setAlimtalkChannelStatus } from '@/server/services/alimtalk';
import { encrypt } from '@/lib/crypto';
import * as tpl from '@/server/services/mt-templates';
import {
  inboundAndSelect,
  moPayload,
  resetDb,
  seedBasics,
  seedRegisteredPayer,
  setChargeAmount,
  type Fixture,
} from './helpers';

/**
 * 2026-11-05 점검 A(결제 핵심) + C(자동화, charge-flow 몫) 조치 회귀 테스트.
 */

let fx: Fixture;
let seq = 0;
const nextMsgId = () => `PC1105-${Date.now()}-${(seq += 1)}`;
const minutesLater = (m: number) => new Date(Date.now() + m * 60_000);

/** MO → 금액 선택 → PENDING_PIN 까지 진행한 결제 건 */
async function pendingPinCharge(amount: bigint) {
  await seedRegisteredPayer(fx.payerPhone);
  setChargeAmount(amount);
  const res = await inboundAndSelect(moPayload({ to: fx.moNumber, messageId: nextMsgId(), text: '응원합니다' }), fx.merchantId);
  setChargeAmount(null);
  expect(res.status).toBe('PENDING_PIN');
  return res.chargeId!;
}

beforeEach(async () => {
  await resetDb();
  resetMockPaymentState();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { allowCustomAmount: true, maxAmount: 1_000_000n } });
});

afterEach(() => {
  vi.restoreAllMocks();
  setChargeAmount(null);
});

describe('승인 결과 기록 실패·재진입 (중간: REQUESTED 고착)', () => {
  it('승인 예외 뒤 기록(DB) 쓰기가 실패해도 예외를 던지지 않고 UNKNOWN 대사 큐로 보낸다', async () => {
    const chargeId = await pendingPinCharge(10666n); // 타임아웃 + 조회 실패
    vi.spyOn(prisma.paymentAttempt, 'create').mockRejectedValue(new Error('DB 순단'));
    const out = await executePayment(chargeId);
    expect(out.status).toBe('PENDING_PAYMENT');
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { chargeId } });
    expect(txn.status).toBe('UNKNOWN');
    expect(await prisma.riskDetection.count({ where: { chargeId, type: 'PAYMENT_UNKNOWN', resolved: false } })).toBe(1);
  });

  it('결과를 모르는 거래로 다시 들어오면 승인을 다시 부르지 않고 한도도 다시 예약하지 않는다', async () => {
    const chargeId = await pendingPinCharge(10666n);
    const first = await executePayment(chargeId);
    expect(first.status).toBe('PENDING_PAYMENT');
    const approve = vi.spyOn(mockPaymentAdapter, 'approve');

    const again = await executePayment(chargeId);
    expect(again.ok).toBe(false);
    expect(again.status).toBe('PENDING_PAYMENT');
    expect(approve).not.toHaveBeenCalled();
    expect(await prisma.paymentTransaction.count({ where: { chargeId } })).toBe(1);
  });

  it('정리 배치가 오래된 REQUESTED 거래를 UNKNOWN 으로 올리고, 관리자가 대사할 수 있다', async () => {
    const chargeId = await pendingPinCharge(10000n);
    // 승인 요청 직후 프로세스가 죽은 상태를 만든다(결제 PENDING_PAYMENT, 거래 REQUESTED).
    await prisma.charge.update({ where: { id: chargeId }, data: { status: 'PENDING_PAYMENT' } });
    const txn = await prisma.paymentTransaction.create({
      data: { id: newId(), chargeId, orderNo: `ORD-${newId()}`, provider: 'mock', amount: 10000n },
    });

    // 아직 오래되지 않았으면 건드리지 않는다.
    expect(await escalateStalePaymentTransactions(new Date())).toBe(0);
    expect(await escalateStalePaymentTransactions(minutesLater(16))).toBe(1);

    const row = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(row.status).toBe('UNKNOWN');
    expect(row.resultCode).toBe('STALE_REQUESTED');
    // 돈이 빠졌을 수 있으므로 결제 건은 실패로 닫지 않는다.
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } })).status).toBe('PENDING_PAYMENT');
    expect(await prisma.riskDetection.count({ where: { chargeId, type: 'PAYMENT_UNKNOWN' } })).toBe(1);

    const r = await reconcileUnknownPayment(txn.id, 'CANCEL', '결제사 원장에 없음');
    expect(r.ok).toBe(true);
  });

  it('승인 단계 전 상태(PENDING_PIN)에 남은 REQUESTED 거래도 대사할 수 있게 PENDING_PAYMENT 로 올린다', async () => {
    const chargeId = await pendingPinCharge(10000n);
    await prisma.paymentTransaction.create({
      data: { id: newId(), chargeId, orderNo: `ORD-${newId()}`, provider: 'mock', amount: 10000n },
    });
    expect(await escalateStalePaymentTransactions(minutesLater(16))).toBe(1);
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } })).status).toBe('PENDING_PAYMENT');
  });
});

describe('승인 응답 불확실 → 조회 (낮음)', () => {
  it('승인 응답이 UNKNOWN 코드여도 거래결과조회로 승인을 확정한다', async () => {
    const chargeId = await pendingPinCharge(10000n);
    const original = mockPaymentAdapter.approve.bind(mockPaymentAdapter);
    vi.spyOn(mockPaymentAdapter, 'approve').mockImplementationOnce(async (req) => {
      await original(req); // 결제사에서는 승인됐는데
      return { ok: false, code: 'UNKNOWN', message: '결제 결과를 확인하지 못했습니다. (HTTP 502)' }; // 응답만 깨짐
    });
    const inquire = vi.spyOn(mockPaymentAdapter, 'inquire');
    const out = await executePayment(chargeId);
    expect(inquire).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { chargeId } });
    expect(txn.status).toBe('APPROVED');
  });
});

describe('PIN 인증 시작 (중간·낮음)', () => {
  it('PIN 세션 저장이 유니크 외 오류로 실패하면 세션 없는 PENDING_PIN 으로 남기지 않고 실패로 닫는다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const mo = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, messageId: nextMsgId(), text: '응원' })));
    const chargeId = mo.chargeId!;
    await prisma.charge.update({ where: { id: chargeId }, data: { status: 'RECEIVED', amount: 10000n } });
    vi.spyOn(prisma.paymentPinSession, 'create').mockRejectedValue(new Error('DB 순단'));
    const out = await startPinAuthorization(chargeId, { notify: false });
    expect(out.ok).toBe(false);
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } })).status).toBe('PAYMENT_FAILED');
  });

  it('이미 만료된 PIN 세션이면 "발송된 링크가 있다" 고 하지 않고 그 자리에서 만료 처리한다', async () => {
    const chargeId = await pendingPinCharge(10000n);
    await prisma.paymentPinSession.update({ where: { chargeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const out = await startPinAuthorization(chargeId);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/시간이 지나/);
    expect((await prisma.paymentPinSession.findUniqueOrThrow({ where: { chargeId } })).status).toBe('EXPIRED');
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } })).status).toBe('PAYMENT_FAILED');
  });

  it('정리 배치는 거래 없이 RECEIVED·세션 없는 PENDING_PIN 에 남은 고아를 실패로 닫고, 진행 중 세션은 두고 본다', async () => {
    const live = await pendingPinCharge(10000n); // 진행 중 세션 있음
    const a = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, messageId: nextMsgId(), text: '하나' })));
    await prisma.charge.update({ where: { id: a.chargeId! }, data: { status: 'RECEIVED', amount: 10000n } });
    const b = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, messageId: nextMsgId(), text: '둘' })));
    await prisma.charge.update({ where: { id: b.chargeId! }, data: { status: 'PENDING_PIN', amount: 10000n } });

    expect(await closeOrphanPreparedCharges(new Date())).toBe(0);
    expect(await closeOrphanPreparedCharges(minutesLater(31))).toBe(2);
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: a.chargeId! } })).status).toBe('PAYMENT_FAILED');
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: b.chargeId! } })).status).toBe('PAYMENT_FAILED');
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: live } })).status).toBe('PENDING_PIN');
  });
});

describe('MO 수신·멱등키 예외 구분 (중간·낮음)', () => {
  it('MO 행 저장이 유니크 위반이 아닌 오류로 실패하면 DUPLICATE 로 삼키지 않고 던진다(EMMA 재시도)', async () => {
    vi.spyOn(prisma.moInboundMessage, 'create').mockRejectedValue(new Error('DB 순단'));
    await expect(
      handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, messageId: nextMsgId(), text: '응원' }))),
    ).rejects.toThrow(/DB 순단/);
  });

  it('멱등키 획득의 유니크 외 오류는 DUPLICATE 가 아니라 예외다', async () => {
    vi.spyOn(prisma.idempotencyKey, 'create').mockRejectedValue(new Error('DB 순단'));
    await expect(acquireIdempotency('charge', `k-${newId()}`)).rejects.toThrow(/DB 순단/);
  });

  it('멱등키 중복(P2002)은 그대로 DUPLICATE 다', async () => {
    const key = `k-${newId()}`;
    const first = await acquireIdempotency('charge', key);
    expect(first.status).toBe('ACQUIRED');
    const second = await acquireIdempotency('charge', key);
    expect(second.status).toBe('DUPLICATE');
  });

  it('문자 후원 결제 건에는 유입 경로 SMS 가 기록된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const mo = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, messageId: nextMsgId(), text: '응원' })));
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: mo.chargeId! } })).source).toBe('SMS');
  });
});

describe('알림톡 발송 이력 순서 (점검 C 낮음)', () => {
  it('알림톡 성공 뒤 이력 갱신이 실패해도 발송 결과는 성공이고 이력 행은 이미 있다', async () => {
    await saveAlimtalkChannel(fx.merchantId, {
      channelId: '@테스트복지관',
      senderKey: 'abcdefghij0123456789KEY',
      templateCodes: { RECURRING_STARTED: 'GS_REC_01' },
    });
    await setAlimtalkChannelStatus(fx.merchantId, 'ACTIVE', 'admin-user');
    vi.spyOn(prisma.mtOutboundMessage, 'update').mockRejectedValue(new Error('DB 순단'));
    const t = tpl.tplRecurringStarted({ merchantName: '기관', amount: 10000n, dayOfMonth: 5, nextDate: '2026-11-05' });
    const r = await sendMtDetailed({ phone: fx.payerPhone, template: t, merchantId: fx.merchantId });
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('ALIMTALK');
    expect(readMockAlimtalkOutbox().length).toBeGreaterThan(0);
    const row = await prisma.mtOutboundMessage.findUnique({ where: { id: r.id } });
    expect(row?.channel).toBe('ALIMTALK');
  });
});

describe('웹훅 즉시 전송과 크론 재전송 (낮음)', () => {
  it('적재 직후에는 리스 시간 동안 크론이 같은 건을 집어 가지 않는다', async () => {
    await prisma.merchantWebhook.create({
      data: { id: newId(), merchantId: fx.merchantId, url: 'https://example.invalid/hook', secretEnc: encrypt('s3cret') },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => undefined)); // 즉시 전송이 끝나지 않는 상태
    await emitMerchantEvent(fx.merchantId, 'mo.received', { transactionNo: 'TRD-TEST' });
    const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { merchantId: fx.merchantId } });
    expect(d.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    const drained = await drainWebhookQueue();
    expect(drained.tried).toBe(0);
  });
});

describe('PIN 성공 코드 (낮음: 스테이징 기본값)', () => {
  it('실결제사면 환경과 무관하게 MOCK 코드를 빼고, 미설정이면 빈 목록(fail-closed)이다', () => {
    expect(resolvePinSuccessCodes('mock', undefined)).toEqual(['0000', 'OK', 'SUCCESS', 'MOCK']);
    expect(resolvePinSuccessCodes('hecto', undefined)).toEqual([]);
    expect(resolvePinSuccessCodes('hecto', '')).toEqual([]);
    expect(resolvePinSuccessCodes('hecto', '0000,mock')).toEqual(['0000']);
  });
});
