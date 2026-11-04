import { requireMerchant } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { consumeRateLimit } from '@/server/rate-limit';
import { putObject, newObjectName } from '@/server/uploads';
import { emptyPdfLayout } from '@/lib/pdf-form';
import { fontInfoForBase, prepareBasePdf, signBasePdf } from '@/server/services/pdf-form';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 문서 서식 파일 업로드 (문서 상품).
 *
 * 저장 위치는 이미지와 같다(server/uploads 드라이버). 서빙은 /api/media/<파일> 이
 * Content-Disposition: attachment 로 내려준다 — 브라우저가 같은 origin 에서
 * 열지 않게 하려는 것이다.
 *
 * 안전장치
 *  - 사회복지기관 로그인 필수 + 동일 출처(CSRF) 검사
 *  - 형식 화이트리스트 — 확장자·MIME 이 아니라 파일 시그니처(매직바이트)로 판정
 *  - 용량 제한 10MB
 *
 * 원본 편집: 올린 파일로 편집 바탕 PDF 를 함께 만든다(`prepareBasePdf`). PDF 는 그대로,
 * PNG·JPG 는 한 쪽 PDF 로, 워드·한글은 서버에 LibreOffice 가 있을 때만 변환한다.
 * 바탕 PDF 를 만들지 못해도 업로드 자체는 성공이다(내려받기 서식으로는 쓸 수 있다).
 */

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * 매직바이트로 실제 형식을 판정한다.
 *
 * docx·hwpx 는 zip 컨테이너라 시그니처만으로는 일반 zip 과 구분되지 않는다.
 * 그래서 확장자를 **형식 판정이 아니라 두 zip 계열 중 어느 쪽으로 저장할지**에만 쓴다.
 */
function sniff(buf: Buffer, fileName: string): { ext: string } | null {
  if (buf.length < 8) return null;
  const lower = fileName.toLowerCase();

  // PDF: %PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return { ext: 'pdf' };

  // 스캔본 그림: PNG · JPG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg' };

  // ZIP 컨테이너: docx · hwpx
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    if (lower.endsWith('.hwpx')) return { ext: 'hwpx' };
    if (lower.endsWith('.docx')) return { ext: 'docx' };
    return null;
  }

  // OLE 복합 문서: 구 워드(.doc) · 한글(.hwp)
  if (
    buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0 &&
    buf[4] === 0xa1 && buf[5] === 0xb1 && buf[6] === 0x1a && buf[7] === 0xe1
  ) {
    if (lower.endsWith('.hwp')) return { ext: 'hwp' };
    if (lower.endsWith('.doc')) return { ext: 'doc' };
    return null;
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

  const byMerchant = await consumeRateLimit('upload-doc', merchant.merchantId, 30, 600);
  if (!byMerchant.ok) {
    return Response.json(
      { ok: false, message: '파일 업로드가 너무 잦습니다. 잠시 후 다시 시도해 주세요.' },
      { status: 429 },
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return Response.json({ ok: false, message: '서식 파일을 선택해 주세요.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, message: '파일 용량은 10MB 이하만 올릴 수 있습니다.' }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const kind = sniff(buf, file.name);
  if (!kind) {
    return Response.json(
      {
        ok: false,
        message: '지원하지 않는 형식입니다. PDF · DOCX · DOC · HWP · HWPX · PNG · JPG 파일만 올릴 수 있습니다.',
      },
      { status: 400 },
    );
  }

  const name = newObjectName(kind.ext);
  // 확장자별 MIME 은 /api/media 가 붙인다. 저장 시점에는 일반 바이너리로 둔다.
  const url = await putObject(name, buf, 'application/octet-stream');

  // 후원자가 내려받을 때 보여 줄 이름. 경로 구분자는 지운다.
  const displayName = file.name.replace(/[\\/]/g, '').slice(0, 120) || `문서서식.${kind.ext}`;

  // 원본 위에서 고칠 수 있게 바탕 PDF 를 만든다. 실패해도 업로드는 그대로 둔다.
  const base = await prepareBasePdf(new Uint8Array(buf), kind.ext, url).catch(() => ({
    ok: false as const,
    message: '원본 편집용 PDF 를 만들지 못했습니다. PDF 로 저장해 다시 올리면 원본 위에서 고칠 수 있습니다.',
  }));
  // 등록 화면에서 바로 미리보기·편집을 하려면 글꼴 정보와 "이 기관이 올린 파일" 토큰이 필요하다.
  const fonts = base.ok ? await fontInfoForBase(base.pdf, emptyPdfLayout()).catch(() => []) : [];
  return Response.json({
    ok: true,
    url,
    name: displayName,
    base: base.ok
      ? { ...base.info, token: signBasePdf(merchant.merchantId, base.info.basePdfUrl), fonts }
      : null,
    editMessage: base.ok ? null : base.message,
  });
}
