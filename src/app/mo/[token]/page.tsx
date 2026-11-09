import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { HeartHandshake } from 'lucide-react';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { formatMoNumber } from '@/lib/mo-number';
import { smsHref, smsPlatform } from '@/lib/sms-link';
import { amountShortText } from '@/lib/mo-intent';
import { MO_COMMAND_LABEL, type MoCommandKind } from '@/lib/mo-commands';
import { prisma } from '@/server/db';
import { recurringIsMock } from '@/server/services/recurring';
import { intentSmsBody, readIntentPayload, resolveReplyLink, type ReplyLinkRow } from '@/server/services/mo-commands';
import { replyLinkContext, smsReceiptSummary, smsReplyLinkScope } from '@/server/services/mo-command-scope';
import { replyLinkBound } from '@/server/services/mo-link-cookie';
import { hasStepUp } from '@/server/services/self-service-stepup';
import { donorDonationHistory } from '@/server/services/donor-history';
import { selfServiceRecurringList } from '@/server/services/donor-self-service';
import { RecurringManagerCard } from '@/components/self-service/recurring-manager';
import { Notice } from '@/components/ui';
import { MoInquiryForm, MoOtpPanel } from './forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '문자 안내', robots: { index: false, follow: false } };

/**
 * 문자 명령·의도 해석 회신 화면 (2026-11-12 4차 K2·K3).
 *  - INTENT  : 알아듣지 못한 문자 → 비슷한 캠페인 고르기(본인 확인 없음, 후원은 문자를 다시 보내거나 후원페이지에서)
 *  - 명령어   : 영수증·내역·변경·해지·문의 → 그 번호 인증번호로 본인 확인 후 그 기관 범위 화면
 * 결제 건을 만들지 않는다. 변경·해지는 2차 F 셀프서비스 함수로만, 결과는 정보성 문자로 알린다.
 */
export default async function MoReplyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await resolveReplyLink(token, { markOpened: true });
  return (
    <main className="min-h-screen bg-[#f6f4ee] px-4 py-8 text-[16px]">
      <div className="mx-auto max-w-[480px] space-y-4">
        {!r.ok ? (
          <Shell title="링크를 열 수 없습니다">
            <p className="leading-relaxed text-ink-700">{r.reason === 'EXPIRED' ? '링크 유효 시간(30분)이 지났습니다. 기관 번호로 같은 문자를 다시 보내 주세요.' : '찾을 수 없는 링크입니다.'}</p>
          </Shell>
        ) : r.link.kind === 'INTENT' ? (
          <IntentScreen link={r.link} />
        ) : (
          <CommandScreen link={r.link} token={token} />
        )}
      </div>
    </main>
  );
}

function Shell({ org, title, children }: { org?: string | null; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4 rounded-[28px] bg-white p-6 shadow-sm">
      {org ? (
        <div className="flex items-center gap-2 text-brand-700"><HeartHandshake size={20} strokeWidth={1.7} /><span className="text-[14px] font-bold">{org}</span></div>
      ) : null}
      <h1 className="text-[22px] font-black leading-snug text-ink-900">{title}</h1>
      {children}
    </div>
  );
}

