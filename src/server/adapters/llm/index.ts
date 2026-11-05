import { llmConfig } from '@/lib/env';
import { logger } from '@/lib/logger';
import { AdapterNotConfiguredError, type AdapterInfo } from '../types';

/**
 * LLM 어댑터 (콘텐츠 대본 · AI 초안 공통).
 *
 *  - mock      : 외부를 부르지 않는다. 호출부가 넘긴 결정적 응답(mockText)을 돌려준다. 토큰·비용 0.
 *  - anthropic : Claude Messages API (`POST https://api.anthropic.com/v1/messages`)
 *  - openai    : Chat Completions API (`POST https://api.openai.com/v1/chat/completions`)
 *
 * 키가 없으면 호출하지 않고 AdapterNotConfiguredError 를 던진다(info().missingCredentials 로도 알린다).
 * 어댑터는 DB 를 만지지 않는다 — 비용 기록(ai_usage)은 호출한 서비스가 한다.
 * 프롬프트·응답 본문은 로그에 남기지 않는다(상태 코드·토큰 수만).
 */

export interface LlmRequest {
  system: string;
  user: string;
  /** JSON 객체 하나로 답하게 한다(openai 는 response_format, anthropic 은 지시문). */
  json?: boolean;
  maxTokens: number;
  /** mock 공급자가 돌려줄 결정적 응답. 실제 공급자는 쓰지 않는다. */
  mockText?: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
}

export interface LlmInfo extends AdapterInfo {
  model: string;
}

export interface LlmAdapter {
  info(): LlmInfo;
  complete(req: LlmRequest): Promise<LlmResult>;
}

/** 공급자 호출 실패. retryable 이면 한 번 더 시도할 만하다(429·5xx·시간 초과). */
export class LlmError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
    this.name = 'LlmError';
  }
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const JSON_INSTRUCTION = '\n\n응답은 설명·코드 블록 없이 JSON 객체 하나만 출력한다.';

export const mockLlmAdapter: LlmAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [], model: 'mock' };
  },
  async complete(req) {
    return { text: req.mockText ?? (req.json ? '{}' : ''), usage: { inputTokens: 0, outputTokens: 0 } };
  },
};

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, provider: string) {
  let res: Response;
  const started = Date.now();
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as Error).name;
    logger.warn('LLM 호출 실패(네트워크)', { provider, name });
    throw new LlmError(name === 'TimeoutError' ? `[${provider}] 응답 시간 초과` : `[${provider}] 연결 실패`, null, true);
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: { message?: string; type?: string } };
      detail = j?.error?.type ?? '';
    } catch {
      /* 본문이 JSON 이 아니면 무시 */
    }
    logger.warn('LLM 호출 실패', { provider, status: res.status, latencyMs, detail });
    const retryable = res.status === 429 || res.status >= 500;
    throw new LlmError(`[${provider}] 공급자 오류 ${res.status}${detail ? ` (${detail})` : ''}`, res.status, retryable);
  }
  logger.info('LLM 호출', { provider, status: res.status, latencyMs });
  return (await res.json()) as Record<string, unknown>;
}

