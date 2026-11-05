import { encrypt, maskPhone, normalizePhone } from '@/lib/crypto';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { kstDateKey } from '@/lib/datetime';
import { featureVolunteerEnabled } from '@/lib/env';
import { prisma } from '@/server/db';
import { ownedContentItemId } from './attribution';
import type { VolunteerApplicationStatus } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';
import { dateKeyOf, kstInstant, minutesBetween, shiftScheduleLabel, weekdayCode } from '@/lib/volunteer-schedule';
import { currentTermsDoc } from './terms';
import { issueVolunteerAgreement, type AgreementMeta } from './agreements';
import { emitDomainEvent, emitDomainEventSafe } from './events';
import { sendMtForPayer } from './charge-flow';
import { filterContent } from './content-filter';
import * as tpl from './mt-templates';

/**
 * 자원봉사 — 신청 · 승인/배정 · 활동 기록 · 1365 양식 내보내기.
 *
 * 후원자와 같은 PayerProfile 을 쓴다. 한 사람이 후원자이면서 봉사자일 수 있고,
 * 기관 콘솔 '후원자·봉사자' 화면이 둘을 한 줄로 보여 준다.
 *
 * 규칙
 *  - 신청에는 VOLUNTEER_PRIVACY 동의가 필요하다(동의 기록 + 신청서 스냅샷).
 *  - 진행 중(접수·승인) 일반 신청은 기관당 1건, 회차 신청은 회차당 1건. DB 부분 유니크 인덱스가 최종 방어다.
 *  - 회차 정원은 volunteer_shift.applied_count 조건부 증가(applied_count < capacity)로 지킨다. 철회·반려 시 되돌린다.
 *  - 마감·기간 지난 공고, 이미 시작한 회차에는 신청할 수 없다.
 *  - 비상연락처는 3분리 저장, 기관 화면에는 마스킹 번호만 보인다.
 *  - 안내 문자 실패는 신청·승인 결과를 바꾸지 않는다.
 *  - 1365 자원봉사포털은 공개 API 가 없다. 실적 등록은 기관이 직접 하고, 여기서는 등록용 자료만 만든다.
 */

export const VOLUNTEER_INTERESTS = ['돌봄·말벗', '급식·도시락', '학습 지도', '행사 지원', '환경·시설', '사무 보조', '이동 지원', '재능 나눔'] as const;
export const VOLUNTEER_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export const VOLUNTEER_SLOTS = ['MORNING', 'AFTERNOON', 'EVENING', 'WEEKEND'] as const;

export const VOLUNTEER_STATUS_LABEL: Record<VolunteerApplicationStatus, string> = {
  RECEIVED: '접수',
  APPROVED: '승인',
  REJECTED: '반려',
  WITHDRAWN: '철회',
  COMPLETED: '활동 완료',
  NO_SHOW: '불참',
};

export class VolunteerError extends Error {}

const LIVE: VolunteerApplicationStatus[] = ['RECEIVED', 'APPROVED'];

function isUniqueViolation(e: unknown) {
  return (e as { code?: string })?.code === 'P2002' || /unique constraint|volunteer_application_live_uniq/i.test((e as Error)?.message ?? '');
}

export interface ApplyVolunteerInput {
  payerId: string;
  merchantId: string;
  interests: string[];
  availableDays: string[];
  timeSlot?: string | null;
  experience?: string | null;
  emergencyName?: string | null;
  emergencyPhone?: string | null;
  wish?: string | null;
  message?: string | null;
  safetyPledge: boolean;
  agree: boolean;
  source?: string | null;
  contentItemId?: string | null;
  /** 모집 공고·회차 신청(선택). 회차가 있는 공고는 회차를 골라야 한다. */
  postingId?: string | null;
  shiftId?: string | null;
  meta?: AgreementMeta;
}

type Tx = Prisma.TransactionClient;

/** 회차 자리 하나를 잡는다. 정원이 찼거나 보관된 회차면 false. 행 단위 조건부 갱신이라 동시 신청에도 정원을 넘지 않는다. */
async function takeSeat(tx: Tx, shiftId: string): Promise<boolean> {
  const n = await tx.$executeRaw`UPDATE "volunteer_shift" SET "applied_count" = "applied_count" + 1, "updated_at" = now()
    WHERE "id" = ${shiftId} AND "archived_at" IS NULL AND "applied_count" < "capacity"`;
  return n === 1;
}