async function IntentScreen({ link }: { link: ReplyLinkRow }) {
  const { candidates, amount, receivedNumber } = readIntentPayload(link.payload);
  const platform = smsPlatform((await headers()).get('user-agent'));
  // 후보 기관이 지금도 받을 수 있는 상태인지 다시 본다(그 사이 정지됐을 수 있다).
  const ok = new Set(
    (await prisma.merchantProfile.findMany({ where: { id: { in: candidates.map((c) => c.merchantId) }, status: 'APPROVED', user: { status: 'ACTIVE', deletedAt: null } }, select: { id: true } })).map((m) => m.id),
  );
  const list = candidates.filter((c) => ok.has(c.merchantId));
  return (
    <Shell title={list.length > 1 ? '어느 캠페인에 후원하시려던 건가요?' : '이 캠페인에 후원하시려던 건가요?'}>
      <p className="leading-relaxed text-ink-700">
        보내신 문자의 키워드를 정확히 알아보지 못해 비슷한 캠페인을 찾았습니다.{amount ? ` 말씀하신 금액(${amountShortText(amount)})은 다음 화면에 미리 골라 둡니다.` : ''} 아직 후원은 진행되지 않았습니다.
      </p>
      {list.length === 0 ? <p className="text-ink-500">지금 고를 수 있는 캠페인이 없습니다.</p> : null}
      {list.map((c) => {
        const body = intentSmsBody(c, amount);
        const donate = `/donate/${c.merchantCode}${c.campaignId ? `/campaigns/${c.campaignId}` : ''}?src=sms`;
        return (
          <div key={`${c.merchantId}:${c.campaignId ?? ''}`} className="space-y-3 rounded-2xl border border-ink-100 p-4">
            <p className="text-[14px] font-bold text-brand-700">{c.merchantName}</p>
            <p className="text-[18px] font-extrabold text-ink-900">{c.campaignTitle ?? '기관 일반 후원'}</p>
            {receivedNumber ? (
              <a href={smsHref(receivedNumber, body, platform)} className="block rounded-2xl bg-brand-600 px-5 py-3.5 text-center text-[16px] font-extrabold text-white">
                문자로 후원하기 ({body.trim()})
              </a>
            ) : null}
            <a href={donate} className="block rounded-2xl border border-ink-200 px-5 py-3.5 text-center text-[16px] font-bold text-ink-800">후원페이지에서 보기</a>
            {receivedNumber ? <p className="text-[13px] text-ink-400">{formatMoNumber(receivedNumber)} 로 &quot;{body.trim()}&quot; 를 보내면 금액 선택 링크가 옵니다.</p> : null}
          </div>
        );
      })}
    </Shell>
  );
}

