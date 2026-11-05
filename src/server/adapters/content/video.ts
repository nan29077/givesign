import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath } from '@/lib/env';
import { logger } from '@/lib/logger';
import { newObjectName, putObject } from '@/server/uploads';

/**
 * 숏폼 영상 조립 (ffmpeg).
 *
 * 장면 SVG → PNG(sharp) → 장면 길이대로 이어 붙인 9:16 mp4(H.264, yuv420p, faststart).
 * 자막·"AI 생성 콘텐츠 · 모집등록번호" 표시는 장면 SVG 에 이미 그려져 있다. 음성 파일이 있으면 합친다.
 * FFMPEG_PATH 가 없거나 sharp 를 불러오지 못하면 만들지 않고 그 사실을 돌려준다(만든 척하지 않는다).
 * 외부 계약이 필요 없는 로컬 처리라 mock·llm 공급자 모두 같은 함수를 쓴다.
 */

export interface AssembleInput {
  scenes: Array<{ svg: string; durationSec: number }>;
  /** 내레이션 음성 (TTS 계약 전이라 지금은 항상 null) */
  audio?: { data: Buffer; ext: 'mp3' | 'wav' | 'm4a' } | null;
}

export interface AssembleResult {
  available: boolean;
  note: string;
  costKrw: number;
  videoUrl?: string;
}

export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
export const VIDEO_FPS = 30;

/** ffmpeg 인자 구성 (실행과 분리 — 테스트가 이 함수만으로 형태를 검증한다). */
export function buildFfmpegArgs(input: {
  frames: Array<{ file: string; durationSec: number }>;
  audioFile?: string | null;
  outFile: string;
  width?: number;
  height?: number;
  fps?: number;
}): string[] {
  const W = input.width ?? VIDEO_W;
  const H = input.height ?? VIDEO_H;
  const fps = input.fps ?? VIDEO_FPS;
  if (input.frames.length === 0) throw new Error('장면이 없습니다.');
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const f of input.frames) {
    const d = Math.max(1, Math.min(30, Math.round(f.durationSec)));
    args.push('-loop', '1', '-framerate', String(fps), '-t', String(d), '-i', f.file);
  }
  if (input.audioFile) args.push('-i', input.audioFile);
  const n = input.frames.length;
  const chains = input.frames
    .map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`)
    .join(';');
  const concat = `${input.frames.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[v]`;
  args.push('-filter_complex', `${chains};${concat}`, '-map', '[v]');
  if (input.audioFile) args.push('-map', `${n}:a`, '-c:a', 'aac', '-b:a', '128k', '-shortest');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', input.outFile);
  return args;
}

function run(bin: string, args: string[], timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg 실패: ${(stderr || err.message).toString().slice(0, 300)}`));
      else resolve();
    });
  });
}

type SharpFn = (input: Buffer, opts?: Record<string, unknown>) => { resize: (w: number, h: number, o?: Record<string, unknown>) => { png: () => { toBuffer: () => Promise<Buffer> } }; png: () => { toBuffer: () => Promise<Buffer> } };

/** sharp 가 있으면 불러온다(배포 환경에 없을 수 있다). */
export async function loadSharp(): Promise<SharpFn | null> {
  try {
    const mod = (await import('sharp')) as unknown as { default?: SharpFn };
    return (mod.default ?? (mod as unknown as SharpFn)) as SharpFn;
  } catch {
    return null;
  }
}

/** SVG 한 장을 PNG 로 (내려받기·영상 공용). sharp 가 없으면 null. */
export async function svgToPng(svg: string, width?: number, height?: number): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const img = sharp(Buffer.from(svg), { density: 72 });
  return width && height ? img.resize(width, height, { fit: 'contain' }).png().toBuffer() : img.png().toBuffer();
}

export async function assembleVideo(input: AssembleInput): Promise<AssembleResult> {
  const bin = ffmpegPath();
  const count = input.scenes.length;
  if (!bin) {
    return { available: false, note: `영상(mp4) 조립 도구(FFMPEG_PATH)가 설정되지 않아 영상을 만들지 않았습니다. 장면 ${count}개 이미지와 자막(SRT)으로 미리보기·내려받기가 됩니다.`, costKrw: 0 };
  }
  const sharp = await loadSharp();
  if (!sharp) return { available: false, note: '이미지 변환 도구(sharp)를 불러오지 못해 영상을 만들지 않았습니다.', costKrw: 0 };
  if (count === 0) return { available: false, note: '장면이 없어 영상을 만들지 않았습니다.', costKrw: 0 };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'givesign-video-'));
  try {
    const frames: Array<{ file: string; durationSec: number }> = [];
    for (let i = 0; i < count; i++) {
      const png = await sharp(Buffer.from(input.scenes[i]!.svg), { density: 72 }).resize(VIDEO_W, VIDEO_H, { fit: 'contain' }).png().toBuffer();
      const file = path.join(dir, `scene-${String(i).padStart(2, '0')}.png`);
      await fs.writeFile(file, png);
      frames.push({ file, durationSec: input.scenes[i]!.durationSec });
    }
    let audioFile: string | null = null;
    if (input.audio) {
      audioFile = path.join(dir, `voice.${input.audio.ext}`);
      await fs.writeFile(audioFile, input.audio.data);
    }
    const outFile = path.join(dir, 'out.mp4');
    const total = frames.reduce((s, f) => s + f.durationSec, 0);
    await run(bin, buildFfmpegArgs({ frames, audioFile, outFile }), Math.max(60_000, total * 8_000));
    const mp4 = await fs.readFile(outFile);
    const url = await putObject(newObjectName('mp4'), mp4, 'video/mp4');
    return { available: true, note: `장면 ${count}개 · 약 ${total}초 9:16 영상을 만들었습니다${input.audio ? ' (음성 포함)' : ' (음성 없음 — 자막 영상)'}.`, costKrw: 0, videoUrl: url };
  } catch (e) {
    logger.error('영상 조립 실패', { message: (e as Error).message });
    return { available: false, note: `영상 조립에 실패했습니다: ${(e as Error).message.slice(0, 160)}`, costKrw: 0 };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
