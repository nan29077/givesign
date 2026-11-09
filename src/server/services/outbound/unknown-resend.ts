import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { newId } from '@/lib/id';
import { decrypt, normalizePhone } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { decideMessageType, getMtAdapter } from '@/server/adapters/mt';

/**
 * 알림톡 결과 미확인(UNKNOWN) 건 — 기관 콘솔 목록 + "문자로 다시 보내기"(수동, 1회) (11-06 미결정 처리, 2026-11-09 D).
 *
 *  - 2시간 무응답 UNKNOWN 규칙은 그대로다(자동 재발송 없음). UNKNOWN 으로 닫을 때 본문 암호문을 `resend_body_enc` 로 옮겨 둔다(14일 보관).
 *  - 담당자가 누르면 `manual_resent_at` 조건부 선점으로 한 번만 보낸다(동시 클릭 1회). 새 발송 이력 행(문자, fallback=true)을 만들고
 *    원래 행에 `manual_resend_id` 로 잇는다. 원래 행의 UNKNOWN 상태는 바꾸지 않는다(카카오톡으로 이미 받았을 수 있다는 기록).
 */

export class UnknownResendError extends Error {}

export async function listUnknownAlimtalk(merchantId: string, since = new Date(Date.now() - 30 * 86_400_000)) {
  const rows = await prisma.mtOutboundMessage.findMany({
    where: { merchantId, status: 'UNKNOWN', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, phoneMasked: true, templateCode: true, bodyMasked: true, createdAt: true, acceptedAt: true, manualResentAt: true, resendBodyEnc: true },
  });
  return rows.map(({ resendBodyEnc, ...r }) => ({ ...r, canResend: Boolean(resendBodyEnc) && !r.manualResentAt }));
}

export async function resendUnknownAsSms(merchantId: string, id: string): Promise<{ ok: boolean; newId: string }> {
  const claim = await prisma.mtOutboundMessage.updateMany({
    where: { id, merchantId, status: 'UNKNOWN', manualResentAt: null, resendBodyEnc: { not: null } },
    data: { manualResentAt: new Date() },
  });
  if (claim.count !== 1) throw new UnknownResendError('이미 다시 보냈거나 다시 보낼 수 없는 건입니다(본문 보관 기간 14일).');
  const row = await prisma.mtOutboundMessage.findUniqueOrThrow({
    where: { id },
    select: { phoneEnc: true, phoneHash: true, phoneMasked: true, resendBodyEnc: true, templateCode: true, bodyMasked: true, chargeId: true },
  });
  let to: string;
  let text: string;
  try {
    to = normalizePhone(decrypt(row.phoneEnc));
    text = decrypt(row.resendBodyEnc!);
  } catch {
    await prisma.mtOutboundMessage.update({ where: { id }, data: { resendBodyEnc: null } });
    throw new UnknownResendError('본문을 읽지 못해 다시 보낼 수 없습니다.');
  }
  const adapter = getMtAdapter();
  const created = await prisma.mtOutboundMessage.create({
    data: {
      id: newId(),
      phoneHash: row.phoneHash,
      phoneEnc: row.phoneEnc,
      phoneMasked: row.phoneMasked,
      fromNumber: env.mt.fromNumber,
      messageType: decideMessageType(text),
      templateCode: row.templateCode,
      bodyMasked: row.bodyMasked,
      chargeId: row.chargeId,
      merchantId,
      channel: 'SMS',
      fallback: true,
      resultMessage: '알림톡 결과 미확인 — 담당자가 문자로 다시 보냄',
    },
    select: { id: true },
  });
  let ok = false;
  try {
    const res = await adapter.send({ to, text, templateCode: row.templateCode ?? 'ALIMTALK_FALLBACK' });
    ok = res.ok;
    await prisma.mtOutboundMessage.update({
      where: { id: created.id },
      data: {
        status: res.ok ? 'SENT' : 'FAILED',
        providerCode: adapter.info().provider,
        providerMessageId: res.data?.providerMessageId ?? null,
        resultCode: res.code ?? null,
        attempts: { increment: 1 },
        sentAt: res.ok ? new Date() : null,
      },
    });
  } catch (e) {
    logger.warn('결과 미확인 건 수동 문자 재발송 실패', { id, message: (e as Error).message });
    await prisma.mtOutboundMessage.update({ where: { id: created.id }, data: { status: 'FAILED', attempts: { increment: 1 }, resultMessage: (e as Error).message.slice(0, 300) } });
  }
  // 한 번만 — 결과와 무관하게 보관 본문을 지우고 새 행을 잇는다.
  await prisma.mtOutboundMessage.update({ where: { id }, data: { resendBodyEnc: null, manualResendId: created.id } });
  return { ok, newId: created.id };
}
