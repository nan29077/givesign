import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { deletePrivateObject, newObjectName, putPrivateObject } from '@/server/uploads';
import { personalInfoHit } from '@/server/adapters/content/llm-script';
import type { ContentAsset } from '@/generated/prisma/client';

/**
 * 콘텐츠 소재 (2026-11-11 G2-4) — 담당자가 휴대폰으로 올리는 사진·짧은 영상.
 *
 *  - 파일은 **비공개 저장소**에만 둔다(`putPrivateObject`). 기관 콘솔 `/studio/content/assets/[id]/file` 로만 읽는다.
 *  - 얼굴 여부는 담당자가 체크한다(자동 얼굴 인식을 하지 않는다 — 꾸미지 않음).
 *  - 얼굴이 나온 소재는 전자문서 용도 `PORTRAIT_CONSENT`(초상권 이용 동의서) 서명 요청을 **보냈거나 완료한 것**과 연결해야 콘텐츠에 쓸 수 있다.
 *    거절·만료·취소된 동의서는 연결이 없는 것으로 본다(쓸 때마다 다시 확인).
 *  - 아동·이용자 소재는 기본 "가림 필요" 표시. 수혜자 소재(BENEFICIARY 태그)는 콘텐츠에 쓸 수 없다(기존 규칙 "수혜자 실사진·실명을 쓰지 않는다").
 *  - 콘텐츠에 연결하는 것은 검토 대기(REVIEW)일 때만. 승인 때(approveContent) 다시 검사한다.
 *  - 소재를 장면 이미지·영상에 자동으로 합성하지 않는다(담당자가 게시할 때 쓰는 자료). 승인 화면에 동의서 상태를 보인다.
 */

export class ContentAssetError extends Error {}

export const ASSET_TAGS = ['EVENT', 'VOLUNTEER', 'GOODS', 'FACILITY', 'BENEFICIARY'] as const;
export type AssetTag = (typeof ASSET_TAGS)[number];
export const ASSET_TAG_LABEL: Record<AssetTag, string> = {
  EVENT: '행사',
  VOLUNTEER: '봉사',
  GOODS: '물품',
  FACILITY: '시설',
  BENEFICIARY: '수혜자(콘텐츠 사용 불가)',
};

export const ASSET_PEOPLE = ['NONE', 'STAFF_VOLUNTEER', 'CHILD', 'CLIENT'] as const;
export type AssetPeople = (typeof ASSET_PEOPLE)[number];
export const ASSET_PEOPLE_LABEL: Record<AssetPeople, string> = {
  NONE: '사람 없음',
  STAFF_VOLUNTEER: '직원·봉사자',
  CHILD: '아동',
  CLIENT: '이용자',
};

export const ASSET_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ASSET_MAX_VIDEO_BYTES = 25 * 1024 * 1024;
/** 기관당 보관 전 소재 상한 */
export const ASSET_MAX_PER_MERCHANT = 500;

/** 초상권 동의서로 인정하는 서명 요청 상태(보냈거나 완료) */
export const CONSENT_OK_STATUSES = ['SENT', 'IN_PROGRESS', 'COMPLETED'] as const;
export const PORTRAIT_PURPOSE = 'PORTRAIT_CONSENT';

/** 파일 앞부분으로 형식을 판정한다(확장자·브라우저가 보낸 형식은 믿지 않는다). */
export function sniffAsset(buf: Buffer): { kind: 'IMAGE' | 'VIDEO'; ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'IMAGE', ext: 'jpg', mime: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { kind: 'IMAGE', ext: 'png', mime: 'image/png' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { kind: 'IMAGE', ext: 'webp', mime: 'image/webp' };
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(brand)) return { kind: 'IMAGE', ext: 'heic', mime: 'image/heic' };
    if (brand === 'qt  ') return { kind: 'VIDEO', ext: 'mov', mime: 'video/quicktime' };
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', '3gp4', '3gp5'].includes(brand)) return { kind: 'VIDEO', ext: 'mp4', mime: 'video/mp4' };
  }
  return null;
}

