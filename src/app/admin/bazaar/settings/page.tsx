import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, Notice } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect, AdminTextarea } from '@/components/admin/controls';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { adminBazaarContext, ADMIN_BAZAAR_TABS } from '@/server/admin-bazaar-context';
import { getBazaarConfig } from '@/server/services/bazaar-settings';
import { saveBazaarConfigAction } from '@/app/actions/admin/bazaar';
import { BAZAAR_CONFIG_RANGES as R, BLOCKED_KEYWORDS } from '@/lib/bazaar';

export const dynamic = 'force-dynamic';

export default async function AdminBazaarSettings() {
  const admin = await adminBazaarContext();
  const cfg = await getBazaarConfig();
  const canEdit = admin.adminPermission === 'SUPER_ADMIN';
  return (
    <>
      <PageHeader title="바자회 설정" description="수수료·최소 판매가·정산 지급일 등 운영 기준입니다. 켜고 끄기는 사이트 설정에서 합니다." action={<Link href="/admin/site-settings" className="text-[13px] font-bold text-brand-700 underline">사이트 설정(켜기·끄기)</Link>} />
      <BazaarSubNav items={ADMIN_BAZAAR_TABS} current="/admin/bazaar/settings" />
      {!canEdit ? <div className="mb-4"><Notice tone="neutral">최고관리자만 바꿀 수 있습니다.</Notice></div> : null}
      <Card>
        <CardTitle>운영 기준</CardTitle>
        <div className="mt-3">
          <ActionForm action={saveBazaarConfigAction} submitLabel="저장" disabled={!canEdit} confirm="바꾼 기준은 이후 승인하는 판매 결과부터 적용됩니다. 저장할까요?">
            <div className="grid gap-3 sm:grid-cols-3">
              <AdminField label="수수료 요율(%)" hint="0~90, 소수 둘째 자리까지. 판매 금액에서 공제(환불 환입은 원래 판매 요율). 기본 30"><AdminInput name="feeRatePercent" defaultValue={cfg.feeRatePercent} /></AdminField>
              <AdminField label="수수료 부가세" hint="결정 전까지 포함으로 운영. 원장에는 공급가액·부가세를 나눠 기록">
                <AdminSelect name="feeVatMode" defaultValue={cfg.feeVatMode}><option value="INCLUDED">요율에 부가세 포함</option><option value="EXCLUDED">부가세 10% 별도</option></AdminSelect>
              </AdminField>
              <AdminField label="정산 지급일(다음 달 n일)" hint={`${R.settlementPayDay.min}~${R.settlementPayDay.max}`}><AdminInput name="settlementPayDay" inputMode="numeric" defaultValue={String(cfg.settlementPayDay)} /></AdminField>
              <AdminField label="최소 판매가(원)" hint={`${R.minSalePrice.min.toLocaleString('ko-KR')}~${R.minSalePrice.max.toLocaleString('ko-KR')}. 소액 상품 적자 방지. 묶음 상품으로 만들어 넘기세요`}><AdminInput name="minSalePrice" inputMode="numeric" defaultValue={String(cfg.minSalePrice)} /></AdminField>
              <AdminField label="기본 1인 구매 제한(개)" hint={`${R.defaultPerPersonLimit.min}~${R.defaultPerPersonLimit.max}`}><AdminInput name="defaultPerPersonLimit" inputMode="numeric" defaultValue={String(cfg.defaultPerPersonLimit)} /></AdminField>
              <AdminField label="매칭 수락 기한(일)" hint={`${R.matchDeadlineDays.min}~${R.matchDeadlineDays.max}. 기한이 지나면 1시간마다 도는 배치가 접수 상태로 되돌립니다`}><AdminInput name="matchDeadlineDays" inputMode="numeric" defaultValue={String(cfg.matchDeadlineDays)} /></AdminField>
            </div>
            <AdminField label="기부 물품 받을 창고 주소" hint="약정을 마친 기부자에게 보입니다."><AdminInput name="warehouseAddress" defaultValue={cfg.warehouseAddress} /></AdminField>
            <AdminField label="셀러브릭스 상품 설명 위탁판매 문구" hint="{기관명} 은 기관 이름으로 바뀝니다. 등록 정보 CSV 에 들어갑니다."><AdminTextarea name="consignmentNotice" rows={2} defaultValue={cfg.consignmentNotice} /></AdminField>
          </ActionForm>
        </div>
      </Card>
      <Card className="mt-4">
        <CardTitle>받지 않는 품목(접수 단계 자동 차단)</CardTitle>
        <p className="mt-2 text-[13px] text-ink-600">{BLOCKED_KEYWORDS.join(' · ')} — 유통기한 30일 미만도 받지 않습니다. 품목 목록은 코드(src/lib/bazaar.ts)에서 관리합니다.</p>
      </Card>
    </>
  );
}
