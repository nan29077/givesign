import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env, isLocal } from '@/lib/env';
import { logger } from '@/lib/logger';
import { decrypt, generateNumericCode, generateToken, hmac, safeEqual, tokenHash } from '@/lib/crypto';
import { formatKst } from '@/lib/datetime';
import { forecastEDocCost } from '@/lib/edoc-forecast';
import type { Prisma } from '@/generated/prisma/client';
import { kv, consumeAttempt } from '@/server/redis';
import { getMtAdapter } from '@/server/adapters/mt';
import { DOCUMENT_PURPOSE_LABEL, issuePurposeDocument, type DocumentPurpose, type MergeContext } from './purpose-documents';
import { isDocumentPurpose, templateRevision } from './purpose-templates';

/**
 * 업무별 문서 묶음 (2026-11-12 4차 J2).
 *
 *  - 묶음 정의(document_bundle + item)는 "용도" 목록이다. 보낼 때 그 용도의 현재 서식을 쓴다(서식 판은 발송 항목에 남긴다).
 *  - 기본 묶음(정기후원 신청: 약정서·개인정보 동의·출금 동의 / 봉사 신청: 신청서·개인정보 동의·초상권 동의(선택))은
 *    기관 승인 때와 묶음 화면을 열 때 `ensureDefaultBundles` 가 만든다(기관×preset 부분 유니크 — 멱등·동시 안전).
 *  - 보내기(`sendBundle`)는 문서마다 기존 `issuePurposeDocument`(notify:false — 개별 문자 없음)를 부른다:
 *    발송 전 점검·잔액 확인·머지 PDF·발급 대장·전자문서 봉투(서명자 1명)·이용요금 차감이 **기존 규칙 그대로**다.
 *    봉투 1개 = 1건 차감이므로 묶음은 문서 수만큼 차감된다(요금 규칙을 바꾸지 않는다). 문서별 발송 키 bundle:{발송}:{용도}.
 *  - 후원자에게는 묶음 링크 하나(`/sign/bundle/[토큰]`, 해시만 저장)를 보낸다. 본인확인 1번 → 한 화면에서 순서대로 확인·서명.
 *    서명은 문서마다 기존 `signAsSigner` 로 한다(봉투 해시 체인·완료 처리·document.signed 그대로).
 *  - 잔액이 모자라면 문서를 하나도 만들지 않고 BLOCKED(EDOC_BALANCE). 충전 승인 이벤트 소비자(edoc-balance-retry)가 다시 시도한다.
 *  - 약정서(SUPPORT_AGREEMENT)는 약정 흐름(agreements.ts)이 이미 보낸 서명 요청을 묶음에 **함께 보여 줄 뿐** 새로 만들지 않는다
 *    (같은 약정서에 서명 요청 두 개가 생기지 않게). 없으면 건너뛴다.
 */

export class BundleError extends Error {}

export const BUNDLE_KIND_LABEL: Record<string, string> = {
  RECURRING_SIGNUP: '정기후원 신청',
  VOLUNTEER_SIGNUP: '자원봉사 신청',
  CUSTOM: '직접 구성',
};

export interface BundlePreset {
  key: string;
  kind: 'RECURRING_SIGNUP' | 'VOLUNTEER_SIGNUP';
  name: string;
  items: Array<{ purpose: DocumentPurpose; required: boolean }>;
}

export const BUNDLE_PRESETS: BundlePreset[] = [
  {
    key: 'RECURRING_SIGNUP',
    kind: 'RECURRING_SIGNUP',
    name: '정기후원 신청 서류',
    items: [
      { purpose: 'SUPPORT_AGREEMENT', required: true },
      { purpose: 'PRIVACY_CONSENT', required: true },
      { purpose: 'DEBIT_CONSENT', required: true },
    ],
  },
  {
    key: 'VOLUNTEER_SIGNUP',
    kind: 'VOLUNTEER_SIGNUP',
    name: '자원봉사 신청 서류',
    items: [
      { purpose: 'VOLUNTEER_APPLICATION', required: true },
      { purpose: 'PRIVACY_CONSENT', required: true },
      { purpose: 'PORTRAIT_CONSENT', required: false },
    ],
  },
];

/** 묶음 서명 링크·본인확인 유효시간 */
export const BUNDLE_ACCESS_TTL_SEC = 30 * 60;
const OTP_TTL_SEC = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_SEND_MAX = 5;
const OTP_SEND_WINDOW_SEC = 1800;
/** 준비 중(PREPARING) 선점 유지 시간 — 넘으면 다른 실행이 이어받는다 */
const PREPARE_LEASE_MS = 2 * 60_000;

function isUnique(e: unknown) {
  return (e as { code?: string })?.code === 'P2002';
}

// ---------------------------------------------------------------- 기본 묶음

/** 기본 묶음을 만든다(없는 것만). 만든 preset 키 목록. 동시에 불러도 기관×preset 1개(부분 유니크). */
export async function ensureDefaultBundles(merchantId: string): Promise<string[]> {
  const existing = await prisma.documentBundle.findMany({ where: { merchantId, presetKey: { not: null } }, select: { presetKey: true } });
  const have = new Set(existing.map((b) => b.presetKey));
  const created: string[] = [];
  for (const p of BUNDLE_PRESETS) {
    if (have.has(p.key)) continue;
    try {
      await prisma.$transaction(async (tx) => {
        const id = newId();
        await tx.documentBundle.create({ data: { id, merchantId, name: p.name, kind: p.kind, presetKey: p.key } });
        await tx.documentBundleItem.createMany({
          data: p.items.map((it, i) => ({ id: newId(), bundleId: id, position: i + 1, purpose: it.purpose, required: it.required })),
        });
      });
      created.push(p.key);
    } catch (e) {
      if (isUnique(e)) continue;
      throw e;
    }
  }
  return created;
}

/** 기관 승인 시점. 실패해도 승인 결과를 바꾸지 않는다(묶음 화면을 열 때 다시 만든다). */
export async function provisionDefaultBundlesSafe(merchantId: string) {
  try {
    return await ensureDefaultBundles(merchantId);
  } catch (e) {
    logger.error('기본 문서 묶음 제공 실패', { merchantId, message: (e as Error).message });
    return [];
  }
}

// ---------------------------------------------------------------- 묶음 정의 · 상태

export interface BundleItemView {
  purpose: DocumentPurpose;
  label: string;
  required: boolean;
  /** 그 용도의 서식 상태 */
  template: { id: string; name: string; active: boolean; revision: string } | null;
  problem: string | null;
}

export interface BundleView {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  presetKey: string | null;
  useForRecurring: boolean;
  items: BundleItemView[];
  /** 서식이 없거나 중지된 문서(보내면 막힌다) */
  missing: string[];
  sends: { total: number; completed: number; open: number; blocked: number };
}

