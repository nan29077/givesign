import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { kstDateKey } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { consumeRateLimit } from '@/server/rate-limit';
import { completeJson, getLlmAdapter, llmUsable, LlmError, type LlmAdapter } from '@/server/adapters/llm';
import { AdapterNotConfiguredError } from '@/server/adapters/types';
import { llmConfig } from '@/lib/env';
import { personalInfoHit, realNameHit } from '@/server/adapters/content/llm-script';
import { THANKS_MT_MAX_LENGTH, THANKS_MT_VARIABLES } from './mt-templates';
import { recordAiUsage, type AiFeature } from './ai-usage';
import { CONTENT_KIND_SHORT, contentConversions } from './content';
import { PLATFORM_LABEL } from '@/server/adapters/sns';
import type { ContentKind, SocialPlatform } from '@/generated/prisma/enums';

/**
 * AI 초안 — 모두 "초안 → 사람이 확인 후 저장/발송" 이다. 이 모듈은 아무것도 저장·발송·게시하지 않는다
 * (성과 요약 캐시만 남긴다). 결과는 화면 입력칸에 채워지고, 담당자가 고쳐서 저장 버튼을 눌러야 반영된다.
 *
 *  - 속도 제한: 기관(또는 관리자)당 분당 AI_DRAFT_PER_MINUTE 회 (consumeRateLimit)
 *  - 비용 기록: 시도마다 ai_usage (실패한 시도 포함)
 *  - 검증: 길이·허용 치환자·개인정보(전화·이메일·주민번호)·실명 패턴·링크·금지어. 어기면 1회 재요청, 그래도 어기면 실패.
 *  - LLM 공급자가 mock 이면 화면은 버튼 대신 "AI 공급자 연결 후 사용" 안내를 보인다(aiDraftAvailability).
 *    서비스 함수는 mock 으로도 돈다(테스트) — mock 응답은 규칙 기반 문장이다.
 */

export class AiDraftError extends Error {}

export function aiDraftAvailability(adapter: LlmAdapter = getLlmAdapter()) {
  const info = adapter.info();
  if (info.mode === 'mock') return { available: false, provider: info.provider, model: info.model, message: 'AI 공급자 연결 후 사용할 수 있습니다. (LLM_PROVIDER 설정 필요)' };
  if (!llmUsable(adapter)) return { available: false, provider: info.provider, model: info.model, message: `AI 공급자 설정이 비어 있습니다: ${info.missingCredentials.join(', ')}` };
  return { available: true, provider: info.provider, model: info.model, message: '' };
}

const DRAFT_SYSTEM_BASE = [
  '당신은 한국 사회복지기관 담당자를 돕는 문안 작성 도우미다. 결과는 초안이며 담당자가 확인·수정한 뒤에만 쓰인다.',
  '수혜자(지원 대상자)의 실명·나이·연락처·주소·학교 등 개인을 특정할 수 있는 정보를 쓰지 않는다.',
  '과장, 죄책감·공포 자극, 확인되지 않은 수치를 쓰지 않는다. 주어진 자료에 있는 사실만 쓴다.',
  '링크(주소)·전화번호·계좌번호를 쓰지 않는다. 이모지를 쓰지 않는다. 정중한 존댓말.',
].join('\n');

/** 계좌번호 모양(숫자-숫자-숫자). 날짜(2026-11-06)는 제외. */
const ACCOUNT_RE = /(?<!\d)(?!\d{4}-\d{1,2}-\d{1,2}(?!\d))\d{2,6}-\d{2,6}-\d{2,8}(?!\d)/;

export function draftTextViolation(text: string, bannedWords: string[] = []): string | null {
  const pii = personalInfoHit(text);
  if (pii) return `${pii}가 들어 있습니다`;
  if (/https?:\/\/|www\./i.test(text)) return '링크가 들어 있습니다';
  if (ACCOUNT_RE.test(text)) return '계좌번호로 보이는 숫자가 들어 있습니다';
  if (realNameHit(text)) return '실명으로 보이는 표현이 들어 있습니다';
  const hit = bannedWords.find((w) => w && text.includes(w));
  if (hit) return `금지어 "${hit}" 가 들어 있습니다`;
  return null;
}

async function bannedWordsOf(merchantId: string) {
  const s = await prisma.merchantContentSetting.findUnique({ where: { merchantId }, select: { bannedWords: true } });
  return s?.bannedWords ?? [];
}

