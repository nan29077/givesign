import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { campaignSchema } from '@/lib/fundraising';
import { llmConfig } from '@/lib/env';
import { saveCampaign, setCampaignStatus } from '@/server/services/fundraising';
import {
  anthropicAdapter,
  completeJson,
  getLlmAdapter,
  llmCostKrw,
  LlmError,
  mockLlmAdapter,
  openaiAdapter,
} from '@/server/adapters/llm';
import { AdapterNotConfiguredError } from '@/server/adapters/types';
import { getContentAdapter, renderSceneSvg } from '@/server/adapters/content';
import { CONTENT_SYSTEM_PROMPT } from '@/server/adapters/content/llm-script';
import { assembleVideo, buildFfmpegArgs } from '@/server/adapters/content/video';
import {
  approveContent,
  connectSocialChannel,
  logoDataUri,
  renderCaption,
  renderPlatformPost,
  requestContent,
  type Scene,
} from '@/server/services/content';
import { adaptCaption, PLATFORM_CAPTION_RULES } from '@/server/services/content-captions';
import { calendarBlockers, calendarPreview, calendarSlots, effectiveDays, fillNextSlot, pickCampaign, runContentCalendar } from '@/server/services/content-calendar';
import {
  AiDraftError,
  contentInsight,
  draftCampaign,
  draftInquiryReply,
  draftTextViolation,
  draftThanksMessage,
  maskForLlm,
  thanksDraftViolation,
} from '@/server/services/ai-drafts';
import { aiUsageThisMonth } from '@/server/services/ai-usage';
import { PLATFORM_KINDS } from '@/server/adapters/sns';
import { resetDb, seedBasics, type Fixture } from './helpers';

/**
 * 고도화 5단계 — AI 실연동 어댑터 · 콘텐츠 캘린더(자율 생성) · 카드뉴스/피드 · 플랫폼 확장 · AI 초안.
 *
 * 실제 네트워크는 쓰지 않는다. globalThis.fetch 를 가짜로 바꿔 요청 형태·응답 파싱·재요청·실패를 본다.
 */

let fx: Fixture;
const ENV_KEYS = ['LLM_PROVIDER', 'LLM_MODEL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'LLM_KRW_PER_1K_INPUT', 'LLM_KRW_PER_1K_OUTPUT', 'CONTENT_PROVIDER', 'AI_DRAFT_PER_MINUTE', 'FFMPEG_PATH'];
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
let calls: FakeCall[] = [];

/** 응답 목록을 차례로 돌려주는 가짜 fetch. 항목: {status, json} */
function fakeFetch(responses: Array<{ status?: number; json: unknown }>) {
  calls = [];
  let i = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? '{}')) });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const anthropicText = (text: string, inTok = 1000, outTok = 500) => ({ json: { content: [{ type: 'text', text }], usage: { input_tokens: inTok, output_tokens: outTok } } });

function useAnthropic() {
  process.env.LLM_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.LLM_KRW_PER_1K_INPUT = '4';
  process.env.LLM_KRW_PER_1K_OUTPUT = '20';
}

async function seedCampaign(code = 'KIMJANG', over: Partial<{ title: string; goalAmount: number; endsOn: string }> = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const c = await saveCampaign(fx.merchantId, campaignSchema.parse({
    code, title: over.title ?? '김장 나눔', summary: '홀몸 어르신 김장 나눔', story: '올겨울 300가구에 김장김치를 전합니다. 함께해 주세요.',
    beneficiary: '홀몸 어르신 300가구', usagePlan: '김장 재료비와 배송비', goalAmount: over.goalAmount ?? 3000000, startsOn: '2026-01-01', endsOn: over.endsOn ?? '2099-12-31',
  }));
  await setCampaignStatus(fx.merchantId, c.id, 'ACTIVE');
  void today;
  return c;
}

async function withRegNo() {
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { fundraisingRegNo: '2026-서울-00999' } });
}

