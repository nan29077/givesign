import { createHash } from 'node:crypto';
import { prisma } from '@/server/db';
import { kv, consumeAttempt } from '@/server/redis';
import { newId } from '@/lib/id';
import { env, isLocal } from '@/lib/env';
import { logger } from '@/lib/logger';
import { addDays, formatKst } from '@/lib/datetime';
import {
  decrypt, encrypt, generateNumericCode, generateToken, hmac, maskName, maskPhone, normalizePhone, phoneHash, safeEqual, tokenHash,
} from '@/lib/crypto';
import { getMtAdapter } from '@/server/adapters/mt';
import { sendMtDetailed } from '@/server/services/charge-flow';
import { applyMtTemplateOverride, tplEDocCompleted, tplEDocSignRequest, tplEDocVerify } from '@/server/services/mt-templates';
import { notifyUser } from '@/server/services/notifications';
import { parseDocumentFields, storeSignature, validateValues, type DocumentField } from '@/server/services/documents';
import { debitForEnvelope, maybeNotifyLowBalance, refundEnvelope } from '@/server/services/edoc-billing';
import type { Prisma } from '@/generated/prisma/client';
import type { EDocEnvelopeStatus, EDocSignerRole, EDocSignerStatus, EDocSigningOrder } from '@/generated/prisma/enums';
import type { Tone } from '@/lib/labels';

/**
 * 전자문서 서명 요청 (기관 → 후원자·봉사자·이용자·보호자).
 *
 * 흐름
 *  1. 기관이 서식을 골라 서명자(최대 5명)를 지정해 보낸다. 발송 시점 서식을 암호화 스냅샷으로 묶어 두므로
 *     나중에 서식을 고쳐도 이미 보낸 문서는 바뀌지 않는다. 같은 트랜잭션에서 이용료 1건을 차감한다.
 *  2. 서명자는 문자로 받은 링크(/sign/<토큰>)를 열고, 받은 번호로 인증번호를 확인한 뒤 내용을 본다.
 *  3. 첫 번째 서명자가 입력 항목을 채우고 서명한다. 다른 서명자는 채운 내용을 확인하고 서명한다.
 *     순차 서명이면 앞사람이 서명한 뒤에 다음 사람에게 링크가 간다.
 *  4. 모두 서명하면 완료(COMPLETED). 완료본 해시를 남기고 서명자 전원에게 완료 문자를 보낸다.
 *
 * 증적
 *  - 모든 사건(발송·열람·인증·서명·거절·취소·만료)은 edoc_event 에 append-only 로 쌓이고,
 *    각 행은 직전 행의 해시를 이어 붙인 해시를 가진다. `verifyEnvelopeChain` 이 처음부터 다시 계산해 위변조를 찾는다.
 *  - 기브싸인 내부 감사기록이다. 공인전자문서중계자·공동인증서·TSA(시점확인) 연동은 하지 않았고 화면에도 그렇게 적는다.
 *
 * 개인정보
 *  - 서명자 이름·번호는 암호화 + 해시 + 마스킹, 입력값은 암호화. 목록에는 마스킹 값만 보이고
 *    기관 담당자가 입력값을 열람하면 감사로그를 남긴다(호출부).
 *  - 서명 링크 토큰은 해시만 저장한다. 재발송할 때마다 새 토큰을 만들고 이전 링크는 무효가 된다.
 */

export class EDocError extends Error {}

export const EDOC_MAX_SIGNERS = 5;
export const EDOC_EXPIRE_DAYS_DEFAULT = 14;
export const EDOC_EXPIRE_DAYS_MAX = 30;
export const EDOC_REMIND_MAX = 5;
const REMIND_GAP_MS = 60 * 60 * 1000;
const OTP_TTL_SEC = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_SEND_MAX = 5;
const OTP_SEND_WINDOW_SEC = 1800;
/** 인증을 마친 뒤 다시 인증하지 않고 문서를 볼 수 있는 시간 */
export const EDOC_ACCESS_TTL_SEC = 30 * 60;

export const edocRoleLabel: Record<EDocSignerRole, string> = {
  DONOR: '후원자',
  GUARDIAN: '보호자(법정대리인)',
  VOLUNTEER: '자원봉사자',
  PARTICIPANT: '이용자',
  STAFF: '기관 담당자',
  OTHER: '기타',
};

export const edocEnvelopeStatusLabel: Record<EDocEnvelopeStatus, { text: string; tone: Tone }> = {
  SENT: { text: '서명 대기', tone: 'warning' },
  IN_PROGRESS: { text: '서명 진행 중', tone: 'brand' },
  COMPLETED: { text: '서명 완료', tone: 'success' },
  DECLINED: { text: '서명 거절', tone: 'danger' },
  EXPIRED: { text: '기한 만료', tone: 'neutral' },
  CANCELLED: { text: '발송 취소', tone: 'neutral' },
};

export const edocSignerStatusLabel: Record<EDocSignerStatus, { text: string; tone: Tone }> = {
  WAITING: { text: '순서 대기', tone: 'neutral' },
  SENT: { text: '발송', tone: 'warning' },
  VIEWED: { text: '열람', tone: 'brand' },
  SIGNED: { text: '서명', tone: 'success' },
  DECLINED: { text: '거절', tone: 'danger' },
};

