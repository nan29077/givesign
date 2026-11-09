import { createHash } from 'node:crypto';
import { prisma } from '@/server/db';
import type { Prisma } from '@/generated/prisma/client';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { featureContentEnabled } from '@/lib/env';
import { maskPhone, normalizePhone } from '@/lib/crypto';
import { hasCandidates, maskResidentNumbers, parseOrgDocument, type OrgDocCandidates } from '@/lib/org-doc-parse';
import { getOcrAdapter, ocrUsable, OCR_MAX_BYTES, OCR_MIME_TYPES, OcrError, type OcrAdapter } from '@/server/adapters/ocr';
import { deletePrivateObject, putPrivateObject } from '@/server/uploads';
import { PAID_STATUSES } from '@/components/studio/shared';
import { recordAiUsage } from './ai-usage';
import { isUsableTestPhone, sandboxInjectMo, sandboxSucceed } from './sandbox';
import { isMockPaymentProvider, isMockMoProvider } from './onboarding-mode';

/**
 * 기관 도입 자동 (2026-11-12 4차 과제 I2).
 *
 *  - 도입 체크리스트 `/studio/start`: 단계마다 기존 화면으로 연결하고, 진행 상태는 **원천에서 계산**한다(체크를 따로 저장하지 않음).
 *    예외는 "해당 없음으로 건너뛰기"(예: 가져올 기존 명단이 없음)와 "다 봤음 — 숨기기" 두 가지뿐이라 system_setting 한 줄
 *    (`onboarding:{기관 id}`)에 남긴다.
 *  - 서류로 기본 정보 채우기: 고유번호증·사업자등록증 그림·PDF → OCR 어댑터 → 이름·번호·대표자·주소 **후보**(입력칸 채우기만,
 *    저장은 담당자). mock 이면 읽지 않고 "자동 읽기는 연결 후 사용". 원본은 비공개 저장소, 주민번호 꼴은 가린다.
 *  - 시험 후원·시험 문서: 담당자 번호로 시험 문자 수신 → 회신 → 결제 성공을 **샌드박스(sandbox_charge·sandbox_message)** 에서
 *    시뮬레이션한다 — 샌드박스 규칙 재사용: charge·정산 원장·영수증·집계에 아무것도 생기지 않는다(물리 분리). 시험 문서는 기관 감사장 서식을
 *    담당자 이름으로 렌더·점검만 한다(저장·발송·이용요금 차감 없음).
 */

export class OnboardingError extends Error {}

const SETTING_KEY = (merchantId: string) => `onboarding:${merchantId}`;

/** 대시보드 안내를 보이는 신규 기관 기간(승인일부터) */
export const NEW_MERCHANT_DAYS = 90;

export const ONBOARDING_STEPS = ['profile', 'templates', 'supporters', 'campaign', 'content', 'testDonation', 'testDocument', 'channel'] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];
/** 해당 없음으로 건너뛸 수 있는 단계 */
export const SKIPPABLE_STEPS: readonly OnboardingStepKey[] = ['supporters', 'content', 'channel'];

export interface OnboardingStep {
  key: OnboardingStepKey;
  label: string;
  description: string;
  done: boolean;
  skipped: boolean;
  href: string;
  linkLabel: string;
  /** 지금 상태 한 줄 */
  status: string;
}

interface OnboardingState {
  skipped: OnboardingStepKey[];
  dismissedAt: string | null;
}

async function readState(merchantId: string): Promise<OnboardingState> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY(merchantId) } });
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const skipped = Array.isArray(v.skipped) ? (v.skipped as string[]).filter((k): k is OnboardingStepKey => (SKIPPABLE_STEPS as readonly string[]).includes(k)) : [];
  return { skipped, dismissedAt: typeof v.dismissedAt === 'string' ? v.dismissedAt : null };
}

async function writeState(merchantId: string, state: OnboardingState, userId: string) {
  const value = state as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: SETTING_KEY(merchantId) }, create: { key: SETTING_KEY(merchantId), value, updatedBy: userId, memo: '기관 도입 체크리스트(건너뛴 단계·숨김)' }, update: { value, updatedBy: userId } });
}

export async function setOnboardingSkip(merchantId: string, userId: string, step: string, skip: boolean) {
  if (!(SKIPPABLE_STEPS as readonly string[]).includes(step)) throw new OnboardingError('건너뛸 수 없는 단계입니다.');
  const s = await readState(merchantId);
  const set = new Set(s.skipped);
  if (skip) set.add(step as OnboardingStepKey);
  else set.delete(step as OnboardingStepKey);
  await writeState(merchantId, { ...s, skipped: [...set] }, userId);
}

