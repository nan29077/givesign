import { encrypt, maskPhone, normalizePhone } from '@/lib/crypto';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { kstDateKey } from '@/lib/datetime';
import { featureVolunteerEnabled } from '@/lib/env';
import { prisma } from '@/server/db';
import type { VolunteerApplicationStatus } from '@/generated/prisma/enums';
import { currentTermsDoc } from './terms';
import { issueVolunteerAgreement, type AgreementMeta } from './agreements';
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
 *  - 진행 중(접수·승인) 신청은 기관당 1건. DB 부분 유니크 인덱스가 최종 방어다.
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
  meta?: AgreementMeta;
}

export async function applyVolunteer(input: ApplyVolunteerInput) {
  if (!featureVolunteerEnabled()) throw new VolunteerError('자원봉사 신청을 받지 않는 중입니다.');
  if (!input.agree) throw new VolunteerError('자원봉사 개인정보 수집·이용에 동의해 주세요.');
  if (!input.safetyPledge) throw new VolunteerError('안전 수칙 서약에 체크해 주세요.');
  const interests = input.interests.filter((i) => (VOLUNTEER_INTERESTS as readonly string[]).includes(i));
  const days = input.availableDays.filter((d) => (VOLUNTEER_DAYS as readonly string[]).includes(d));
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

  const dup = await prisma.volunteerApplication.findFirst({
    where: { merchantId: merchant.id, payerId: payer.id, status: { in: LIVE } },
    select: { id: true },
  });
  const DUP = '이 기관에 진행 중인 자원봉사 신청이 있습니다. 마이페이지에서 진행 상황을 확인해 주세요.';
  if (dup) throw new VolunteerError(DUP);

  const terms = await currentTermsDoc('VOLUNTEER_PRIVACY');
  if (!terms) throw new VolunteerError('자원봉사 동의 약관이 준비되지 않았습니다. 관리자에게 문의해 주세요.');

  const clean = (v: string | null | undefined, max: number) =>
    v?.trim() ? filterContent(v.trim(), { bannedWords: [], maxLength: max }).clean : null;

  let applicationId: string;
  try {
    applicationId = await prisma.$transaction(async (tx) => {
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
          contentItemId: input.contentItemId ?? null,
        },
      });
      return app.id;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new VolunteerError(DUP);
    throw e;
  }

  await issueVolunteerAgreement(applicationId, input.meta ?? {}).catch((e) =>
    logger.error('자원봉사 신청서 생성 실패', { applicationId, message: (e as Error).message }),
  );
  await sendMtForPayer(payer.id, tpl.tplVolunteerReceived({ merchantName: merchant.displayName }), null, merchant.id).catch((e) =>
    logger.warn('자원봉사 접수 안내 실패', { message: (e as Error).message }),
  );
  return applicationId;
}

export async function withdrawVolunteer(payerId: string, applicationId: string) {
  const r = await prisma.volunteerApplication.updateMany({
    where: { id: applicationId, payerId, status: { in: LIVE } },
    data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
  });
  if (r.count === 0) throw new VolunteerError('철회할 수 있는 신청이 없습니다.');
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
    include: { merchant: { select: { displayName: true } } },
  });
  if (!app) throw new VolunteerError('신청을 찾을 수 없습니다.');
  if (app.status !== 'RECEIVED' && !(input.decision === 'APPROVE' && app.status === 'APPROVED')) {
    throw new VolunteerError('이미 처리된 신청입니다.');
  }
  const assignment = input.assignment?.trim().slice(0, 120) || null;
  if (input.decision === 'APPROVE' && !assignment) throw new VolunteerError('승인할 때는 활동 일정·장소 안내를 적어 주세요.');
  await prisma.volunteerApplication.update({
    where: { id: app.id },
    data: {
      status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      assignment: input.decision === 'APPROVE' ? assignment : app.assignment,
      memo: input.memo?.trim().slice(0, 300) || app.memo,
      decidedAt: new Date(),
      decidedBy: input.userId,
    },
  });
  if (input.decision === 'APPROVE') {
    await sendMtForPayer(app.payerId, tpl.tplVolunteerApproved({ merchantName: app.merchant.displayName, assignment: assignment! }), null, app.merchantId).catch((e) =>
      logger.warn('자원봉사 승인 안내 실패', { message: (e as Error).message }),
    );
  }
}

export async function recordVolunteerActivity(input: {
  merchantId: string;
  payerId: string;
  activityDate: string;
  minutes: number;
  title: string;
  note?: string;
  userId: string;
}) {
  const approved = await prisma.volunteerApplication.findFirst({
    where: { merchantId: input.merchantId, payerId: input.payerId, status: 'APPROVED' },
    select: { id: true },
  });
  if (!approved) throw new VolunteerError('승인된 자원봉사자에게만 활동을 기록할 수 있습니다.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.activityDate) || input.activityDate > kstDateKey()) {
    throw new VolunteerError('활동일을 확인해 주세요. 오늘 이후 날짜는 기록할 수 없습니다.');
  }
  if (!Number.isInteger(input.minutes) || input.minutes < 10 || input.minutes > 720) {
    throw new VolunteerError('활동 시간은 10분~12시간 사이로 입력해 주세요.');
  }
  const title = input.title.trim();
  if (!title) throw new VolunteerError('활동 내용을 입력해 주세요.');
  return prisma.volunteerActivity.create({
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