/** 카드뉴스용 유효한 LLM 응답 */
function cardNewsJson(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: '함께 담그는 겨울 김장',
    scenes: [
      { label: '표지', caption: '올겨울, 김장 한 통의 온기' },
      { label: '문제', caption: '홀로 겨울을 나는 이웃에게 김장은 큰 부담입니다.' },
      { label: '사연', caption: '해마다 기다려 주시는 이웃이 계십니다.' },
      { label: '사용계획', caption: '모인 후원금은 김장 재료와 배송에 쓰입니다.' },
      { label: '마무리', caption: '따뜻한 겨울을 함께 만들어 주세요.' },
    ],
    hashtags: ['김장나눔', '겨울나눔', '이웃사랑'],
    platforms: {
      YOUTUBE: { title: '함께 담그는 겨울 김장', body: '올겨울 김장 나눔에 함께해 주세요.' },
      INSTAGRAM: { body: '올겨울 김장 나눔 소식입니다.' },
      FACEBOOK: { body: '김장 나눔에 함께해 주세요.' },
      TIKTOK: { body: '김장 한 통의 온기' },
      NAVER_BLOG: { title: '겨울 김장 나눔 이야기', body: '올겨울에도 김장 나눔을 준비합니다.\n\n후원금은 재료와 배송에 쓰입니다.' },
      KAKAO_CHANNEL: { body: '김장 나눔 소식을 전합니다.' },
    },
    ...over,
  });
}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  await resetDb();
  fx = await seedBasics();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = realFetch;
});

