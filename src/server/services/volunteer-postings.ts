import { newId } from '@/lib/id';
import { kstDateKey } from '@/lib/datetime';
import { prisma } from '@/server/db';
import { dateKeyOf, isDateKey, isHm, kstInstant, minutesBetween } from '@/lib/volunteer-schedule';
import type { VolunteerPostingStatus } from '@/generated/prisma/enums';
import { filterContent } from './content-filter';
import { VOLUNTEER_INTERESTS, VolunteerError } from './volunteers';

/**
 * 자원봉사 모집 공고 · 회차 (2026-11-06 고도화 6단계).
 *
 * 규칙
 *  - 공고 상태: DRAFT(작성 중) → OPEN(모집 중) → CLOSED(마감) / ARCHIVED(보관, 되돌릴 수 있음). 지우지 않는다.
 *  - 공개 후원페이지에는 OPEN 이면서 모집 기간(KST, 양끝 포함) 안인 공고만 보인다.
 *  - 회차 시각은 KST 날짜 + "HH:MM" 으로 받고, 시작·끝 UTC 시각을 함께 저장한다. 하루를 넘기는 회차는 받지 않는다.
 *  - 정원은 신청 쪽(volunteers.ts takeSeat)이 조건부 증가로 지킨다. 정원을 신청 수보다 작게 줄일 수 없다.
 *  - 진행 중 신청이 있는 회차는 보관하지 않는다(신청자에게 안내가 끊기지 않게).
 */

export const POSTING_STATUS_LABEL: Record<VolunteerPostingStatus, string> = {
  DRAFT: '작성 중',
  OPEN: '모집 중',
  CLOSED: '마감',
  ARCHIVED: '보관',
};

const LIVE = ['RECEIVED', 'APPROVED'] as const;

export interface PostingInput {
  title: string;
  interest: string;
  description: string;
  place: string;
  recruitFrom: string;
  recruitTo: string;
  requirements?: string | null;
}

function clean(v: string | null | undefined, max: number) {
  const t = v?.trim();
  return t ? filterContent(t, { bannedWords: [], maxLength: max }).clean : '';
}

function validatePosting(input: PostingInput) {
  const title = clean(input.title, 80);
  const description = clean(input.description, 2000);
  const place = clean(input.place, 120);
  if (!title) throw new VolunteerError('공고 제목을 입력해 주세요.');
  if (!(VOLUNTEER_INTERESTS as readonly string[]).includes(input.interest)) throw new VolunteerError('활동 분야를 골라 주세요.');
  if (!description) throw new VolunteerError('활동 설명을 입력해 주세요.');
  if (!place) throw new VolunteerError('활동 장소를 입력해 주세요.');
  if (!isDateKey(input.recruitFrom) || !isDateKey(input.recruitTo)) throw new VolunteerError('모집 기간을 확인해 주세요.');
  if (input.recruitFrom > input.recruitTo) throw new VolunteerError('모집 시작일이 마감일보다 늦습니다.');
  return {
    title,
    interest: input.interest,
    description,
    place,
    recruitFrom: new Date(`${input.recruitFrom}T00:00:00Z`),
    recruitTo: new Date(`${input.recruitTo}T00:00:00Z`),
    requirements: clean(input.requirements, 500) || null,
  };
}

async function ownPosting(merchantId: string, id: string) {
  const p = await prisma.volunteerPosting.findFirst({ where: { id, merchantId } });
  if (!p) throw new VolunteerError('공고를 찾을 수 없습니다.');
  return p;
}

export async function createPosting(merchantId: string, userId: string, input: PostingInput) {
  const data = validatePosting(input);
  return prisma.volunteerPosting.create({ data: { id: newId(), merchantId, createdBy: userId, ...data } });
}

export async function updatePosting(merchantId: string, id: string, input: PostingInput) {
  const p = await ownPosting(merchantId, id);
  if (p.status === 'ARCHIVED') throw new VolunteerError('보관된 공고는 고칠 수 없습니다. 먼저 보관을 해제해 주세요.');
  const data = validatePosting(input);
  return prisma.volunteerPosting.update({ where: { id: p.id }, data });
}

