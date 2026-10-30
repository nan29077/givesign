'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { decrypt } from '@/lib/crypto';
import { env } from '@/lib/env';
import type { StudioActionState } from '@/app/actions/studio';
import type { ContentKind, SocialPlatform } from '@/generated/prisma/enums';
import { decideVolunteer, recordVolunteerActivity, VolunteerError } from '@/server/services/volunteers';
import { commitSupporterImport, ImportError, pendingPledgeRequests, previewSupporterImport, type ImportPreviewRow } from '@/server/services/supporters';
import { AlimtalkConfigError, ALIMTALK_TEMPLATES, saveAlimtalkChannel } from '@/server/services/alimtalk';
import { runMerchantNotice, previousMonthKey } from '@/server/services/monthly-notice';
import {
  approveContent,
  archiveContent,
  cancelPublish,
  connectSocialChannel,
  ContentError,
  disconnectSocialChannel,
  regenerateContent,
  requestContent,
  saveContentSetting,
  schedulePublish,
  updateContentDraft,
} from '@/server/services/content';
import { sendMtDetailed } from '@/server/services/charge-flow';
import * as tpl from '@/server/services/mt-templates';

/**
 * 기관 콘솔 — 자동화(구성원·자원봉사·알림톡·월간 안내·콘텐츠·SNS) 액션.
 * 모든 대상은 세션 기관(merchantId) 소유인지 서비스에서 다시 확인한다.
 */

type Handler = (merchantId: string, userId: string) => Promise<StudioActionState>;

const KNOWN_ERRORS = [VolunteerError, ImportError, AlimtalkConfigError, ContentError];

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
    const message = (e as Error)?.message ?? '';
    if (KNOWN_ERRORS.some((E) => e instanceof E)) return { ok: false, message };
    logger.error('기관 콘솔(자동화) 액션 처리 오류', { message });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const list = (f: FormData, k: string) => f.getAll(k).filter((v): v is string => typeof v === 'string' && v.trim() !== '');

// ---------------------------------------------------------------------------
// 자원봉사
// ---------------------------------------------------------------------------

export async function decideVolunteerAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId, userId) => {
    const decision = text(f, 'decision') === 'REJECT' ? 'REJECT' : 'APPROVE';
    await decideVolunteer({ merchantId, applicationId: text(f, 'id'), decision, assignment: text(f, 'assignment'), memo: text(f, 'memo'), userId });
    revalidatePath('/studio/volunteers');
    return { ok: true, message: decision === 'APPROVE' ? '승인하고 배정 안내를 보냈습니다.' : '신청을 반려했습니다.' };
  });
}

export async function recordActivityAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId, userId) => {
    const hours = Number(text(f, 'hours') || '0');
    const minutes = Math.round(hours * 60);
    await recordVolunteerActivity({ merchantId, payerId: text(f, 'payerId'), activityDate: text(f, 'date'), minutes, title: text(f, 'title'), note: text(f, 'note'), userId });
    revalidatePath('/studio/volunteers');
    return { ok: true, message: '활동을 기록했습니다.' };
  });
}

// ---------------------------------------------------------------------------
// 명단 업로드
// ---------------------------------------------------------------------------

