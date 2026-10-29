import { z } from 'zod';
import type { CampaignStatus } from '@/generated/prisma/enums';

/**
 * 후원페이지·캠페인 입력 검증과 화면 공용 계산.
 * 서버 전용 로직(DB·암호화)은 src/server/services/fundraising.ts 에 둔다.
 */

/** 업로드 경로(/uploads/..)나 HTTPS 주소만 허용한다. javascript: · //evil 같은 값은 거부. */
export const safeImage = z
  .string()
  .trim()
  .max(1000)
  .refine(
    (v) => !v || (v.startsWith('/') && !v.startsWith('//') && !v.includes('\\')) || /^https:\/\//i.test(v),
    '이미지는 업로드 경로나 HTTPS 주소를 사용해 주세요.',
  );

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜 형식은 YYYY-MM-DD 입니다.');

export const donationPageSchema = z.object({
  title: z.string().trim().min(1, '대표 제목을 입력해 주세요.').max(100),
  subtitle: z.string().trim().max(300).default(''),
  intro: z.string().trim().max(10000).default(''),
  heroUrl: safeImage.default(''),
  logoUrl: safeImage.default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, '대표 색상은 #rrggbb 형식입니다.').default('#28634e'),
  thanks: z.string().trim().max(1000).default(''),
  transparencyUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => !v || /^https?:\/\//i.test(v), '공시 링크는 http(s) 주소여야 합니다.')
    .default(''),
  published: z.boolean().default(false),
  showCampaigns: z.boolean().default(true),
  showProgress: z.boolean().default(true),
  showRecentDonors: z.boolean().default(true),
});
export type DonationPageInput = z.infer<typeof donationPageSchema>;

export const defaultDonationPage: DonationPageInput = {
  title: '당신의 마음이, 이웃의 내일이 됩니다',
  subtitle: '문자 한 통에서 시작하는 따뜻한 변화',
  intro: '지역의 이웃과 함께 더 나은 일상을 만들어 갑니다. 보내주신 후원은 꼭 필요한 곳에 소중히 사용됩니다.',
  heroUrl: '/assets/givesign/hero.png',
  logoUrl: '',
  color: '#28634e',
  thanks: '함께해 주셔서 감사합니다. 보내주신 마음을 이웃에게 전하겠습니다.',
  transparencyUrl: '',
  published: false,
  showCampaigns: true,
  showProgress: true,
  showRecentDonors: true,
};

/** 캠페인 문자 키워드: 한글·영문·숫자 2~10자. 비교는 normalizeKeyword 기준(대문자·기호 제거). */
export const CAMPAIGN_CODE_RE = /^[\p{L}\p{N}]{2,10}$/u;

export function normalizeCampaignCode(raw: string): string {
  return (raw ?? '').normalize('NFKC').replace(/[\s._\-*~/+#]/gu, '').toUpperCase();
}

export const campaignSchema = z
  .object({
    code: z
      .string()
      .trim()
      .transform(normalizeCampaignCode)
      .refine((v) => CAMPAIGN_CODE_RE.test(v), '문자 키워드는 한글·영문·숫자 2~10자로 입력해 주세요.'),
    title: z.string().trim().min(1, '캠페인 제목을 입력해 주세요.').max(100),
    summary: z.string().trim().min(1, '한 줄 소개를 입력해 주세요.').max(300),
    story: z.string().trim().max(10000).default(''),
    beneficiary: z.string().trim().max(300).default(''),
    usagePlan: z.string().trim().max(3000).default(''),
    imageUrl: safeImage.default(''),
    goalAmount: z.coerce
      .number()
      .int('목표 금액은 원 단위 정수입니다.')
      .min(10000, '목표 금액은 1만원 이상이어야 합니다.')
      .max(1_000_000_000_000, '목표 금액이 너무 큽니다.'),
    startsOn: dateString,
    endsOn: dateString,
    featured: z.boolean().default(false),
    resultReport: z.string().trim().max(10000).default(''),
  })
  .refine(
    (v) => {
      const valid = (d: string) => Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
      return valid(v.startsOn) && valid(v.endsOn) && v.endsOn >= v.startsOn;
    },
    { message: '올바른 날짜를 입력하고 종료일을 시작일 이후로 설정해 주세요.', path: ['endsOn'] },
  );
export type CampaignInput = z.infer<typeof campaignSchema>;

/** KST 기준 오늘(YYYY-MM-DD). */
export const kstToday = (now = new Date()) => new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);

/** DATE 컬럼(자정 UTC) → YYYY-MM-DD */
export const dateKey = (d: Date) => d.toISOString().slice(0, 10);

/** 모금 중인가: ACTIVE 이고 오늘이 기간 안. */
export function campaignOpen(c: { status: CampaignStatus; startsOn: Date; endsOn: Date }, now = new Date()) {
  const today = kstToday(now);
  return c.status === 'ACTIVE' && dateKey(c.startsOn) <= today && today <= dateKey(c.endsOn);
}

/** 진행률(0~100, 소수 없음). 목표 초과는 100 으로 자른 값과 실제 비율을 함께 준다. */
export function campaignProgress(raised: bigint, goal: bigint) {
  if (goal <= 0n) return { percent: 0, capped: 0 };
  const percent = Number((raised * 1000n) / goal) / 10;
  return { percent, capped: Math.min(100, Math.round(percent)) };
}

/** 남은 일수(종료일 포함). 지났으면 0. */
export function daysLeft(endsOn: Date, now = new Date()) {
  const end = Date.parse(`${dateKey(endsOn)}T23:59:59+09:00`);
  return Math.max(0, Math.ceil((end - now.getTime()) / 86_400_000));
}

export const campaignStatusLabel: Record<CampaignStatus, { text: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  DRAFT: { text: '작성 중', tone: 'neutral' },
  ACTIVE: { text: '모금 중', tone: 'brand' },
  CLOSED: { text: '모금 종료', tone: 'success' },
  ARCHIVED: { text: '보관', tone: 'neutral' },
};
