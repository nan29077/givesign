import { requireMerchant } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { consumeRateLimit } from '@/server/rate-limit';
import { FONT_ASSET_MAX_BYTES, registerFontAsset } from '@/server/services/pdf-form/font-assets';
import { stripSubsetTag } from '@/lib/pdf-form';
import fontkit from '@pdf-lib/fontkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 원본 글꼴 파일 올리기.
 *
 * 원본 PDF 에는 보통 문서에 쓰인 글자만 들어 있어(부분집합), 새 글자가 원본에 없으면 대체 글꼴로
 * 그릴 수밖에 없다. 기관이 그 글꼴 파일(예: 함초롬바탕 TTF)을 올리면 같은 글꼴로 그린다.
 * 서식 등록 전에도 쓸 수 있도록 서식과 묶지 않는다(저장 이름만 돌려주고 편집 기록 fonts[] 에 담긴다).
 * 대신 기관 소유로 대장(`document_font_asset`)에 남겨 기관별 개수·총량 상한을 걸고, 렌더할 때
 * 그 기관이 올린 글꼴만 쓴다. 어느 서식에도 쓰이지 않은 글꼴은 전자문서 배치가 정리한다.
 *
 * 글꼴은 비공개 저장소에만 두고 공개 주소로 내보내지 않는다(글꼴 라이선스). 결과 PDF 에는 쓰인 글자만
 * 부분집합으로 들어간다.
 */
const MAX_BYTES = FONT_ASSET_MAX_BYTES;

function sniffFont(buf: Buffer): 'ttf' | 'otf' | null {
  if (buf.length < 12) return null;
  const tag = buf.subarray(0, 4).toString('latin1');
  if (tag === 'OTTO') return 'otf';
  if (tag === 'true' || (buf[0] === 0 && buf[1] === 1 && buf[2] === 0 && buf[3] === 0)) return 'ttf';
  return null;
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return Response.json({ ok: false, message: '허용되지 않은 요청입니다.' }, { status: 403 });
  const merchant = await requireMerchant().catch(() => null);
  if (!merchant) return Response.json({ ok: false, message: '사회복지기관 로그인이 필요합니다.' }, { status: 401 });

  const limit = await consumeRateLimit('pdf-font', merchant.merchantId, 20, 600);
  if (!limit.ok) return Response.json({ ok: false, message: '글꼴 업로드가 너무 잦습니다.' }, { status: 429 });

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  const match = stripSubsetTag(String(form?.get('match') ?? '').trim()).slice(0, 120);
  if (!(file instanceof File)) return Response.json({ ok: false, message: '글꼴 파일을 골라 주세요.' }, { status: 400 });
  if (!match) return Response.json({ ok: false, message: '어느 글꼴을 대신할지 골라 주세요.' }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ ok: false, message: '글꼴 파일은 25MB 이하만 올릴 수 있습니다.' }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = sniffFont(buf);
  if (!ext) {
    return Response.json(
      { ok: false, message: 'TTF·OTF 글꼴 파일만 올릴 수 있습니다. (TTC 묶음 파일은 낱개 글꼴로 풀어서 올려 주세요)' },
      { status: 400 },
    );
  }
  try {
    const font = fontkit.create(buf) as unknown as { numGlyphs?: number };
    if (!font.numGlyphs) throw new Error('empty');
  } catch {
    return Response.json({ ok: false, message: '글꼴 파일을 읽을 수 없습니다.' }, { status: 400 });
  }

  const displayName = file.name.replace(/[\\/]/g, '').slice(0, 120) || `글꼴.${ext}`;
  const saved = await registerFontAsset(merchant.merchantId, buf, ext, match, displayName);
  if (!saved.ok) return Response.json({ ok: false, message: saved.message }, { status: saved.status });
  return Response.json({ ok: true, font: { match, url: saved.asset.name, name: displayName } });
}
