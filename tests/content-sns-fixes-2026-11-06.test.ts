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