export async function dismissOnboarding(merchantId: string, userId: string, dismiss = true) {
  const s = await readState(merchantId);
  await writeState(merchantId, { ...s, dismissedAt: dismiss ? new Date().toISOString() : null }, userId);
}

export async function onboardingChecklist(merchantId: string) {
  const [m, templates, imports, contacts, campaigns, approvedContent, realPaid, lastTest, edocSent, issuedSent, alimtalk, state] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { businessNo: true, representativeName: true, address: true, displayName: true, approvedAt: true, createdAt: true } }),
    prisma.documentTemplate.count({ where: { merchantId, purpose: { not: null }, archivedAt: null } }),
    prisma.supporterImport.count({ where: { merchantId } }),
    prisma.supporterContact.count({ where: { merchantId } }),
    prisma.campaign.count({ where: { merchantId, status: { not: 'ARCHIVED' } } }),
    featureContentEnabled() ? prisma.contentItem.count({ where: { merchantId, approvedAt: { not: null } } }) : Promise.resolve(0),
    prisma.charge.count({ where: { merchantId, isTest: false, status: { in: PAID_STATUSES } } }),
    prisma.onboardingTestRun.findFirst({ where: { merchantId }, orderBy: { createdAt: 'desc' } }),
    prisma.eDocEnvelope.count({ where: { merchantId } }),
    prisma.issuedDocument.count({ where: { merchantId, sentAt: { not: null } } }),
    prisma.merchantAlimtalkChannel.findUnique({ where: { merchantId }, select: { status: true } }),
    readState(merchantId),
  ]);
  const skipped = new Set(state.skipped);
  const profileOk = Boolean(m.businessNo && m.representativeName && m.address);
  const testPaid = await prisma.onboardingTestRun.count({ where: { merchantId, paymentOk: true } });
  const testDoc = await prisma.onboardingTestRun.count({ where: { merchantId, documentOk: true } });
  const steps: OnboardingStep[] = [
    { key: 'profile', label: '기관 정보', description: '고유번호·대표자·소재지. 고유번호증·사업자등록증 사진으로 채울 수 있습니다.', done: profileOk, skipped: false, href: '/studio/profile', linkLabel: '기관 정보', status: profileOk ? '입력됨' : '고유번호·대표자·소재지 중 빈 칸이 있습니다' },
    { key: 'templates', label: '기본 서식 세트 확인', description: '감사장·확인서·약정서 기본 서식. 기관 이름·직인이 들어간 서식으로 바꿀 수 있습니다.', done: templates > 0, skipped: false, href: '/studio/documents?tab=purposes', linkLabel: '서식 보기', status: templates > 0 ? `용도별 서식 ${templates}개` : '아직 서식이 없습니다(기관 승인 때 기본 세트가 만들어집니다)' },
    { key: 'supporters', label: '기존 후원자 명단 가져오기', description: '기관이 갖고 있던 명단(CSV). 가져온 분들께 자동으로 문자를 보내지 않습니다.', done: imports > 0 || contacts > 0, skipped: skipped.has('supporters'), href: '/studio/supporters', linkLabel: '명단 가져오기', status: imports > 0 ? `명단 ${contacts}명` : '가져온 명단이 없습니다' },
    { key: 'campaign', label: '첫 캠페인', description: '개설 마법사로 캠페인·키워드·QR·콘텐츠 일정·감사 문구를 한 번에 만듭니다.', done: campaigns > 0, skipped: false, href: '/studio/campaigns/new', linkLabel: '캠페인 만들기', status: campaigns > 0 ? `캠페인 ${campaigns}개` : '캠페인이 없습니다' },
    ...(featureContentEnabled()
      ? [{ key: 'content' as const, label: '첫 콘텐츠(승인)', description: '만든 콘텐츠는 담당자가 승인해야 게시됩니다.', done: approvedContent > 0, skipped: skipped.has('content'), href: '/studio/content', linkLabel: '콘텐츠', status: approvedContent > 0 ? `승인한 콘텐츠 ${approvedContent}개` : '승인한 콘텐츠가 없습니다' }]
      : []),
    { key: 'testDonation', label: '시험 후원', description: '담당자 번호로 문자 수신 → 회신 → 결제까지 시험합니다(시험 거래는 집계·정산·영수증에서 빠집니다).', done: testPaid > 0 || realPaid > 0, skipped: false, href: '/studio/start#test', linkLabel: '시험하기', status: realPaid > 0 ? `실제 후원 ${realPaid}건` : testPaid > 0 ? '시험 성공(시뮬레이션)' : '아직 시험하지 않았습니다' },
    { key: 'testDocument', label: '시험 문서', description: '감사장 서식이 담당자 이름으로 제대로 만들어지는지 점검합니다(발송·차감 없음).', done: testDoc > 0 || edocSent > 0 || issuedSent > 0, skipped: false, href: '/studio/start#test', linkLabel: '시험하기', status: edocSent + issuedSent > 0 ? `보낸 문서 ${edocSent + issuedSent}건` : testDoc > 0 ? '시험 성공' : '아직 시험하지 않았습니다' },
    { key: 'channel', label: '알림 채널', description: '카카오 알림톡 채널을 등록하면 안내가 문자 대신 알림톡으로 나갑니다.', done: alimtalk?.status === 'ACTIVE' || alimtalk?.status === 'PENDING', skipped: skipped.has('channel'), href: '/studio/notices', linkLabel: '알림톡 설정', status: alimtalk?.status === 'ACTIVE' ? '사용 중' : alimtalk?.status === 'PENDING' ? '관리자 확인 대기' : '등록하지 않음(문자로 안내)' },
  ];
  const finished = steps.every((s) => s.done || s.skipped);
  return {
    steps,
    doneCount: steps.filter((s) => s.done || s.skipped).length,
    total: steps.length,
    finished,
    dismissed: Boolean(state.dismissedAt),
    /** 대시보드 안내를 보일지 — 신규 기관(승인 90일 안)만, 다 끝났거나 숨겼으면 숨김 */
    showPrompt: !finished && !state.dismissedAt && Date.now() - (m.approvedAt ?? m.createdAt).getTime() < NEW_MERCHANT_DAYS * 86_400_000,
    lastTest,
    orgName: m.displayName,
  };
}

