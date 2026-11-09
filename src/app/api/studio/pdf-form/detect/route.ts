import { requireMerchant } from '@/server/auth';
import { isSameOrigin, readTextWithLimit } from '@/server/request-guard';
import { consumeRateLimit } from '@/server/rate-limit';
import type { PreviewSource } from '@/server/services/pdf-form';
import { detectByOcr } from '@/server/services/pdf-form/detect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 스캔본 서식 자동 인식(OCR) — 2026-11-12 4차 J1. 저장하지 않고 후보만 돌려준다.
 * 본문: { templateId } 또는 { basePdfUrl, token } + layout(이미 고친 자리는 다시 제안하지 않음)
 * 글자가 있는 PDF 는 편집기가 브라우저에서 바로 후보를 만든다(이 경로를 부르지 않는다).
 */
const MAX_BODY = 512 * 1024;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return Response.json({ ok: false, message: '허용되지 않은 요청입니다.' }, { status: 403 });
  const merchant = await requireMerchant().catch(() => null);
  if (!merchant) return Response.json({ ok: false, message: '사회복지기관 로그인이 필요합니다.' }, { status: 401 });
  const limit = await consumeRateLimit('pdf-detect', merchant.merchantId, 30, 600);
  if (!limit.ok) return Response.json({ ok: false, message: '자동 인식 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' }, { status: 429 });
  const read = await readTextWithLimit(req, MAX_BODY);
  if (!read.ok) return Response.json({ ok: false, message: '요청이 너무 큽니다.' }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(read.text) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }
  let source: PreviewSource;
  if (typeof body.templateId === 'string' && body.templateId) source = { templateId: body.templateId };
  else if (typeof body.basePdfUrl === 'string' && typeof body.token === 'string') source = { basePdfUrl: body.basePdfUrl, token: body.token };
  else return Response.json({ ok: false, message: '서식을 찾을 수 없습니다.' }, { status: 400 });
  const r = await detectByOcr(merchant.merchantId, source, body.layout);
  return Response.json(r, { status: r.ok ? 200 : 400, headers: { 'Cache-Control': 'no-store' } });
}
