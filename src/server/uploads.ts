import path from 'node:path';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * 업로드 파일 저장소.
 *
 * ── 왜 추상화했는가 ──────────────────────────────────────────────────────
 * 로컬 디스크 저장은 단일 서버에서만 성립한다. AWS(ECS/Fargate/EB)로 올리면
 *   - 인스턴스를 2대 이상 띄우는 순간 A에 올린 이미지가 B 요청에서 404
 *   - 재배포·오토스케일 축소 때 컨테이너 파일시스템과 함께 **전량 소실**
 * 이 두 가지가 반드시 발생한다. 그래서 저장소를 드라이버로 분리하고,
 * 환경변수 STORAGE_DRIVER=s3 로 바꾸면 코드 수정 없이 S3 로 전환되게 했다.
 *
 * 현재 기본값은 local (서버 로컬 디스크). AWS 이관 시 s3 로 전환한다.
 *
 * ── 객체 이름 기준 ──────────────────────────────────────────────────────
 * DB 에는 공개 주소(`mediaUrl`)가 남지만, 서버가 파일을 다시 읽을 때는 주소에서 **객체 이름**
 * (`<32자리 16진>.<확장자>`)을 뽑아(`objectNameFromUrl`) 저장소에서 읽는다. S3 + 공개 배포
 * 도메인(S3_PUBLIC_BASE) 구성이면 주소가 절대 URL 이 되므로, 두 형태를 모두 알아본다.
 *
 * ── 비공개 객체 ─────────────────────────────────────────────────────────
 * 기관이 올린 글꼴처럼 공개 주소로 내보내면 안 되는 파일은 `putPrivateObject` 로 공개 배포 경로와
 * 분리된 접두사(S3: S3_PRIVATE_PREFIX, 기본 `private`)·폴더(로컬: var/private)에 둔다.
 * `/api/media` 와 CDN 은 공개 접두사(S3_PREFIX)만 내보내므로 비공개 객체는 주소가 없다.
 */

export type StorageDriver = 'local' | 's3';

export interface StorageConfig {
  driver: StorageDriver;
  bucket: string;
  /** 공개 객체 접두사(CDN 배포 경로) */
  prefix: string;
  /** 비공개 객체 접두사. CDN 배포 경로에 넣지 않는다. */
  privatePrefix: string;
  /** CloudFront 등 공개 배포 도메인. 없으면 /api/media 라우트를 통해 서빙한다. */
  publicBase: string;
}

const trimSlashes = (v: string) => v.replace(/^\/+|\/+$/g, '');

/** 환경변수에서 저장소 구성을 읽는다(호출할 때마다 읽어 시험에서 구성을 바꿀 수 있다). */
export function storageConfig(): StorageConfig {
  return {
    driver: (process.env.STORAGE_DRIVER ?? 'local').toLowerCase() === 's3' ? 's3' : 'local',
    bucket: process.env.S3_BUCKET ?? '',
    prefix: trimSlashes(process.env.S3_PREFIX ?? 'uploads'),
    privatePrefix: trimSlashes(process.env.S3_PRIVATE_PREFIX ?? 'private'),
    publicBase: (process.env.S3_PUBLIC_BASE ?? '').replace(/\/+$/, ''),
  };
}

export const STORAGE_DRIVER: StorageDriver = storageConfig().driver;

/** 로컬 디스크 저장 경로. next start 는 빌드 후 public/ 에 추가된 파일을 서빙하지 않는다. */
export const UPLOAD_DIR = path.join(process.cwd(), 'var', 'uploads');
/** 로컬 비공개 저장 경로. /api/media 는 UPLOAD_DIR 의 바로 아래 이름만 읽으므로 여기는 서빙되지 않는다. */
export const PRIVATE_DIR = path.join(process.cwd(), 'var', 'private');

/** 저장 객체 이름 형식(newObjectName). 경로 조작 문자가 들어갈 수 없다. */
export const OBJECT_NAME_RE = /^[a-f0-9]{32}\.[a-z0-9]{2,5}$/;