async function rateLimit(key: string) {
  // 저장소 장애 때 열어 두면 기관당 분당 한도가 사라지고 유료 LLM 호출이 무제한이 된다 → 닫는다(2026-11-06 점검 낮음).
  const r = await consumeRateLimit('ai-draft', key, llmConfig().draftPerMinute, 60, { failClosed: true });
  if (!r.ok && r.count === 0) throw new AiDraftError('AI 초안 요청 한도를 확인할 수 없어 잠시 멈췄습니다. 잠시 뒤 다시 시도해 주세요.');
  if (!r.ok) throw new AiDraftError('AI 초안 요청이 너무 잦습니다. 1분 뒤에 다시 시도해 주세요.');
}

/** 공용 실행기: 속도 제한 → LLM(JSON) + 검증 + 1회 재요청 → 시도별 비용 기록 */
async function runDraft<T>(input: {
  merchantId: string | null;
  rateKey: string;
  feature: AiFeature;
  system: string;
  user: string;
  maxTokens: number;
  mockText: string;
  validate: (d: Record<string, unknown>) => { ok: true; value: T } | { ok: false; reason: string };
}): Promise<T> {
  await rateLimit(input.rateKey);
  const adapter = getLlmAdapter();
  const info = adapter.info();
  try {
    const { value } = await completeJson(
      adapter,
      { system: input.system, user: input.user, json: true, maxTokens: input.maxTokens, mockText: input.mockText },
      input.validate,
      (a) => recordAiUsage({ merchantId: input.merchantId, feature: input.feature, provider: info.provider, model: info.model, usage: a.usage, ok: a.ok }).then(() => undefined),
    );
    return value;
  } catch (e) {
    if (e instanceof AdapterNotConfiguredError) throw new AiDraftError('AI 공급자 설정이 비어 있어 초안을 만들 수 없습니다.');
    if (e instanceof LlmError) throw new AiDraftError(e.retryable ? 'AI 공급자 응답이 없습니다. 잠시 뒤 다시 시도해 주세요.' : `AI 초안을 만들지 못했습니다. (${e.message.slice(0, 120)})`);
    throw e;
  }
}

const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// ---------------------------------------------------------------------------
// 캠페인 초안
// ---------------------------------------------------------------------------

export interface CampaignDraft {
  title: string;
  summary: string;
  story: string;
  usagePlan: string;
}

export async function draftCampaign(merchantId: string, hint: { title?: string } = {}): Promise<CampaignDraft> {
  const [merchant, page, past, banned] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { displayName: true, description: true } }),
    prisma.merchantDonationPage.findUnique({ where: { merchantId }, select: { intro: true } }),
    prisma.campaign.findMany({ where: { merchantId, status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'desc' }, take: 5, select: { title: true, summary: true } }),
    bannedWordsOf(merchantId),
  ]);
  const user = [
    `[기관] ${merchant.displayName}`,
    merchant.description ? `[기관 소개] ${merchant.description.slice(0, 800)}` : null,
    page?.intro ? `[기관 사업] ${page.intro.slice(0, 800)}` : null,
    past.length ? `[지난 캠페인]\n${past.map((p) => `- ${p.title}: ${p.summary}`).join('\n')}` : '[지난 캠페인] 없음',
    hint.title ? `[담당자가 적은 제목] ${hint.title.slice(0, 100)}` : null,
    `[금지어] ${banned.length ? banned.join(', ') : '(없음)'}`,
    '',
    '이 기관의 새 모금 캠페인 초안을 써라. 기관 소개·사업에 근거한 내용만, 구체적인 수혜자 정보 없이.',
    '출력 JSON: {"title": "제목 40자 이내", "summary": "한 줄 소개 120자 이내", "story": "캠페인 이야기 3~5문단, 1500자 이내", "usagePlan": "후원금 사용 계획 항목 3~5개, 600자 이내 (금액은 쓰지 않는다)"}',
  ].filter((l) => l !== null).join('\n');
  const mockText = JSON.stringify({
    title: hint.title?.slice(0, 40) || `${merchant.displayName} 함께 나눔`,
    summary: `${merchant.displayName}가 이웃 곁에서 이어 가는 나눔에 함께해 주세요.`,
    story: `${merchant.displayName}는 지역 이웃의 일상을 돕고 있습니다.\n\n후원해 주신 마음은 기관이 진행하는 사업에 쓰입니다.`,
    usagePlan: '- 사업 운영 물품\n- 프로그램 진행비\n- 결과 보고',
  });
  return runDraft<CampaignDraft>({
    merchantId,
    rateKey: merchantId,
    feature: 'campaign_draft',
    system: DRAFT_SYSTEM_BASE,
    user,
    maxTokens: 2000,
    mockText,
    validate: (d) => {
      const v = { title: s(d.title), summary: s(d.summary), story: s(d.story), usagePlan: s(d.usagePlan) };
      if (!v.title || v.title.length > 40) return { ok: false, reason: 'title 1~40자' };
      if (!v.summary || v.summary.length > 120) return { ok: false, reason: 'summary 1~120자' };
      if (!v.story || v.story.length > 1500) return { ok: false, reason: 'story 1~1500자' };
      if (!v.usagePlan || v.usagePlan.length > 600) return { ok: false, reason: 'usagePlan 1~600자' };
      for (const t of Object.values(v)) {
        const bad = draftTextViolation(t, banned);
        if (bad) return { ok: false, reason: bad };
      }
      return { ok: true, value: v };
    },
  });
}

