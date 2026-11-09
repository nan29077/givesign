import { Checkbox, Field, Input, Notice } from '@/components/ui';
import { RECEIPT_PROFILE_DAILY_ATTEMPTS } from '@/server/services/receipts';

/** 영수증 정보 입력칸(통합 /my/receipts 와 같은 항목·안내). 폼은 호출하는 쪽이 감싼다. */
export function ReceiptProfileFields({ profile, terms }: {
  profile: { legalName: string; address: string | null; hometaxOptIn: boolean } | null;
  terms: { title: string; content: string } | null;
}) {
  return (
    <>
      <Notice tone="warning" title="본인 명의 주민등록번호만 등록하세요">
        <span className="text-[15px] leading-relaxed">입력한 성명과 주민등록번호가 일치하는지 기브싸인이 확인하지 못합니다(실명확인 서비스 연동 전). 다른 사람의 번호를 등록하면 그 사람 명의로 영수증이 발급됩니다. 같은 번호는 한 계정에만 등록할 수 있고, 저장 시도는 하루 {RECEIPT_PROFILE_DAILY_ATTEMPTS}번까지입니다.</span>
      </Notice>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="성명(실명)" required><Input name="legalName" maxLength={30} defaultValue={profile?.legalName ?? ''} required className="text-[17px]" /></Field>
        <Field label="주민등록번호" required hint="저장 후에는 가려진 값으로만 표시됩니다.">
          <div className="flex items-center gap-2">
            <Input name="residentFront" inputMode="numeric" maxLength={6} pattern="\d{6}" placeholder="900101" required className="font-mono text-[17px]" />
            <span className="text-ink-400">-</span>
            <Input name="residentBack" type="password" inputMode="numeric" maxLength={7} pattern="\d{7}" placeholder="●●●●●●●" required className="font-mono text-[17px]" />
          </div>
        </Field>
      </div>
      <Field label="주소(선택)" hint="영수증에 인쇄됩니다."><Input name="address" maxLength={200} defaultValue={profile?.address ?? ''} className="text-[17px]" /></Field>
      <Checkbox name="hometaxOptIn" defaultChecked={profile?.hometaxOptIn ?? false} label="국세청 연말정산 간소화 자료 제출에 동의" description="끄면 종이(화면) 영수증만 발급되고 홈택스에 자동 반영되지 않습니다." />
      <div className="rounded-xl border border-ink-200 p-3">
        <p className="text-[15px] font-bold text-ink-900">{terms?.title ?? '기부금영수증 발급을 위한 개인정보 수집·이용 동의'}</p>
        <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-ink-500">{terms?.content ?? '동의 약관이 준비되지 않았습니다.'}</pre>
        <Checkbox name="agree" required label="위 내용을 확인했고 동의합니다" />
      </div>
    </>
  );
}
