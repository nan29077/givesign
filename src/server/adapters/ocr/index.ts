import { logger } from '@/lib/logger';
import { AdapterNotConfiguredError, type AdapterInfo } from '../types';

/**
 * 문서 글자 읽기(OCR) 어댑터 (2026-11-12 4차 I2 — 다른 과제와 같은 형식이라 모양을 바꾸지 않는다).
 *
 *   recognize(buffer, mime) → { lines: [{ text, box: { page, x, y, w, h }, confidence }] }
 *
 *  - box 는 쪽(1부터) 안의 비율 좌표(0~1, 왼쪽 위 기준)다. 공급자가 위치를 모르면 0 으로 채운다.
 *  - confidence 는 0~1.
 *  - mock      : 외부를 부르지 않는다. 글자를 지어내지 않고 빈 결과를 돌려준다(info().mode = 'mock').
 *                화면은 "자동 읽기는 연결 후 사용" 으로 안내한다.
 *  - anthropic : Claude Messages API 비전 입력(그림 = image, PDF = document). `ANTHROPIC_API_KEY` 가 없으면 호출하지 않는다.
 *
 * 설정: `OCR_PROVIDER=mock|anthropic`(기본 mock), 모델 `OCR_MODEL`(비우면 LLM_MODEL, 그것도 비우면 기본 모델).
 * 어댑터는 DB 를 만지지 않는다(비용 기록은 호출한 서비스). 문서 원문·응답 본문은 로그에 남기지 않는다.
 */

export interface OcrBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLine {
  text: string;
  box: OcrBox;
  confidence: number;
}

export interface OcrResult {
  lines: OcrLine[];
  /** 공급자 토큰 사용량(비용 기록용). mock 은 0 */
  usage?: { inputTokens: number; outputTokens: number };
  /** mock 공급자 결과(글자를 읽지 않았다) — 4차 J 서식 인식이 화면 표시에 쓴다 */
  mock?: boolean;
}

export interface OcrInfo extends AdapterInfo {
  model: string;
}

export interface OcrAdapter {
  info(): OcrInfo;
  recognize(buffer: Buffer, mime: string): Promise<OcrResult>;
}

/** 읽을 수 있는 파일 형식 */
export const OCR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;
export type OcrMime = (typeof OCR_MIME_TYPES)[number];
/** 공급자로 보내는 파일 상한(바이트) */
export const OCR_MAX_BYTES = 5 * 1024 * 1024;

export class OcrError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'OcrError';
  }
}