// ---------------------------------------------------------------------------
// 감사 문자 문구 초안
// ---------------------------------------------------------------------------

const THANKS_TOKENS = THANKS_MT_VARIABLES.map((v) => v.token);

export function thanksDraftViolation(text: string, banned: string[] = []): string | null {
  if (!text) return '빈 문구';
  if (text.length > THANKS_MT_MAX_LENGTH) return `${THANKS_MT_MAX_LENGTH}자 이내`;
  const unknown = [...text.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]).filter((t) => !THANKS_TOKENS.includes(t as (typeof THANKS_TOKENS)[number]));
  if (unknown.length) return `허용되지 않은 치환자 ${unknown[0]}`;
  if (!text.includes('{후원자}')) return '{후원자} 치환자를 넣어야 합니다';
  return draftTextViolation(text, banned);
}

export async function draftThanksMessage(merchantId: string): Promise<{ message: string }> {
  const [merchant, banned] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { displayName: true, description: true } }),
    bannedWordsOf(merchantId),
  ]);
  const user = [
    `[기관] ${merchant.displayName}`,
    merchant.description ? `[기관 소개] ${merchant.description.slice(0, 400)}` : null,
    '',
    '후원이 완료됐을 때 후원자에게 가는 감사 문자 본문 초안을 하나 써라.',
    `쓸 수 있는 치환자는 ${THANKS_TOKENS.join(' ')} 뿐이다(다른 중괄호 표현 금지). {후원자} 는 반드시 넣는다.`,
    `${THANKS_MT_MAX_LENGTH}자 이내(치환 전 기준), 링크·전화번호 금지. 발신 표기 [기브싸인] 은 시스템이 붙이므로 쓰지 않는다.`,
    '출력 JSON: {"message": "본문"}',
  ].filter((l) => l !== null).join('\n');
  return runDraft({
    merchantId,
    rateKey: merchantId,
    feature: 'thanks_draft',
    system: DRAFT_SYSTEM_BASE,
    user,
    maxTokens: 500,
    mockText: JSON.stringify({ message: `{후원자}님, {금액} 후원 감사합니다. 보내 주신 마음은 {사회복지기관}이 이웃을 위해 소중히 쓰겠습니다.` }),
    validate: (d) => {
      const message = s(d.message);
      const bad = thanksDraftViolation(message, banned);
      return bad ? { ok: false, reason: bad } : { ok: true, value: { message } };
    },
  });
}

// ---------------------------------------------------------------------------
// 문의 1차 분류 · 답변 초안 (관리자 1:1 문의 화면)
// ---------------------------------------------------------------------------

export const INQUIRY_AI_CATEGORIES = ['PAYMENT', 'RECEIPT', 'RECURRING', 'VOLUNTEER', 'OTHER'] as const;
export type InquiryAiCategory = (typeof INQUIRY_AI_CATEGORIES)[number];
export const INQUIRY_AI_CATEGORY_LABEL: Record<InquiryAiCategory, string> = {
  PAYMENT: '결제',
  RECEIPT: '영수증',
  RECURRING: '정기후원',
  VOLUNTEER: '봉사',
  OTHER: '기타',
};