/**
 * 상태 전환. OPEN(모집 시작) · CLOSED(마감) · ARCHIVED(보관) · RESTORE(보관 해제 → 마감 상태로).
 * 모집 시작은 마감일이 오늘 이후일 때만 된다.
 */
export async function setPostingStatus(merchantId: string, id: string, next: 'OPEN' | 'CLOSED' | 'ARCHIVED' | 'RESTORE', now = new Date()) {
  const p = await ownPosting(merchantId, id);
  if (next === 'RESTORE') {
    if (p.status !== 'ARCHIVED') throw new VolunteerError('보관된 공고가 아닙니다.');
    return prisma.volunteerPosting.update({ where: { id: p.id }, data: { status: 'CLOSED', archivedAt: null } });
  }
  if (p.status === 'ARCHIVED') throw new VolunteerError('보관된 공고입니다. 먼저 보관을 해제해 주세요.');
  if (next === 'OPEN' && dateKeyOf(p.recruitTo) < kstDateKey(now)) throw new VolunteerError('모집 마감일이 지났습니다. 기간을 고친 뒤 모집을 시작해 주세요.');
  if (next === 'ARCHIVED') {
    return prisma.volunteerPosting.update({ where: { id: p.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
  }
  return prisma.volunteerPosting.update({ where: { id: p.id }, data: { status: next } });
}

export interface ShiftInput {
  date: string;
  startTime: string;
  endTime: string;
  capacity: number;
}

export async function addShift(merchantId: string, postingId: string, input: ShiftInput, now = new Date()) {
  const p = await ownPosting(merchantId, postingId);
  if (p.status === 'ARCHIVED') throw new VolunteerError('보관된 공고에는 회차를 추가할 수 없습니다.');
  if (!isDateKey(input.date)) throw new VolunteerError('활동 날짜를 확인해 주세요.');
  if (!isHm(input.startTime) || !isHm(input.endTime)) throw new VolunteerError('시작·끝 시각을 HH:MM 으로 입력해 주세요.');
  const minutes = minutesBetween(input.startTime, input.endTime);
  if (minutes < 10 || minutes > 720) throw new VolunteerError('회차 길이는 10분~12시간이어야 하고, 끝 시각이 시작보다 늦어야 합니다.');
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 1000) throw new VolunteerError('정원은 1~1000명입니다.');
  const startsAt = kstInstant(input.date, input.startTime);
  if (startsAt.getTime() <= now.getTime()) throw new VolunteerError('이미 지난 시각의 회차는 만들 수 없습니다.');
  return prisma.volunteerShift.create({
    data: {
      id: newId(),
      postingId: p.id,
      merchantId,
      shiftDate: new Date(`${input.date}T00:00:00Z`),
      startTime: input.startTime,
      endTime: input.endTime,
      startsAt,
      endsAt: kstInstant(input.date, input.endTime),
      capacity: input.capacity,
    },
  });
}

/** 정원 변경. 진행 중 신청 수보다 작게 줄일 수 없다(조건부 갱신). */
export async function setShiftCapacity(merchantId: string, shiftId: string, capacity: number) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new VolunteerError('정원은 1~1000명입니다.');
  const r = await prisma.$executeRaw`UPDATE "volunteer_shift" SET "capacity" = ${capacity}, "updated_at" = now()
    WHERE "id" = ${shiftId} AND "merchant_id" = ${merchantId} AND "applied_count" <= ${capacity}`;
  if (r === 0) throw new VolunteerError('회차를 찾을 수 없거나, 이미 신청한 인원보다 정원을 작게 줄일 수 없습니다.');
}

export async function setShiftArchived(merchantId: string, shiftId: string, archived: boolean) {
  const s = await prisma.volunteerShift.findFirst({ where: { id: shiftId, merchantId } });
  if (!s) throw new VolunteerError('회차를 찾을 수 없습니다.');
  if (!archived) return prisma.volunteerShift.update({ where: { id: s.id }, data: { archivedAt: null } });
  // 신청(자리 잡기 = 회차 행 UPDATE)과 직렬화한다: 회차 행을 잠근 뒤 진행 중 신청을 세고 보관한다.
  // 신청이 먼저 자리를 잡았으면 그 커밋을 기다려 신청을 보고 거절하고, 보관이 먼저면 신청의 자리 잡기가
  // archived_at IS NULL 조건에서 떨어진다(2026-11-06 점검 낮음 — 보관과 동시 신청 경쟁).
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "volunteer_shift" WHERE "id" = ${s.id} FOR UPDATE`;
    const live = await tx.volunteerApplication.count({ where: { shiftId: s.id, status: { in: [...LIVE] } } });
    if (live > 0) throw new VolunteerError('진행 중 신청이 있는 회차는 보관할 수 없습니다. 신청을 먼저 처리해 주세요.');
    return tx.volunteerShift.update({ where: { id: s.id }, data: { archivedAt: new Date() } });
  });
}

/** 콘솔 목록: 공고 + 회차 수·신청 수 */
export async function listPostings(merchantId: string, opts: { includeArchived?: boolean } = {}) {
  const rows = await prisma.volunteerPosting.findMany({
    where: { merchantId, ...(opts.includeArchived ? {} : { status: { not: 'ARCHIVED' } }) },
    include: { shifts: { where: { archivedAt: null }, select: { id: true, capacity: true, appliedCount: true, startsAt: true } } },
    orderBy: [{ createdAt: 'desc' }],
    take: 200,
  });
  return rows.map((p) => ({
    ...p,
    shiftCount: p.shifts.length,
    capacity: p.shifts.reduce((a, s) => a + s.capacity, 0),
    applied: p.shifts.reduce((a, s) => a + s.appliedCount, 0),
    nextShiftAt: p.shifts.filter((s) => s.startsAt > new Date()).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0]?.startsAt ?? null,
  }));
}

/** 콘솔 상세: 회차별 신청 현황(마스킹 번호·표시 이름만) */
export async function getPostingDetail(merchantId: string, id: string) {
  return prisma.volunteerPosting.findFirst({
    where: { id, merchantId },
    include: {
      shifts: {
        orderBy: [{ startsAt: 'asc' }],
        include: {
          applications: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              status: true,
              assignment: true,
              createdAt: true,
              attendedAt: true,
              payer: { select: { id: true, displayName: true, phoneMasked: true, mergedIntoId: true } },
            },
          },
        },
      },
    },
  });
}

function openWhere(merchantId: string, now: Date) {
  const today = new Date(`${kstDateKey(now)}T00:00:00Z`);
  return { merchantId, status: 'OPEN' as const, archivedAt: null, recruitFrom: { lte: today }, recruitTo: { gte: today } };
}

/** 공개 후원페이지 "자원봉사 모집" 영역: OPEN · 모집 기간 안 공고 + 앞으로의 회차(남은 자리) */
export async function listOpenPostings(merchantId: string, now = new Date()) {
  const rows = await prisma.volunteerPosting.findMany({
    where: openWhere(merchantId, now),
    include: { shifts: { where: { archivedAt: null, startsAt: { gt: now } }, orderBy: { startsAt: 'asc' } } },
    orderBy: [{ recruitTo: 'asc' }, { createdAt: 'desc' }],
    take: 12,
  });
  return rows.map((p) => ({
    id: p.id,
    title: p.title,
    interest: p.interest,
    place: p.place,
    recruitTo: p.recruitTo,
    shiftCount: p.shifts.length,
    remaining: p.shifts.reduce((a, s) => a + Math.max(0, s.capacity - s.appliedCount), 0),
    nextShift: p.shifts[0] ?? null,
  }));
}

/** 공개 공고 상세. 공개 조건을 벗어나면 null(404). */
export async function getPublicPosting(merchantId: string, postingId: string, now = new Date()) {
  return prisma.volunteerPosting.findFirst({
    where: { id: postingId, ...openWhere(merchantId, now) },
    include: { shifts: { where: { archivedAt: null, startsAt: { gt: now } }, orderBy: { startsAt: 'asc' } } },
  });
}

/** 다른 기관 공고 ID 가 섞이지 않게 확인한다(콘텐츠 연결용). 없거나 남의 것이면 null. */
export async function ownedPostingId(merchantId: string, postingId: string | null | undefined): Promise<string | null> {
  if (!postingId) return null;
  const p = await prisma.volunteerPosting.findFirst({ where: { id: postingId, merchantId }, select: { id: true } });
  return p?.id ?? null;
}
