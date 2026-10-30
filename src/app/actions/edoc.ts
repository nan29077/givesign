'use server';

import { revalidatePath } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { requireMerchant, writeAudit } from '@/server/auth';
import { clientIpFrom } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { prisma } from '@/server/db';
import {
  appendEDocEvent,
  envelopeValues,
  readSnapshot,
  accessCookieName,
  cancelEnvelope,
  confirmSignerOtp,
  createBulkEnvelopes,
  createEnvelope,
  declineAsSigner,
  edocRoleLabel,
  loadSigner,
  parseRecipientLines,
  remindSigner,
  requestSignerOtp,
  signAsSigner,
} from '@/server/services/edoc';
import { cancelBillingRequest, requestBilling } from '@/server/services/edoc-billing';
import type { StudioActionState } from './studio';
import type { EDocSignerRole } from '@/generated/prisma/enums';

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

function refresh(envelopeId?: string) {
  revalidatePath('/studio/e-documents');
  revalidatePath('/studio/document-billing');
  revalidatePath('/admin/e-documents');
  if (envelopeId) revalidatePath(`/studio/e-documents/${envelopeId}`);
}

/** 서비스가 던진 한국어 안내는 그대로, 내부 오류는 일반 문구로 바꾼다. */
function friendly(e: unknown, fallback: string) {
  const m = e instanceof Error ? e.message : '';
  if (m && /[가-힣]/.test(m) && !/prisma|invocation|decrypt/i.test(m)) return m;
  logger.error('전자문서 처리 오류', { message: m });
  return fallback;
}

const ROLES = Object.keys(edocRoleLabel) as EDocSignerRole[];
const asRole = (v: string): EDocSignerRole => (ROLES.includes(v as EDocSignerRole) ? (v as EDocSignerRole) : 'OTHER');

// ---------------------------------------------------------------- 기관: 서명 요청

export async function createEDocEnvelopeAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const user = await requireMerchant();
    const signers = [0, 1, 2, 3, 4].map((i) => ({ name: text(f, `signer_${i}_name`), phone: text(f, `signer_${i}_phone`), role: asRole(text(f, `signer_${i}_role`)) }));
    const r = await createEnvelope({
      merchantId: user.merchantId,
      actorId: user.id,
      nonce: text(f, 'nonce'),
      templateId: text(f, 'templateId'),
      title: text(f, 'title') || null,
      message: text(f, 'message') || null,
      signingOrder: text(f, 'signingOrder') === 'SEQUENTIAL' ? 'SEQUENTIAL' : 'PARALLEL',
      expiresDays: Number(text(f, 'expiresDays')) || undefined,
      signers,
    });
    if (!r.duplicated) {
      await writeAudit({ adminUserId: user.id, action: 'EDOC_ENVELOPE_CREATE', targetType: 'edoc_envelope', targetId: r.envelopeId, after: { merchantId: user.merchantId, sent: r.sent, failed: r.failed, charge: r.charge?.source } });
    }
    refresh(r.envelopeId);
    const message = r.duplicated
      ? '이미 보낸 서명 요청입니다.'
      : r.failed
        ? `서명 요청을 만들었지만 문자 ${r.failed}건을 보내지 못했습니다. 상세 화면에서 다시 보내 주세요.`
        : `서명 요청을 보냈습니다. (문자 ${r.sent}건)`;
    return {
      ok: true,
      message,
      redirectTo: r.devTokens.length ? undefined : `/studio/e-documents/${r.envelopeId}`,
      ...(r.devTokens.length
        ? { secret: r.devTokens.map((t) => `/sign/${t}`).join('\n'), secretLabel: '테스트 서명 링크 (로컬 mock 문자 전용)', secretHint: '실제 운영에서는 이 값이 화면에 나오지 않고 문자로만 갑니다.' }
        : {}),
    };
  } catch (e) {
    return { ok: false, message: friendly(e, '서명 요청을 보내지 못했습니다.') };
  }
}

