import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, phoneHash, maskPhone } from '@/lib/crypto';
import { newObjectName, putObject } from '@/server/uploads';
import {
  pickSamples, runPreflight, stressSampleValues, PURPOSE_REQUIRED_FIELDS,
} from '@/lib/document-preflight';
import { preflightDocument, previewSamples, previewTemplateWithStress } from '@/server/services/document-preflight';
import { fallbackTextWidth, measureLayoutTexts } from '@/server/services/pdf-form/measure';
import { issuePurposeDocument, PREFLIGHT_BLOCK_PREFIX } from '@/server/services/purpose-documents';
import { ensureDefaultPurposeTemplates } from '@/server/services/purpose-templates';
import { requestApproval } from '@/server/services/approvals';
import { inboxActionCount, inboxItems } from '@/server/services/inbox';
import { inboxOverview, waitedLabel } from '@/server/services/inbox-overview';
import {
  journeyFailureClass, loadInboxGroups, receiptInfoSegments, registerInboxGroupProvider, resetInboxGroupProviders, sortInboxGroups,
  type InboxExceptionGroup,
} from '@/server/services/inbox-groups';
import { runInboxGroupAction } from '@/server/services/inbox-actions';
import { notifyOverdueInboxAssignments, saveInboxAssignment, InboxAssignmentError } from '@/server/services/inbox-assignments';
import { receiptBatchPreview } from '@/server/services/receipt-batch-preview';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { advanceRun, retryJourneyRun } from '@/server/services/journeys';
import { CRON_JOBS } from '@/server/cron-registry';
import { readMockOutbox } from '@/server/adapters/mt';
import { resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';

/**
 * 2026-11-09 과제 C — 승인 대기함 예외 해결 화면 + 문서 발송 전 점검.
 *
 *  [P] 점검 판정(block/warn) · 표본 3건 · 긴 이름 폭 계산
 *  [S] 발송 경로 연결: 기존 정상 발송 무변화, block 은 PREFLIGHT, warn 은 발급 행에 남김, 저니는 막힌 일로
 *  [G] 예외 묶음: 형식·제공자 실패 격리·정렬·영수증 정보 안내(중복·수신 거부 제외)·재안내 하루 1회·UNKNOWN 은 다시 실행 없음
 *  [A] 담당자 배정·기한 넘김 알림 1회(동시 실행)·배지 수 회귀
 *  [R] RECEIPT_BATCH 승인 전 확인(대상·표본·제외 이유, 발급 로직 무변화)
 */

let fx: Fixture;
let payerId: string;

beforeEach(async () => {
  await resetDb();
  resetInboxGroupProviders();
  fx = await seedBasics();
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { representativeName: '이대표' } });
  payerId = (await seedRegisteredPayer(fx.payerPhone)).id;
  for (const t of ['RECURRING_DEBIT', 'VOLUNTEER_PRIVACY', 'RECEIPT_ISSUANCE'] as const) {
    await prisma.termsVersion.create({
      data: { id: newId(), type: t, version: '1.0', title: `${t} 동의`, content: `${t} 본문`, required: false, effectiveFrom: new Date('2026-01-01') },
    });
  }
});

afterEach(() => {
  resetInboxGroupProviders();
});

async function seedPayer(phone: string, displayName: string | null, status: 'REGISTERED' | 'WITHDRAWN' = 'REGISTERED') {
  return prisma.payerProfile.create({
    data: { id: newId(), phoneHash: phoneHash(phone), phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone), displayName, onboardingStatus: status, registeredAt: new Date() },
  });
}

async function makeIssuer(cycle: 'YEARLY' | 'MONTHLY' = 'YEARLY') {
  await prisma.merchantProfile.update({
    where: { id: fx.merchantId },
    data: { businessNo: '123-82-00001', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true, designatedDoneeVerifiedAt: new Date(), orgType: 'WELFARE_CORPORATION', receiptCycle: cycle },
  });
}

/** 지난해 결제 건(영수증 대상) */
async function paidLastYear(pid: string, amount: bigint, year: number) {
  await prisma.charge.create({
    data: {
      id: newId(), transactionNo: `TRD-${newId()}`, merchantId: fx.merchantId, payerId: pid, amount, displayName: '후원자', message: '',
      status: 'PAYMENT_SUCCESS', paymentMode: 'CONFIRM_LINK', paidAt: new Date(Date.UTC(year, 5, 1)),
    },
  });
}

async function receiptProfile(pid: string, legalName: string, no: string) {
  await prisma.payerReceiptProfile.create({
    data: { payerId: pid, legalName, residentNoEnc: encrypt(no), residentNoHash: phoneHash(`rn:${no}`), residentNoMasked: `${no.slice(0, 6)}-1******` },
  });
}

