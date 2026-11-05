import { decrypt, normalizePhone } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { prisma } from '@/server/db';
import { getAlimtalkAdapter } from '@/server/adapters/alimtalk';
import { getMtAdapter } from '@/server/adapters/mt';

/**
 * 알림톡 전달 결과 확인 + 실패 시 문자 대체 (2026-11-06 점검 A-5, 배치 `/api/cron/alimtalk-reports`).
 *
 * 솔라피는 알림톡을 접수(2000)만 하고 카카오 전달 결과는 나중에 낸다. 공급자 대체 문자는 끈다(`disableSms:true`) —
 * 대체는 기브싸인이 한 번만 한다(CLAUDE.md 11항 "실패하면 같은 본문을 문자로 대체하고 channel/fallback 에 남긴다").
 *
 *  - 접수된 건은 `mt_outbound_message.status = ACCEPTED`(+ `accepted_at`, 대체용 원문 암호문 `body_enc`).
 *  - 이 배치가 공급자에 결과를 조회한다.
 *    · 수신 완료(4000) → SENT, 원문 암호문 삭제
 *    · **명시적 실패 코드**(3104 카카오톡 미사용·3107 차단 등) → 조건부 갱신(ACCEPTED → PENDING, channel=SMS, fallback=true)으로
 *      한 실행만 잡고 같은 본문을 문자로 1회 보낸다. 같은 행을 이어 쓰므로 두 번 대체되지 않는다.
 *    · 결과 없음·처리 중 → 그대로 두고 다음 배치에서 다시 본다.
 *  - 접수 뒤 `ALIMTALK_REPORT_TIMEOUT_MS` 가 지나도 결과가 없으면 UNKNOWN 으로 닫는다. **자동으로 문자를 보내지 않는다** —
 *    이미 카카오톡으로 받았을 수 있어 두 번 받게 하는 것보다 담당자 확인이 낫다(관리자 MT 발송 이력 "결과 미확인").
 *  - 결제 건에 묶인 안내는 `charge.mt_status` 도 같은 값으로 맞춘다(결제 결과는 바꾸지 않는다 — 절대 규칙 3).
 */

/** 접수 뒤 이 시간이 지나도 결과가 없으면 UNKNOWN. 카카오 리포트는 보통 수 분 안에 온다. */
export const ALIMTALK_REPORT_TIMEOUT_MS = 2 * 3600_000;
/** 같은 건을 다시 조회하는 최소 간격 */
export const ALIMTALK_REPORT_RECHECK_MS = 2 * 60_000;
const BATCH = 200;

export interface AlimtalkReportResult {
  checked: number;
  delivered: number;
  fallback: number;
  fallbackFailed: number;
  unknown: number;
  pending: number;
  errors: number;
}

async function syncChargeMt(chargeId: string | null, status: 'SENT' | 'FAILED' | 'UNKNOWN') {
  if (!chargeId) return;
  // 다른 문자가 이미 결과를 덮었으면 건드리지 않는다(접수 상태일 때만).
  await prisma.charge
    .updateMany({ where: { id: chargeId, mtStatus: 'ACCEPTED' }, data: { mtStatus: status } })
    .catch((e) => logger.error('결제 건 문자 상태 갱신 실패', { chargeId, message: (e as Error).message }));
}

/** 명시적 실패 → 같은 본문을 문자로 1회 대체. 선점에 실패하면(다른 실행이 처리) false. */
async function fallbackToSms(row: { id: string; phoneEnc: string; bodyEnc: string | null; chargeId: string | null; templateCode: string | null }, code: string | null, why: string | null) {
  const alimtalkNote = `알림톡 전달 실패(${code ?? '코드 없음'}${why ? ` ${why}` : ''}) → 문자 대체`;
  const claim = await prisma.mtOutboundMessage.updateMany({
    where: { id: row.id, status: 'ACCEPTED' },
    data: { status: 'PENDING', channel: 'SMS', fallback: true, reportCheckedAt: new Date(), resultCode: code, resultMessage: alimtalkNote.slice(0, 300) },
  });
  if (claim.count === 0) return null;
  let to: string;
  let text: string;
  try {
    to = normalizePhone(decrypt(row.phoneEnc));
    if (!row.bodyEnc) throw new Error('대체 발송할 본문이 없습니다');
    text = decrypt(row.bodyEnc);
  } catch (e) {
    await prisma.mtOutboundMessage.update({
      where: { id: row.id },
      data: { status: 'FAILED', bodyEnc: null, resultMessage: `${alimtalkNote} 실패: ${(e as Error).message}`.slice(0, 300) },
    });
    await syncChargeMt(row.chargeId, 'FAILED');
    return false;
  }
  const adapter = getMtAdapter();
  let ok = false;
  try {
    const res = await adapter.send({ to, text, templateCode: row.templateCode ?? 'ALIMTALK_FALLBACK' });
    ok = res.ok;
    await prisma.mtOutboundMessage.update({
      where: { id: row.id },
      data: {
        status: res.ok ? 'SENT' : 'FAILED',
        providerCode: adapter.info().provider,
        providerMessageId: res.data?.providerMessageId ?? null,
        resultCode: res.code ?? code,
        resultMessage: `${alimtalkNote}${res.ok ? '' : ` 실패: ${res.message ?? ''}`}`.slice(0, 300),
        attempts: { increment: 1 },
        sentAt: res.ok ? new Date() : null,
        bodyEnc: null,
      },
    });
  } catch (e) {
    await prisma.mtOutboundMessage.update({
      where: { id: row.id },
      data: { status: 'FAILED', bodyEnc: null, attempts: { increment: 1 }, resultMessage: `${alimtalkNote} 실패: ${(e as Error).message}`.slice(0, 300) },
    });
  }
  await syncChargeMt(row.chargeId, ok ? 'SENT' : 'FAILED');
  return ok;
}

