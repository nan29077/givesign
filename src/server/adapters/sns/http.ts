/**
 * SNS 공급자 HTTP 호출 공용 도구.
 * - 모든 호출은 `globalThis.fetch` 를 쓴다(테스트가 가짜로 바꿔 요청 형태를 검증한다).
 * - 응답 본문의 토큰·비밀은 오류 메시지에 싣지 않는다. 공급자 오류 코드·문구만 남긴다.
 */

export const SNS_TIMEOUT_MS = 20_000;

export class SnsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
    /** 토큰이 만료·폐기됐다고 공급자가 알린 경우 */
    public readonly authExpired = false,
  ) {
    super(message);
    this.name = 'SnsApiError';
  }
}

export async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const t = await res.text();
    return t ? (JSON.parse(t) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function form(params: Record<string, string | number | boolean | null | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return p;
}

export async function call(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs ?? SNS_TIMEOUT_MS) });
  } catch (e) {
    throw new SnsApiError(`공급자에 연결하지 못했습니다: ${(e as Error).message}`, 0, 'NETWORK');
  }
}

/** 공급자 오류 응답을 사람이 읽을 문구로. */
export function describeError(body: Record<string, unknown>, status: number): { message: string; code: string | null } {
  const err = body.error as Record<string, unknown> | string | undefined;
  if (typeof err === 'string') {
    return { code: err, message: String(body.error_description ?? err) };
  }
  if (err && typeof err === 'object') {
    const code = err.code != null ? String(err.code) : err.status != null ? String(err.status) : null;
    return { code, message: String(err.message ?? err.error_user_msg ?? `HTTP ${status}`) };
  }
  return { code: null, message: `HTTP ${status}` };
}

export async function expectJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const body = await readJson(res);
  if (!res.ok) {
    const d = describeError(body, res.status);
    const authExpired = res.status === 401 || d.code === 'invalid_grant' || d.code === '190' || d.code === 'access_token_invalid';
    throw new SnsApiError(`${what} 실패: ${d.message}`.slice(0, 300), res.status, d.code, authExpired);
  }
  return body;
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 캡션 길이 검증. 어댑터는 캡션을 **자르지 않는다** — 꼬리의 "AI 생성 콘텐츠·모집등록번호·후원 링크" 가 잘리면 안 되기 때문이다
 * (2026-11-06 점검 A-M10). 길이 맞춤은 content-captions.ts 가 하고, 그래도 넘치면 여기서 검증 실패로 돌려준다.
 */
export function assertCaptionFits(caption: string, limit: { chars?: number; bytes?: number }, what: string): string {
  if (limit.chars && Array.from(caption).length > limit.chars) {
    throw new SnsApiError(`${what}이(가) ${limit.chars.toLocaleString()}자를 넘어 올리지 않았습니다. 캡션 본문을 줄여 주세요.`, 0, 'CAPTION_TOO_LONG');
  }
  if (limit.bytes && Buffer.byteLength(caption, 'utf8') > limit.bytes) {
    throw new SnsApiError(`${what}이(가) ${limit.bytes.toLocaleString()}바이트를 넘어 올리지 않았습니다. 캡션 본문을 줄여 주세요.`, 0, 'CAPTION_TOO_LONG');
  }
  return caption;
}