/** 철회·반려로 자리를 돌려준다. */
async function releaseSeat(tx: Tx, shiftId: string): Promise<void> {
  await tx.$executeRaw`UPDATE "volunteer_shift" SET "applied_count" = "applied_count" - 1, "updated_at" = now()
    WHERE "id" = ${shiftId} AND "applied_count" > 0`;
}

/**
 * 공고·회차 신청 가능 여부. 공고는 OPEN + 모집 기간 안(KST), 회차는 보관되지 않았고 아직 시작 전이어야 한다.
 * 회차가 있는 공고에 회차 없이 신청하면 거절한다.
 */
async function resolvePostingTarget(merchantId: string, postingId: string | null | undefined, shiftId: string | null | undefined, now = new Date()) {
  if (!postingId && !shiftId) return null;
  const shift = shiftId
    ? await prisma.volunteerShift.findFirst({ where: { id: shiftId, merchantId }, include: { posting: true } })
    : null;
  if (shiftId && !shift) throw new VolunteerError('신청할 회차를 찾을 수 없습니다.');
  const posting = shift?.posting ?? (postingId ? await prisma.volunteerPosting.findFirst({ where: { id: postingId, merchantId } }) : null);
  if (!posting || (postingId && posting.id !== postingId)) throw new VolunteerError('자원봉사 모집 공고를 찾을 수 없습니다.');
  const today = kstDateKey(now);
  if (posting.status !== 'OPEN' || posting.archivedAt) throw new VolunteerError('모집이 마감된 공고입니다.');
  if (today < dateKeyOf(posting.recruitFrom)) throw new VolunteerError('아직 모집 기간이 아닙니다.');
  if (today > dateKeyOf(posting.recruitTo)) throw new VolunteerError('모집 기간이 지난 공고입니다.');
  if (shift) {
    if (shift.archivedAt) throw new VolunteerError('신청을 받지 않는 회차입니다.');
    if (shift.startsAt.getTime() <= now.getTime()) throw new VolunteerError('이미 시작했거나 지난 회차입니다.');
    if (shift.appliedCount >= shift.capacity) throw new VolunteerError('이 회차는 정원이 찼습니다. 다른 회차를 골라 주세요.');
  } else {
    const open = await prisma.volunteerShift.count({ where: { postingId: posting.id, archivedAt: null, startsAt: { gt: now } } });
    if (open > 0) throw new VolunteerError('참여할 회차를 골라 주세요.');
  }
  return { posting, shift };
}