export interface UploadAssetInput {
  bytes: Buffer;
  tags: string[];
  people: string;
  hasFace: boolean;
  /** 비우면 아동·이용자일 때 켬 */
  blurRequired?: boolean | null;
  note?: string | null;
}

export function normalizeAssetInput(input: Pick<UploadAssetInput, 'tags' | 'people' | 'hasFace' | 'blurRequired' | 'note'>) {
  const tags = [...new Set(input.tags.filter((t): t is AssetTag => (ASSET_TAGS as readonly string[]).includes(t)))];
  if (tags.length === 0) throw new ContentAssetError('태그(행사·봉사·물품·시설·수혜자)를 하나 이상 골라 주세요.');
  const people = (ASSET_PEOPLE as readonly string[]).includes(input.people) ? (input.people as AssetPeople) : 'NONE';
  const sensitive = people === 'CHILD' || people === 'CLIENT';
  // 아동·이용자는 기본 가림 필요. 담당자가 명시적으로 끈 경우에도 아동은 끄지 못한다(얼굴이 나왔으면).
  let blur = input.blurRequired ?? sensitive;
  if (people === 'CHILD' && input.hasFace) blur = true;
  const note = (input.note ?? '').trim().slice(0, 200) || null;
  if (note) {
    const pii = personalInfoHit(note);
    if (pii) throw new ContentAssetError(`메모에 ${pii}를 적지 마세요.`);
  }
  return { tags, people, hasFace: Boolean(input.hasFace), blurRequired: Boolean(blur), note };
}

export async function uploadContentAsset(merchantId: string, userId: string, input: UploadAssetInput): Promise<ContentAsset> {
  const sniff = sniffAsset(input.bytes);
  if (!sniff) throw new ContentAssetError('사진(JPG·PNG·WEBP·HEIC) 또는 짧은 영상(MP4·MOV)만 올릴 수 있습니다.');
  const max = sniff.kind === 'VIDEO' ? ASSET_MAX_VIDEO_BYTES : ASSET_MAX_IMAGE_BYTES;
  if (input.bytes.length > max) throw new ContentAssetError(`${sniff.kind === 'VIDEO' ? '영상' : '사진'}은 ${Math.round(max / 1024 / 1024)}MB 이하만 올릴 수 있습니다.`);
  const meta = normalizeAssetInput(input);
  const count = await prisma.contentAsset.count({ where: { merchantId, archivedAt: null } });
  if (count >= ASSET_MAX_PER_MERCHANT) throw new ContentAssetError(`소재는 ${ASSET_MAX_PER_MERCHANT}개까지 보관할 수 있습니다. 쓰지 않는 소재를 보관 처리해 주세요.`);
  // 저장소에 먼저 올리고 행을 만든다. 행 생성이 실패하면 올린 파일을 지운다.
  const objectName = newObjectName(sniff.ext);
  await putPrivateObject(objectName, input.bytes, sniff.mime);
  try {
    return await prisma.contentAsset.create({
      data: { id: newId(), merchantId, kind: sniff.kind, objectName, mime: sniff.mime, sizeBytes: input.bytes.length, ...meta, uploadedBy: userId },
    });
  } catch (e) {
    await deletePrivateObject(objectName).catch(() => undefined);
    throw e;
  }
}

export async function updateContentAssetMeta(merchantId: string, id: string, input: Pick<UploadAssetInput, 'tags' | 'people' | 'hasFace' | 'blurRequired' | 'note'>) {
  const meta = normalizeAssetInput(input);
  const r = await prisma.contentAsset.updateMany({ where: { id, merchantId, archivedAt: null }, data: meta });
  if (r.count === 0) throw new ContentAssetError('소재를 찾을 수 없습니다.');
}

/** 보관(되돌릴 수 있음). 파일은 지우지 않는다. */
export async function archiveContentAsset(merchantId: string, id: string, restore = false) {
  const r = await prisma.contentAsset.updateMany({ where: { id, merchantId }, data: { archivedAt: restore ? null : new Date() } });
  if (r.count === 0) throw new ContentAssetError('소재를 찾을 수 없습니다.');
}

