import type { ContentKind } from '@/generated/prisma/enums';
import { completeJson, type JsonAttempt, type LlmAdapter } from '../llm';
import {
  CLOSERS,
  TONE_LABEL,
  defaultHashtags,
  factScenes,
  progressPct,
  type ContentBrief,
  type GeneratedScript,
  type PlatformVariant,
  type SceneSpec,
} from './brief';

/**
 * LLM 대본 — 프롬프트, 응답 검증, 사실 장면 결합.
 *
 * LLM 이 쓰는 것: 제목, 이야기 장면 자막, 해시태그, 플랫폼별 캡션 본문.
 * 시스템이 쓰는 것: 진행률·참여 방법 장면(캠페인 데이터 그대로), 문자 키워드·링크·"AI 생성 콘텐츠"·모집등록번호.
 */

export const CONTENT_SYSTEM_PROMPT = [
  '당신은 한국 사회복지기관의 모금 캠페인 홍보 문안을 쓰는 작가다. 결과물은 기관 담당자가 검토한 뒤 기관 명의로 SNS 에 게시된다.',
  '반드시 지킬 것:',
  '1. 수혜자(지원 대상자)의 실명·별명·나이·연락처·주소·학교·직장 등 개인을 특정할 수 있는 정보를 쓰지 않는다. 사진이나 외모 묘사도 쓰지 않는다.',
  '2. 과장, 공포·죄책감·동정심 자극("당신이 외면하면", "불쌍한" 등), 확인되지 않은 수치를 쓰지 않는다. 주어진 캠페인 자료에 있는 사실만 쓴다.',
  '3. 목표액·모금액·남은 기간·문자 번호·키워드·링크는 쓰지 않는다. 시스템이 정확한 값으로 따로 붙인다.',
  '4. "AI 생성 콘텐츠" 표시와 기부금품 모집등록번호도 시스템이 붙인다. 직접 쓰지 않는다.',
  '5. 따뜻하고 존중하는 존댓말. 이모지·특수문자 장식을 쓰지 않는다.',
  '6. 금지어 목록의 단어는 어떤 형태로도 쓰지 않는다.',
].join('\n');

