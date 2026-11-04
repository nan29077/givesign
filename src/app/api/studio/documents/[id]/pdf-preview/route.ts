import { requireMerchant } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { consumeRateLimit } from '@/server/rate-limit';
import { previewTemplateLayout } from '@/server/services/pdf-form';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 원본 편집 미리보기: 편집 기록으로 결과 PDF 를 만들어 돌려준다(저장하지 않음).
 * 편집기는 이 PDF 를 그려 "실제로 이렇게 나간다" 를 보여 준다 — 화면 입력칸의 글꼴은
 * 브라우저 근사치라서, 원본 글꼴이 실제로 쓰였는지는 이 결과로만 확인할 수 있다.
 *
 * 응답 본문은 PDF, 글꼴 판정은 x-render-report 헤더(JSON, URI 인코딩)에 담는다.
 */
const MAX_BODY = 512 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return Response.json({ ok: false, message: '허용되지 않은 요청입니다.' }, { status: 403 });
  const merchant = await requireMerchant().catch(() => null);
  if (!merchant) return Response.json({ ok: false, message: '사회복지기관 로그인이 필요합니다.' }, { status: 401 });

  const limit = await consumeRateLimit('pdf-preview', merchant.merchantId, 240, 600);
  if (!limit.ok) {
    return Response.json({ ok: false, message: '미리보기 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' }, { status: 429 });
  }

  const text = await req.text();
  if (text.length > MAX_BODY) return Response.json({ ok: false, message: '편집 내용이 너무 큽니다.' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ ok: false, message: '편집 내용 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  const { id } = await params;
  const res = await previewTemplateLayout(merchant.merchantId, id, body);
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