function envStr(key: string, fallback = ''): string {
  const v = process.env[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

export function ocrConfig() {
  const provider = envStr('OCR_PROVIDER', 'mock').toLowerCase();
  return {
    provider,
    model: envStr('OCR_MODEL', envStr('LLM_MODEL', 'claude-sonnet-5-5')),
    anthropicKey: envStr('ANTHROPIC_API_KEY'),
    timeoutMs: Number(envStr('LLM_TIMEOUT_MS', '60000')) || 60_000,
  };
}

export const mockOcrAdapter: OcrAdapter = {
  info: () => ({ provider: 'mock', mode: 'mock', missingCredentials: [], model: 'mock' }),
  async recognize() {
    return { lines: [], usage: { inputTokens: 0, outputTokens: 0 }, mock: true };
  },
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const OCR_PROMPT = [
  '이 문서(사업자등록증·고유번호증 또는 기관 서식)에 인쇄된 글자를 줄 단위로 그대로 옮겨라. 고치거나 추측해 채우지 않는다.',
  '각 줄의 위치는 그 쪽 안의 비율 좌표(0~1, 왼쪽 위 기준)로 적는다. 쪽 번호는 1부터.',
  '출력은 설명·코드 블록 없이 JSON 객체 하나: {"lines": [{"text": "줄 글자", "page": 1, "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.03, "confidence": 0.95}]}',
].join('\n');

function clamp01(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** 공급자 응답 JSON → 줄 목록. 형식이 틀린 줄은 버린다. */
export function parseOcrJson(text: string): OcrLine[] | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (data as { lines?: unknown })?.lines;
  if (!Array.isArray(list)) return null;
  const out: OcrLine[] = [];
  for (const raw of list.slice(0, 400)) {
    const r = raw as Record<string, unknown>;
    const s = typeof r?.text === 'string' ? r.text.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (!s) continue;
    const page = Math.max(1, Math.min(50, Math.round(Number(r.page) || 1)));
    out.push({ text: s, box: { page, x: clamp01(r.x), y: clamp01(r.y), w: clamp01(r.w), h: clamp01(r.h) }, confidence: r.confidence == null ? 0.5 : clamp01(r.confidence) });
  }
  return out;
}

export function anthropicOcrAdapter(cfg = ocrConfig()): OcrAdapter {
  const missing = cfg.anthropicKey ? [] : ['ANTHROPIC_API_KEY'];
  return {
    info: () => ({ provider: 'anthropic', mode: 'live', missingCredentials: missing, model: cfg.model }),
    async recognize(buffer, mime) {
      if (missing.length) throw new AdapterNotConfiguredError('anthropic', missing);
      if (!(OCR_MIME_TYPES as readonly string[]).includes(mime)) throw new OcrError('읽을 수 없는 파일 형식입니다(PNG·JPG·WEBP·PDF).');
      if (buffer.length > OCR_MAX_BYTES) throw new OcrError('파일은 5MB 이하만 읽을 수 있습니다.');
      const data = buffer.toString('base64');
      const source = { type: 'base64', media_type: mime, data };
      const fileBlock = mime === 'application/pdf' ? { type: 'document', source } : { type: 'image', source };
      let res: Response;
      const started = Date.now();
      try {
        res = await fetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: { 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, max_tokens: 4000, messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: OCR_PROMPT }] }] }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (e) {
        logger.warn('OCR 호출 실패(네트워크)', { provider: 'anthropic', name: (e as Error).name });
        throw new OcrError('글자 읽기 공급자에 연결하지 못했습니다.', true);
      }
      if (!res.ok) {
        logger.warn('OCR 호출 실패', { provider: 'anthropic', status: res.status, latencyMs: Date.now() - started });
        throw new OcrError(`글자 읽기 공급자 오류(${res.status})`, res.status === 429 || res.status >= 500);
      }
      const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      logger.info('OCR 호출', { provider: 'anthropic', status: res.status, latencyMs: Date.now() - started });
      const text = (body.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
      const lines = parseOcrJson(text);
      if (!lines) throw new OcrError('글자 읽기 결과 형식이 올바르지 않습니다.', true);
      return { lines, usage: { inputTokens: Number(body.usage?.input_tokens ?? 0), outputTokens: Number(body.usage?.output_tokens ?? 0) } };
    },
  };
}

/** provider 를 주지 않으면 OCR_PROVIDER. 모르는 값은 조용히 mock 으로 바꾸지 않고 설정 없음으로 본다. */
export function getOcrAdapter(provider?: string | null): OcrAdapter {
  const cfg = ocrConfig();
  const p = (provider ?? cfg.provider).toLowerCase();
  if (p === 'mock') return mockOcrAdapter;
  if (p === 'anthropic') return anthropicOcrAdapter(cfg);
  return {
    info: () => ({ provider: p, mode: 'live', missingCredentials: [`OCR_PROVIDER(${p}) 미지원`], model: cfg.model }),
    async recognize() {
      throw new AdapterNotConfiguredError(p, ['OCR_PROVIDER']);
    },
  };
}

/** 실제로 읽을 수 있는가(mock 아님 + 키 있음). 화면 버튼 노출 기준. */
export function ocrUsable(adapter: OcrAdapter = getOcrAdapter()): boolean {
  const i = adapter.info();
  return i.mode === 'live' && i.missingCredentials.length === 0;
}

/** 기본 공급자로 읽는다(형식: { lines: [{ text, box: {page, x, y, w, h}, confidence }] }). */
export async function recognize(buffer: Buffer, mime: string): Promise<OcrResult> {
  return getOcrAdapter().recognize(buffer, mime);
}