// ---------------------------------------------------------------------------
// 초상권 동의서 연결
// ---------------------------------------------------------------------------

export type ConsentState = 'NONE' | 'SENT' | 'COMPLETED' | 'INVALID';
export const CONSENT_STATE_LABEL: Record<ConsentState, string> = {
  NONE: '동의서 없음',
  SENT: '동의서 보냄(서명 대기)',
  COMPLETED: '동의서 서명 완료',
  INVALID: '동의서 무효(거절·만료·취소)',
};

/** 초상권 동의서로 쓸 수 있는 서명 요청: 이 기관 · 서식 용도 PORTRAIT_CONSENT(또는 기본 서식 PORTRAIT_CONSENT) */
async function portraitEnvelopes(merchantId: string, ids?: string[]) {
  return prisma.eDocEnvelope.findMany({
    where: {
      merchantId,
      ...(ids ? { id: { in: ids } } : {}),
      template: { OR: [{ purpose: PORTRAIT_PURPOSE }, { presetKey: PORTRAIT_PURPOSE }] },
    },
    select: { id: true, title: true, status: true, sentAt: true, completedAt: true },
    orderBy: { sentAt: 'desc' },
    take: ids ? undefined : 100,
  });
}

function consentStateOf(status: string | null | undefined): ConsentState {
  if (!status) return 'NONE';
  if (status === 'COMPLETED') return 'COMPLETED';
  if (status === 'SENT' || status === 'IN_PROGRESS') return 'SENT';
  return 'INVALID';
}

/** 연결 후보(최근 100건, 무효 포함 — 화면이 상태를 보여 준다) */
export async function consentCandidates(merchantId: string) {
  const list = await portraitEnvelopes(merchantId);
  return list.map((e) => ({ ...e, state: consentStateOf(e.status) }));
}

export async function linkPortraitConsent(merchantId: string, assetId: string, envelopeId: string | null) {
  const asset = await prisma.contentAsset.findFirst({ where: { id: assetId, merchantId } });
  if (!asset) throw new ContentAssetError('소재를 찾을 수 없습니다.');
  if (envelopeId) {
    const [env] = await portraitEnvelopes(merchantId, [envelopeId]);
    if (!env) throw new ContentAssetError('이 기관의 초상권 이용 동의서 서명 요청만 연결할 수 있습니다.');
    if (consentStateOf(env.status) === 'INVALID') throw new ContentAssetError('거절·만료·취소된 동의서는 연결할 수 없습니다. 동의서를 다시 보내 주세요.');
  }
  await prisma.contentAsset.update({ where: { id: asset.id }, data: { consentEnvelopeId: envelopeId } });
}

export interface AssetUsability {
  asset: ContentAsset;
  consent: ConsentState;
  consentTitle: string | null;
  usable: boolean;
  reasons: string[];
  warnings: string[];
}

/** 소재 사용 가능 여부(쓸 때마다 원천을 다시 본다) */
export async function assetUsability(merchantId: string, assetIds: string[]): Promise<AssetUsability[]> {
  if (assetIds.length === 0) return [];
  const assets = await prisma.contentAsset.findMany({ where: { merchantId, id: { in: assetIds } } });
  const envIds = [...new Set(assets.map((a) => a.consentEnvelopeId).filter((x): x is string => Boolean(x)))];
  const envs = envIds.length ? await portraitEnvelopes(merchantId, envIds) : [];
  const envBy = new Map(envs.map((e) => [e.id, e]));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out: AssetUsability[] = [];
  for (const id of assetIds) {
    const asset = byId.get(id);
    if (!asset) continue;
    const env = asset.consentEnvelopeId ? envBy.get(asset.consentEnvelopeId) : null;
    const consent = asset.consentEnvelopeId ? (env ? consentStateOf(env.status) : 'INVALID') : 'NONE';
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (asset.archivedAt) reasons.push('보관된 소재입니다.');
    if (asset.tags.includes('BENEFICIARY')) reasons.push('수혜자 소재는 콘텐츠에 쓸 수 없습니다.');
    if (asset.hasFace && consent !== 'SENT' && consent !== 'COMPLETED') reasons.push('얼굴이 나온 소재는 초상권 이용 동의서(보냈거나 서명 완료)를 연결해야 쓸 수 있습니다.');
    if (asset.hasFace && consent === 'SENT') warnings.push('동의서 서명이 아직 끝나지 않았습니다. 게시 전에 서명 완료를 확인해 주세요.');
    if (asset.blurRequired) warnings.push('얼굴 가림이 필요한 소재입니다. 가린 뒤 게시해 주세요.');
    out.push({ asset, consent, consentTitle: env?.title ?? null, usable: reasons.length === 0, reasons, warnings });
  }
  return out;
}

