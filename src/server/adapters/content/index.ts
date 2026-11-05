import { contentProviderConfig } from '@/lib/env';
import { AdapterNotConfiguredError, type AdapterInfo } from '../types';
import { getLlmAdapter, llmCostKrw, type LlmAdapter } from '../llm';
import type { ContentKind } from '@/generated/prisma/enums';
import { assembleVideo, type AssembleInput, type AssembleResult } from './video';
import { llmScript } from './llm-script';
import { defaultHashtags, mockScenes, TONE_LABEL, type ContentBrief, type GeneratedScript } from './brief';

/**
 * 콘텐츠 생성 어댑터 (대본 · 장면 이미지 · 음성 · 영상 조립).
 *
 *  - mock : 외부 AI 를 부르지 않는다. 기관·캠페인 데이터를 서식에 넣어 대본을 만든다.
 *  - llm  : CONTENT_PROVIDER=llm (또는 anthropic|openai) 이면 대본·장면 자막·플랫폼별 캡션을 LLM 이 JSON 으로 쓴다.
 *           진행률·참여 방법 장면, "AI 생성 콘텐츠" 표시, 모집등록번호는 LLM 이 아니라 시스템이 붙인다(사실만).
 *  장면 이미지는 공급자와 무관하게 서버가 그린 SVG(문자·도형·기관 로고만, 사람 사진 없음)다.
 *  음성(TTS)은 계약 전이라 만들지 않고 그 사실을 남긴다. 영상(mp4)은 FFMPEG_PATH 가 있을 때만 조립한다
 *  — 없는 결과물을 만든 척하지 않는다(절대 규칙 2).
 *
 * 수혜자 실사진·실명은 쓰지 않는다(초상권·복지 이용자 보호). 모든 산출물에 "AI 생성 콘텐츠" 표시를 넣는다.
 */

export * from './brief';

export interface ScriptUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
}

export interface ScriptResult {
  data: GeneratedScript;
  costKrw: number;
  /** LLM 시도별 사용량 (비용 기록용). mock 은 비어 있다. */
  usage?: ScriptUsage[];
}

export interface ContentGenAdapter {
  info(): AdapterInfo;
  script(brief: ContentBrief, kind: ContentKind): Promise<ScriptResult>;
  voice(script: string): Promise<{ available: boolean; note: string; costKrw: number }>;
  assemble(input: AssembleInput): Promise<AssembleResult>;
}

const NO_TTS_NOTE = '음성(TTS) 공급자 계약 전이라 내레이션 음성을 만들지 않았습니다. 자막 영상으로 쓰거나 공급자 연결 뒤 다시 만드세요.';

export const mockContentAdapter: ContentGenAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async script(b, kind) {
    const scenes = mockScenes(b, kind);
    return {
      data: {
        title: `${b.campaignTitle} — ${TONE_LABEL[b.tone]} 이야기`,
        script: scenes.map((s) => s.caption).join('\n'),
        scenes,
        hashtags: defaultHashtags(b),
      },
      costKrw: 0,
    };
  },
  async voice() {
    return { available: false, note: `mock: ${NO_TTS_NOTE}`, costKrw: 0 };
  },
  assemble: assembleVideo,
};

/** LLM 대본 어댑터. 음성은 계약 전(만들지 않음), 영상은 ffmpeg 가 있을 때만. */
export function llmContentAdapter(llm: LlmAdapter): ContentGenAdapter {
  const li = llm.info();
  return {
    info: () => ({ provider: `llm:${li.provider}`, mode: li.mode, missingCredentials: li.missingCredentials }),
    async script(brief, kind) {
      if (li.missingCredentials.length) throw new AdapterNotConfiguredError(li.provider, li.missingCredentials);
      const usage: ScriptUsage[] = [];
      try {
        const data = await llmScript(llm, brief, kind, (a) => {
          usage.push({ provider: li.provider, model: li.model, inputTokens: a.usage.inputTokens, outputTokens: a.usage.outputTokens, ok: a.ok });
        });
        return { data, costKrw: usage.reduce((s, u) => s + llmCostKrw(u), 0), usage };
      } catch (e) {
        // 실패한 시도도 과금됐으므로 사용량을 예외에 실어 보낸다(호출부가 비용 기록).
        (e as { usage?: ScriptUsage[] }).usage = usage;
        throw e;
      }
    },
    async voice() {
      return { available: false, note: NO_TTS_NOTE, costKrw: 0 };
    },
    assemble: assembleVideo,
  };
}

export function getContentAdapter(): ContentGenAdapter {
  const c = contentProviderConfig();
  if (c.mode === 'mock') return mockContentAdapter;
  return llmContentAdapter(getLlmAdapter(c.llmProvider));
}

// ---------------------------------------------------------------------------
// SVG 장면 렌더 (공급자와 무관하게 서버에서 그린다)
// ---------------------------------------------------------------------------

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 한글 기준 대략 글자 수로 줄을 나눈다. */
export function wrapText(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + (cur ? ' ' : '') + w).length > perLine && cur) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
    while (cur.length > perLine) {
      lines.push(cur.slice(0, perLine));
      cur = cur.slice(perLine);
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = `${cut[maxLines - 1]!.slice(0, perLine - 1)}…`;
    return cut;
  }
  return lines;
}

function safeColor(c: string) {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#28634e';
}