export async function listBundles(merchantId: string): Promise<BundleView[]> {
  await ensureDefaultBundles(merchantId).catch((e) => logger.warn('기본 문서 묶음 확인 실패', { merchantId, message: (e as Error).message }));
  const bundles = await prisma.documentBundle.findMany({
    where: { merchantId, archivedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { items: { orderBy: { position: 'asc' } } },
  });
  const templates = await prisma.documentTemplate.findMany({ where: { merchantId, archivedAt: null, purpose: { not: null } } });
  const byPurpose = new Map(templates.map((t) => [t.purpose!, t]));
  const counts = await prisma.documentBundleSend.groupBy({ by: ['bundleId', 'status'], where: { merchantId }, _count: { _all: true } });
  return bundles.map((b) => {
    const items: BundleItemView[] = b.items
      .filter((it) => isDocumentPurpose(it.purpose))
      .map((it) => {
        const purpose = it.purpose as DocumentPurpose;
        const t = byPurpose.get(purpose);
        const problem = !t
          ? purpose === 'SUPPORT_AGREEMENT'
            ? null
            : '서식이 아직 없습니다(처음 보낼 때 기본 서식을 만듭니다).'
          : !t.active
            ? '서식이 중지되어 있습니다.'
            : null;
        return {
          purpose,
          label: DOCUMENT_PURPOSE_LABEL[purpose],
          required: it.required,
          template: t ? { id: t.id, name: t.name, active: t.active, revision: templateRevision(t) } : null,
          problem,
        };
      });
    const c = (s: string) => counts.filter((x) => x.bundleId === b.id && x.status === s).reduce((a, x) => a + x._count._all, 0);
    return {
      id: b.id,
      name: b.name,
      kind: b.kind,
      kindLabel: BUNDLE_KIND_LABEL[b.kind] ?? b.kind,
      presetKey: b.presetKey,
      useForRecurring: b.useForRecurring,
      items,
      missing: items.filter((i) => i.problem && i.template && !i.template.active).map((i) => i.label),
      sends: { total: counts.filter((x) => x.bundleId === b.id).reduce((a, x) => a + x._count._all, 0), completed: c('COMPLETED'), open: c('SENT'), blocked: c('BLOCKED') + c('PREPARING') },
    };
  });
}

/**
 * 정기후원 약정에 이 묶음을 쓸지(기관 설정). 기본은 꺼짐 — 기존처럼 약정서만 보낸다.
 * 켤 수 있는 것은 정기후원 신청 묶음뿐이고, 기관당 하나만 켜진다(다른 묶음은 같은 트랜잭션에서 끈다).
 */
export async function setBundleForRecurring(merchantId: string, bundleId: string, on: boolean) {
  const b = await prisma.documentBundle.findFirst({ where: { id: bundleId, merchantId, archivedAt: null } });
  if (!b) throw new BundleError('묶음을 찾을 수 없습니다.');
  if (on && b.kind !== 'RECURRING_SIGNUP') throw new BundleError('정기후원 신청 묶음만 약정 흐름에 쓸 수 있습니다.');
  await prisma.$transaction(async (tx) => {
    if (on) await tx.documentBundle.updateMany({ where: { merchantId, useForRecurring: true, NOT: { id: bundleId } }, data: { useForRecurring: false } });
    await tx.documentBundle.update({ where: { id: bundleId }, data: { useForRecurring: on } });
  });
}

/** 선택 문서 켜기·끄기(필수 여부). 약정서·신청서 같은 묶음의 첫 문서는 항상 필수다. */
export async function setBundleItemRequired(merchantId: string, bundleId: string, purpose: string, required: boolean) {
  const b = await prisma.documentBundle.findFirst({ where: { id: bundleId, merchantId, archivedAt: null }, include: { items: { orderBy: { position: 'asc' } } } });
  if (!b) throw new BundleError('묶음을 찾을 수 없습니다.');
  const item = b.items.find((i) => i.purpose === purpose);
  if (!item) throw new BundleError('묶음에 없는 문서입니다.');
  if (item.position === 1 && !required) throw new BundleError('묶음의 첫 문서는 선택으로 바꿀 수 없습니다.');
  await prisma.documentBundleItem.update({ where: { id: item.id }, data: { required } });
}

// ---------------------------------------------------------------- 보내기

export interface SendBundleInput {
  merchantId: string;
  bundleId: string;
  payerId: string;
  /** 머지 맥락(이름·연락처는 발급 때 후원자 행에서 채운다 — 넣지 않는다) */
  context: Omit<MergeContext, 'donorName' | 'phoneMasked'> & { recurringId?: string | null };
  dedupeKey: string;
  subject?: { type: string; id: string };
}

export type SendBundleResult =
  | { ok: true; sendId: string; status: 'SENT' | 'COMPLETED' | 'CLOSED'; already?: boolean; devToken?: string }
  | { ok: false; sendId: string | null; status: string; blocked?: string; reason: string };

type StoredContext = Record<string, string | number | null>;

function storeContext(c: SendBundleInput['context']): StoredContext {
  const out: StoredContext = {};
  for (const [k, v] of Object.entries(c)) {
    if (v == null) continue;
    out[k] = typeof v === 'bigint' ? v.toString() : (v as string | number);
  }
  return out;
}

function readContext(raw: unknown): MergeContext & { recurringId?: string | null } {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const big = (v: unknown) => (v == null || v === '' ? null : BigInt(String(v)));
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    amount: big(c.amount),
    totalAmount: big(c.totalAmount),
    count: num(c.count),
    date: str(c.date),
    campaignTitle: str(c.campaignTitle),
    dayOfMonth: num(c.dayOfMonth),
    activityTitle: str(c.activityTitle),
    activityDate: str(c.activityDate),
    assignment: str(c.assignment),
    recurringId: str(c.recurringId),
  };
}

export function bundleSignUrl(token: string) {
  return `${env.baseUrl}/sign/bundle/${token}`;
}

/** 묶음 문서 1건의 발송 키(문서 단위 멱등 — 다시 불러도 봉투·차감이 한 번) */
export function bundleItemDedupeKey(sendId: string, purpose: string) {
  return `bundle:${sendId}:${purpose}`;
}

/**
 * 묶음을 보낸다(또는 막혔던 것을 이어서 보낸다). 다시 불러도 안전하다:
 * 발송 행은 dedupeKey 유니크, 문서는 문서별 발송 키, 문자 발송은 PREPARING 선점(2분)으로 한 번.
 */
