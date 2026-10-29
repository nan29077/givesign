import { Card, CardTitle, Field, Input, Notice, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { DocumentFieldEditor, type EditorField } from '@/components/studio/document-field-editor';
import { DocumentFileField } from '@/components/studio/document-file-field';
import {
  DOCUMENT_BODY_MAX, MAX_DOCUMENT_FIELDS, documentTemplateTypeLabel, fieldTypeLabel,
  type DocumentField,
} from '@/server/services/documents';
import type { DocumentTemplate } from '@/generated/prisma/client';
import type { DocumentTemplateType } from '@/generated/prisma/enums';
import type { StudioActionState } from '@/app/actions/studio';

/**
 * 문서 서식 등록·수정 폼 (직접 작성 · 파일 업로드 · 기본 서식 공용).
 *
 * 만드는 방법(templateType)은 등록할 때 주소로 정하고 이후 바꿀 수 없다.
 * 이미 발송된 작성 링크가 다른 화면을 그리면, 후원자는 결제한 것과 다른 문서를 보게 된다.
 */

type Action = (prev: StudioActionState, formData: FormData) => Promise<StudioActionState>;

function Section({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-brand-100 text-[12px] font-black text-brand-800">
          {step}
        </span>
        <div>
          <CardTitle>{title}</CardTitle>
          {description ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{description}</p> : null}
        </div>
      </div>
      <div className="space-y-3.5">{children}</div>
    </Card>
  );
}

export function DocumentTemplateForm({
  action,
  templateType,
  template,
  fields,
  defaultName,
  defaultDescription,
  defaultBody,
  presetKey,
  submitLabel,
}: {
  action: Action;
  templateType: DocumentTemplateType;
  /** 수정이면 저장된 서식. 새로 만들면 null. */
  template: DocumentTemplate | null;
  fields: DocumentField[];
  /** 기본 서식을 고른 직후 폼에 채워 넣을 값 (등록 화면에서만 쓴다). */
  defaultName?: string;
  defaultDescription?: string;
  defaultBody?: string;
  presetKey?: string | null;
  submitLabel: string;
}) {
  const isFile = templateType === 'FILE';
  const editorFields: EditorField[] = fields.map((f) => ({
    id: f.id,
    label: f.label,
    type: f.type,
    required: f.required,
    hint: f.hint ?? '',
  }));

  return (
    <ActionForm action={action} submitLabel={submitLabel} size="lg" className="space-y-4">
      <input type="hidden" name="templateType" value={templateType} />
      {template ? <input type="hidden" name="templateId" value={template.id} /> : null}
      {templateType === 'PRESET' ? (
        <input type="hidden" name="presetKey" value={template?.presetKey ?? presetKey ?? ''} />
      ) : null}

      {/* ── 1. 기본 정보 ───────────────────────────────────────── */}
      <Section
        step={1}
        title="기본 정보"
        description={`만드는 방법: ${documentTemplateTypeLabel[templateType].text} — ${documentTemplateTypeLabel[templateType].hint}`}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="서식 이름" hint="60자 이내. 문자와 작성 화면에 그대로 보입니다." required>
            <Input
              name="name"
              maxLength={60}
              defaultValue={template?.name ?? defaultName ?? ''}
              placeholder="후원약정서"
            />
          </Field>
          <Field label="한 줄 설명" hint="콘솔 목록과 작성 화면 상단에 보입니다.">
            <Input
              name="description"
              maxLength={200}
              defaultValue={template?.description ?? defaultDescription ?? ''}
              placeholder="정기 후원 약정 내용을 확인받는 서식"
            />
          </Field>
        </div>

        {/*
          체크박스는 해제하면 FormData 에 아예 담기지 않는다.
          "값이 안 왔다" 와 "꺼서 안 왔다" 를 구분할 짝(hidden)이 없으면 항상 켜서 저장된다.
        */}
        <input type="hidden" name="activePresent" value="1" />
        <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-800">
          <input type="checkbox" name="active" defaultChecked={template ? template.active : true} className="h-4 w-4" />
          이 서식 사용
          <span className="font-normal text-ink-400">(끄면 이 서식을 쓰는 상품을 결제할 수 없습니다)</span>
        </label>
      </Section>

      {/* ── 2. 서식 내용 ───────────────────────────────────────── */}
      {isFile ? (
        <Section
          step={2}
          title="서식 파일"
          description="후원자는 작성 화면에서 이 파일을 내려받아 작성합니다."
        >
          <DocumentFileField
            name="fileUrl"
            nameFieldName="fileName"
            label="서식 파일"
            defaultValue={template?.fileUrl ?? ''}
            defaultFileName={template?.fileName ?? ''}
            hint="후원자가 내려받는 원본 서식입니다. 개인정보가 미리 채워진 파일을 올리지 마세요."
          />
          <Field
            label="작성 안내"
            hint="파일을 내려받은 뒤 무엇을 해야 하는지 적어 주세요. 작성 화면에 그대로 보입니다."
          >
            <Textarea
              name="body"
              rows={4}
              maxLength={DOCUMENT_BODY_MAX}
              defaultValue={template?.body ?? ''}
              placeholder={'서식을 내려받아 작성하신 뒤, 아래 연락처로 보내 주세요.\n문의: 평일 10시~18시'}
            />
          </Field>
        </Section>
      ) : (
        <Section
          step={2}
          title="문서 본문"
          description="후원자가 작성 화면에서 그대로 읽는 내용입니다. 줄바꿈이 유지됩니다."
        >
          <Field label="본문" hint={`${DOCUMENT_BODY_MAX.toLocaleString('ko-KR')}자 이내`} required>
            <Textarea
              name="body"
              rows={16}
              maxLength={DOCUMENT_BODY_MAX}
              defaultValue={template?.body ?? defaultBody ?? ''}
              placeholder={'제1조 (목적)\n이 약정서는 ...'}
            />
          </Field>
          {templateType === 'PRESET' ? (
            <Notice tone="warning" title="기본 서식은 뼈대입니다">
              기브싸인이 준비한 기본 서식은 작성 편의를 위한 예시이며, 법률 검토를 받은 표준 약관이 아닙니다.
              사회복지기관 사정과 관계 법령에 맞게 반드시 손봐서 쓰세요.
            </Notice>
          ) : null}
        </Section>
      )}

      {/* ── 3. 입력 항목 ───────────────────────────────────────── */}
      <Section
        step={3}
        title="입력 항목"
        description={
          isFile
            ? '파일 서식도 제출자를 확인할 항목을 받아 둘 수 있습니다. 없어도 됩니다.'
            : '후원자가 화면에서 채우는 빈칸입니다. 1개 이상 필요합니다.'
        }
      >
        <DocumentFieldEditor name="fieldsJson" defaultValue={editorFields} max={MAX_DOCUMENT_FIELDS} />
        <ul className="space-y-1 rounded-xl bg-ink-50 px-3.5 py-2.5">
          {(Object.keys(fieldTypeLabel) as Array<keyof typeof fieldTypeLabel>).map((t) => (
            <li key={t} className="text-[11.5px] leading-relaxed text-ink-500">
              <span className="font-bold text-ink-700">{fieldTypeLabel[t].text}</span> — {fieldTypeLabel[t].hint}
            </li>
          ))}
        </ul>
      </Section>

      {/* ── 4. 서명 ───────────────────────────────────────────── */}
      <Section step={4} title="서명" description="약정서·계약서는 자필 서명을 받아 두는 것이 안전합니다.">
        <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-800">
          <input
            type="checkbox"
            name="requireSignature"
            defaultChecked={template ? template.requireSignature : templateType !== 'FILE'}
            className="h-4 w-4"
          />
          자필 서명 받기
          <span className="font-normal text-ink-400">(작성 화면에서 손가락·마우스로 서명합니다)</span>
        </label>
        <Notice tone="neutral" title="서명은 이미지로 보관됩니다">
          후원자가 그린 서명은 그림 파일로 저장되고, 제출 시각·접속 정보와 함께 남습니다. 공인전자서명은 아니므로
          분쟁 가능성이 큰 계약에는 별도 절차를 함께 두세요.
        </Notice>
      </Section>
    </ActionForm>
  );
}
