import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// 서명 이미지는 저장소에 쓰지 않고 주소만 돌려준다(edoc.test.ts 와 같은 방식).
vi.mock('@/server/uploads', () => ({ newObjectName: (ext: string) => `test.${ext}`, putObject: vi.fn(async (name: string) => `/uploads/${name}`) }));

import { createHash } from 'node:crypto';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { generateToken, tokenHash } from '@/lib/crypto';
import { setMockMtFailure } from '@/server/adapters/mt';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { adjustWallet, ensureWallet, verifyWallet } from '@/server/services/edoc-billing';
import {
  accessProof, cancelEnvelope, createEnvelope, declineAsSigner, loadSigner, remindSigner, requestSignerOtp, signAsSigner,
  stableJson, verifyEnvelopeChain,
} from '@/server/services/edoc';
import { buildTemplateSnapshot, loadDocumentContext, submitDocument, templateSnapshotText } from '@/server/services/documents';

/**
 * 2026-11-05 점검 D — 전자문서(서명 요청·이용요금)·결제 연동 문서 조치 회귀 시험.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let fx: Fixture;
let templateId: string;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  const t = await prisma.documentTemplate.create({
    data: {
      id: newId(), merchantId: fx.merchantId, name: '봉사 신청서', templateType: 'EDITOR', body: '본문', requireSignature: true,
      fields: [{ id: 'name', label: '성명', type: 'TEXT', required: true }],
    },
  });
  templateId = t.id;
});

const send = (over: Partial<Parameters<typeof createEnvelope>[0]> = {}) =>
  createEnvelope({
    merchantId: fx.merchantId, actorId: fx.merchantUserId, nonce: newId(), templateId, signingOrder: 'PARALLEL',
    signers: [{ name: '홍길동', phone: '010-1111-2222', role: 'VOLUNTEER' }], ...over,
  });

async function tokenFor(signerId: string) {
  const token = `test-token-${signerId}-abcdefgh`;
  await prisma.eDocSigner.update({ where: { id: signerId }, data: { tokenHash: tokenHash(token) } });
  return { token, proof: accessProof(signerId, tokenHash(token), Math.floor(Date.now() / 1000) + 600) };
}

describe('H-7 재안내 문자 실패', () => {
  it('실패하면 이전 링크를 살려 두고, 재안내 횟수·1시간 간격을 소진하지 않는다', async () => {
    const r = await send();
    const s = await prisma.eDocSigner.findFirstOrThrow({ where: { envelopeId: r.envelopeId } });
    const old = await tokenFor(s.id);

    setMockMtFailure('게이트웨이 장애');
    const failed = await remindSigner({ merchantId: fx.merchantId, envelopeId: r.envelopeId, signerId: s.id, actorId: fx.merchantUserId });
    expect(failed.ok).toBe(false);
    const after = await prisma.eDocSigner.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.remindCount).toBe(0);
    expect(after.lastRemindedAt).toBeNull();
    expect((await loadSigner(old.token)).ok).toBe(true); // 이전 링크가 그대로 열린다
    const ev = await prisma.eDocEvent.findFirstOrThrow({ where: { envelopeId: r.envelopeId, type: 'SEND_FAILED' } });
    expect((ev.detail as { previousLinkKept?: boolean }).previousLinkKept).toBe(true);

    // 장애가 풀리면 바로(1시간 기다리지 않고) 다시 보낼 수 있다.
    setMockMtFailure(null);
    const ok = await remindSigner({ merchantId: fx.merchantId, envelopeId: r.envelopeId, signerId: s.id, actorId: fx.merchantUserId });
    expect(ok.ok).toBe(true);
    expect((await prisma.eDocSigner.findUniqueOrThrow({ where: { id: s.id } })).remindCount).toBe(1);
    expect((await loadSigner(old.token)).ok).toBe(false); // 성공하면 이전 링크는 무효
    expect((await verifyEnvelopeChain(r.envelopeId)).ok).toBe(true);
  });

  it('순차 서명에서 순서 대기에 남은 서명자(앞사람 모두 서명)는 다시 보낼 수 있다', async () => {
    const r = await send({
      signingOrder: 'SEQUENTIAL',
      signers: [{ name: '홍길동', phone: '010-1111-2222', role: 'VOLUNTEER' }, { name: '담당자', phone: '010-3333-4444', role: 'STAFF' }],
    });
    const [s1, s2] = await prisma.eDocSigner.findMany({ where: { envelopeId: r.envelopeId }, orderBy: { order: 'asc' } });
    await expect(remindSigner({ merchantId: fx.merchantId, envelopeId: r.envelopeId, signerId: s2!.id, actorId: fx.merchantUserId })).rejects.toThrow(/서명을 기다리는/);
    // 앞사람이 서명했지만 다음 사람 링크 발송이 끝나지 못한 상태
    await prisma.eDocSigner.update({ where: { id: s1!.id }, data: { status: 'SIGNED', signedAt: new Date() } });
    const res = await remindSigner({ merchantId: fx.merchantId, envelopeId: r.envelopeId, signerId: s2!.id, actorId: fx.merchantUserId });
    expect(res.ok).toBe(true);
    expect((await prisma.eDocSigner.findUniqueOrThrow({ where: { id: s2!.id } })).status).toBe('SENT');
  });
});

describe('동시 서명 · 상태 경합 · 종료 문서', () => {
  it('동시 서명: 첫 서명자가 작성·서명하면 나머지 서명자에게 "이제 서명할 수 있다" 문자를 보낸다', async () => {
    const r = await send({
      signers: [{ name: '홍길동', phone: '010-1111-2222', role: 'VOLUNTEER' }, { name: '담당자', phone: '010-3333-4444', role: 'STAFF' }],
    });
    const [s1, s2] = await prisma.eDocSigner.findMany({ where: { envelopeId: r.envelopeId }, orderBy: { order: 'asc' } });
    const before = await prisma.mtOutboundMessage.count({ where: { templateCode: 'EDOC_SIGN_REQUEST' } });
    const b = await tokenFor(s2!.id);
    const a = await tokenFor(s1!.id);
    await signAsSigner({ token: a.token, proof: a.proof, values: { name: '홍길동' }, signature: PNG, agreed: true });
    const msgs = await prisma.mtOutboundMessage.findMany({ where: { templateCode: 'EDOC_SIGN_REQUEST' }, orderBy: { createdAt: 'desc' } });
    expect(msgs.length).toBe(before + 1);
    // 안내 문자에는 새 링크가 들어가므로 이전 링크는 열리지 않는다.
    expect((await loadSigner(b.token)).ok).toBe(false);
    const ev = await prisma.eDocEvent.findMany({ where: { envelopeId: r.envelopeId, signerId: s2!.id, type: 'SENT' } });
    expect(ev.some((e) => (e.detail as { notice?: string }).notice === 'ready')).toBe(true);
    expect((await prisma.eDocSigner.findUniqueOrThrow({ where: { id: s2!.id } })).remindCount).toBe(0);
  });

  it('완료 처리와 발송 취소가 겹쳐도 취소된 문서가 완료로 덮어써지지 않는다', async () => {
    const r = await send();
    const s = await prisma.eDocSigner.findFirstOrThrow({ where: { envelopeId: r.envelopeId } });
    const a = await tokenFor(s.id);
    const results = await Promise.allSettled([
      signAsSigner({ token: a.token, proof: a.proof, values: { name: '홍길동' }, signature: PNG, agreed: true }),
      cancelEnvelope({ merchantId: fx.merchantId, envelopeId: r.envelopeId, actorId: fx.merchantUserId, reason: '취소' }),
    ]);
    const env = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: r.envelopeId } });
    const types = (await prisma.eDocEvent.findMany({ where: { envelopeId: r.envelopeId } })).map((e) => e.type);
    expect(results.filter((x) => x.status === 'fulfilled').length).toBe(1);
    if (env.status === 'CANCELLED') expect(types).not.toContain('COMPLETED');
    else {
      expect(env.status).toBe('COMPLETED');
      expect(types).not.toContain('CANCELLED');
    }
    expect((await verifyEnvelopeChain(r.envelopeId)).ok).toBe(true);
  });

  it('취소된 문서의 링크로는 인증번호 문자를 보내지 않는다', async () => {
    const r = await send();
    const s = await prisma.eDocSigner.findFirstOrThrow({ where: { envelopeId: r.envelopeId } });
    const a = await tokenFor(s.id);
    await cancelEnvelope({ merchantId: fx.merchantId, envelopeId: r.envelopeId, actorId: fx.merchantUserId, reason: '번호 오기' });
    const loaded = await loadSigner(a.token);
    expect(loaded.ok && loaded.closed).toBe(true);
    await expect(requestSignerOtp(a.token, {})).rejects.toThrow(/취소/);
  });

  it('기한이 지난 문서는 만료 배치 전이라도 거절할 수 없다', async () => {
    const r = await send();
    const s = await prisma.eDocSigner.findFirstOrThrow({ where: { envelopeId: r.envelopeId } });
    const a = await tokenFor(s.id);
    await prisma.eDocEnvelope.update({ where: { id: r.envelopeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(declineAsSigner({ token: a.token, proof: a.proof, reason: '안 함' })).rejects.toThrow(/기한/);
    expect((await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: r.envelopeId } })).status).toBe('SENT');
  });

  it('서명 이미지 내용 해시를 남기고 완료본 해시에 넣는다', async () => {
    const r = await send();
    const s = await prisma.eDocSigner.findFirstOrThrow({ where: { envelopeId: r.envelopeId } });
    const a = await tokenFor(s.id);
    await signAsSigner({ token: a.token, proof: a.proof, values: { name: '홍길동' }, signature: PNG, agreed: true });
    const signed = await prisma.eDocSigner.findUniqueOrThrow({ where: { id: s.id } });
    const bytes = Buffer.from(PNG.split(',')[1]!, 'base64');
    expect(signed.signatureSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const ev = await prisma.eDocEvent.findFirstOrThrow({ where: { envelopeId: r.envelopeId, type: 'SIGNED' } });
    expect((ev.detail as { signatureSha256?: string }).signatureSha256).toBe(signed.signatureSha256);
  });
});

describe('해시 체인 직렬화', () => {
  it('undefined 값 키는 빠지고(jsonb 왕복과 같게), 유한하지 않은 숫자는 null', () => {
    expect(stableJson({ a: 1, b: undefined })).toBe(stableJson({ a: 1 }));
    expect(stableJson(JSON.parse(JSON.stringify({ a: 1, b: undefined, c: [undefined] })))).toBe(stableJson({ a: 1, b: undefined, c: [undefined] }));
    expect(stableJson({ n: Number.NaN })).toBe('{"n":null}');
  });
});

describe('이용요금', () => {
  it('정액 기간이 끝난 뒤 취소하면 효과 없는 "환원" 행을 남기지 않는다', async () => {
    await ensureWallet(fx.merchantId);
    const subId = newId();
    const now = new Date();
    await prisma.eDocSubscription.create({
      data: {
        id: subId, merchantId: fx.merchantId, price: 30000, quota: 10, used: 0,
        startsAt: new Date(now.getTime() - 86400_000), endsAt: new Date(now.getTime() + 86400_000),
      },
    });
    const r = await send();
    const use = await prisma.eDocLedger.findUniqueOrThrow({ where: { idempotencyKey: `use:${r.envelopeId}` } });
    expect(use.source).toBe('MONTHLY');
    await prisma.eDocSubscription.update({ where: { id: subId }, data: { endsAt: new Date(now.getTime() - 1000) } });
    const res = await cancelEnvelope({ merchantId: fx.merchantId, envelopeId: r.envelopeId, actorId: fx.merchantUserId, reason: '취소' });
    expect(res.refunded).toBe(false);
    expect(await prisma.eDocLedger.count({ where: { idempotencyKey: `refund:${r.envelopeId}` } })).toBe(0);
    const ev = await prisma.eDocEvent.findFirstOrThrow({ where: { envelopeId: r.envelopeId, type: 'CANCELLED' } });
    expect((ev.detail as { noRefund?: string }).noRefund).toBe('MONTHLY_ENDED');
    expect((await verifyWallet(fx.merchantId)).ok).toBe(true);
  });

  it('같은 nonce 로 두 번 조정하면 "이미 반영된 조정" 으로 알린다', async () => {
    await ensureWallet(fx.merchantId);
    const nonce = newId();
    await adjustWallet({ merchantId: fx.merchantId, actorId: 'a', amount: 1000, units: 0, reason: '테스트', nonce });
    await expect(adjustWallet({ merchantId: fx.merchantId, actorId: 'a', amount: 1000, units: 0, reason: '테스트', nonce })).rejects.toThrow(/이미 반영된 조정/);
    expect((await prisma.eDocWallet.findUniqueOrThrow({ where: { merchantId: fx.merchantId } })).balance).toBe(1000);
  });

  it('트랜잭션 밖에서 지갑을 만들어도 시범 제공 원장과 함께 만든다', async () => {
    await ensureWallet(fx.merchantId);
    expect(await prisma.eDocLedger.count({ where: { merchantId: fx.merchantId, kind: 'TRIAL_GRANT' } })).toBe(1);
    expect((await verifyWallet(fx.merchantId)).ok).toBe(true);
  });
});

describe('결제 연동 문서(/doc) 서식 스냅샷', () => {
  async function makeSubmission(withSnapshot: boolean) {
    const t = await prisma.documentTemplate.create({
      data: { id: newId(), merchantId: fx.merchantId, name: '후원 약정서', templateType: 'EDITOR', body: '요청 당시 본문', requireSignature: false, fields: [] },
    });
    const token = generateToken(32);
    const snap = buildTemplateSnapshot(t, 'request');
    const sub = await prisma.documentSubmission.create({
      data: {
        id: newId(), templateId: t.id, merchantId: fx.merchantId, tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 86400_000),
        ...(withSnapshot ? { templateSnapshotEnc: snap.enc, templateSnapshotHash: snap.sha256 } : {}),
      },
    });
    return { t, token, sub };
  }

  it('요청 당시 서식을 암호화 스냅샷 + SHA-256 으로 고정하고, 서식을 고쳐도 그 내용으로 보인다', async () => {
    const { t, token } = await makeSubmission(true);
    await prisma.documentTemplate.update({ where: { id: t.id }, data: { name: '바뀐 이름', body: '바뀐 본문' } });
    const loaded = await loadDocumentContext(token);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.ctx.templateName).toBe('후원 약정서');
    expect(loaded.ctx.body).toBe('요청 당시 본문');
    expect(loaded.ctx.snapshotState).toBe('frozen');
    expect(loaded.ctx.documentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('이전 제출 건(스냅샷 없음)은 현재 서식으로 보이고 "요청 당시 서식 확인값 없음" 을 적으며, 제출할 때 고정한다', async () => {
    const { token, sub } = await makeSubmission(false);
    const loaded = await loadDocumentContext(token);
    expect(loaded.ok && loaded.ctx.snapshotState).toBe('missing');
    expect(templateSnapshotText('missing')).toContain('요청 당시 서식 확인값 없음');
    const res = await submitDocument({ token, values: {} });
    expect(res.ok).toBe(true);
    const row = await prisma.documentSubmission.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.templateSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    const again = await loadDocumentContext(token);
    expect(again.ok && again.ctx.snapshotCapturedOn).toBe('submit');
  });

  it('스냅샷이 확인값과 맞지 않으면 현재 서식으로 보이고 그 사실을 알린다', async () => {
    const { token, sub } = await makeSubmission(true);
    await prisma.documentSubmission.update({ where: { id: sub.id }, data: { templateSnapshotHash: 'f'.repeat(64) } });
    const loaded = await loadDocumentContext(token);
    expect(loaded.ok && loaded.ctx.snapshotState).toBe('mismatch');
  });
});