export const edocEventLabel: Record<string, string> = {
  CREATED: '서명 요청 생성',
  SENT: '서명 링크 발송',
  SEND_FAILED: '문자 발송 실패',
  REMINDED: '재안내 발송',
  OTP_SENT: '인증번호 발송',
  OTP_VERIFIED: '본인확인 완료',
  VIEWED: '문서 열람',
  SIGNED: '서명',
  DECLINED: '서명 거절',
  COMPLETED: '서명 완료',
  CANCELLED: '발송 취소',
  EXPIRED: '기한 만료',
  VALUES_VIEWED: '기관 담당자 입력값 열람',
  CERTIFICATE_VIEWED: '완료 확인서 열람',
};

const OPEN_STATUSES: EDocEnvelopeStatus[] = ['SENT', 'IN_PROGRESS'];

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------- 스냅샷

export interface EDocSnapshot {
  templateId: string;
  name: string;
  description: string | null;
  templateType: string;
  body: string | null;
  fields: DocumentField[];
  fileUrl: string | null;
  fileName: string | null;
  requireSignature: boolean;
}

export function readSnapshot(enc: string): EDocSnapshot {
  const raw = JSON.parse(decrypt(enc)) as EDocSnapshot;
  return { ...raw, fields: parseDocumentFields(raw.fields) };
}

function readJsonEnc(enc: string | null): Record<string, string> {
  if (!enc) return {};
  try {
    const v = JSON.parse(decrypt(enc)) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x ?? '')]));
  } catch (e) {
    logger.error('전자문서 값 복호화 실패', { message: (e as Error).message });
    return {};
  }
}

export const readPrefill = readJsonEnc;
export const readSignerValues = readJsonEnc;

// ---------------------------------------------------------------- 감사추적 해시 체인

/** 키 순서와 무관하게 같은 문자열을 만든다(jsonb 는 키 순서를 바꾼다). */
function stableJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const genesis = (envelopeId: string) => sha(`givesign:edoc:genesis:${envelopeId}`);

function eventHash(e: { prevHash: string; id: string; envelopeId: string; signerId: string | null; type: string; actor: string; createdAt: Date; detail: unknown }) {
  return sha([e.prevHash, e.id, e.envelopeId, e.signerId ?? '', e.type, e.actor, e.createdAt.toISOString(), stableJson(e.detail ?? null)].join('|'));
}

export async function appendEvent(
  tx: Tx,
  envelopeId: string,
  ev: { type: string; actor: string; signerId?: string | null; ip?: string | null; userAgent?: string | null; detail?: Record<string, unknown> | null },
) {
  const rows = await tx.$queryRaw<Array<{ last_event_hash: string | null }>>`SELECT last_event_hash FROM edoc_envelope WHERE id = ${envelopeId} FOR UPDATE`;
  const prevHash = rows[0]?.last_event_hash ?? genesis(envelopeId);
  const id = newId();
  const createdAt = new Date();
  const detail = ev.detail ?? null;
  const hash = eventHash({ prevHash, id, envelopeId, signerId: ev.signerId ?? null, type: ev.type, actor: ev.actor, createdAt, detail });
  await tx.eDocEvent.create({
    data: {
      id,
      envelopeId,
      signerId: ev.signerId ?? null,
      type: ev.type,
      actor: ev.actor,
      ip: ev.ip ?? null,
      userAgent: ev.userAgent?.slice(0, 300) ?? null,
      detail: (detail ?? undefined) as Prisma.InputJsonValue | undefined,
      prevHash,
      hash,
      createdAt,
    },
  });
  await tx.eDocEnvelope.update({ where: { id: envelopeId }, data: { lastEventHash: hash } });
  return hash;
}

