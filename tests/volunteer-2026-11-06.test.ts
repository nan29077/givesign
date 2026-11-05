import { beforeEach, describe, expect, it, vi } from 'vitest';

// 감사로그(writeAudit)는 요청 헤더·쿠키를 읽는다. 테스트에서는 빈 요청으로 대체한다.
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { kstDateKey } from '@/lib/datetime';
import { kstInstant, shiftScheduleLabel } from '@/lib/volunteer-schedule';
import {
  applyVolunteer,
  decideVolunteer,
  markShiftAttendance,
  recordVolunteerActivity,
  volunteerShiftsStartingOn,
  withdrawVolunteer,
} from '@/server/services/volunteers';
import { addShift, createPosting, getPublicPosting, listOpenPostings, setPostingStatus, setShiftArchived, setShiftCapacity } from '@/server/services/volunteer-postings';
import { clickTargetPath, goLink, isBotUserAgent } from '@/server/services/content-clicks';
import { foldMergedSums, mergePayer, unmergePayer } from '@/server/services/payer-merge';
import { listSupporters } from '@/server/services/supporters';
import { GET as goRoute } from '@/app/go/[publishId]/route';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, type Fixture } from './helpers';

/**
 * 고도화 6단계 — 자원봉사 모집 공고·회차, 출석·불참, D-1 대상, 콘텐츠 클릭 집계, 후원자 병합.
 */