/** 공급자로 보내기 전에 문의 본문의 연락처·계좌·주민번호를 가린다(외부 전송 최소화). */
export function maskForLlm(text: string) {
  return text
    // 뒷자리 첫 숫자 1~4 = 주민등록번호, 5~8 = 외국인등록번호(2026-11-06 점검 A-M13).
    .replace(/\d{6}[-\s]?[1-8]\d{6}/g, '[주민번호]')
    .replace(/01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/g, '[전화번호]')
    .replace(/0\d{1,2}[-\s.]\d{3,4}[-\s.]\d{4}/g, '[전화번호]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[이메일]')
    .replace(new RegExp(ACCOUNT_RE.source, 'g'), '[계좌번호]')
    .replace(/\d{10,16}/g, '[번호]');
}

export async function draftInquiryReply(inquiryId: string, adminUserId: string): Promise<{ category: InquiryAiCategory; reply: string }> {
  const inquiry = await prisma.supportInquiry.findUnique({
    where: { id: inquiryId },
    select: { id: true, merchantId: true, category: true, messages: { orderBy: { createdAt: 'asc' }, take: 20, select: { sender: true, body: true } } },
  });
  if (!inquiry) throw new AiDraftError('문의를 찾을 수 없습니다.');
  if (inquiry.messages.length === 0) throw new AiDraftError('문의 내용이 없습니다.');
  const convo = inquiry.messages.map((m) => `${m.sender === 'ADMIN' ? '담당자' : '문의자'}: ${maskForLlm(m.body).slice(0, 800)}`).join('\n');
  const user = [
    '기브싸인(사회복지기관 문자후원 서비스) 고객센터 문의다. 분류하고 답변 초안을 써라.',
    `분류는 ${INQUIRY_AI_CATEGORIES.join('|')} 중 하나 (결제·영수증·정기후원·봉사·기타).`,
    '답변 원칙: 확인되지 않은 처리 결과(환불 완료·발급 완료 등)를 약속하지 않는다. 확인이 필요하면 "확인 후 안내드리겠습니다" 로 쓴다.',
    '결제 링크·인증번호는 문자로만 안내되므로 답변에 쓰지 않는다. 링크·전화번호를 쓰지 않는다. 800자 이내.',
    '',
    '[대화]',
    convo,
    '',
    '출력 JSON: {"category": "PAYMENT", "reply": "답변 초안"}',
  ].join('\n');
  return runDraft({
    merchantId: inquiry.merchantId,
    rateKey: `admin:${adminUserId}`,
    feature: 'inquiry_draft',
    system: DRAFT_SYSTEM_BASE,
    user,
    maxTokens: 1200,
    mockText: JSON.stringify({ category: 'OTHER', reply: '문의 주셔서 감사합니다. 말씀하신 내용을 확인한 뒤 이 창으로 다시 안내드리겠습니다.' }),
    validate: (d) => {
      const category = s(d.category).toUpperCase() as InquiryAiCategory;
      const reply = s(d.reply);
      if (!INQUIRY_AI_CATEGORIES.includes(category)) return { ok: false, reason: 'category 값' };
      if (!reply || reply.length > 800) return { ok: false, reason: 'reply 1~800자' };
      const bad = draftTextViolation(reply);
      return bad ? { ok: false, reason: bad } : { ok: true, value: { category, reply } };
    },
  });
}

// ---------------------------------------------------------------------------
// 콘텐츠 성과 요약 (기관당 하루 1회 캐시)
// ---------------------------------------------------------------------------

export interface ContentInsight {
  summary: string;
  suggestions: string[];
  generatedAt: string;
  dayKey: string;
}

/** 최근 30일 콘텐츠 성과 집계 (원천: 콘텐츠·게시·결제/약정/봉사 신청) */
export async function contentPerformance(merchantId: string, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const items = await prisma.contentItem.findMany({
    where: { merchantId, createdAt: { gte: since }, status: { notIn: ['FAILED', 'ARCHIVED'] } },
    select: { id: true, kind: true, status: true, publishes: { select: { platform: true, status: true } } },
  });
  const conv = await contentConversions(merchantId, items.map((i) => i.id));
  const byKind = new Map<ContentKind, { items: number; donations: number; amount: bigint; pledges: number; volunteers: number }>();
  const byPlatform = new Map<SocialPlatform, number>();
  for (const it of items) {
    const k = byKind.get(it.kind) ?? { items: 0, donations: 0, amount: 0n, pledges: 0, volunteers: 0 };
    const c = conv.get(it.id)!;
    k.items += 1;
    k.donations += c.donations;
    k.amount += c.amount;
    k.pledges += c.pledges;
    k.volunteers += c.volunteers;
    byKind.set(it.kind, k);
    for (const p of it.publishes) if (['PUBLISHED', 'PRIVATE_UPLOADED'].includes(p.status)) byPlatform.set(p.platform, (byPlatform.get(p.platform) ?? 0) + 1);
  }
  return { items: items.length, byKind, byPlatform };
}

