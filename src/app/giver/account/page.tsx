import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, Checkbox, DataRow, Field, Input, Notice } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { giverPageContext } from '@/server/giver-context';
import { updateGiverProfileAction, updateGiverReceiptAction } from '@/app/actions/bazaar-giver';
import { donorTypeLabel, formatBizNo, type DonorType } from '@/lib/bazaar';

export const dynamic = 'force-dynamic';

export default async function GiverAccount() {
  const { user, donor } = await giverPageContext();
  const corp = donor.donorType === 'CORPORATE';
  return (
    <>
      <PageHeader title="회원 정보" description="연락처와 기부금영수증 정보를 관리합니다." />
      <Card>
        <CardTitle>기본 정보</CardTitle>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          <DataRow label="회원 구분" value={`${donorTypeLabel[donor.donorType as DonorType]} 회원`} />
          <DataRow label={corp ? '상호' : '이름'} value={donor.displayName} />
          {corp ? <DataRow label="사업자등록번호" value={formatBizNo(donor.businessNo)} /> : null}
          <DataRow label="이메일" value={user.email ?? '-'} />
          <DataRow label="연락처" value={donor.phoneMasked} />
        </div>
        <div className="mt-4">
          <ActionForm action={updateGiverProfileAction} submitLabel="저장" variant="secondary">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={corp ? '담당자 이름' : '연락받을 이름'}><Input name="contactName" defaultValue={donor.contactName} maxLength={30} /></Field>
              <Field label="휴대폰(바꿀 때만)"><Input name="phone" inputMode="tel" placeholder={donor.phoneMasked} /></Field>
              {corp ? <Field label="대표자"><Input name="representativeName" defaultValue={donor.representativeName ?? ''} maxLength={30} /></Field> : null}
              <Field label="주소(영수증 표기)"><Input name="address" defaultValue={donor.address ?? ''} maxLength={200} /></Field>
            </div>
          </ActionForm>
        </div>
      </Card>

      {!corp ? (
        <Card className="mt-4">
          <CardTitle>기부금영수증 정보</CardTitle>
          {donor.residentNoMasked ? <p className="mt-2 text-[13px] text-ink-500">등록됨: {donor.legalName} · {donor.residentNoMasked} · 연말정산 간소화 {donor.hometaxOptIn ? '제출 동의' : '미제출'}</p> : (
            <div className="mt-2"><Notice tone="warning">영수증 정보가 없으면 기관이 검수를 확정할 때 영수증을 발급할 수 없습니다.</Notice></div>
          )}
          <div className="mt-3">
            <ActionForm action={updateGiverReceiptAction} submitLabel="영수증 정보 저장">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="성명" required><Input name="legalName" required defaultValue={donor.legalName ?? donor.displayName} maxLength={30} /></Field>
                <Field label="주민등록번호" required hint="암호화해 보관하고 화면에는 가린 값만 보입니다."><Input name="resident" required inputMode="numeric" autoComplete="off" placeholder="900101-1234567" /></Field>
              </div>
              <Checkbox name="hometaxOptIn" defaultChecked={donor.hometaxOptIn} label="연말정산 간소화 서비스(국세청)에 기부 내역을 제출하는 데 동의합니다" />
            </ActionForm>
          </div>
        </Card>
      ) : (
        <Card className="mt-4">
          <CardTitle>기부금영수증 정보</CardTitle>
          <p className="mt-2 text-[13px] text-ink-500">기업 기부금영수증은 상호·사업자등록번호·대표자로 발급됩니다. 상호·사업자번호 변경은 고객센터로 요청해 주세요.</p>
        </Card>
      )}
    </>
  );
}
