import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { notifySuperAdmins, notifyUser } from './notifications';
import { walletOverview } from './edoc-billing';

/**
 * 자가 진단 (2026-11-12 4차 I2-6, 하루 1회 배치 `/api/cron/self-check`).
 *
 *  - SNS 토큰 만료 7일 전 재연결 안내: 실연동(mock 아님) CONNECTED 채널의 만료 예정 시각
 *    (리프레시 토큰이 있으면 그 만료, 없으면 접근 토큰 만료)이 7일 안이면 1회. 만료된 뒤 알림(social-oauth)은 그대로.
 *  - 전자문서 잔액 소진 예상: 지난 30일 실제 발송 건수(차감 − 환원)로 하루 사용량을 보고, 지금 보낼 수 있는 건수가 7일 안에 바닥나면 1회
 *    (충전·정액 등 새 원장이 생기면 다시 알릴 수 있다).
 *  - MO 수신량 급감: 어제(KST) 수신이 지난 4주 같은 요일 평균의 30% 미만이고 평균이 20건 이상일 때만 기관·관리자 알림(기관·날짜 1회).
 *
 * 같은 알림은 `self_check_alert.dedupe_key` 유니크로 1회 — 키를 먼저 잡은 실행만 알린다(겹쳐 돌아도 한 번).
 */

const DAY = 86_400_000;
export const SNS_EXPIRY_NOTICE_DAYS = 7;
export const EDOC_RUNWAY_DAYS = 7;
export const MO_DROP_RATIO = 0.3;
export const MO_DROP_MIN_AVERAGE = 20;

/** 키를 잡으면 true(이번 실행이 알린다). 이미 있으면 false. */
async function claimAlert(merchantId: string, kind: string, dedupeKey: string, detail: Record<string, unknown>): Promise<boolean> {
  const r = await prisma.selfCheckAlert.createMany({ data: [{ id: newId(), merchantId, kind, dedupeKey, detail: detail as object }], skipDuplicates: true });
  return r.count > 0;
}

async function ownerUserId(merchantId: string) {
  const m = await prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { userId: true } });
  return m?.userId ?? null;
}

const PLATFORM_KO: Record<string, string> = { YOUTUBE: '유튜브', INSTAGRAM: '인스타그램', FACEBOOK: '페이스북', TIKTOK: '틱톡', NAVER_BLOG: '네이버 블로그', KAKAO_CHANNEL: '카카오 채널' };

/** 만료 예정 시각 — 리프레시 토큰이 있으면 그 만료(모르면 null = 갱신 가능), 없으면 접근 토큰 만료 */
export function socialExpiryAt(c: { refreshTokenEnc: string | null; refreshExpiresAt: Date | null; expiresAt: Date | null }): Date | null {
  return c.refreshTokenEnc ? c.refreshExpiresAt : c.expiresAt;
}

export async function checkSocialExpiry(now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + SNS_EXPIRY_NOTICE_DAYS * DAY);
  const rows = await prisma.socialChannel.findMany({
    where: { status: 'CONNECTED', mock: false, OR: [{ refreshExpiresAt: { gt: now, lte: horizon } }, { expiresAt: { gt: now, lte: horizon } }] },
    select: { id: true, merchantId: true, platform: true, accountName: true, expiresAt: true, refreshTokenEnc: true, refreshExpiresAt: true },
  });
  let sent = 0;
  for (const c of rows) {
    const at = socialExpiryAt(c);
    if (!at || at.getTime() <= now.getTime() || at.getTime() > horizon.getTime()) continue;
    if (!(await claimAlert(c.merchantId, 'SNS_TOKEN_EXPIRING', `sns-expiring:${c.id}:${at.getTime()}`, { platform: c.platform, expiresAt: at.toISOString() }))) continue;
    const userId = await ownerUserId(c.merchantId);
    if (!userId) continue;
    const days = Math.max(1, Math.ceil((at.getTime() - now.getTime()) / DAY));
    await notifyUser({
      userId,
      title: `${PLATFORM_KO[c.platform] ?? c.platform} 연결이 ${days}일 뒤 만료됩니다`,
      body: `${c.accountName} 계정 연결이 곧 끝납니다. 만료되면 예약 게시가 멈춥니다. SNS 채널 화면에서 다시 연결해 주세요.`,
      linkUrl: '/studio/channels',
    });
    sent += 1;
  }
  return sent;
}

/** 지난 30일 실제 발송 건수(차감 − 환원). 금액형 차감도 1건으로 센다. */
export async function edocUsageLast30(merchantId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 30 * DAY);
  const [use, refund] = await Promise.all([
    prisma.eDocLedger.count({ where: { merchantId, kind: 'USE', createdAt: { gte: since } } }),
    prisma.eDocLedger.count({ where: { merchantId, kind: 'REFUND', createdAt: { gte: since } } }),
  ]);
  return Math.max(0, use - refund);
}