const PLATFORM_KEYS = ['YOUTUBE', 'INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'NAVER_BLOG', 'KAKAO_CHANNEL'] as const;

/** 플랫폼별 본문 길이(시스템이 붙이는 키워드·링크·해시태그·표시 몫을 뺀 값) */
export const VARIANT_BODY_MAX: Record<(typeof PLATFORM_KEYS)[number], number> = {
  YOUTUBE: 1500,
  INSTAGRAM: 1200,
  FACEBOOK: 1200,
  TIKTOK: 600,
  NAVER_BLOG: 3000,
  KAKAO_CHANNEL: 200,
};

const CARD_LABELS = ['표지', '문제', '사연', '사용계획', '마무리'] as const;

interface KindRule {
  min: number;
  max: number;
  captionMax: number;
  describe: string;
}

/** LLM 이 쓸 이야기 장면 수 (사실 장면 제외) */
export const LLM_SCENE_RULE: Record<ContentKind, KindRule> = {
  SHORTFORM: { min: 3, max: 5, captionMax: 60, describe: '9:16 숏폼 영상의 이야기 장면 3~5개 (장면당 자막 60자 이내). 마지막에 시스템이 진행률·참여 방법 장면 2개를 붙인다.' },
  IMAGE_SQUARE: { min: 2, max: 2, captionMax: 60, describe: '정사각 이미지 묶음의 앞 장면 2개 (자막 60자 이내). 첫 장면은 기관·캠페인 소개, 둘째는 사연. 시스템이 참여 방법 장면을 붙인다.' },
  IMAGE_STORY: { min: 2, max: 2, captionMax: 60, describe: '스토리(9:16) 이미지 묶음의 앞 장면 2개 (자막 60자 이내). 첫 장면은 기관·캠페인 소개, 둘째는 사연. 시스템이 참여 방법 장면을 붙인다.' },
  CARD_NEWS: { min: 3, max: 5, captionMax: 90, describe: '4:5 카드뉴스 카드. label 은 순서대로 표지·문제·사연·사용계획·마무리 중에서 쓴다(사연·사용계획은 자료가 있을 때만, 표지·문제·마무리는 반드시). 표지 40자, 나머지 90자 이내. 시스템이 마무리 앞에 진행률·참여 방법 카드를 넣는다.' },
  IMAGE_FEED: { min: 1, max: 1, captionMax: 50, describe: '4:5 피드 이미지 한 장의 핵심 문구 1개 (50자 이내). 진행률 막대는 시스템이 그린다.' },
};

export function buildScriptPrompt(b: ContentBrief, kind: ContentKind) {
  const rule = LLM_SCENE_RULE[kind];
  const lines = [
    `[기관] ${b.merchantName}`,
    b.merchantIntro ? `[기관 소개] ${b.merchantIntro.slice(0, 600)}` : null,
    b.merchantBusiness ? `[기관 사업] ${b.merchantBusiness.slice(0, 600)}` : null,
    `[캠페인] ${b.campaignTitle}`,
    `[한 줄 소개] ${b.summary}`,
    b.story ? `[캠페인 이야기] ${b.story.slice(0, 2000)}` : null,
    b.usagePlan ? `[후원금 사용 계획] ${b.usagePlan.slice(0, 1000)}` : null,
    `[분위기] ${TONE_LABEL[b.tone]}`,
    `[금지어] ${b.bannedWords.length ? b.bannedWords.join(', ') : '(없음)'}`,
    b.avoid?.length ? `[피해야 할 것 — 이 기관 담당자가 예전에 반려·수정 요청한 이유] ${b.avoid.map((a) => a.slice(0, 80)).join(' / ')}` : null,
    b.revisionRequest ? `[담당자 수정 요청 — 이번 판에 반영] ${b.revisionRequest.slice(0, 100)}` : null,
    '',
    `[만들 것] ${rule.describe}`,
    '',
    '[출력 JSON 형식]',
    '{',
    '  "title": "콘텐츠 제목 (60자 이내)",',
    `  "scenes": [{"label": "${kind === 'CARD_NEWS' ? '표지' : ''}", "caption": "자막"}],`,
    '  "hashtags": ["해시태그 3~10개, # 없이, 띄어쓰기 없이"],',
    '  "platforms": {',
    '    "YOUTUBE": {"title": "유튜브 제목 (90자 이내)", "body": "설명 (1500자 이내)"},',
    '    "INSTAGRAM": {"body": "인스타그램 본문 (1200자 이내)"},',
    '    "FACEBOOK": {"body": "페이스북 본문 (1200자 이내)"},',
    '    "TIKTOK": {"body": "틱톡 본문 (600자 이내)"},',
    '    "NAVER_BLOG": {"title": "블로그 제목 (60자 이내)", "body": "블로그 본문, 문단을 빈 줄로 나눈다 (3000자 이내)"},',
    '    "KAKAO_CHANNEL": {"body": "카카오 채널 소식 (200자 이내)"}',
    '  }',
    '}',
  ];
  return { system: CONTENT_SYSTEM_PROMPT, user: lines.filter((l) => l !== null).join('\n') };
}

const PHONE_RE = /01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}|0\d{1,2}[-\s.]\d{3,4}[-\s.]\d{4}/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;
const URL_RE = /https?:\/\/|www\./i;
/** 뒷자리 첫 숫자 1~4 주민등록번호, 5~8 외국인등록번호 (2026-11-06 점검 A-M13) */
const RRN_RE = /\d{6}[-\s]?[1-8]\d{6}/;

