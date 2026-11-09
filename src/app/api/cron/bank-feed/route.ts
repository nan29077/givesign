import { runCronJob } from '@/server/cron';
import { syncBankFeeds } from '@/server/services/bank-feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 계좌 거래내역 자동 조회 배치 (하루 1회, 2026-11-13 5차 L3).
 *   GET /api/cron/bank-feed   Authorization: Bearer ${CRON_SECRET}
 * BANK_FEED_ENABLED 가 꺼져 있으면 아무것도 읽지 않는다. 오픈뱅킹·펌뱅킹 계약 전이라 mock 은 "연동 안 됨" 만 남긴다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'bank-feed', 900, async () => ({ ...(await syncBankFeeds()) }));
}