/** 남은 일수 예상(하루 사용량 0 이면 null) */
export function edocRunwayDays(sendable: number, used30: number): number | null {
  if (used30 <= 0) return null;
  return sendable / (used30 / 30);
}

export async function checkEdocRunway(now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 30 * DAY);
  const active = await prisma.eDocLedger.groupBy({ by: ['merchantId'], where: { kind: 'USE', createdAt: { gte: since } } });
  let sent = 0;
  for (const { merchantId } of active) {
    try {
      const used = await edocUsageLast30(merchantId, now);
      const o = await walletOverview(merchantId);
      const days = edocRunwayDays(o.sendable, used);
      if (days == null || days >= EDOC_RUNWAY_DAYS) continue;
      // 마지막 충전·정액·시범·정정 원장이 바뀌면 다시 알릴 수 있게 그 id 를 키에 넣는다
      const lastGrant = await prisma.eDocLedger.findFirst({ where: { merchantId, kind: { in: ['TOPUP', 'PLAN_GRANT', 'TRIAL_GRANT', 'ADJUST'] } }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      if (!(await claimAlert(merchantId, 'EDOC_RUNWAY', `edoc-runway:${merchantId}:${lastGrant?.id ?? 'none'}`, { sendable: o.sendable, used30: used }))) continue;
      const userId = await ownerUserId(merchantId);
      if (!userId) continue;
      await notifyUser({
        userId,
        title: '전자문서 이용 잔액이 곧 바닥납니다',
        body: `지난 30일 ${used}건을 보냈습니다. 지금 보낼 수 있는 ${o.sendable}건은 이 속도로 약 ${Math.max(0, Math.floor(days))}일 안에 바닥납니다. 서명 요청이 멈추기 전에 충전 또는 정액 이용을 신청해 주세요.`,
        linkUrl: '/studio/document-billing',
      });
      sent += 1;
    } catch (e) {
      logger.warn('전자문서 잔액 진단 실패', { merchantId, message: (e as Error).message });
    }
  }
  return sent;
}

const kstKey = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const kstDayRange = (key: string) => {
  const start = new Date(Date.parse(`${key}T00:00:00+09:00`));
  return { gte: start, lt: new Date(start.getTime() + DAY) };
};
const shiftKey = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** 급감 판단(순수) — 평균 20건 이상일 때만, 어제 < 평균 × 30% */
export function moDropped(yesterday: number, weeks: number[]): { dropped: boolean; average: number } {
  const average = weeks.length ? weeks.reduce((a, b) => a + b, 0) / weeks.length : 0;
  return { dropped: average >= MO_DROP_MIN_AVERAGE && yesterday < average * MO_DROP_RATIO, average };
}

export async function checkMoDrop(now = new Date()): Promise<number> {
  const day = shiftKey(kstKey(now), -1);
  const weekKeys = [7, 14, 21, 28].map((d) => shiftKey(day, -d));
  const oldest = kstDayRange(weekKeys[3]!).gte;
  // 지난 4주 사이 수신이 있었던 기관만
  const merchants = await prisma.moInboundMessage.groupBy({ by: ['merchantId'], where: { merchantId: { not: null }, receivedAt: { gte: oldest } } });
  let sent = 0;
  for (const { merchantId } of merchants) {
    if (!merchantId) continue;
    const [y, ...weeks] = await Promise.all([day, ...weekKeys].map((k) => prisma.moInboundMessage.count({ where: { merchantId, receivedAt: kstDayRange(k) } })));
    const r = moDropped(y!, weeks);
    if (!r.dropped) continue;
    if (!(await claimAlert(merchantId, 'MO_DROP', `mo-drop:${merchantId}:${day}`, { day, count: y, average: Math.round(r.average) }))) continue;
    const m = await prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { userId: true, displayName: true } });
    const body = `${day} 문자 후원 수신 ${y}건 — 지난 4주 같은 요일 평균 ${Math.round(r.average)}건의 ${Math.round(MO_DROP_RATIO * 100)}% 미만입니다. 수신번호 안내·통신사 장애·후원 안내 문구를 확인해 주세요.`;
    if (m) await notifyUser({ userId: m.userId, title: '문자 후원 수신이 크게 줄었습니다', body, linkUrl: '/studio/messages' });
    await notifySuperAdmins({ title: `MO 수신 급감 — ${m?.displayName ?? merchantId}`, body, linkUrl: '/admin/automation' }).catch(() => undefined);
    sent += 1;
  }
  return sent;
}

export async function runSelfCheck(now = new Date()) {
  const out: Record<string, number | string> = {};
  for (const [name, fn] of [['snsExpiring', checkSocialExpiry], ['edocRunway', checkEdocRunway], ['moDrop', checkMoDrop]] as const) {
    try {
      out[name] = await fn(now);
    } catch (e) {
      logger.error('자가 진단 항목 실패', { name, message: (e as Error).message });
      out[name] = 'error';
    }
  }
  return out;
}
