/**
 * 점검 F(공개 화면·후원페이지·브랜드·접근성) 조치 회귀 테스트.
 * 화면 자체는 브라우저 없이 확인할 수 없어, 화면이 기대는 순수 판단과 공개 집계만 검증한다.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { recentDonors } from '@/server/services/fundraising';
import { decideServiceMode, testModeNotice, currentServiceMode } from '@/server/services/service-mode';
import { readBusinessInfo, DEFAULT_BUSINESS_NAME } from '@/lib/business-info';
import {
  DEFAULT_BANNERS,
  LEGACY_DEFAULT_BANNERS,
  defaultBannerFor,
  isPresetBanner,
  resolveChargeBanner,
} from '@/lib/banners';
import { isOptimizableImage } from '@/lib/image-src';
import { needsRequestHost, siteUrlFromHost, SITE_NAME } from '@/lib/site-url';
import { ROBOTS_DISALLOW, buildSitemap } from '@/lib/seo';
import { activeMyTab, visibleMyTabs } from '@/components/my/my-tabs';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

describe('H-2 테스트 환경 고지', () => {
  it('실결제·실문자면 고지하지 않는다', () => {
    const m = decideServiceMode({ safeMode: false, paymentMode: 'live', mtMode: 'live' });
    expect(m.testMode).toBe(false);
    expect(testModeNotice(m)).toBeNull();
  });

  it('SAFE_MODE 또는 mock 이면 사실대로 고지한다', () => {
    expect(testModeNotice(decideServiceMode({ safeMode: true, paymentMode: 'live', mtMode: 'live' }))).toBe(
      '현재 테스트 환경이라 실제 출금과 문자 발송이 일어나지 않습니다.',
    );
    expect(testModeNotice(decideServiceMode({ safeMode: false, paymentMode: 'mock', mtMode: 'live' }))).toBe(
      '현재 테스트 환경이라 실제 출금이 일어나지 않습니다.',
    );
    expect(testModeNotice(decideServiceMode({ safeMode: false, paymentMode: 'live', mtMode: 'mock' }))).toBe(
      '현재 테스트 환경이라 실제 문자 발송이 일어나지 않습니다.',
    );
  });

  it('어댑터 상태를 알 수 없으면 실제 처리로 단정하지 않는다', () => {
    expect(decideServiceMode({ safeMode: false, paymentMode: 'unknown', mtMode: 'live' }).paymentMock).toBe(true);
  });

  it('테스트 설정(SAFE_MODE=true, mock)에서는 고지가 켜진다', () => {
    expect(currentServiceMode().testMode).toBe(true);
  });
});

describe('공개 푸터 사업자 정보', () => {
  it('값이 없으면 상호만 두고 나머지 줄은 숨긴다(지어내지 않는다)', () => {
    const info = readBusinessInfo({});
    expect(info.name).toBe(DEFAULT_BUSINESS_NAME);
    expect(info.lines).toEqual([]);
  });

  it('설정된 항목만 순서대로 싣고 공백을 정리한다', () => {
    const info = readBusinessInfo({ BUSINESS_REG_NO: ' 123-45-67890 ', BUSINESS_CEO: '홍길동', BUSINESS_ADDRESS: '  ', BUSINESS_PHONE: '1588\n0000' });
    expect(info.lines).toEqual([
      { label: '대표자', value: '홍길동' },
      { label: '사업자등록번호', value: '123-45-67890' },
      { label: '대표 전화', value: '1588 0000' },
    ]);
  });
});

describe('/c 기본 배너', () => {
  it('기본 배너 5종은 서로 다른 프리셋 WebP 파일이다', () => {
    const hashes = DEFAULT_BANNERS.map((b) => {
      const file = path.join(process.cwd(), 'public', b);
      expect(existsSync(file)).toBe(true);
      expect(b.endsWith('.webp')).toBe(true);
      return createHash('md5').update(readFileSync(file)).digest('hex');
    });
    expect(new Set(hashes).size).toBe(DEFAULT_BANNERS.length);
  });

  it('예전 기본 배너를 저장한 기관은 같은 순번의 새 프리셋으로 보이고, 저장 액션도 예전 값을 받는다', () => {
    LEGACY_DEFAULT_BANNERS.forEach((legacy, i) => {
      expect(resolveChargeBanner('m1', legacy)).toBe(DEFAULT_BANNERS[i]);
      expect(isPresetBanner(legacy)).toBe(true);
    });
    expect(isPresetBanner(DEFAULT_BANNERS[2])).toBe(true);
    expect(isPresetBanner('/banners/../../etc/passwd.png')).toBe(false);
    expect(resolveChargeBanner('m1', null)).toBe(defaultBannerFor('m1'));
    expect(resolveChargeBanner('m1', '/api/media/x.png')).toBe('/api/media/x.png');
  });
});

describe('이미지 최적화 분기', () => {
  it('저장소 정적 자산만 최적화하고 업로드·외부 주소는 원본 그대로 쓴다', () => {
    expect(isOptimizableImage('/assets/givesign/hero.png')).toBe(true);
    expect(isOptimizableImage('/assets/givesign/presets/banner-1.webp')).toBe(true);
    expect(isOptimizableImage('/api/media/abc.png')).toBe(false);
    expect(isOptimizableImage('https://cdn.example.com/a.png')).toBe(false);
    expect(isOptimizableImage('/assets/x.png?v=1')).toBe(false);
    expect(isOptimizableImage('/assets/../secret.png')).toBe(false);
    expect(isOptimizableImage(null)).toBe(false);
  });
});

describe('사이트 주소 · robots · sitemap', () => {
  it('운영에서는 요청 Host 를 읽지 않는다', () => {
    expect(needsRequestHost('https://givesign.kr', false)).toBe(false);
    expect(needsRequestHost(undefined, false)).toBe(false);
    expect(needsRequestHost('http://localhost:3060', true)).toBe(true);
    expect(needsRequestHost('https://givesign.kr', true)).toBe(false);
  });

  it('로컬 미리보기 호스트 해석은 형식이 맞는 값만 받는다', () => {
    expect(siteUrlFromHost('abc.trycloudflare.com', 'https')).toBe('https://abc.trycloudflare.com');
    expect(siteUrlFromHost('localhost:3060', null)).toBe('http://localhost:3060');
    expect(siteUrlFromHost('evil.com/<x>', null)).toBeNull();
  });

  it('siteName 표기는 한 가지다', () => {
    expect(SITE_NAME).toBe('기브싸인 GIVESIGN');
  });

  it('robots 는 API·콘솔·토큰 화면을 막는다', () => {
    for (const p of ['/api/', '/admin', '/studio', '/my', '/mock/', '/r/', '/receipt/', '/sign/']) {
      expect(ROBOTS_DISALLOW).toContain(p);
    }
  });

  it('sitemap 은 정적 공개 경로와 올바른 기관 코드만 싣는다', () => {
    const entries = buildSitemap('https://givesign.kr', [{ code: 'GIV-8K2M' }, { code: '../x' }]);
    const urls = entries.map((e) => e.url);
    expect(urls).toContain('https://givesign.kr/');
    expect(urls).toContain('https://givesign.kr/donate/GIV-8K2M');
    expect(urls.some((u) => u.includes('../x') || u.endsWith('/x'))).toBe(false);
    expect(urls.some((u) => u.includes('/admin') || u.includes('/api/'))).toBe(false);
  });
});

describe('마이페이지 탭', () => {
  it('하위 화면에서도 해당 탭이 활성이다(접두사, 가장 긴 일치)', () => {
    expect(activeMyTab('/my')).toBe('donations');
    expect(activeMyTab('/my/payments/abc')).toBe('donations');
    expect(activeMyTab('/my/agreements/abc')).toBe('recurring');
    expect(activeMyTab('/my/recurring/new')).toBe('recurring');
    expect(activeMyTab('/my/volunteer/apply')).toBe('volunteer');
    expect(activeMyTab('/my/limits')).toBe('account');
    expect(activeMyTab('/my-other')).toBeNull();
  });

  it('자원봉사 기능이 꺼지면 봉사 탭을 숨긴다', () => {
    expect(visibleMyTabs({ volunteerEnabled: false }).map((t) => t.key)).not.toContain('volunteer');
    expect(visibleMyTabs({ volunteerEnabled: true }).map((t) => t.key)).toContain('volunteer');
    expect(activeMyTab('/my/volunteer', visibleMyTabs({ volunteerEnabled: false }))).toBeNull();
  });
});

describe('H-3 공개 최근 후원 (/c 와 /donate 공통)', () => {
  let fx: Fixture;
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  async function charge(data: { status: string; isTest?: boolean; paidAt?: Date | null; amount?: number; displayName?: string }) {
    return prisma.charge.create({
      data: {
        id: newId(),
        transactionNo: `TRD-${newId().slice(-10)}`,
        merchantId: fx.merchantId,
        amount: BigInt(data.amount ?? 10000),
        displayName: data.displayName ?? '홍길동',
        message: '응원합니다',
        status: data.status as never,
        isTest: data.isTest ?? false,
        paidAt: data.paidAt === undefined ? new Date() : data.paidAt,
      },
    });
  }

  it('테스트 후원은 빼고, 결제 직후(PAYMENT_SUCCESS) 건은 포함한다', async () => {
    await charge({ status: 'SETTLED', amount: 1000 });
    await charge({ status: 'PAYMENT_SUCCESS', amount: 2000 });
    await charge({ status: 'SETTLED', amount: 3000, isTest: true });
    await charge({ status: 'PAYMENT_FAILED', amount: 4000 });
    await charge({ status: 'SETTLED', amount: 5000, paidAt: null });

    const donors = await recentDonors(fx.merchantId, 10);
    const amounts = donors.map((d) => Number(d.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([1000, 2000]);
    // 공개용 이름은 마스킹된다. 전화번호 필드는 없다.
    expect(donors.every((d) => d.name.includes('*'))).toBe(true);
    expect(Object.keys(donors[0])).not.toContain('phone');
  });
});
