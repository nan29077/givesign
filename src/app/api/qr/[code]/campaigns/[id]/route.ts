import { respondQr } from '../../../_respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 캠페인 QR — GET /api/qr/[기관코드]/campaigns/[캠페인ID]?format=png|svg&download=1 */
export async function GET(req: Request, ctx: { params: Promise<{ code: string; id: string }> }) {
  const { code, id } = await ctx.params;
  return respondQr(req, code, id);
}
