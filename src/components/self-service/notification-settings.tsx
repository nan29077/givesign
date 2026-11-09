import { BellRing, MessageSquareText, Megaphone } from 'lucide-react';
import { Badge } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import {
  NOTIFICATION_SETTING_HELP,
  PREFERRED_CHANNELS,
  PREFERRED_CHANNEL_LABEL,
  type MerchantNoticeSetting,
  type PreferredChannel,
} from '@/server/services/donor-preferences';
import { marketingConsentAction, noticeOptOutAction, preferredChannelAction } from '@/app/actions/self-service';
import { SelfServiceForm } from './self-service-forms';

/**
 * 알림 설정 한 곳 (2026-11-09 2차 F) — 연락 선호 · 월간 안내 수신 · (선택) 소식 수신 동의.
 * 각각 무엇인지 한 줄 설명을 붙인다. code 가 있으면 기관 후원 회원 화면(그 기관만).
 */
export function NotificationSettingsPanel({ code, channel, merchants }: { code?: string; channel: PreferredChannel; merchants: MerchantNoticeSetting[] }) {
  return (
    <div className="space-y-4 text-[16px]">
      <section className="rounded-[24px] border border-ink-100 bg-white p-5">
        <h2 className="flex items-center gap-2 text-[18px] font-black text-ink-900"><MessageSquareText size={20} strokeWidth={1.7} /> 안내 받는 방법</h2>
        <p className="mt-1.5 leading-relaxed text-ink-700">{NOTIFICATION_SETTING_HELP.channel}</p>
        <SelfServiceForm action={preferredChannelAction} code={code} submitLabel="저장" className="mt-3">
          <fieldset className="space-y-2">
            <legend className="sr-only">안내 받는 방법</legend>
            {PREFERRED_CHANNELS.map((c) => (
              <label key={c} className="flex cursor-pointer items-start gap-3 rounded-2xl border border-ink-200 px-4 py-3 has-[:checked]:border-brand-400 has-[:checked]:bg-brand-50">
                <input type="radio" name="channel" value={c} defaultChecked={channel === c} className="mt-1 h-5 w-5" />
                <span>
                  <span className="block text-[17px] font-extrabold text-ink-900">{PREFERRED_CHANNEL_LABEL[c].title}</span>
                  <span className="block text-[15px] leading-relaxed text-ink-500">{PREFERRED_CHANNEL_LABEL[c].desc}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </SelfServiceForm>
      </section>

      <section className="rounded-[24px] border border-ink-100 bg-white p-5">
        <h2 className="flex items-center gap-2 text-[18px] font-black text-ink-900"><BellRing size={20} strokeWidth={1.7} /> 월간 후원 안내</h2>
        <p className="mt-1.5 leading-relaxed text-ink-700">{NOTIFICATION_SETTING_HELP.notice}</p>
        <ul className="mt-3 space-y-3">
          {merchants.map((m) => (
            <li key={m.merchantId} className="rounded-2xl bg-ink-50 p-4">
              <p className="text-[17px] font-bold text-ink-900">{m.merchantName} {m.noticeOptOut ? <Badge className="text-[13px]">받지 않음</Badge> : <Badge tone="success" className="text-[13px]">받음</Badge>}</p>
              <SelfServiceForm action={noticeOptOutAction} code={code} submitLabel={m.noticeOptOut ? '다시 받기' : '그만 받기'} variant="secondary" size="md" className="mt-2">
                <input type="hidden" name="merchantId" value={m.merchantId} />
                <input type="hidden" name="optOut" value={m.noticeOptOut ? '0' : '1'} />
              </SelfServiceForm>
            </li>
          ))}
          {merchants.length === 0 ? <li className="text-ink-500">후원한 기관이 아직 없습니다.</li> : null}
        </ul>
      </section>

      <section className="rounded-[24px] border border-ink-100 bg-white p-5">
        <h2 className="flex items-center gap-2 text-[18px] font-black text-ink-900"><Megaphone size={20} strokeWidth={1.7} /> 기관 소식·후원 안내 (선택 동의)</h2>
        <p className="mt-1.5 leading-relaxed text-ink-700">{NOTIFICATION_SETTING_HELP.marketing}</p>
        <ul className="mt-3 space-y-3">
          {merchants.map((m) => (
            <li key={m.merchantId} className="rounded-2xl bg-ink-50 p-4">
              <p className="text-[17px] font-bold text-ink-900">
                {m.merchantName} {m.marketingAgreed ? <Badge tone="success" className="text-[13px]">동의</Badge> : <Badge className="text-[13px]">동의 안 함</Badge>}
                {m.marketingSince ? <span className="ml-1 text-[14px] font-normal text-ink-500">{formatKst(m.marketingSince, false)}부터</span> : null}
              </p>
              <SelfServiceForm action={marketingConsentAction} code={code} submitLabel={m.marketingAgreed ? '동의 철회' : '동의하기'} variant="secondary" size="md" className="mt-2">
                <input type="hidden" name="merchantId" value={m.merchantId} />
                <input type="hidden" name="agree" value={m.marketingAgreed ? '0' : '1'} />
              </SelfServiceForm>
            </li>
          ))}
          {merchants.length === 0 ? <li className="text-ink-500">이어진 기관이 아직 없습니다.</li> : null}
        </ul>
      </section>
    </div>
  );
}