/** 콘텐츠에 연결된 소재 중 쓸 수 없는 것이 있으면 이유(승인 거절용), 없으면 null */
export async function contentAssetsProblem(merchantId: string, assetIds: string[] | null | undefined): Promise<string | null> {
  const ids = assetIds ?? [];
  if (ids.length === 0) return null;
  const list = await assetUsability(merchantId, ids);
  if (list.length < ids.length) return '연결된 소재를 찾을 수 없습니다. 소재 연결을 다시 확인해 주세요.';
  const bad = list.find((u) => !u.usable);
  return bad ? `소재를 쓸 수 없어 승인할 수 없습니다: ${bad.reasons[0]}` : null;
}

/** 소재를 콘텐츠에 연결(검토 대기일 때만, 쓸 수 있는 소재만) */
export async function attachAssetToContent(merchantId: string, itemId: string, assetId: string) {
  const item = await prisma.contentItem.findFirst({ where: { id: itemId, merchantId }, select: { id: true, status: true, assetIds: true } });
  if (!item) throw new ContentAssetError('콘텐츠를 찾을 수 없습니다.');
  if (item.status !== 'REVIEW') throw new ContentAssetError('검토 대기 중인 콘텐츠에만 소재를 연결할 수 있습니다.');
  const [u] = await assetUsability(merchantId, [assetId]);
  if (!u) throw new ContentAssetError('소재를 찾을 수 없습니다.');
  if (!u.usable) throw new ContentAssetError(u.reasons[0]!);
  if (item.assetIds.includes(assetId)) return;
  if (item.assetIds.length >= 10) throw new ContentAssetError('콘텐츠 하나에 소재는 10개까지 연결할 수 있습니다.');
  // 검토 대기 조건부 — 그 사이 승인됐으면 연결하지 않는다
  const r = await prisma.contentItem.updateMany({ where: { id: item.id, merchantId, status: 'REVIEW' }, data: { assetIds: { push: assetId } } });
  if (r.count === 0) throw new ContentAssetError('이미 처리된 콘텐츠입니다.');
}

export async function detachAssetFromContent(merchantId: string, itemId: string, assetId: string) {
  const item = await prisma.contentItem.findFirst({ where: { id: itemId, merchantId }, select: { id: true, assetIds: true } });
  if (!item) throw new ContentAssetError('콘텐츠를 찾을 수 없습니다.');
  await prisma.contentItem.update({ where: { id: item.id }, data: { assetIds: item.assetIds.filter((x) => x !== assetId) } });
}

/** 승인 화면용: 콘텐츠별 소재 상태 */
export async function assetStatusForItems(merchantId: string, items: Array<{ id: string; assetIds: string[] }>) {
  const all = [...new Set(items.flatMap((i) => i.assetIds))];
  const list = await assetUsability(merchantId, all).catch((e) => {
    logger.warn('소재 상태 확인 실패', { message: (e as Error).message });
    return [] as AssetUsability[];
  });
  const by = new Map(list.map((u) => [u.asset.id, u]));
  return new Map(items.map((i) => [i.id, i.assetIds.map((a) => by.get(a)).filter((x): x is AssetUsability => Boolean(x))]));
}