/** 사건 기록을 처음부터 다시 계산해 봉투의 끝값과 맞는지 본다. */
export async function verifyEnvelopeChain(envelopeId: string) {
  const [env_, events] = await Promise.all([
    prisma.eDocEnvelope.findUnique({ where: { id: envelopeId }, select: { lastEventHash: true } }),
    prisma.eDocEvent.findMany({ where: { envelopeId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  ]);
  if (!env_) return { ok: false, count: 0, brokenAt: null as string | null };
  // 같은 밀리초에 쌓인 행이 있어도 prevHash 연결로 순서를 복원한다.
  const byPrev = new Map(events.map((e) => [e.prevHash, e]));
  let prev = genesis(envelopeId);
  let count = 0;
  while (byPrev.has(prev)) {
    const e = byPrev.get(prev)!;
    const expect = eventHash({ prevHash: e.prevHash, id: e.id, envelopeId, signerId: e.signerId, type: e.type, actor: e.actor, createdAt: e.createdAt, detail: e.detail });
    if (expect !== e.hash) return { ok: false, count, brokenAt: e.id };
    prev = e.hash;
    count += 1;
  }
  const ok = count === events.length && prev === (env_.lastEventHash ?? genesis(envelopeId));
  return { ok, count, brokenAt: ok ? null : (events.find((e) => e.prevHash === prev)?.id ?? 'tail') };
}

// ---------------------------------------------------------------- 발송

export function signUrl(token: string) {
  return `${env.baseUrl}/sign/${token}`;
}

/** 서명자에게 새 링크를 만들어 보낸다(이전 링크는 무효). 문자 실패는 봉투 상태를 바꾸지 않는다(사후 처리). */
async function issueAndSend(signerId: string, opts: { actor: string; reminder?: boolean }) {
  const signer = await prisma.eDocSigner.findUniqueOrThrow({
    where: { id: signerId },
    include: { envelope: { include: { merchant: { select: { id: true, displayName: true } } } } },
  });
  const token = generateToken(32);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.eDocSigner.update({
      where: { id: signerId },
      data: {
        tokenHash: tokenHash(token),
        sentAt: signer.sentAt ?? now,
        status: signer.status === 'WAITING' ? 'SENT' : signer.status,
        ...(opts.reminder ? { remindCount: { increment: 1 }, lastRemindedAt: now } : {}),
      },
    });
  });
  const phone = decrypt(signer.phoneEnc);
  const tpl = tplEDocSignRequest({
    merchantName: signer.envelope.merchant.displayName,
    title: signer.envelope.title,
    link: signUrl(token),
    dueDate: formatKst(signer.envelope.expiresAt, false).slice(0, 10),
    reminder: opts.reminder,
  });
  let ok = false;
  let mtId: string | null = null;
  try {
    const sent = await sendMtDetailed({ phone, template: tpl, merchantId: signer.envelope.merchantId });
    ok = sent.ok;
    mtId = sent.id;
  } catch (e) {
    logger.error('전자문서 서명 요청 문자 실패', { signerId, message: (e as Error).message });
  }
  await prisma.$transaction((tx) =>
    appendEvent(tx, signer.envelopeId, {
      type: ok ? (opts.reminder ? 'REMINDED' : 'SENT') : 'SEND_FAILED',
      actor: opts.actor,
      signerId,
      detail: { to: signer.phoneMasked, mtId },
    }),
  );
  return { ok, token: isLocal && getMtAdapter().info().provider === 'mock' ? token : undefined };
}

export interface CreateEnvelopeInput {
  merchantId: string;
  actorId: string;
  /** 화면을 열 때 만든 ULID. 봉투 id 로 써서 두 번 눌러도 한 번만 만들고 한 번만 차감한다. */
  nonce: string;
  templateId: string;
  title?: string | null;
  message?: string | null;
  signingOrder: EDocSigningOrder;
  expiresDays?: number;
  signers: Array<{ name: string; phone: string; role: EDocSignerRole }>;
  prefill?: Record<string, string>;
  batchId?: string | null;
}

/** 서명자 입력 검증(화면·CSV 공용) */
export function normalizeSigners(list: CreateEnvelopeInput['signers']) {
  const out: Array<{ name: string; phone: string; role: EDocSignerRole }> = [];
  for (const [i, s] of list.entries()) {
    const name = s.name.trim();
    const phone = normalizePhone(s.phone);
    if (!name && !s.phone.trim()) continue;
    if (!name || name.length > 30) throw new EDocError(`${i + 1}번째 서명자 이름을 확인해 주세요.`);
    if (!/^01\d{8,9}$/.test(phone)) throw new EDocError(`${i + 1}번째 서명자 휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)`);
    out.push({ name, phone, role: s.role in edocRoleLabel ? s.role : 'OTHER' });
  }
  if (!out.length) throw new EDocError('서명자를 1명 이상 입력해 주세요.');
  if (out.length > EDOC_MAX_SIGNERS) throw new EDocError(`서명자는 최대 ${EDOC_MAX_SIGNERS}명입니다.`);
  return out;
}

/**
 * 서명 요청 만들기 + 이용료 차감 + 첫 발송.
 * 봉투·서명자·차감·생성 사건은 한 트랜잭션이다(차감만 되고 문서가 없거나, 문서만 있고 차감이 없는 상태가 없다).
 * 문자 발송은 그 뒤 사후 처리이며 실패해도 봉투는 유지된다(재발송 가능).
 */
export async function createEnvelope(input: CreateEnvelopeInput) {
  if (!/^[0-9A-Z]{26}$/.test(input.nonce)) throw new EDocError('화면을 새로 열고 다시 시도해 주세요.');
  const existing = await prisma.eDocEnvelope.findUnique({ where: { id: input.nonce }, select: { id: true, merchantId: true } });
  if (existing) {
    if (existing.merchantId !== input.merchantId) throw new EDocError('화면을 새로 열고 다시 시도해 주세요.');
    return { envelopeId: existing.id, duplicated: true, sent: 0, failed: 0, devTokens: [] as string[] };
  }
  const signers = normalizeSigners(input.signers);
  const template = await prisma.documentTemplate.findFirst({ where: { id: input.templateId, merchantId: input.merchantId, active: true, archivedAt: null } });
  if (!template) throw new EDocError('사용할 수 있는 기관 서식을 골라 주세요.');
  const days = Math.min(EDOC_EXPIRE_DAYS_MAX, Math.max(1, Math.floor(input.expiresDays ?? EDOC_EXPIRE_DAYS_DEFAULT)));
  const snapshot: EDocSnapshot = {
    templateId: template.id,
    name: template.name,
    description: template.description,
    templateType: template.templateType,
    body: template.body,
    fields: parseDocumentFields(template.fields),
    fileUrl: template.fileUrl,
    fileName: template.fileName,
    requireSignature: true,
  };
  const snapshotJson = JSON.stringify(snapshot);
  // 첫 서명자 이름·연락처는 같은 이름의 항목에 미리 채운다(서명자가 고칠 수 있다).
  const prefill: Record<string, string> = { ...(input.prefill ?? {}) };
  const ids = new Set(snapshot.fields.map((f) => f.id));
  if (ids.has('name') && !prefill.name) prefill.name = signers[0]!.name;
  if (ids.has('phone') && !prefill.phone) prefill.phone = signers[0]!.phone.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
  for (const k of Object.keys(prefill)) if (!ids.has(k)) delete prefill[k];

  const title = (input.title?.trim() || template.name).slice(0, 60);
  const sequential = input.signingOrder === 'SEQUENTIAL' && signers.length > 1;
  const envelopeId = input.nonce;
  let charge: Awaited<ReturnType<typeof debitForEnvelope>>;
  try {
    charge = await prisma.$transaction(async (tx) => {
      await tx.eDocEnvelope.create({
        data: {
          id: envelopeId,
          merchantId: input.merchantId,
          templateId: template.id,
          title,
          snapshotEnc: encrypt(snapshotJson),
          snapshotHash: sha(snapshotJson),
          prefillEnc: Object.keys(prefill).length ? encrypt(JSON.stringify(prefill)) : null,
          signingOrder: sequential ? 'SEQUENTIAL' : 'PARALLEL',
          message: input.message?.trim().slice(0, 300) || null,
          batchId: input.batchId ?? null,
          createdBy: input.actorId,
          expiresAt: addDays(new Date(), days),
        },
      });
      await tx.eDocSigner.createMany({
        data: signers.map((s, i) => ({
          id: newId(),
          envelopeId,
          order: i + 1,
          role: s.role,
          nameEnc: encrypt(s.name),
          nameMasked: maskName(s.name),
          phoneEnc: encrypt(s.phone),
          phoneHash: phoneHash(s.phone),
          phoneMasked: maskPhone(s.phone),
          // 아직 링크를 보내지 않았다. 보낼 때 새 토큰으로 바꾼다.
          tokenHash: tokenHash(generateToken(32)),
          status: sequential && i > 0 ? 'WAITING' : 'SENT',
        })),
      });
      const debit = await debitForEnvelope(tx, { merchantId: input.merchantId, envelopeId, actorId: input.actorId });
      await tx.eDocEnvelope.update({ where: { id: envelopeId }, data: { chargeSource: debit.source } });
      await appendEvent(tx, envelopeId, {
        type: 'CREATED',
        actor: `staff:${input.actorId}`,
        detail: { templateId: template.id, snapshotHash: sha(snapshotJson), signers: signers.length, order: sequential ? 'SEQUENTIAL' : 'PARALLEL', charge: debit.source, amount: debit.amount },
      });
      return debit;
    });
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') return { envelopeId, duplicated: true, sent: 0, failed: 0, devTokens: [] as string[] };
    throw e;
  }

  const first = await prisma.eDocSigner.findMany({ where: { envelopeId, status: 'SENT' }, orderBy: { order: 'asc' }, select: { id: true } });
  let sent = 0;
  let failed = 0;
  const devTokens: string[] = [];
  for (const s of first) {
    const r = await issueAndSend(s.id, { actor: 'system' });
    if (r.ok) sent += 1;
    else failed += 1;
    if (r.token) devTokens.push(r.token);
  }
  if (charge.source === 'PREPAID') await maybeNotifyLowBalance(input.merchantId);
  return { envelopeId, duplicated: false, sent, failed, devTokens, charge };
}

/** 대량 발송(서명자 1명짜리). 한 줄씩 따로 만들고, 잔액이 떨어지면 거기서 멈춘다. */
export async function createBulkEnvelopes(input: {
  merchantId: string;
  actorId: string;
  templateId: string;
  title?: string | null;
  message?: string | null;
  expiresDays?: number;
  role: EDocSignerRole;
  rows: Array<{ name: string; phone: string }>;
  batchNonce: string;
}) {
  if (!/^[0-9A-Z]{26}$/.test(input.batchNonce)) throw new EDocError('화면을 새로 열고 다시 시도해 주세요.');
  if (!input.rows.length) throw new EDocError('받는 사람을 한 줄에 한 명씩 입력해 주세요. (이름, 휴대폰)');
  if (input.rows.length > 200) throw new EDocError('한 번에 200명까지 보낼 수 있습니다.');
  const results: Array<{ line: number; ok: boolean; message: string; envelopeId?: string }> = [];
  let stopped = false;
  for (const [i, row] of input.rows.entries()) {
    if (stopped) {
      results.push({ line: i + 1, ok: false, message: '잔액 부족으로 보내지 않음' });
      continue;
    }
    // 줄마다 결정적인 id 를 만든다: 같은 묶음을 다시 제출해도 같은 줄은 다시 만들지 않는다.
    const nonce = sha(`${input.batchNonce}:${i}`).slice(0, 26).toUpperCase().replace(/[^0-9A-Z]/g, '0');
    try {
      const r = await createEnvelope({
        merchantId: input.merchantId,
        actorId: input.actorId,
        nonce,
        templateId: input.templateId,
        title: input.title,
        message: input.message,
        signingOrder: 'PARALLEL',
        expiresDays: input.expiresDays,
        signers: [{ name: row.name, phone: row.phone, role: input.role }],
        batchId: input.batchNonce,
      });
      results.push({ line: i + 1, ok: true, message: r.duplicated ? '이미 보낸 줄' : r.failed ? '생성(문자 실패 — 재발송 필요)' : '발송', envelopeId: r.envelopeId });
    } catch (e) {
      const msg = e instanceof Error && /[가-힣]/.test(e.message) ? e.message : '처리하지 못했습니다.';
      results.push({ line: i + 1, ok: false, message: msg });
      if (/잔액이 부족/.test(msg)) stopped = true;
    }
  }
  return { results, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/** "이름, 휴대폰" 줄 목록을 읽는다(쉼표·탭 구분, 머리글 줄은 건너뜀). */
export function parseRecipientLines(text: string) {
  const rows: Array<{ name: string; phone: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [name = '', phone = ''] = line.split(/[,\t]/).map((s) => s.trim().replace(/^"|"$/g, ''));
    if (/^(이름|성명|name)$/i.test(name)) continue;
    rows.push({ name, phone });
  }
  return rows;
}

// ---------------------------------------------------------------- 기관 조작

async function loadOwned(merchantId: string, envelopeId: string) {
  const e = await prisma.eDocEnvelope.findFirst({ where: { id: envelopeId, merchantId }, include: { signers: { orderBy: { order: 'asc' } } } });
  if (!e) throw new EDocError('서명 요청을 찾을 수 없습니다.');
  return e;
}

/**
 * 발송 취소. 진행 중인 봉투만 취소한다.
 * 아무 서명자도 문서를 열기 전(본인확인 전)이면 차감한 이용료를 되돌린다. 이미 열었다면 되돌리지 않는다.
 */
export async function cancelEnvelope(input: { merchantId: string; envelopeId: string; actorId: string; reason: string }) {
  const reason = input.reason.trim().slice(0, 200);
  if (!reason) throw new EDocError('취소 사유를 입력해 주세요.');
  const e = await loadOwned(input.merchantId, input.envelopeId);
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.eDocEnvelope.updateMany({
      where: { id: e.id, status: { in: OPEN_STATUSES } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
    });
    if (claimed.count !== 1) throw new EDocError('진행 중인 서명 요청만 취소할 수 있습니다.');
    const signers = await tx.eDocSigner.findMany({ where: { envelopeId: e.id }, select: { viewedAt: true, otpVerifiedAt: true } });
    const untouched = signers.every((s) => !s.viewedAt && !s.otpVerifiedAt);
    const refund = untouched ? await refundEnvelope(tx, { merchantId: input.merchantId, envelopeId: e.id, actorId: input.actorId }) : { refunded: false as const };
    await appendEvent(tx, e.id, { type: 'CANCELLED', actor: `staff:${input.actorId}`, detail: { reason, refunded: refund.refunded } });
    return { refunded: refund.refunded };
  });
}

/** 재안내. 서명 전 서명자에게 새 링크를 보낸다. 1시간 간격, 최대 5회. */
export async function remindSigner(input: { merchantId: string; envelopeId: string; signerId: string; actorId: string }) {
  const e = await loadOwned(input.merchantId, input.envelopeId);
  if (!OPEN_STATUSES.includes(e.status)) throw new EDocError('진행 중인 서명 요청만 다시 보낼 수 있습니다.');
  if (e.expiresAt <= new Date()) throw new EDocError('서명 기한이 지났습니다.');
  const s = e.signers.find((x) => x.id === input.signerId);
  if (!s || (s.status !== 'SENT' && s.status !== 'VIEWED')) throw new EDocError('서명을 기다리는 서명자에게만 다시 보낼 수 있습니다.');
  if (s.remindCount >= EDOC_REMIND_MAX) throw new EDocError(`재안내는 최대 ${EDOC_REMIND_MAX}회까지 보낼 수 있습니다.`);
  if (s.lastRemindedAt && Date.now() - s.lastRemindedAt.getTime() < REMIND_GAP_MS) throw new EDocError('재안내는 1시간에 한 번 보낼 수 있습니다.');
  return issueAndSend(s.id, { actor: `staff:${input.actorId}`, reminder: true });
}

/** 기한이 지난 진행 중 봉투를 만료로 바꾼다(배치). 이미 보낸 문서라 이용료는 되돌리지 않는다. */
export async function expireEDocEnvelopes(now = new Date()) {
  const due = await prisma.eDocEnvelope.findMany({ where: { status: { in: OPEN_STATUSES }, expiresAt: { lte: now } }, select: { id: true }, take: 1000 });
  let count = 0;
  for (const { id } of due) {
    await prisma.$transaction(async (tx) => {
      const r = await tx.eDocEnvelope.updateMany({ where: { id, status: { in: OPEN_STATUSES } }, data: { status: 'EXPIRED' } });
      if (r.count === 1) {
        count += 1;
        await appendEvent(tx, id, { type: 'EXPIRED', actor: 'system' });
      }
    });
  }
  return count;
}

// ---------------------------------------------------------------- 서명자 화면

export type SignerLoad =
  | { ok: false; reason: string }
  | {
      ok: true;
      signer: NonNullable<Awaited<ReturnType<typeof findSigner>>>;
      snapshot: EDocSnapshot;
      merchantName: string;
      isPrimary: boolean;
      canSign: boolean;
      waitingReason: string | null;
    };

async function findSigner(token: string) {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  return prisma.eDocSigner.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: {
      envelope: {
        include: {
          merchant: { select: { displayName: true, code: true, avatarUrl: true } },
          signers: { orderBy: { order: 'asc' }, select: { id: true, order: true, role: true, nameMasked: true, status: true, signedAt: true } },
        },
      },
    },
  });
}

