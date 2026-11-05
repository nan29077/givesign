import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt } from '@/lib/crypto';
import { env } from '@/lib/env';
import { inboundAndPay, moPayload, resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';
import { clearMockOutbox, readMockOutbox } from '@/server/adapters/mt';
import { clearMockAlimtalkOutbox } from '@/server/adapters/alimtalk';
import { classifySolapiStatus, SOLAPI_LIST_URL, SOLAPI_SEND_URL } from '@/server/adapters/alimtalk/solapi';
import { sendMtDetailed } from '@/server/services/charge-flow';
import { saveAlimtalkChannel, setAlimtalkChannelStatus } from '@/server/services/alimtalk';
import { ALIMTALK_REPORT_TIMEOUT_MS, processAlimtalkReports } from '@/server/services/alimtalk-reports';
import { CRON_JOBS } from '@/server/cron-registry';
import { GET as alimtalkReportsGET } from '@/app/api/cron/alimtalk-reports/route';
import * as tpl from '@/server/services/mt-templates';
import { maskForLlm, draftCampaign, AiDraftError } from '@/server/services/ai-drafts';
import { personalInfoHit, validateScriptJson } from '@/server/adapters/content/llm-script';
import type { ContentBrief } from '@/server/adapters/content/brief';
import { filterContent } from '@/server/services/content-filter';
import { kv } from '@/server/redis';
import { mockSnsAdapter } from '@/server/adapters/sns';
import { liveSnsAdapter, SNS_AUTH_EXPIRED } from '@/server/adapters/sns/live';
import { goLink, recordContentClick } from '@/server/services/content-clicks';
import { captionProblem, composePlatformCaption, LINK_TOKEN, PLATFORM_CAPTION_RULES } from '@/server/services/content-captions';
import { captionLinkReserve, processContentQueue, PUBLISHING_STALE_MS, renderPlatformPost, resolveUnknownPublish, schedulePublish } from '@/server/services/content';
import { refreshIfNeeded, SocialTokenExpiredError, SocialTokenRefreshTransientError } from '@/server/services/social-oauth';

/**
 * 2026-11-06 정밀 점검 — 콘텐츠·SNS·알림톡·봉사 영역 회귀 테스트.
 * 공급자는 모두 globalThis.fetch 가짜로 대신한다(실제 네트워크 없음).
 */

type Call = { url: string; method: string; headers: Record<string, string>; body: string | Uint8Array | null };
type Responder = (c: Call) => Response | null;

let calls: Call[] = [];
let responders: Responder[] = [];
const realFetch = globalThis.fetch;

function headersOf(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

function installFetch() {
  calls = [];
  responders = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body == null ? null : typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : (init.body as Uint8Array);
    const c: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers: headersOf(init?.headers), body };
    calls.push(c);
    for (const r of responders) {
      const res = r(c);
      if (res) return res;
    }
    throw new Error(`예상하지 못한 요청: ${c.method} ${url}`);
  }) as typeof fetch;
}

function on(method: string, match: string | RegExp, res: (c: Call) => Response) {
  responders.push((c) => (c.method === method && (typeof match === 'string' ? c.url.startsWith(match) : match.test(c.url)) ? res(c) : null));
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const S = env.integrations.social as unknown as Record<string, string>;
const A = env.integrations.alimtalk as unknown as Record<string, string>;
const AUTO = env.automation as unknown as Record<string, unknown>;
const SAFE = env.safety as unknown as Record<string, unknown>;
const snap = { S: { ...S }, A: { ...A }, AUTO: { ...AUTO }, SAFE: { ...SAFE } };

let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  clearMockOutbox();
  clearMockAlimtalkOutbox();
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(S, snap.S);
  Object.assign(A, snap.A);
  Object.assign(AUTO, snap.AUTO);
  Object.assign(SAFE, snap.SAFE);
  vi.restoreAllMocks();
});

