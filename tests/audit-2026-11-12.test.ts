import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { campaignStoryCards } from '@/lib/campaign-storytelling';
import { campaignSchema, hasCardGuidance, readCampaignCards } from '@/lib/fundraising';
import { buildFontconfigXml, SCENE_FONT_FAMILY } from '@/server/adapters/content/fonts';
import { renderSceneSvg } from '@/server/adapters/content';
import { LinkButton } from '@/components/ui';

/**
 * 2026-11-12 전체 점검 조치 회귀 테스트.
 *  1) 카드뉴스 작성 안내 문구가 그대로 저장·공개되지 않는다(읽기는 그대로).
 *  2) 장면 SVG → PNG 변환이 번들 한글 글꼴을 쓰도록 fontconfig 설정을 만든다.
 *  3) 파일 내려받기(/api/…) 버튼은 미리 불러오기 없는 일반 링크로 그린다.
 */

const base = {
  code: 'GIMJANG',
  title: '겨울 김장 나눔',
  summary: '홀몸 어르신 300가구에 김장김치를 전합니다',
  story: '',
  beneficiary: '',
  usagePlan: '',
  imageUrl: '',
  goalAmount: '3000000',
  startsOn: '2026-11-01',
  endsOn: '2026-12-31',
  featured: false,
  resultReport: '',
};

describe('카드뉴스 작성 안내 문구', () => {
  it('빈 칸으로 만든 스토리형 카드는 안내 문구로 표시되고 저장이 막힌다', () => {
    const cards = campaignStoryCards({ title: '겨울 김장 나눔', summary: '김장김치를 전합니다', story: '', usagePlan: '' });
    expect(cards.some(hasCardGuidance)).toBe(true);
    const parsed = campaignSchema.safeParse({ ...base, cardNews: cards });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toMatch(/번째 장에 작성 안내 문구가 남아 있습니다/);
  });

  it('실제 내용으로 채운 카드는 저장된다(마지막 참여 안내 문구는 막지 않는다)', () => {
    const cards = campaignStoryCards({
      title: '겨울 김장 나눔',
      summary: '김장김치를 전합니다',
      story: '혼자 겨울을 나는 어르신이 늘었습니다.\n\n올해는 김장 재료비가 크게 올랐습니다.\n\n300가구에 한 통씩 전합니다.',
      usagePlan: '배추·양념 구입, 배송',
    });
    expect(cards.some(hasCardGuidance)).toBe(false);
    expect(campaignSchema.safeParse({ ...base, cardNews: cards }).success).toBe(true);
  });

  it('이미 저장된 안내 문구 카드도 읽기에서는 사라지지 않는다', () => {
    const cards = campaignStoryCards({ title: '', summary: '', story: '', usagePlan: '' });
    expect(readCampaignCards(cards)).toHaveLength(cards.length);
  });

  it('카드뉴스 없이 저장하는 기존 흐름(개설 마법사 등)은 영향이 없다', () => {
    expect(campaignSchema.safeParse(base).success).toBe(true);
  });
});

describe('장면 이미지 번들 한글 글꼴', () => {
  it('fontconfig 설정에 기존 설정과 번들 글꼴 폴더를 함께 넣고 경로를 이스케이프한다', () => {
    const xml = buildFontconfigXml({ fontDir: '/app/assets/fonts', baseConf: '/etc/fonts/fonts.conf', cacheDir: '/tmp/c&d', windows: false });
    expect(xml).toContain('<include ignore_missing="yes">/etc/fonts/fonts.conf</include>');
    expect(xml).toContain('<dir>/app/assets/fonts</dir>');
    expect(xml).toContain('<cachedir>/tmp/c&amp;d</cachedir>');
    expect(xml).not.toContain('WINDOWSFONTDIR');
  });

  it('윈도우에서 기존 설정이 없으면 시스템 글꼴 폴더를 함께 넣는다', () => {
    const xml = buildFontconfigXml({ fontDir: 'E:\\프로젝트\\기브싸인\\assets\\fonts', baseConf: null, cacheDir: 'C:\\tmp', windows: true });
    expect(xml).toContain('<dir>WINDOWSFONTDIR</dir>');
    expect(xml).toContain('<dir>E:\\프로젝트\\기브싸인\\assets\\fonts</dir>');
  });

  it('저장소의 번들 글꼴이 있고, 장면 SVG 글꼴 목록에 그 글꼴 이름이 들어 있다', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'assets', 'fonts', 'NotoKRSans-Bold.ttf'))).toBe(true);
    expect(SCENE_FONT_FAMILY).toContain("'Noto Sans CJK KR'");
    const svg = renderSceneSvg({ caption: '김장 나눔', index: 0, total: 1, merchantName: '햇살', color: '#28634e', footer: 'AI 생성 콘텐츠', format: 'FEED' });
    expect(svg).toContain('Noto Sans CJK KR');
  });

  describe('ensureBundledFonts', () => {
    const prev = process.env.FONTCONFIG_FILE;
    afterEach(() => {
      if (prev === undefined) delete process.env.FONTCONFIG_FILE;
      else process.env.FONTCONFIG_FILE = prev;
    });

    it('운영자가 지정한 FONTCONFIG_FILE 을 포함한 새 설정을 가리키게 한다', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-font-'));
      const custom = path.join(dir, 'custom.conf');
      fs.writeFileSync(custom, '<?xml version="1.0"?><fontconfig></fontconfig>');
      process.env.FONTCONFIG_FILE = custom;
      // 모듈 상태(한 번만 적용)를 새로 시작하려고 다시 불러온다.
      const { vi } = await import('vitest');
      vi.resetModules();
      const mod = await import('@/server/adapters/content/fonts');
      const file = mod.ensureBundledFonts();
      expect(file).toBeTruthy();
      expect(process.env.FONTCONFIG_FILE).toBe(file);
      const xml = fs.readFileSync(file!, 'utf8');
      expect(xml).toContain(custom);
      expect(xml).toContain(path.join(process.cwd(), 'assets', 'fonts'));
      // 두 번째 호출은 같은 결과(한 번만 적용)
      expect(mod.ensureBundledFonts()).toBe(file);
    });
  });
});

describe('파일 내려받기 버튼', () => {
  it('/api/ 경로는 일반 링크로 그리고 next/link 전용 속성을 HTML 에 흘리지 않는다', () => {
    const html = renderToStaticMarkup(createElement(LinkButton, { href: '/api/bazaar/export?kind=ledger', prefetch: false }, '대장 내려받기'));
    expect(html).toContain('href="/api/bazaar/export?kind=ledger"');
    expect(html).not.toContain('prefetch');
  });
});