export async function loadSigner(token: string): Promise<SignerLoad> {
  const signer = await findSigner(token);
  if (!signer) return { ok: false, reason: '유효하지 않은 서명 링크입니다. 가장 최근에 받은 문자의 링크를 열어 주세요.' };
  const e = signer.envelope;
  const isPrimary = e.signers[0]?.id === signer.id;
  let waitingReason: string | null = null;
  if (e.status === 'CANCELLED') waitingReason = '기관이 이 서명 요청을 취소했습니다.';
  else if (e.status === 'EXPIRED' || (OPEN_STATUSES.includes(e.status) && e.expiresAt <= new Date())) waitingReason = '서명 기한이 지났습니다. 기관에 다시 요청해 주세요.';
  else if (e.status === 'DECLINED') waitingReason = '서명자 중 한 명이 서명을 거절해 진행이 멈췄습니다.';
  else if (signer.status === 'WAITING') waitingReason = '앞 순서 서명자가 서명한 뒤에 서명할 수 있습니다.';
  else if (!isPrimary && e.signingOrder === 'PARALLEL' && e.signers[0]?.status !== 'SIGNED') waitingReason = '첫 번째 서명자가 내용을 작성한 뒤에 서명할 수 있습니다. 작성이 끝나면 다시 열어 주세요.';
  const canSign = !waitingReason && (signer.status === 'SENT' || signer.status === 'VIEWED');
  return { ok: true, signer, snapshot: readSnapshot(e.snapshotEnc), merchantName: e.merchant.displayName, isPrimary, canSign, waitingReason };
}

