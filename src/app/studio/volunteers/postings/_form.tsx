import { Field, Input, Select, Textarea } from '@/components/ui';
import { VOLUNTEER_INTERESTS } from '@/server/services/volunteers';

/** 공고 입력 칸(등록·수정 공용). 서버 컴포넌트에서 ActionForm 안에 넣는다. */
export function PostingFields({
  defaults,
}: {
  defaults?: { title?: string; interest?: string; description?: string; place?: string; recruitFrom?: string; recruitTo?: string; requirements?: string | null };
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <Field label="공고 제목" required><Input name="title" maxLength={80} defaultValue={defaults?.title} placeholder="예: 토요일 어르신 도시락 배달" /></Field>
        <Field label="활동 분야" required>
          <Select name="interest" defaultValue={defaults?.interest ?? VOLUNTEER_INTERESTS[0]}>
            {VOLUNTEER_INTERESTS.map((i) => <option key={i} value={i}>{i}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="활동 설명" required><Textarea name="description" rows={4} maxLength={2000} defaultValue={defaults?.description} placeholder="무엇을 하는지, 누구를 돕는지 적어 주세요. 수혜자 실명은 쓰지 않습니다." /></Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_170px_170px]">
        <Field label="활동 장소" required><Input name="place" maxLength={120} defaultValue={defaults?.place} placeholder="예: 복지관 1층 급식실" /></Field>
        <Field label="모집 시작일" required><Input type="date" name="recruitFrom" defaultValue={defaults?.recruitFrom} /></Field>
        <Field label="모집 마감일" required><Input type="date" name="recruitTo" defaultValue={defaults?.recruitTo} /></Field>
      </div>
      <Field label="필요 사항 (선택)" hint="준비물·자격·연령 등"><Input name="requirements" maxLength={500} defaultValue={defaults?.requirements ?? ''} placeholder="예: 앞치마 지참, 만 14세 이상" /></Field>
    </>
  );
}