function cronReq(path: string) {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` } });
}

// ---------------------------------------------------------------------------
describe('A-5 알림톡 전달 실패 → 문자 대체', () => {
  async function activeChannel() {
    await saveAlimtalkChannel(fx.merchantId, { channelId: '@테스트복지관', senderKey: 'KA01PF2611060000000000ab', templateCodes: { RECURRING_STARTED: 'KA01TP_REC_01' } });
    await setAlimtalkChannelStatus(fx.merchantId, 'ACTIVE', 'admin');
  }
  function liveAlimtalk() {
    SAFE.safeMode = false;
    AUTO.alimtalkEnabled = true;
    AUTO.alimtalkProvider = 'coolsms';
    Object.assign(A, { apiKey: 'NCSKEY', apiSecret: 'NCSSECRET' });
  }
  const t = () => tpl.tplRecurringStarted({ merchantName: '기관', amount: 10000n, dayOfMonth: 5, nextDate: '2026-11-05' });

  async function acceptOne(messageId = 'M4V2ATA1') {
    liveAlimtalk();
    await activeChannel();
    on('POST', SOLAPI_SEND_URL, () => json({ groupInfo: { groupId: 'G1' }, failedMessageList: [], messageList: [{ messageId, statusCode: '2000', statusMessage: '정상 접수' }] }));
    const r = await sendMtDetailed({ phone: fx.payerPhone, template: t(), merchantId: fx.merchantId });
    expect(r).toMatchObject({ ok: true, channel: 'ALIMTALK', fallback: false });
    return r.id;
  }

  it('솔라피 상태 코드 분류: 4000 수신 완료, 2000/3000·빈 값은 대기, 명시적 실패 코드만 실패', () => {
    expect(classifySolapiStatus({ status: 'COMPLETE', statusCode: '4000' }).outcome).toBe('DELIVERED');
    expect(classifySolapiStatus({ status: 'PENDING', statusCode: '2000' }).outcome).toBe('PENDING');
    expect(classifySolapiStatus({ status: 'SENDING', statusCode: '3000' }).outcome).toBe('PENDING');
    expect(classifySolapiStatus({ status: 'SENDING', statusCode: null }).outcome).toBe('PENDING');
    expect(classifySolapiStatus({ status: 'COMPLETE', statusCode: '3104', reason: '카카오톡 미사용자' })).toMatchObject({ outcome: 'FAILED', statusCode: '3104' });
    expect(classifySolapiStatus({ status: 'COMPLETE', statusCode: '3107' }).outcome).toBe('FAILED');
    expect(classifySolapiStatus({ statusCode: '1030' }).outcome).toBe('FAILED');
    // 처리 중(SENDING)인데 코드가 실패처럼 보여도 최종이 아니면 기다린다(중복 발송 방지)
    expect(classifySolapiStatus({ status: 'SENDING', statusCode: '3104' }).outcome).toBe('PENDING');
    expect(classifySolapiStatus({ status: 'COMPLETE', statusCode: 'XYZ' }).outcome).toBe('PENDING');
  });

  it('접수(2000)는 SENT 가 아니라 ACCEPTED 다 — 대체용 본문은 암호문으로만 둔다', async () => {
    const id = await acceptOne();
    const row = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'ACCEPTED', channel: 'ALIMTALK', fallback: false, providerMessageId: 'M4V2ATA1', providerCode: 'alimtalk:coolsms' });
    expect(row.acceptedAt).not.toBeNull();
    expect(row.sentAt).toBeNull();
    expect(row.bodyEnc).toBeTruthy();
    expect(row.bodyEnc).not.toContain('정기후원');
    // 문자는 아직 나가지 않았다
    expect(readMockOutbox(5)).toHaveLength(0);
  });

  it('리포트 4000 → SENT, 문자는 보내지 않고 원문 암호문을 지운다', async () => {
    const id = await acceptOne();
    on('GET', SOLAPI_LIST_URL, () => json({ messageList: { M4V2ATA1: { messageId: 'M4V2ATA1', status: 'COMPLETE', statusCode: '4000', reason: '성공', dateReceived: '2026-11-06T01:02:03.000Z' } } }));
    const r = await processAlimtalkReports();
    expect(r).toMatchObject({ checked: 1, delivered: 1, fallback: 0 });
    const list = calls.find((c) => c.url.startsWith(SOLAPI_LIST_URL))!;
    expect(new URL(list.url).searchParams.get('messageId')).toBe('M4V2ATA1');
    expect(list.headers.authorization).toMatch(/^HMAC-SHA256 apiKey=NCSKEY, /);
    const row = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'SENT', channel: 'ALIMTALK', fallback: false, bodyEnc: null });
    expect(row.sentAt?.toISOString()).toBe('2026-11-06T01:02:03.000Z');
    expect(readMockOutbox(5)).toHaveLength(0);
  });

  it('리포트 실패 코드(3104) → 같은 본문을 문자로 정확히 한 번 대체하고 channel=SMS·fallback=true 로 남긴다', async () => {
    const id = await acceptOne();
    on('GET', SOLAPI_LIST_URL, () => json({ messageList: { M4V2ATA1: { messageId: 'M4V2ATA1', status: 'COMPLETE', statusCode: '3104', reason: '카카오톡을 사용하지 않는 수신자' } } }));
    // 겹쳐 도는 배치 두 개 — 대체 문자는 한 번만
    const [a, b] = await Promise.all([processAlimtalkReports(), processAlimtalkReports()]);
    expect(a.fallback + b.fallback).toBe(1);
    const sms = readMockOutbox(10);
    expect(sms).toHaveLength(1);
    expect(sms[0]!.text).toBe(t().text);
    const row = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'SENT', channel: 'SMS', fallback: true, bodyEnc: null });
    expect(row.resultMessage).toMatch(/3104/);
    // 다음 배치에서도 다시 보내지 않는다
    expect((await processAlimtalkReports()).checked).toBe(0);
    expect(readMockOutbox(10)).toHaveLength(1);
  });

  it('결과가 아직 없으면 그대로 두고, 시한이 지나면 UNKNOWN 으로 닫는다(자동 재발송 없음)', async () => {
    const id = await acceptOne();
    on('GET', SOLAPI_LIST_URL, () => json({ messageList: { M4V2ATA1: { messageId: 'M4V2ATA1', status: 'SENDING', statusCode: '3000' } } }));
    const r = await processAlimtalkReports();
    expect(r).toMatchObject({ checked: 1, pending: 1 });
    expect((await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id } })).status).toBe('ACCEPTED');
    // 조회 오류(HTTP 500)도 상태를 바꾸지 않는다
    responders.length = 0;
    on('GET', SOLAPI_LIST_URL, () => json({ errorCode: 'InternalError', errorMessage: 'x' }, 500));
    const later = new Date(Date.now() + 5 * 60_000);
    expect((await processAlimtalkReports(later)).errors).toBe(1);
    expect((await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id } })).status).toBe('ACCEPTED');
    // 시한 경과
    const done = await processAlimtalkReports(new Date(Date.now() + ALIMTALK_REPORT_TIMEOUT_MS + 60_000));
    expect(done.unknown).toBe(1);
    const row = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'UNKNOWN', channel: 'ALIMTALK', fallback: false, bodyEnc: null });
    expect(readMockOutbox(5)).toHaveLength(0);
  });

  it('결제 건 안내면 charge.mt_status 도 ACCEPTED → 대체 결과로 맞춘다(결제 상태는 그대로)', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const paid = await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원' }), fx.merchantId);
    const chargeId = (paid as { chargeId?: string; id?: string }).chargeId ?? (await prisma.charge.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).id;
    const before = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    liveAlimtalk();
    await activeChannel();
    on('POST', SOLAPI_SEND_URL, () => json({ groupInfo: { groupId: 'G1' }, failedMessageList: [], messageList: [{ messageId: 'MC1', statusCode: '2000' }] }));
    await sendMtDetailed({ phone: fx.payerPhone, template: t(), merchantId: fx.merchantId, chargeId });
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } })).mtStatus).toBe('ACCEPTED');
    on('GET', SOLAPI_LIST_URL, () => json({ messageList: { MC1: { messageId: 'MC1', status: 'COMPLETE', statusCode: '3107' } } }));
    expect((await processAlimtalkReports()).fallback).toBe(1);
    const after = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(after.mtStatus).toBe('SENT');
    expect(after.status).toBe(before.status);
  });

  it('mock 알림톡은 리포트가 없어 그 자리에서 최종(SENT)이고, 배치 경로가 등록·인증된다', async () => {
    AUTO.alimtalkEnabled = true;
    AUTO.alimtalkProvider = 'mock';
    await activeChannel();
    const r = await sendMtDetailed({ phone: fx.payerPhone, template: t(), merchantId: fx.merchantId });
    expect(r).toMatchObject({ ok: true, channel: 'ALIMTALK' });
    const row = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ status: 'SENT', bodyEnc: null, acceptedAt: null });

    const def = CRON_JOBS.find((j) => j.name === 'alimtalk-reports');
    expect(def).toMatchObject({ path: '/api/cron/alimtalk-reports', intervalSec: 300 });
    // 비밀이 설정된 환경에서만 거절을 확인한다(로컬은 비밀 없이 통과하는 것이 정책).
    if (process.env.CRON_SECRET) {
      const bad = await alimtalkReportsGET(new Request('http://localhost/api/cron/alimtalk-reports', { headers: { authorization: 'Bearer wrong' } }));
      expect(bad.status).toBe(401);
    }
    const ok = await alimtalkReportsGET(cronReq('/api/cron/alimtalk-reports'));
    expect(ok.status).toBe(200);
    expect(await prisma.cronHeartbeat.findUnique({ where: { name: 'alimtalk-reports' } })).not.toBeNull();
  });
});


// ---------------------------------------------------------------------------
describe('A-M13 LLM 전송 전 가리기 — 외국인등록번호(뒷자리 5~8)', () => {
  it('maskForLlm·personalInfoHit·content-filter 가 [1-8] 을 모두 가린다', () => {
    for (const d of ['1', '4', '5', '6', '7', '8']) {
      const rrn = `900101-${d}234567`;
      expect(maskForLlm(`제 번호는 ${rrn} 입니다`)).toBe('제 번호는 [주민번호] 입니다');
      expect(personalInfoHit(`번호 ${rrn}`)).toMatch(/주민등록번호/);
      expect(filterContent(`번호 ${rrn}`, { bannedWords: [], maxLength: 100 }).containsPersonalInfo).toBe(true);
    }
    // 9·0 으로 시작하는 뒷자리는 등록번호가 아니다(날짜·주문번호 오탐 방지 범위 유지)
    expect(personalInfoHit('900101-9234567')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('낮음: 콘텐츠 LLM 응답 실명 검사 · AI 초안 속도 제한 저장소 장애', () => {
  const brief: ContentBrief = {
    merchantName: '기관', campaignTitle: '김장', summary: '요약', story: null, usagePlan: null, goalAmount: 0n, raisedAmount: 0n,
    daysLeft: null, keyword: null, moNumber: null, tone: 'WARM', color: '#28634e', regNo: null, bannedWords: [],
  };
  const good = () => ({
    title: '함께 담그는 겨울 김장',
    scenes: [
      { label: '표지', caption: '올겨울, 김장 한 통의 온기' },
      { label: '문제', caption: '홀로 겨울을 나는 이웃에게 김장은 큰 부담입니다.' },
      { label: '사연', caption: '해마다 기다려 주시는 이웃이 계십니다.' },
      { label: '마무리', caption: '따뜻한 겨울을 함께 만들어 주세요.' },
      { label: '사용계획', caption: '모인 후원금은 김장 재료와 배송에 쓰입니다.' },
    ],
    hashtags: ['김장나눔', '겨울나눔', '이웃사랑'],
    platforms: {
      YOUTUBE: { title: '함께 담그는 겨울 김장', body: '올겨울 김장 나눔에 함께해 주세요.' },
      INSTAGRAM: { body: '올겨울 김장 나눔 소식입니다.' },
      FACEBOOK: { body: '김장 나눔에 함께해 주세요.' },
      TIKTOK: { body: '김장 한 통의 온기' },
      NAVER_BLOG: { title: '겨울 김장 나눔 이야기', body: '올겨울에도 김장 나눔을 준비합니다.' },
      KAKAO_CHANNEL: { body: '김장 나눔 소식을 전합니다.' },
    },
  });

  it('대본 장면·플랫폼 본문에 실명 표현이 있으면 거절하고, 가린 이름(김OO)은 통과한다', () => {
    expect(validateScriptJson(good(), brief, 'CARD_NEWS').ok).toBe(true);
    const bad = good();
    bad.scenes[2]!.caption = '김영희할머니께 김장을 전합니다.';
    const r = validateScriptJson(bad, brief, 'CARD_NEWS');
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/실명/);
    const bad2 = good();
    bad2.platforms.INSTAGRAM.body = '박철수씨의 겨울';
    expect(validateScriptJson(bad2, brief, 'CARD_NEWS').ok).toBe(false);
    const masked = good();
    masked.scenes[2]!.caption = '김OO 어르신께 김장을 전합니다.';
    expect(validateScriptJson(masked, brief, 'CARD_NEWS').ok).toBe(true);
  });

  it('속도 제한 저장소가 고장 나면 AI 초안을 열어 두지 않는다(유료 호출 무제한 방지)', async () => {
    vi.spyOn(kv, 'incr').mockRejectedValue(new Error('redis down'));
    await expect(draftCampaign(fx.merchantId)).rejects.toThrow(AiDraftError);
    await expect(draftCampaign(fx.merchantId)).rejects.toThrow(/한도를 확인할 수 없어/);
  });
});

// ---------------------------------------------------------------------------
// 콘텐츠 · SNS
// ---------------------------------------------------------------------------
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#28634e"/></svg>';

function liveSocial() {
  AUTO.socialProvider = 'live';
  AUTO.socialPublishEnabled = true;
  Object.assign(S, {
    googleClientId: 'g-client', googleClientSecret: 'g-secret',
    metaAppId: 'meta-app', metaAppSecret: 'meta-secret', metaGraphVersion: 'v26.0',
    tiktokClientKey: 'tt-key', tiktokClientSecret: 'tt-secret',
    stateSecret: 'test-state-secret',
  });
}

async function channel(platform: 'YOUTUBE' | 'INSTAGRAM' | 'FACEBOOK', over: Partial<{ mock: boolean; expiresAt: Date | null; refreshTokenEnc: string | null; externalId: string }> = {}) {
  return prisma.socialChannel.create({
    data: {
      id: newId(), merchantId: fx.merchantId, platform, accountName: '기관 채널', status: 'CONNECTED', mock: over.mock ?? false, connectedBy: fx.merchantUserId,
      accessTokenEnc: over.mock ? null : encrypt('ACCESS-OLD'), externalId: over.externalId ?? 'ACC-1',
      refreshTokenEnc: over.refreshTokenEnc === undefined ? encrypt('REFRESH-1') : over.refreshTokenEnc,
      expiresAt: over.expiresAt === undefined ? null : over.expiresAt,
    },
  });
}

async function item(kind: 'IMAGE_SQUARE' | 'SHORTFORM' = 'IMAGE_SQUARE', status = 'SCHEDULED', caption = '후원하기: {링크}\nAI 생성 콘텐츠') {
  return prisma.contentItem.create({
    data: {
      id: newId(), merchantId: fx.merchantId, kind, status: status as 'SCHEDULED', title: '캠페인', provider: 'mock', createdBy: fx.merchantUserId,
      caption, scenes: [{ caption: 'a', durationSec: 5, svg }], aiLabeled: true, regNoIncluded: true,
    },
  });
}

async function scheduled(itemId: string, platform: 'YOUTUBE' | 'INSTAGRAM' | 'FACEBOOK', mock = true) {
  return prisma.contentPublish.create({ data: { id: newId(), itemId, platform, status: 'SCHEDULED', mock, scheduledAt: new Date(Date.now() - 1000) } });
}

describe('A-M8 게시 성공 뒤 기록 실패 · 조건부 실패 처리', () => {
  it('공급자 성공 뒤 성공 기록이 실패해도 예약으로 되돌리지 않는다(UNKNOWN) — 다음 배치가 다시 올리지 않는다', async () => {
    await channel('INSTAGRAM', { mock: true });
    const it1 = await item();
    const pub = await scheduled(it1.id, 'INSTAGRAM');
    const publish = vi.spyOn(mockSnsAdapter, 'publish');
    const real = prisma.contentPublish.updateMany.bind(prisma.contentPublish);
    const spy = vi.spyOn(prisma.contentPublish, 'updateMany').mockImplementation(((args: Parameters<typeof real>[0]) => {
      const d = (args as { data?: { status?: string } }).data;
      if (d?.status === 'PUBLISHED') return Promise.reject(new Error('DB 연결 끊김')) as never;
      return real(args) as never;
    }) as never);
    const r = await processContentQueue();
    spy.mockRestore();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(r.retried).toBe(0);
    const after = await prisma.contentPublish.findUniqueOrThrow({ where: { id: pub.id } });
    expect(after.status).toBe('UNKNOWN');
    expect(after.error).toMatch(/게시됨으로 표시/);
    await processContentQueue(new Date(Date.now() + 3600_000));
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('공급자 실패 사이에 행이 다른 경로로 바뀌었으면 fail() 이 덮지 않는다(PUBLISHING 일 때만)', async () => {
    await channel('INSTAGRAM', { mock: true });
    const it1 = await item();
    const pub = await scheduled(it1.id, 'INSTAGRAM');
    vi.spyOn(mockSnsAdapter, 'publish').mockImplementation(async () => {
      await prisma.contentPublish.update({ where: { id: pub.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      return { ok: false, code: 'X', message: '응답 시간 초과' };
    });
    const r = await processContentQueue();
    expect(r.retried).toBe(0);
    expect((await prisma.contentPublish.findUniqueOrThrow({ where: { id: pub.id } })).status).toBe('PUBLISHED');
  });
});

describe('A-M9 멈춘 게시는 UNKNOWN → 담당자가 다시 게시 / 게시됨으로 표시', () => {
  it('자동 재게시 없이 UNKNOWN, 예약으로 덮이지 않고, 두 동작은 UNKNOWN 일 때만 된다', async () => {
    await channel('INSTAGRAM', { mock: true });
    await channel('FACEBOOK', { mock: true });
    const it1 = await item();
    const p1 = await prisma.contentPublish.create({ data: { id: newId(), itemId: it1.id, platform: 'INSTAGRAM', status: 'PUBLISHING', attempts: 1, scheduledAt: new Date() } });
    const p2 = await prisma.contentPublish.create({ data: { id: newId(), itemId: it1.id, platform: 'FACEBOOK', status: 'PUBLISHING', attempts: 1, scheduledAt: new Date() } });
    const stale = new Date(Date.now() - PUBLISHING_STALE_MS - 60_000);
    await prisma.$executeRaw`UPDATE content_publish SET updated_at = ${stale} WHERE id IN (${p1.id}, ${p2.id})`;
    const publish = vi.spyOn(mockSnsAdapter, 'publish');
    const r = await processContentQueue();
    expect(r.recovered).toBe(2);
    expect(publish).not.toHaveBeenCalled();
    expect((await prisma.contentPublish.findUniqueOrThrow({ where: { id: p1.id } })).status).toBe('UNKNOWN');
    // 예약을 다시 눌러도 UNKNOWN 은 건드리지 않는다
    await prisma.contentItem.update({ where: { id: it1.id }, data: { status: 'APPROVED' } });
    expect(await schedulePublish(fx.merchantId, it1.id, ['INSTAGRAM'], new Date())).toEqual([]);
    // 다른 기관은 못 바꾼다
    await expect(resolveUnknownPublish('other', p1.id, 'REPUBLISH')).rejects.toThrow(/찾을 수 없/);
    // 다시 게시 → SCHEDULED(시도 0) → 배치가 올린다
    expect(await resolveUnknownPublish(fx.merchantId, p1.id, 'REPUBLISH')).toBe('SCHEDULED');
    expect(await prisma.contentPublish.findUniqueOrThrow({ where: { id: p1.id } })).toMatchObject({ status: 'SCHEDULED', attempts: 0, error: null });
    await expect(resolveUnknownPublish(fx.merchantId, p1.id, 'REPUBLISH')).rejects.toThrow(/결과 미확인/);
    expect((await processContentQueue()).published).toBe(1);
    // 게시됨으로 표시(주소는 https 만)
    await expect(resolveUnknownPublish(fx.merchantId, p2.id, 'MARK_PUBLISHED', { url: 'javascript:alert(1)' })).rejects.toThrow(/https/);
    expect(await resolveUnknownPublish(fx.merchantId, p2.id, 'MARK_PUBLISHED', { url: 'https://www.facebook.com/P/1' })).toBe('PUBLISHED');
    expect(await prisma.contentPublish.findUniqueOrThrow({ where: { id: p2.id } })).toMatchObject({ status: 'PUBLISHED', url: 'https://www.facebook.com/P/1' });
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: it1.id } })).status).toBe('PUBLISHED');
  });
});

describe('A-M10 캡션 꼬리(AI 표시·모집등록번호·링크)는 잘리지 않는다', () => {
  const footer = 'AI 생성 콘텐츠 · 기부금품 모집등록 2026-서울-00999';
  it('실제 링크로 바꾼 뒤에도 한도 안이고 꼬리가 그대로 남는다(모든 플랫폼)', () => {
    const link = goLink('01JZ0000000000000000000000');
    expect(captionLinkReserve()).toBeGreaterThanOrEqual(link.length);
    for (const platform of ['YOUTUBE', 'INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'NAVER_BLOG', 'KAKAO_CHANNEL'] as const) {
      const rule = PLATFORM_CAPTION_RULES[platform];
      const body = '가'.repeat(rule.maxChars + 500);
      const post = composePlatformCaption(platform, { title: '제목', body, tags: ['나눔'], footer }, captionLinkReserve());
      const text = post.text.replace(LINK_TOKEN, link);
      expect(captionProblem(platform, { title: post.title, text })).toBeNull();
      expect(text.endsWith(footer)).toBe(true);
      expect(text).toContain(link);
    }
  });

  it('유튜브 설명은 글자가 아니라 UTF-8 5,000바이트로 맞춘다(한글 1자 = 3바이트)', () => {
    const post = composePlatformCaption('YOUTUBE', { title: '제목', body: '한'.repeat(3000), tags: [], footer }, captionLinkReserve());
    const text = post.text.replace(LINK_TOKEN, goLink('01JZ0000000000000000000000'));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(5000);
    expect(text.endsWith(footer)).toBe(true);
    expect(composePlatformCaption('YOUTUBE', { body: '<b>강조</b>', tags: [], footer }).text).not.toMatch(/[<>]/);
  });

  it('렌더 캡션: 저장된 캡션이 링크 치환 뒤 길어지면 본문만 다시 줄인다', async () => {
    const long = { INSTAGRAM: { title: null, text: `${'나'.repeat(2150)}\n\n후원하기: {링크}\n\n${footer}` } };
    const it1 = await prisma.contentItem.create({
      data: { id: newId(), merchantId: fx.merchantId, kind: 'IMAGE_SQUARE', status: 'APPROVED', title: 't', provider: 'mock', createdBy: fx.merchantUserId, caption: `x\n후원하기: {링크}\n${footer}`, platformCaptions: long, aiLabeled: true, regNoIncluded: true },
    });
    const post = await renderPlatformPost(it1, 'INSTAGRAM', { publishId: '01JZ0000000000000000000000' });
    expect(captionProblem('INSTAGRAM', post)).toBeNull();
    expect(post.text.endsWith(footer)).toBe(true);
    expect(post.text).toContain('/go/01JZ0000000000000000000000');
  });

  it('어댑터는 자르지 않는다 — 한도를 넘는 캡션은 공급자를 부르지 않고 CAPTION_TOO_LONG', async () => {
    liveSocial();
    const r = await liveSnsAdapter.publish({ platform: 'INSTAGRAM', accessToken: 't', accountId: 'IG', caption: '가'.repeat(2201), title: 't', assets: [svg], kind: 'IMAGE_SQUARE' });
    expect(r).toMatchObject({ ok: false, code: 'CAPTION_TOO_LONG' });
    const y = await liveSnsAdapter.publish({ platform: 'YOUTUBE', accessToken: 't', caption: '한'.repeat(1700), title: 't', assets: [], kind: 'SHORTFORM', videoUrl: 'https://cdn.example/v.mp4' });
    expect(y).toMatchObject({ ok: false, code: 'CAPTION_TOO_LONG' });
    expect(y.message).toMatch(/바이트/);
    expect(calls).toHaveLength(0);
  });
});

describe('A-M11 토큰 갱신 일시 오류는 채널을 만료시키지 않는다', () => {
  it('503 → 연결 유지·알림 없음·이번 시도만 실패 / invalid_grant → EXPIRED', async () => {
    liveSocial();
    const ch = await channel('YOUTUBE', { expiresAt: new Date(Date.now() - 1000) });
    on('POST', 'https://oauth2.googleapis.com/token', () => json({ error: { code: 503, message: 'Backend Error', status: 'UNAVAILABLE' } }, 503));
    await expect(refreshIfNeeded(ch)).rejects.toThrow(SocialTokenRefreshTransientError);
    const after = await prisma.socialChannel.findUniqueOrThrow({ where: { id: ch.id } });
    expect(after.status).toBe('CONNECTED');
    expect(after.lastError).toMatch(/일시 오류/);
    expect(await prisma.notification.count({ where: { userId: fx.merchantUserId } })).toBe(0);
    // 네트워크 오류도 같다
    responders.length = 0;
    on('POST', 'https://oauth2.googleapis.com/token', () => { throw new TypeError('fetch failed'); });
    await expect(refreshIfNeeded(ch)).rejects.toThrow(SocialTokenRefreshTransientError);
    expect((await prisma.socialChannel.findUniqueOrThrow({ where: { id: ch.id } })).status).toBe('CONNECTED');
    // 게시 배치에서는 재시도로 돈다(만료로 닫지 않음)
    const it1 = await item('SHORTFORM');
    await prisma.contentItem.update({ where: { id: it1.id }, data: { videoUrl: 'https://cdn.example/v.mp4' } });
    const pub = await scheduled(it1.id, 'YOUTUBE', false);
    expect((await processContentQueue()).retried).toBe(1);
    expect((await prisma.contentPublish.findUniqueOrThrow({ where: { id: pub.id } })).status).toBe('SCHEDULED');
    // 인증 실패는 만료
    responders.length = 0;
    on('POST', 'https://oauth2.googleapis.com/token', () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    await expect(refreshIfNeeded(ch)).rejects.toThrow(SocialTokenExpiredError);
    expect((await prisma.socialChannel.findUniqueOrThrow({ where: { id: ch.id } })).status).toBe('EXPIRED');
  });
});

describe('A-M12 게시 중 토큰 폐기(AUTH_EXPIRED)', () => {
  it('채널을 만료로 바꾸고 기관에 알리며 재시도 없이 실패로 닫는다', async () => {
    liveSocial();
    await channel('FACEBOOK', { externalId: 'PAGE1', refreshTokenEnc: null });
    const it1 = await item();
    const pub = await scheduled(it1.id, 'FACEBOOK', false);
    vi.spyOn(liveSnsAdapter, 'publish').mockResolvedValue({ ok: false, code: SNS_AUTH_EXPIRED, message: '페이스북 사진 실패: Error validating access token' });
    const r = await processContentQueue();
    expect(r).toMatchObject({ failed: 1, retried: 0 });
    const after = await prisma.contentPublish.findUniqueOrThrow({ where: { id: pub.id } });
    expect(after).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(after.error).toMatch(/다시 연결/);
    const ch = await prisma.socialChannel.findFirstOrThrow({ where: { merchantId: fx.merchantId, platform: 'FACEBOOK' } });
    expect(ch.status).toBe('EXPIRED');
    expect(await prisma.notification.count({ where: { userId: fx.merchantUserId } })).toBe(1);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: it1.id } })).status).toBe('APPROVED');
  });
});

describe('낮음: 예약 대상 · 클릭 집계', () => {
  it('영상 없는 숏폼은 영상 플랫폼에 예약하지 않는다', async () => {
    await channel('YOUTUBE', { mock: true });
    const it1 = await item('SHORTFORM', 'APPROVED');
    await expect(schedulePublish(fx.merchantId, it1.id, ['YOUTUBE'], new Date())).rejects.toThrow(/영상 파일이 없어/);
    await prisma.contentItem.update({ where: { id: it1.id }, data: { videoUrl: '/api/media/v.mp4' } });
    expect(await schedulePublish(fx.merchantId, it1.id, ['YOUTUBE'], new Date())).toEqual(['YOUTUBE']);
  });

  it('실연동으로 바꾼 뒤 mock 시절 연결 채널은 예약 대상이 아니다', async () => {
    await channel('INSTAGRAM', { mock: true });
    const it1 = await item('IMAGE_SQUARE', 'APPROVED');
    liveSocial();
    await expect(schedulePublish(fx.merchantId, it1.id, ['INSTAGRAM'], new Date())).rejects.toThrow(/mock 시절 연결/);
    // 이미 예약돼 있던 건은 공급자를 부르지 않고 재시도 없이 실패로 닫는다
    const pub = await scheduled(it1.id, 'INSTAGRAM', true);
    expect((await processContentQueue()).failed).toBe(1);
    expect((await prisma.contentPublish.findUniqueOrThrow({ where: { id: pub.id } })).error).toMatch(/다시 연결/);
    expect(calls).toHaveLength(0);
  });

  it('다음앱 인앱 브라우저는 세고 Daumoa 수집기는 제외, IP 를 모르면 UA 로 나눠 센다', async () => {
    const it1 = await item('IMAGE_SQUARE', 'PUBLISHED');
    const pub = await prisma.contentPublish.create({ data: { id: newId(), itemId: it1.id, platform: 'INSTAGRAM', status: 'PUBLISHED', scheduledAt: new Date() } });
    const daumApp = 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 DaumApps/8.6.0 DaumDevice/mobile';
    expect((await recordContentClick({ publishId: pub.id, ip: '1.1.1.1', userAgent: daumApp })).found && true).toBe(true);
    expect(await recordContentClick({ publishId: pub.id, ip: '2.2.2.2', userAgent: 'Mozilla/5.0 (compatible; Daumoa/4.0)' })).toMatchObject({ counted: false, reason: 'bot' });
    const ua = (n: number) => `Mozilla/5.0 (iPhone; CPU iPhone OS 17_${n} like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148`;
    expect(await recordContentClick({ publishId: pub.id, ip: null, userAgent: ua(1) })).toMatchObject({ counted: true });
    expect(await recordContentClick({ publishId: pub.id, ip: null, userAgent: ua(2) })).toMatchObject({ counted: true });
    expect(await recordContentClick({ publishId: pub.id, ip: null, userAgent: ua(2) })).toMatchObject({ counted: false, reason: 'duplicate' });
    expect((await prisma.contentPublish.findUniqueOrThrow({ where: { id: pub.id } })).clicks).toBe(3);
  });
});
