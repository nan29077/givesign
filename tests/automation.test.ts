import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { decrypt } from '@/lib/crypto';
import { readMockOutbox } from '@/server/adapters/mt';
import { readMockAlimtalkOutbox, setMockAlimtalkFailure } from '@/server/adapters/alimtalk';
import { mockMoAdapter } from '@/server/adapters/mo';
import { campaignSchema } from '@/lib/fundraising';

// PGlite는 한 DB backend를 다중화하므로 독립된 동시 트랜잭션의 응답이
// 섞일 수 있다. 실제 PostgreSQL에서는 동시 요청 검사를 그대로 실행한다.
const singleBackend = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${process.env.PGLITE_PORT ?? '5463'}/`);
import { decodeAttribution, encodeAttribution, normalizeSource } from '@/lib/attribution';
import { handleMoInbound, sendMtDetailed } from '@/server/services/charge-flow';
import { saveCampaign, setCampaignStatus } from '@/server/services/fundraising';
import { createRecurringDonation, updateRecurringDonation } from '@/server/services/recurring';
import { completeESign, verifyAgreement } from '@/server/services/agreements';
import { applyVolunteer, buildVolunteer1365Csv, decideVolunteer, recordVolunteerActivity, VolunteerError } from '@/server/services/volunteers';
import { commitSupporterImport, listSupporters, parseCsv, pendingPledgeRequests, previewSupporterImport } from '@/server/services/supporters';
import { saveAlimtalkChannel, setAlimtalkChannelStatus } from '@/server/services/alimtalk';
import { monthRange, previousMonthKey, runMerchantNotice } from '@/server/services/monthly-notice';
import {
  approveContent,
  connectSocialChannel,
  contentConversions,
  processContentQueue,
  renderCaption,
  requestContent,
  schedulePublish,
  updateContentDraft,
  type Scene,
} from '@/server/services/content';
import * as tpl from '@/server/services/mt-templates';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, type Fixture } from './helpers';

/**
 * 자동화 도메인 — 발굴(콘텐츠·SNS) → 전환(MO 예약어·약정서·봉사) → 관리(통합 구성원) → 안내(알림톡·월간).
 *
 * 이 파일이 지키는 것
 *  1) 문자 예약어(정기·봉사)는 결제 건을 만들지 않고 안내 링크만 보내며, 캠페인 키워드로 쓸 수 없다.
 *  2) 알림톡은 관리자 확인 채널 + 승인 템플릿일 때만 나가고, 실패하면 같은 본문이 문자로 대체된다.
 *  3) 월간 안내는 (기관, 월) 한 번, 수신 거부자는 제외, 금액은 결제 성공 건 기준이다.
 *  4) 약정서는 약정 시점 내용으로 고정되고(해시 검증), 바꾸면 새 버전이 생긴다. 모의 서명은 한 번만 반영된다.
 *  5) 자원봉사는 동의·서약이 필수, 기관당 진행 중 1건, 활동 기록은 승인자에게만, 내보내기는 마스킹.
 *  6) 콘텐츠는 AI 표시가 항상 붙고, 모집등록번호가 없으면 승인되지 않으며, 게시는 플랫폼당 한 번이다.
 */

let fx: Fixture;

async function seedContextualTerms() {
  for (const t of ['RECEIPT_ISSUANCE', 'RECURRING_DEBIT', 'VOLUNTEER_PRIVACY'] as const) {
    await prisma.termsVersion.create({
      data: { id: newId(), type: t, version: '1.0', title: `${t} 동의`, content: `${t} 테스트 본문`, required: false, effectiveFrom: new Date('2026-01-01') },
    });
  }
}

async function mo(text: string, from = fx.payerPhone) {
  return handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, from, text })));
}

async function seedCampaign(code = 'KIMJANG') {
  const today = new Date().toISOString().slice(0, 10);
  const c = await saveCampaign(fx.merchantId, campaignSchema.parse({
    code, title: '김장 나눔', summary: '홀몸 어르신 김장 나눔', story: '올겨울 300가구에 김장김치를 전합니다. 함께해 주세요.',
    beneficiary: '홀몸 어르신 300가구', usagePlan: '김장 재료비와 배송비', goalAmount: 3000000, startsOn: today, endsOn: '2099-12-31',
  }));
  await setCampaignStatus(fx.merchantId, c.id, 'ACTIVE');
  return c;
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  await seedContextualTerms();
});

describe('[1] 문자 예약어 — 정기·봉사', () => {
  it('정기: 결제 건 없이 약정 링크만 보내고, 10분 안 재요청에는 다시 보내지 않는다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const r = await mo('정기');
    expect(r.result).toBe('ROUTED');
    expect(r.chargeId).toBeUndefined();
    expect(await prisma.charge.count()).toBe(0);
    const out = readMockOutbox(5).filter((m) => m.template === 'PLEDGE_LINK');
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain('/my/recurring/new?merchant=');
    expect(out[0]!.text).toContain('src=sms');

    await mo('정기');
    expect(readMockOutbox(10).filter((m) => m.template === 'PLEDGE_LINK')).toHaveLength(1);
    const rows = await prisma.moInboundMessage.findMany({ orderBy: { receivedAt: 'asc' } });
    expect(rows.every((x) => x.resultDetail?.startsWith('PLEDGE_REQUEST'))).toBe(true);
  });

  it('정기 + 캠페인 키워드: 링크에 캠페인이 지정된다 / 봉사: 미등록 번호도 신청 링크를 받는다', async () => {
    const c = await seedCampaign();
    await seedRegisteredPayer(fx.payerPhone);
    await mo('정기 KIMJANG');
    const pledge = readMockOutbox(5).find((m) => m.template === 'PLEDGE_LINK')!;
    expect(pledge.text).toContain(`campaign=${c.id}`);

    const v = await mo('봉사', '01099990000');
    expect(v.result).toBe('ROUTED');
    expect(readMockOutbox(5).some((m) => m.template === 'VOLUNTEER_LINK' && m.text.includes('/my/volunteer/apply'))).toBe(true);
    expect(await prisma.charge.count()).toBe(0);
  });

  it('예약어는 캠페인 키워드로 쓸 수 없고, 일반 문자는 그대로 후원 흐름으로 간다', async () => {
    for (const code of ['정기', '봉사', '자원봉사', '약정']) {
      expect(campaignSchema.safeParse({ code, title: 't', summary: 's', goalAmount: 10000, startsOn: '2026-01-01', endsOn: '2026-12-31' }).success).toBe(false);
    }
    await seedRegisteredPayer(fx.payerPhone);
    const paid = await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '정기적으로 응원해요' }), fx.merchantId);
    expect(paid.chargeId).toBeTruthy();
    const ch = await prisma.charge.findUniqueOrThrow({ where: { id: paid.chargeId! } });
    expect(ch.source).toBeNull(); // MO 경로는 결제 건에 source 를 강제로 넣지 않는다(문자 유입은 수신 기록이 원천)
  });

  it('정기 요청 후 약정을 마치지 않은 사람이 재안내 대상에 잡히고, 약정하면 빠진다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await mo('정기');
    let pending = await pendingPledgeRequests(fx.merchantId);
    expect(pending.map((p) => p.payerId)).toEqual([payer.id]);
    const r = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 10 });
    expect(r.ok).toBe(true);
    pending = await pendingPledgeRequests(fx.merchantId);
    expect(pending).toHaveLength(0);
  });
});

describe('[2] 알림톡 발송 계층', () => {
  async function activeChannel() {
    await saveAlimtalkChannel(fx.merchantId, {
      channelId: '@테스트복지관',
      senderKey: 'abcdefghij0123456789KEY',
      templateCodes: { RECURRING_STARTED: 'GS_REC_01', MONTHLY_NOTICE: 'GS_MON_01' },
    });
  }

  it('승인 대기(PENDING) 채널은 문자로, 관리자 확인(ACTIVE) 뒤에는 승인 템플릿만 알림톡으로 보낸다', async () => {
    await activeChannel();
    const t = tpl.tplRecurringStarted({ merchantName: '기관', amount: 10000n, dayOfMonth: 5, nextDate: '2026-11-05' });
    const a = await sendMtDetailed({ phone: fx.payerPhone, template: t, merchantId: fx.merchantId });
    expect(a.channel).toBe('SMS');
    expect(readMockAlimtalkOutbox()).toHaveLength(0);

    await setAlimtalkChannelStatus(fx.merchantId, 'ACTIVE', 'admin-user');
    const b = await sendMtDetailed({ phone: fx.payerPhone, template: t, merchantId: fx.merchantId });
    expect(b.channel).toBe('ALIMTALK');
    expect(readMockAlimtalkOutbox()[0]!.templateCode).toBe('GS_REC_01');
    const row = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.channel).toBe('ALIMTALK');
    expect(row.status).toBe('SENT');

    // 매핑 없는 템플릿(환불 안내)은 알림톡 채널이 있어도 문자
    const c = await sendMtDetailed({ phone: fx.payerPhone, template: tpl.tplRefundDone('기관', 1000n), merchantId: fx.merchantId });
    expect(c.channel).toBe('SMS');
    // 인증번호는 알림톡 대상 목록에 없다
    const d = await sendMtDetailed({ phone: fx.payerPhone, template: tpl.tplPaymentVerify('123456'), merchantId: fx.merchantId });
    expect(d.channel).toBe('SMS');
  });

  it('알림톡이 실패하면 같은 본문을 문자로 대체하고 대체 여부를 남긴다', async () => {
    await activeChannel();
    await setAlimtalkChannelStatus(fx.merchantId, 'ACTIVE', 'admin-user');
    setMockAlimtalkFailure('카카오 일시 장애');
    const t = tpl.tplRecurringStarted({ merchantName: '기관', amount: 10000n, dayOfMonth: 5, nextDate: '2026-11-05' });
    const r = await sendMtDetailed({ phone: fx.payerPhone, template: t, merchantId: fx.merchantId });
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('SMS');
    expect(r.fallback).toBe(true);
    const row = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.fallback).toBe(true);
    expect(readMockOutbox(3).some((m) => m.template === 'RECURRING_STARTED')).toBe(true);
  });

  it('템플릿 코드를 바꾸면 다시 승인 대기로 돌아가고, 코드가 없으면 ACTIVE 로 확인할 수 없다', async () => {
    await saveAlimtalkChannel(fx.merchantId, { channelId: '@테스트복지관', senderKey: 'abcdefghij0123456789KEY', templateCodes: {} });
    await expect(setAlimtalkChannelStatus(fx.merchantId, 'ACTIVE', 'admin')).rejects.toThrow(/템플릿 코드/);
    await activeChannel();
    await setAlimtalkChannelStatus(fx.merchantId, 'ACTIVE', 'admin');
    await saveAlimtalkChannel(fx.merchantId, { channelId: '@테스트복지관', templateCodes: { RECURRING_STARTED: 'GS_REC_02' } });
    const row = await prisma.merchantAlimtalkChannel.findUniqueOrThrow({ where: { merchantId: fx.merchantId } });
    expect(row.status).toBe('PENDING');
    expect(decrypt(row.senderKeyEnc!)).toBe('abcdefghij0123456789KEY');
    expect(row.senderKeyMasked).not.toContain('abcdefghij0123456789KEY');
  });
});

describe('[3] 월간 후원 안내', () => {
  it('지난달 결제 성공 건으로 안내하고, 같은 달은 한 번만, 수신 거부자는 제외한다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const other = await seedRegisteredPayer('01055556666');
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '첫 후원' }), fx.merchantId);
    await inboundAndPay(moPayload({ to: fx.moNumber, from: '01055556666', text: '응원' }), fx.merchantId);
    const month = previousMonthKey();
    const { start } = monthRange(month);
    const mid = new Date(start.getTime() + 5 * 86_400_000);
    await prisma.charge.updateMany({ where: { merchantId: fx.merchantId }, data: { paidAt: mid } });
    await prisma.payerMerchantLink.updateMany({ where: { payerId: other.id, merchantId: fx.merchantId }, data: { noticeOptOutAt: new Date() } });

    const run = await runMerchantNotice(fx.merchantId, month);
    expect(run).not.toBeNull();
    expect(run!.recipientCount).toBe(2);
    expect(run!.sentCount).toBe(1);
    expect(run!.skippedCount).toBe(1);
    const notices = readMockOutbox(20).filter((m) => m.template === 'MONTHLY_NOTICE');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('/my/receipts');
    const deliveries = await prisma.noticeDelivery.findMany({ where: { noticeRunId: run!.id } });
    expect(deliveries.find((d) => d.payerId === payer.id)!.status).toBe('SENT');
    expect(deliveries.find((d) => d.payerId === other.id)!.reason).toBe('월간 안내 수신 거부');

    expect(await runMerchantNotice(fx.merchantId, month)).toBeNull();
    expect(readMockOutbox(20).filter((m) => m.template === 'MONTHLY_NOTICE')).toHaveLength(1);
  });

  it('중간에 멈춘 실행은 이어서 돌리되 이미 보낸 사람에게 다시 보내지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원' }), fx.merchantId);
    const month = previousMonthKey();
    await prisma.charge.updateMany({ data: { paidAt: new Date(monthRange(month).start.getTime() + 86_400_000) } });
    const run = await prisma.noticeRun.create({ data: { id: newId(), merchantId: fx.merchantId, monthKey: month } });
    await prisma.noticeDelivery.create({ data: { id: newId(), noticeRunId: run.id, payerId: payer.id, status: 'SENT' } });
    const r = await runMerchantNotice(fx.merchantId, month);
    expect(r!.status).toBe('DONE');
    expect(readMockOutbox(20).filter((m) => m.template === 'MONTHLY_NOTICE')).toHaveLength(0);
  });
});

describe('[4] 전자 약정서', () => {
  it('약정을 만들면 약정서 v1 이 생기고 해시로 검증되며, 금액을 바꾸면 v2 가 이전본을 대체한다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const r = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 20000n, dayOfMonth: 15, ip: '1.2.3.4' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v1 = await prisma.agreementDocument.findFirstOrThrow({ where: { subjectId: r.recurring.id } });
    expect(v1.version).toBe(1);
    expect(v1.consentIp).toBe('1.2.3.4');
    expect(verifyAgreement(v1)).toBe(true);
    const snap = v1.snapshot as { pledge: { amount: string }; donor: { phoneMasked: string } };
    expect(snap.pledge.amount).toBe('20000');
    expect(snap.donor.phoneMasked).not.toContain('12345678');
    expect((await prisma.recurringDonation.findUniqueOrThrow({ where: { id: r.recurring.id } })).agreementDocId).toBe(v1.id);
    expect(readMockOutbox(10).some((m) => m.template === 'AGREEMENT_ISSUED')).toBe(true);

    // 내용이 바뀌면 해시 검증이 깨진다
    expect(verifyAgreement({ snapshot: { ...(v1.snapshot as object), tampered: true }, contentHash: v1.contentHash })).toBe(false);

    await updateRecurringDonation(payer.id, r.recurring.id, { amount: 30000n });
    const docs = await prisma.agreementDocument.findMany({ where: { subjectId: r.recurring.id }, orderBy: { version: 'asc' } });
    expect(docs.map((d) => d.version)).toEqual([1, 2]);
    expect(docs[1]!.supersedesId).toBe(v1.id);
    // 메시지만 바꾸면 새 버전을 만들지 않는다
    await updateRecurringDonation(payer.id, r.recurring.id, { message: '늘 응원합니다' });
    expect(await prisma.agreementDocument.count({ where: { subjectId: r.recurring.id } })).toBe(2);
  });

  it('전자서명(mock)은 요청 상태로 남고, 결과는 한 번만 반영된다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const r = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 3 });
    if (!r.ok) throw new Error(r.message);
    const doc = await prisma.agreementDocument.findFirstOrThrow({ where: { subjectId: r.recurring.id } });
    expect(doc.esignStatus).toBe('REQUESTED');
    expect(doc.signedAt).toBeNull();
    const first = await completeESign(doc.esignRequestId!, 'SIGNED');
    expect(first.ok && !('already' in first && first.already)).toBe(true);
    const second = await completeESign(doc.esignRequestId!, 'DECLINED');
    expect(second.ok && second.already).toBe(true);
    expect((await prisma.agreementDocument.findUniqueOrThrow({ where: { id: doc.id } })).esignStatus).toBe('SIGNED');
  });
});

describe('[5] 자원봉사', () => {
  const base = { interests: ['돌봄·말벗'], availableDays: ['SAT'], timeSlot: 'WEEKEND', safetyPledge: true, agree: true };

  it('동의·서약 없이는 신청할 수 없고, 신청하면 신청서·동의 기록·접수 안내가 남는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await expect(applyVolunteer({ ...base, payerId: payer.id, merchantId: fx.merchantId, agree: false })).rejects.toThrow(VolunteerError);
    await expect(applyVolunteer({ ...base, payerId: payer.id, merchantId: fx.merchantId, safetyPledge: false })).rejects.toThrow(/서약/);
    const id = await applyVolunteer({ ...base, payerId: payer.id, merchantId: fx.merchantId, emergencyName: '보호자', emergencyPhone: '010-2222-3333', source: 'INSTAGRAM' });
    const app = await prisma.volunteerApplication.findUniqueOrThrow({ where: { id } });
    expect(app.status).toBe('RECEIVED');
    expect(app.source).toBe('INSTAGRAM');
    expect(app.agreementDocId).toBeTruthy();
    const vp = await prisma.volunteerProfile.findUniqueOrThrow({ where: { payerId: payer.id } });
    expect(vp.emergencyPhoneMasked).not.toContain('22223333');
    expect(decrypt(vp.emergencyPhoneEnc!)).toBe('01022223333');
    expect(await prisma.consentRecord.count({ where: { type: 'VOLUNTEER_PRIVACY' } })).toBe(1);
    expect(readMockOutbox(5).some((m) => m.template === 'VOLUNTEER_RECEIVED')).toBe(true);
  });

  it.skipIf(singleBackend)('진행 중 신청은 기관당 1건, 동시에 두 번 눌러도 1건만 생긴다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const results = await Promise.allSettled([
      applyVolunteer({ ...base, payerId: payer.id, merchantId: fx.merchantId }),
      applyVolunteer({ ...base, payerId: payer.id, merchantId: fx.merchantId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.volunteerApplication.count()).toBe(1);
  });

  it('승인은 배정 안내가 필요하고, 활동 기록은 승인자에게만, 내보내기는 마스킹 번호만 담는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const id = await applyVolunteer({ ...base, payerId: payer.id, merchantId: fx.merchantId });
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    await expect(recordVolunteerActivity({ merchantId: fx.merchantId, payerId: payer.id, activityDate: today, minutes: 120, title: '말벗', userId: fx.merchantUserId })).rejects.toThrow(/승인된/);
    await expect(decideVolunteer({ merchantId: fx.merchantId, applicationId: id, decision: 'APPROVE', userId: fx.merchantUserId })).rejects.toThrow(/안내/);
    await decideVolunteer({ merchantId: fx.merchantId, applicationId: id, decision: 'APPROVE', assignment: '11/8(토) 10시 복지관 1층', userId: fx.merchantUserId });
    expect(readMockOutbox(5).some((m) => m.template === 'VOLUNTEER_APPROVED' && m.text.includes('11/8'))).toBe(true);
    await recordVolunteerActivity({ merchantId: fx.merchantId, payerId: payer.id, activityDate: today, minutes: 150, title: '=HYPERLINK("x")', userId: fx.merchantUserId });
    const { csv, count, totalMinutes } = await buildVolunteer1365Csv(fx.merchantId, today, today);
    expect(count).toBe(1);
    expect(totalMinutes).toBe(150);
    expect(csv).not.toContain('01012345678');
    expect(csv).toContain("'=HYPERLINK"); // 수식 주입 방지
    // 다른 기관은 이 신청을 처리할 수 없다
    await expect(decideVolunteer({ merchantId: 'other', applicationId: id, decision: 'REJECT', userId: 'x' })).rejects.toThrow(/찾을 수 없/);
  });
});

describe('[6] 통합 구성원 · 명단 업로드', () => {
  it('후원·봉사·명단을 한 사람 기준으로 묶고 세그먼트를 계산한다', async () => {
    const donor = await seedRegisteredPayer(fx.payerPhone);
    const vol = await seedRegisteredPayer('01077778888');
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '1' }), fx.merchantId);
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '2' }), fx.merchantId);
    const appId = await applyVolunteer({ interests: ['급식·도시락'], availableDays: ['MON'], safetyPledge: true, agree: true, payerId: vol.id, merchantId: fx.merchantId });
    await decideVolunteer({ merchantId: fx.merchantId, applicationId: appId, decision: 'APPROVE', assignment: '월 오전', userId: fx.merchantUserId });

    const rows = await listSupporters(fx.merchantId);
    const d = rows.find((r) => r.payerId === donor.id)!;
    const v = rows.find((r) => r.payerId === vol.id)!;
    expect(d.role).toBe('DONOR');
    expect(d.segments).toContain('repeat_no_pledge');
    expect(v.role).toBe('VOLUNTEER');
    expect(v.segments).toContain('volunteer_only');

    await applyVolunteer({ interests: ['행사 지원'], availableDays: ['SUN'], safetyPledge: true, agree: true, payerId: donor.id, merchantId: fx.merchantId });
    expect((await listSupporters(fx.merchantId)).find((r) => r.payerId === donor.id)!.role).toBe('BOTH');
  });

  it('CSV 미리보기는 중복·오류를 표시하고, 등록은 동의 확인이 있어야 하며 번호는 암호화된다', async () => {
    const payer = await seedRegisteredPayer('01011112222');
    const csv = '이름,휴대폰,구분,태그\n김나눔,010-1111-2222,후원자,후원의밤\n박봉사,01033334444,봉사자,\n중복,010-3333-4444,기타,\n없음,12345,기타,\n';
    expect(parseCsv('"a,b",c\n')).toEqual([['a,b', 'c']]);
    const p = await previewSupporterImport(fx.merchantId, csv);
    expect(p.newCount).toBe(2);
    expect(p.duplicateCount).toBe(1);
    expect(p.errorCount).toBe(1);
    expect(p.rows.every((r) => !r.phoneMasked.includes('33334444'))).toBe(true);

    await expect(commitSupporterImport({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: 'a.csv', csv, consentConfirmed: false, consentBasis: '후원의 밤 신청서' })).rejects.toThrow(/동의/);
    const r = await commitSupporterImport({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: 'a.csv', csv, consentConfirmed: true, consentBasis: '2025 후원의 밤 신청서' });
    expect(r.accepted).toBe(2);
    const again = await commitSupporterImport({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: 'a.csv', csv, consentConfirmed: true, consentBasis: '2025 후원의 밤 신청서' });
    expect(again.accepted).toBe(0);
    const contacts = await prisma.supporterContact.findMany({ where: { merchantId: fx.merchantId } });
    expect(contacts).toHaveLength(2);
    expect(contacts.find((c) => c.name === '김나눔')!.payerId).toBe(payer.id);
    expect(contacts.every((c) => !c.phoneMasked.includes('1111') || c.phoneMasked.includes('*'))).toBe(true);
    const rows = await listSupporters(fx.merchantId);
    expect(rows.filter((x) => x.role === 'CONTACT').map((x) => x.name).sort()).toEqual(['김나눔', '박봉사']);
  });
});

describe('[7] 콘텐츠 생성 · 승인 · 게시', () => {
  it('캠페인으로 숏폼을 만들면 장면·대본·캡션이 생기고 AI 표시가 붙는다. 모집등록번호가 없으면 승인되지 않는다', async () => {
    const c = await seedCampaign();
    const item = await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'SHORTFORM', userId: fx.merchantUserId });
    expect(item.status).toBe('REVIEW');
    expect(item.aiLabeled).toBe(true);
    expect(item.regNoIncluded).toBe(false);
    const scenes = item.scenes as unknown as Scene[];
    expect(scenes.length).toBeGreaterThanOrEqual(5);
    expect(scenes[0]!.svg.startsWith('<svg')).toBe(true);
    expect(scenes.every((s) => s.svg.includes('AI 생성 콘텐츠'))).toBe(true);
    expect(item.caption).toContain('AI 생성 콘텐츠');
    expect(item.caption).toContain("'KIMJANG'");
    const jobs = await prisma.contentJob.findMany({ where: { itemId: item.id } });
    expect(jobs.map((j) => j.step).sort()).toEqual(['ASSEMBLE', 'COVER', 'SCENES', 'SCRIPT', 'VOICE']);
    // mock 은 음성·영상을 만든 척하지 않는다
    expect((jobs.find((j) => j.step === 'VOICE')!.output as { available: boolean }).available).toBe(false);
    await expect(approveContent(fx.merchantId, item.id, fx.merchantUserId)).rejects.toThrow(/모집등록번호/);
  });

  it('수정은 금지어·링크·AI 표시를 지키고, 승인 → 예약 → 배치 게시는 플랫폼당 한 번이며 전환이 콘텐츠로 집계된다', async () => {
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { fundraisingRegNo: '2026-서울-00999' } });
    const c = await seedCampaign();
    const item = await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_SQUARE', userId: fx.merchantUserId });
    expect(item.regNoIncluded).toBe(true);
    const scenes = item.scenes as unknown as Scene[];
    await expect(updateContentDraft(fx.merchantId, item.id, { captions: scenes.map((s) => s.caption), caption: '링크 없는 캡션 AI 생성 콘텐츠' })).rejects.toThrow(/링크/);
    await expect(updateContentDraft(fx.merchantId, item.id, { captions: scenes.map((s) => s.caption), caption: '{링크}' })).rejects.toThrow(/AI 생성/);
    await updateContentDraft(fx.merchantId, item.id, { captions: ['첫 장면 고침', ...scenes.slice(1).map((s) => s.caption)], caption: item.caption! });
    const edited = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect((edited.scenes as unknown as Scene[])[0]!.svg).toContain('첫 장면 고침');

    await expect(schedulePublish(fx.merchantId, item.id, ['INSTAGRAM'], new Date())).rejects.toThrow(/승인된/);
    await approveContent(fx.merchantId, item.id, fx.merchantUserId);
    await expect(schedulePublish(fx.merchantId, item.id, ['INSTAGRAM'], new Date())).rejects.toThrow(/연결/);
    await connectSocialChannel(fx.merchantId, 'INSTAGRAM', '@test_welfare', fx.merchantUserId);
    await expect(schedulePublish(fx.merchantId, item.id, ['YOUTUBE'], new Date())).rejects.toThrow();
    await schedulePublish(fx.merchantId, item.id, ['INSTAGRAM'], new Date(Date.now() - 1000));

    const [a, b] = singleBackend
      ? [await processContentQueue(), await processContentQueue()]
      : await Promise.all([processContentQueue(), processContentQueue()]);
    expect(a.published + b.published).toBe(1);
    const pub = await prisma.contentPublish.findFirstOrThrow({ where: { itemId: item.id } });
    expect(pub.status).toBe('PUBLISHED');
    expect(pub.mock).toBe(true);
    expect(pub.url).toBeNull(); // mock 은 게시물 주소를 만들어 내지 않는다
    expect(pub.views).toBe(0);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('PUBLISHED');
    expect((await processContentQueue()).published).toBe(0);

    const caption = await renderCaption(edited, 'INSTAGRAM');
    expect(caption).toContain(`src=ig&cid=${item.id}`);

    // 이 콘텐츠 링크로 들어온 후원이 전환으로 잡힌다
    await seedRegisteredPayer(fx.payerPhone);
    const paid = await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: 'SNS 보고 왔어요' }), fx.merchantId);
    await prisma.charge.update({ where: { id: paid.chargeId! }, data: { contentItemId: item.id, source: 'INSTAGRAM' } });
    const conv = await contentConversions(fx.merchantId, [item.id]);
    expect(conv.get(item.id)!.donations).toBe(1);
  });

  it('월 생성 한도를 넘으면 만들지 않는다', async () => {
    const c = await seedCampaign();
    await prisma.merchantContentSetting.create({ data: { merchantId: fx.merchantId, monthlyLimit: 1 } });
    await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_STORY', userId: fx.merchantUserId });
    await expect(requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_STORY', userId: fx.merchantUserId })).rejects.toThrow(/한도/);
  });
});

describe('[8] 유입 경로', () => {
  it('src 별칭을 정규화하고 콘텐츠 ID 는 ULID 만 받는다', () => {
    expect(normalizeSource('yt')).toBe('YOUTUBE');
    expect(normalizeSource('IG')).toBe('INSTAGRAM');
    expect(normalizeSource('evil<script>')).toBeNull();
    const id = newId();
    expect(decodeAttribution(encodeAttribution({ source: 'FACEBOOK', contentItemId: id }))).toEqual({ source: 'FACEBOOK', contentItemId: id });
    expect(decodeAttribution('FACEBOOK.not-a-ulid')).toEqual({ source: 'FACEBOOK', contentItemId: null });
  });

  it('정기 약정은 유입 경로를 기록하고 매월 결제 건에도 옮긴다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const r = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 1, source: 'YOUTUBE' });
    if (!r.ok) throw new Error(r.message);
    expect(r.recurring.source).toBe('YOUTUBE');
  });
});