function performanceText(p: Awaited<ReturnType<typeof contentPerformance>>) {
  const kinds = [...p.byKind.entries()].map(([k, v]) => `${CONTENT_KIND_SHORT[k]} ${v.items}건 → 후원 ${v.donations}건(${formatNumber(v.amount)}원)·정기 ${v.pledges}·봉사 ${v.volunteers}`);
  const plats = [...p.byPlatform.entries()].map(([k, v]) => `${PLATFORM_LABEL[k]} ${v}건 게시`);
  return [`최근 30일 콘텐츠 ${p.items}건`, ...kinds, plats.length ? plats.join(', ') : '게시 기록 없음'].join('\n');
}

export async function getCachedInsight(merchantId: string): Promise<ContentInsight | null> {
  const row = await prisma.aiCache.findFirst({ where: { merchantId, feature: 'content_insight' }, orderBy: { createdAt: 'desc' } });
  return row ? (row.result as unknown as ContentInsight) : null;
}

export async function contentInsight(merchantId: string, now = new Date()): Promise<{ insight: ContentInsight; cached: boolean }> {
  const dayKey = kstDateKey(now);
  const hit = await prisma.aiCache.findUnique({ where: { merchantId_feature_cacheKey: { merchantId, feature: 'content_insight', cacheKey: dayKey } } });
  if (hit) return { insight: hit.result as unknown as ContentInsight, cached: true };
  const perf = await contentPerformance(merchantId, now);
  const facts = performanceText(perf);
  const best = [...perf.byKind.entries()].sort((a, b) => b[1].donations - a[1].donations)[0];
  const mockText = JSON.stringify({
    summary: perf.items ? `${facts.split('\n')[0]}을 만들었습니다.${best && best[1].donations ? ` 후원 전환은 ${CONTENT_KIND_SHORT[best[0]]}이 가장 많았습니다.` : ' 아직 콘텐츠로 들어온 후원은 없습니다.'}` : '최근 30일에 만든 콘텐츠가 없습니다.',
    suggestions: perf.items ? ['전환이 높은 형식을 캘린더 형식 목록 앞에 두어 보세요.'] : ['콘텐츠 캘린더를 켜 두면 정한 요일에 자동으로 만들어집니다.'],
  });
  const value = await runDraft({
    merchantId,
    rateKey: merchantId,
    feature: 'content_insight',
    system: DRAFT_SYSTEM_BASE,
    user: [
      '사회복지기관의 최근 30일 SNS 콘텐츠 성과다. 숫자는 아래에 있는 것만 쓰고 새 숫자를 지어내지 않는다.',
      facts,
      '',
      '담당자에게 보여 줄 요약(300자 이내)과 다음에 해 볼 제안 1~3개(각 100자 이내)를 써라. 광고성 발송·문자 대량 발송은 제안하지 않는다.',
      '출력 JSON: {"summary": "요약", "suggestions": ["제안"]}',
    ].join('\n'),
    maxTokens: 800,
    mockText,
    validate: (d) => {
      const summary = s(d.summary);
      const suggestions = (Array.isArray(d.suggestions) ? d.suggestions : []).map(s).filter(Boolean);
      if (!summary || summary.length > 300) return { ok: false, reason: 'summary 1~300자' };
      if (suggestions.length < 1 || suggestions.length > 3 || suggestions.some((x) => x.length > 100)) return { ok: false, reason: 'suggestions 1~3개, 각 100자' };
      const bad = [summary, ...suggestions].map((t) => draftTextViolation(t)).find(Boolean);
      return bad ? { ok: false, reason: bad } : { ok: true, value: { summary, suggestions } };
    },
  });
  const insight: ContentInsight = { ...value, generatedAt: now.toISOString(), dayKey };
  await prisma.aiCache.createMany({
    data: [{ id: newId(), merchantId, feature: 'content_insight', cacheKey: dayKey, result: insight as unknown as object }],
    skipDuplicates: true,
  });
  return { insight, cached: false };
}
