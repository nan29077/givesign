import { Checkbox, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { saveImpactUpdateAction } from '@/app/actions/impact';
import { IMPACT_BODY_MAX, IMPACT_TITLE_MAX } from '@/server/services/impact-reports';

/** 사업 진행 기록 입력 폼(새로 만들기·고치기 공용) — 2026-11-09 3차 H1 */
export function ImpactForm({
  campaigns,
  initial,
}: {
  campaigns: Array<{ id: string; title: string }>;
  initial?: { id: string; campaignId: string | null; title: string; body: string; photos: string[]; periodFrom: string | null; periodTo: string | null; photoRuleAck: boolean };
}) {
  return (
    <ActionForm action={saveImpactUpdateAction} submitLabel={initial ? '저장' : '진행 기록 만들기'}>
      {initial ? <input type="hidden" name="id" value={initial.id} /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="연결 캠페인" hint="비우면 기관 일반 후원(대상 기간의 비지정 후원자)으로 봅니다.">
          <Select name="campaignId" defaultValue={initial?.campaignId ?? ''}>
            <option value="">기관 일반 후원</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </Select>
        </Field>
        <Field label="제목" required hint={`${IMPACT_TITLE_MAX}자 이내`}>
          <Input name="title" required maxLength={IMPACT_TITLE_MAX} defaultValue={initial?.title ?? ''} placeholder="예: 겨울나기 연탄 나눔 1차 진행" />
        </Field>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="대상 기간 시작(일반 후원만)" hint="캠페인 기록은 캠페인 전체를 봅니다.">
          <Input type="date" name="periodFrom" defaultValue={initial?.periodFrom ?? ''} />
        </Field>
        <Field label="대상 기간 끝(일반 후원만)">
          <Input type="date" name="periodTo" defaultValue={initial?.periodTo ?? ''} />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="진행 내용" required hint={`${IMPACT_BODY_MAX}자 이내 · 무엇을 했는지 사실대로 적어 주세요. 이 내용과 집행 내역 숫자로 보고서 초안을 만듭니다.`}>
          <Textarea name="body" required rows={6} maxLength={IMPACT_BODY_MAX} defaultValue={initial?.body ?? ''} />
        </Field>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <ImageUploadField key={i} name={`photo${i + 1}`} label={`사진 ${i + 1}`} defaultValue={initial?.photos[i] ?? ''} hint="이 화면에서 올린 파일만 씁니다." />
        ))}
      </div>
      <div className="mt-3">
        <Notice tone="warning" title="수혜자 실사진·실명 금지">
          지원 대상자의 얼굴이 보이는 사진·실명·나이·주소처럼 사람을 알아볼 수 있는 내용을 올리지 않습니다. 물품·공간·활동 장면 사진만 써 주세요.
        </Notice>
        <Checkbox name="photoRuleAck" defaultChecked={initial?.photoRuleAck} label="수혜자 실사진·실명을 쓰지 않았음을 확인했습니다(사진이 있으면 필수)" />
      </div>
    </ActionForm>
  );
}
