import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env, assertProductionSafety } from '@/lib/env';
import { tokenHash } from '@/lib/crypto';
import { readMockOutbox } from '@/server/adapters/mt';
import { getESignAdapter } from '@/server/adapters/esign';
import { newObjectName, putObject } from '@/server/uploads';
import { maskSensitive, mergeKeysIn, renderMergeHtml, renderMergeText } from '@/lib/merge-fields';
import { DOCUMENT_PURPOSES, issuePurposeDocument } from '@/server/services/purpose-documents';
import {
  ensureDefaultPurposeTemplates, mergeValuesFromContext, purposeStatus,
} from '@/server/services/purpose-templates';
import {
  loadIssuedByToken, loadIssuedForPayer, readIssuedPdf, readIssuedSnapshot, resendIssuedDocument, IssuedDocumentError,
} from '@/server/services/issued-documents';
import { accessProof, readSnapshot, signAsSigner } from '@/server/services/edoc';
import { createRecurringDonation } from '@/server/services/recurring';
import { verifyAgreement } from '@/server/services/agreements';
import { DOCUMENT_PRESETS } from '@/server/services/documents';
import { resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';

/**
 * 2단계 — 전자문서 통일 (용도·기본 세트·머지 필드·서명 봉투 연결·감사장).
 *
 *  1) 기본 세트 제공은 멱등이고 동시에 불러도 용도마다 1개다(부분 유니크 인덱스).
 *  2) 머지 렌더: 값이 없으면 빈칸 + missing, HTML 이스케이프, 번호 꼴 값은 마스킹.
 *  3) 열람 문서 발급: dedupeKey 로 한 번, 토큰은 해시만, 만료되면 링크는 닫히고 마이페이지는 열린다.
 *  4) 탈퇴 후원자·자동 발송 끔은 막는다.
 *  5) 서명 용도는 전자문서 봉투(서명자 1명·이용요금 차감)로, 잔액이 없으면 EDOC_BALANCE.
 *  6) 약정서 스냅샷에 기관 서식 본문이 머지되어 들어가고, internal 서명이 끝나면 약정서가 SIGNED 가 된다.
 */

const singleBackend = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${process.env.PGLITE_PORT ?? '5463'}/`);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==';

let fx: Fixture;
let payerId: string;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { representativeName: '이대표' } });
  const payer = await seedRegisteredPayer(fx.payerPhone);
  payerId = payer.id;
  for (const t of ['RECURRING_DEBIT', 'VOLUNTEER_PRIVACY'] as const) {
    await prisma.termsVersion.create({
      data: { id: newId(), type: t, version: '1.0', title: `${t} 동의`, content: `${t} 본문`, required: false, effectiveFrom: new Date('2026-01-01') },
    });
  }
});

const thanks = (over: Partial<Parameters<typeof issuePurposeDocument>[0]> = {}) =>
  issuePurposeDocument({
    merchantId: fx.merchantId,
    purpose: 'THANKS_LETTER',
    payerId,
    context: { amount: 30000n, date: '2026-11-06', campaignTitle: '따뜻한 겨울나기' },
    subject: { type: 'charge', id: 'C1' },
    dedupeKey: 'thanks:C1',
    ...over,
  });

describe('[1] 기본 세트 제공', () => {
  it('없는 용도만 기본 서식으로 복사하고, 다시 불러도 늘지 않는다', async () => {
    const first = await ensureDefaultPurposeTemplates(fx.merchantId);
    expect(first.sort()).toEqual([...DOCUMENT_PURPOSES].sort());
    expect(await ensureDefaultPurposeTemplates(fx.merchantId)).toEqual([]);
    const rows = await prisma.documentTemplate.findMany({ where: { merchantId: fx.merchantId } });
    expect(rows).toHaveLength(DOCUMENT_PURPOSES.length);
    expect(rows.every((r) => r.templateType === 'PRESET' && r.defaultSet && r.autoSend && r.active)).toBe(true);
    const status = await purposeStatus(fx.merchantId);
    expect(status.every((s) => s.sending && s.template?.unchanged)).toBe(true);
    // 감사장 4종은 서명 없는 기본 서식이다
    for (const key of ['THANKS_LETTER', 'RECURRING_THANKS', 'YEAR_END_THANKS', 'VOLUNTEER_THANKS']) {
      const p = DOCUMENT_PRESETS.find((x) => x.key === key)!;
      expect(p.purpose).toBe(key);
      expect(p.requireSignature).toBe(false);
      expect(mergeKeysIn(p.body)).toContain('후원자명');
    }
  });

  it('같은 기본 서식으로 등록해 둔 용도 없는 서식은 새로 만들지 않고 용도를 붙인다', async () => {
    const own = await prisma.documentTemplate.create({
      data: { id: newId(), merchantId: fx.merchantId, name: '후원약정서', templateType: 'PRESET', presetKey: 'SUPPORT_AGREEMENT', body: '기관 약정서 본문입니다.' },
    });
    await ensureDefaultPurposeTemplates(fx.merchantId, ['SUPPORT_AGREEMENT']);
    const rows = await prisma.documentTemplate.findMany({ where: { merchantId: fx.merchantId, purpose: 'SUPPORT_AGREEMENT' } });
    expect(rows.map((r) => r.id)).toEqual([own.id]);
  });

  it.skipIf(singleBackend)('동시에 여러 번 불러도 용도마다 1개만 생긴다', async () => {
    await Promise.all([1, 2, 3, 4].map(() => ensureDefaultPurposeTemplates(fx.merchantId)));
    const groups = await prisma.documentTemplate.groupBy({ by: ['purpose'], where: { merchantId: fx.merchantId, archivedAt: null }, _count: { _all: true } });
    expect(groups).toHaveLength(DOCUMENT_PURPOSES.length);
    expect(groups.every((g) => g._count._all === 1)).toBe(true);
  });

  it('부분 유니크 인덱스: 보관 전 서식 둘이 같은 용도를 가질 수 없다(보관한 것은 예외)', async () => {
    await ensureDefaultPurposeTemplates(fx.merchantId, ['THANKS_LETTER']);
    await expect(
      prisma.documentTemplate.create({ data: { id: newId(), merchantId: fx.merchantId, name: '두 번째', templateType: 'EDITOR', body: '본문입니다.', purpose: 'THANKS_LETTER' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await prisma.documentTemplate.create({
      data: { id: newId(), merchantId: fx.merchantId, name: '보관본', templateType: 'EDITOR', body: '본문입니다.', purpose: 'THANKS_LETTER', archivedAt: new Date() },
    });
  });
});

describe('[2] 머지 렌더', () => {
  it('값이 없는 필드는 빈칸 + missing, 모르는 이름은 그대로 + unknown', () => {
    const r = renderMergeText('{{후원자명}} 님 {{캠페인}} {{금액}} {{후원자이름}}', { 후원자명: '김나눔', 금액: '1,000원', 캠페인: null });
    expect(r.text).toBe('김나눔 님  1,000원 {{후원자이름}}');
    expect(r.missing).toEqual(['캠페인']);
    expect(r.unknown).toEqual(['후원자이름']);
  });

  it('HTML 로 그릴 때 본문과 값을 모두 이스케이프한다', () => {
    const r = renderMergeHtml('<b>안녕</b> {{후원자명}}\n둘째 줄', { 후원자명: '<script>alert(1)</script>' });
    expect(r.html).toBe('&lt;b&gt;안녕&lt;/b&gt; &lt;script&gt;alert(1)&lt;/script&gt;<br>둘째 줄');
    expect(r.html).not.toContain('<script>');
    const hl = renderMergeHtml('{{캠페인}}', {}, { highlight: true });
    expect(hl.html).toContain('data-merge="missing"');
  });

  it('번호 꼴 값은 마스킹한다(전화·주민등록번호)', () => {
    expect(maskSensitive('01012345678')).toBe('010-****-5678');
    expect(maskSensitive('홍길동 010-9876-5432')).toBe('홍길동 010-****-5432');
    expect(maskSensitive('900101-1234567')).toBe('900101-1******');
    expect(renderMergeText('{{후원자명}}', { 후원자명: '01011112222' }).text).toBe('010-****-2222');
  });

  it('MergeContext → 값: 금액·횟수·시간 형식, 기관명·대표자·발급일 자동', () => {
    const v = mergeValuesFromContext(
      { donorName: '김나눔', amount: 1234567n, totalAmount: 0n, count: 12, dayOfMonth: 15, activityHours: 2.5, totalHours: 24, taxYear: 2026 },
      { merchantName: '해오름', representative: null },
      new Date('2026-11-06T03:00:00Z'),
    );
    expect(v).toMatchObject({ 금액: '1,234,567원', 누적금액: '0원', 횟수: '12회', 출금일: '15', 활동시간: '2.5시간', 누적시간: '24시간', 귀속연도: '2026', 기관명: '해오름', 대표자: null, 발급일: '2026-11-06' });
    expect(v.캠페인).toBeNull();
  });
});

describe('[3] 열람 문서 발급 (감사장)', () => {
  it('첫 호출 때 기본 서식을 깔고 머지한 스냅샷 + 열람 링크 문자를 보낸다. 같은 키는 한 번만', async () => {
    const r = await thanks();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signature).toBe(false);
    expect(r.link).toMatch(/\/l\/[A-Za-z0-9_-]{20,}$/);
    const row = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.issuedId } });
    const token = r.link!.split('/l/')[1]!;
    expect(row.tokenHash).toBe(tokenHash(token));
    expect(row.tokenHash).not.toContain(token);
    expect(row.status).toBe('ISSUED');
    expect(row.sentAt).not.toBeNull();
    const { snapshot, verified } = readIssuedSnapshot(row);
    expect(verified).toBe(true);
    expect(snapshot!.body).toContain('테스트후원자 님께');
    expect(snapshot!.body).toContain('30,000원');
    expect(snapshot!.body).toContain('따뜻한 겨울나기');
    expect(snapshot!.body).toContain('테스트사회복지기관 대표 이대표 드림');
    expect(row.snapshotEnc).not.toContain('테스트후원자');
    expect(readMockOutbox(10).filter((m) => m.template === 'DOCUMENT_ISSUED')).toHaveLength(1);

    const again = await thanks();
    expect(again).toMatchObject({ ok: true, already: true, issuedId: r.issuedId, link: null });
    expect(await prisma.issuedDocument.count()).toBe(1);
    expect(readMockOutbox(10).filter((m) => m.template === 'DOCUMENT_ISSUED')).toHaveLength(1);
  });

  it.skipIf(singleBackend)('같은 키로 동시에 불러도 한 건만 발급한다', async () => {
    const rs = await Promise.all([thanks(), thanks(), thanks()]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(await prisma.issuedDocument.count()).toBe(1);
  });

  it('값이 없는 필드는 빈칸으로 두고 missingFields 에 남긴다', async () => {
    const r = await thanks({ context: { amount: 5000n } });
    if (!r.ok) throw new Error(r.reason);
    const row = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.issuedId } });
    expect(row.missingFields).toEqual(expect.arrayContaining(['날짜', '캠페인']));
    expect(readIssuedSnapshot(row).snapshot!.body).not.toContain('{{');
  });

  it('notify:false 면 만들기만 하고 문자는 보내지 않는다', async () => {
    const r = await thanks({ notify: false });
    expect(r.ok).toBe(true);
    expect(readMockOutbox(10).filter((m) => m.template === 'DOCUMENT_ISSUED')).toHaveLength(0);
  });

  it('열람 토큰: 맞는 토큰만 열리고 열람이 기록되며, 만료되면 링크는 닫히고 마이페이지는 열린다', async () => {
    const r = await thanks();
    if (!r.ok) throw new Error(r.reason);
    const token = r.link!.split('/l/')[1]!;
    expect((await loadIssuedByToken('x'.repeat(43))).ok).toBe(false);
    expect((await loadIssuedByToken('../etc')).ok).toBe(false);
    const ok = await loadIssuedByToken(token);
    expect(ok.ok).toBe(true);
    const row = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.issuedId } });
    expect(row.viewCount).toBe(1);
    expect(row.firstViewedAt).not.toBeNull();

    await prisma.issuedDocument.update({ where: { id: r.issuedId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await loadIssuedByToken(token);
    expect(expired).toMatchObject({ ok: false, expired: true });
    expect((await loadIssuedForPayer(payerId, r.issuedId)).ok).toBe(true);
    expect((await loadIssuedForPayer('OTHER', r.issuedId)).ok).toBe(false);

    // 재발송하면 새 토큰 — 이전 링크는 무효
    await prisma.issuedDocument.update({ where: { id: r.issuedId }, data: { sentAt: new Date(Date.now() - 3_600_000) } });
    await resendIssuedDocument({ merchantId: fx.merchantId, id: r.issuedId });
    expect((await loadIssuedByToken(token)).ok).toBe(false);
    const after = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.issuedId } });
    expect(after.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after.sendCount).toBe(2);
    // 보관하면 링크가 닫힌다
    await prisma.issuedDocument.update({ where: { id: r.issuedId }, data: { archivedAt: new Date() } });
    await expect(resendIssuedDocument({ merchantId: fx.merchantId, id: r.issuedId })).rejects.toThrow(IssuedDocumentError);
  });

  it('탈퇴 후원자는 WITHDRAWN, 자동 발송 끔·서식 중지는 DISABLED', async () => {
    await prisma.payerProfile.update({ where: { id: payerId }, data: { onboardingStatus: 'WITHDRAWN' } });
    expect(await thanks()).toMatchObject({ ok: false, blocked: 'WITHDRAWN' });
    await prisma.payerProfile.update({ where: { id: payerId }, data: { onboardingStatus: 'REGISTERED' } });

    await ensureDefaultPurposeTemplates(fx.merchantId, ['THANKS_LETTER']);
    await prisma.documentTemplate.updateMany({ where: { merchantId: fx.merchantId, purpose: 'THANKS_LETTER' }, data: { autoSend: false } });
    expect(await thanks()).toMatchObject({ ok: false, blocked: 'DISABLED' });
    await prisma.documentTemplate.updateMany({ where: { merchantId: fx.merchantId, purpose: 'THANKS_LETTER' }, data: { autoSend: true, active: false } });
    expect(await thanks()).toMatchObject({ ok: false, blocked: 'DISABLED' });
    expect(await prisma.issuedDocument.count()).toBe(0);
  });

  it('파일 서식: 원본 위 새 글자의 머지 필드를 채운 새 PDF 를 비공개로 남기고 원본은 그대로 둔다', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]);
    const baseBytes = await doc.save();
    const baseUrl = await putObject(newObjectName('pdf'), Buffer.from(baseBytes), 'application/octet-stream');
    const layout = {
      v: 1,
      edits: [{
        id: 'e1', page: 1, kind: 'add', matrix: [12, 0, 0, 12, 20, 100], width: 0, text: '{{후원자명}} 님 감사합니다',
        font: { baseFont: 'Helvetica', serif: false, bold: false }, color: [0, 0, 0], cover: [1, 1, 1],
      }],
      fonts: [],
    };
    await prisma.documentTemplate.create({
      data: {
        id: newId(), merchantId: fx.merchantId, name: '파일 감사장', templateType: 'FILE', fileUrl: baseUrl, fileName: 'a.pdf',
        basePdfUrl: baseUrl, basePdfHash: 'x', pdfLayout: layout, purpose: 'THANKS_LETTER', requireSignature: false,
      },
    });
    const r = await thanks({ context: { donorName: '김나눔' } });
    if (!r.ok) throw new Error(r.reason);
    const row = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.issuedId } });
    expect(row.pdfObject).toMatch(/^[a-f0-9]{32}\.pdf$/);
    const bytes = await readIssuedPdf(row);
    expect(bytes).not.toBeNull();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes!), disableFontFace: true }).promise;
    const tc = await (await pdf.getPage(1)).getTextContent();
    const text = tc.items.map((i) => ('str' in i ? i.str : '')).join('');
    await pdf.loadingTask.destroy();
    expect(text.replace(/\s/g, '')).toContain('김나눔님감사합니다');
    // 공개 저장소에는 결과가 없다(비공개 객체) — 원본 주소는 그대로
    const t = await prisma.documentTemplate.findFirstOrThrow({ where: { merchantId: fx.merchantId, purpose: 'THANKS_LETTER' } });
    expect(t.renderedPdfUrl).toBeNull();
    expect(t.basePdfUrl).toBe(baseUrl);
  });
});

describe('[4] 서명 용도 → 전자문서 봉투', () => {
  const pledge = (over: Partial<Parameters<typeof issuePurposeDocument>[0]> = {}) =>
    issuePurposeDocument({
      merchantId: fx.merchantId,
      purpose: 'SUPPORT_AGREEMENT',
      payerId,
      context: { amount: 20000n, dayOfMonth: 15, campaignTitle: '기관 일반 후원' },
      dedupeKey: 'pledge:R1',
      ...over,
    });

  it('후원자 1명 봉투를 만들고 이용요금 1건을 차감하며, 본문은 머지 결과로 고정한다', async () => {
    const r = await pledge();
    expect(r).toMatchObject({ ok: true, signature: true, link: null });
    if (!r.ok) return;
    const row = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.issuedId } });
    expect(row.status).toBe('REQUESTED');
    const env_ = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: row.envelopeId! }, include: { signers: true } });
    expect(env_.signers).toHaveLength(1);
    expect(env_.signers[0]!.phoneMasked).not.toContain('12345678');
    const snap = readSnapshot(env_.snapshotEnc);
    expect(snap.body).toContain('후원자 테스트후원자 님은');
    expect(snap.body).toContain('20,000원');
    expect(snap.body).not.toContain('{{');
    expect(await prisma.eDocLedger.count({ where: { envelopeId: env_.id, kind: 'USE' } })).toBe(1);
    expect(readMockOutbox(10).some((m) => m.template === 'EDOC_SIGN_REQUEST')).toBe(true);
    // 다시 불러도 봉투·차감은 한 번
    expect(await pledge()).toMatchObject({ ok: true, already: true });
    expect(await prisma.eDocEnvelope.count()).toBe(1);
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(1);
  });

  it('잔액이 없으면 EDOC_BALANCE 로 막고 봉투·발급 기록을 남기지 않는다', async () => {
    await prisma.eDocWallet.create({ data: { merchantId: fx.merchantId, balance: 0, trialRemaining: 0, totalUsed: 0 } });
    const r = await pledge();
    expect(r).toMatchObject({ ok: false, blocked: 'EDOC_BALANCE' });
    expect(await prisma.eDocEnvelope.count()).toBe(0);
    expect(await prisma.issuedDocument.count()).toBe(0);
  });
});

describe('[5] 약정서 · 내부 전자서명', () => {
  const original = env.automation.esignProvider;
  afterEach(() => {
    (env.automation as { esignProvider: string }).esignProvider = original;
  });

  it('약정서 스냅샷에 기관 서식(후원 약정서) 본문이 머지되어 들어간다', async () => {
    await ensureDefaultPurposeTemplates(fx.merchantId, ['SUPPORT_AGREEMENT']);
    await prisma.documentTemplate.updateMany({
      where: { merchantId: fx.merchantId, purpose: 'SUPPORT_AGREEMENT' },
      data: { body: '우리 기관 약정: {{후원자명}} 님 매월 {{출금일}}일 {{금액}} <{{캠페인}}>' },
    });
    const r = await createRecurringDonation({ payerId, merchantId: fx.merchantId, amount: 20000n, dayOfMonth: 15 });
    if (!r.ok) throw new Error(r.message);
    const doc = await prisma.agreementDocument.findFirstOrThrow({ where: { subjectId: r.recurring.id } });
    const snap = doc.snapshot as { form?: { body: string; name: string }; pledge: { amount: string }; donor: { phoneMasked: string } };
    expect(snap.form?.body).toBe('우리 기관 약정: 테스트후원자 님 매월 15일 20,000원 <기관 일반 후원>');
    expect(snap.pledge.amount).toBe('20000');
    expect(snap.donor.phoneMasked).not.toContain('12345678');
    expect(verifyAgreement(doc)).toBe(true);
  });

  it('internal 공급자는 mock 이 아니므로 운영 부팅 점검을 통과한다', () => {
    (env.automation as { esignProvider: string }).esignProvider = 'internal';
    expect(getESignAdapter().info()).toMatchObject({ provider: 'internal', mode: 'live' });
    expect(assertProductionSafety().some((p) => p.includes('ESIGN_PROVIDER'))).toBe(false);
  });

  it('ESIGN_PROVIDER=internal: 약정 → 전자문서 봉투 서명 요청 → 서명 완료 → 약정서 SIGNED', async () => {
    (env.automation as { esignProvider: string }).esignProvider = 'internal';
    await ensureDefaultPurposeTemplates(fx.merchantId, ['SUPPORT_AGREEMENT']);
    // 서명 화면 입력을 단순하게: 동의 체크 하나
    await prisma.documentTemplate.updateMany({
      where: { merchantId: fx.merchantId, purpose: 'SUPPORT_AGREEMENT' },
      data: { fields: [{ id: 'agree', label: '동의', type: 'CHECKBOX', required: true }] },
    });
    const r = await createRecurringDonation({ payerId, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 3 });
    if (!r.ok) throw new Error(r.message);
    const doc = await prisma.agreementDocument.findFirstOrThrow({ where: { subjectId: r.recurring.id } });
    expect(doc.esignProvider).toBe('internal');
    expect(doc.esignStatus).toBe('REQUESTED');
    const envelope = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: doc.esignRequestId! }, include: { signers: true } });
    const issued = await prisma.issuedDocument.findUniqueOrThrow({ where: { envelopeId: envelope.id } });
    expect(issued).toMatchObject({ purpose: 'SUPPORT_AGREEMENT', subjectType: 'agreement_document', subjectId: doc.id, dedupeKey: `agreement:${doc.id}` });

    // 서명자 링크 토큰을 알 수 있게 바꾸고(문자로 받은 링크를 연 것과 같다) 본인확인 증표로 서명한다.
    const signer = envelope.signers[0]!;
    const token = 'T'.repeat(43);
    await prisma.eDocSigner.update({ where: { id: signer.id }, data: { tokenHash: tokenHash(token) } });
    const proof = accessProof(signer.id, tokenHash(token), Math.floor(Date.now() / 1000) + 600);
    const out = await signAsSigner({ token, proof, values: { agree: 'on' }, signature: PNG, agreed: true });
    expect(out.completed).toBe(true);

    const signed = await prisma.agreementDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(signed.esignStatus).toBe('SIGNED');
    expect(signed.signedAt).not.toBeNull();
    expect((await prisma.issuedDocument.findUniqueOrThrow({ where: { id: issued.id } })).status).toBe('SIGNED');
    expect(await prisma.domainEvent.count({ where: { type: 'agreement.signed', subjectId: doc.id } })).toBe(1);
  });
});