export async function sendBundle(input: SendBundleInput): Promise<SendBundleResult> {
  const bundle = await prisma.documentBundle.findFirst({
    where: { id: input.bundleId, merchantId: input.merchantId, archivedAt: null },
    include: { items: { orderBy: { position: 'asc' } } },
  });
  if (!bundle) return { ok: false, sendId: null, status: 'NONE', reason: '묶음을 찾을 수 없습니다.' };
  const items = bundle.items.filter((i) => isDocumentPurpose(i.purpose));
  if (!items.length) return { ok: false, sendId: null, status: 'NONE', reason: '묶음에 문서가 없습니다.' };

  let send = await prisma.documentBundleSend.findUnique({ where: { dedupeKey: input.dedupeKey } });
  if (!send) {
    try {
      const id = newId();
      send = await prisma.$transaction(async (tx) => {
        const row = await tx.documentBundleSend.create({
          data: {
            id, merchantId: input.merchantId, bundleId: bundle.id, payerId: input.payerId, dedupeKey: input.dedupeKey,
            context: storeContext(input.context) as Prisma.InputJsonValue, subjectType: input.subject?.type ?? null, subjectId: input.subject?.id ?? null,
          },
        });
        await tx.documentBundleSendItem.createMany({
          data: items.map((it) => ({ id: newId(), sendId: id, position: it.position, purpose: it.purpose, required: it.required })),
        });
        return row;
      });
    } catch (e) {
      if (!isUnique(e)) throw e;
      send = await prisma.documentBundleSend.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey } });
    }
  }
  if (send.merchantId !== input.merchantId) return { ok: false, sendId: null, status: 'NONE', reason: '묶음을 찾을 수 없습니다.' };
  return continueBundleSend(send.id);
}

