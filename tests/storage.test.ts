import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 2026-11-05 점검 D H-9 — 저장소를 "객체 이름" 기준으로 다루고, 기관이 올린 글꼴은 공개 배포 경로와
 * 분리된 비공개 접두사에 둔다. 로컬 드라이버와 S3(+공개 배포 도메인) 구성을 모두 확인한다.
 */

// S3 SDK 를 메모리 버킷으로 바꾼다(실제 네트워크 없음).
const bucket = new Map<string, { body: Buffer; cache?: string }>();
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    async send(cmd: { kind: string; input: Record<string, unknown> }) {
      const key = String(cmd.input.Key);
      if (cmd.kind === 'put') {
        bucket.set(key, { body: cmd.input.Body as Buffer, cache: cmd.input.CacheControl as string });
        return {};
      }
      if (cmd.kind === 'delete') {
        bucket.delete(key);
        return {};
      }
      const hit = bucket.get(key);
      if (!hit) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return { Body: (async function* () { yield new Uint8Array(hit.body); })() };
    }
  }
  const cmd = (kind: string) => class { kind = kind; constructor(public input: Record<string, unknown>) {} };
  return { S3Client, PutObjectCommand: cmd('put'), GetObjectCommand: cmd('get'), DeleteObjectCommand: cmd('delete') };
});

import {
  getObject, getPrivateObject, isOwnMediaUrl, mediaUrl, newObjectName, objectNameFromUrl, putObject, putPrivateObject,
  storageConfig, storageWarnings, deletePrivateObject, PRIVATE_DIR, UPLOAD_DIR,
} from '@/server/uploads';
import { isMediaPdfUrl, mediaPdfName, readMediaPdf } from '@/server/services/pdf-form';

const ENV_KEYS = ['STORAGE_DRIVER', 'S3_BUCKET', 'S3_PREFIX', 'S3_PRIVATE_PREFIX', 'S3_PUBLIC_BASE'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  bucket.clear();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function useLocal() {
  for (const k of ENV_KEYS) delete process.env[k];
}
function useS3(publicBase = 'https://cdn.example.org') {
  process.env.STORAGE_DRIVER = 's3';
  process.env.S3_BUCKET = 'givesign-test';
  process.env.S3_PREFIX = 'uploads';
  delete process.env.S3_PRIVATE_PREFIX;
  if (publicBase) process.env.S3_PUBLIC_BASE = publicBase;
  else delete process.env.S3_PUBLIC_BASE;
}

describe('로컬 드라이버(기본) — 동작은 이전과 같다', () => {
  it('공개 주소는 /api/media/<이름>, 역함수로 이름을 되찾는다', async () => {
    useLocal();
    const name = newObjectName('pdf');
    const url = await putObject(name, Buffer.from('%PDF-1.4 x'), 'application/octet-stream');
    expect(url).toBe(`/api/media/${name}`);
    expect(fs.existsSync(path.join(UPLOAD_DIR, name))).toBe(true);
    expect(objectNameFromUrl(url)).toBe(name);
    expect(mediaPdfName(url)).toBe(name);
    expect((await getObject(name))?.toString()).toBe('%PDF-1.4 x');
    expect((await readMediaPdf(url))?.length).toBe(10);
    // 경로 조작·외부 주소는 이름으로 인정하지 않는다.
    expect(objectNameFromUrl('/api/media/../../etc/passwd')).toBeNull();
    expect(objectNameFromUrl(`https://cdn.example.org/uploads/${name}`)).toBeNull();
    expect(isOwnMediaUrl('https://evil.example.com/a.pdf')).toBe(false);
  });

  it('글꼴은 공개 폴더 밖(var/private)에 두어 /api/media 로 서빙되지 않는다', async () => {
    useLocal();
    const name = newObjectName('ttf');
    expect(await putPrivateObject(name, Buffer.from('font'), 'application/octet-stream')).toBe(name);
    expect(fs.existsSync(path.join(PRIVATE_DIR, name))).toBe(true);
    expect(fs.existsSync(path.join(UPLOAD_DIR, name))).toBe(false);
    expect(await getObject(name)).toBeNull(); // /api/media 가 쓰는 읽기 경로로는 보이지 않는다
    expect((await getPrivateObject(name))?.toString()).toBe('font');
    await deletePrivateObject(name);
    expect(await getPrivateObject(name)).toBeNull();
  });

  it('구분 이전에 공개 폴더에 올라간 글꼴도 읽을 수 있다(기존 서식 호환)', async () => {
    useLocal();
    const name = newObjectName('otf');
    await putObject(name, Buffer.from('legacy'), 'application/octet-stream');
    expect((await getPrivateObject(name))?.toString()).toBe('legacy');
  });
});

describe('S3 + 공개 배포 도메인(S3_PUBLIC_BASE)', () => {
  it('절대 주소도 객체 이름으로 되찾아 원본 편집 PDF 를 읽는다', async () => {
    useS3();
    const name = newObjectName('pdf');
    const url = await putObject(name, Buffer.from('%PDF-1.7 s3'), 'application/octet-stream');
    expect(url).toBe(`https://cdn.example.org/uploads/${name}`);
    expect(mediaUrl(name)).toBe(url);
    expect(objectNameFromUrl(url)).toBe(name);
    expect(isMediaPdfUrl(url)).toBe(true);
    expect((await readMediaPdf(url))?.length).toBe(11);
    // /api/media 형태도 계속 받는다(구성 전환 전 저장된 주소)
    expect(objectNameFromUrl(`/api/media/${name}`)).toBe(name);
    // 다른 도메인·다른 접두사는 받지 않는다.
    expect(objectNameFromUrl(`https://cdn.example.org/private/${name}`)).toBeNull();
    expect(objectNameFromUrl(`https://other.example.org/uploads/${name}`)).toBeNull();
  });

  it('글꼴은 공개 접두사(uploads/)가 아닌 비공개 접두사(private/)에 둔다', async () => {
    useS3();
    const name = newObjectName('ttf');
    await putPrivateObject(name, Buffer.from('font'), 'application/octet-stream');
    expect(bucket.has(`private/${name}`)).toBe(true);
    expect(bucket.has(`uploads/${name}`)).toBe(false);
    expect(bucket.get(`private/${name}`)?.cache).toBe('private, no-store');
    expect(await getObject(name)).toBeNull();
    expect((await getPrivateObject(name))?.toString()).toBe('font');
  });

  it('구성 경고: 공개 배포 경로 제한 안내, 접두사가 겹치면 경고', () => {
    useS3();
    const w = storageWarnings();
    expect(w.some((x) => x.includes('S3_PUBLIC_BASE') && x.includes('private/'))).toBe(true);
    process.env.S3_PRIVATE_PREFIX = 'uploads/private';
    expect(storageWarnings().some((x) => x.includes('겹칩니다'))).toBe(true);
    process.env.S3_PRIVATE_PREFIX = 'private';
    useS3('');
    expect(storageWarnings()).toEqual([]);
    expect(storageConfig().publicBase).toBe('');
  });

  it('공개 배포 도메인이 없으면 /api/media 주소를 쓴다', async () => {
    useS3('');
    const name = newObjectName('pdf');
    expect(await putObject(name, Buffer.from('x'), 'application/pdf')).toBe(`/api/media/${name}`);
    expect(bucket.has(`uploads/${name}`)).toBe(true);
  });
});
