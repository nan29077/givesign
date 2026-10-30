import { Card, Checkbox, Field, Input, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { saveCampaignAction } from '@/app/actions/fundraising';
import type { Campaign } from '@/generated/prisma/client';
import { CampaignCardEditor } from './campaign-card-editor';

/**
 * 캠페인 등록·수정 폼.
 * 문자 키워드는 후원자가 문자 맨 앞에 적는 값이라 짧고 기억하기 쉬운 한글을 권한다.
 */
export function CampaignForm({ initial: c, today }: { initial?: Campaign | null; today: string }) {
  const date = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : today);
  return (
    <ActionForm action={saveCampaignAction} submitLabel={c ? '캠페인 저장' : '캠페인 만들기'} className="space-y-5">
      <input type="hidden" name="id" value={c?.id ?? ''} />
      <Card className="space-y-4">
        <div className="grid gap-4 md:grid-cols-[1fr_200px]">
          <Field label="캠페인 제목" required>
            <Input name="title" required maxLength={100} defaultValue={c?.title ?? ''} placeholder="예: 겨울 김장 나눔" />
          </Field>
          <Field label="문자 키워드" required hint="한글·영문·숫자 2~10자. 후원자는 '김장 응원합니다' 처럼 문자 맨 앞에 적습니다.">
            <Input name="code" required maxLength={10} defaultValue={c?.code ?? ''} placeholder="김장" className="font-mono" />
          </Field>
        </div>
        <Field label="한 줄 소개" required>
          <Input name="summary" required maxLength={300} defaultValue={c?.summary ?? ''} placeholder="어르신 300가구에 김장김치를 전합니다" />
        </Field>
        <ImageUploadField label="대표 이미지" name="imageUrl" defaultValue={c?.imageUrl ?? ''} hint="비워 두면 기관 후원페이지의 대표 배너를 씁니다." />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="목표 후원금 (원)" required>
            <Input type="number" name="goalAmount" min={10000} step={1000} required defaultValue={c ? Number(c.goalAmount) : 1000000} />
          </Field>
          <Field label="시작일" required>
            <Input type="date" name="startsOn" required defaultValue={date(c?.startsOn)} />
          </Field>
          <Field label="종료일" required>
            <Input type="date" name="endsOn" required defaultValue={date(c?.endsOn)} />
          </Field>
        </div>
      </Card>
      <CampaignCardEditor initial={c?.cardNews} />
      <Card className="space-y-4">
        <Field label="지원 대상" hint="누구를 돕는 캠페인인지 한두 문장으로">
          <Input name="beneficiary" maxLength={300} defaultValue={c?.beneficiary ?? ''} />
        </Field>
        <Field label="캠페인 이야기" hint="후원페이지 본문. 상황·필요·변화를 구체적으로 적을수록 참여가 늘어납니다.">
          <Textarea name="story" rows={8} maxLength={10000} defaultValue={c?.story ?? ''} />
        </Field>
        <Field label="후원금 사용 계획" hint="항목별 예산처럼 쓰임을 밝히면 신뢰가 높아집니다.">
          <Textarea name="usagePlan" rows={5} maxLength={3000} defaultValue={c?.usagePlan ?? ''} />
        </Field>
        {c && c.status === 'CLOSED' ? (
          <Field label="결과 보고" hint="모금 종료 후 사용 내역과 성과. 후원페이지 캠페인 상세에 표시됩니다.">
            <Textarea name="resultReport" rows={6} maxLength={10000} defaultValue={c.resultReport ?? ''} />
          </Field>
        ) : (
          <input type="hidden" name="resultReport" value={c?.resultReport ?? ''} />
        )}
        <Checkbox name="featured" defaultChecked={c?.featured ?? false} label="후원페이지 맨 위에 강조" description="강조 캠페인은 후원페이지 첫 화면과 금액 선택 화면에서 가장 먼저 보입니다." />
      </Card>
    </ActionForm>
  );
}