describe('[1] LLM 어댑터', () => {
  it('anthropic: Messages API 요청 형태(헤더·모델 기본값·JSON 지시)와 응답·사용량 파싱', async () => {
    useAnthropic();
    delete process.env.LLM_MODEL;
    fakeFetch([anthropicText('{"ok":true}', 120, 30)]);
    const r = await getLlmAdapter().complete({ system: 'S', user: 'U', json: true, maxTokens: 300 });
    expect(r).toEqual({ text: '{"ok":true}', usage: { inputTokens: 120, outputTokens: 30 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-test');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body.model).toBe('claude-sonnet-5-5');
    expect(calls[0]!.body.max_tokens).toBe(300);
    expect(String(calls[0]!.body.system)).toMatch(/^S[\s\S]*JSON 객체 하나/);
    expect(calls[0]!.body.messages).toEqual([{ role: 'user', content: 'U' }]);
    expect(llmCostKrw(r.usage)).toBe(Math.ceil(0.12 * 4 + 0.03 * 20));
  });

  it('openai: Chat Completions 요청 형태(Bearer·response_format)와 응답 파싱, 모델은 필수', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-oa';
    delete process.env.LLM_MODEL;
    expect(getLlmAdapter().info().missingCredentials).toEqual(['LLM_MODEL']);
    process.env.LLM_MODEL = 'test-model';
    fakeFetch([{ json: { choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } }]);
    const r = await getLlmAdapter().complete({ system: 'S', user: 'U', json: true, maxTokens: 100 });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-oa');
    expect(calls[0]!.body.model).toBe('test-model');
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0]!.body.max_completion_tokens).toBe(100);
    expect((calls[0]!.body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('키가 없으면 missingCredentials 로 알리고 호출하지 않는다', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = '';
    fakeFetch([anthropicText('{}')]);
    const a = getLlmAdapter();
    expect(a.info().missingCredentials).toEqual(['ANTHROPIC_API_KEY']);
    await expect(a.complete({ system: 's', user: 'u', maxTokens: 10 })).rejects.toBeInstanceOf(AdapterNotConfiguredError);
    expect(calls).toHaveLength(0);
    // 콘텐츠 어댑터도 같은 이유로 실패하고 호출하지 않는다
    process.env.CONTENT_PROVIDER = 'llm';
    expect(getContentAdapter().info().missingCredentials).toEqual(['ANTHROPIC_API_KEY']);
    expect(openaiAdapter({ ...llmConfig(), openaiKey: '', model: '' }).info().missingCredentials).toEqual(['OPENAI_API_KEY', 'LLM_MODEL']);
  });

  it('completeJson: 규칙 위반이면 사유를 붙여 1회 재요청하고, 두 번 모두 어기면 실패한다. 429 는 한 번 더 시도한다', async () => {
    const adapter = anthropicAdapter({ ...llmConfig(), anthropicKey: 'k', model: 'm', timeoutMs: 1000, krwPer1kInput: 0, krwPer1kOutput: 0 });
    const validate = (d: Record<string, unknown>) => (d.n === 2 ? { ok: true as const, value: 2 } : { ok: false as const, reason: 'n 은 2' });
    const attempts: boolean[] = [];
    fakeFetch([anthropicText('설명 {"n":1} 끝'), anthropicText('```json\n{"n":2}\n```')]);
    const r = await completeJson(adapter, { system: 's', user: 'u', maxTokens: 10 }, validate, (a) => void attempts.push(a.ok));
    expect(r.value).toBe(2);
    expect(attempts).toEqual([false, true]);
    expect(String((calls[1]!.body.messages as Array<{ content: string }>)[0]!.content)).toContain('n 은 2');

    fakeFetch([anthropicText('아님'), anthropicText('{"n":3}')]);
    await expect(completeJson(adapter, { system: 's', user: 'u', maxTokens: 10 }, validate)).rejects.toBeInstanceOf(LlmError);
    expect(calls).toHaveLength(2);

    fakeFetch([{ status: 429, json: { error: { type: 'rate_limit_error' } } }, anthropicText('{"n":2}')]);
    expect((await completeJson(adapter, { system: 's', user: 'u', maxTokens: 10 }, validate)).value).toBe(2);
    fakeFetch([{ status: 401, json: { error: { type: 'authentication_error' } } }]);
    await expect(completeJson(adapter, { system: 's', user: 'u', maxTokens: 10 }, validate)).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
    // mock 은 결정적 응답만, 비용 0
    expect(await mockLlmAdapter.complete({ system: '', user: '', maxTokens: 1, mockText: 'x' })).toEqual({ text: 'x', usage: { inputTokens: 0, outputTokens: 0 } });
  });
});

describe('[2] LLM 콘텐츠 대본 · 카드뉴스', () => {
  it('LLM 카드뉴스: 이야기 카드 + 시스템 사실 카드(진행률·참여 방법), 플랫폼별 캡션 저장, 비용 기록', async () => {
    useAnthropic();
    process.env.CONTENT_PROVIDER = 'llm';
    await withRegNo();
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { description: '우리 동네 어르신 돌봄 기관입니다.' } });
    const c = await seedCampaign();
    fakeFetch([anthropicText(cardNewsJson(), 2000, 1000)]);
    const item = await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'CARD_NEWS', userId: fx.merchantUserId });
    expect(item.status).toBe('REVIEW');
    expect(item.provider).toBe('llm:anthropic');
    // 프롬프트: 금지 규칙이 system 에, 기관 소개가 user 에
    expect(String(calls[0]!.body.system)).toContain('수혜자');
    expect(CONTENT_SYSTEM_PROMPT).toMatch(/AI 생성 콘텐츠/);
    expect(JSON.stringify(calls[0]!.body.messages)).toContain('우리 동네 어르신 돌봄 기관입니다.');
    expect(JSON.stringify(calls[0]!.body.messages)).not.toContain('홀몸 어르신 300가구'); // 수혜 대상 문구는 보내지 않는다

    const scenes = item.scenes as unknown as Scene[];
    expect(scenes.map((s) => s.label)).toEqual(['표지', '문제', '사연', '사용계획', '진행률', '참여 방법', '마무리']);
    expect(scenes[4]!.caption).toMatch(/목표 3,000,000원 중 0% 모였습니다/);
    expect(scenes[0]!.svg).toContain('viewBox="0 0 1080 1350"');
    expect(scenes.every((s) => s.svg.includes('AI 생성 콘텐츠 · 기부금품 모집등록 2026-서울-00999'))).toBe(true);

    const stored = item.platformCaptions as Record<string, { title: string | null; text: string }>;
    expect(Object.keys(stored).sort()).toEqual(['FACEBOOK', 'INSTAGRAM', 'KAKAO_CHANNEL', 'NAVER_BLOG', 'TIKTOK', 'YOUTUBE']);
    const tiktok = await renderCaption(item, 'TIKTOK');
    expect(tiktok).toContain('src=tt&cid=');
    expect(tiktok).toContain('AI 생성 콘텐츠');
    expect((tiktok.match(/#/g) ?? []).length).toBeLessThanOrEqual(5);
    const yt = await renderPlatformPost(item, 'YOUTUBE');
    expect(yt.title).toBe('함께 담그는 겨울 김장');

    const usage = await prisma.aiUsage.findMany({ where: { merchantId: fx.merchantId } });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ feature: 'content_script', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 2000, outputTokens: 1000, costKrw: 28, ok: true });
    expect(item.costKrw).toBe(28);
    expect((await aiUsageThisMonth()).total).toBe(28);
    // 사람이 승인할 수 있다(검사 통과)
    await expect(approveContent(fx.merchantId, item.id, fx.merchantUserId)).resolves.toBeTruthy();
  });

  it('LLM 응답이 두 번 모두 규칙을 어기면(전화번호·장면 수) 생성 실패로 남고 두 시도 모두 비용 기록된다', async () => {
    useAnthropic();
    process.env.CONTENT_PROVIDER = 'llm';
    const c = await seedCampaign();
    const bad = cardNewsJson({ scenes: [{ label: '표지', caption: '문의 010-1234-5678' }, { label: '문제', caption: 'a' }, { label: '마무리', caption: 'b' }] });
    fakeFetch([anthropicText(bad), anthropicText(cardNewsJson({ scenes: [{ label: '표지', caption: 'x' }] }))]);
    const item = await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'CARD_NEWS', userId: fx.merchantUserId });
    expect(item.status).toBe('FAILED');
    expect(item.error).toMatch(/규칙에 맞지 않았습니다/);
    expect(calls).toHaveLength(2);
    const usage = await prisma.aiUsage.findMany({ where: { merchantId: fx.merchantId }, orderBy: { createdAt: 'asc' } });
    expect(usage.map((u) => u.ok)).toEqual([false, false]);
  });

  it('mock 카드뉴스 5~7장·피드 1장(4:5), 플랫폼 형식 매트릭스, 로고는 data URI 로만 들어간다', async () => {
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { avatarUrl: '/assets/givesign/brand/mark-hope-transparent-v7.png' } });
    const c = await seedCampaign();
    const card = await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'CARD_NEWS', userId: fx.merchantUserId });
    const scenes = card.scenes as unknown as Scene[];
    expect(scenes.length).toBeGreaterThanOrEqual(5);
    expect(scenes.length).toBeLessThanOrEqual(7);
    expect(scenes.find((s) => s.label === '진행률')!.progress).toBe(0);
    expect(scenes[0]!.svg).toContain('<image href="data:image/png;base64,');
    const feed = await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_FEED', userId: fx.merchantUserId });
    expect((feed.scenes as unknown as Scene[])).toHaveLength(1);
    expect(feed.coverSvg).toContain('height="1350"');
    expect(feed.platformCaptions).toBeNull();
    // 외부 주소 로고는 넣지 않는다(SVG 이미지에서 불러오지 않음)
    expect(renderSceneSvg({ caption: 'a', index: 0, total: 1, merchantName: 'm', color: '#000000', footer: 'AI 생성 콘텐츠', format: 'FEED', logo: 'https://evil.example/x.png' })).not.toContain('<image');
    expect(await logoDataUri('https://evil.example/x.png')).toBeNull();
    expect(PLATFORM_KINDS.YOUTUBE).toEqual(['SHORTFORM']);
    expect(PLATFORM_KINDS.INSTAGRAM).toContain('CARD_NEWS');
    expect(PLATFORM_KINDS.KAKAO_CHANNEL).not.toContain('SHORTFORM');
  });
});

