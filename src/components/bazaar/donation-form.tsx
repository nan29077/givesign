'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Card, CardTitle, Checkbox, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { createDonationAction } from '@/app/actions/bazaar-giver';
import { initialAdminState } from '@/components/admin/state';
import { BAZAAR_UPLOAD_MAX_FILES, ITEM_CATEGORIES, ITEM_CONDITIONS, itemConditionLabel, unsoldActionLabel, deliveryMethodLabel } from '@/lib/bazaar';

interface Row { key: number }

/**
 * 물품 기부 접수(4단계를 한 화면에 순서대로): 물품 → 기관 → 판매 조건 → 가액 근거·사진.
 * 금지 품목·유통기한은 서버에서 다시 검사한다.
 */
export function DonationForm({ merchants, minSalePrice }: { merchants: Array<{ id: string; displayName: string; neededItems: string | null }>; minSalePrice: number }) {
  const [state, action, pending] = React.useActionState(createDonationAction, initialAdminState);
  const [rows, setRows] = React.useState<Row[]>([{ key: 1 }]);
  const [mode, setMode] = React.useState('ANY');
  const nextKey = React.useRef(2);
  const add = () => setRows((r) => (r.length >= 30 ? r : [...r, { key: nextKey.current++ }]));
  const remove = (k: number) => setRows((r) => (r.length <= 1 ? r : r.filter((x) => x.key !== k)));

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="itemCount" value={rows.length} />
      <Card>
        <CardTitle>1. 기부할 물품</CardTitle>
        <p className="mt-1 text-[12.5px] text-ink-500">품목마다 수량과 개당 가액(원)을 적어 주세요. 가액은 기관과 협의해 확정합니다.</p>
        <div className="mt-4 space-y-4">
          {rows.map((row, i) => (
            <fieldset key={row.key} className="rounded-2xl border border-ink-200 p-4">
              <legend className="px-1 text-[12px] font-extrabold text-ink-500">품목 {i + 1}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="품명" required><Input name={`item_name_${i}`} required maxLength={80} placeholder="예: 주방세제 1L" /></Field>
                <Field label="분류">
                  <Select name={`item_category_${i}`} defaultValue="생활용품">
                    {ITEM_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </Field>
                <Field label="수량" required><Input name={`item_qty_${i}`} required inputMode="numeric" placeholder="100" /></Field>
                <Field label="개당 가액(원)" required hint="공급가·원가 등 근거가 있는 금액"><Input name={`item_value_${i}`} required inputMode="numeric" placeholder="3000" /></Field>
                <Field label="상태">
                  <Select name={`item_condition_${i}`} defaultValue="NEW">
                    {ITEM_CONDITIONS.map((c) => <option key={c} value={c}>{itemConditionLabel[c]}</option>)}
                  </Select>
                </Field>
                <Field label="유통기한(식품·화장품)" hint="30일 이상 남은 물품만 받습니다"><Input type="date" name={`item_expiry_${i}`} /></Field>
              </div>
              {rows.length > 1 ? (
                <div className="mt-2 text-right">
                  <Button variant="ghost" size="sm" onClick={() => remove(row.key)}><Trash2 size={16} strokeWidth={1.7} aria-hidden /> 이 품목 빼기</Button>
                </div>
              ) : null}
            </fieldset>
          ))}
        </div>
        <div className="mt-3"><Button variant="secondary" size="sm" onClick={add}><Plus size={16} strokeWidth={1.7} aria-hidden /> 품목 추가</Button></div>
        <div className="mt-4"><Field label="기부 제목(선택)" hint="비우면 첫 품목 이름으로 만듭니다."><Input name="title" maxLength={80} /></Field></div>
      </Card>

      <Card>
        <CardTitle>2. 기부할 기관</CardTitle>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {[['DESIGNATED', '기관 지정'], ['RECOMMEND', '추천 받기'], ['ANY', '상관없음']].map(([v, l]) => (
            <label key={v} className="flex cursor-pointer items-center gap-2 rounded-xl border border-ink-200 px-3 py-2.5 text-[14px] has-[:checked]:border-brand-400 has-[:checked]:bg-brand-50">
              <input type="radio" name="matchMode" value={v} checked={mode === v} onChange={() => setMode(v)} /> {l}
            </label>
          ))}
        </div>
        {mode === 'DESIGNATED' ? (
          <div className="mt-3">
            {merchants.length === 0 ? (
              <Notice tone="warning">지금 지정할 수 있는 참여 기관이 없습니다. 추천 받기를 골라 주세요.</Notice>
            ) : (
              <Field label="기관" required>
                <Select name="preferredMerchantId" required defaultValue="">
                  <option value="" disabled>기관을 골라 주세요</option>
                  {merchants.map((m) => <option key={m.id} value={m.id}>{m.displayName}{m.neededItems ? ` — 필요 물품: ${m.neededItems.slice(0, 30)}` : ''}</option>)}
                </Select>
              </Field>
            )}
          </div>
        ) : (
          <p className="mt-3 text-[12.5px] text-ink-500">운영자가 물품이 필요한 기관을 찾아 연결합니다. 기관이 수락하면 알려 드립니다.</p>
        )}
      </Card>

      <Card>
        <CardTitle>3. 판매 조건</CardTitle>
        <div className="mt-3 space-y-3">
          <Checkbox name="brandPublic" label="방송·상품 설명에 기부 기업(브랜드)명을 공개해도 됩니다" description="체크하지 않으면 익명 기부로 표시합니다." />
          <Field label="최저 판매가(선택, 원)" hint={`숫자만 적어 주세요. 비우면 운영 기준(최소 ${minSalePrice.toLocaleString('ko-KR')}원)을 따릅니다. 이 가격보다 낮게는 팔지 않습니다.`}>
            <Input name="minSalePrice" inputMode="numeric" pattern="[0-9,]*" title="숫자로 입력해 주세요" />
          </Field>
          <Field label="판매되지 않은 물품" required>
            <Select name="unsoldAction" defaultValue="MERCHANT_USE">
              {['MERCHANT_USE', 'TRANSFER', 'RETURN'].map((v) => <option key={v} value={v}>{unsoldActionLabel[v]}</option>)}
            </Select>
          </Field>
          <Field label="물품 전달 방법" required>
            <Select name="deliveryMethod" defaultValue="SEND">
              {['SEND', 'PICKUP'].map((v) => <option key={v} value={v}>{deliveryMethodLabel[v]}</option>)}
            </Select>
          </Field>
        </div>
      </Card>

      <Card>
        <CardTitle>4. 사진·가액 근거</CardTitle>
        <div className="mt-3 space-y-3">
          <p className="text-[12.5px] text-ink-500">사진과 근거 자료를 합쳐 한 번에 {BAZAAR_UPLOAD_MAX_FILES}개까지, 한 개 5MB 이하로 올릴 수 있습니다. 더 있으면 접수한 뒤 기부 상세 화면에서 올려 주세요. 파일에 문제가 있으면 기부가 접수되지 않으니 안내를 확인하고 다시 올려 주세요.</p>
          <Field label="물품 사진" hint="JPG·PNG·WEBP, 한 장 5MB 이하"><input type="file" name="photos" multiple accept="image/jpeg,image/png,image/webp" className="text-[13px]" /></Field>
          <Field label="가액 근거(세금계산서·거래명세서·원가 자료)" hint="이미지 또는 PDF, 한 개 5MB 이하. 기관이 가액을 확정하는 데 씁니다. 나중에 올려도 됩니다."><input type="file" name="evidence" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="text-[13px]" /></Field>
          <Field label="기관에 전할 말(선택)"><Textarea name="donorMessage" rows={3} maxLength={500} /></Field>
        </div>
      </Card>

      {state.message && !state.ok ? <Notice tone="danger"><span className="whitespace-pre-line">{state.message}</span></Notice> : null}
      <Button type="submit" size="lg" disabled={pending}>{pending ? '접수 중' : '기부 접수하기'}</Button>
    </form>
  );
}