// ---------------------------------------------------------------------------
// 서류로 기본 정보 채우기 (OCR)
// ---------------------------------------------------------------------------

export function ocrAvailability(adapter: OcrAdapter = getOcrAdapter()) {
  return { usable: ocrUsable(adapter), mode: adapter.info().mode, provider: adapter.info().provider };
}

function sniffMime(buf: Buffer, declared: string): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  void declared;
  return null;
}

export interface OrgDocScanResult {
  scanId: string;
  candidates: OrgDocCandidates;
  found: boolean;
}

/**
 * 서류 읽기. 원본을 비공개 저장소에 둔 뒤 OCR → 후보. 저장소·OCR 실패면 올린 파일을 지운다.
 * mock(또는 키 없음)이면 아무것도 저장하지 않고 OnboardingError("자동 읽기는 연결 후 사용").
 */
export async function scanOrgDocument(input: { merchantId: string; userId: string; buffer: Buffer; mime: string; adapter?: OcrAdapter }): Promise<OrgDocScanResult> {
  const adapter = input.adapter ?? getOcrAdapter();
  if (!ocrUsable(adapter)) throw new OnboardingError('자동 읽기는 글자 읽기(OCR) 공급자를 연결한 뒤 사용할 수 있습니다. 지금은 직접 입력해 주세요.');
  if (input.buffer.length === 0) throw new OnboardingError('파일이 비어 있습니다.');
  if (input.buffer.length > OCR_MAX_BYTES) throw new OnboardingError('파일은 5MB 이하로 올려 주세요.');
  const mime = sniffMime(input.buffer, input.mime);
  if (!mime || !(OCR_MIME_TYPES as readonly string[]).includes(mime)) throw new OnboardingError('PNG·JPG·WEBP 사진이나 PDF 만 올릴 수 있습니다.');
  const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const objectName = `${createHash('sha256').update(`${input.merchantId}:${newId()}`).digest('hex').slice(0, 32)}.${ext}`;
  await putPrivateObject(objectName, input.buffer, mime);
  const info = adapter.info();
  let candidates: OrgDocCandidates = {};
  let status = 'READ';
  let error: string | null = null;
  try {
    const r = await adapter.recognize(input.buffer, mime);
    await recordAiUsage({ merchantId: input.merchantId, feature: 'org_doc_ocr', provider: info.provider, model: info.model, usage: r.usage ?? { inputTokens: 0, outputTokens: 0 }, ok: true }).catch(() => undefined);
    candidates = parseOrgDocument(r.lines.map((l) => ({ text: l.text, confidence: l.confidence })));
    if (!hasCandidates(candidates)) status = 'EMPTY';
  } catch (e) {
    status = 'FAILED';
    error = e instanceof OcrError ? e.message : '글자를 읽지 못했습니다.';
    logger.warn('기관 서류 읽기 실패', { merchantId: input.merchantId, message: (e as Error).message });
    await recordAiUsage({ merchantId: input.merchantId, feature: 'org_doc_ocr', provider: info.provider, model: info.model, usage: { inputTokens: 0, outputTokens: 0 }, ok: false }).catch(() => undefined);
  }
  const scanId = newId();
  try {
    await prisma.orgDocScan.create({
      data: { id: scanId, merchantId: input.merchantId, objectName, mime, sizeBytes: input.buffer.length, provider: info.provider, status, candidates: candidates as unknown as Prisma.InputJsonValue, error, createdBy: input.userId },
    });
  } catch (e) {
    await deletePrivateObject(objectName).catch(() => undefined);
    throw e;
  }
  if (status === 'FAILED') throw new OnboardingError(error ?? '글자를 읽지 못했습니다.');
  return { scanId, candidates, found: status === 'READ' };
}

