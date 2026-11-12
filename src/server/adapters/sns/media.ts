import { env } from '@/lib/env';
import { getObject, newObjectName, objectNameFromUrl, putObject } from '@/server/uploads';
import { call, SnsApiError } from './http';
import { ensureBundledFonts } from '@/server/adapters/content/fonts';

/**
 * 게시용 미디어 준비.
 *
 * SNS 그래프 API 는 이미지를 "공개 주소" 로만 받는다(서버가 가져간다). 콘텐츠 장면은 SVG 이므로
 *   SVG → PNG/JPEG(sharp) → 공개 미디어 저장소(putObject) → 절대 주소
 * 로 바꿔 넘긴다. 인스타그램·틱톡 사진은 JPEG 만 받으므로 JPEG, 페이스북은 PNG 로 만든다.
 * sharp 는 next 가 함께 설치하는 선택 의존성이라, 없으면 이미지 게시를 실패 사유로 돌려준다.
 */

export class MediaUnavailableError extends SnsApiError {}

type SharpFn = (input: Buffer, opts?: { density?: number }) => {
  png(): { toBuffer(): Promise<Buffer> };
  flatten(o: { background: string }): { jpeg(o: { quality: number }): { toBuffer(): Promise<Buffer> } };
};

async function loadSharp(): Promise<SharpFn> {
  // 첫 렌더 전에 번들 한글 글꼴을 fontconfig 에 등록한다(없으면 게시 이미지의 한글이 □ 로 깨진다).
  ensureBundledFonts();
  try {
    const mod = (await import('sharp')) as unknown as { default?: SharpFn } & SharpFn;
    return (mod.default ?? mod) as SharpFn;
  } catch {
    throw new MediaUnavailableError('이미지 변환 모듈(sharp)이 없어 SVG 장면을 이미지로 바꾸지 못했습니다. 배포 환경에 sharp 를 설치해 주세요.', 0, 'NO_SHARP');
  }
}

export async function svgToPng(svg: string): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp(Buffer.from(svg, 'utf8'), { density: 144 }).png().toBuffer();
}

export async function svgToJpeg(svg: string): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp(Buffer.from(svg, 'utf8'), { density: 144 }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
}

/** 저장소 주소를 공급자가 가져갈 수 있는 절대 주소로 */
export function absoluteMediaUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  return `${env.baseUrl.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** SVG 장면들을 공개 이미지 주소로 */
export async function publishSceneImages(svgs: string[], format: 'png' | 'jpeg'): Promise<string[]> {
  if (svgs.length === 0) throw new MediaUnavailableError('게시할 장면 이미지가 없습니다.', 0, 'NO_ASSET');
  const out: string[] = [];
  for (const svg of svgs) {
    const buf = format === 'png' ? await svgToPng(svg) : await svgToJpeg(svg);
    const url = await putObject(newObjectName(format === 'png' ? 'png' : 'jpg'), buf, format === 'png' ? 'image/png' : 'image/jpeg');
    out.push(absoluteMediaUrl(url));
  }
  return out;
}

/** 영상 바이트 읽기. 이 서비스 저장소 주소면 저장소에서, 아니면 주소에서 받는다. */
export async function loadVideoBytes(videoUrl: string): Promise<{ bytes: Buffer; contentType: string }> {
  const name = objectNameFromUrl(videoUrl);
  if (name) {
    const b = await getObject(name);
    if (!b) throw new MediaUnavailableError('영상 파일을 저장소에서 찾지 못했습니다.', 0, 'NO_VIDEO');
    return { bytes: b, contentType: name.endsWith('.webm') ? 'video/webm' : 'video/mp4' };
  }
  const res = await call(absoluteMediaUrl(videoUrl), { timeoutMs: 120_000 });
  if (!res.ok) throw new MediaUnavailableError(`영상 파일을 받지 못했습니다 (HTTP ${res.status}).`, res.status, 'NO_VIDEO');
  return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'video/mp4' };
}