// 본인확인(문자 인증번호)

const otpKey = (signerId: string) => `edoc:otp:${signerId}`;
const otpTryKey = (signerId: string) => `edoc:otp-try:${signerId}`;
const codeDigest = (code: string) => hmac(code, env.crypto.sessionSecret);

/** 인증을 마친 브라우저에 주는 증표. 서명자·현재 토큰 해시·만료시각에 묶인다(재발송하면 무효). */
export function accessProof(signerId: string, currentTokenHash: string, expiresAtSec: number) {
  return `${expiresAtSec}.${hmac(`edoc-access:${signerId}:${currentTokenHash}:${expiresAtSec}`, env.crypto.sessionSecret)}`;
}

export function checkAccessProof(signerId: string, currentTokenHash: string, proof: string | undefined | null) {
  if (!proof) return false;
  const [exp, mac] = proof.split('.');
  const expSec = Number(exp);
  if (!Number.isFinite(expSec) || expSec * 1000 < Date.now() || !mac) return false;
  return safeEqual(accessProof(signerId, currentTokenHash, expSec), proof);
}

export function accessCookieName(signerId: string) {
  return `givesign_edoc_${signerId}`;
}

export async function requestSignerOtp(token: string, meta: { ip?: string; userAgent?: string }) {
  const loaded = await loadSigner(token);
  if (!loaded.ok) throw new EDocError(loaded.reason);
  const s = loaded.signer;
  const sent = await kv.incr(`edoc:otp-send:${s.id}`, OTP_SEND_WINDOW_SEC);
  if (sent > OTP_SEND_MAX) throw new EDocError('인증번호 요청이 너무 잦습니다. 30분 뒤 다시 시도해 주세요.');
  const code = generateNumericCode(6);
  const adapter = getMtAdapter();
  const tpl = await applyMtTemplateOverride(tplEDocVerify(code));
  const res = await adapter.send({ to: decrypt(s.phoneEnc), text: tpl.text, templateCode: tpl.code });
  if (!res.ok) throw new EDocError('인증번호를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
  await kv.set(otpKey(s.id), codeDigest(code), OTP_TTL_SEC);
  await kv.del(otpTryKey(s.id));
  await prisma.$transaction((tx) => appendEvent(tx, s.envelopeId, { type: 'OTP_SENT', actor: `signer:${s.id}`, signerId: s.id, ip: meta.ip, userAgent: meta.userAgent, detail: { to: s.phoneMasked } }));
  return { phoneMasked: s.phoneMasked, devCode: isLocal && adapter.info().provider === 'mock' ? code : undefined };
}

export async function confirmSignerOtp(token: string, rawCode: string, meta: { ip?: string; userAgent?: string }) {
  const loaded = await loadSigner(token);
  if (!loaded.ok) throw new EDocError(loaded.reason);
  const s = loaded.signer;
  const code = rawCode.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) throw new EDocError('인증번호 6자리를 입력해 주세요.');
  const saved = await kv.get(otpKey(s.id));
  if (!saved) throw new EDocError('인증 유효시간이 지났습니다. 인증번호를 다시 받아 주세요.');
  if (!safeEqual(codeDigest(code), saved)) {
    const remain = await consumeAttempt(otpTryKey(s.id), OTP_MAX_ATTEMPTS, OTP_TTL_SEC);
    if (remain <= 0) {
      await kv.del(otpKey(s.id));
      throw new EDocError(`인증번호를 ${OTP_MAX_ATTEMPTS}회 잘못 입력했습니다. 인증번호를 다시 받아 주세요.`);
    }
    throw new EDocError(`인증번호가 일치하지 않습니다. (남은 시도 ${remain}회)`);
  }
  await kv.del(otpKey(s.id));
  await kv.del(otpTryKey(s.id));
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.eDocSigner.update({
      where: { id: s.id },
      data: { otpVerifiedAt: now, ...(s.viewedAt ? {} : { viewedAt: now }), ...(s.status === 'SENT' ? { status: 'VIEWED' } : {}) },
    });
    await appendEvent(tx, s.envelopeId, { type: 'OTP_VERIFIED', actor: `signer:${s.id}`, signerId: s.id, ip: meta.ip, userAgent: meta.userAgent });
    if (!s.viewedAt) await appendEvent(tx, s.envelopeId, { type: 'VIEWED', actor: `signer:${s.id}`, signerId: s.id, ip: meta.ip, userAgent: meta.userAgent });
  });
  const exp = Math.floor(Date.now() / 1000) + EDOC_ACCESS_TTL_SEC;
  return { signerId: s.id, proof: accessProof(s.id, s.tokenHash, exp), maxAge: EDOC_ACCESS_TTL_SEC };
}