/** STORY 9:16 1080×1920 · SQUARE 1:1 1080×1080 · FEED 4:5 1080×1350 */
export type SceneFormat = 'STORY' | 'SQUARE' | 'FEED';

export const FORMAT_SIZE: Record<SceneFormat, { w: number; h: number }> = {
  STORY: { w: 1080, h: 1920 },
  SQUARE: { w: 1080, h: 1080 },
  FEED: { w: 1080, h: 1350 },
};

export function kindFormat(kind: ContentKind): SceneFormat {
  if (kind === 'IMAGE_SQUARE') return 'SQUARE';
  if (kind === 'CARD_NEWS' || kind === 'IMAGE_FEED') return 'FEED';
  return 'STORY';
}

/** 기관 로고는 data: URI(png/jpeg/webp/svg)만 받는다. 외부 주소는 SVG 를 이미지로 볼 때 불러오지 않으므로 넣지 않는다. */
function safeLogo(uri: string | null | undefined) {
  return uri && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(uri) && uri.length < 400_000 ? uri : null;
}

export function renderSceneSvg(input: {
  caption: string;
  index: number;
  total: number;
  merchantName: string;
  color: string;
  footer: string;
  format: SceneFormat;
  /** 카드뉴스 구간 이름 */
  label?: string;
  /** 진행률 막대 (0~100) */
  progress?: number;
  /** 기관 로고 data: URI */
  logo?: string | null;
}): string {
  const { w: W, h: H } = FORMAT_SIZE[input.format];
  const story = input.format === 'STORY';
  const color = safeColor(input.color);
  const perLine = story ? 13 : input.format === 'FEED' ? 14 : 15;
  const maxLines = story ? 6 : input.format === 'FEED' ? 6 : 4;
  const lines = wrapText(input.caption, perLine, maxLines);
  const fs = story ? 76 : 64;
  const lh = fs * 1.4;
  const top = H / 2 - (lines.length * lh) / 2 + fs * 0.35;
  const seed = (input.index * 97 + input.merchantName.length * 13) % 360;
  const headerY = story ? 140 : 110;
  const logo = safeLogo(input.logo);
  const nameX = logo ? 64 + 72 + 20 : 64;
  const text = lines
    .map((l, i) => `<text x="${W / 2}" y="${top + i * lh}" text-anchor="middle" font-size="${fs}" font-weight="800" fill="#ffffff">${esc(l)}</text>`)
    .join('');
  const label = input.label
    ? `<rect x="${W / 2 - 130}" y="${top - fs * 1.9}" width="260" height="64" rx="32" fill="#ffffff" fill-opacity="0.18"/><text x="${W / 2}" y="${top - fs * 1.9 + 43}" text-anchor="middle" font-size="32" font-weight="700" fill="#ffffff">${esc(input.label)}</text>`
    : '';
  const pct = typeof input.progress === 'number' && Number.isFinite(input.progress) ? Math.max(0, Math.min(100, Math.round(input.progress))) : null;
  const barY = top + lines.length * lh + 20;
  const bar = pct !== null
    ? `<rect x="140" y="${barY}" width="${W - 280}" height="28" rx="14" fill="#ffffff" fill-opacity="0.2"/><rect x="140" y="${barY}" width="${Math.max(28, ((W - 280) * pct) / 100)}" height="28" rx="14" fill="#ffffff"/><text x="${W / 2}" y="${barY + 84}" text-anchor="middle" font-size="40" font-weight="800" fill="#ffffff">${pct}%</text>`
    : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Pretendard, 'Noto Sans KR', 'Noto Sans CJK KR', sans-serif">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#0f1f1a"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="url(#g)"/>`,
    `<circle cx="${W * 0.82}" cy="${H * 0.16}" r="${W * 0.28}" fill="#ffffff" fill-opacity="0.07" transform="rotate(${seed} ${W / 2} ${H / 2})"/>`,
    `<circle cx="${W * 0.12}" cy="${H * 0.86}" r="${W * 0.22}" fill="#ffffff" fill-opacity="0.05"/>`,
    input.label || pct !== null
      ? ''
      : `<path d="M${W / 2 - 36} ${H * 0.2} c-24 -40 -96 -28 -96 24 c0 44 60 76 96 104 c36 -28 96 -60 96 -104 c0 -52 -72 -64 -96 -24z" fill="#ffffff" fill-opacity="0.9"/>`,
    logo ? `<rect x="60" y="${headerY - 56}" width="80" height="80" rx="18" fill="#ffffff"/><image href="${logo}" x="64" y="${headerY - 52}" width="72" height="72" preserveAspectRatio="xMidYMid meet"/>` : '',
    `<text x="${nameX}" y="${headerY}" font-size="40" font-weight="700" fill="#ffffff" fill-opacity="0.92">${esc(input.merchantName)}</text>`,
    `<text x="${W - 64}" y="${headerY}" text-anchor="end" font-size="34" fill="#ffffff" fill-opacity="0.7">${input.index + 1}/${input.total}</text>`,
    label,
    text,
    bar,
    `<rect x="0" y="${H - 120}" width="${W}" height="120" fill="#000000" fill-opacity="0.35"/>`,
    `<text x="${W / 2}" y="${H - 50}" text-anchor="middle" font-size="30" fill="#ffffff" fill-opacity="0.9">${esc(input.footer)}</text>`,
    `</svg>`,
  ].join('');
}

export type { AssembleInput, AssembleResult } from './video';