describe('[3] 플랫폼별 캡션 규칙', () => {
  const longBody = '가'.repeat(6000);
  const base = ['겨울 김장 나눔', longBody, '', "문자 후원: 1588-1234-1234 로 'KIMJANG' 보내기", '후원하기: {링크}', '', Array.from({ length: 40 }, (_, i) => `#태그${i}`).join(' '), '', 'AI 생성 콘텐츠 · 기부금품 모집등록 2026-서울-1'].join('\n');

  it('길이·해시태그 상한을 지키고 링크·AI 표시는 잘리지 않는다', () => {
    for (const p of Object.keys(PLATFORM_CAPTION_RULES) as Array<keyof typeof PLATFORM_CAPTION_RULES>) {
      const post = adaptCaption(base, p);
      const rule = PLATFORM_CAPTION_RULES[p];
      expect(post.text.length, p).toBeLessThanOrEqual(rule.maxChars);
      expect(post.text, p).toContain('{링크}');
      expect(post.text, p).toContain('AI 생성 콘텐츠 · 기부금품 모집등록 2026-서울-1');
      expect((post.text.match(/#태그/g) ?? []).length, p).toBeLessThanOrEqual(rule.maxTags);
      if (rule.titleMax) expect(post.title!.length, p).toBeLessThanOrEqual(rule.titleMax);
    }
    expect(adaptCaption(base, 'INSTAGRAM').text).toContain('프로필 링크');
    expect(adaptCaption(base, 'INSTAGRAM').text.length).toBeLessThanOrEqual(2200);
    expect((adaptCaption(base, 'INSTAGRAM').text.match(/#/g) ?? []).length).toBe(30);
    expect((adaptCaption(base, 'TIKTOK').text.match(/#/g) ?? []).length).toBe(5);
    expect(adaptCaption(base, 'FACEBOOK').text.startsWith('후원하기: {링크}')).toBe(true);
    expect(adaptCaption(base, 'KAKAO_CHANNEL').text).not.toContain('#');
    expect(adaptCaption(base, 'YOUTUBE').title).toBe('겨울 김장 나눔');
    expect(adaptCaption('<b>제목</b>\n본문\n후원하기: {링크}\nAI 생성 콘텐츠', 'YOUTUBE').title).toBe('b제목/b');
  });

  it('mock 콘텐츠의 플랫폼 캡션은 기본 캡션에서 규칙으로 만들고, 유입 경로가 붙는다', async () => {
    const c = await seedCampaign();
    const item = await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'SHORTFORM', userId: fx.merchantUserId });
    expect(await renderCaption(item, 'NAVER_BLOG')).toContain('src=nb&cid=');
    expect(await renderCaption(item, 'KAKAO_CHANNEL')).toContain('src=kc&cid=');
    expect(await renderCaption(item, 'INSTAGRAM')).toContain('src=ig&cid=');
  });
});

describe('[4] 콘텐츠 캘린더', () => {
  it('슬롯 계산은 KST 요일·시각 기준이고, 고른 요일이 많으면 주당 건수만큼 고르게 쓴다', () => {
    // 2026-11-05T15:30Z = KST 11-06(금) 00:30
    const from = new Date('2026-11-05T15:30:00Z');
    const slots = calendarSlots({ weeklyCount: 3, days: [1, 3, 5], postHour: 19 }, from);
    expect(slots.map((d) => d.toISOString())).toEqual(['2026-11-06T10:00:00.000Z', '2026-11-09T10:00:00.000Z', '2026-11-11T10:00:00.000Z']);
    // 자정 직후 0시 슬롯은 이미 지난 같은 날이 아니라 다음 주로
    expect(calendarSlots({ weeklyCount: 1, days: [5], postHour: 0 }, from).map((d) => d.toISOString())).toEqual(['2026-11-12T15:00:00.000Z']);
    expect(effectiveDays({ weeklyCount: 2, days: [] })).toEqual([2, 5]);
    expect(effectiveDays({ weeklyCount: 2, days: [1, 2, 3, 4] })).toEqual([1, 3]);
    expect(effectiveDays({ weeklyCount: 7, days: [0, 6] })).toEqual([0, 6]);
  });

  it('모집등록번호·진행 중 캠페인·월 한도가 없으면 만들지 않고 이유를 알린다', async () => {
    await prisma.merchantContentSetting.create({ data: { merchantId: fx.merchantId, calendarEnabled: true, weeklyCount: 7, days: [], postHour: 23 } });
    let r = await fillNextSlot(fx.merchantId);
    expect(r.slot).toBeNull();
    const codes = (await calendarBlockers(fx.merchantId)).map((b) => b.code);
    expect(codes).toContain('NO_REG_NO');
    expect(codes).toContain('NO_CAMPAIGN');
    await withRegNo();
    expect((await fillNextSlot(fx.merchantId)).reason).toBe('NO_CAMPAIGN');
    // 기간이 지난 캠페인은 진행 중이 아니다
    const old = await seedCampaign('OLD', { endsOn: '2026-01-31' });
    expect(old).toBeTruthy();
    expect((await fillNextSlot(fx.merchantId)).reason).toBe('NO_CAMPAIGN');
    await seedCampaign();
    await prisma.merchantContentSetting.update({ where: { merchantId: fx.merchantId }, data: { monthlyLimit: 0 } });
    r = await fillNextSlot(fx.merchantId);
    expect(r.reason).toBe('LIMIT');
    expect(await prisma.contentSlot.count()).toBe(0);
  });

  it('같은 슬롯은 한 번만(겹친 실행도), 형식은 돌아가며, 캠페인은 진행률 낮고 마감 가까운 것부터 돌아가며 고른다', async () => {
    await withRegNo();
    const far = await seedCampaign('FAR', { title: '먼 캠페인', endsOn: '2099-12-31' });
    const near = await seedCampaign('NEAR', { title: '마감 임박', endsOn: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) });
    expect((await pickCampaign(fx.merchantId))!.id).toBe(near.id);
    await prisma.merchantContentSetting.create({ data: { merchantId: fx.merchantId, calendarEnabled: true, weeklyCount: 7, days: [], postHour: 23, kinds: ['IMAGE_FEED', 'CARD_NEWS'] } });

    const [a, b] = await Promise.all([fillNextSlot(fx.merchantId), fillNextSlot(fx.merchantId)]);
    expect([a.slot, b.slot].filter(Boolean)).toHaveLength(1);
    expect(await prisma.contentSlot.count()).toBe(1);
    const first = (a.slot ?? b.slot)!;
    expect(first.kind).toBe('IMAGE_FEED');
    expect(first.campaignId).toBe(near.id);
    expect(first.status).toBe('REVIEW');

    const r2 = await runContentCalendar();
    expect(r2.created).toBe(1);
    const slots = await prisma.contentSlot.findMany({ orderBy: { slotAt: 'asc' } });
    expect(slots).toHaveLength(2);
    expect(slots[1]!.slotAt.getTime()).toBeGreaterThan(slots[0]!.slotAt.getTime());
    expect(slots[1]!.kind).toBe('CARD_NEWS');
    expect(slots[1]!.campaignId).toBe(far.id); // 돌아가며
    const items = await prisma.contentItem.findMany({ where: { createdBy: 'CALENDAR' } });
    expect(items).toHaveLength(2);
    const preview = await calendarPreview(fx.merchantId);
    expect(preview.length).toBeGreaterThanOrEqual(20);
    expect(preview.filter((p) => p.slot).length).toBe(2);
  });

  it('자동 승인 + 자동 예약이면 생성 직후 연결 채널(형식 허용)로 슬롯 시각에 예약한다', async () => {
    await withRegNo();
    await seedCampaign();
    await connectSocialChannel(fx.merchantId, 'INSTAGRAM', '@welfare', fx.merchantUserId);
    await connectSocialChannel(fx.merchantId, 'YOUTUBE', '복지관', fx.merchantUserId);
    await prisma.merchantContentSetting.create({
      data: { merchantId: fx.merchantId, calendarEnabled: true, weeklyCount: 7, days: [], postHour: 23, kinds: ['CARD_NEWS'], platforms: ['INSTAGRAM', 'YOUTUBE'], autoApprove: true, autoSchedule: true },
    });
    const r = await fillNextSlot(fx.merchantId);
    expect(r.slot!.status).toBe('SCHEDULED');
    const pubs = await prisma.contentPublish.findMany({ where: { itemId: r.slot!.itemId! } });
    expect(pubs.map((p) => p.platform)).toEqual(['INSTAGRAM']); // 유튜브는 카드뉴스 불가
    expect(pubs[0]!.scheduledAt.getTime()).toBe(r.slot!.slotAt.getTime());
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: r.slot!.itemId! } })).status).toBe('SCHEDULED');
  });

  it('검토 대기로 만든 캘린더 콘텐츠는 승인하는 순간 슬롯이 미래면 예약하고, 지났으면 예약하지 않는다', async () => {
    await withRegNo();
    await seedCampaign();
    await connectSocialChannel(fx.merchantId, 'FACEBOOK', '복지관 페이지', fx.merchantUserId);
    await prisma.merchantContentSetting.create({
      data: { merchantId: fx.merchantId, calendarEnabled: true, weeklyCount: 7, days: [], postHour: 23, kinds: ['IMAGE_FEED'], platforms: ['FACEBOOK'], autoSchedule: true },
    });
    const r = await fillNextSlot(fx.merchantId);
    expect(r.slot!.status).toBe('REVIEW');
    expect(await prisma.contentPublish.count()).toBe(0);
    await approveContent(fx.merchantId, r.slot!.itemId!, fx.merchantUserId);
    const pub = await prisma.contentPublish.findFirstOrThrow({ where: { itemId: r.slot!.itemId! } });
    expect(pub.platform).toBe('FACEBOOK');
    expect(pub.scheduledAt.getTime()).toBe(r.slot!.slotAt.getTime());

    const r2 = await fillNextSlot(fx.merchantId);
    await prisma.contentSlot.update({ where: { id: r2.slot!.id }, data: { slotAt: new Date(Date.now() - 3600_000) } });
    await approveContent(fx.merchantId, r2.slot!.itemId!, fx.merchantUserId);
    expect(await prisma.contentPublish.count({ where: { itemId: r2.slot!.itemId! } })).toBe(0);
    expect((await prisma.contentSlot.findUniqueOrThrow({ where: { id: r2.slot!.id } })).note).toMatch(/지나/);
  });
});

describe('[5] AI 초안', () => {
  it('감사 문구: 허용 치환자만·200자·링크/전화 금지 — mock 응답도 같은 검사를 통과한다', async () => {
    const r = await draftThanksMessage(fx.merchantId);
    expect(thanksDraftViolation(r.message)).toBeNull();
    expect(thanksDraftViolation('{이름}님 감사합니다 {후원자}')).toMatch(/치환자/);
    expect(thanksDraftViolation('{후원자}님 감사합니다 www.x.kr')).toMatch(/링크/);
    expect(thanksDraftViolation(`{후원자}${'가'.repeat(200)}`)).toMatch(/200/);
    expect(thanksDraftViolation('{후원자}님 문의 010-1111-2222')).toMatch(/전화/);
    expect(draftTextViolation('김영희할머니께 전합니다')).toMatch(/실명/);
    expect(draftTextViolation('김OO 어르신께 전합니다')).toBeNull();
    expect(draftTextViolation('2026-11-06 부터 모금합니다')).toBeNull();
  });

  it('캠페인 초안: 실명·연락처가 있으면 사유를 붙여 재요청하고, 시도마다 비용을 기록한다', async () => {
    useAnthropic();
    const bad = JSON.stringify({ title: '겨울 나눔', summary: '박철수씨 가정을 돕습니다', story: '이야기', usagePlan: '계획' });
    const good = JSON.stringify({ title: '겨울 나눔', summary: '이웃의 겨울을 돕습니다', story: '이야기', usagePlan: '계획' });
    fakeFetch([anthropicText(bad, 500, 100), anthropicText(good, 600, 120)]);
    const d = await draftCampaign(fx.merchantId, { title: '겨울' });
    expect(d.summary).toBe('이웃의 겨울을 돕습니다');
    expect(String((calls[1]!.body.messages as Array<{ content: string }>)[0]!.content)).toContain('실명');
    const rows = await prisma.aiUsage.findMany({ where: { feature: 'campaign_draft' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((x) => [x.ok, x.inputTokens])).toEqual([[false, 500], [true, 600]]);
    expect(rows.every((x) => x.costKrw > 0)).toBe(true);
    // 아무것도 저장하지 않는다
    expect(await prisma.campaign.count({ where: { merchantId: fx.merchantId } })).toBe(0);
  });

  it('속도 제한: 기관당 분당 N회를 넘으면 거절한다', async () => {
    process.env.AI_DRAFT_PER_MINUTE = '2';
    await draftThanksMessage(fx.merchantId);
    await draftThanksMessage(fx.merchantId);
    await expect(draftThanksMessage(fx.merchantId)).rejects.toBeInstanceOf(AiDraftError);
  });

  it('문의 답변 초안: 본문 연락처를 가려서 보내고 분류를 검증한다', async () => {
    useAnthropic();
    const inq = await prisma.supportInquiry.create({ data: { id: newId(), category: 'ETC', merchantId: fx.merchantId } });
    await prisma.supportMessage.create({ data: { id: newId(), inquiryId: inq.id, sender: 'USER', body: '영수증 받고 싶어요 010-9876-5432 / a@b.kr' } });
    fakeFetch([anthropicText(JSON.stringify({ category: 'RECEIPT', reply: '확인 후 안내드리겠습니다.' }))]);
    const d = await draftInquiryReply(inq.id, 'admin-1');
    expect(d).toEqual({ category: 'RECEIPT', reply: '확인 후 안내드리겠습니다.' });
    const sent = JSON.stringify(calls[0]!.body.messages);
    expect(sent).not.toContain('9876');
    expect(sent).not.toContain('a@b.kr');
    expect(maskForLlm('계좌 110-123-456789')).toBe('계좌 [계좌번호]');
    // 답변은 저장되지 않는다
    expect(await prisma.supportMessage.count({ where: { inquiryId: inq.id } })).toBe(1);
  });

  it('콘텐츠 성과 요약은 기관당 하루 1회 캐시한다', async () => {
    const a = await contentInsight(fx.merchantId);
    expect(a.cached).toBe(false);
    expect(a.insight.summary).toMatch(/콘텐츠/);
    const b = await contentInsight(fx.merchantId);
    expect(b.cached).toBe(true);
    expect(await prisma.aiCache.count({ where: { merchantId: fx.merchantId } })).toBe(1);
  });
});

describe('[6] 영상 조립 (ffmpeg)', () => {
  it('ffmpeg 인자: 장면별 길이·9:16 스케일·concat·H.264·faststart, 음성이 있으면 합친다', () => {
    const args = buildFfmpegArgs({ frames: [{ file: 'a.png', durationSec: 5 }, { file: 'b.png', durationSec: 7.4 }], outFile: 'o.mp4' });
    expect(args.filter((a) => a === '-loop')).toHaveLength(2);
    expect(args.slice(args.indexOf('a.png') - 3, args.indexOf('a.png'))).toEqual(['-t', '5', '-i']);
    expect(args.slice(args.indexOf('b.png') - 3, args.indexOf('b.png'))).toEqual(['-t', '7', '-i']);
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('scale=1080:1920');
    expect(filter).toContain('concat=n=2:v=1:a=0[v]');
    expect(args).toContain('libx264');
    expect(args).toContain('+faststart');
    expect(args.at(-1)).toBe('o.mp4');
    const withAudio = buildFfmpegArgs({ frames: [{ file: 'a.png', durationSec: 3 }], audioFile: 'v.mp3', outFile: 'o.mp4' });
    expect(withAudio).toContain('v.mp3');
    expect(withAudio.slice(withAudio.indexOf('-map', withAudio.indexOf('[v]')), withAudio.indexOf('-map', withAudio.indexOf('[v]')) + 2)).toEqual(['-map', '1:a']);
    expect(() => buildFfmpegArgs({ frames: [], outFile: 'o.mp4' })).toThrow();
  });

  it('영상 조립을 끄면 만들지 않았다고 남긴다', async () => {
    process.env.FFMPEG_PATH = 'off';
    const r = await assembleVideo({ scenes: [{ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', durationSec: 1 }] });
    expect(r.available).toBe(false);
    expect(r.videoUrl).toBeUndefined();
  });

  const ffmpeg = (() => {
    try {
      return execFileSync('which', ['ffmpeg']).toString().trim();
    } catch {
      return '';
    }
  })();
  it.skipIf(!ffmpeg)('ffmpeg 가 있으면 숏폼 장면으로 mp4 를 만들어 저장하고 content_item.videoUrl 에 기록한다', async () => {
    process.env.FFMPEG_PATH = ffmpeg;
    await withRegNo();
    const c = await seedCampaign();
    const item = await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'SHORTFORM', userId: fx.merchantUserId });
    expect(item.videoUrl).toMatch(/\/api\/media\/[a-f0-9]{32}\.mp4$/);
    const name = item.videoUrl!.split('/').pop()!;
    expect(existsSync(path.join(process.cwd(), 'var', 'uploads', name))).toBe(true);
    const job = await prisma.contentJob.findFirstOrThrow({ where: { itemId: item.id, step: 'ASSEMBLE' } });
    expect((job.output as { available: boolean }).available).toBe(true);
  }, 120_000);
});
