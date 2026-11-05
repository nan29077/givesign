'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import type { StudioActionState } from '@/app/actions/studio';
import { markShiftAttendance, VolunteerError } from '@/server/services/volunteers';
import {
  addShift,
  createPosting,
  setPostingStatus,
  setShiftArchived,
  setShiftCapacity,
  updatePosting,
  type PostingInput,
} from '@/server/services/volunteer-postings';

/**
 * 기관 콘솔 — 자원봉사 모집 공고·회차·출석 액션. 대상 소유(merchantId)는 서비스가 다시 확인한다.
 */

type Handler = (merchantId: string, userId: string) => Promise<StudioActionState>;

async function withMerchant(fn: Handler): Promise<StudioActionState> {
  let merchantId: string;
  let userId: string;
  try {
    const user = await requireMerchant();
    merchantId = user.merchantId;
    userId = user.id;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '기관 권한이 필요합니다.' };
  }
  try {
    return await fn(merchantId, userId);
  } catch (e) {
    if (e instanceof VolunteerError) return { ok: false, message: e.message };
    logger.error('자원봉사 공고 액션 처리 오류', { message: (e as Error)?.message });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

function postingInput(f: FormData): PostingInput {
  return {
    title: text(f, 'title'),
    interest: text(f, 'interest'),
    description: text(f, 'description'),
    place: text(f, 'place'),
    recruitFrom: text(f, 'recruitFrom'),
    recruitTo: text(f, 'recruitTo'),
    requirements: text(f, 'requirements'),
  };
}

function refresh(postingId?: string) {
  revalidatePath('/studio/volunteers');
  revalidatePath('/studio/volunteers/postings');
  if (postingId) revalidatePath(`/studio/volunteers/postings/${postingId}`);
}

export async function savePostingAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = text(f, 'id');
    if (id) {
      await updatePosting(merchantId, id, postingInput(f));
      await writeAudit({ actorUserId: userId, action: 'VOLUNTEER_POSTING_UPDATE', targetType: 'volunteer_posting', targetId: id, after: { merchantId } });
      refresh(id);
      return { ok: true, message: '공고를 저장했습니다.' };
    }
    const p = await createPosting(merchantId, userId, postingInput(f));
    await writeAudit({ actorUserId: userId, action: 'VOLUNTEER_POSTING_CREATE', targetType: 'volunteer_posting', targetId: p.id, after: { merchantId } });
    refresh(p.id);
    return { ok: true, message: '공고를 만들었습니다. 회차를 추가한 뒤 모집을 시작해 주세요.', redirectTo: `/studio/volunteers/postings/${p.id}` };
  });
}

const STATUS_MESSAGE = { OPEN: '모집을 시작했습니다.', CLOSED: '모집을 마감했습니다.', ARCHIVED: '공고를 보관했습니다.', RESTORE: '보관을 해제했습니다(마감 상태).' } as const;

export async function setPostingStatusAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = text(f, 'id');
    const raw = text(f, 'next');
    const next = (['OPEN', 'CLOSED', 'ARCHIVED', 'RESTORE'] as const).find((s) => s === raw);
    if (!next) return { ok: false, message: '처리 구분을 확인해 주세요.' };
    await setPostingStatus(merchantId, id, next);
    await writeAudit({ actorUserId: userId, action: 'VOLUNTEER_POSTING_STATUS', targetType: 'volunteer_posting', targetId: id, after: { merchantId, next } });
    refresh(id);
    return { ok: true, message: STATUS_MESSAGE[next] };
  });
}

export async function addShiftAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const postingId = text(f, 'postingId');
    const s = await addShift(merchantId, postingId, {
      date: text(f, 'date'),
      startTime: text(f, 'startTime'),
      endTime: text(f, 'endTime'),
      capacity: Number(text(f, 'capacity') || '0'),
    });
    await writeAudit({ actorUserId: userId, action: 'VOLUNTEER_SHIFT_CREATE', targetType: 'volunteer_shift', targetId: s.id, after: { merchantId, postingId } });
    refresh(postingId);
    return { ok: true, message: '회차를 추가했습니다.' };
  });
}

export async function shiftCapacityAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const shiftId = text(f, 'shiftId');
    const capacity = Number(text(f, 'capacity') || '0');
    await setShiftCapacity(merchantId, shiftId, capacity);
    await writeAudit({ actorUserId: userId, action: 'VOLUNTEER_SHIFT_UPDATE', targetType: 'volunteer_shift', targetId: shiftId, after: { merchantId, capacity } });
    refresh(text(f, 'postingId'));
    return { ok: true, message: '정원을 바꿨습니다.' };
  });
}

export async function archiveShiftAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const shiftId = text(f, 'shiftId');
    const archived = text(f, 'archived') !== '0';
    await setShiftArchived(merchantId, shiftId, archived);
    await writeAudit({ actorUserId: userId, action: archived ? 'VOLUNTEER_SHIFT_ARCHIVE' : 'VOLUNTEER_SHIFT_RESTORE', targetType: 'volunteer_shift', targetId: shiftId, after: { merchantId } });
    refresh(text(f, 'postingId'));
    return { ok: true, message: archived ? '회차를 보관했습니다.' : '회차 보관을 해제했습니다.' };
  });
}

export async function attendanceAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const applicationId = text(f, 'id');
    const attended = text(f, 'attended') === '1';
    await markShiftAttendance({ merchantId, applicationId, attended, userId });
    await writeAudit({ actorUserId: userId, action: attended ? 'VOLUNTEER_ATTENDED' : 'VOLUNTEER_NO_SHOW', targetType: 'volunteer_application', targetId: applicationId, after: { merchantId } });
    refresh(text(f, 'postingId'));
    return { ok: true, message: attended ? '출석을 확인하고 활동을 기록했습니다.' : '불참으로 처리했습니다.' };
  });
}