/** 개인정보 패턴(전화·이메일·주민번호). 걸리면 사유. */
export function personalInfoHit(text: string): string | null {
  if (PHONE_RE.test(text)) return '전화번호로 보이는 숫자';
  if (EMAIL_RE.test(text)) return '이메일 주소';
  if (RRN_RE.test(text)) return '주민등록번호로 보이는 숫자';
  return null;
}

/**
 * 흔한 성씨 + 이름 1~2자 + 호칭(띄어쓰기 없이) — "김영희할머니께", "박철수씨" 같은 실명 표현. 마스킹(김OO)은 통과.
 * 어림 검사다(오탐을 줄이려 어르신·학생 같은 일반 명사형 호칭은 넣지 않았다). 최종 확인은 담당자가 한다.
 */
export const REAL_NAME_RE = /(?:^|[^가-힣])[김이박최정강조윤장임한오서신권황안송류홍전고문양손배백허유남심노하곽성차주우구민진나엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국은편용예경봉][가-힣]{1,2}(?:씨|할머니|할아버지|군|양)/;

/** 수혜자 실명으로 보이는 표현(어림). 콘텐츠 대본·AI 초안이 함께 쓴다. */
export function realNameHit(text: string): boolean {
  return REAL_NAME_RE.test(text);
}

function str(v: unknown) {
  return typeof v === 'string' ? v.replace(/\s+\n/g, '\n').trim() : '';
}

