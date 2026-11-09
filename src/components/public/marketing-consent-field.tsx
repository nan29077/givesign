import * as React from 'react';
import { BellRing } from 'lucide-react';

/**
 * (선택) 기관 소식·후원 안내 수신 동의 체크칸 (2026-11-09).
 *  - 기본 체크 해제. 필수 동의와 떨어진 별도 상자에 둔다.
 *  - 체크하지 않으면 아무것도 바뀌지 않는다(기존 동의를 철회하지 않는다) — 서버가 같은 규칙을 지킨다.
 *  - 문구는 services/marketing-consent.ts marketingConsentWording 과 같다(이력에 남는 문구).
 * 훅이 없어 서버·클라이언트 컴포넌트 어디서든 쓸 수 있다.
 */
export function MarketingConsentField({
  merchantName,
  tail = '후원할 수 있습니다',
  name = 'marketingConsent',
  className = '',
}: {
  merchantName: string;
  tail?: string;
  name?: string;
  className?: string;
}) {
  const id = React.useId();
  return (
    <div className={`rounded-xl border border-dashed border-ink-200 bg-white px-3 py-2.5 ${className}`}>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2 text-[12.5px] leading-relaxed text-ink-600">
        <input id={id} type="checkbox" name={name} value="1" defaultChecked={false} className="mt-0.5 h-4 w-4 shrink-0 rounded border-ink-300" />
        <span>
          <BellRing size={14} strokeWidth={1.7} className="mr-1 inline-block align-[-2px] text-ink-400" aria-hidden />
          (선택) {merchantName}의 소식과 후원 안내를 문자·알림톡으로 받겠습니다. 동의하지 않아도 {tail}.
        </span>
      </label>
    </div>
  );
}