const singleBackend = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${process.env.PGLITE_PORT ?? '5463'}/`);

let fx: Fixture;
const base = { interests: [] as string[], availableDays: [] as string[], safetyPledge: true, agree: true };

const today = () => kstDateKey();
const daysFromToday = (n: number) => kstDateKey(new Date(Date.now() + n * 86_400_000));

async function seedVolunteerTerms() {
  await prisma.termsVersion.create({
    data: { id: newId(), type: 'VOLUNTEER_PRIVACY', version: '1.0', title: '자원봉사 동의', content: '본문', required: false, effectiveFrom: new Date('2026-01-01') },
  });
}

async function openPosting(opts: { from?: string; to?: string } = {}) {
  const p = await createPosting(fx.merchantId, fx.merchantUserId, {
    title: '토요 도시락 배달',
    interest: '급식·도시락',
    description: '홀몸 어르신 댁에 도시락을 전합니다.',
    place: '복지관 1층',
    recruitFrom: opts.from ?? today(),
    recruitTo: opts.to ?? daysFromToday(30),
    requirements: '앞치마 지참',
  });
  await setPostingStatus(fx.merchantId, p.id, 'OPEN');
  return p;
}

let phoneSeq = 0;
async function newPayer() {
  phoneSeq += 1;
  return seedRegisteredPayer(`0109${String(1000000 + phoneSeq).slice(-7)}`);
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  await seedVolunteerTerms();
});

describe('[1] 모집 공고·회차 신청', () => {
  it.skipIf(singleBackend)('정원 2 회차에 동시에 3명이 신청하면 2명만 접수된다', async () => {
    const p = await openPosting();
    const s = await addShift(fx.merchantId, p.id, { date: daysFromToday(3), startTime: '10:00', endTime: '12:00', capacity: 2 });
    const payers = await Promise.all([newPayer(), newPayer(), newPayer()]);
    const results = await Promise.allSettled(payers.map((py) => applyVolunteer({ ...base, payerId: py.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s.id })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason?.message)).toMatch(/정원/);
    expect((await prisma.volunteerShift.findUniqueOrThrow({ where: { id: s.id } })).appliedCount).toBe(2);
    expect(await prisma.volunteerApplication.count({ where: { shiftId: s.id } })).toBe(2);
  });

  it('회차 신청은 공고 분야·회차 요일을 채우고, 같은 회차 중복은 거절, 다른 회차·일반 신청은 따로 받는다', async () => {
    const p = await openPosting();
    const s1 = await addShift(fx.merchantId, p.id, { date: daysFromToday(3), startTime: '10:00', endTime: '12:00', capacity: 5 });
    const s2 = await addShift(fx.merchantId, p.id, { date: daysFromToday(4), startTime: '10:00', endTime: '12:00', capacity: 5 });
    const py = await newPayer();
    const id = await applyVolunteer({ ...base, payerId: py.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s1.id });
    const app = await prisma.volunteerApplication.findUniqueOrThrow({ where: { id } });
    expect(app.postingId).toBe(p.id);
    expect(app.shiftId).toBe(s1.id);
    expect((await prisma.volunteerProfile.findUniqueOrThrow({ where: { payerId: py.id } })).interests).toEqual(['급식·도시락']);
    await expect(applyVolunteer({ ...base, payerId: py.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s1.id })).rejects.toThrow(/이미 이 회차/);
    await applyVolunteer({ ...base, payerId: py.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s2.id });
    // 기존 일반 신청 1건 제한은 그대로
    await applyVolunteer({ ...base, interests: ['돌봄·말벗'], availableDays: ['SAT'], payerId: py.id, merchantId: fx.merchantId });
    await expect(applyVolunteer({ ...base, interests: ['돌봄·말벗'], availableDays: ['SAT'], payerId: py.id, merchantId: fx.merchantId })).rejects.toThrow(/진행 중인/);
    // 회차가 있는 공고에 회차 없이 신청하면 거절
    const py2 = await newPayer();
    await expect(applyVolunteer({ ...base, payerId: py2.id, merchantId: fx.merchantId, postingId: p.id })).rejects.toThrow(/회차를 골라/);
  });

  it('마감·기간 지난·작성 중 공고, 지난 회차, 보관 회차, 다른 기관 회차는 거절한다', async () => {
    const py = await newPayer();
    const p = await openPosting();
    const s = await addShift(fx.merchantId, p.id, { date: daysFromToday(3), startTime: '10:00', endTime: '12:00', capacity: 5 });
    await setPostingStatus(fx.merchantId, p.id, 'CLOSED');
    await expect(applyVolunteer({ ...base, payerId: py.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s.id })).rejects.toThrow(/마감/);
    expect(await getPublicPosting(fx.merchantId, p.id)).toBeNull();

    const expired = await openPosting();
    const es = await addShift(fx.merchantId, expired.id, { date: daysFromToday(3), startTime: '10:00', endTime: '12:00', capacity: 5 });
    await prisma.volunteerPosting.update({ where: { id: expired.id }, data: { recruitTo: new Date(`${daysFromToday(-1)}T00:00:00Z`) } });
    await expect(applyVolunteer({ ...base, payerId: py.id, merchantId: fx.merchantId, postingId: expired.id, shiftId: es.id })).rejects.toThrow(/기간이 지난/);
    expect((await listOpenPostings(fx.merchantId)).map((x) => x.id)).not.toContain(expired.id);
    await expect(setPostingStatus(fx.merchantId, expired.id, 'OPEN')).rejects.toThrow(/마감일이 지났/);

    const live = await openPosting();
    const past = await addShift(fx.merchantId, live.id, { date: daysFromToday(3), startTime: '10:00', endTime: '12:00', capacity: 5 });
    await prisma.volunteerShift.update({ where: { id: past.id }, data: { startsAt: new Date(Date.now() - 60_000) } });
    await expect(applyVolunteer({ ...base, payerId: py.id, merchantId: fx.merchantId, postingId: live.id, shiftId: past.id })).rejects.toThrow(/지난 회차/);
    const arch = await addShift(fx.merchantId, live.id, { date: daysFromToday(5), startTime: '10:00', endTime: '12:00', capacity: 5 });
    await setShiftArchived(fx.merchantId, arch.id, true);
    await expect(applyVolunteer({ ...base, payerId: py.id, merchantId: fx.merchantId, postingId: live.id, shiftId: arch.id })).rejects.toThrow(/받지 않는 회차/);
    await expect(applyVolunteer({ ...base, payerId: py.id, merchantId: 'other-merchant', postingId: live.id, shiftId: arch.id })).rejects.toThrow();
    await expect(addShift(fx.merchantId, live.id, { date: daysFromToday(3), startTime: '12:00', endTime: '10:00', capacity: 5 })).rejects.toThrow(/끝 시각/);
    await expect(addShift(fx.merchantId, live.id, { date: daysFromToday(-1), startTime: '10:00', endTime: '12:00', capacity: 5 })).rejects.toThrow(/지난 시각/);
    // 지원하지 않은 공고에는 신청이 남지 않는다
    expect(await prisma.volunteerApplication.count()).toBe(0);
  });

  it('철회·반려하면 자리를 돌려주고, 정원은 신청 수보다 작게 줄일 수 없으며, 진행 중 신청이 있으면 회차를 보관하지 않는다', async () => {
    const p = await openPosting();
    const s = await addShift(fx.merchantId, p.id, { date: daysFromToday(3), startTime: '10:00', endTime: '12:00', capacity: 1 });
    const a = await newPayer();
    const b = await newPayer();
    const appA = await applyVolunteer({ ...base, payerId: a.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s.id });
    await expect(applyVolunteer({ ...base, payerId: b.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s.id })).rejects.toThrow(/정원/);
    await expect(setShiftCapacity(fx.merchantId, s.id, 0)).rejects.toThrow(/정원/);
    await expect(setShiftArchived(fx.merchantId, s.id, true)).rejects.toThrow(/진행 중 신청/);
    await withdrawVolunteer(a.id, appA);
    expect((await prisma.volunteerShift.findUniqueOrThrow({ where: { id: s.id } })).appliedCount).toBe(0);
    await expect(withdrawVolunteer(a.id, appA)).rejects.toThrow(/철회할 수 있는/);
    expect((await prisma.volunteerShift.findUniqueOrThrow({ where: { id: s.id } })).appliedCount).toBe(0);

    const appB = await applyVolunteer({ ...base, payerId: b.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s.id });
    await decideVolunteer({ merchantId: fx.merchantId, applicationId: appB, decision: 'REJECT', userId: fx.merchantUserId });
    expect((await prisma.volunteerShift.findUniqueOrThrow({ where: { id: s.id } })).appliedCount).toBe(0);
    await expect(decideVolunteer({ merchantId: fx.merchantId, applicationId: appB, decision: 'REJECT', userId: fx.merchantUserId })).rejects.toThrow(/이미 처리/);
    expect((await prisma.volunteerShift.findUniqueOrThrow({ where: { id: s.id } })).appliedCount).toBe(0);
    // 반려된 사람이 같은 회차에 다시 신청할 수 있다
    await applyVolunteer({ ...base, payerId: b.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s.id });
    expect((await prisma.volunteerShift.findUniqueOrThrow({ where: { id: s.id } })).appliedCount).toBe(1);
  });

  it('승인하면 배정 안내가 "M/D(요일) HH:MM~HH:MM · 장소" 로 채워지고, 담당자가 적은 문구가 우선한다', async () => {
    expect(shiftScheduleLabel({ shiftDate: '2026-11-08', startTime: '10:00', endTime: '12:00' }, '복지관 1층')).toBe('11/8(일) 10:00~12:00 · 복지관 1층');
    const p = await openPosting();
    const date = daysFromToday(3);
    const s = await addShift(fx.merchantId, p.id, { date, startTime: '10:00', endTime: '12:30', capacity: 3 });
    const a = await newPayer();
    const b = await newPayer();
    const appA = await applyVolunteer({ ...base, payerId: a.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s.id });
    const appB = await applyVolunteer({ ...base, payerId: b.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s.id });
    await decideVolunteer({ merchantId: fx.merchantId, applicationId: appA, decision: 'APPROVE', userId: fx.merchantUserId });
    const got = (await prisma.volunteerApplication.findUniqueOrThrow({ where: { id: appA } })).assignment!;
    expect(got).toBe(shiftScheduleLabel({ shiftDate: date, startTime: '10:00', endTime: '12:30' }, '복지관 1층'));
    expect(got).toMatch(/^\d{1,2}\/\d{1,2}\([일월화수목금토]\) 10:00~12:30 · 복지관 1층$/);
    await decideVolunteer({ merchantId: fx.merchantId, applicationId: appB, decision: 'APPROVE', assignment: '정문 9:50 집합', userId: fx.merchantUserId });
    expect((await prisma.volunteerApplication.findUniqueOrThrow({ where: { id: appB } })).assignment).toBe('정문 9:50 집합');
    // 승인은 자리를 바꾸지 않는다
    expect((await prisma.volunteerShift.findUniqueOrThrow({ where: { id: s.id } })).appliedCount).toBe(2);
  });
});

describe('[2] 출석·불참', () => {
  async function approvedOnTodayShift() {
    const p = await openPosting();
    const s = await addShift(fx.merchantId, p.id, { date: daysFromToday(2), startTime: '09:00', endTime: '11:00', capacity: 5 });
    const a = await newPayer();
    const appId = await applyVolunteer({ ...base, payerId: a.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s.id });
    await decideVolunteer({ merchantId: fx.merchantId, applicationId: appId, decision: 'APPROVE', userId: fx.merchantUserId });
    return { p, s, a, appId };
  }

  it('회차 날짜 전에는 출석을 받지 않고, 출석하면 회차 길이만큼 활동이 기록되며 COMPLETED 가 된다(두 번 눌러도 1건)', async () => {
    const { p, s, a, appId } = await approvedOnTodayShift();
    await expect(markShiftAttendance({ merchantId: fx.merchantId, applicationId: appId, attended: true, userId: fx.merchantUserId })).rejects.toThrow(/회차 날짜/);
    // 회차가 오늘이 되었다고 친다
    await prisma.volunteerShift.update({ where: { id: s.id }, data: { shiftDate: new Date(`${today()}T00:00:00Z`), startsAt: new Date(Date.now() - 60_000) } });
    const act = await markShiftAttendance({ merchantId: fx.merchantId, applicationId: appId, attended: true, userId: fx.merchantUserId });
    expect(act?.minutes).toBe(120);
    expect(act?.title).toBe(p.title);
    expect(act?.activityDate.toISOString().slice(0, 10)).toBe(today());
    const app = await prisma.volunteerApplication.findUniqueOrThrow({ where: { id: appId } });
    expect(app.status).toBe('COMPLETED');
    expect(app.attendedBy).toBe(fx.merchantUserId);
    await expect(markShiftAttendance({ merchantId: fx.merchantId, applicationId: appId, attended: true, userId: fx.merchantUserId })).rejects.toThrow(/승인된 신청만/);
    expect(await prisma.volunteerActivity.count({ where: { payerId: a.id } })).toBe(1);
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type: 'volunteer.activity_recorded' } });
    expect((ev.payload as { applicationId: string }).applicationId).toBe(appId);
    // COMPLETED 만 남은 봉사자에게도 담당자가 추가 활동을 기록할 수 있다(기존 recordVolunteerActivity 조건 유지)
    await recordVolunteerActivity({ merchantId: fx.merchantId, payerId: a.id, activityDate: today(), minutes: 30, title: '정리', userId: fx.merchantUserId });
    expect(await prisma.volunteerActivity.count({ where: { payerId: a.id } })).toBe(2);
  });

  it('불참은 NO_SHOW 이고 활동이 기록되지 않는다', async () => {
    const { s, a, appId } = await approvedOnTodayShift();
    await prisma.volunteerShift.update({ where: { id: s.id }, data: { shiftDate: new Date(`${today()}T00:00:00Z`), startsAt: new Date(Date.now() - 60_000) } });
    expect(await markShiftAttendance({ merchantId: fx.merchantId, applicationId: appId, attended: false, userId: fx.merchantUserId })).toBeNull();
    expect((await prisma.volunteerApplication.findUniqueOrThrow({ where: { id: appId } })).status).toBe('NO_SHOW');
    expect(await prisma.volunteerActivity.count({ where: { payerId: a.id } })).toBe(0);
    await expect(markShiftAttendance({ merchantId: fx.merchantId, applicationId: appId, attended: true, userId: fx.merchantUserId })).rejects.toThrow();
    await expect(markShiftAttendance({ merchantId: 'other', applicationId: appId, attended: true, userId: fx.merchantUserId })).rejects.toThrow(/찾을 수 없/);
  });
});

describe('[3] D-1 안내 대상 계산 (발송하지 않음)', () => {
  it('그 KST 날짜 00:00~24:00 에 시작하는 회차의 승인 신청만 고른다', async () => {
    const p = await openPosting();
    const D = '2027-01-10';
    const mk = async (date: string, start: string, end: string) =>
      prisma.volunteerShift.create({
        data: {
          id: newId(), postingId: p.id, merchantId: fx.merchantId, shiftDate: new Date(`${date}T00:00:00Z`),
          startTime: start, endTime: end, startsAt: kstInstant(date, start), endsAt: kstInstant(date, end), capacity: 5,
        },
      });
    const midnight = await mk(D, '00:00', '01:00');
    const late = await mk(D, '23:30', '23:50');
    const before = await mk('2027-01-09', '23:59', '23:59');
    const after = await mk('2027-01-11', '00:00', '01:00');
    const archived = await mk(D, '12:00', '13:00');
    expect(midnight.startsAt.toISOString()).toBe('2027-01-09T15:00:00.000Z');

    const ids: Record<string, string> = {};
    for (const [k, s] of Object.entries({ midnight, late, before, after, archived })) {
      const py = await newPayer();
      ids[k] = await applyVolunteer({ ...base, payerId: py.id, merchantId: fx.merchantId, postingId: p.id, shiftId: s.id });
      await decideVolunteer({ merchantId: fx.merchantId, applicationId: ids[k], decision: 'APPROVE', userId: fx.merchantUserId });
    }
    const received = await newPayer();
    await applyVolunteer({ ...base, payerId: received.id, merchantId: fx.merchantId, postingId: p.id, shiftId: midnight.id });
    await prisma.volunteerShift.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    const rows = await volunteerShiftsStartingOn(D);
    expect(rows.map((r) => r.applicationId)).toEqual([ids.midnight, ids.late]);
    expect(rows[0]).toMatchObject({ merchantId: fx.merchantId, merchantName: '테스트사회복지기관', shiftId: midnight.id, postingTitle: p.title });
    expect(rows[0]!.schedule).toBe('1/10(일) 00:00~01:00 · 복지관 1층');
    expect(rows[0]!.startsAt.toISOString()).toBe('2027-01-09T15:00:00.000Z');
    expect((await volunteerShiftsStartingOn('2027-01-09')).map((r) => r.applicationId)).toEqual([ids.before]);
    await expect(volunteerShiftsStartingOn('2027/01/10')).rejects.toThrow();
  });
});

describe('[4] 콘텐츠 링크 클릭 집계 (/go)', () => {
  async function seedPublish(opts: { campaignId?: string | null; postingId?: string | null } = {}) {
    const item = await prisma.contentItem.create({
      data: { id: newId(), merchantId: fx.merchantId, kind: 'SHORTFORM', title: 't', provider: 'mock', createdBy: fx.merchantUserId, campaignId: opts.campaignId ?? null, postingId: opts.postingId ?? null },
    });
    const pub = await prisma.contentPublish.create({
      data: { id: newId(), itemId: item.id, platform: 'INSTAGRAM', status: 'PUBLISHED', scheduledAt: new Date() },
    });
    return { item, pub };
  }
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
  const call = (publishId: string, ip: string, ua: string | null = UA, query = '') =>
    goRoute(new Request(`${env.baseUrl}/go/${publishId}${query}`, { headers: { 'x-forwarded-for': ip, ...(ua ? { 'user-agent': ua } : {}) } }), { params: Promise.resolve({ publishId }) });

  it('사람 클릭만 세고(봇·10분 안 같은 IP 제외), 대상은 게시 행에서 만든 후원페이지 주소로 고정된다', async () => {
    const { item, pub } = await seedPublish();
    const code = (await prisma.merchantProfile.findUniqueOrThrow({ where: { id: fx.merchantId } })).code;
    const expected = `${env.baseUrl}/donate/${code}?src=ig&cid=${item.id}`;

    const bot = await call(pub.id, '1.1.1.1', 'facebookexternalhit/1.1');
    expect(bot.status).toBe(302);
    expect(bot.headers.get('location')).toBe(expected);
    expect((await call(pub.id, '1.1.1.1', null)).status).toBe(302);
    expect((await prisma.contentPublish.findUniqueOrThrow({ where: { id: pub.id } })).clicks).toBe(0);

    const r1 = await call(pub.id, '1.1.1.1', UA, '?to=https://evil.example/&next=//evil.example');
    expect(r1.status).toBe(302);
    expect(r1.headers.get('location')).toBe(expected);
    await call(pub.id, '1.1.1.1');
    await call(pub.id, '2.2.2.2');
    expect((await prisma.contentPublish.findUniqueOrThrow({ where: { id: pub.id } })).clicks).toBe(2);

    expect((await call(newId(), '1.1.1.1')).status).toBe(404);
    expect((await call('not-an-id', '1.1.1.1')).status).toBe(404);
    expect((await call('https:%2F%2Fevil.example', '1.1.1.1')).status).toBe(404);
    expect(goLink(pub.id)).toBe(`${env.baseUrl}/go/${pub.id}`);
    expect(isBotUserAgent('Googlebot/2.1')).toBe(true);
    expect(isBotUserAgent(UA)).toBe(false);
  });

  it('캠페인·봉사 공고 콘텐츠는 그 페이지로 보낸다', async () => {
    const code = 'GIV-TEST';
    expect(clickTargetPath({ platform: 'YOUTUBE', item: { id: 'I', campaignId: 'C', postingId: null, merchant: { code } } })).toBe('/donate/GIV-TEST/campaigns/C?src=yt&cid=I');
    expect(clickTargetPath({ platform: 'FACEBOOK', item: { id: 'I', campaignId: null, postingId: 'P', merchant: { code } } })).toBe('/donate/GIV-TEST/volunteer/P?src=fb&cid=I');
  });
});

describe('[5] 후원자 병합 (조회·집계만)', () => {
  it('병합하면 통합 목록·후원자 누적이 한 줄로 합산되고, 해제하면 다시 나뉜다. 데이터는 옮기지 않고 감사로그가 남는다', async () => {
    const oldPayer = await seedRegisteredPayer('01011110001');
    const newP = await seedRegisteredPayer('01011110002');
    await inboundAndPay(moPayload({ to: fx.moNumber, from: '01011110001', text: '옛 번호 후원' }), fx.merchantId);
    await inboundAndPay(moPayload({ to: fx.moNumber, from: '01011110002', text: '새 번호 후원' }), fx.merchantId);
    const before = await listSupporters(fx.merchantId);
    expect(before.filter((r) => r.payerId === oldPayer.id || r.payerId === newP.id)).toHaveLength(2);
    const oldAmount = before.find((r) => r.payerId === oldPayer.id)!.totalAmount;
    const newAmount = before.find((r) => r.payerId === newP.id)!.totalAmount;

    const admin = await prisma.user.create({ data: { id: newId(), email: `admin-${newId()}@test.kr`, name: '관리자', role: 'ADMIN' } });
    await expect(mergePayer({ sourceId: oldPayer.id, targetId: newP.id, note: '짧', adminUserId: admin.id })).rejects.toThrow(/근거/);
    await expect(mergePayer({ sourceId: oldPayer.id, targetId: oldPayer.id, note: '본인 확인 통화', adminUserId: admin.id })).rejects.toThrow(/자기 자신/);
    await mergePayer({ sourceId: oldPayer.id, targetId: newP.id, note: '본인 확인 통화, 번호 변경', adminUserId: admin.id });

    const after = await listSupporters(fx.merchantId);
    expect(after.find((r) => r.payerId === oldPayer.id)).toBeUndefined();
    const merged = after.find((r) => r.payerId === newP.id)!;
    expect(merged.totalAmount).toBe(oldAmount + newAmount);
    expect(merged.donationCount).toBe(2);
    expect(merged.mergedCount).toBe(1);
    expect(merged.phoneMasked).toBe(newP.phoneMasked);

    // 기관 후원자 누적(/studio/donors)도 같은 기준
    const raw = await prisma.charge.groupBy({
      by: ['payerId'], where: { merchantId: fx.merchantId, payerId: { not: null } },
      _sum: { amount: true }, _count: { _all: true }, _max: { paidAt: true }, _min: { paidAt: true },
    });
    const folded = await foldMergedSums(raw);
    expect(folded.sums).toHaveLength(1);
    expect(folded.sums[0]!.payerId).toBe(newP.id);
    expect(folded.sums[0]!._count._all).toBe(2);
    expect(folded.mergedCount.get(newP.id)).toBe(1);

    // 결제 건은 그대로 각자 명의
    expect(await prisma.charge.count({ where: { payerId: oldPayer.id } })).toBe(1);

    // 순환·체인 거절
    const third = await seedRegisteredPayer('01011110003');
    await expect(mergePayer({ sourceId: newP.id, targetId: oldPayer.id, note: '반대 방향 시도', adminUserId: admin.id })).rejects.toThrow(/병합/);
    await expect(mergePayer({ sourceId: newP.id, targetId: third.id, note: '체인 시도입니다', adminUserId: admin.id })).rejects.toThrow(/한 단계/);
    await expect(mergePayer({ sourceId: third.id, targetId: oldPayer.id, note: '체인 시도입니다', adminUserId: admin.id })).rejects.toThrow(/한 단계/);
    await expect(mergePayer({ sourceId: oldPayer.id, targetId: third.id, note: '이중 병합 시도', adminUserId: admin.id })).rejects.toThrow(/이미/);

    const log = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'PAYER_MERGE', targetId: oldPayer.id } });
    expect(JSON.stringify(log.afterValue)).not.toContain('01011110001');

    await unmergePayer({ sourceId: oldPayer.id, adminUserId: admin.id, note: '잘못 병합' });
    await expect(unmergePayer({ sourceId: oldPayer.id, adminUserId: admin.id })).rejects.toThrow(/병합된 후원자가 아닙니다/);
    expect(await prisma.adminAuditLog.count({ where: { action: 'PAYER_UNMERGE', targetId: oldPayer.id } })).toBe(1);
    const again = await listSupporters(fx.merchantId);
    expect(again.filter((r) => r.payerId === oldPayer.id || r.payerId === newP.id)).toHaveLength(2);
    expect(again.find((r) => r.payerId === newP.id)!.mergedCount).toBe(0);
  });

  it.skipIf(singleBackend)('동시에 서로를 병합해도 순환이 생기지 않는다', async () => {
    const a = await seedRegisteredPayer('01022220001');
    const b = await seedRegisteredPayer('01022220002');
    const admin = await prisma.user.create({ data: { id: newId(), email: `admin-${newId()}@test.kr`, name: '관리자', role: 'ADMIN' } });
    const r = await Promise.allSettled([
      mergePayer({ sourceId: a.id, targetId: b.id, note: '동시 병합 확인', adminUserId: admin.id }),
      mergePayer({ sourceId: b.id, targetId: a.id, note: '동시 병합 확인', adminUserId: admin.id }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rows = await prisma.payerProfile.findMany({ where: { id: { in: [a.id, b.id] } }, select: { mergedIntoId: true } });
    expect(rows.filter((x) => x.mergedIntoId)).toHaveLength(1);
  });
});