// ---------------------------------------------------------------------------
describe('[P] 점검 판정', () => {
  const T = (purpose: string, body: string) => ({ purpose, body, active: true, archivedAt: null });

  it('정상 값이면 ok', () => {
    const r = runPreflight({ template: T('THANKS_LETTER', '{{후원자명}} 님 {{금액}} 감사합니다. {{기관명}}'), values: { 후원자명: '김나눔', 금액: '30,000원', 기관명: '해오름' }, recipient: { hasContact: true } });
    expect(r).toEqual({ level: 'ok', issues: [] });
  });

  it('필수 필드 빈칸·연락처 없음·탈퇴·차단·서식 중지·보관은 block', () => {
    const body = '{{후원자명}} 님 {{기관명}}';
    expect(runPreflight({ template: T('THANKS_LETTER', body), values: { 후원자명: '', 기관명: '해오름' } }).issues.map((i) => i.code)).toContain('REQUIRED_FIELD_EMPTY');
    expect(runPreflight({ template: T('THANKS_LETTER', body), values: { 후원자명: 'a', 기관명: 'b' }, recipient: { hasContact: false } }).level).toBe('block');
    expect(runPreflight({ template: T('THANKS_LETTER', body), values: { 후원자명: 'a', 기관명: 'b' }, recipient: { hasContact: true, withdrawn: true } }).issues[0]!.code).toBe('RECIPIENT_WITHDRAWN');
    expect(runPreflight({ template: T('THANKS_LETTER', body), values: { 후원자명: 'a', 기관명: 'b' }, recipient: { hasContact: true, blocked: true } }).issues[0]!.code).toBe('RECIPIENT_BLOCKED');
    expect(runPreflight({ template: { ...T('THANKS_LETTER', body), active: false }, values: { 후원자명: 'a', 기관명: 'b' } }).issues[0]!.code).toBe('TEMPLATE_INACTIVE');
    expect(runPreflight({ template: { ...T('THANKS_LETTER', body), archivedAt: new Date() }, values: { 후원자명: 'a', 기관명: 'b' } }).issues[0]!.code).toBe('TEMPLATE_ARCHIVED');
  });

  it('서식이 쓰지 않는 필수 필드는 보지 않는다(기존 서식이 막히지 않게)', () => {
    const r = runPreflight({ template: T('SUPPORT_AGREEMENT', '{{후원자명}} 님 약정 — {{기관명}}'), values: { 후원자명: '김', 기관명: '해오름' } });
    expect(r.level).toBe('ok');
    expect(PURPOSE_REQUIRED_FIELDS.SUPPORT_AGREEMENT).toContain('금액');
  });

  it('금액 0원·숫자 아님, 미래 귀속연도는 block / 누적금액 0원은 통과', () => {
    const now = new Date('2026-11-09T03:00:00Z');
    expect(runPreflight({ template: T('THANKS_LETTER', '{{금액}}'), values: { 금액: '0원' } }).issues[0]!.code).toBe('AMOUNT_INVALID');
    expect(runPreflight({ template: T('THANKS_LETTER', '{{금액}}'), values: { 금액: '삼만원' } }).issues[0]!.code).toBe('AMOUNT_INVALID');
    expect(runPreflight({ template: T('RECURRING_THANKS', '{{누적금액}}'), values: { 누적금액: '0원' } }).level).toBe('ok');
    expect(runPreflight({ template: T('YEAR_END_THANKS', '{{귀속연도}}'), values: { 귀속연도: '2027' }, now }).issues[0]!.code).toBe('YEAR_IN_FUTURE');
    expect(runPreflight({ template: T('YEAR_END_THANKS', '{{귀속연도}}'), values: { 귀속연도: '2025' }, now }).level).toBe('ok');
  });

  it('모르는 필드·긴 이름·묶음 이상값은 warn', () => {
    expect(runPreflight({ template: T('THANKS_LETTER', '{{후원자이름}}'), values: {} }).issues.map((i) => [i.code, i.severity])).toEqual([['UNKNOWN_FIELD', 'warn']]);
    const long = runPreflight({ template: T('THANKS_LETTER', '{{후원자명}} {{기관명}}'), values: { 후원자명: stressSampleValues().후원자명, 기관명: '해오름' } });
    expect(long.level).toBe('warn');
    expect(long.issues[0]!.code).toBe('TEXT_OVERFLOW');
    const out = runPreflight({ template: T('THANKS_LETTER', '{{금액}}'), values: { 금액: '5,000,000원' }, batch: { amounts: [10000n, 20000n, 30000n, 5000000n] } });
    expect(out.issues.map((i) => i.code)).toEqual(['OUTLIER_VALUE']);
    // 묶음이 3건 미만이면 비교하지 않는다(경계)
    expect(runPreflight({ template: T('THANKS_LETTER', '{{금액}}'), values: { 금액: '5,000,000원' }, batch: { amounts: [10000n, 5000000n] } }).level).toBe('ok');
  });

  it('파일 서식 측정 결과가 칸보다 넓으면 TEXT_OVERFLOW(측정이 있으면 글자 수 기준은 쓰지 않는다)', () => {
    const t = { purpose: 'THANKS_LETTER', body: '', pdfTexts: ['{{후원자명}}'], active: true };
    expect(runPreflight({ template: t, values: { 후원자명: '김' }, measured: [{ field: '후원자명', text: '김', widthPt: 120, boxPt: 60 }] }).issues[0]!.code).toBe('TEXT_OVERFLOW');
    expect(runPreflight({ template: t, values: { 후원자명: 'x'.repeat(50) }, measured: [{ field: '후원자명', text: 'x', widthPt: 50, boxPt: 60 }] }).level).toBe('ok');
  });

  it('표본 3건: 정상 · 빈칸 · 이름이 가장 긴 것(겹치면 한 번)', () => {
    const c = (key: string, name: string, camp: string | null) => ({ key, label: key, values: { 후원자명: name, 캠페인: camp } });
    const s = pickSamples([c('a', '김', '겨울'), c('b', '이', null), c('c', '가나다라마바사', '여름')], ['후원자명', '캠페인']);
    expect(s.map((x) => [x.kind, x.cand.key])).toEqual([['normal', 'a'], ['blank', 'b'], ['longest', 'c']]);
    // 가장 긴 것이 정상 표본과 같으면 두 건만
    const two = pickSamples([c('a', '가나다라마바사', '겨울'), c('b', '이', null)], ['후원자명', '캠페인']);
    expect(two.map((x) => x.kind)).toEqual(['normal', 'blank']);
    expect(pickSamples([], ['후원자명'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('[P] 긴 이름 폭 계산 (파일 서식)', () => {
  it('대체 글꼴 폭: 한글은 대략 글자 크기 1em, 긴 이름은 짧은 이름보다 넓다', async () => {
    const one = await fallbackTextWidth('가', 10, { serif: false, bold: false });
    expect(one).toBeGreaterThan(8);
    expect(one).toBeLessThan(11);
    const longW = await fallbackTextWidth(stressSampleValues().후원자명, 10, { serif: false, bold: false });
    expect(longW).toBeGreaterThan(one * 20);
  });

  it('원본 글꼴(Helvetica /Widths)로 쓸 수 있으면 그 폭으로, 칸은 replace 의 원래 폭', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const f = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('NAME', { x: 20, y: 100, size: 12, font: f });
    const bytes = await doc.save();
    const m = await measureLayoutTexts(new Uint8Array(bytes), {
      v: 1,
      fonts: [],
      edits: [{ id: 'e1', page: 1, kind: 'replace', matrix: [12, 0, 0, 12, 20, 100], width: 40, text: 'ABCDEFGHIJKLMNOP', font: { baseFont: 'Helvetica', serif: false, bold: false }, color: [0, 0, 0], cover: [1, 1, 1] }],
    });
    expect(m).toHaveLength(1);
    expect(m[0]!.boxPt).toBe(40);
    // Helvetica 대문자 평균 약 0.67em → 16자 × 12pt ≈ 128pt
    expect(m[0]!.widthPt).toBeGreaterThan(100);
    expect(m[0]!.widthPt).toBeLessThan(150);
  });
});

// ---------------------------------------------------------------------------
describe('[S] 발송 경로 연결', () => {
  const thanks = (over: Partial<Parameters<typeof issuePurposeDocument>[0]> = {}) =>
    issuePurposeDocument({ merchantId: fx.merchantId, purpose: 'THANKS_LETTER', payerId, context: { amount: 30000n, date: '2026-11-06', campaignTitle: '겨울' }, dedupeKey: `t:${newId()}`, ...over });

  it('기존 정상 시나리오(기본 서식 감사장·약정서)는 그대로 보내고 경고도 없다', async () => {
    const r = await thanks();
    expect(r).toMatchObject({ ok: true, signature: false });
    if (!r.ok) return;
    const row = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.issuedId } });
    expect(row.preflightWarnings).toEqual([]);
    const p = await issuePurposeDocument({ merchantId: fx.merchantId, purpose: 'SUPPORT_AGREEMENT', payerId, context: { amount: 20000n, dayOfMonth: 15 }, dedupeKey: 'pl:1' });
    expect(p).toMatchObject({ ok: true, signature: true });
  });

  it('이름을 정하지 않은 후원자는 기본 이름(후원자1234)으로 채워 보낸다', async () => {
    const p = await seedPayer('01055556666', null);
    const r = await thanks({ payerId: p.id });
    if (!r.ok) throw new Error(r.reason);
    const row = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.issuedId } });
    expect(row.missingFields).not.toContain('후원자명');
  });

  it('필수 금액이 빈 감사장은 보내지 않고 PREFLIGHT 로 막는다(발급 행·문자 없음)', async () => {
    await ensureDefaultPurposeTemplates(fx.merchantId, ['SUPPORT_AGREEMENT']);
    const before = readMockOutbox(50).length;
    const r = await issuePurposeDocument({ merchantId: fx.merchantId, purpose: 'SUPPORT_AGREEMENT', payerId, context: {}, dedupeKey: 'pl:none' });
    expect(r).toMatchObject({ ok: false, blocked: 'PREFLIGHT' });
    if (r.ok) return;
    expect(r.reason.startsWith(PREFLIGHT_BLOCK_PREFIX)).toBe(true);
    expect(await prisma.issuedDocument.count()).toBe(0);
    expect(await prisma.eDocEnvelope.count()).toBe(0);
    expect(readMockOutbox(50).length).toBe(before);
  });

  it('번호를 풀 수 없는 후원자(연락처 없음)는 막는다', async () => {
    const p = await prisma.payerProfile.create({ data: { id: newId(), phoneHash: phoneHash('x1'), phoneEnc: 'broken', phoneMasked: '', displayName: '김', onboardingStatus: 'REGISTERED' } });
    expect(await thanks({ payerId: p.id })).toMatchObject({ ok: false, blocked: 'PREFLIGHT' });
  });

  it('warn(모르는 머지 필드)은 보내고 발급 행에 경고를 남긴다', async () => {
    await ensureDefaultPurposeTemplates(fx.merchantId, ['THANKS_LETTER']);
    await prisma.documentTemplate.updateMany({ where: { merchantId: fx.merchantId, purpose: 'THANKS_LETTER' }, data: { body: '{{후원자명}} 님 {{기관명}} {{후원자이름}}' } });
    const r = await thanks();
    if (!r.ok) throw new Error(r.reason);
    const row = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.issuedId } });
    expect(row.preflightWarnings.join(' ')).toContain('후원자이름');
  });

  it('저니 문서 단계가 PREFLIGHT 로 막히면 재시도 없이 막힌 일(FAILED)로 남고, 고친 뒤 다시 실행하면 보낸다', async () => {
    registerDefaultConsumers();
    await ensureDefaultPurposeTemplates(fx.merchantId, ['THANKS_LETTER']);
    // 기관이 감사장 본문에 금액을 넣었는데 0원 결제 맥락(데이터 오류)을 흉내
    await prisma.documentTemplate.updateMany({ where: { merchantId: fx.merchantId, purpose: 'THANKS_LETTER' }, data: { body: '{{후원자명}} 님 {{금액}} {{기관명}}' } });
    const run = await prisma.journeyRun.create({
      data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'donation-thanks', triggerKey: `donation-thanks:${newId()}`, payerId, context: { amount: '0' }, startedAt: new Date() },
    });
    await advanceRun(run.id);
    let r = await prisma.journeyRun.findUniqueOrThrow({ where: { id: run.id }, include: { logs: true } });
    expect(r.status).toBe('FAILED');
    expect(r.attempts).toBe(0);
    expect(r.lastError?.startsWith(PREFLIGHT_BLOCK_PREFIX)).toBe(true);
    expect(r.logs.some((l) => l.outcome === 'BLOCKED')).toBe(true);
    // 보내지 않았으므로 발송 예약(sent)이 남지 않는다
    expect(r.logs.filter((l) => l.sent)).toHaveLength(0);
    // 승인 대기함 막힌 일 + 원인 묶음
    const box = await inboxItems(fx.merchantId);
    expect(box.blocked.find((b) => b.key === `run:${run.id}`)?.retryRunId).toBe(run.id);
    const groups = await loadInboxGroups(fx.merchantId);
    expect(groups.find((g) => g.group?.kind === 'JOURNEY_FAILED.PREFLIGHT')?.group?.affectedCount).toBe(1);

    // 고침: 본문에서 금액을 뺀다 → 다시 실행
    await prisma.documentTemplate.updateMany({ where: { merchantId: fx.merchantId, purpose: 'THANKS_LETTER' }, data: { body: '{{후원자명}} 님 감사합니다 {{기관명}}' } });
    await retryJourneyRun(fx.merchantId, run.id);
    r = await prisma.journeyRun.findUniqueOrThrow({ where: { id: run.id }, include: { logs: true } });
    expect(r.status).not.toBe('FAILED');
    expect(await prisma.issuedDocument.count({ where: { purpose: 'THANKS_LETTER' } })).toBe(1);
    // 두 번 다시 실행은 거절(조건부)
    await expect(retryJourneyRun(fx.merchantId, run.id)).rejects.toThrow();
  });

  it('미리보기·점검은 저장·발송하지 않는다', async () => {
    await ensureDefaultPurposeTemplates(fx.merchantId, ['THANKS_LETTER']);
    const t = await prisma.documentTemplate.findFirstOrThrow({ where: { merchantId: fx.merchantId, purpose: 'THANKS_LETTER' } });
    const before = readMockOutbox(50).length;
    const p = await previewTemplateWithStress(fx.merchantId, t.id);
    expect(p?.preflight.level).toBe('warn');
    expect(p?.html).toContain('가나다라마바사');
    const s = await previewSamples(fx.merchantId, t, [
      { key: 'a', label: 'a', values: { 후원자명: '김', 금액: '1,000원', 날짜: '2026-01-01', 캠페인: '겨울', 발급일: '2026-01-01', 기관명: '해오름', 대표자: '이' } },
      { key: 'b', label: 'b', values: { 후원자명: '이', 금액: '1,000원', 기관명: '해오름' } },
    ]);
    expect(s.map((x) => x.kind)).toEqual(['normal', 'blank']);
    expect(s[1]!.missing.length).toBeGreaterThan(0);
    expect(await prisma.issuedDocument.count()).toBe(0);
    expect(readMockOutbox(50).length).toBe(before);
  });

  it('파일 서식 점검: 첫 쪽 PDF 미리보기를 메모리로 만들고, 긴 이름이 칸을 넘으면 warn', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]);
    const baseUrl = await putObject(newObjectName('pdf'), Buffer.from(await doc.save()), 'application/octet-stream');
    const layout = { v: 1, fonts: [], edits: [{ id: 'e1', page: 1, kind: 'replace', matrix: [12, 0, 0, 12, 20, 100], width: 60, text: '{{후원자명}}', font: { baseFont: 'Helvetica', serif: false, bold: false }, color: [0, 0, 0], cover: [1, 1, 1] }] };
    const t = await prisma.documentTemplate.create({
      data: { id: newId(), merchantId: fx.merchantId, name: '파일 감사장', templateType: 'FILE', fileUrl: baseUrl, fileName: 'a.pdf', basePdfUrl: baseUrl, basePdfHash: 'x', pdfLayout: layout, purpose: 'THANKS_LETTER', requireSignature: false },
    });
    const r = await preflightDocument(t, { values: { 후원자명: stressSampleValues().후원자명 }, recipient: { hasContact: true } });
    expect(r.issues.some((i) => i.code === 'TEXT_OVERFLOW' && i.field === '후원자명')).toBe(true);
    const ok = await preflightDocument(t, { values: { 후원자명: '김' }, recipient: { hasContact: true } });
    expect(ok.level).toBe('ok');
    const p = await previewTemplateWithStress(fx.merchantId, t.id);
    expect(p?.pdfDataUrl?.startsWith('data:application/pdf;base64,')).toBe(true);
    const one = await PDFDocument.load(Buffer.from(p!.pdfDataUrl!.split(',')[1]!, 'base64'));
    expect(one.getPageCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('[G] 예외 묶음', () => {
  it('다른 영역 제공자를 같은 형식으로 넣고, 하나가 실패해도 나머지는 보인다', async () => {
    const extra: InboxExceptionGroup = {
      kind: 'RECURRING_ACTION_REQUIRED', title: '정기후원 조치 필요', reason: '계좌 문제 3명', affectedCount: 3, amount: 90000n,
      oldestAt: new Date(Date.now() - 3 * 86_400_000), href: '/studio/recurring', recommendedAction: '재등록 안내', severity: 'high',
    };
    registerInboxGroupProvider('recurring-recovery', async () => extra, '정기후원 복구');
    registerInboxGroupProvider('broken', async () => {
      throw new Error('boom');
    }, '고장 난 묶음');
    const groups = await loadInboxGroups(fx.merchantId);
    expect(groups.find((g) => g.group?.kind === 'RECURRING_ACTION_REQUIRED')?.group).toEqual(extra);
    const broken = groups.find((g) => g.provider === 'broken');
    expect(broken).toMatchObject({ group: null, error: '불러오지 못함', errorLabel: '고장 난 묶음' });
    // 화면 조립도 깨지지 않는다
    const ov = await inboxOverview(fx.merchantId);
    expect(ov.groups.at(-1)?.provider).toBe('broken');
  });

  it('정렬: 기한 넘김 → 먼저 처리(high) → 영향 큰 순 → 오래된 순', () => {
    const mk = (kind: string, n: number, days: number, severity?: 'high') => ({
      key: `group:${kind}`, provider: kind,
      group: { kind, title: kind, reason: '', affectedCount: n, oldestAt: new Date(Date.now() - days * 86_400_000), href: '/', recommendedAction: '', severity },
    });
    const sorted = sortInboxGroups([mk('a', 1, 1), mk('b', 5, 1), mk('c', 5, 3), mk('d', 1, 1, 'high'), mk('e', 1, 0)], (k) => k === 'group:e');
    expect(sorted.map((x) => x.provider)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('연간 영수증 준비 묶음: 안내 가능 / 연락 확인 필요(탈퇴·수신 거부·차단) 로 나누고, 안내는 저니 경로로 한 번만', async () => {
    registerDefaultConsumers();
    await makeIssuer('YEARLY');
    const year = new Date().getUTCFullYear() - 1;
    const a = await seedPayer('01011110001', '가');
    const b = await seedPayer('01011110002', '나');
    const optOut = await seedPayer('01011110003', '다');
    const gone = await seedPayer('01011110004', '라', 'WITHDRAWN');
    const ready = await seedPayer('01011110005', '마');
    for (const p of [a, b, optOut, gone, ready]) await paidLastYear(p.id, 10000n, year);
    await receiptProfile(ready.id, '홍길동', '9001011234567');
    await prisma.payerMerchantLink.create({ data: { id: newId(), payerId: optOut.id, merchantId: fx.merchantId, noticeOptOutAt: new Date() } });
    // 1~2월이 아니어도 일괄 발급 요청이 살아 있으면 보인다
    await requestApproval({ merchantId: fx.merchantId, kind: 'RECEIPT_BATCH', title: '영수증', dedupeKey: 'rb:x', payload: { taxYear: year, readyCount: 1, total: 10000 } });

    const seg = await receiptInfoSegments(fx.merchantId, year);
    expect(seg.total).toBe(4);
    expect(seg.contactable.sort()).toEqual([a.id, b.id].sort());
    expect(seg.unreachable.map((u) => u.why).sort()).toEqual(['수신 거부', '탈퇴']);
    const groups = await loadInboxGroups(fx.merchantId);
    const g = groups.find((x) => x.group?.kind === 'RECEIPT_INFO_MISSING')!.group!;
    expect(g.reason).toContain('안내 가능 2명');
    expect(g.reason).toContain('연락 확인 필요 2명');
    expect(g.actions?.[0]).toMatchObject({ label: '2명에게 등록 안내 보내기', action: 'receipt.send_info' });

    const r1 = await runInboxGroupAction({ merchantId: fx.merchantId, userId: fx.merchantUserId, action: 'receipt.send_info', payload: { taxYear: String(year) } });
    expect(r1.done).toBe(2);
    // 동시·반복 눌러도 같은 사람·같은 해는 한 번
    await Promise.all([1, 2].map(() => runInboxGroupAction({ merchantId: fx.merchantId, userId: fx.merchantUserId, action: 'receipt.send_info', payload: { taxYear: String(year) } })));
    expect(await prisma.domainEvent.count({ where: { type: 'receipt.info_needed' } })).toBe(2);
    await processDomainEvents();
    const sent = readMockOutbox(50).filter((m) => m.template === 'RECEIPT_INFO_REQUEST');
    expect(sent).toHaveLength(2);
    // 이미 안내한 사람은 다음에 "이미 안내함" 으로 빠진다
    const again = await receiptInfoSegments(fx.merchantId, year);
    expect(again.contactable).toHaveLength(0);
    expect(again.alreadyGuided).toBe(2);
  });

  it('게시 결과 미확인(UNKNOWN)은 다시 실행 버튼이 없고 결과 확인만, 실패는 따로 묶는다', async () => {
    const item = await prisma.contentItem.create({ data: { id: newId(), merchantId: fx.merchantId, kind: 'CARD_NEWS', title: '카드', status: 'APPROVED', provider: 'mock', createdBy: 'test' } });
    await prisma.contentPublish.create({ data: { id: newId(), itemId: item.id, platform: 'INSTAGRAM', status: 'UNKNOWN', scheduledAt: new Date() } });
    await prisma.contentPublish.create({ data: { id: newId(), itemId: item.id, platform: 'FACEBOOK', status: 'FAILED', scheduledAt: new Date() } });
    const groups = await loadInboxGroups(fx.merchantId);
    const unknown = groups.find((g) => g.group?.kind === 'PUBLISH_UNKNOWN')!.group!;
    expect(unknown.actions).toEqual([]);
    expect(unknown.recommendedAction).toContain('확인');
    expect(groups.find((g) => g.group?.kind === 'PUBLISH_FAILED')?.group?.affectedCount).toBe(1);
  });

  it('전자서명 미완료: 미열람/열람 후 미서명/만료 임박으로 나누고, 재안내는 서명자마다 하루 1회', async () => {
    const a = await issuePurposeDocument({ merchantId: fx.merchantId, purpose: 'SUPPORT_AGREEMENT', payerId, context: { amount: 20000n, dayOfMonth: 5 }, dedupeKey: 'e:1' });
    const p2 = await seedPayer('01022220002', '나');
    const b = await issuePurposeDocument({ merchantId: fx.merchantId, purpose: 'SUPPORT_AGREEMENT', payerId: p2.id, context: { amount: 20000n, dayOfMonth: 5 }, dedupeKey: 'e:2' });
    if (!a.ok || !b.ok) throw new Error('발송 실패');
    const eb = (await prisma.issuedDocument.findUniqueOrThrow({ where: { id: b.issuedId } })).envelopeId!;
    await prisma.eDocSigner.updateMany({ where: { envelopeId: eb }, data: { status: 'VIEWED', viewedAt: new Date() } });
    await prisma.eDocEnvelope.update({ where: { id: eb }, data: { expiresAt: new Date(Date.now() + 2 * 86_400_000) } });
    const g = (await loadInboxGroups(fx.merchantId)).find((x) => x.group?.kind === 'ESIGN_PENDING')!.group!;
    expect(g.reason).toContain('미열람 1');
    expect(g.reason).toContain('열람 후 미서명 1');
    expect(g.reason).toContain('만료 임박(3일) 1');
    const before = readMockOutbox(50).filter((m) => m.template === 'EDOC_SIGN_REQUEST').length;
    const [r1, r2] = await Promise.all([1, 2].map(() => runInboxGroupAction({ merchantId: fx.merchantId, userId: fx.merchantUserId, action: 'edoc.remind', payload: { segment: 'unviewed' } })));
    expect(r1!.done + r2!.done).toBe(1);
    const r3 = await runInboxGroupAction({ merchantId: fx.merchantId, userId: fx.merchantUserId, action: 'edoc.remind', payload: { segment: 'unviewed' } });
    expect(r3.done).toBe(0);
    expect(readMockOutbox(50).filter((m) => m.template === 'EDOC_SIGN_REQUEST').length).toBe(before + 1);
  });

  it('잔액 부족으로 막힌 자동 발송: 막힌 건수와 필요 금액', async () => {
    await prisma.eDocWallet.create({ data: { merchantId: fx.merchantId, balance: 0, trialRemaining: 0, totalUsed: 0 } });
    const run = await prisma.journeyRun.create({ data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'x', triggerKey: `x:${newId()}`, payerId, status: 'WAITING', dueAt: new Date(Date.now() + 86_400_000) } });
    await prisma.journeyStepLog.create({ data: { id: newId(), runId: run.id, stepIndex: 0, stepKey: 's', outcome: 'BLOCKED', detail: '전자문서 이용 잔액 부족 — 충전 후 다시 시도', merchantId: fx.merchantId, payerId } });
    const g = (await loadInboxGroups(fx.merchantId)).find((x) => x.group?.kind === 'EDOC_BALANCE')!.group!;
    expect(g.affectedCount).toBe(1);
    expect(g.amount).toBeGreaterThan(0n);
    expect(g.href).toBe('/studio/document-billing');
  });

  it('실패 이유 분류', () => {
    expect(journeyFailureClass(`${PREFLIGHT_BLOCK_PREFIX}: x`).code).toBe('PREFLIGHT');
    expect(journeyFailureClass('같은 오류').code).toBe(journeyFailureClass('같은 오류').code);
    expect(journeyFailureClass('a').code).not.toBe(journeyFailureClass('b').code);
  });
});

// ---------------------------------------------------------------------------
describe('[A] 배정·기한·배지', () => {
  it('배지 수는 지금처럼 항목 수(묶음 기준이 아님) — 회귀', async () => {
    const p = await seedRegisteredPayer('01099990000');
    await requestApproval({ merchantId: fx.merchantId, kind: 'RECEIPT_BATCH', title: 'r', dedupeKey: 'b:1', payload: { taxYear: 2025 } });
    await requestApproval({ merchantId: fx.merchantId, kind: 'JOURNEY_STEP', title: 'j', dedupeKey: 'b:2' });
    await prisma.volunteerApplication.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: p.id, status: 'RECEIVED' } });
    // 묶음·막힌 일은 배지에 들어가지 않는다
    await prisma.journeyRun.create({ data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'x', triggerKey: `x:${newId()}`, status: 'FAILED', finishedAt: new Date(), lastError: 'e' } });
    expect(await inboxActionCount(fx.merchantId)).toBe(3);
    const ov = await inboxOverview(fx.merchantId);
    expect(ov.actions).toHaveLength(3);
    expect(ov.nowCount).toBe(4);
  });

  it('판단 정보: 영수증 일괄 발급은 대상 수·금액, 기다린 시간 표기', async () => {
    await requestApproval({ merchantId: fx.merchantId, kind: 'RECEIPT_BATCH', title: 'r', dedupeKey: 'b:1', payload: { taxYear: 2025, readyCount: 12, total: 360000n } });
    const ov = await inboxOverview(fx.merchantId);
    expect(ov.actions[0]).toMatchObject({ affectedCount: 12, amount: 360000n });
    expect(ov.actions[0]!.decision.recommendedAction).toContain('승인');
    expect(waitedLabel(30 * 60_000)).toBe('1시간 안');
    expect(waitedLabel(5 * 3_600_000)).toBe('5시간');
    expect(waitedLabel(3 * 86_400_000)).toBe('3일');
  });

  it('기한 넘긴 항목은 맨 위로, 대표 담당자에게 콘솔 알림 1회(동시 배치에도)', async () => {
    const r1 = await requestApproval({ merchantId: fx.merchantId, kind: 'JOURNEY_STEP', title: '첫째', dedupeKey: 'a:1', payload: { readyCount: 10 } });
    const r2 = await requestApproval({ merchantId: fx.merchantId, kind: 'JOURNEY_STEP', title: '둘째', dedupeKey: 'a:2' });
    await saveInboxAssignment({ merchantId: fx.merchantId, userId: fx.merchantUserId, itemKey: `approval:${r2.request.id}`, dueAt: new Date(Date.now() - 60_000), memo: '오늘까지' });
    const ov = await inboxOverview(fx.merchantId);
    expect(ov.actions[0]!.title).toBe('둘째');
    expect(ov.actions[0]!.decision.overdue).toBe(true);
    expect(ov.actions[1]!.key).toBe(`approval:${r1.request.id}`);
    expect(ov.overdueCount).toBe(1);

    const [n1, n2] = await Promise.all([notifyOverdueInboxAssignments(), notifyOverdueInboxAssignments()]);
    expect(n1.notified + n2.notified).toBe(1);
    expect(await prisma.notification.count({ where: { userId: fx.merchantUserId, linkUrl: '/studio/inbox' } })).toBe(1);
    expect((await notifyOverdueInboxAssignments()).notified).toBe(0);
    // 기한을 바꾸면 새 기한에 다시 알린다
    await saveInboxAssignment({ merchantId: fx.merchantId, userId: fx.merchantUserId, itemKey: `approval:${r2.request.id}`, dueAt: new Date(Date.now() - 1000) });
    expect((await notifyOverdueInboxAssignments()).notified).toBe(1);
  });

  it('처리돼 사라진 항목의 배정은 알리지 않고 닫는다 / 다른 기관 계정·잘못된 키는 거절', async () => {
    const r = await requestApproval({ merchantId: fx.merchantId, kind: 'JOURNEY_STEP', title: 'x', dedupeKey: 'c:1' });
    await saveInboxAssignment({ merchantId: fx.merchantId, userId: fx.merchantUserId, itemKey: `approval:${r.request.id}`, dueAt: new Date(Date.now() - 1000) });
    await prisma.approvalRequest.update({ where: { id: r.request.id }, data: { status: 'APPROVED' } });
    const out = await notifyOverdueInboxAssignments();
    expect(out).toMatchObject({ notified: 0, closed: 1 });
    await expect(saveInboxAssignment({ merchantId: fx.merchantId, userId: fx.merchantUserId, itemKey: 'nope', dueAt: null })).rejects.toThrow(InboxAssignmentError);
    await expect(saveInboxAssignment({ merchantId: fx.merchantId, userId: fx.merchantUserId, itemKey: 'approval:x', assigneeUserId: 'someone-else' })).rejects.toThrow(InboxAssignmentError);
  });

  it('inbox 배치가 배치 목록에 1시간 주기로 등록되어 있다', () => {
    expect(CRON_JOBS.find((j) => j.name === 'inbox')).toMatchObject({ path: '/api/cron/inbox', intervalSec: 3600 });
  });
});