export async function createEDocBulkAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const user = await requireMerchant();
    const rows = parseRecipientLines(text(f, 'recipients'));
    const r = await createBulkEnvelopes({
      merchantId: user.merchantId,
      actorId: user.id,
      templateId: text(f, 'templateId'),
      title: text(f, 'title') || null,
      message: text(f, 'message') || null,
      expiresDays: Number(text(f, 'expiresDays')) || undefined,
      role: asRole(text(f, 'role')),
      rows,
      batchNonce: text(f, 'nonce'),
    });
    await writeAudit({ adminUserId: user.id, action: 'EDOC_BULK_SEND', targetType: 'edoc_envelope', targetId: text(f, 'nonce'), after: { merchantId: user.merchantId, created: r.created, failed: r.failed } });
    refresh();
    const failedLines = r.results.filter((x) => !x.ok).slice(0, 8).map((x) => `${x.line}번째 줄: ${x.message}`);
    return {
      ok: r.created > 0,
      message: `${r.created}건 보냄 · ${r.failed}건 실패${failedLines.length ? ` — ${failedLines.join(' / ')}` : ''}`,
    };
  } catch (e) {
    return { ok: false, message: friendly(e, '대량 발송을 처리하지 못했습니다.') };
  }
}

export async function cancelEDocEnvelopeAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const user = await requireMerchant();
    const id = text(f, 'envelopeId');
    const r = await cancelEnvelope({ merchantId: user.merchantId, envelopeId: id, actorId: user.id, reason: text(f, 'reason') });
    await writeAudit({ adminUserId: user.id, action: 'EDOC_ENVELOPE_CANCEL', targetType: 'edoc_envelope', targetId: id, after: { refunded: r.refunded } });
    refresh(id);
    return { ok: true, message: r.refunded ? '발송을 취소하고 이용료 1건을 되돌렸습니다.' : '발송을 취소했습니다. 서명자가 이미 문서를 열어 이용료는 되돌리지 않습니다.' };
  } catch (e) {
    return { ok: false, message: friendly(e, '취소하지 못했습니다.') };
  }
}

export async function remindEDocSignerAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const user = await requireMerchant();
    const id = text(f, 'envelopeId');
    const r = await remindSigner({ merchantId: user.merchantId, envelopeId: id, signerId: text(f, 'signerId'), actorId: user.id });
    refresh(id);
    if (!r.ok) return { ok: false, message: '재안내 문자를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.' };
    return {
      ok: true,
      // 로컬 mock 문자에서만 링크를 화면에 보여 준다(재안내 버튼은 비밀값 상자가 없어 문구에 붙인다).
      message: `새 서명 링크로 재안내를 보냈습니다. 이전 링크는 더 이상 열리지 않습니다.${r.token ? ` (테스트 링크 /sign/${r.token})` : ''}`,
    };
  } catch (e) {
    return { ok: false, message: friendly(e, '재안내를 보내지 못했습니다.') };
  }
}

// ---------------------------------------------------------------- 기관: 이용요금 신청

export async function requestEDocBilling(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const user = await requireMerchant();
    const kind = text(f, 'kind');
    if (kind !== 'TOPUP' && kind !== 'MONTHLY') throw new Error('이용 방식을 골라 주세요.');
    const r = await requestBilling({
      merchantId: user.merchantId,
      actorId: user.id,
      requestId: text(f, 'nonce'),
      kind,
      amount: Number(text(f, 'amount').replace(/,/g, '')),
      depositorName: text(f, 'depositorName') || null,
      wantsTaxInvoice: f.get('wantsTaxInvoice') != null,
    });
    if (!r.duplicated) await writeAudit({ adminUserId: user.id, action: 'EDOC_BILLING_REQUEST', targetType: 'edoc_billing_request', targetId: r.request.id, after: { kind, amount: r.request.amount, bonus: r.request.bonus } });
    refresh();
    return { ok: true, message: r.duplicated ? '이미 접수한 신청입니다.' : '신청을 접수했습니다. 결제가 된 것은 아닙니다. 안내받은 계좌로 입금하면 관리자가 확인한 뒤 반영합니다.' };
  } catch (e) {
    return { ok: false, message: friendly(e, '신청하지 못했습니다.') };
  }
}

export async function cancelEDocBillingAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const user = await requireMerchant();
    await cancelBillingRequest(user.merchantId, text(f, 'requestId'));
    refresh();
    return { ok: true, message: '신청을 취소했습니다.' };
  } catch (e) {
    return { ok: false, message: friendly(e, '취소하지 못했습니다.') };
  }
}

// ---------------------------------------------------------------- 서명자(비로그인)

export interface SignerActionState {
  ok: boolean;
  message?: string;
  devCode?: string;
  codeSent?: boolean;
  done?: 'verified' | 'signed' | 'completed' | 'declined';
  /** 실패했을 때 입력값을 되돌려 준다(폼이 제출 뒤 초기화되므로). */
  values?: Record<string, string>;
}