/** 문서 완료본 해시: 스냅샷 해시 + 서명자별(순서·역할·입력값·서명 이미지·서명 시각) */
function documentHashOf(snapshotHash: string, signers: Array<{ id: string; order: number; role: string; valuesEnc: string | null; signatureUrl: string | null; signedAt: Date | null }>) {
  return sha(
    stableJson({
      snapshot: snapshotHash,
      signers: signers.map((s) => ({ id: s.id, order: s.order, role: s.role, values: readJsonEnc(s.valuesEnc), signature: s.signatureUrl, signedAt: s.signedAt?.toISOString() ?? null })),
    }),
  );
}

export async function signAsSigner(input: {
  token: string;
  proof: string | undefined;
  values: Record<string, string>;
  signature: string | null;
  agreed: boolean;
  ip?: string;
  userAgent?: string;
}) {
  const loaded = await loadSigner(input.token);
  if (!loaded.ok) throw new EDocError(loaded.reason);
  const { signer: s, snapshot, isPrimary } = loaded;
  if (!checkAccessProof(s.id, s.tokenHash, input.proof)) throw new EDocError('본인확인이 만료되었습니다. 인증번호를 다시 받아 주세요.');
  if (!loaded.canSign) throw new EDocError(loaded.waitingReason ?? '이미 처리한 문서입니다.');
  if (!input.agreed) throw new EDocError('문서 내용을 확인했다는 항목에 체크해 주세요.');

  let valuesEnc: string | null = null;
  if (isPrimary && snapshot.fields.length) {
    const checked = validateValues(snapshot.fields, input.values);
    if (!checked.ok) throw new EDocError(checked.message);
    valuesEnc = encrypt(JSON.stringify(checked.values));
  }
  if (!input.signature) throw new EDocError('서명란에 서명해 주세요.');
  const stored = await storeSignature(input.signature);
  if (!stored.ok) throw new EDocError(stored.message);

  const now = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    // 선점: 서명 전 상태일 때만 바뀐다(두 번 눌러도 한 번만 서명).
    const claimed = await tx.eDocSigner.updateMany({
      where: { id: s.id, status: { in: ['SENT', 'VIEWED'] }, envelope: { status: { in: OPEN_STATUSES } } },
      data: { status: 'SIGNED', signedAt: now, valuesEnc, signatureUrl: stored.url, signIp: input.ip ?? null, signAgent: input.userAgent?.slice(0, 300) ?? null },
    });
    if (claimed.count !== 1) throw new EDocError('이미 처리한 문서입니다.');
    await appendEvent(tx, s.envelopeId, {
      type: 'SIGNED',
      actor: `signer:${s.id}`,
      signerId: s.id,
      ip: input.ip,
      userAgent: input.userAgent,
      detail: { role: s.role, signature: sha(stored.url), values: valuesEnc ? sha(valuesEnc) : null },
    });
    const all = await tx.eDocSigner.findMany({ where: { envelopeId: s.envelopeId }, orderBy: { order: 'asc' } });
    if (all.every((x) => x.status === 'SIGNED')) {
      const env_ = await tx.eDocEnvelope.findUniqueOrThrow({ where: { id: s.envelopeId }, select: { snapshotHash: true } });
      const documentHash = documentHashOf(env_.snapshotHash, all);
      await tx.eDocEnvelope.update({ where: { id: s.envelopeId }, data: { status: 'COMPLETED', completedAt: now, documentHash } });
      await appendEvent(tx, s.envelopeId, { type: 'COMPLETED', actor: 'system', detail: { documentHash } });
      return { completed: true as const, next: null };
    }
    await tx.eDocEnvelope.updateMany({ where: { id: s.envelopeId, status: 'SENT' }, data: { status: 'IN_PROGRESS' } });
    const next = all.find((x) => x.status === 'WAITING');
    return { completed: false as const, next: next?.id ?? null };
  });

  // 사후 처리(문자·알림). 실패해도 서명 결과는 그대로다.
  try {
    const e = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: s.envelopeId }, include: { merchant: { select: { userId: true, displayName: true } }, signers: true } });
    if (outcome.completed) {
      for (const x of e.signers) {
        await sendMtDetailed({ phone: decrypt(x.phoneEnc), template: tplEDocCompleted({ merchantName: e.merchant.displayName, title: e.title }), merchantId: e.merchantId }).catch(() => undefined);
      }
      await notifyUser({ userId: e.merchant.userId, title: '전자문서 서명이 완료되었습니다', body: `「${e.title}」 서명자 ${e.signers.length}명이 모두 서명했습니다.`, linkUrl: `/studio/e-documents/${e.id}` });
    } else if (outcome.next && e.signingOrder === 'SEQUENTIAL') {
      await issueAndSend(outcome.next, { actor: 'system' });
    }
  } catch (err) {
    logger.error('전자문서 서명 후 처리 실패', { envelopeId: s.envelopeId, message: (err as Error).message });
  }
  return outcome;
}

