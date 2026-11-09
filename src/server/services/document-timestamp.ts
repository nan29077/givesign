import { prisma } from '@/server/db';
import { encrypt } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { getTimestampAdapter } from '@/server/adapters/timestamp';
import { registerConsumer, type StoredDomainEvent } from './events';

/**
 * 완료 문서 시점확인(TSA) 자리 (2026-11-13 5차 L1-4).
 *
 * 전자서명 봉투가 완료되면(document.signed) 완료본 해시에 시점 토큰을 붙이는 자리다. 실연동이 없으므로
 * mock 은 토큰 없이 NOT_CONNECTED("시점확인 미연동")만 남긴다 — 가짜 토큰을 만들지 않는다.
 * 봉투당 1행(envelope_id PK). 소비자 실패는 서명 결과를 바꾸지 않는다.
 */

export const TIMESTAMP_STATUS_LABEL: Record<string, string> = {
  NOT_CONNECTED: '시점확인 미연동(공인 시점확인 기관 연동 전)',
  STAMPED: '시점확인 완료',
  FAILED: '시점확인 실패',
};

export async function stampEnvelope(envelopeId: string): Promise<'SKIPPED' | 'NOT_CONNECTED' | 'STAMPED' | 'FAILED'> {
  const env_ = await prisma.eDocEnvelope.findUnique({ where: { id: envelopeId }, select: { status: true, documentHash: true } });
  if (!env_ || env_.status !== 'COMPLETED' || !env_.documentHash) return 'SKIPPED';
  const existing = await prisma.documentTimestamp.findUnique({ where: { envelopeId } });
  if (existing && existing.status === 'STAMPED') return 'STAMPED';
  const adapter = getTimestampAdapter();
  const res = await adapter.stamp(env_.documentHash).catch((e) => ({ ok: false as const, code: 'ERROR', message: (e as Error).message, data: undefined }));
  const status = res.ok && res.data ? 'STAMPED' : res.code === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : 'FAILED';
  const data = {
    documentHash: env_.documentHash,
    provider: adapter.info().provider,
    status,
    tokenEnc: res.ok && res.data ? encrypt(res.data.token) : null,
    stampedAt: res.ok && res.data ? res.data.stampedAt : null,
    note: res.ok ? null : (res.message ?? null),
  };
  await prisma.documentTimestamp.upsert({ where: { envelopeId }, create: { envelopeId, ...data }, update: data });
  if (status === 'FAILED') logger.warn('시점확인 실패', { envelopeId, code: res.code });
  return status;
}

export async function handleDocumentTimestamp(ev: StoredDomainEvent) {
  if (ev.subjectType !== 'edoc_envelope') return 'SKIPPED' as const;
  const r = await stampEnvelope(ev.subjectId);
  return r === 'SKIPPED' ? ('SKIPPED' as const) : undefined;
}

export function registerDocumentTimestampConsumer() {
  registerConsumer({ name: 'document-timestamp', types: ['document.signed'], handle: handleDocumentTimestamp });
}

export async function timestampLabel(envelopeId: string): Promise<string | null> {
  const row = await prisma.documentTimestamp.findUnique({ where: { envelopeId }, select: { status: true } });
  return row ? (TIMESTAMP_STATUS_LABEL[row.status] ?? row.status) : null;
}