export async function applyVolunteer(input: ApplyVolunteerInput) {
  if (!featureVolunteerEnabled()) throw new VolunteerError('자원봉사 신청을 받지 않는 중입니다.');
  if (!input.agree) throw new VolunteerError('자원봉사 개인정보 수집·이용에 동의해 주세요.');
  if (!input.safetyPledge) throw new VolunteerError('안전 수칙 서약에 체크해 주세요.');
  const target = await resolvePostingTarget(input.merchantId, input.postingId, input.shiftId);
  let interests = input.interests.filter((i) => (VOLUNTEER_INTERESTS as readonly string[]).includes(i));
  let days = input.availableDays.filter((d) => (VOLUNTEER_DAYS as readonly string[]).includes(d));
  // 공고 신청은 분야·요일을 공고·회차에서 채운다(신청서에서 따로 고르지 않아도 된다).
  if (target && interests.length === 0 && (VOLUNTEER_INTERESTS as readonly string[]).includes(target.posting.interest)) interests = [target.posting.interest];
  if (target?.shift && days.length === 0) days = [weekdayCode(dateKeyOf(target.shift.shiftDate))];
  if (interests.length === 0) throw new VolunteerError('활동 분야를 하나 이상 골라 주세요.');
  if (days.length === 0) throw new VolunteerError('가능한 요일을 하나 이상 골라 주세요.');
  const slot = input.timeSlot && (VOLUNTEER_SLOTS as readonly string[]).includes(input.timeSlot) ? input.timeSlot : null;

  let emergencyPhone: string | null = null;
  if (input.emergencyPhone?.trim()) {
    emergencyPhone = normalizePhone(input.emergencyPhone);
    if (!/^01\d{8,9}$/.test(emergencyPhone)) throw new VolunteerError('비상연락처 휴대폰 번호를 확인해 주세요.');
  }

  const merchant = await prisma.merchantProfile.findFirst({
    where: { id: input.merchantId, status: 'APPROVED', user: { status: 'ACTIVE', deletedAt: null } },
    select: { id: true, displayName: true },
  });
  if (!merchant) throw new VolunteerError('자원봉사 신청을 받을 수 없는 기관입니다.');
  const payer = await prisma.payerProfile.findUnique({ where: { id: input.payerId } });
  if (!payer || payer.blockedAt) throw new VolunteerError('신청할 수 없는 계정입니다.');

  const shiftId = target?.shift?.id ?? null;
  const dup = await prisma.volunteerApplication.findFirst({
    where: { merchantId: merchant.id, payerId: payer.id, status: { in: LIVE }, shiftId },
    select: { id: true },
  });
  const DUP = shiftId
    ? '이미 이 회차에 신청했습니다. 마이페이지에서 진행 상황을 확인해 주세요.'
    : '이 기관에 진행 중인 자원봉사 신청이 있습니다. 마이페이지에서 진행 상황을 확인해 주세요.';
  if (dup) throw new VolunteerError(DUP);

  const terms = await currentTermsDoc('VOLUNTEER_PRIVACY');
  if (!terms) throw new VolunteerError('자원봉사 동의 약관이 준비되지 않았습니다. 관리자에게 문의해 주세요.');

  const clean = (v: string | null | undefined, max: number) =>
    v?.trim() ? filterContent(v.trim(), { bannedWords: [], maxLength: max }).clean : null;

  const contentItemId = await ownedContentItemId(merchant.id, input.contentItemId);
  let applicationId: string;
  try {
    applicationId = await prisma.$transaction(async (tx) => {
      // 자리부터 잡는다. 이후 단계가 실패하면 트랜잭션과 함께 되돌아간다.
      if (shiftId && !(await takeSeat(tx, shiftId))) throw new VolunteerError('이 회차는 정원이 찼습니다. 다른 회차를 골라 주세요.');
      const consent = await tx.consentRecord.create({
        data: {
          id: newId(),
          userId: payer.userId,
          phoneHash: payer.phoneHash,
          termsId: terms.id,
          type: 'VOLUNTEER_PRIVACY',
          agreed: true,
          ip: input.meta?.ip ?? null,
          userAgent: input.meta?.userAgent ?? null,
        },
      });
      const profileData = {
        interests,
        availableDays: days,
        timeSlot: slot,
        experience: clean(input.experience, 300),
        emergencyName: input.emergencyName?.trim().slice(0, 20) || null,
        emergencyPhoneEnc: emergencyPhone ? encrypt(emergencyPhone) : null,
        emergencyPhoneMasked: emergencyPhone ? maskPhone(emergencyPhone) : null,
        safetyPledgedAt: new Date(),
        consentId: consent.id,
      };
      await tx.volunteerProfile.upsert({
        where: { payerId: payer.id },
        create: { payerId: payer.id, ...profileData },
        update: profileData,
      });
      const app = await tx.volunteerApplication.create({
        data: {
          id: newId(),
          merchantId: merchant.id,
          payerId: payer.id,
          wish: clean(input.wish, 100),
          message: clean(input.message, 300),
          source: input.source ?? null,
          contentItemId,
          postingId: target?.posting.id ?? null,
          shiftId,
        },
      });
      await emitDomainEvent(
        {
          merchantId: merchant.id,
          type: 'volunteer.applied',
          subjectType: 'volunteer_application',
          subjectId: app.id,
          payerId: payer.id,
          payload: { interests, source: input.source ?? null, postingId: target?.posting.id ?? null, shiftId },
        },
        tx,
      );
      return app.id;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new VolunteerError(DUP);
    throw e;
  }

  // 신청서 열람 링크도 안내한다(정기후원 약정서와 같은 기준). 예전에는 notify 를 넘기지 않아 링크가 나가지 않았다.
  await issueVolunteerAgreement(applicationId, input.meta ?? {}, { notify: true }).catch((e) =>
    logger.error('자원봉사 신청서 생성 실패', { applicationId, message: (e as Error).message }),
  );
  await sendMtForPayer(payer.id, tpl.tplVolunteerReceived({ merchantName: merchant.displayName }), null, merchant.id).catch((e) =>
    logger.warn('자원봉사 접수 안내 실패', { message: (e as Error).message }),
  );
  return applicationId;
}

export async function withdrawVolunteer(payerId: string, applicationId: string) {
  await prisma.$transaction(async (tx) => {
    const app = await tx.volunteerApplication.findFirst({ where: { id: applicationId, payerId }, select: { shiftId: true } });
    const r = await tx.volunteerApplication.updateMany({
      where: { id: applicationId, payerId, status: { in: LIVE } },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
    });
    if (r.count === 0) throw new VolunteerError('철회할 수 있는 신청이 없습니다.');
    if (app?.shiftId) await releaseSeat(tx, app.shiftId);
  });
}

export async function decideVolunteer(input: {
  merchantId: string;
  applicationId: string;
  decision: 'APPROVE' | 'REJECT';
  assignment?: string;
  memo?: string;
  userId: string;
}) {
  const app = await prisma.volunteerApplication.findFirst({
    where: { id: input.applicationId, merchantId: input.merchantId },
    include: { merchant: { select: { displayName: true } }, shift: true, posting: { select: { place: true } } },
  });
  if (!app) throw new VolunteerError('신청을 찾을 수 없습니다.');
  if (app.status !== 'RECEIVED' && !(input.decision === 'APPROVE' && app.status === 'APPROVED')) {
    throw new VolunteerError('이미 처리된 신청입니다.');
  }
  // 회차 신청은 비워 두면 "M/D(요일) HH:MM~HH:MM · 장소" 로 채운다(담당자가 고쳐 쓸 수 있다).
  const assignment =
    input.assignment?.trim().slice(0, 120) || (app.shift ? shiftScheduleLabel(app.shift, app.posting?.place) : null);
  if (input.decision === 'APPROVE' && !assignment) throw new VolunteerError('승인할 때는 활동 일정·장소 안내를 적어 주세요.');
  await prisma.$transaction(async (tx) => {
    const r = await tx.volunteerApplication.updateMany({
      where: { id: app.id, status: input.decision === 'APPROVE' ? { in: LIVE } : 'RECEIVED' },
      data: {
        status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        assignment: input.decision === 'APPROVE' ? assignment : app.assignment,
        memo: input.memo?.trim().slice(0, 300) || app.memo,
        decidedAt: new Date(),
        decidedBy: input.userId,
      },
    });
    if (r.count === 0) throw new VolunteerError('이미 처리된 신청입니다.');
    if (input.decision === 'REJECT' && app.shiftId) await releaseSeat(tx, app.shiftId);
  });
  if (input.decision === 'APPROVE') {
    await sendMtForPayer(app.payerId, tpl.tplVolunteerApproved({ merchantName: app.merchant.displayName, assignment: assignment! }), null, app.merchantId).catch((e) =>
      logger.warn('자원봉사 승인 안내 실패', { message: (e as Error).message }),
    );
  }
  await emitDomainEventSafe({
    merchantId: app.merchantId,
    type: input.decision === 'APPROVE' ? 'volunteer.approved' : 'volunteer.rejected',
    subjectType: 'volunteer_application',
    subjectId: app.id,
    payerId: app.payerId,
    payload: { assignment: input.decision === 'APPROVE' ? assignment : null },
  });
}

/** 누적 봉사 시간 이정표(시간). 저니가 봉사 감사장을 보낼 때 쓴다. */
export const VOLUNTEER_HOUR_MILESTONES = [10, 30, 50, 100, 200, 500];

export async function recordVolunteerActivity(input: {
  merchantId: string;
  payerId: string;
  activityDate: string;
  minutes: number;
  title: string;
  note?: string;
  userId: string;
}) {
  // 회차 출석으로 COMPLETED 가 된 신청도 승인된 봉사자로 본다. 승인 중인 신청을 먼저 고른다.
  const approved = await prisma.volunteerApplication.findFirst({
    where: { merchantId: input.merchantId, payerId: input.payerId, status: { in: ['APPROVED', 'COMPLETED'] } },
    orderBy: [{ status: 'asc' }, { decidedAt: 'desc' }],
    select: { id: true },
  });
  if (!approved) throw new VolunteerError('승인된 자원봉사자에게만 활동을 기록할 수 있습니다.');
  return prisma.$transaction((tx) => recordActivityTx(tx, input, approved.id));
}

/** 활동 기록 + 이벤트(활동 기록·누적 이정표). 출석 확인과 같은 트랜잭션에서도 쓴다. */
async function recordActivityTx(
  tx: Tx,
  input: { merchantId: string; payerId: string; activityDate: string; minutes: number; title: string; note?: string; userId: string },
  applicationId: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.activityDate) || input.activityDate > kstDateKey()) {
    throw new VolunteerError('활동일을 확인해 주세요. 오늘 이후 날짜는 기록할 수 없습니다.');
  }
  if (!Number.isInteger(input.minutes) || input.minutes < 10 || input.minutes > 720) {
    throw new VolunteerError('활동 시간은 10분~12시간 사이로 입력해 주세요.');
  }
  const title = input.title.trim();
  if (!title) throw new VolunteerError('활동 내용을 입력해 주세요.');
  const before = await tx.volunteerActivity.aggregate({
    where: { merchantId: input.merchantId, payerId: input.payerId },
    _sum: { minutes: true },
  });
  {
    const created = await tx.volunteerActivity.create({
      data: {
        id: newId(),
        merchantId: input.merchantId,
        payerId: input.payerId,
        activityDate: new Date(`${input.activityDate}T00:00:00Z`),
        minutes: input.minutes,
        title: title.slice(0, 100),
        note: input.note?.trim().slice(0, 300) || null,
        confirmedBy: input.userId,
      },
    });
    const totalMinutes = (before._sum.minutes ?? 0) + input.minutes;
    await emitDomainEvent(
      {
        merchantId: input.merchantId,
        type: 'volunteer.activity_recorded',
        subjectType: 'volunteer_activity',
        subjectId: created.id,
        payerId: input.payerId,
        payload: { applicationId, activityDate: input.activityDate, minutes: input.minutes, title: created.title, totalMinutes },
      },
      tx,
    );
    // 누적 시간이 이정표를 넘는 순간 한 번(이정표마다 dedupe).
    const prevH = Math.floor((before._sum.minutes ?? 0) / 60);
    const nowH = Math.floor(totalMinutes / 60);
    for (const h of VOLUNTEER_HOUR_MILESTONES) {
      if (prevH < h && nowH >= h) {
        await emitDomainEvent(
          {
            merchantId: input.merchantId,
            type: 'volunteer.milestone',
            subjectType: 'volunteer_application',
            subjectId: applicationId,
            payerId: input.payerId,
            dedupeKey: `volunteer.milestone:${input.merchantId}:${input.payerId}:${h}`,
            payload: { hours: h, totalMinutes },
          },
          tx,
        );
      }
    }
    return created;
  }
}

