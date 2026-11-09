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
 *  장면 이미지는 서버가 그린 SVG와 직접 제작한 기본 일러스트를 사용한다(수혜자 사진 없음).
 *  음성(TTS)은 계약 전이라 만들지 않고 그 사실을 남긴다. 영상(mp4)은 기본 FFmpeg로 조립한다
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

export { FORMAT_SIZE, type SceneFormat } from './scene-svg';
import { editorialSceneSvg, type SceneFormat } from './scene-svg';

export function kindFormat(kind: ContentKind): SceneFormat {
  if (kind === 'IMAGE_SQUARE') return 'SQUARE';
  if (kind === 'CARD_NEWS' || kind === 'IMAGE_FEED') return 'FEED';
  return 'STORY';
}

export function renderSceneSvg(input: Parameters<typeof editorialSceneSvg>[0]): string {
  return editorialSceneSvg(input, wrapText);
}

export type { AssembleInput, AssembleResult } from './video';
