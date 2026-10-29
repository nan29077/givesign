import { requireMerchant } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { consumeRateLimit } from '@/server/rate-limit';
import { putObject, newObjectName } from '@/server/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 이미지 업로드 (프로필 아바타 / 결제페이지 배너).
 *
 * 저장 위치: var/uploads/ (서버 로컬 디스크). /api/media/<파일> 라우트로 서빙된다.
 * S3 등 오브젝트 스토리지는 추후 도입. 그때는 업로드/미디어 라우트만 교체하면 된다.
 *
 * 안전장치
 *  - 사회복지기관 로그인 필수 + 동일 출처(CSRF) 검사
 *  - 형식 화이트리스트(jpg/png/webp/gif) — 확장자·MIME 이 아니라 파일 시그니처(매직바이트)로 판정
 *  - 용량 제한 5MB
 */

const MAX_BYTES = 5 * 1024 * 1024;

/** 매직바이트로 실제 이미지 형식을 판정한다. 확장자·MIME 은 위조 가능하므로 신뢰하지 않는다. */
function sniff(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  // JPEG FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  // PNG 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: 'gif', mime: 'image/gif' };
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return Response.json({ ok: false, message: '허용되지 않은 요청입니다.' }, { status: 403 });
  }

  const merchant = await requireMerchant().catch(() => null);
  if (!merchant) {
    return Response.json({ ok: false, message: '사회복지기관 로그인이 필요합니다.' }, { status: 401 });
  }

  // 5MB 파일을 횟수 제한 없이 올릴 수 있으면 저장소·비용이 소진된다.
  const byMerchant = await consumeRateLimit('upload', merchant.merchantId, 60, 600);
  if (!byMerchant.ok) {
    return Response.json(
      { ok: false, message: '이미지 업로드가 너무 잦습니다. 잠시 후 다시 시도해 주세요.' },
      { status: 429 },
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return Response.json({ ok: false, message: '이미지 파일을 선택해 주세요.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, message: '이미지 용량은 5MB 이하만 올릴 수 있습니다.' }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const kind = sniff(buf);
  if (!kind) {
    return Response.json(
      { ok: false, message: '지원하지 않는 형식입니다. JPG/PNG/WEBP/GIF 이미지만 올릴 수 있습니다.' },
      { status: 400 },
    );
  }

  // 저장소는 드라이버로 분리돼 있다(local / s3). STORAGE_DRIVER 로 전환한다.
  const name = newObjectName(kind.ext);
  const url = await putObject(name, buf, kind.mime);

  return Response.json({ ok: true, url });
}
