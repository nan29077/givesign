'use server';

import { headers } from 'next/headers';
import { clientIpFrom, consumeRateLimit } from '@/server/rate-limit';
import { loadDocumentContext, submitDocument } from '@/server/services/documents';
import { logger } from '@/lib/logger';

/**
 * 문서 제출 (공개 화면 — 로그인 없음).
 *
 * 후원자는 문자로 받은 작성 링크(/doc/<토큰>)에서 이 액션을 호출한다.
 * 입력값은 서식에 정의된 항목만 읽고, 검증은 서버(documents.ts)가 다시 한다
 * — 화면에서 required 를 지우고 제출할 수 있기 때문이다.
 *
 * 항목 값은 `f_<항목id>` 이름으로 온다. 서식에 없는 이름은 무시한다.
 */

export interface DocumentSubmitState {
  ok: boolean;
  message?: string;
}

/** 서명 data URL 길이 상한. 본문 검증은 documents.ts 가 매직바이트로 다시 한다. */
const SIGNATURE_MAX_CHARS = 1_000_000;

export async function submitDocumentAction(
  _prev: DocumentSubmitState,
  formData: FormData,
): Promise<DocumentSubmitState> {
  const token = String(formData.get('token') ?? '').trim();
  if (!token) return { ok: false, message: '유효하지 않은 요청입니다.' };

  const h = await headers();
  const ip = clientIpFrom((name) => h.get(name));
  const userAgent = h.get('user-agent') ?? undefined;

  // 같은 IP 에서 폼을 반복 제출하며 토큰을 찾으려는 시도를 막는다.
  const rl = await consumeRateLimit('doc-submit', ip, 30, 600);
  if (!rl.ok) return { ok: false, message: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' };

  const loaded = await loadDocumentContext(token);
  if (!loaded.ok) return { ok: false, message: loaded.reason };

  // 서식에 정의된 항목만 읽는다. 폼에 임의의 이름을 더해 보내도 저장되지 않는다.
  const values: Record<string, string> = {};
  for (const field of loaded.ctx.fields) {
    const raw = formData.get(`f_${field.id}`);
    values[field.id] = typeof raw === 'string' ? raw : '';
  }

  const signatureRaw = formData.get('signature');
  const signature =
    typeof signatureRaw === 'string' && signatureRaw.length > 0 && signatureRaw.length <= SIGNATURE_MAX_CHARS
      ? signatureRaw
      : null;

  try {
    const res = await submitDocument({ token, values, signature, ip: ip ?? undefined, userAgent });
    if (!res.ok) return { ok: false, message: res.message };
    return { ok: true, message: '제출이 완료되었습니다. 사회복지기관이 내용을 확인합니다.' };
  } catch (e) {
    logger.error('문서 제출 실패', { message: (e as Error).message });
    return { ok: false, message: '제출 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
