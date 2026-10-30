import { respondQr } from '../_respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 기관 후원페이지 QR — GET /api/qr/[기관코드]?format=png|svg&download=1 */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  return respondQr(req, code, null);
}