export function anthropicAdapter(cfg = llmConfig()): LlmAdapter {
  const missing = cfg.anthropicKey ? [] : ['ANTHROPIC_API_KEY'];
  return {
    info: () => ({ provider: 'anthropic', mode: 'live', missingCredentials: missing, model: cfg.model }),
    async complete(req) {
      if (missing.length) throw new AdapterNotConfiguredError('anthropic', missing);
      const data = await postJson(
        ANTHROPIC_URL,
        { 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        {
          model: cfg.model,
          max_tokens: req.maxTokens,
          system: req.json ? `${req.system}${JSON_INSTRUCTION}` : req.system,
          messages: [{ role: 'user', content: req.user }],
        },
        cfg.timeoutMs,
        'anthropic',
      );
      const blocks = Array.isArray(data.content) ? (data.content as Array<{ type?: string; text?: string }>) : [];
      const text = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
      const u = (data.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      if (!text) throw new LlmError('[anthropic] 빈 응답', 200, true);
      return { text, usage: { inputTokens: Number(u.input_tokens ?? 0), outputTokens: Number(u.output_tokens ?? 0) } };
    },
  };
}

export function openaiAdapter(cfg = llmConfig()): LlmAdapter {
  const missing = [...(cfg.openaiKey ? [] : ['OPENAI_API_KEY']), ...(cfg.model ? [] : ['LLM_MODEL'])];
  return {
    info: () => ({ provider: 'openai', mode: 'live', missingCredentials: missing, model: cfg.model }),
    async complete(req) {
      if (missing.length) throw new AdapterNotConfiguredError('openai', missing);
      const data = await postJson(
        OPENAI_URL,
        { authorization: `Bearer ${cfg.openaiKey}`, 'content-type': 'application/json' },
        {
          model: cfg.model,
          max_completion_tokens: req.maxTokens,
          messages: [
            { role: 'system', content: req.json ? `${req.system}${JSON_INSTRUCTION}` : req.system },
            { role: 'user', content: req.user },
          ],
          ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        },
        cfg.timeoutMs,
        'openai',
      );
      const choices = Array.isArray(data.choices) ? (data.choices as Array<{ message?: { content?: string } }>) : [];
      const text = choices[0]?.message?.content ?? '';
      const u = (data.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
      if (!text) throw new LlmError('[openai] 빈 응답', 200, true);
      return { text, usage: { inputTokens: Number(u.prompt_tokens ?? 0), outputTokens: Number(u.completion_tokens ?? 0) } };
    },
  };
}

/** provider 를 주지 않으면 LLM_PROVIDER. 모르는 값은 mock 이 아니라 설정 없음으로 본다(조용히 mock 으로 바꾸지 않는다). */
export function getLlmAdapter(provider?: string | null): LlmAdapter {
  const cfg = llmConfig();
  const p = (provider ?? cfg.provider).toLowerCase();
  if (p === 'mock') return mockLlmAdapter;
  // 공급자를 직접 고른 경우(CONTENT_PROVIDER=anthropic 등)에도 모델은 LLM_MODEL 을 따른다.
  const model = process.env.LLM_MODEL?.trim() || '';
  if (p === 'anthropic') return anthropicAdapter({ ...cfg, model: model || 'claude-sonnet-5-5' });
  if (p === 'openai') return openaiAdapter({ ...cfg, model });
  return {
    info: () => ({ provider: p, mode: 'live', missingCredentials: [`LLM_PROVIDER(${p}) 미지원`], model: cfg.model }),
    async complete() {
      throw new AdapterNotConfiguredError(p, ['LLM_PROVIDER']);
    },
  };
}

/** 공급자가 실제로 쓸 수 있는가(mock 아님 + 키 있음). AI 초안 버튼 노출 기준. */
export function llmUsable(adapter: LlmAdapter = getLlmAdapter()): boolean {
  const i = adapter.info();
  return i.mode === 'live' && i.missingCredentials.length === 0;
}

/** 사용량 × 단가(원/1천 토큰). 단가가 없으면 0. 올림해 정수 원으로. */
export function llmCostKrw(usage: LlmUsage, cfg = llmConfig()): number {
  const v = (usage.inputTokens / 1000) * cfg.krwPer1kInput + (usage.outputTokens / 1000) * cfg.krwPer1kOutput;
  return v > 0 ? Math.ceil(v) : 0;
}

/** 응답 문자열에서 JSON 객체를 꺼낸다(코드 블록·앞뒤 설명이 섞여도). 실패하면 null. */
export function extractJson(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(t.slice(start, end + 1)) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface JsonAttempt {
  usage: LlmUsage;
  ok: boolean;
}

/**
 * JSON 응답 + 검증. 형식·검증에 실패하거나 일시 오류(429·5xx·시간 초과)면 한 번 더 요청하고, 그래도 안 되면 던진다.
 * 두 번째 요청에는 실패 사유를 덧붙인다. 시도별 사용량은 onAttempt 로 넘긴다(비용 기록용 — 실패한 시도도 과금된다).
 */
export async function completeJson<T>(
  adapter: LlmAdapter,
  req: LlmRequest,
  validate: (data: Record<string, unknown>) => { ok: true; value: T } | { ok: false; reason: string },
  onAttempt?: (a: JsonAttempt) => Promise<void> | void,
): Promise<{ value: T; usage: LlmUsage }> {
  const total: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let reason = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt === 0 ? req.user : `${req.user}\n\n[이전 응답이 규칙에 맞지 않았습니다: ${reason}. 규칙을 지켜 JSON 객체 하나로 다시 작성하세요.]`;
    let r: LlmResult;
    try {
      r = await adapter.complete({ ...req, user, json: true });
    } catch (e) {
      if (e instanceof LlmError && e.retryable && attempt === 0) {
        reason = e.message;
        continue;
      }
      throw e;
    }
    total.inputTokens += r.usage.inputTokens;
    total.outputTokens += r.usage.outputTokens;
    const data = extractJson(r.text);
    const checked = data ? validate(data) : ({ ok: false, reason: 'JSON 객체가 아닙니다' } as const);
    await onAttempt?.({ usage: r.usage, ok: checked.ok });
    if (checked.ok) return { value: checked.value, usage: total };
    reason = checked.reason;
  }
  throw new LlmError(`AI 응답이 두 번 모두 규칙에 맞지 않았습니다: ${reason}`, null, false);
}