export interface ImportActionState extends StudioActionState {
  preview?: { rows: ImportPreviewRow[]; newCount: number; duplicateCount: number; errorCount: number; truncated: boolean };
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function supporterImportAction(_p: ImportActionState, f: FormData): Promise<ImportActionState> {
  let user;
  try {
    user = await requireMerchant();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const file = f.get('file');
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'CSV 파일을 골라 주세요.' };
  if (file.size > MAX_FILE_BYTES) return { ok: false, message: '파일은 2MB 이하로 올려 주세요.' };
  if (!/\.csv$/i.test(file.name)) return { ok: false, message: 'CSV 파일만 올릴 수 있습니다. 엑셀은 [다른 이름으로 저장 → CSV UTF-8] 로 저장해 주세요.' };
  const csv = await file.text();
  try {
    if (text(f, 'intent') !== 'commit') {
      const preview = await previewSupporterImport(user.merchantId, csv);
      return { ok: true, message: `새로 등록 ${preview.newCount}명 · 중복 ${preview.duplicateCount}명 · 오류 ${preview.errorCount}행`, preview };
    }
    const r = await commitSupporterImport({
      merchantId: user.merchantId,
      userId: user.id,
      fileName: file.name,
      csv,
      consentConfirmed: Boolean(f.get('consentConfirmed')),
      consentBasis: text(f, 'consentBasis'),
    });
    await writeAudit({ action: 'SUPPORTER_IMPORT', targetType: 'merchant', targetId: user.merchantId, after: { fileName: file.name, ...r } }).catch(() => undefined);
    revalidatePath('/studio/supporters');
    return { ok: true, message: `명단 ${r.accepted}명을 등록했습니다. (중복 ${r.duplicates} · 오류 ${r.errors})` };
  } catch (e) {
    if (e instanceof ImportError) return { ok: false, message: e.message };
    logger.error('명단 업로드 실패', { message: (e as Error).message });
    return { ok: false, message: '파일을 처리하지 못했습니다. 형식을 확인해 주세요.' };
  }
}

/** 문자 '정기' 로 링크를 받고 약정을 마치지 않은 분께 같은 안내를 한 번 더 보낸다(본인 요청에 대한 정보성 안내). */
export async function pledgeReminderAction(_p: StudioActionState) {
  return withMerchant(async (merchantId) => {
    const merchant = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { code: true, displayName: true } });
    const targets = await pendingPledgeRequests(merchantId);
    if (targets.length === 0) return { ok: true, message: '다시 안내할 대상이 없습니다.' };
    const payers = await prisma.payerProfile.findMany({ where: { id: { in: targets.map((t) => t.payerId) } }, select: { id: true, phoneEnc: true } });
    let sent = 0;
    for (const p of payers) {
      const link = `${env.baseUrl}/my/recurring/new?merchant=${merchant.code}&src=sms`;
      const r = await sendMtDetailed({ phone: decrypt(p.phoneEnc), template: tpl.tplPledgeLink({ merchantName: merchant.displayName, link }), merchantId }).catch(() => null);
      if (r?.ok) sent += 1;
    }
    return { ok: true, message: `${sent}명에게 약정 안내를 다시 보냈습니다.` };
  });
}

// ---------------------------------------------------------------------------
// 알림톡 · 월간 안내
// ---------------------------------------------------------------------------

export async function saveAlimtalkAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId) => {
    const codes: Record<string, string> = {};
    for (const code of ALIMTALK_TEMPLATES) codes[code] = text(f, `tpl_${code}`);
    await saveAlimtalkChannel(merchantId, { channelId: text(f, 'channelId'), senderKey: text(f, 'senderKey') || undefined, templateCodes: codes });
    await writeAudit({ action: 'ALIMTALK_CHANNEL_SAVE', targetType: 'merchant', targetId: merchantId, after: { channelId: text(f, 'channelId'), templates: Object.values(codes).filter(Boolean).length } }).catch(() => undefined);
    revalidatePath('/studio/notices');
    return { ok: true, message: '저장했습니다. 관리자가 카카오 승인 내용을 확인하면 알림톡으로 발송됩니다. 그 전까지는 문자로 나갑니다.' };
  });
}

export async function saveNoticeSettingsAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId) => {
    const cycle = text(f, 'receiptCycle') === 'MONTHLY' ? 'MONTHLY' : 'YEARLY';
    await prisma.merchantProfile.update({ where: { id: merchantId }, data: { receiptCycle: cycle, monthlyNoticeEnabled: Boolean(f.get('monthlyNoticeEnabled')) } });
    revalidatePath('/studio/notices');
    return { ok: true, message: '안내 설정을 저장했습니다.' };
  });
}

/** 지난달 월간 안내를 지금 보낸다(배치와 같은 함수 · 같은 멱등 규칙). */
export async function runNoticeNowAction(_p: StudioActionState) {
  return withMerchant(async (merchantId) => {
    const month = previousMonthKey();
    const r = await runMerchantNotice(merchantId, month);
    revalidatePath('/studio/notices');
    if (!r) return { ok: true, message: `${month} 안내는 이미 보냈습니다. 같은 달은 한 번만 보냅니다.` };
    return { ok: true, message: `${month} 안내: 발송 ${r.sentCount}건(알림톡 ${r.alimtalkCount}) · 문자 대체 ${r.fallbackCount} · 제외 ${r.skippedCount} · 실패 ${r.failedCount}` };
  });
}

// ---------------------------------------------------------------------------
// 콘텐츠
// ---------------------------------------------------------------------------

const KINDS: ContentKind[] = ['SHORTFORM', 'IMAGE_SQUARE', 'IMAGE_STORY'];
const PLATFORMS: SocialPlatform[] = ['YOUTUBE', 'INSTAGRAM', 'FACEBOOK'];

