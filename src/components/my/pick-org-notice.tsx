import { Building2 } from 'lucide-react';
import { LinkButton } from '@/components/ui';
import { MerchantCodeForm } from '@/components/merchant-code-form';

/**
 * /my/recurring/new · /my/volunteer/apply 를 기관 지정(?merchant=코드) 없이 열었거나,
 * 지정한 기관을 찾을 수 없을 때의 안내. 404 대신 기관 후원페이지로 가는 길을 알려 준다.
 */
export function PickOrgNotice({ kind, unknownCode = false }: { kind: 'recurring' | 'volunteer'; unknownCode?: boolean }) {
  const what = kind === 'recurring' ? '정기후원' : '자원봉사 신청';
  return (
    <div className="rounded-2xl border border-dashed border-ink-200 bg-white px-5 py-8">
      <div className="text-center">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-700">
          <Building2 size={20} strokeWidth={1.7} />
        </span>
        <h2 className="mt-3 text-[16px] font-extrabold text-ink-900">
          {unknownCode ? '기관을 찾을 수 없습니다' : '후원페이지에서 기관을 골라 주세요'}
        </h2>
        <p className="mx-auto mt-1.5 max-w-[380px] text-[13px] leading-relaxed text-ink-500">
          {unknownCode
            ? `링크의 기관 코드를 확인해 주세요. 승인 전이거나 이용이 정지된 기관에는 ${what}을 할 수 없습니다.`
            : `${what}은 기관마다 따로 진행합니다. 아래에서 기관을 찾아 후원페이지의 ${what} 버튼을 눌러 주세요.`}
        </p>
      </div>
      <div className="mx-auto mt-4 max-w-[400px]">
        <MerchantCodeForm target="donate" />
      </div>
      <div className="mt-4 flex justify-center">
        <LinkButton href={kind === 'recurring' ? '/my/recurring' : '/my/volunteer'} variant="secondary" size="md">
          {kind === 'recurring' ? '내 정기후원 보기' : '내 자원봉사 보기'}
        </LinkButton>
      </div>
    </div>
  );
}