/** 막혔거나 준비 중이던 발송을 이어서 한다(충전 뒤 재시도·담당자 "다시 보내기" 공용). */
export async function continueBundleSend(sendId: string): Promise<SendBundleResult> {
  const send = await prisma.documentBundleSend.findUnique({ where: { id: sendId }, include: { items: { orderBy: { position: 'asc' } }, bundle: true } });
  if (!send) return { ok: false, sendId: null, status: 'NONE', reason: '묶음 발송을 찾을 수 없습니다.' };
  if (send.status === 'SENT' || send.status === 'COMPLETED' || send.status === 'CLOSED') {
    return { ok: true, sendId: send.id, status: send.status, already: true };
  }
  // 선점: BLOCKED 이거나, 처음(attempts 0) 이거나, 준비 중인데 선점이 오래된 것만. attempts 를 함께 보아 동시에 둘이 잡지 못한다.
  const now = new Date();
  const claimed = await prisma.documentBundleSend.updateMany({
    where: {
      id: send.id,
      attempts: send.attempts,
      OR: [{ status: 'BLOCKED' }, { status: 'PREPARING', attempts: 0 }, { status: 'PREPARING', updatedAt: { lt: new Date(now.getTime() - PREPARE_LEASE_MS) } }],
    },
    data: { status: 'PREPARING', attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return { ok: false, sendId: send.id, status: 'PREPARING', reason: '이미 처리 중인 발송입니다.' };

  const ctx = readContext(send.context);
  const block = async (blocked: string, reason: string) => {
    await prisma.documentBundleSend.update({ where: { id: send.id }, data: { status: 'BLOCKED', blocked, blockedReason: reason.slice(0, 300) } });
    return { ok: false as const, sendId: send.id, status: 'BLOCKED', blocked, reason };
  };

  try {
    // 약정서: 약정 흐름이 보낸 서명 요청을 잇는다(새로 만들지 않음).
    const agreementItem = send.items.find((i) => i.purpose === 'SUPPORT_AGREEMENT' && i.status !== 'CREATED');
    if (agreementItem) {
      const linked = await agreementEnvelopeFor(send.merchantId, ctx.recurringId ?? null);
      if (linked) {
        await prisma.documentBundleSendItem.update({
          where: { id: agreementItem.id },
          data: { status: 'CREATED', envelopeId: linked.envelopeId, issuedDocumentId: linked.issuedId, templateId: linked.templateId, templateRevision: linked.templateRevision, error: null },
        });
        agreementItem.status = 'CREATED';
      } else {
        await prisma.documentBundleSendItem.update({ where: { id: agreementItem.id }, data: { status: 'SKIPPED', error: '약정서는 약정 화면에서 서명 요청을 보냅니다(묶음에서 새로 만들지 않음).' } });
        agreementItem.status = 'SKIPPED';
      }
    }

    // 잔액: 만들 문서 수만큼 미리 본다 — 모자라면 하나도 만들지 않는다(반쪽 묶음 방지).
    const pending = send.items.filter((i) => i.status === 'PENDING' || i.status === 'BLOCKED');
    if (pending.length) {
      const { walletOverview } = await import('./edoc-billing');
      const w = await walletOverview(send.merchantId);
      const f = forecastEDocCost({ monthlyLeft: w.monthlyLeft, trialLeft: w.wallet.trialRemaining, balance: w.wallet.balance, perDocument: w.plan.perDocument }, pending.length);
      if (f.blocked > 0) {
        return block('EDOC_BALANCE', `전자문서 이용 잔액이 부족합니다. 이 묶음에 ${pending.length}건이 필요하고 지금 ${pending.length - f.blocked}건만 보낼 수 있습니다. 충전되면 자동으로 다시 보냅니다.`);
      }
    }

    for (const item of pending) {
      const purpose = item.purpose as DocumentPurpose;
      const r = await issuePurposeDocument({
        merchantId: send.merchantId,
        purpose,
        payerId: send.payerId,
        context: ctx,
        subject: { type: 'document_bundle_send', id: send.id },
        dedupeKey: bundleItemDedupeKey(send.id, purpose),
        notify: false,
      });
      if (r.ok) {
        const doc = await prisma.issuedDocument.findUnique({ where: { id: r.issuedId }, select: { envelopeId: true, templateId: true, templateRevision: true } });
        await prisma.documentBundleSendItem.update({
          where: { id: item.id },
          data: { status: 'CREATED', issuedDocumentId: r.issuedId, envelopeId: doc?.envelopeId ?? null, templateId: doc?.templateId ?? null, templateRevision: doc?.templateRevision ?? null, error: null },
        });
        item.status = 'CREATED';
        continue;
      }
      if (r.blocked === 'EDOC_BALANCE') {
        await prisma.documentBundleSendItem.update({ where: { id: item.id }, data: { status: 'BLOCKED', error: r.reason.slice(0, 300) } });
        return block('EDOC_BALANCE', r.reason);
      }
      if (!item.required) {
        await prisma.documentBundleSendItem.update({ where: { id: item.id }, data: { status: 'SKIPPED', error: r.reason.slice(0, 300) } });
        item.status = 'SKIPPED';
        continue;
      }
      await prisma.documentBundleSendItem.update({ where: { id: item.id }, data: { status: 'BLOCKED', error: r.reason.slice(0, 300) } });
      return block(r.blocked ?? 'SEND_FAILED', `${DOCUMENT_PURPOSE_LABEL[purpose]}: ${r.reason}`);
    }

    const created = send.items.filter((i) => i.status === 'CREATED');
    if (!created.length) return block('NO_TEMPLATE', '보낼 서명 문서가 없습니다.');
    return await sendBundleLink(send.id);
  } catch (e) {
    logger.error('문서 묶음 발송 실패', { sendId: send.id, message: (e as Error).message });
    return block('SEND_FAILED', '문서 묶음을 보내지 못했습니다. 잠시 후 다시 시도합니다.');
  }
}

/** 약정 흐름(internal 전자서명)이 만든 약정서 서명 요청. 열린 것·완료된 것만. */
async function agreementEnvelopeFor(merchantId: string, recurringId: string | null) {
  if (!recurringId) return null;
  const r = await prisma.recurringDonation.findFirst({ where: { id: recurringId, merchantId }, select: { agreementDocId: true } });
  if (!r?.agreementDocId) return null;
  const doc = await prisma.agreementDocument.findUnique({ where: { id: r.agreementDocId }, select: { esignProvider: true, esignRequestId: true } });
  if (!doc || doc.esignProvider !== 'internal' || !doc.esignRequestId) return null;
  const env_ = await prisma.eDocEnvelope.findFirst({ where: { id: doc.esignRequestId, merchantId, status: { in: ['SENT', 'IN_PROGRESS', 'COMPLETED'] } }, select: { id: true, templateId: true } });
  if (!env_) return null;
  const issued = await prisma.issuedDocument.findUnique({ where: { envelopeId: env_.id }, select: { id: true, templateRevision: true } });
  return { envelopeId: env_.id, issuedId: issued?.id ?? null, templateId: env_.templateId, templateRevision: issued?.templateRevision ?? null };
}

/** 묶음 링크(새 토큰 — 이전 링크 무효)를 만들어 후원자 번호로 보낸다. 문자 실패는 발송 상태를 SENT 로 두고 사유만 남긴다(재발송 가능). */
async function sendBundleLink(sendId: string, opts: { reminder?: boolean } = {}): Promise<SendBundleResult> {
  const send = await prisma.documentBundleSend.findUniqueOrThrow({ where: { id: sendId }, include: { bundle: true, items: true } });
  const [payer, merchant] = await Promise.all([
    prisma.payerProfile.findUnique({ where: { id: send.payerId }, select: { phoneEnc: true } }),
    prisma.merchantProfile.findUnique({ where: { id: send.merchantId }, select: { displayName: true } }),
  ]);
  const token = generateToken(32);
  const envs = await prisma.eDocEnvelope.findMany({ where: { id: { in: send.items.map((i) => i.envelopeId).filter(Boolean) as string[] } }, select: { expiresAt: true } });
  const due = envs.length ? new Date(Math.min(...envs.map((e) => e.expiresAt.getTime()))) : new Date();
  await prisma.documentBundleSend.update({
    where: { id: send.id },
    data: { tokenHash: tokenHash(token), status: 'SENT', sentAt: send.sentAt ?? new Date(), blocked: null, blockedReason: null },
  });
  let ok = false;
  try {
    const { tplEDocSignRequest } = await import('./mt-templates');
    const { sendMtDetailed } = await import('./charge-flow');
    const count = send.items.filter((i) => i.status === 'CREATED').length;
    const tpl = tplEDocSignRequest({
      merchantName: merchant?.displayName ?? '기관',
      title: `${send.bundle.name} (문서 ${count}건)`,
      link: bundleSignUrl(token),
      dueDate: formatKst(due, false).slice(0, 10),
      reminder: opts.reminder,
    });
    const r = await sendMtDetailed({ phone: decrypt(payer!.phoneEnc), template: tpl, merchantId: send.merchantId });
    ok = r.ok;
  } catch (e) {
    logger.warn('문서 묶음 링크 문자 실패', { sendId: send.id, message: (e as Error).message });
  }
  if (!ok) {
    await prisma.documentBundleSend.update({ where: { id: send.id }, data: { blocked: 'SEND_FAILED', blockedReason: '서명 링크 문자를 보내지 못했습니다. [링크 다시 보내기] 를 눌러 주세요.' } });
  }
  const devToken = isLocal && getMtAdapter().info().provider === 'mock' ? token : undefined;
  return { ok: true, sendId: send.id, status: 'SENT', devToken };
}

/** 담당자: 묶음 링크 다시 보내기(새 토큰). 하루 3번까지. */
export async function resendBundleLink(merchantId: string, sendId: string) {
  const send = await prisma.documentBundleSend.findFirst({ where: { id: sendId, merchantId } });
  if (!send) throw new BundleError('묶음 발송을 찾을 수 없습니다.');
  if (send.status !== 'SENT') throw new BundleError('서명을 기다리는 묶음만 다시 보낼 수 있습니다.');
  const n = await kv.incr(`bundle:resend:${sendId}`, 86_400);
  if (n > 3) throw new BundleError('링크는 하루 3번까지 다시 보낼 수 있습니다.');
  return sendBundleLink(sendId, { reminder: true });
}

// ---------------------------------------------------------------- 상태 (D4)

export type BundleItemState = 'SIGNED' | 'UNVIEWED' | 'VIEWED' | 'DECLINED' | 'INPUT_ERROR' | 'CLOSED' | 'SKIPPED' | 'WAITING';

export const BUNDLE_ITEM_STATE_LABEL: Record<BundleItemState, { text: string; tone: 'success' | 'neutral' | 'warning' | 'danger' | 'brand' }> = {
  SIGNED: { text: '서명 완료', tone: 'success' },
  UNVIEWED: { text: '미열람', tone: 'neutral' },
  VIEWED: { text: '열람 후 미서명', tone: 'warning' },
  DECLINED: { text: '거절', tone: 'danger' },
  INPUT_ERROR: { text: '입력 오류', tone: 'danger' },
  CLOSED: { text: '만료·취소', tone: 'neutral' },
  SKIPPED: { text: '건너뜀', tone: 'neutral' },
  WAITING: { text: '발송 대기', tone: 'brand' },
};

export interface BundleSendItemView {
  id: string;
  purpose: DocumentPurpose;
  label: string;
  required: boolean;
  state: BundleItemState;
  envelopeId: string | null;
  /** 보낸 서식 판이 지금 서식과 다르면 false(이전 판으로 보냄) */
  latest: boolean | null;
  error: string | null;
}

interface SignerLite { status: string; viewedAt: Date | null }
interface EnvelopeLite { id: string; status: string; signers: SignerLite[] }

export function itemState(item: { status: string; error: string | null }, env_: EnvelopeLite | null, sendStatus: string): BundleItemState {
  if (item.status === 'SKIPPED') return 'SKIPPED';
  if (item.status === 'BLOCKED') return sendStatus === 'BLOCKED' && /잔액/.test(item.error ?? '') ? 'WAITING' : 'INPUT_ERROR';
  if (item.status === 'PENDING' || !env_) return sendStatus === 'BLOCKED' ? 'INPUT_ERROR' : 'WAITING';
  const s = env_.signers[0];
  if (env_.status === 'COMPLETED' || s?.status === 'SIGNED') return 'SIGNED';
  if (env_.status === 'DECLINED' || s?.status === 'DECLINED') return 'DECLINED';
  if (env_.status === 'EXPIRED' || env_.status === 'CANCELLED') return 'CLOSED';
  if (s?.viewedAt || s?.status === 'VIEWED') return 'VIEWED';
  return 'UNVIEWED';
}

export interface BundleSendView {
  id: string;
  bundleName: string;
  payerId: string;
  payerLabel: string;
  status: string;
  blocked: string | null;
  blockedReason: string | null;
  createdAt: Date;
  sentAt: Date | null;
  items: BundleSendItemView[];
  /** 빠진(서명 안 된) 필수 문서 */
  missing: string[];
  counts: Record<BundleItemState, number>;
}

export async function listBundleSends(merchantId: string, opts: { bundleId?: string; take?: number } = {}): Promise<BundleSendView[]> {
  const sends = await prisma.documentBundleSend.findMany({
    where: { merchantId, ...(opts.bundleId ? { bundleId: opts.bundleId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: opts.take ?? 50,
    include: { items: { orderBy: { position: 'asc' } }, bundle: { select: { name: true } } },
  });
  const envIds = sends.flatMap((s) => s.items.map((i) => i.envelopeId)).filter(Boolean) as string[];
  const [envs, payers, templates] = await Promise.all([
    prisma.eDocEnvelope.findMany({ where: { id: { in: envIds } }, select: { id: true, status: true, signers: { orderBy: { order: 'asc' }, take: 1, select: { status: true, viewedAt: true } } } }),
    prisma.payerProfile.findMany({ where: { id: { in: [...new Set(sends.map((s) => s.payerId))] } }, select: { id: true, displayName: true, phoneMasked: true } }),
    prisma.documentTemplate.findMany({ where: { merchantId, archivedAt: null, purpose: { not: null } } }),
  ]);
  const envMap = new Map(envs.map((e) => [e.id, e]));
  const payerMap = new Map(payers.map((p) => [p.id, p]));
  const revByPurpose = new Map(templates.map((t) => [t.purpose!, templateRevision(t)]));
  return sends.map((s) => {
    const items: BundleSendItemView[] = s.items
      .filter((i) => isDocumentPurpose(i.purpose))
      .map((i) => {
        const purpose = i.purpose as DocumentPurpose;
        const cur = revByPurpose.get(purpose);
        return {
          id: i.id,
          purpose,
          label: DOCUMENT_PURPOSE_LABEL[purpose],
          required: i.required,
          state: itemState(i, i.envelopeId ? (envMap.get(i.envelopeId) ?? null) : null, s.status),
          envelopeId: i.envelopeId,
          latest: i.templateRevision && cur ? i.templateRevision === cur : null,
          error: i.error,
        };
      });
    const counts = Object.fromEntries(Object.keys(BUNDLE_ITEM_STATE_LABEL).map((k) => [k, 0])) as Record<BundleItemState, number>;
    for (const it of items) counts[it.state] += 1;
    const p = payerMap.get(s.payerId);
    return {
      id: s.id,
      bundleName: s.bundle.name,
      payerId: s.payerId,
      payerLabel: p ? (p.displayName ? `${p.displayName} (${p.phoneMasked})` : p.phoneMasked) : '후원자',
      status: s.status,
      blocked: s.blocked,
      blockedReason: s.blockedReason,
      createdAt: s.createdAt,
      sentAt: s.sentAt,
      items,
      missing: items.filter((i) => i.required && i.state !== 'SIGNED' && i.state !== 'SKIPPED').map((i) => i.label),
      counts,
    };
  });
}

// ---------------------------------------------------------------- 묶음 서명 화면 (공개, 토큰)

export interface BundleSessionItem {
  id: string;
  position: number;
  purpose: DocumentPurpose;
  label: string;
  required: boolean;
  envelopeId: string;
  signerId: string;
  state: BundleItemState;
  canSign: boolean;
}

export type BundleSession =
  | { ok: false; reason: string }
  | {
      ok: true;
      sendId: string;
      merchantId: string;
      merchantName: string;
      merchantCode: string;
      avatarUrl: string | null;
      bundleName: string;
      tokenHash: string;
      phoneMasked: string;
      items: BundleSessionItem[];
      /** 모든 필수 문서에 서명했는가 */
      done: boolean;
      /** 서명할 문서가 남지 않았고 끝나지도 않음(만료·거절) */
      closed: boolean;
    };

async function findSendByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token ?? '')) return null;
  return prisma.documentBundleSend.findUnique({ where: { tokenHash: tokenHash(token) }, include: { items: { orderBy: { position: 'asc' } }, bundle: { select: { name: true } } } });
}

export async function loadBundleSession(token: string): Promise<BundleSession> {
  const send = await findSendByToken(token);
  if (!send || (send.status !== 'SENT' && send.status !== 'COMPLETED' && send.status !== 'CLOSED')) {
    return { ok: false, reason: '유효하지 않은 서명 링크입니다. 가장 최근에 받은 문자의 링크를 열어 주세요.' };
  }
  const [merchant, payer] = await Promise.all([
    prisma.merchantProfile.findUnique({ where: { id: send.merchantId }, select: { displayName: true, code: true, avatarUrl: true, status: true } }),
    prisma.payerProfile.findUnique({ where: { id: send.payerId }, select: { phoneMasked: true, onboardingStatus: true } }),
  ]);
  if (!merchant || merchant.status !== 'APPROVED' || !payer || payer.onboardingStatus === 'WITHDRAWN') {
    return { ok: false, reason: '지금은 이 문서를 열 수 없습니다. 기관에 문의해 주세요.' };
  }
  const envIds = send.items.map((i) => i.envelopeId).filter(Boolean) as string[];
  const envs = await prisma.eDocEnvelope.findMany({
    where: { id: { in: envIds }, merchantId: send.merchantId },
    select: { id: true, status: true, expiresAt: true, signers: { orderBy: { order: 'asc' }, select: { id: true, status: true, viewedAt: true } } },
  });
  const envMap = new Map(envs.map((e) => [e.id, e]));
  const now = new Date();
  const items: BundleSessionItem[] = [];
  for (const i of send.items) {
    if (!isDocumentPurpose(i.purpose) || !i.envelopeId) continue;
    const e = envMap.get(i.envelopeId);
    if (!e || !e.signers[0]) continue;
    const state = itemState(i, e, send.status);
    const open = (e.status === 'SENT' || e.status === 'IN_PROGRESS') && e.expiresAt > now;
    items.push({
      id: i.id, position: i.position, purpose: i.purpose as DocumentPurpose, label: DOCUMENT_PURPOSE_LABEL[i.purpose as DocumentPurpose],
      required: i.required, envelopeId: e.id, signerId: e.signers[0].id, state,
      canSign: open && (e.signers[0].status === 'SENT' || e.signers[0].status === 'VIEWED'),
    });
  }
  const done = items.length > 0 && items.filter((i) => i.required).every((i) => i.state === 'SIGNED');
  const closed = !done && !items.some((i) => i.canSign);
  return {
    ok: true, sendId: send.id, merchantId: send.merchantId, merchantName: merchant.displayName, merchantCode: merchant.code, avatarUrl: merchant.avatarUrl,
    bundleName: send.bundle.name, tokenHash: send.tokenHash!, phoneMasked: payer.phoneMasked, items, done, closed,
  };
}

/** 묶음 본인확인 증표(발송·현재 토큰·만료에 묶임 — 링크를 다시 보내면 무효) */
export function bundleProof(sendId: string, currentTokenHash: string, expSec: number) {
  return `${expSec}.${hmac(`edoc-bundle:${sendId}:${currentTokenHash}:${expSec}`, env.crypto.sessionSecret)}`;
}

export function checkBundleProof(sendId: string, currentTokenHash: string, proof: string | null | undefined) {
  if (!proof) return false;
  const [exp, mac] = proof.split('.');
  const expSec = Number(exp);
  if (!Number.isFinite(expSec) || expSec * 1000 < Date.now() || !mac) return false;
  return safeEqual(bundleProof(sendId, currentTokenHash, expSec), proof);
}

export function bundleCookieName(sendId: string) {
  return `givesign_edoc_bundle_${sendId}`;
}

const otpKey = (sendId: string) => `edoc:bundle-otp:${sendId}`;
const otpTryKey = (sendId: string) => `edoc:bundle-otp-try:${sendId}`;
const digest = (code: string) => hmac(code, env.crypto.sessionSecret);

/** 본인확인 번호 보내기(묶음당 1번 — 문서마다 따로 받지 않는다). 감사기록은 열린 문서 봉투마다 남긴다. */
export async function requestBundleOtp(token: string, meta: { ip?: string; userAgent?: string } = {}) {
  const session = await loadBundleSession(token);
  if (!session.ok) throw new BundleError(session.reason);
  if (session.closed && !session.done) throw new BundleError('서명할 수 있는 문서가 남아 있지 않습니다(기한이 지났거나 거절됨).');
  const sent = await kv.incr(`edoc:bundle-otp-send:${session.sendId}`, OTP_SEND_WINDOW_SEC);
  if (sent > OTP_SEND_MAX) throw new BundleError('인증번호 요청이 너무 잦습니다. 30분 뒤 다시 시도해 주세요.');
  const send = await prisma.documentBundleSend.findUniqueOrThrow({ where: { id: session.sendId }, select: { payerId: true } });
  const payer = await prisma.payerProfile.findUniqueOrThrow({ where: { id: send.payerId }, select: { phoneEnc: true } });
  const code = generateNumericCode(6);
  const { applyMtTemplateOverride, tplEDocVerify } = await import('./mt-templates');
  const tpl = await applyMtTemplateOverride(tplEDocVerify(code));
  const adapter = getMtAdapter();
  const res = await adapter.send({ to: decrypt(payer.phoneEnc), text: tpl.text, templateCode: tpl.code });
  if (!res.ok) throw new BundleError('인증번호를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
  await kv.set(otpKey(session.sendId), digest(code), OTP_TTL_SEC);
  await kv.del(otpTryKey(session.sendId));
  const { appendEDocEvent } = await import('./edoc');
  for (const it of session.items.filter((i) => i.canSign)) {
    await prisma.$transaction((tx) =>
      appendEDocEvent(tx, it.envelopeId, { type: 'OTP_SENT', actor: `signer:${it.signerId}`, signerId: it.signerId, ip: meta.ip, userAgent: meta.userAgent, detail: { to: session.phoneMasked, bundleSendId: session.sendId } }),
    );
  }
  return { phoneMasked: session.phoneMasked, devCode: isLocal && adapter.info().provider === 'mock' ? code : undefined };
}

/** 본인확인 번호 확인 → 열린 문서 서명자 모두 본인확인·열람 처리(문서마다 감사기록) + 묶음 증표 */
export async function confirmBundleOtp(token: string, rawCode: string, meta: { ip?: string; userAgent?: string } = {}) {
  const session = await loadBundleSession(token);
  if (!session.ok) throw new BundleError(session.reason);
  const code = rawCode.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) throw new BundleError('인증번호 6자리를 입력해 주세요.');
  const saved = await kv.get(otpKey(session.sendId));
  if (!saved) throw new BundleError('인증 유효시간이 지났습니다. 인증번호를 다시 받아 주세요.');
  if (!safeEqual(digest(code), saved)) {
    const remain = await consumeAttempt(otpTryKey(session.sendId), OTP_MAX_ATTEMPTS, OTP_TTL_SEC);
    if (remain <= 0) {
      await kv.del(otpKey(session.sendId));
      throw new BundleError(`인증번호를 ${OTP_MAX_ATTEMPTS}회 잘못 입력했습니다. 인증번호를 다시 받아 주세요.`);
    }
    throw new BundleError(`인증번호가 일치하지 않습니다. (남은 시도 ${remain}회)`);
  }
  await kv.del(otpKey(session.sendId));
  await kv.del(otpTryKey(session.sendId));
  const now = new Date();
  const { appendEDocEvent } = await import('./edoc');
  for (const it of session.items.filter((i) => i.canSign)) {
    await prisma.$transaction(async (tx) => {
      const s = await tx.eDocSigner.findUniqueOrThrow({ where: { id: it.signerId }, select: { status: true, viewedAt: true } });
      await tx.eDocSigner.update({
        where: { id: it.signerId },
        data: { otpVerifiedAt: now, ...(s.viewedAt ? {} : { viewedAt: now }), ...(s.status === 'SENT' ? { status: 'VIEWED' } : {}) },
      });
      await appendEDocEvent(tx, it.envelopeId, { type: 'OTP_VERIFIED', actor: `signer:${it.signerId}`, signerId: it.signerId, ip: meta.ip, userAgent: meta.userAgent, detail: { bundleSendId: session.sendId } });
      if (!s.viewedAt) await appendEDocEvent(tx, it.envelopeId, { type: 'VIEWED', actor: `signer:${it.signerId}`, signerId: it.signerId, ip: meta.ip, userAgent: meta.userAgent });
    });
  }
  await prisma.documentBundleSend.update({ where: { id: session.sendId }, data: { otpVerifiedAt: now } });
  const exp = Math.floor(Date.now() / 1000) + BUNDLE_ACCESS_TTL_SEC;
  return { sendId: session.sendId, proof: bundleProof(session.sendId, session.tokenHash, exp), maxAge: BUNDLE_ACCESS_TTL_SEC };
}

/** 묶음 증표 → 문서(봉투) 서명자 증표. 서버 안에서만 만든다(서명 함수의 본인확인 검사를 그대로 통과시키기 위해). */
async function signerProofFor(signerId: string) {
  const { accessProof } = await import('./edoc');
  const s = await prisma.eDocSigner.findUniqueOrThrow({ where: { id: signerId }, select: { tokenHash: true } });
  return accessProof(signerId, s.tokenHash, Math.floor(Date.now() / 1000) + 300);
}

export interface SignBundleInput {
  token: string;
  proof: string | null | undefined;
  signature: string | null;
  /** 문서별 "내용을 확인했습니다"(항목 id → 체크). 선택 문서는 체크한 것만 서명한다. */
  agreed: Record<string, boolean>;
  /** 문서별 입력값(항목 id → { 항목 id → 값 }) */
  values: Record<string, Record<string, string>>;
  ip?: string;
  userAgent?: string;
}

/**
 * 한 화면에서 순서대로 서명. 필수 문서는 모두 확인 체크해야 하고(빠지면 아무것도 서명하지 않음), 서명 이미지는 한 번 그린 것을 문서마다 쓴다.
 * 문서마다 기존 signAsSigner(선점·봉투 잠금·해시 체인·완료 이벤트) — 한 문서가 실패해도 이미 서명한 문서는 그대로다.
 */
export async function signBundle(input: SignBundleInput) {
  const session = await loadBundleSession(input.token);
  if (!session.ok) throw new BundleError(session.reason);
  if (!checkBundleProof(session.sendId, session.tokenHash, input.proof)) throw new BundleError('본인확인이 만료되었습니다. 인증번호를 다시 받아 주세요.');
  const targets = session.items.filter((i) => i.canSign);
  if (!targets.length) throw new BundleError('서명할 문서가 남아 있지 않습니다.');
  const missingAgree = targets.filter((i) => i.required && !input.agreed[i.id]);
  if (missingAgree.length) throw new BundleError(`${missingAgree.map((i) => i.label).join(', ')} 내용을 확인했다는 항목에 체크해 주세요.`);
  if (!input.signature) throw new BundleError('서명란에 서명해 주세요.');
  // 입력값 검증을 먼저 모두 한다(앞 문서만 서명되고 뒤 문서 입력 오류로 멈추는 일을 줄인다).
  const { loadSignerById, signAsSigner, EDocError } = await import('./edoc');
  const { validateValues } = await import('./documents');
  for (const it of targets.filter((i) => input.agreed[i.id])) {
    const l = await loadSignerById(it.signerId);
    if (!l.ok) throw new BundleError(l.reason);
    if (l.isPrimary && l.snapshot.fields.length) {
      const v = validateValues(l.snapshot.fields, input.values[it.id] ?? {});
      if (!v.ok) throw new BundleError(`${it.label}: ${v.message}`);
    }
  }
  const results: Array<{ id: string; label: string; ok: boolean; message?: string }> = [];
  for (const it of targets) {
    if (!input.agreed[it.id]) {
      results.push({ id: it.id, label: it.label, ok: false, message: '선택 문서 — 서명하지 않음' });
      continue;
    }
    try {
      await signAsSigner({
        token: '', signerId: it.signerId, quietSigner: true, proof: await signerProofFor(it.signerId), values: input.values[it.id] ?? {},
        signature: input.signature, agreed: true, ip: input.ip, userAgent: input.userAgent,
      });
      results.push({ id: it.id, label: it.label, ok: true });
    } catch (e) {
      results.push({ id: it.id, label: it.label, ok: false, message: e instanceof EDocError || e instanceof BundleError ? e.message : '서명하지 못했습니다.' });
    }
  }
  await refreshBundleSend(session.sendId);
  return { results, signed: results.filter((r) => r.ok).length };
}

/** 묶음 전체 거절(사유) — 열린 문서마다 기존 declineAsSigner. */
export async function declineBundle(input: { token: string; proof: string | null | undefined; reason: string; ip?: string; userAgent?: string }) {
  const session = await loadBundleSession(input.token);
  if (!session.ok) throw new BundleError(session.reason);
  if (!checkBundleProof(session.sendId, session.tokenHash, input.proof)) throw new BundleError('본인확인이 만료되었습니다. 인증번호를 다시 받아 주세요.');
  const reason = input.reason.trim();
  if (!reason) throw new BundleError('거절 사유를 적어 주세요. 기관이 확인합니다.');
  const { declineAsSigner } = await import('./edoc');
  let n = 0;
  for (const it of session.items.filter((i) => i.canSign)) {
    await declineAsSigner({ token: '', signerId: it.signerId, proof: await signerProofFor(it.signerId), reason, ip: input.ip, userAgent: input.userAgent }).then(
      () => (n += 1),
      (e) => logger.warn('묶음 거절 중 한 문서 실패', { itemId: it.id, message: (e as Error).message }),
    );
  }
  await refreshBundleSend(session.sendId);
  return { declined: n };
}

/** 문서 상태로 묶음 상태를 맞춘다(SENT → COMPLETED/CLOSED, 조건부). */
export async function refreshBundleSend(sendId: string) {
  const send = await prisma.documentBundleSend.findUnique({ where: { id: sendId }, include: { items: true } });
  if (!send || send.status !== 'SENT') return;
  const envIds = send.items.map((i) => i.envelopeId).filter(Boolean) as string[];
  const envs = await prisma.eDocEnvelope.findMany({ where: { id: { in: envIds } }, select: { id: true, status: true, signers: { orderBy: { order: 'asc' }, take: 1, select: { status: true, viewedAt: true } } } });
  const map = new Map(envs.map((e) => [e.id, e]));
  const states = send.items.map((i) => ({ required: i.required, state: itemState(i, i.envelopeId ? (map.get(i.envelopeId) ?? null) : null, send.status) }));
  const required = states.filter((s) => s.required && s.state !== 'SKIPPED');
  if (required.length && required.every((s) => s.state === 'SIGNED')) {
    const done = await prisma.documentBundleSend.updateMany({ where: { id: sendId, status: 'SENT' }, data: { status: 'COMPLETED', completedAt: new Date() } });
    if (done.count === 1) await notifyBundleCompleted(sendId);
  } else if (required.some((s) => s.state === 'DECLINED' || s.state === 'CLOSED')) {
    await prisma.documentBundleSend.updateMany({ where: { id: sendId, status: 'SENT' }, data: { status: 'CLOSED' } });
  }
}

/** 묶음이 끝나면 후원자에게 완료 문자 1통(문서마다 보내지 않는다). 실패해도 상태는 그대로(사후 처리). */
async function notifyBundleCompleted(sendId: string) {
  try {
    const send = await prisma.documentBundleSend.findUniqueOrThrow({ where: { id: sendId }, include: { bundle: { select: { name: true } } } });
    const [payer, merchant] = await Promise.all([
      prisma.payerProfile.findUniqueOrThrow({ where: { id: send.payerId }, select: { phoneEnc: true } }),
      prisma.merchantProfile.findUniqueOrThrow({ where: { id: send.merchantId }, select: { displayName: true } }),
    ]);
    const { tplEDocCompleted } = await import('./mt-templates');
    const { sendMtDetailed } = await import('./charge-flow');
    await sendMtDetailed({ phone: decrypt(payer.phoneEnc), template: tplEDocCompleted({ merchantName: merchant.displayName, title: send.bundle.name }), merchantId: send.merchantId });
  } catch (e) {
    logger.warn('문서 묶음 완료 안내 실패', { sendId, message: (e as Error).message });
  }
}

/** 봉투가 끝났을 때(document.signed / document.closed) 그 봉투가 든 묶음 상태를 맞춘다 — 소비자 bundle-status. */
export async function refreshBundlesForEnvelope(envelopeId: string) {
  const items = await prisma.documentBundleSendItem.findMany({ where: { envelopeId }, select: { sendId: true } });
  for (const s of new Set(items.map((i) => i.sendId))) await refreshBundleSend(s);
  return items.length ? undefined : ('SKIPPED' as const);
}

// ---------------------------------------------------------------- 정기후원 약정 → 묶음 (기관 설정이 켜졌을 때만)

/** recurring.pledged 소비자. 기관이 정기후원 신청 묶음을 약정에 쓰도록 켰을 때만 보낸다(기본 꺼짐 — 기존 흐름 그대로). */
export async function handleRecurringPledgedBundle(ev: { merchantId: string; subjectId: string; payerId: string | null }) {
  const bundle = await prisma.documentBundle.findFirst({ where: { merchantId: ev.merchantId, useForRecurring: true, archivedAt: null } });
  if (!bundle || !ev.payerId) return 'SKIPPED' as const;
  const r = await prisma.recurringDonation.findFirst({
    where: { id: ev.subjectId, merchantId: ev.merchantId },
    select: { id: true, amount: true, dayOfMonth: true, status: true, campaign: { select: { title: true } } },
  });
  if (!r || r.status === 'CANCELED') return 'SKIPPED' as const;
  const res = await sendBundle({
    merchantId: ev.merchantId,
    bundleId: bundle.id,
    payerId: ev.payerId,
    context: { amount: r.amount, dayOfMonth: r.dayOfMonth, campaignTitle: r.campaign?.title ?? null, recurringId: r.id },
    dedupeKey: `bundle:recurring:${r.id}`,
    subject: { type: 'recurring_donation', id: r.id },
  });
  // 잔액 부족·점검 막힘은 발송 행에 남고(승인 대기함·이용요금 화면), 재시도는 충전 이벤트 소비자가 한다 — 이 소비자는 실패로 보지 않는다.
  if (!res.ok && res.status === 'PREPARING') throw new Error(res.reason);
  return undefined;
}

// ---------------------------------------------------------------- 잔액 부족으로 멈춘 일 (J3)

export interface BalanceBlockedItem {
  kind: 'JOURNEY' | 'BUNDLE';
  id: string;
  label: string;
  /** 필요한 문서 건수 */
  units: number;
  since: Date;
}

/** 잔액 부족으로 멈춘 서명 문서 발송(오래된 순) — 저니 문서 단계 + 문서 묶음. 충전되면 이 순서로 다시 보낸다. */
export async function balanceBlockedQueue(merchantId: string): Promise<BalanceBlockedItem[]> {
  const [logs, sends] = await Promise.all([
    prisma.journeyStepLog.findMany({
      where: { merchantId, outcome: 'BLOCKED', detail: { startsWith: '전자문서 이용 잔액 부족' } },
      select: { runId: true, stepIndex: true, stepKey: true, at: true },
      orderBy: { at: 'asc' },
      take: 2000,
    }),
    prisma.documentBundleSend.findMany({
      where: { merchantId, status: 'BLOCKED', blocked: 'EDOC_BALANCE' },
      include: { items: true, bundle: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
      take: 500,
    }),
  ]);
  const runIds = [...new Set(logs.map((l) => l.runId))];
  const runs = runIds.length
    ? await prisma.journeyRun.findMany({ where: { id: { in: runIds }, status: 'WAITING' }, select: { id: true, stepIndex: true, journeyKey: true } })
    : [];
  const out: BalanceBlockedItem[] = [];
  for (const run of runs) {
    const first = logs.find((l) => l.runId === run.id && l.stepIndex === run.stepIndex);
    if (!first) continue;
    out.push({ kind: 'JOURNEY', id: run.id, label: `자동 안내 문서(${first.stepKey})`, units: 1, since: first.at });
  }
  for (const s of sends) {
    const units = s.items.filter((i) => i.status === 'PENDING' || i.status === 'BLOCKED').length;
    out.push({ kind: 'BUNDLE', id: s.id, label: `${s.bundle.name}`, units: Math.max(1, units), since: s.createdAt });
  }
  return out.sort((a, b) => a.since.getTime() - b.since.getTime());
}

/**
 * 충전 승인(edoc.balance_added) 소비자 — 멈춘 발송을 오래된 것부터 **지금 보낼 수 있는 건수만큼** 다시 시도한다.
 * 저니는 기다림을 지금으로 당기기만 한다(같은 발송 키 — 저니 배치가 보낸다), 묶음은 이어서 보낸다(문서별 발송 키).
 * 그래서 몇 번 불려도 같은 문서가 두 번 나가지 않는다.
 */
export async function retryBalanceBlocked(merchantId: string, now = new Date()) {
  const queue = await balanceBlockedQueue(merchantId);
  if (!queue.length) return { journeys: 0, bundles: 0 };
  const { walletOverview } = await import('./edoc-billing');
  const w = await walletOverview(merchantId);
  let room = w.sendable;
  let journeys = 0;
  let bundles = 0;
  for (const item of queue) {
    if (item.units > room) break;
    if (item.kind === 'JOURNEY') {
      const r = await prisma.journeyRun.updateMany({ where: { id: item.id, status: 'WAITING', dueAt: { gt: now } }, data: { dueAt: now } });
      if (r.count) journeys += 1;
      room -= item.units;
    } else {
      const r = await continueBundleSend(item.id);
      if (r.ok) {
        bundles += 1;
        room -= item.units;
      } else if (r.status === 'BLOCKED') break;
    }
  }
  return { journeys, bundles };
}

/** 승인 대기함 묶음 — 멈춘 문서 묶음 발송. 없으면 null. */
export async function bundlesInboxGroup(merchantId: string, now: Date) {
  const rows = await prisma.documentBundleSend.findMany({
    where: { merchantId, status: 'BLOCKED' },
    select: { blocked: true, createdAt: true, items: { select: { status: true } } },
    orderBy: { createdAt: 'asc' },
    take: 1000,
  });
  if (!rows.length) return null;
  const balance = rows.filter((r) => r.blocked === 'EDOC_BALANCE');
  const other = rows.length - balance.length;
  const units = balance.reduce((a, r) => a + r.items.filter((i) => i.status === 'PENDING' || i.status === 'BLOCKED').length, 0);
  const { walletOverview } = await import('./edoc-billing');
  const w = await walletOverview(merchantId);
  const short = Math.max(0, units - w.sendable);
  return {
    kind: 'DOCUMENT_BUNDLE_BLOCKED',
    title: '멈춘 문서 묶음 발송',
    reason: `보내지 못한 묶음 ${rows.length}건${balance.length ? ` · 잔액 부족 ${balance.length}건(문서 ${units}건)` : ''}${other ? ` · 서식·정보 확인 필요 ${other}건` : ''}`,
    affectedCount: rows.length,
    amount: BigInt(short * w.plan.perDocument),
    oldestAt: rows[0]?.createdAt ?? now,
    href: '/studio/agreements/bundles',
    recommendedAction: short
      ? `전자문서 이용요금을 ${(short * w.plan.perDocument).toLocaleString('ko-KR')}원 이상 충전하세요. 충전이 승인되면 오래된 것부터 자동으로 이어서 보냅니다.`
      : other
        ? '서식이나 후원자 정보를 고친 뒤 묶음 화면에서 다시 보내세요.'
        : '충전 승인 뒤 자동으로 이어서 보냅니다.',
    actions: [],
    severity: short ? ('high' as const) : ('normal' as const),
  };
}