// ---------------------------------------------------------------------------
describe('[R] 영수증 일괄 발급 승인 전 확인', () => {
  it('대상 수·표본·제외 대상과 이유·비용 0원 — 정보만(발급하지 않음)', async () => {
    await makeIssuer('YEARLY');
    const year = new Date().getUTCFullYear() - 1;
    const a = await seedPayer('01033330001', '가');
    const b = await seedPayer('01033330002', '나');
    const c = await seedPayer('01033330003', '다');
    const gone = await seedPayer('01033330004', '라', 'WITHDRAWN');
    await paidLastYear(a.id, 20000n, year);
    await paidLastYear(b.id, 10000n, year);
    await paidLastYear(c.id, 30000n, year);
    await paidLastYear(gone.id, 40000n, year);
    await receiptProfile(a.id, '김', '9001011000001');
    await receiptProfile(b.id, '가나다라마바사아자차', '9001011000002');
    const req = await requestApproval({ merchantId: fx.merchantId, kind: 'RECEIPT_BATCH', title: 'r', dedupeKey: 'r:1', payload: { taxYear: year, readyCount: 2, total: 30000 } });
    const p = await receiptBatchPreview(fx.merchantId, req.request.id);
    expect(p).not.toBeNull();
    expect(p!.targetCount).toBe(2);
    expect(p!.targetAmount).toBe(30000n);
    expect(p!.expectedCost.amount).toBe(0n);
    expect(p!.excluded.map((e) => [e.reason, e.count]).sort()).toEqual([['NO_PROFILE', 1], ['WITHDRAWN', 1]]);
    expect(p!.samples.map((s) => s.kind)).toEqual(['normal', 'longest']);
    expect(p!.samples.every((s) => !s.residentNoMasked || s.residentNoMasked.includes('*'))).toBe(true);
    expect(await prisma.donationReceipt.count()).toBe(0);
    // 다른 기관·다른 종류는 없음
    expect(await receiptBatchPreview('OTHER', req.request.id)).toBeNull();
  });
});
