import { kstDateKey } from '@/lib/datetime';
import { kv } from '@/server/redis';
import { logger } from '@/lib/logger';
import { emitDomainEventSafe } from '../events';
import { volunteerShiftsStartingOn } from '../volunteers';

/**
 * 봉사 회차 전날 안내 이벤트(volunteer.shift_reminder_due) 만들기.
 *
 * /api/cron/events 가 매분 부르지만 KST 9~21시에만 일하고, (신청, 회차)마다 한 번(dedupe)이라 여러 번 불러도 같다.
 * 발송은 저니 'volunteer-reminder' 가 한다(야간 보류·수신 거부·상한 보호 공통 적용).
 */
export async function emitShiftReminders(now = new Date(), opts: { throttle?: boolean } = {}) {
  const kstHour = new Date(now.getTime() + 9 * 3_600_000).getUTCHours();
  if (kstHour < 9) return { emitted: 0, skipped: 'before-9' as const };
  // 21시 이후에 만들면 야간 보류로 다음 날 9시에 나가 이른 회차는 시작 뒤에 도착한다(점검 A-M6).
  // 21시 이후 승인된 내일 회차는 전날 안내를 보내지 않는다(배정 안내 문자는 승인 때 이미 나간다).
  if (kstHour >= 21) return { emitted: 0, skipped: 'after-21' as const };
  // 1분 배치가 9~21시 내내 같은 계산을 되풀이하던 것을 한 시간에 한 번으로(2026-11-13 점검 A-L2).
  // 이벤트 발생 키가 (신청, 회차) 유일이라 여러 번 돌아도 중복은 없다 — 잠금 저장소 장애 때는 예전처럼 계산한다.
  if (opts.throttle) {
    const hourKey = `shift-reminders:${kstDateKey(now)}:${kstHour}`;
    const first = await kv.setnx(hourKey, '1', 3_700).catch(() => true);
    if (!first) return { emitted: 0, skipped: 'this-hour' as const };
  }
  const tomorrow = kstDateKey(new Date(now.getTime() + 86_400_000));
  let emitted = 0;
  try {
    const targets = await volunteerShiftsStartingOn(tomorrow);
    for (const t of targets) {
      await emitDomainEventSafe({
        merchantId: t.merchantId,
        type: 'volunteer.shift_reminder_due',
        subjectType: 'volunteer_application',
        subjectId: t.applicationId,
        payerId: t.payerId,
        dedupeKey: `volunteer.shift_reminder_due:${t.applicationId}:${t.shiftId}`,
        payload: { shiftId: t.shiftId, schedule: t.schedule, postingTitle: t.postingTitle, startsAt: t.startsAt.toISOString() },
      });
      emitted += 1;
    }
  } catch (e) {
    logger.warn('봉사 전날 안내 대상 계산 실패', { message: (e as Error).message });
  }
  return { emitted };
}