async function meta() {
  const h = await headers();
  return { ip: clientIpFrom((n) => h.get(n)) ?? undefined, userAgent: h.get('user-agent') ?? undefined };
}

export async function signerOtpRequestAction(_prev: SignerActionState, f: FormData): Promise<SignerActionState> {
  try {
    const r = await requestSignerOtp(text(f, 'token'), await meta());
    return { ok: true, codeSent: true, message: `${r.phoneMasked} 번호로 인증번호를 보냈습니다.`, devCode: r.devCode };
  } catch (e) {
    return { ok: false, codeSent: false, message: friendly(e, '인증번호를 보내지 못했습니다.') };
  }
}

export async function signerOtpConfirmAction(_prev: SignerActionState, f: FormData): Promise<SignerActionState> {
  try {
    const token = text(f, 'token');
    const r = await confirmSignerOtp(token, text(f, 'otp'), await meta());
    (await cookies()).set(accessCookieName(r.signerId), r.proof, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' && env.baseUrl.startsWith('https'), path: '/sign', maxAge: r.maxAge });
    return { ok: true, codeSent: true, done: 'verified', message: '본인확인을 마쳤습니다.' };
  } catch (e) {
    return { ok: false, codeSent: true, message: friendly(e, '본인확인을 하지 못했습니다.') };
  }
}

async function proofFor(token: string) {
  const loaded = await loadSigner(token);
  if (!loaded.ok) return undefined;
  return (await cookies()).get(accessCookieName(loaded.signer.id))?.value;
}

export async function signerSignAction(_prev: SignerActionState, f: FormData): Promise<SignerActionState> {
  const values: Record<string, string> = {};
  for (const [k, v] of f.entries()) if (k.startsWith('v_') && typeof v === 'string') values[k.slice(2)] = v;
  try {
    const token = text(f, 'token');
    const r = await signAsSigner({
      token,
      proof: await proofFor(token),
      values,
      signature: text(f, 'signature') || null,
      agreed: f.get('agreed') != null,
      ...(await meta()),
    });
    return { ok: true, done: r.completed ? 'completed' : 'signed', message: r.completed ? '서명이 모두 끝났습니다.' : '서명했습니다.' };
  } catch (e) {
    return { ok: false, values, message: friendly(e, '서명을 저장하지 못했습니다. 다시 시도해 주세요.') };
  }
}

export async function signerDeclineAction(_prev: SignerActionState, f: FormData): Promise<SignerActionState> {
  try {
    const token = text(f, 'token');
    await declineAsSigner({ token, proof: await proofFor(token), reason: text(f, 'reason'), ...(await meta()) });
    return { ok: true, done: 'declined', message: '서명을 거절했습니다. 기관에 사유가 전달됩니다.' };
  } catch (e) {
    return { ok: false, message: friendly(e, '처리하지 못했습니다.') };
  }
}

// ---------------------------------------------------------------- 기관: 입력값 열람(감사로그)

export interface RevealState {
  ok: boolean;
  message?: string;
  rows?: Array<{ label: string; value: string }>;
}

export async function revealEDocValuesAction(_prev: RevealState, f: FormData): Promise<RevealState> {
  try {
    const user = await requireMerchant();
    const id = text(f, 'envelopeId');
    const e = await prisma.eDocEnvelope.findFirst({ where: { id, merchantId: user.merchantId }, select: { id: true, snapshotEnc: true } });
    if (!e) throw new Error('서명 요청을 찾을 수 없습니다.');
    const snapshot = readSnapshot(e.snapshotEnc);
    const values = await envelopeValues(e.id);
    await writeAudit({ adminUserId: user.id, action: 'EDOC_VALUES_VIEW', targetType: 'edoc_envelope', targetId: e.id });
    await prisma.$transaction((tx) => appendEDocEvent(tx, e.id, { type: 'VALUES_VIEWED', actor: `staff:${user.id}` }));
    return {
      ok: true,
      rows: snapshot.fields.map((fl) => ({ label: fl.label, value: fl.type === 'CHECKBOX' ? (values[fl.id] === 'Y' ? '동의' : '동의 안 함') : values[fl.id] || '-' })),
    };
  } catch (e) {
    return { ok: false, message: friendly(e, '열람하지 못했습니다.') };
  }
}
