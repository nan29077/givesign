import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundledFontsEnabled } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * 장면 SVG → PNG/MP4 변환(sharp·librsvg)이 번들 한글 글꼴을 쓰게 한다(2026-11-12 점검).
 *
 * librsvg 는 SVG 의 font-family 를 **서버에 설치된 글꼴(fontconfig)** 에서만 찾는다. 운영 리눅스 이미지
 * (node:slim·Amazon Linux 등)에는 한글 글꼴이 없어, 그대로 두면 카드뉴스·숏폼의 제목·기관명이 사라지고
 * 법정 표시("AI 생성 콘텐츠 · 기부금품 모집등록번호")까지 네모(□)로 깨진다.
 *
 * 저장소에 이미 있는 assets/fonts(Noto Sans CJK KR, OFL — PDF 서식 편집이 쓰는 글꼴)를 fontconfig 검색
 * 경로에 더한 설정 파일을 임시 폴더에 만들고 FONTCONFIG_FILE 로 가리킨다. 기존 설정(운영자가 지정한
 * FONTCONFIG_FILE 또는 시스템 /etc/fonts/fonts.conf)은 그대로 포함하므로 설치된 글꼴도 계속 쓴다.
 *
 * fontconfig 는 처음 글자를 그릴 때 설정을 읽으므로 **sharp 로 첫 렌더를 하기 전에** 불러야 한다
 * (sharp 를 불러오는 두 곳 — content/video.ts·sns/media.ts — 의 loadSharp 에서 호출한다).
 * GIVESIGN_BUNDLED_FONTS=off 로 끌 수 있다.
 */

let applied: string | null | undefined;

const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** fontconfig 설정 XML (테스트가 이 함수만으로 형태를 검증한다). */
export function buildFontconfigXml(input: { fontDir: string; baseConf: string | null; cacheDir: string; windows: boolean }): string {
  return [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    '<fontconfig>',
    input.baseConf ? `  <include ignore_missing="yes">${escXml(input.baseConf)}</include>` : '',
    input.windows && !input.baseConf ? '  <dir>WINDOWSFONTDIR</dir>' : '',
    `  <dir>${escXml(input.fontDir)}</dir>`,
    `  <cachedir>${escXml(input.cacheDir)}</cachedir>`,
    '</fontconfig>',
    '',
  ].filter((l) => l !== '').join('\n');
}

/** 번들 글꼴을 fontconfig 에 등록한다. 여러 번 불러도 한 번만 적용한다. 적용한 설정 파일 경로(또는 null)를 돌려준다. */
export function ensureBundledFonts(): string | null {
  if (applied !== undefined) return applied;
  applied = null;
  if (!bundledFontsEnabled()) return null;
  try {
    const fontDir = path.join(process.cwd(), 'assets', 'fonts');
    if (!fs.existsSync(fontDir)) {
      logger.warn('번들 한글 글꼴 폴더가 없어 시스템 글꼴만 사용합니다.', { fontDir });
      return null;
    }
    const prev = process.env.FONTCONFIG_FILE;
    const baseConf = prev && fs.existsSync(prev) ? prev : fs.existsSync('/etc/fonts/fonts.conf') ? '/etc/fonts/fonts.conf' : null;
    const outDir = path.join(os.tmpdir(), 'givesign-fontconfig');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, 'fonts.conf');
    const xml = buildFontconfigXml({ fontDir, baseConf, cacheDir: path.join(outDir, 'cache'), windows: process.platform === 'win32' });
    fs.writeFileSync(file, xml, 'utf8');
    process.env.FONTCONFIG_FILE = file;
    applied = file;
    return file;
  } catch (e) {
    logger.warn('번들 한글 글꼴 등록 실패 — 시스템 글꼴만 사용합니다.', { message: (e as Error).message });
    return null;
  }
}

/** 장면 SVG 의 글꼴 목록. 번들 글꼴(Noto Sans CJK KR)을 포함한다. */
export const SCENE_FONT_FAMILY = "'Malgun Gothic', Pretendard, 'Noto Sans CJK KR', 'Noto Sans KR', sans-serif";