export async function processAlimtalkReports(now = new Date()): Promise<AlimtalkReportResult> {
  const out: AlimtalkReportResult = { checked: 0, delivered: 0, fallback: 0, fallbackFailed: 0, unknown: 0, pending: 0, errors: 0 };

  // 1) 시한이 지난 건은 UNKNOWN 으로 닫는다(자동 재발송 없음).
  const deadline = new Date(now.getTime() - ALIMTALK_REPORT_TIMEOUT_MS);
  const expired = await prisma.mtOutboundMessage.findMany({
    where: { status: 'ACCEPTED', acceptedAt: { lt: deadline } },
    select: { id: true, chargeId: true },
    take: BATCH,
  });
  for (const r of expired) {
    const u = await prisma.mtOutboundMessage.updateMany({
      where: { id: r.id, status: 'ACCEPTED' },
      data: { status: 'UNKNOWN', bodyEnc: null, reportCheckedAt: now, resultMessage: '알림톡 전달 결과를 받지 못했습니다. 수신 여부를 확인해 주세요(자동 재발송하지 않음).' },
    });
    if (u.count) {
      out.unknown += 1;
      await syncChargeMt(r.chargeId, 'UNKNOWN');
    }
  }

  // 2) 결과 조회. 공급자가 조회를 지원하고 그 행을 보낸 공급자와 같을 때만.
  const adapter = getAlimtalkAdapter();
  if (!adapter.report) return out;
  const providerCode = `alimtalk:${adapter.info().provider}`;
  const recheck = new Date(now.getTime() - ALIMTALK_REPORT_RECHECK_MS);
  const rows = await prisma.mtOutboundMessage.findMany({
    where: {
      status: 'ACCEPTED',
      providerCode,
      providerMessageId: { not: null },
      OR: [{ reportCheckedAt: null }, { reportCheckedAt: { lt: recheck } }],
    },
    select: { id: true, providerMessageId: true, phoneEnc: true, bodyEnc: true, chargeId: true, templateCode: true },
    orderBy: { acceptedAt: 'asc' },
    take: BATCH,
  });
  for (const row of rows) {
    out.checked += 1;
    let rep;
    try {
      rep = await adapter.report(row.providerMessageId!);
    } catch (e) {
      rep = { ok: false as const, code: 'EXCEPTION', message: (e as Error).message };
    }
    if (!rep.ok || !rep.data) {
      out.errors += 1;
      await prisma.mtOutboundMessage.updateMany({ where: { id: row.id, status: 'ACCEPTED' }, data: { reportCheckedAt: now } });
      logger.warn('알림톡 결과 조회 실패 — 다음 배치에서 다시 봅니다', { id: row.id, code: rep.code ?? null });
      continue;
    }
    const r = rep.data;
    if (r.outcome === 'DELIVERED') {
      const u = await prisma.mtOutboundMessage.updateMany({
        where: { id: row.id, status: 'ACCEPTED' },
        data: { status: 'SENT', sentAt: r.receivedAt ?? now, reportCheckedAt: now, resultCode: r.statusCode, resultMessage: r.reason, bodyEnc: null },
      });
      if (u.count) {
        out.delivered += 1;
        await syncChargeMt(row.chargeId, 'SENT');
      }
    } else if (r.outcome === 'FAILED') {
      const ok = await fallbackToSms(row, r.statusCode, r.reason);
      if (ok === true) out.fallback += 1;
      else if (ok === false) out.fallbackFailed += 1;
    } else {
      out.pending += 1;
      await prisma.mtOutboundMessage.updateMany({ where: { id: row.id, status: 'ACCEPTED' }, data: { reportCheckedAt: now } });
    }
  }
  return out;
}