/** 기관 정보 화면 입력칸 채우기용 — 그 기관이 24시간 안에 읽은 것만 */
export async function scanCandidates(merchantId: string, scanId: string): Promise<OrgDocCandidates | null> {
  const row = await prisma.orgDocScan.findFirst({ where: { id: scanId, merchantId, createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
  if (!row || row.status !== 'READ') return null;
  const c = (row.candidates ?? {}) as OrgDocCandidates;
  // 저장할 때 이미 가렸지만, 읽을 때도 한 번 더 가린다
  for (const k of ['name', 'businessNo', 'representative', 'address'] as const) {
    if (c[k]?.value) c[k]!.value = maskResidentNumbers(c[k]!.value);
  }
  return c;
}

// ---------------------------------------------------------------------------
// 시험 후원 · 시험 문서
// ---------------------------------------------------------------------------

export const TEST_DONATION_AMOUNT = 1000n;

export interface TestStep {
  key: 'MO' | 'REPLY' | 'PAYMENT' | 'DOCUMENT';
  ok: boolean;
  message: string;
}

/** 시험 문서: 기관 감사장(없으면 첫 서명 불필요 용도) 서식을 담당자 이름으로 점검·렌더. 저장·발송·차감 없음 */
async function testDocument(merchantId: string, staffName: string): Promise<TestStep> {
  try {
    const { ensureDefaultPurposeTemplates, purposeNeedsSignature, mergeValuesFromContext } = await import('./purpose-templates');
    await ensureDefaultPurposeTemplates(merchantId).catch(() => []);
    const templates = await prisma.documentTemplate.findMany({ where: { merchantId, purpose: { not: null }, archivedAt: null, active: true }, orderBy: { createdAt: 'asc' } });
    const t = templates.find((x) => x.purpose === 'THANKS_LETTER') ?? templates.find((x) => x.purpose && !purposeNeedsSignature(x.purpose as never));
    if (!t) return { key: 'DOCUMENT', ok: false, message: '시험할 문서 서식이 없습니다. 서식 화면에서 감사장 서식을 확인해 주세요.' };
    const m = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { displayName: true, representativeName: true } });
    const { previewSamples } = await import('./document-preflight');
    const values = mergeValuesFromContext({ donorName: staffName, amount: TEST_DONATION_AMOUNT, totalAmount: TEST_DONATION_AMOUNT, count: 1 }, { merchantName: m.displayName, representative: m.representativeName ?? null });
    const [p] = await previewSamples(merchantId, t, [{ key: 'test', label: '시험(담당자)', values, recipient: { hasContact: true } }]);
    if (!p) return { key: 'DOCUMENT', ok: false, message: '시험 문서를 만들지 못했습니다.' };
    if (p.preflight.level === 'block') return { key: 'DOCUMENT', ok: false, message: `'${t.name}' 서식에 고칠 점이 있어 보내지 못하는 상태입니다. 서식 점검 화면에서 확인해 주세요.` };
    if (t.templateType === 'FILE' && !p.pdfDataUrl) return { key: 'DOCUMENT', ok: false, message: `'${t.name}' 서식 PDF 를 만들지 못했습니다. 서식 편집 화면에서 확인해 주세요.` };
    return { key: 'DOCUMENT', ok: true, message: `'${t.name}' 서식으로 시험 문서를 만들었습니다${p.preflight.level === 'warn' ? '(주의할 점이 있습니다 — 서식 점검 화면 확인)' : ''}. 실제로 보내지 않았고 이용요금도 차감하지 않았습니다.` };
  } catch (e) {
    logger.warn('시험 문서 실패', { merchantId, message: (e as Error).message });
    return { key: 'DOCUMENT', ok: false, message: '시험 문서를 만드는 중 오류가 났습니다.' };
  }
}

/**
 * 시험 후원·시험 문서를 한 번에. 시험 거래는 샌드박스 표에만 생긴다 — 실제 결제·문자·정산·영수증·집계에 영향이 없다.
 * 같은 기관이 1분 안에 다시 누르면 새로 만들지 않고 마지막 결과를 돌려준다(연타 방지).
 */
export async function runOnboardingTest(input: { merchantId: string; userId: string; phone: string; staffName?: string | null; now?: Date }) {
  const phone = normalizePhone(input.phone ?? '');
  if (!isUsableTestPhone(phone)) throw new OnboardingError('담당자 휴대폰 번호(010으로 시작)를 입력해 주세요.');
  const now = input.now ?? new Date();
  const recent = await prisma.onboardingTestRun.findFirst({ where: { merchantId: input.merchantId, createdAt: { gte: new Date(now.getTime() - 60_000) } }, orderBy: { createdAt: 'desc' } });
  if (recent) return { run: recent, reused: true };
  const m = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: input.merchantId }, select: { displayName: true } });
  const steps: TestStep[] = [];
  let transactionNo: string | null = null;
  try {
    const row = await sandboxInjectMo({ merchantId: input.merchantId, merchantName: m.displayName, phone, text: '시험 후원', amount: TEST_DONATION_AMOUNT });
    transactionNo = row.transactionNo;
    steps.push({ key: 'MO', ok: true, message: '시험 문자 수신을 기록했습니다(시뮬레이션 — 통신망을 거치지 않음).' });
    steps.push({ key: 'REPLY', ok: true, message: '금액 선택 회신 문자를 시험 문자함에 남겼습니다(실제로 보내지 않음).' });
    const paid = await sandboxSucceed({ merchantId: input.merchantId, merchantName: m.displayName, transactionNo: row.transactionNo });
    const ok = paid?.status === 'PAYMENT_SUCCESS';
    steps.push({ key: 'PAYMENT', ok, message: ok ? `시험 결제 ${TEST_DONATION_AMOUNT.toString()}원 성공(돈이 움직이지 않음 — 집계·정산·영수증 제외).` : '시험 결제를 확인하지 못했습니다.' });
  } catch (e) {
    logger.warn('시험 후원 실패', { merchantId: input.merchantId, message: (e as Error).message });
    steps.push({ key: 'MO', ok: false, message: '시험 후원을 기록하지 못했습니다.' });
  }
  steps.push(await testDocument(input.merchantId, (input.staffName ?? '').trim().slice(0, 20) || '담당자'));
  const run = await prisma.onboardingTestRun.create({
    data: {
      id: newId(),
      merchantId: input.merchantId,
      phoneMasked: maskPhone(phone),
      simulated: true,
      steps: steps as unknown as Prisma.InputJsonValue,
      moOk: steps.some((s) => s.key === 'REPLY' && s.ok),
      paymentOk: steps.some((s) => s.key === 'PAYMENT' && s.ok),
      documentOk: steps.some((s) => s.key === 'DOCUMENT' && s.ok),
      transactionNo,
      createdBy: input.userId,
      createdAt: now,
    },
  });
  return { run, reused: false, liveHint: liveTestHint() };
}

/** 실제 공급자가 붙어 있을 때 담당자가 직접 해 볼 일(시험은 항상 시뮬레이션이다) */
export function liveTestHint(): string | null {
  if (isMockMoProvider() && isMockPaymentProvider()) return null;
  return '실제 번호로 확인하려면 담당자 휴대폰으로 기관 후원 문자 번호에 "시험" 이라고 보내 보세요. 회신 문자가 오면 문자 수신·회신이 정상입니다(결제는 하지 않아도 됩니다). 결과는 승인 대기함의 작동 점검에 나타납니다.';
}

export function readTestSteps(v: unknown): TestStep[] {
  return Array.isArray(v) ? (v as TestStep[]).filter((s) => s && typeof s.key === 'string') : [];
}
