import { Badge, Card, Field, Input, Notice, Textarea } from '@/components/ui';
import { ActionForm, InlineActionForm } from '@/components/studio/action-form';
import { QrCard } from '@/components/studio/qr-card';
import { formatNumber, formatWon } from '@/lib/money';
import { dateKey } from '@/lib/fundraising';
import { MO_COMMAND_WORDS_TEXT } from '@/lib/mo-commands';
import { PROMO_LIMIT_PER_CAMPAIGN, listPromos, promoActive, promoLandingUrl, promoPerformance } from '@/server/services/promo-codes';
import { archivePromoAction, createPromoAction, restorePromoAction, saveCampaignAliasesAction, updatePromoAction } from '@/app/actions/promo';

/**
 * 캠페인 상세 — 홍보물 코드·성과·별칭 (2026-11-12 4차 K1·K2). 서버 컴포넌트.
 */
export async function CampaignPromos({ merchantId, campaign, moHint }: {
  merchantId: string;
  campaign: { id: string; code: string; title: string; aliases: string[]; status: string };
  /** 문자 안내 예시 앞부분(대표번호 공유면 기관 키워드) */
  moHint: string | null;
}) {
  const promos = await listPromos(merchantId, campaign.id, true);
  const perf = await promoPerformance(promos.map((p) => p.id));
  const live = promos.filter((p) => !p.archivedAt);
  const archived = campaign.status === 'ARCHIVED';

  return (
    <Card className="mb-5">
      <h2 className="mb-1 text-[16px] font-black text-ink-900">홍보물별 키워드·QR</h2>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-500">
        현수막·소식지·행사장 QR 마다 키워드(예: {campaign.code}A, {campaign.code}B)를 따로 두면 어느 홍보물로 후원이 들어왔는지 나눠 볼 수 있습니다.
        홍보물 QR 을 휴대폰으로 찍으면 문자 앱이 키워드가 채워진 채로 열리고, 문자 앱이 안 열리면 후원페이지로 안내합니다. 캠페인당 {PROMO_LIMIT_PER_CAMPAIGN}개까지.
      </p>

      {promos.length === 0 ? <p className="mb-4 text-[13px] text-ink-400">아직 홍보물이 없습니다.</p> : (
        <div className="mb-5 space-y-4">
          {promos.map((p) => {
            const st = perf.get(p.id)!;
            const active = promoActive(p);
            return (
              <div key={p.id} className="rounded-2xl border border-ink-100 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge tone={p.archivedAt ? 'neutral' : active ? 'brand' : 'warning'}>{p.archivedAt ? '보관' : active ? '사용 중' : '만료'}</Badge>
                  <span className="text-[14px] font-bold text-ink-900">{p.name}</span>
                  <span className="font-mono text-[12px] text-ink-500">{p.keyword ? `키워드 ${p.keyword}` : 'QR·링크 전용'}</span>
                  {p.expiresOn ? <span className="text-[12px] text-ink-400">~{dateKey(p.expiresOn)}</span> : null}
                </div>
                <div className="mb-3 grid grid-cols-3 gap-2 text-[12.5px]">
                  <div className="rounded-xl bg-ink-50 px-3 py-2"><p className="text-ink-400">문자 수신</p><p className="font-bold text-ink-900">{formatNumber(st.moReceived)}건</p></div>
                  <div className="rounded-xl bg-ink-50 px-3 py-2"><p className="text-ink-400">후원 완료</p><p className="font-bold text-ink-900">{formatNumber(st.paidCount)}건</p></div>
                  <div className="rounded-xl bg-ink-50 px-3 py-2"><p className="text-ink-400">금액</p><p className="font-bold text-ink-900">{formatWon(st.paidAmount)}</p></div>
                </div>
                {p.keyword && moHint ? <p className="mb-3 text-[12.5px] text-ink-500">문자 안내: {moHint} &quot;{p.keyword} 응원 메시지&quot;</p> : null}
                {!p.archivedAt ? (
                  <>
                    <QrCard title={`${campaign.title} · ${p.name}`} subtitle="찍으면 문자 앱이 열립니다" qrPath={`/api/qr/promo/${p.id}`} targetUrl={promoLandingUrl(p.id)} compact />
                    <details className="mt-3">
                      <summary className="cursor-pointer text-[12.5px] font-semibold text-ink-600">이름·키워드·만료일 고치기</summary>
                      <div className="mt-3">
                        <ActionForm action={updatePromoAction} submitLabel="저장" size="sm">
                          <input type="hidden" name="id" value={p.id} />
                          <div className="grid gap-3 sm:grid-cols-3">
                            <Field label="이름"><Input name="name" defaultValue={p.name} maxLength={40} required /></Field>
                            <Field label="문자 키워드(선택)"><Input name="keyword" defaultValue={p.keyword ?? ''} maxLength={10} /></Field>
                            <Field label="만료일(선택)"><Input name="expiresOn" type="date" defaultValue={p.expiresOn ? dateKey(p.expiresOn) : ''} /></Field>
                          </div>
                        </ActionForm>
                      </div>
                    </details>
                    <div className="mt-3"><InlineActionForm action={archivePromoAction} submitLabel="보관" variant="ghost" fields={{ id: p.id, campaignId: campaign.id }} confirmMessage="보관하면 이 홍보물 키워드·QR 이 홍보물로 집계되지 않습니다(지난 성과는 남습니다). 나중에 되살릴 수 있습니다." /></div>
                  </>
                ) : (
                  <InlineActionForm action={restorePromoAction} submitLabel="되살리기" fields={{ id: p.id, campaignId: campaign.id }} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {!archived && live.length < PROMO_LIMIT_PER_CAMPAIGN ? (
        <div className="rounded-2xl bg-ink-50 p-4">
          <p className="mb-3 text-[13.5px] font-bold text-ink-900">홍보물 추가</p>
          <ActionForm action={createPromoAction} submitLabel="홍보물 만들기" size="sm">
            <input type="hidden" name="campaignId" value={campaign.id} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="이름" hint="예: 현수막 1, 교회 소식지 11월, 행사장 QR"><Input name="name" maxLength={40} required /></Field>
              <Field label="문자 키워드(선택)" hint={`예: ${campaign.code}A. 비우면 QR·링크 전용`}><Input name="keyword" maxLength={10} /></Field>
              <Field label="만료일(선택)" hint="이 날까지 홍보물로 집계"><Input name="expiresOn" type="date" /></Field>
            </div>
          </ActionForm>
        </div>
      ) : null}

      <div className="mt-5 border-t border-ink-100 pt-4">
        <p className="mb-1 text-[13.5px] font-bold text-ink-900">비슷한 말(별칭)</p>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-500">
          후원자가 키워드를 정확히 보내지 않았을 때(예: &quot;김치 나눔&quot;) 이 캠페인으로 짐작할 말입니다. 짐작한 결과는 금액 선택 화면에 미리 골라 둘 뿐이고, 후원자가 확인한 뒤 눌러야 후원이 됩니다. 쉼표로 나눠 10개까지.
        </p>
        <ActionForm action={saveCampaignAliasesAction} submitLabel="별칭 저장" size="sm" variant="secondary">
          <input type="hidden" name="campaignId" value={campaign.id} />
          <Field label="별칭"><Textarea name="aliases" rows={2} defaultValue={campaign.aliases.join(', ')} /></Field>
        </ActionForm>
      </div>
      <div className="mt-4"><Notice tone="neutral">{MO_COMMAND_WORDS_TEXT}·정기·봉사는 문자 명령어라 홍보물 키워드·별칭으로 쓸 수 없습니다.</Notice></div>
    </Card>
  );
}
