import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { mockContentAdapter } from '@/server/adapters/content';
import {
  approveContent,
  reassembleContentVideo,
  reassembleQueuedVideos,
  REASSEMBLE_MAX_ATTEMPTS,
  updateContentDraft,
  videoRebuildState,
} from '@/server/services/content';
import { CAMPAIGN_STORY_GUIDE, campaignStoryCards } from '@/lib/campaign-storytelling';
import { hasCardGuidance } from '@/lib/fundraising';
import { CampaignCardEditor } from '@/components/studio/campaign-card-editor';
import { resetDb, seedBasics } from './helpers';

/**
 * 2026-11-12 결정 사항 후속 조치 회귀 테스트.
 *  2) 참고 캠페인 외부 링크 → 화면 안 6장 구성 예시
 *  3) 기관 콘솔 메뉴 이름 정리
 *  5) 숏폼 수정 뒤 영상 재조립을 요청 밖(응답 뒤·배치)으로 — 준비 중엔 승인 불가, 경합 시 최신 장면만 반영
 */

const CAPTION = '후원하기 {링크}\nAI 생성 콘텐츠';

async function shortform(fx: { merchantId: string; merchantUserId: string }, extra: Record<string, unknown> = {}) {
  const id = newId();
  await prisma.contentItem.create({
    data: {
      id, merchantId: fx.merchantId, kind: 'SHORTFORM', status: 'REVIEW', provider: 'mock', createdBy: fx.merchantUserId,
      title: '김장 나눔', scenes: [{ caption: '처음 자막', durationSec: 1 }], videoUrl: '/api/media/first.mp4',
      caption: CAPTION, aiLabeled: true, regNoIncluded: true, ...extra,
    },
  });
  return id;
}

