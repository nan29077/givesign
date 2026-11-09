import { prisma } from '@/server/db';
import { contractIntegrations } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getBankFeedAdapter, type BankFeedTransaction } from '@/server/adapters/bank-feed';
import { importBankFeedRows } from './deposits';

/**
 * 계좌 거래내역 자동 조회 (2026-11-13 5차 L3, `BANK_FEED_ENABLED` 꺼짐 기본, 하루 배치 `/api/cron/bank-feed`).
 *
 * 오픈뱅킹·펌뱅킹 계약 전이다. mock 은 "연동 안 됨" 을 돌려주고 아무 입금도 만들지 않는다.
 * 받은 거래는 은행 파일과 같은 표로 바꿔 2차 E 입금 대사(importBankFeedRows — 같은 정규화·같은 입금 해시)로 넣는다.
 * 확정은 지금처럼 맞추기 규칙(자동 확정 조건)·사람 확인을 따른다. 기브싸인이 받은 돈이 아니므로 charge·정산에 넣지 않는다.
 */

const FIRST_WINDOW_DAYS = 7;

const KST = 9 * 3_600_000;
function kstText(d: Date): string {
  const k = new Date(d.getTime() + KST);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())}`;
}

/** 공급자 거래 → 은행 파일과 같은 칸 순서(BANK_FEED_MAPPING) */
export function feedRowsToTable(rows: BankFeedTransaction[]): string[][] {
  return [
    ['거래일시', '입금자', '적요', '입금액', '출금액', '잔액'],
    ...rows.map((r) => [r.occurredAt, r.name, r.memo ?? '', r.deposit.toString(), r.withdrawal.toString(), r.balance != null ? r.balance.toString() : '']),
  ];
}

export function bankFeedEnabled(): boolean {
  return contractIntegrations().bankFeedEnabled;
}

export interface BankFeedSyncResult {
  skipped?: 'DISABLED';
  merchants: number;
  ok: number;
  notConnected: number;
  failed: number;
  newDeposits: number;
}

/** 하루 배치. 꺼져 있으면 아무것도 읽지 않는다. 연결 행(enabled)만 돈다. */
export async function syncBankFeeds(now = new Date()): Promise<BankFeedSyncResult> {
  const out: BankFeedSyncResult = { merchants: 0, ok: 0, notConnected: 0, failed: 0, newDeposits: 0 };
  if (!bankFeedEnabled()) return { ...out, skipped: 'DISABLED' };
  const links = await prisma.bankFeedLink.findMany({ where: { enabled: true }, take: 500 });
  const adapter = getBankFeedAdapter();
  for (const link of links) {
    out.merchants += 1;
    const from = link.fetchedTo ?? new Date(now.getTime() - FIRST_WINDOW_DAYS * 86_400_000);
    try {
      const res = await adapter.fetchTransactions({ merchantId: link.merchantId, from, to: now });
      if (!res.ok || !res.data) {
        const notConnected = res.code === 'NOT_CONNECTED';
        if (notConnected) out.notConnected += 1;
        else out.failed += 1;
        await prisma.bankFeedLink.update({ where: { merchantId: link.merchantId }, data: { lastResult: notConnected ? 'NOT_CONNECTED' : 'FAILED', lastMessage: (res.message ?? '').slice(0, 200), lastSyncedAt: now } });
        continue;
      }
      const r = await importBankFeedRows({
        merchantId: link.merchantId,
        provider: adapter.info().provider,
        feedKey: `${link.merchantId}:${from.toISOString()}:${now.toISOString()}`,
        rows: feedRowsToTable(res.data.transactions),
        now,
      });
      out.ok += 1;
      out.newDeposits += r.newCount;
      await prisma.bankFeedLink.update({ where: { merchantId: link.merchantId }, data: { lastResult: 'OK', lastMessage: `새 입금 ${r.newCount}건 · 이미 있던 입금 ${r.duplicateCount}건`, lastSyncedAt: now, fetchedTo: now } });
    } catch (e) {
      out.failed += 1;
      logger.error('계좌 거래내역 자동 조회 실패', { merchantId: link.merchantId, message: (e as Error).message });
      await prisma.bankFeedLink.update({ where: { merchantId: link.merchantId }, data: { lastResult: 'FAILED', lastMessage: (e as Error).message.slice(0, 200), lastSyncedAt: now } }).catch(() => undefined);
    }
  }
  return out;
}

/** 기관 콘솔 입금 맞추기 화면의 상태 카드용 */
export async function bankFeedStatus(merchantId: string) {
  const adapter = getBankFeedAdapter();
  const link = await prisma.bankFeedLink.findUnique({ where: { merchantId } }).catch(() => null);
  return {
    enabled: bankFeedEnabled(),
    mock: adapter.info().mode === 'mock',
    provider: adapter.info().provider,
    link,
  };
}

export { kstText as bankFeedKstText };