/** 업로드 파일의 공개 URL. */
export function mediaUrl(name: string, cfg: StorageConfig = storageConfig()): string {
  if (cfg.driver === 's3' && cfg.publicBase) {
    return `${cfg.publicBase}/${cfg.prefix}/${name}`;
  }
  return `/api/media/${name}`;
}

/**
 * `mediaUrl` 의 역함수: 이 서비스 저장소의 공개 주소에서 객체 이름을 뽑는다. 아니면 null.
 * `/api/media/<이름>` 은 어느 구성에서나, `${S3_PUBLIC_BASE}/${S3_PREFIX}/<이름>` 은 S3 + 공개 배포 구성에서 받는다.
 */
export function objectNameFromUrl(url: string | null | undefined, cfg: StorageConfig = storageConfig()): string | null {
  if (!url || typeof url !== 'string') return null;
  const local = /^\/api\/media\/([^/?#]+)$/.exec(url);
  let name: string | null = local ? local[1] : null;
  if (!name && cfg.driver === 's3' && cfg.publicBase) {
    const head = `${cfg.publicBase}/${cfg.prefix}/`;
    if (url.startsWith(head)) name = url.slice(head.length);
  }
  return name && OBJECT_NAME_RE.test(name) ? name : null;
}

/** 이 서비스 저장소에 올린 파일의 주소인지. */
export function isOwnMediaUrl(url: string | null | undefined, cfg: StorageConfig = storageConfig()): boolean {
  return objectNameFromUrl(url, cfg) !== null;
}

/** 예측 불가능한 저장 파일명. 사회복지기관 식별자가 드러나지 않게 한다. */
export function newObjectName(ext: string): string {
  return `${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

async function s3Client() {
  const mod = await import('@aws-sdk/client-s3');
  return { mod, client: new mod.S3Client({ region: env.crypto.awsRegion }) };
}

async function s3Put(cfg: StorageConfig, key: string, body: Buffer, contentType: string, cacheControl: string) {
  if (!cfg.bucket) throw new Error('[storage] STORAGE_DRIVER=s3 인데 S3_BUCKET 이 설정되지 않았습니다.');
  const { mod, client } = await s3Client();
  await client.send(
    new mod.PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }),
  );
}

async function s3Get(cfg: StorageConfig, key: string): Promise<Buffer | null> {
  if (!cfg.bucket) return null;
  try {
    const { mod, client } = await s3Client();
    const res = await client.send(new mod.GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (e) {
    const code = (e as { name?: string }).name;
    if (code !== 'NoSuchKey') logger.warn('S3 객체 읽기 실패', { key, message: (e as Error).message });
    return null;
  }
}

/**
 * 공개 객체 저장. 저장에 성공하면 공개 URL 을 돌려준다.
 * S3 드라이버는 @aws-sdk/client-s3 를 지연 로딩한다(로컬 환경에 패키지가 없어도 동작).
 */
export async function putObject(name: string, body: Buffer, contentType: string): Promise<string> {
  const cfg = storageConfig();
  if (cfg.driver === 's3') {
    await s3Put(cfg, `${cfg.prefix}/${name}`, body, contentType, 'public, max-age=31536000, immutable');
    return mediaUrl(name, cfg);
  }

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, name), body);
  return mediaUrl(name, cfg);
}

/** 저장된 공개 객체 읽기 (/api/media 라우트에서 사용). */
export async function getObject(name: string): Promise<Buffer | null> {
  const cfg = storageConfig();
  if (cfg.driver === 's3') return s3Get(cfg, `${cfg.prefix}/${name}`);

  try {
    return await fs.readFile(path.join(UPLOAD_DIR, name));
  } catch {
    return null;
  }
}

/**
 * 비공개 객체 저장(기관이 올린 글꼴 등). 공개 주소가 없으므로 돌려주는 것은 객체 이름뿐이다.
 */
export async function putPrivateObject(name: string, body: Buffer, contentType: string): Promise<string> {
  if (!OBJECT_NAME_RE.test(name)) throw new Error('[storage] 객체 이름 형식이 올바르지 않습니다.');
  const cfg = storageConfig();
  if (cfg.driver === 's3') {
    await s3Put(cfg, `${cfg.privatePrefix}/${name}`, body, contentType, 'private, no-store');
    return name;
  }
  await fs.mkdir(PRIVATE_DIR, { recursive: true });
  await fs.writeFile(path.join(PRIVATE_DIR, name), body);
  return name;
}

/**
 * 비공개 객체 읽기. 이 구분 이전에 공개 접두사에 올라간 글꼴도 읽을 수 있게 그쪽을 한 번 더 본다
 * (운영자가 옮기기 전까지 기존 서식 결과가 바뀌지 않게).
 */
export async function getPrivateObject(name: string): Promise<Buffer | null> {
  if (!OBJECT_NAME_RE.test(name)) return null;
  const cfg = storageConfig();
  if (cfg.driver === 's3') {
    return (await s3Get(cfg, `${cfg.privatePrefix}/${name}`)) ?? (await s3Get(cfg, `${cfg.prefix}/${name}`));
  }
  for (const dir of [PRIVATE_DIR, UPLOAD_DIR]) {
    try {
      return await fs.readFile(path.join(dir, name));
    } catch {
      // 다음 위치
    }
  }
  return null;
}

/** 비공개 객체 지우기(쓰이지 않는 글꼴 정리). 없는 객체는 조용히 넘어간다. */
export async function deletePrivateObject(name: string): Promise<void> {
  if (!OBJECT_NAME_RE.test(name)) return;
  const cfg = storageConfig();
  if (cfg.driver === 's3') {
    if (!cfg.bucket) return;
    const { mod, client } = await s3Client();
    await client.send(new mod.DeleteObjectCommand({ Bucket: cfg.bucket, Key: `${cfg.privatePrefix}/${name}` }));
    return;
  }
  await fs.rm(path.join(PRIVATE_DIR, name), { force: true });
}

/**
 * 저장소 구성 경고(부팅 점검에서 호출).
 *  - 로컬 디스크: 다중 인스턴스·재배포 시 파일이 사라진다.
 *  - S3 + 공개 배포 도메인: CDN 원본 경로를 공개 접두사로만 제한해야 비공개 객체(글꼴)가 열리지 않는다.
 */
export function storageWarnings(cfg: StorageConfig = storageConfig()): string[] {
  if (cfg.driver === 'local') {
    return [
      '이미지 저장이 서버 로컬 디스크(var/uploads)입니다. 다중 인스턴스에서는 이미지가 보이지 않고 재배포 시 사라집니다. STORAGE_DRIVER=s3 로 전환하세요.',
    ];
  }
  const out: string[] = [];
  if (!cfg.bucket) out.push('STORAGE_DRIVER=s3 인데 S3_BUCKET 이 비어 있습니다.');
  if (!cfg.privatePrefix || cfg.privatePrefix === cfg.prefix || cfg.privatePrefix.startsWith(`${cfg.prefix}/`) || cfg.prefix.startsWith(`${cfg.privatePrefix}/`)) {
    out.push(
      `S3_PRIVATE_PREFIX(${cfg.privatePrefix || '비어 있음'}) 가 공개 접두사 S3_PREFIX(${cfg.prefix}) 와 겹칩니다. 기관이 올린 글꼴이 공개 주소로 열릴 수 있으니 서로 다른 최상위 접두사로 나눠 주세요.`,
    );
  }
  if (cfg.publicBase) {
    out.push(
      `S3_PUBLIC_BASE(${cfg.publicBase}) 배포는 원본 경로를 "${cfg.prefix}/" 로만 제한해야 합니다. "${cfg.privatePrefix}/" 아래(기관이 올린 글꼴)는 CDN·버킷 공개 정책에서 제외해 주세요. 이 구분 전에 "${cfg.prefix}/" 에 올라간 .ttf·.otf 파일은 "${cfg.privatePrefix}/" 로 옮겨 주세요.`,
    );
  }
  return out;
}