export async function declineAsSigner(input: { token: string; proof: string | undefined; reason: string; ip?: string; userAgent?: string }) {
  const loaded = await loadSigner(input.token);
  if (!loaded.ok) throw new EDocError(loaded.reason);
  const s = loaded.signer;
  if (!checkAccessProof(s.id, s.tokenHash, input.proof)) throw new EDocError('본인확인이 만료되었습니다. 인증번호를 다시 받아 주세요.');
  const reason = input.reason.trim().slice(0, 200);
  if (!reason) throw new EDocError('거절 사유를 적어 주세요. 기관이 확인합니다.');
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.eDocSigner.updateMany({
      where: { id: s.id, status: { in: ['SENT', 'VIEWED'] }, envelope: { status: { in: OPEN_STATUSES } } },
      data: { status: 'DECLINED', declinedAt: new Date(), declineReason: reason },
    });
    if (claimed.count !== 1) throw new EDocError('이미 처리한 문서입니다.');
    await tx.eDocEnvelope.update({ where: { id: s.envelopeId }, data: { status: 'DECLINED' } });
    await appendEvent(tx, s.envelopeId, { type: 'DECLINED', actor: `signer:${s.id}`, signerId: s.id, ip: input.ip, userAgent: input.userAgent, detail: { reason } });
  });
  try {
    const m = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: s.envelopeId }, select: { title: true, merchant: { select: { userId: true } } } });
    await notifyUser({ userId: m.merchant.userId, title: '전자문서 서명이 거절되었습니다', body: `「${m.title}」 ${edocRoleLabel[s.role]} ${s.nameMasked}: ${reason}`, linkUrl: `/studio/e-documents/${s.envelopeId}` });
  } catch {
    /* 알림 실패는 무시 */
  }
}

/** 완료본에 보여 줄 입력값(첫 서명자 것). 서명자 화면·기관 열람 공용. */
export async function envelopeValues(envelopeId: string) {
  const primary = await prisma.eDocSigner.findFirst({ where: { envelopeId }, orderBy: { order: 'asc' }, select: { valuesEnc: true } });
  return readJsonEnc(primary?.valuesEnc ?? null);
}

// ---------------------------------------------------------------- 통계

export async function edocStats(merchantId?: string) {
  const where = merchantId ? { merchantId } : {};
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [byStatus, thisMonth] = await Promise.all([
    prisma.eDocEnvelope.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.eDocEnvelope.count({ where: { ...where, createdAt: { gte: monthStart } } }),
  ]);
  const c = (s: EDocEnvelopeStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  return { open: c('SENT') + c('IN_PROGRESS'), completed: c('COMPLETED'), declined: c('DECLINED'), expired: c('EXPIRED'), cancelled: c('CANCELLED'), thisMonth, total: byStatus.reduce((a, b) => a + b._count._all, 0) };
}

export { appendEvent as appendEDocEvent };