/**
 * 회차 출석 확인(attended=true) → 활동 기록 자동 생성(시간 = 회차 길이, 내용 = 공고 제목) + 신청 COMPLETED.
 * 불참(attended=false) → NO_SHOW. 지난 회차 자리는 돌려주지 않는다.
 * 상태 전환을 조건부 갱신으로 먼저 잡아 두 번 눌러도 활동이 두 번 기록되지 않는다.
 */
export async function markShiftAttendance(input: { merchantId: string; applicationId: string; attended: boolean; userId: string; now?: Date }) {
  const app = await prisma.volunteerApplication.findFirst({
    where: { id: input.applicationId, merchantId: input.merchantId },
    include: { shift: true, posting: { select: { title: true } } },
  });
  if (!app || !app.shift) throw new VolunteerError('회차 신청을 찾을 수 없습니다.');
  if (app.status !== 'APPROVED') throw new VolunteerError('승인된 신청만 출석·불참을 처리할 수 있습니다.');
  const shiftDate = dateKeyOf(app.shift.shiftDate);
  if (shiftDate > kstDateKey(input.now ?? new Date())) throw new VolunteerError('회차 날짜가 되어야 출석·불참을 처리할 수 있습니다.');
  const shift = app.shift;
  return prisma.$transaction(async (tx) => {
    const r = await tx.volunteerApplication.updateMany({
      where: { id: app.id, status: 'APPROVED' },
      data: { status: input.attended ? 'COMPLETED' : 'NO_SHOW', attendedAt: new Date(), attendedBy: input.userId },
    });
    if (r.count === 0) throw new VolunteerError('이미 처리된 신청입니다.');
    if (!input.attended) return null;
    return recordActivityTx(
      tx,
      {
        merchantId: input.merchantId,
        payerId: app.payerId,
        activityDate: shiftDate,
        minutes: minutesBetween(shift.startTime, shift.endTime),
        title: app.posting?.title ?? '자원봉사 활동',
        note: `회차 ${shift.startTime}~${shift.endTime} 출석 확인`,
        userId: input.userId,
      },
      app.id,
    );
  });
}

