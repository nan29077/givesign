import path from 'node:path';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * 업로드 이미지 저장소.
 *
 * ── 왜 추상화했는가 ──────────────────────────────────────────────────────
 * 로컬 디스크 저장은 단일 서버에서만 성립한다. AWS(ECS/Fargate/EB)로 올리면
 *   - 인스턴스를 2대 이상 띄우는 순간 A에 올린 이미지가 B 요청에서 404
 *   - 재배포·오토스케일 축소 때 컨테이너 파일시스템과 함께 **전량 소실**
 * 이 두 가지가 반드시 발생한다. 그래서 저장소를 드라이버로 분리하고,
 * 환경변수 STORAGE_DRIVER=s3 로 바꾸면 코드 수정 없이 S3 로 전환되게 했다.
 *
 * 현재 기본값은 local (서버 로컬 디스크). AWS 이관 시 s3 로 전환한다.
 */

export type StorageDriver = 'local' | 's3';

export const STORAGE_DRIVER: StorageDriver =
  (process.env.STORAGE_DRIVER ?? 'local').toLowerCase() === 's3' ? 's3' : 'local';

/** 로컬 디스크 저장 경로. next start 는 빌드 후 public/ 에 추가된 파일을 서빙하지 않는다. */
export const UPLOAD_DIR = path.join(process.cwd(), 'var', 'uploads');

const S3_BUCKET = process.env.S3_BUCKET ?? '';
const S3_PREFIX = (process.env.S3_PREFIX ?? 'uploads').replace(/^\/+|\/+$/g, '');
/** CloudFront 등 공개 배포 도메인. 없으면 /api/media 라우트를 통해 서빙한다. */
const S3_PUBLIC_BASE = (process.env.S3_PUBLIC_BASE ?? '').replace(/\/+$/, '');

/** 업로드 파일의 공개 URL. */
export function mediaUrl(name: string): string {
  if (STORAGE_DRIVER === 's3' && S3_PUBLIC_BASE) {
    return `${S3_PUBLIC_BASE}/${S3_PREFIX}/${name}`;
  }
  return `/api/media/${name}`;
}

/** 예측 불가능한 저장 파일명. 사회복지기관 식별자가 드러나지 않게 한다. */
export function newObjectName(ext: string): string {
  return `${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

/**
 * 이미지 저장. 저장에 성공하면 공개 URL 을 돌려준다.
 * S3 드라이버는 @aws-sdk/client-s3 를 지연 로딩한다(로컬 환경에 패키지가 없어도 동작).
 */
export async function putObject(name: string, body: Buffer, contentType: string): Promise<string> {
  if (STORAGE_DRIVER === 's3') {
    if (!S3_BUCKET) throw new Error('[storage] STORAGE_DRIVER=s3 인데 S3_BUCKET 이 설정되지 않았습니다.');
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: env.crypto.awsRegion });
    await client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${S3_PREFIX}/${name}`,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return mediaUrl(name);
  }

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, name), body);
  return mediaUrl(name);
}

/** 저장된 이미지 읽기 (/api/media 라우트에서 사용). */
export async function getObject(name: string): Promise<Buffer | null> {
  if (STORAGE_DRIVER === 's3') {
    if (!S3_BUCKET) return null;
    try {
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({ region: env.crypto.awsRegion });
      const res = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: `${S3_PREFIX}/${name}` }));
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch (e) {
      logger.warn('S3 객체 읽기 실패', { name, message: (e as Error).message });
      return null;
    }
  }

  try {
    return await fs.readFile(path.join(UPLOAD_DIR, name));
  } catch {
    return null;
  }
}

/**
 * 운영 환경에서 로컬 디스크 저장을 쓰고 있으면 경고한다.
 * (부팅 점검에서 호출. 다중 인스턴스·재배포 시 이미지가 사라지는 구성이다)
 */
export function storageWarnings(): string[] {
  if (STORAGE_DRIVER === 'local') {
    return [
      '이미지 저장이 서버 로컬 디스크(var/uploads)입니다. 다중 인스턴스에서는 이미지가 보이지 않고 재배포 시 사라집니다. STORAGE_DRIVER=s3 로 전환하세요.',
    ];
  }
  if (!S3_BUCKET) return ['STORAGE_DRIVER=s3 인데 S3_BUCKET 이 비어 있습니다.'];
  return [];
}
