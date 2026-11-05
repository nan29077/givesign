import { kstDateKey } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import { emitDomainEventSafe } from '../events';
import { volunteerShiftsStartingOn } from '../volunteers';

/**
 * 봉사 회차 전날 안내 이벤트(volunteer.shift_reminder_due) 만들기.
 *
 * /api/cron/events 가 매분 부르지만 KST 9시 이후에만 일하고, (신청, 회차)마다 한 번(dedupe)이라 여러 번 불러도 같다.
 * 발송은 저니 'volunteer-reminder' 가 한다(야간 보류·수신 거부·상한 보호 공통 적용).
 */
export async function emitShiftReminders(now = new Date()) {
  const kstHour = new Date(now.getTime() + 9 * 3_600_000).getUTCHours();
  if (kstHour < 9) return { emitted: 0, skipped: 'before-9' as const };
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