/** LLM 응답 검증. 통과하면 정리된 값. */
export function validateScriptJson(
  data: Record<string, unknown>,
  b: ContentBrief,
  kind: ContentKind,
): { ok: true; value: { title: string; scenes: SceneSpec[]; hashtags: string[]; platforms: Record<string, PlatformVariant> } } | { ok: false; reason: string } {
  const rule = LLM_SCENE_RULE[kind];
  const title = str(data.title);
  if (!title || title.length > 60) return { ok: false, reason: 'title 은 1~60자' };
  const rawScenes = Array.isArray(data.scenes) ? data.scenes : [];
  if (rawScenes.length < rule.min || rawScenes.length > rule.max) return { ok: false, reason: `scenes 는 ${rule.min}~${rule.max}개` };
  const scenes: SceneSpec[] = [];
  for (const s of rawScenes) {
    const caption = str((s as Record<string, unknown>)?.caption);
    const label = str((s as Record<string, unknown>)?.label);
    if (!caption) return { ok: false, reason: '빈 자막' };
    const max = kind === 'CARD_NEWS' && label === '표지' ? 40 : rule.captionMax;
    if (caption.length > max) return { ok: false, reason: `자막은 ${max}자 이내 (${caption.length}자)` };
    if (kind === 'CARD_NEWS' && !(CARD_LABELS as readonly string[]).includes(label)) return { ok: false, reason: `카드 label 은 ${CARD_LABELS.join('·')} 중 하나` };
    scenes.push({ caption, durationSec: Math.min(8, Math.max(4, Math.ceil(caption.length / 8))), ...(kind === 'CARD_NEWS' ? { label } : {}) });
  }
  if (kind === 'CARD_NEWS') {
    const labels = scenes.map((s) => s.label);
    for (const need of ['표지', '문제', '마무리']) if (!labels.includes(need)) return { ok: false, reason: `카드 ${need} 가 없습니다` };
    if (new Set(labels).size !== labels.length) return { ok: false, reason: '카드 label 이 겹칩니다' };
  }
  const rawTags = Array.isArray(data.hashtags) ? data.hashtags : [];
  const hashtags = [...new Set(rawTags.map((t) => str(t).replace(/^#/, '')).filter(Boolean))];
  if (hashtags.length < 3 || hashtags.length > 10) return { ok: false, reason: 'hashtags 는 3~10개' };
  if (hashtags.some((t) => !/^[\p{L}\p{N}_]{1,30}$/u.test(t))) return { ok: false, reason: '해시태그는 띄어쓰기·기호 없이 30자 이내' };

  const platforms: Record<string, PlatformVariant> = {};
  const rawP = (data.platforms && typeof data.platforms === 'object' ? data.platforms : {}) as Record<string, unknown>;
  for (const key of PLATFORM_KEYS) {
    const v = (rawP[key] ?? null) as Record<string, unknown> | null;
    if (!v) return { ok: false, reason: `platforms.${key} 가 없습니다` };
    const body = str(v.body);
    if (!body || body.length > VARIANT_BODY_MAX[key]) return { ok: false, reason: `platforms.${key}.body 는 1~${VARIANT_BODY_MAX[key]}자` };
    const vt = str(v.title);
    if ((key === 'YOUTUBE' || key === 'NAVER_BLOG') && (!vt || vt.length > (key === 'YOUTUBE' ? 90 : 60))) return { ok: false, reason: `platforms.${key}.title 길이` };
    platforms[key] = vt ? { title: vt, body } : { body };
  }

  const all = [title, ...scenes.map((s) => s.caption), ...hashtags, ...Object.values(platforms).flatMap((p) => [p.title ?? '', p.body])];
  for (const t of all) {
    const banned = b.bannedWords.find((w) => w && t.includes(w));
    if (banned) return { ok: false, reason: `금지어 "${banned}" 를 썼습니다` };
    const pii = personalInfoHit(t);
    if (pii) return { ok: false, reason: `${pii}를 썼습니다` };
    // 수혜자 실명·실사진을 쓰지 않는다(CLAUDE.md 11항). 콘텐츠 대본에도 AI 초안과 같은 실명 검사를 한다(2026-11-06 점검 낮음).
    if (realNameHit(t)) return { ok: false, reason: '실명으로 보이는 표현을 썼습니다(김OO처럼 가려 쓰거나 빼 주세요)' };
    if (URL_RE.test(t)) return { ok: false, reason: '링크를 직접 썼습니다' };
    if (t.includes('AI 생성 콘텐츠')) return { ok: false, reason: 'AI 표시는 시스템이 붙입니다' };
  }
  return { ok: true, value: { title, scenes, hashtags, platforms } };
}

/** LLM 이야기 장면 + 시스템 사실 장면 → 형식별 최종 장면 */
export function combineScenes(b: ContentBrief, kind: ContentKind, story: SceneSpec[]): SceneSpec[] {
  const f = factScenes(b);
  if (kind === 'SHORTFORM') return [...story, { caption: f.progress.caption, durationSec: 6 }, f.howWithCloser];
  if (kind === 'IMAGE_SQUARE' || kind === 'IMAGE_STORY') return [...story, f.howWithCloser];
  if (kind === 'IMAGE_FEED') return [{ ...story[0]!, progress: progressPct(b) }];
  // 카드뉴스: 표지·문제·사연·사용계획 → 진행률·참여 방법 → 마무리
  const order = ['표지', '문제', '사연', '사용계획'];
  const head = order.map((l) => story.find((s) => s.label === l)).filter((s): s is SceneSpec => Boolean(s));
  const closing = story.find((s) => s.label === '마무리') ?? { caption: CLOSERS[b.tone], durationSec: 5, label: '마무리' };
  return [...head, f.progress, f.how, closing];
}

export async function llmScript(llm: LlmAdapter, b: ContentBrief, kind: ContentKind, onAttempt: (a: JsonAttempt) => void): Promise<GeneratedScript> {
  const { system, user } = buildScriptPrompt(b, kind);
  const { value } = await completeJson(llm, { system, user, json: true, maxTokens: 4000 }, (d) => validateScriptJson(d, b, kind), onAttempt);
  const scenes = combineScenes(b, kind, value.scenes);
  return {
    title: value.title,
    script: scenes.map((s) => s.caption).join('\n'),
    scenes,
    hashtags: [...new Set([...value.hashtags, ...defaultHashtags(b).slice(0, 1)])],
    platformCaptions: value.platforms,
  };
}
