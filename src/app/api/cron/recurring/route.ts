import { runCronJob } from '@/server/cron';
import { runRecurringDonations } from '@/server/services/recurring';
import { prisma } from '@/server/db';
import { kstDateKey } from '@/lib/datetime';
import { notifySuperAdmins } from '@/server/services/notifications';
import type { Prisma } from '@/generated/prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 정기후원 실행 배치 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/recurring
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 하루 세 번(10:00·12:00·14:00 KST) 호출한다. 출금일이 도래한 ACTIVE 약정을 출금일 빠른 순으로 결제한다.
 * 한 번의 시간 상한(8분)에 다 못 하면 다음 실행이 이어 가고, 잘렸으면 최고관리자에게 하루 한 번 알린다(2026-11-13 A-M4).
 *
 * 원칙
 *  - **돈이 나가는 배치다.** 잠금을 못 잡으면 돌리지 않는다(runCronJob 기본 fail-closed, 소유자 확인 해제).
 *  - 한 달에 한 번만 결제되도록 멱등키(`recurring:{id}:{yyyy-MM}`)에 걸린 건은 건너뛴다.
 *  - 한 약정의 실패가 다른 약정 실행을 막지 않는다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'recurring', 900, async () => {
    const summary = await runRecurringDonations();
    if (summary.truncated) {
      // 시간 상한에 걸려 남은 약정이 있다 — 하루 한 번 알린다(다음 실행이 이어 가지만 대상이 계속 늘면 주기를 늘려야 한다).
      const key = `recurring-truncated:${kstDateKey(new Date())}`;
      const first = await prisma.systemSetting
        .createMany({ data: [{ key, value: { checked: summary.checked } as Prisma.InputJsonValue, memo: '정기후원 배치 시간 상한 알림 1회' }], skipDuplicates: true })
        .catch(() => ({ count: 0 }));
      if (first.count === 1) {
        await notifySuperAdmins({
          title: '정기후원 출금 배치가 시간 안에 끝나지 않았습니다',
          body: `오늘 ${summary.checked}건을 처리하고 남은 약정은 다음 실행(12:00·14:00)이 이어 갑니다. 매일 반복되면 실행 횟수를 늘려 주세요.`,
          linkUrl: '/admin/automation',
        }).catch(() => undefined);
      }
    }
    return { ...summary };
  });
}
