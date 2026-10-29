import { Checkbox, Field, Input, Notice, Select } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { issuerReadiness } from '@/server/services/receipts';
import type { MerchantProfile } from '@/generated/prisma/client';
import type { StudioActionState } from '@/app/actions/studio';
import type { OrganizationType } from '@/generated/prisma/enums';

export const ORG_TYPE_LABEL: Record<OrganizationType, string> = {
  WELFARE_CORPORATION: '사회복지법인',
  WELFARE_FACILITY: '사회복지시설',
  NONPROFIT_ORG: '비영리민간단체',
  PUBLIC_INTEREST_CORP: '공익법인(재단·사단)',
  RELIGIOUS: '종교단체',
  OTHER: '기타',
};

export function OrganizationInfoForm({
  action,
  merchant: m,
}: {
  action: (prev: StudioActionState, f: FormData) => Promise<StudioActionState>;
  merchant: MerchantProfile;
}) {
  const ready = issuerReadiness(m);
  return (
    <>
      {!ready.ok ? (
        <div className="mb-4">
          <Notice tone="warning" title="기부금영수증을 발급하려면 다음 정보가 필요합니다">{ready.missing.join(' · ')}</Notice>
        </div>
      ) : (
        <div className="mb-4">
          <Notice tone="success">기부금영수증 발급 정보가 준비되었습니다.</Notice>
        </div>
      )}
      <ActionForm action={action} submitLabel="기관 정보 저장">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="기관 유형">
            <Select name="orgType" defaultValue={m.orgType ?? ''}>
              <option value="">선택</option>
              {(Object.keys(ORG_TYPE_LABEL) as OrganizationType[]).map((k) => (
                <option key={k} value={k}>{ORG_TYPE_LABEL[k]}</option>
              ))}
            </Select>
          </Field>
          <Field label="고유번호(사업자등록번호)" hint="000-00-00000" required>
            <Input name="businessNo" defaultValue={m.businessNo ?? ''} placeholder="123-82-00001" inputMode="numeric" />
          </Field>
          <Field label="대표자 성명" required>
            <Input name="representativeName" maxLength={30} defaultValue={m.representativeName ?? ''} />
          </Field>
          <Field label="소재지" required>
            <Input name="address" maxLength={200} defaultValue={m.address ?? ''} />
          </Field>
          <Field label="후원 담당자">
            <Input name="contactName" maxLength={30} defaultValue={m.contactName ?? ''} />
          </Field>
          <Field label="담당자 연락처" hint="후원자 문의 응대용. 후원페이지에 표시됩니다.">
            <Input name="contactPhone" defaultValue={m.contactPhone ?? ''} placeholder="02-000-0000" inputMode="tel" />
          </Field>
          <Field label="담당자 이메일">
            <Input name="contactEmail" type="email" defaultValue={m.contactEmail ?? ''} />
          </Field>
          <Field label="기부금 코드" hint="영수증·국세청 명세에 쓰입니다. 대부분의 사회복지기관은 40(일반)입니다.">
            <Select name="donationCode" defaultValue={m.donationCode}>
              <option value="10">10 — 특례기부금(법정)</option>
              <option value="40">40 — 일반기부금(지정)</option>
              <option value="41">41 — 일반기부금(종교단체)</option>
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <Checkbox
              name="designatedDonee"
              defaultChecked={m.designatedDonee}
              label="공익법인(구 지정기부금단체)으로 지정되어 기부금영수증을 발급할 수 있습니다"
              description="국세청 공익법인 지정 현황에서 확인한 뒤 체크하세요. 지정되지 않은 기관이 발급한 영수증은 연말정산에서 인정되지 않습니다."
            />
          </div>
          <Field label="지정 만료일" hint="재지정 신청 시기를 놓치지 않도록 안내합니다.">
            <Input type="date" name="designatedDoneeUntil" defaultValue={m.designatedDoneeUntil ? m.designatedDoneeUntil.toISOString().slice(0, 10) : ''} />
          </Field>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="기부금품 모집 등록번호" hint="연 1천만원 이상 모집 시 기부금품법에 따라 등록. 후원페이지 하단에 표기됩니다.">
            <Input name="fundraisingRegNo" maxLength={40} defaultValue={m.fundraisingRegNo ?? ''} />
          </Field>
          <Field label="등록 관청">
            <Input name="fundraisingRegAuthority" maxLength={40} defaultValue={m.fundraisingRegAuthority ?? ''} placeholder="행정안전부 / OO시" />
          </Field>
        </div>
      </ActionForm>
    </>
  );
}