export interface VolunteerShiftReminderTarget {
  merchantId: string;
  merchantName: string;
  applicationId: string;
  payerId: string;
  shiftId: string;
  postingTitle: string;
  /** 안내 문구: "11/8(토) 10:00~12:00 · 복지관 1층" */
  schedule: string;
  startsAt: Date;
}

/**
 * D-1 안내 대상 계산(발송하지 않는다 — 저니 엔진이 tplVolunteerReminder 로 보낸다).
 * 그 KST 날짜(00:00~24:00)에 시작하는 회차의 승인(APPROVED) 신청. 보관된 회차·공고는 뺀다.
 */
export async function volunteerShiftsStartingOn(dateKey: string): Promise<VolunteerShiftReminderTarget[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new VolunteerError('날짜 형식은 YYYY-MM-DD 입니다.');
  const from = kstInstant(dateKey, '00:00');
  const to = new Date(from.getTime() + 86_400_000);
  const apps = await prisma.volunteerApplication.findMany({
    where: {
      status: 'APPROVED',
      shift: { archivedAt: null, startsAt: { gte: from, lt: to }, posting: { archivedAt: null, status: { not: 'ARCHIVED' } } },
    },
    include: {
      shift: { include: { posting: { select: { title: true, place: true } } } },
      merchant: { select: { displayName: true } },
    },
    orderBy: [{ shift: { startsAt: 'asc' } }, { createdAt: 'asc' }],
  });
  return apps
    .filter((a) => a.shift)
    .map((a) => ({
      merchantId: a.merchantId,
      merchantName: a.merchant.displayName,
      applicationId: a.id,
      payerId: a.payerId,
      shiftId: a.shift!.id,
      postingTitle: a.shift!.posting.title,
      schedule: a.assignment || shiftScheduleLabel(a.shift!, a.shift!.posting.place),
      startsAt: a.shift!.startsAt,
    }));
}