async function CommandScreen({ link, token }: { link: ReplyLinkRow; token: string }) {
  const kind = link.kind as MoCommandKind;
  const { merchant, payer } = await replyLinkContext(link);
  const title = `${MO_COMMAND_LABEL[kind] ?? '안내'}`;
  if (!merchant || merchant.status !== 'APPROVED' || !payer) {
    return <Shell title={title}><p className="text-ink-700">이 번호의 후원 정보를 찾을 수 없습니다. 기관에 문의해 주세요.</p></Shell>;
  }
  const verified = (await replyLinkBound(link.id)) && (await hasStepUp({ kind: 'SMS_LINK', linkId: link.id }));
  if (!verified) {
    return (
      <Shell org={merchant.displayName} title={title}>
        <MoOtpPanel token={token} phoneMasked={payer.phoneMasked} purpose={`${MO_COMMAND_LABEL[kind]} 화면을 열려면`} />
        <p className="text-[13px] text-ink-400">이 링크는 30분 동안 쓸 수 있습니다. 본인 확인은 10분 동안 유효합니다.</p>
      </Shell>
    );
  }
  const memberBase = `/donate/${merchant.code}`;

  if (kind === 'RECEIPT') {
    const s = await smsReceiptSummary(merchant.id, payer.id, merchant.receiptCycle);
    return (
      <Shell org={merchant.displayName} title="기부금영수증">
        <p className="leading-relaxed text-ink-700">{s.schedule.text}</p>
        <Notice tone={s.profileRegistered ? 'success' : 'warning'}>
          <span className="text-[15px]">{s.profileRegistered ? '영수증 정보(성명·주민등록번호)가 등록되어 있습니다.' : '영수증 정보(성명·주민등록번호)가 아직 등록되지 않았습니다. 등록해야 영수증이 발급됩니다.'}</span>
        </Notice>
        <div className="space-y-2">
          {s.receipts.length === 0 ? <p className="text-ink-500">아직 이 기관에서 발급된 영수증이 없습니다.</p> : s.receipts.map((x) => (
            <div key={x.id} className="flex items-center justify-between rounded-xl bg-ink-50 px-4 py-3">
              <span>{x.taxYear}년 · {x.status === 'ISSUED' ? '발급' : '무효'}</span>
              <span className="font-bold">{formatWon(x.totalAmount)}</span>
            </div>
          ))}
        </div>
        <a href={`${memberBase}/my/receipts`} className="block rounded-2xl bg-brand-600 px-5 py-3.5 text-center font-extrabold text-white">영수증 정보 등록·발급 내역 보기(로그인)</a>
        <p className="text-[13px] text-ink-400">영수증 정보 등록은 개인정보 보호를 위해 로그인한 화면에서만 할 수 있습니다.</p>
      </Shell>
    );
  }

  if (kind === 'HISTORY') {
    const h = await donorDonationHistory(payer.id, { merchantId: merchant.id });
    return (
      <Shell org={merchant.displayName} title="후원 내역">
        <div className="flex flex-wrap gap-2">
          {h.totals.length === 0 ? <p className="text-ink-500">이 기관에 후원한 내역이 없습니다.</p> : h.totals.map((t) => (
            <span key={t.year} className="rounded-xl bg-ink-50 px-3 py-2 text-[14px]">{t.year}년 {t.count}건 · <strong>{formatWon(t.amount)}</strong></span>
          ))}
        </div>
        <div className="space-y-2">
          {h.entries.slice(0, 30).map((e) => (
            <div key={`${e.source}:${e.id}`} className="flex items-center justify-between rounded-xl border border-ink-100 px-4 py-3">
              <span className="text-[14px] text-ink-700">{formatKst(e.at, false)} · {e.sourceLabel}</span>
              <span className="font-bold">{formatWon(e.amount)}</span>
            </div>
          ))}
        </div>
        {h.failedSources.length ? <p className="text-[13px] text-warning-500">일부 내역({h.failedSources.join(', ')})을 불러오지 못했습니다.</p> : null}
        <a href={`${memberBase}/my`} className="block rounded-2xl border border-ink-200 px-5 py-3.5 text-center font-bold text-ink-800">후원 회원 화면에서 더 보기(로그인)</a>
      </Shell>
    );
  }

  if (kind === 'CHANGE' || kind === 'CANCEL') {
    const scope = await smsReplyLinkScope(token);
    const data = scope ? await selfServiceRecurringList(scope) : null;
    return (
      <Shell org={merchant.displayName} title={kind === 'CANCEL' ? '정기후원 해지' : '정기후원 변경'}>
        <p className="leading-relaxed text-ink-700">아래에서 바꾸거나 해지하면 처리 결과를 이 번호로 문자로 알려 드립니다. 문자 내용만으로는 처리하지 않습니다.</p>
        {recurringIsMock() ? <Notice tone="neutral">현재 mock 결제사입니다. 실제 출금 없이 흐름만 재현됩니다.</Notice> : null}
        {!data || data.items.length === 0 ? <p className="text-ink-500">이 기관에 등록된 정기후원이 없습니다.</p> : data.items.map((item) => (
          <RecurringManagerCard key={item.id} item={item} code={`sms:${token}`} hasActiveToken={data.hasActiveToken} agreementHref={null} />
        ))}
      </Shell>
    );
  }

  // INQUIRY
  const thread = await prisma.supportInquiry.findFirst({
    where: { handledBy: 'MERCHANT', merchantId: merchant.id, payerId: payer.id },
    orderBy: { createdAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 10 } },
  });
  return (
    <Shell org={merchant.displayName} title="문의하기">
      <p className="leading-relaxed text-ink-700">{merchant.displayName} 담당자에게 문의를 남깁니다. 답변은 이 번호로 문자로 알려 드립니다.</p>
      {thread && thread.messages.length > 0 ? (
        <div className="space-y-2">
          {[...thread.messages].reverse().map((m) => (
            <div key={m.id} className={`rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${m.sender === 'USER' ? 'bg-ink-50 text-ink-800' : 'bg-brand-50 text-ink-900'}`}>
              <p className="mb-1 text-[12.5px] text-ink-400">{m.sender === 'USER' ? '나' : m.authorKind === 'AUTO' ? '자동 답변' : '담당자'} · {formatKst(m.createdAt, false)}</p>
              <p className="whitespace-pre-wrap">{m.body}</p>
            </div>
          ))}
        </div>
      ) : null}
      <MoInquiryForm token={token} />
    </Shell>
  );
}
