import { requireMerchant, writeAudit } from '@/server/auth';
import { buildVolunteer1365Csv } from '@/server/services/volunteers';
import { kstDateKey } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/**
 * 자원봉사 활동 기록 CSV (1365 자원봉사포털 실적 등록 자료).
 * 휴대폰은 마스킹 번호만 담는다. 포털 등록 시 본인 확인 정보는 기관이 직접 입력한다.
 */
export async function GET(req: Request) {
  const session = await requireMerchant().catch(() => null);
  if (!session) return new Response('기관 로그인이 필요합니다.', { status: 401 });
  const url = new URL(req.url);
  const today = kstDateKey();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') ?? '') ? url.searchParams.get('from')! : `${today.slice(0, 7)}-01`;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') ?? '') ? url.searchParams.get('to')! : today;
  if (from > to) return new Response('기간을 확인해 주세요.', { status: 400 });
  const { csv, count } = await buildVolunteer1365Csv(session.merchantId, from, to);
  await writeAudit({ action: 'VOLUNTEER_ACTIVITY_EXPORT', targetType: 'merchant', targetId: session.merchantId, after: { from, to, count } }).catch(() => undefined);
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="volunteer-activity-${from}-${to}.csv"`,
      'cache-control': 'private, no-store',
    },
  });
}