/** CSV 수식 주입 방지 (= + - @ 탭 줄바꿈으로 시작하는 칸) */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r\n]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 1365 자원봉사포털 실적 등록용 자료(CSV).
 * 개인정보 보호를 위해 휴대폰은 마스킹 번호만 넣는다. 포털에 등록할 때 본인 확인 정보는 기관이 직접 입력한다.
 */
export async function buildVolunteer1365Csv(merchantId: string, from: string, to: string) {
  const rows = await prisma.volunteerActivity.findMany({
    where: {
      merchantId,
      activityDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
    },
    include: { payer: { select: { displayName: true, phoneMasked: true } } },
    orderBy: [{ activityDate: 'asc' }, { createdAt: 'asc' }],
  });
  const header = ['봉사자', '휴대폰(마스킹)', '활동일', '활동시간(시간)', '활동시간(분)', '활동내용', '비고'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.payer.displayName ?? '봉사자',
        r.payer.phoneMasked,
        r.activityDate.toISOString().slice(0, 10),
        (r.minutes / 60).toFixed(1),
        r.minutes,
        r.title,
        r.note ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return { csv: `﻿${lines.join('\r\n')}\r\n`, count: rows.length, totalMinutes: rows.reduce((a, r) => a + r.minutes, 0) };
}