describe('숏폼 수정 뒤 영상 재조립(요청 밖)', () => {
  it('수정하면 조립하지 않고 작업만 쌓으며, 준비 중에는 승인이 막히고 준비되면 승인된다', async () => {
    await resetDb();
    const fx = await seedBasics();
    const id = await shortform(fx);
    const assemble = vi.spyOn(mockContentAdapter, 'assemble').mockResolvedValue({ available: true, note: '새 영상', costKrw: 0, videoUrl: '/api/media/new.mp4' });
    try {
      const updated = await updateContentDraft(fx.merchantId, id, { captions: ['고친 자막'], caption: CAPTION });
      expect(assemble).not.toHaveBeenCalled();
      expect(updated.videoUrl).toBeNull();
      expect(await videoRebuildState(id)).toBe('PREPARING');
      await expect(approveContent(fx.merchantId, id, fx.merchantUserId)).rejects.toThrow(/영상을 다시 만드는 중/);

      const r = await reassembleQueuedVideos({ limit: 5 });
      expect(r.done).toBe(1);
      expect(assemble).toHaveBeenCalledTimes(1);
      expect(assemble.mock.calls[0]![0].scenes[0]!.svg).toContain('고친 자막');
      expect((await prisma.contentItem.findUniqueOrThrow({ where: { id } })).videoUrl).toBe('/api/media/new.mp4');
      expect(await videoRebuildState(id)).toBe('NONE');

      // 같은 작업을 다시 돌려도 다시 조립하지 않는다
      expect(await reassembleContentVideo(id)).toBe('SKIPPED');
      expect(assemble).toHaveBeenCalledTimes(1);

      const approved = await approveContent(fx.merchantId, id, fx.merchantUserId);
      expect(approved.status).toBe('APPROVED');
    } finally {
      assemble.mockRestore();
    }
  });

  it('조립하는 동안 담당자가 다시 고치면 옛 결과는 버리고 다음 실행이 새 장면으로 만든다', async () => {
    await resetDb();
    const fx = await seedBasics();
    const id = await shortform(fx);
    await updateContentDraft(fx.merchantId, id, { captions: ['첫 수정'], caption: CAPTION });
    let call = 0;
    const assemble = vi.spyOn(mockContentAdapter, 'assemble').mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        // 첫 조립 도중 담당자가 다시 고친다
        await updateContentDraft(fx.merchantId, id, { captions: ['두 번째 수정'], caption: CAPTION });
        return { available: true, note: '옛 장면 영상', costKrw: 0, videoUrl: '/api/media/stale.mp4' };
      }
      return { available: true, note: '최신 장면 영상', costKrw: 0, videoUrl: '/api/media/latest.mp4' };
    });
    try {
      expect(await reassembleContentVideo(id)).toBe('STALE');
      expect((await prisma.contentItem.findUniqueOrThrow({ where: { id } })).videoUrl).toBeNull();
      expect(await videoRebuildState(id)).toBe('PREPARING');
      expect(await reassembleContentVideo(id)).toBe('DONE');
      expect(assemble.mock.calls[1]![0].scenes[0]!.svg).toContain('두 번째 수정');
      expect((await prisma.contentItem.findUniqueOrThrow({ where: { id } })).videoUrl).toBe('/api/media/latest.mp4');
    } finally {
      assemble.mockRestore();
    }
  });

  it('예외가 나면 다시 시도하고, 상한을 넘기면 FAILED — 승인은 풀리고 영상 없는 숏폼은 예약이 막힌 채로 남는다', async () => {
    await resetDb();
    const fx = await seedBasics();
    const id = await shortform(fx);
    await updateContentDraft(fx.merchantId, id, { captions: ['고친 자막'], caption: CAPTION });
    const assemble = vi.spyOn(mockContentAdapter, 'assemble').mockRejectedValue(new Error('ffmpeg 중단'));
    try {
      for (let i = 1; i < REASSEMBLE_MAX_ATTEMPTS; i += 1) expect(await reassembleContentVideo(id)).toBe('RETRY');
      expect(await reassembleContentVideo(id)).toBe('FAILED');
      expect(await videoRebuildState(id)).toBe('FAILED');
      const approved = await approveContent(fx.merchantId, id, fx.merchantUserId);
      expect(approved.status).toBe('APPROVED');
      expect(approved.videoUrl).toBeNull();
      // 다시 저장하면 새로 시도한다
      await prisma.contentItem.update({ where: { id }, data: { status: 'REVIEW' } });
      await updateContentDraft(fx.merchantId, id, { captions: ['한 번 더'], caption: CAPTION });
      expect(await videoRebuildState(id)).toBe('PREPARING');
    } finally {
      assemble.mockRestore();
    }
  });

  it('조립 도구가 꺼져 영상을 만들지 못한 결과(available=false)는 재시도 없이 닫고 승인을 막지 않는다', async () => {
    await resetDb();
    const fx = await seedBasics();
    const id = await shortform(fx);
    await updateContentDraft(fx.merchantId, id, { captions: ['고친 자막'], caption: CAPTION });
    const assemble = vi.spyOn(mockContentAdapter, 'assemble').mockResolvedValue({ available: false, note: '영상 조립이 꺼져 있어 MP4를 만들지 않았습니다.', costKrw: 0 });
    try {
      expect(await reassembleContentVideo(id)).toBe('NO_VIDEO');
      expect(await videoRebuildState(id)).toBe('NONE');
      expect((await approveContent(fx.merchantId, id, fx.merchantUserId)).status).toBe('APPROVED');
    } finally {
      assemble.mockRestore();
    }
  });

  it('카드뉴스·피드는 재조립 작업을 만들지 않는다', async () => {
    await resetDb();
    const fx = await seedBasics();
    const id = newId();
    await prisma.contentItem.create({
      data: { id, merchantId: fx.merchantId, kind: 'CARD_NEWS', status: 'REVIEW', provider: 'mock', createdBy: fx.merchantUserId, title: '카드', scenes: [{ caption: '카드 1', durationSec: 3 }], caption: CAPTION, aiLabeled: true, regNoIncluded: true },
    });
    await updateContentDraft(fx.merchantId, id, { captions: ['고친 카드'], caption: CAPTION });
    expect(await prisma.contentJob.count({ where: { itemId: id, step: 'REASSEMBLE' } })).toBe(0);
    expect(await videoRebuildState(id)).toBe('NONE');
  });
});

describe('카드뉴스 6장 구성 예시', () => {
  it('외부 단체 링크가 없고, 화면 안 예시는 6장 흐름과 같으며 안내 문구 검사에 걸리지 않는다', () => {
    const html = renderToStaticMarkup(createElement(CampaignCardEditor, { initial: [] }));
    expect(html).not.toMatch(/worldvision|월드비전|target="_blank"/);
    expect(html).toContain('6장 구성 예시 보기');
    const cards = campaignStoryCards({ title: '', summary: '', story: '', usagePlan: '' });
    expect(CAMPAIGN_STORY_GUIDE).toHaveLength(cards.length);
    for (const g of CAMPAIGN_STORY_GUIDE) expect(hasCardGuidance({ title: g.step, body: g.example })).toBe(false);
  });
});

describe('기관 콘솔 메뉴 이름', () => {
  it('두 후원자 메뉴 이름이 구분되고 아이콘이 후원 내역·문자 관리와 겹치지 않는다', () => {
    const layout = readFileSync('src/app/studio/layout.tsx', 'utf8');
    expect(layout).toContain("label: '후원자·봉사자 명단'");
    expect(layout).toContain("label: '후원자별 현황·회원'");
    expect(layout).not.toContain("label: '후원자 관리·회원'");
    expect(layout).toContain("label: '문의 응대', icon: 'inquiries'");
    const shell = readFileSync('src/components/layout/console-shell.tsx', 'utf8');
    expect(shell).toMatch(/donors: UserRoundSearch/);
    expect(shell).toMatch(/charges: HeartHandshake/);
  });
});
