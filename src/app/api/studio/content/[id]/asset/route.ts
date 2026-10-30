import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { renderCaption, type Scene } from '@/server/services/content';
import type { SocialPlatform } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

/**
 * 콘텐츠 내려받기 (기관 전용).
 *   ?scene=N  → N번째 장면 SVG
 *   ?cover=1  → 표지 SVG
 *   ?caption=YOUTUBE|INSTAGRAM|FACEBOOK|QR → 그 플랫폼용 유입 링크가 들어간 캡션 텍스트
 *   ?script=1 → 자막 대본(SRT)
 * SNS 자동 게시가 열리기 전에는 이 파일로 기관이 직접 올린다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireMerchant().catch(() => null);
  if (!session) return new Response('기관 로그인이 필요합니다.', { status: 401 });
  const { id } = await ctx.params;
  const item = await prisma.contentItem.findFirst({ where: { id, merchantId: session.merchantId } });
  if (!item) return new Response('콘텐츠를 찾을 수 없습니다.', { status: 404 });
  const url = new URL(req.url);
  const scenes = (item.scenes as unknown as Scene[]) ?? [];
  const base = `givesign-${item.id.slice(-8).toLowerCase()}`;
  const svg = (body: string, name: string) =>
    new Response(body, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'content-disposition': url.searchParams.get('inline') ? 'inline' : `attachment; filename="${name}.svg"`,
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'x-content-type-options': 'nosniff',
      },
    });

  const sceneParam = url.searchParams.get('scene');
  if (sceneParam !== null) {
    const i = Number(sceneParam);
    const s = Number.isInteger(i) ? scenes[i] : undefined;
    if (!s) return new Response('장면을 찾을 수 없습니다.', { status: 404 });
    return svg(s.svg, `${base}-scene${i + 1}`);
  }
  if (url.searchParams.get('cover')) {
    if (!item.coverSvg) return new Response('표지가 없습니다.', { status: 404 });
    return svg(item.coverSvg, `${base}-cover`);
  }
  const cap = url.searchParams.get('caption');
  if (cap) {
    const platform = ['YOUTUBE', 'INSTAGRAM', 'FACEBOOK'].includes(cap) ? (cap as SocialPlatform) : null;
    const text = await renderCaption(item, platform);
    return new Response(text, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${base}-caption-${cap.toLowerCase()}.txt"`, 'cache-control': 'private, no-store' },
    });
  }
  if (url.searchParams.get('script')) {
    let t = 0;
    const ts = (sec: number) => {
      const h = String(Math.floor(sec / 3600)).padStart(2, '0');
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      return `${h}:${m}:${s},000`;
    };
    const srt = scenes
      .map((s, i) => {
        const from = t;
        t += s.durationSec;
        return `${i + 1}\n${ts(from)} --> ${ts(t)}\n${s.caption}\n`;
      })
      .join('\n');
    return new Response(srt, {
      headers: { 'content-type': 'application/x-subrip; charset=utf-8', 'content-disposition': `attachment; filename="${base}.srt"`, 'cache-control': 'private, no-store' },
    });
  }
  return new Response('요청 형식이 올바르지 않습니다.', { status: 400 });
}
