import { requireMerchant } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { consumeRateLimit } from '@/server/rate-limit';
import { previewLayout, type PreviewSource } from '@/server/services/pdf-form';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 원본 편집 미리보기: 편집 기록으로 결과 PDF 를 만들어 돌려준다(저장하지 않음).
 *
 * 본문: { templateId, layout }            — 저장된 서식
 *       { basePdfUrl, token, layout }     — 서식 등록 전(업로드 응답의 서명 토큰으로 소유 확인)
 *
 * 화면 입력칸의 글꼴은 브라우저 근사치라서, 원본 글꼴이 실제로 쓰였는지는 이 결과로만 확인할 수 있다.
 * 응답 본문은 PDF, 글꼴 판정은 x-render-report 헤더(JSON, URI 인코딩)에 담는다.
 */
const MAX_BODY = 512 * 1024;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return Response.json({ ok: false, message: '허용되지 않은 요청입니다.' }, { status: 403 });
  const merchant = await requireMerchant().catch(() => null);
  if (!merchant) return Response.json({ ok: false, message: '사회복지기관 로그인이 필요합니다.' }, { status: 401 });

  const limit = await consumeRateLimit('pdf-preview', merchant.merchantId, 240, 600);
  if (!limit.ok) {
    return Response.json({ ok: false, message: '미리보기 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' }, { status: 429 });
  }

  const text = await req.text();
  if (text.length > MAX_BODY) return Response.json({ ok: false, message: '편집 내용이 너무 큽니다.' }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: '편집 내용 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  let source: PreviewSource;
  if (typeof body.templateId === 'string' && body.templateId) source = { templateId: body.templateId };
  else if (typeof body.basePdfUrl === 'string' && typeof body.token === 'string') {
    source = { basePdfUrl: body.basePdfUrl, token: body.token };
  } else return Response.json({ ok: false, message: '미리볼 서식을 찾을 수 없습니다.' }, { status: 400 });

  const res = await previewLayout(merchant.merchantId, source, body.layout);
  if (!res.ok) return Response.json(res, { status: 400 });

  const report = encodeURIComponent(
    JSON.stringify({ report: res.report, stripped: res.stripped, coverOnlyPages: res.coverOnlyPages }),
  );
  return new Response(Buffer.from(res.bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'x-render-report': report,
    },
  });
}