export async function requestContentAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId, userId) => {
    const kinds = list(f, 'kind').filter((k): k is ContentKind => KINDS.includes(k as ContentKind));
    if (kinds.length === 0) return { ok: false, message: '만들 형식을 하나 이상 골라 주세요.' };
    let last = '';
    for (const kind of kinds) {
      const item = await requestContent({ merchantId, campaignId: text(f, 'campaignId'), kind, userId, tone: text(f, 'tone') });
      last = item.id;
    }
    revalidatePath('/studio/content');
    return { ok: true, message: `${kinds.length}건을 만들었습니다. 검토한 뒤 승인해 주세요.`, redirectTo: kinds.length === 1 ? `/studio/content/${last}` : '/studio/content' };
  });
}

export async function updateContentAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId) => {
    const id = text(f, 'id');
    await updateContentDraft(merchantId, id, { captions: f.getAll('scene').map(String), caption: String(f.get('caption') ?? '') });
    revalidatePath(`/studio/content/${id}`);
    return { ok: true, message: '수정 내용으로 장면을 다시 그렸습니다. 검토 후 승인해 주세요.' };
  });
}

export async function approveContentAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId, userId) => {
    const id = text(f, 'id');
    await approveContent(merchantId, id, userId);
    await writeAudit({ action: 'CONTENT_APPROVE', targetType: 'content_item', targetId: id }).catch(() => undefined);
    revalidatePath(`/studio/content/${id}`);
    revalidatePath('/studio/content');
    return { ok: true, message: '승인했습니다. 게시 예약을 하거나 파일을 내려받아 직접 올릴 수 있습니다.' };
  });
}

export async function archiveContentAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId) => {
    await archiveContent(merchantId, text(f, 'id'));
    revalidatePath('/studio/content');
    return { ok: true, message: '보관했습니다.', redirectTo: '/studio/content' };
  });
}

export async function regenerateContentAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId, userId) => {
    const fresh = await regenerateContent(merchantId, text(f, 'id'), userId, text(f, 'tone'));
    revalidatePath('/studio/content');
    return { ok: true, message: '새로 만들었습니다.', redirectTo: `/studio/content/${fresh.id}` };
  });
}

export async function schedulePublishAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId) => {
    const id = text(f, 'id');
    const platforms = list(f, 'platform').filter((p): p is SocialPlatform => PLATFORMS.includes(p as SocialPlatform));
    const at = text(f, 'at') ? new Date(`${text(f, 'at')}:00+09:00`) : new Date();
    if (Number.isNaN(at.getTime())) return { ok: false, message: '게시 시각을 확인해 주세요.' };
    const created = await schedulePublish(merchantId, id, platforms, at);
    revalidatePath(`/studio/content/${id}`);
    return { ok: true, message: created.length ? `${created.length}개 채널에 게시를 예약했습니다.` : '이미 게시된 채널입니다.' };
  });
}

export async function cancelPublishAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId) => {
    await cancelPublish(merchantId, text(f, 'publishId'));
    revalidatePath(`/studio/content/${text(f, 'id')}`);
    return { ok: true, message: '예약을 취소했습니다.' };
  });
}

export async function saveContentSettingAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId) => {
    await saveContentSetting(merchantId, {
      tone: text(f, 'tone'),
      bannedWords: text(f, 'bannedWords').split(/[,\n]/),
      hashtags: text(f, 'hashtags').split(/[\s,]+/),
      autoApprove: Boolean(f.get('autoApprove')),
    });
    revalidatePath('/studio/content');
    return { ok: true, message: '콘텐츠 설정을 저장했습니다.' };
  });
}

export async function connectChannelAction(_p: StudioActionState, f: FormData) {
  return withMerchant(async (merchantId, userId) => {
    const platform = text(f, 'platform') as SocialPlatform;
    if (!PLATFORMS.includes(platform)) return { ok: false, message: '알 수 없는 채널입니다.' };
    if (text(f, 'intent') === 'disconnect') {
      await disconnectSocialChannel(merchantId, platform);
      revalidatePath('/studio/channels');
      return { ok: true, message: '연결을 해제했습니다.' };
    }
    await connectSocialChannel(merchantId, platform, text(f, 'accountName'), userId);
    await writeAudit({ action: 'SOCIAL_CHANNEL_CONNECT', targetType: 'merchant', targetId: merchantId, after: { platform } }).catch(() => undefined);
    revalidatePath('/studio/channels');
    return { ok: true, message: '채널을 연결했습니다.' };
  });
}
