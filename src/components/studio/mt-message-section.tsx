import { MessageSquareText } from 'lucide-react';
import { Card, CardTitle, Field, Textarea } from '@/components/ui';
import { ActionForm, InlineActionForm } from '@/components/studio/action-form';
import { sendTestMtAction } from '@/app/actions/studio';
import type { StudioActionState } from '@/app/actions/studio';

/**
 * 안내 문자 편집 블록 (MO 안내 · 감사 문자 공용).
 *
 * 두 문자는 편집·검증·미리보기 구조가 같다. 탭을 따로 두면 같은 화면을 두 번 만들고
 * 사회복지기관은 두 문자의 차이를 화면 사이를 오가며 비교해야 한다.
 *
 * 저장 검증은 "템플릿 원문" 길이만 본다. 치환자가 실제 값으로 바뀐 뒤의 길이는 여기서 보여 준다.
 * SMS(90byte) 를 넘으면 LMS 로 나가 발송 단가가 달라지므로 사회복지기관이 알아야 한다.
 */
export function MtMessageSection({
  kind,
  title,
  description,
  action,
  fieldName,
  maxLength,
  defaultValue,
  placeholder,
  variables,
  preview,
  defaultPreview,
  notice,
}: {
  kind: 'moGuide' | 'thanks';
  title: string;
  description: string;
  action: (prev: StudioActionState, formData: FormData) => Promise<StudioActionState>;
  fieldName: string;
  maxLength: number;
  defaultValue: string;
  placeholder: string;
  variables: ReadonlyArray<{ token: string; label: string }>;
  preview: string;
  defaultPreview: string;
  notice: React.ReactNode;
}) {
  // 실제 발송 바이트 수. 어댑터의 decideMessageType 과 같은 기준(90byte)이다.
  const bytes = Buffer.byteLength(preview, 'utf8');
  const type = bytes > 90 ? 'LMS' : 'SMS';

  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <p className="mb-3 mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{description}</p>

      <ActionForm action={action} submitLabel="저장" variant="secondary">
        <Field label="본문" hint={`${maxLength}자 이내. 비워두면 기본 문구로 발송됩니다.`}>
          <Textarea name={fieldName} rows={4} maxLength={maxLength} defaultValue={defaultValue} placeholder={placeholder} />
        </Field>

        <div className="rounded-2xl border border-ink-100 bg-ink-50 px-4 py-3">
          <p className="flex items-center gap-1.5 text-[12.5px] font-extrabold text-ink-900">
            <MessageSquareText size={16} strokeWidth={1.7} className="text-brand-700" />
            사용할 수 있는 치환자
          </p>
          <ul className="mt-2 space-y-1">
            {variables.map((v) => (
              <li key={v.token} className="flex items-center gap-2 text-[12px] text-ink-700">
                <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[11.5px] font-bold text-brand-700">
                  {v.token}
                </span>
                {v.label}
              </li>
            ))}
          </ul>
        </div>
      </ActionForm>

      <div className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-bold text-ink-900">현재 설정으로 발송되는 문자</p>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
              type === 'LMS' ? 'bg-warning-50 text-warning-500' : 'bg-ink-50 text-ink-500'
            }`}
          >
            {type} · {bytes}byte
          </span>
        </div>
        <p className="mt-2 whitespace-pre-wrap rounded-2xl bg-brand-50 px-4 py-3 text-[13px] leading-relaxed text-ink-900">
          {preview}
        </p>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-400">
          치환자가 실제 값으로 바뀐 뒤의 길이입니다. 90byte(한글 45자 안팎)를 넘으면 LMS 로 나가 발송 단가가
          올라갑니다.
        </p>
      </div>

      {defaultValue ? (
        <div className="mt-4">
          <p className="text-[13px] font-bold text-ink-900">기본 문구 (설정을 비우면 이 문구로 발송)</p>
          <p className="mt-2 whitespace-pre-wrap rounded-2xl bg-ink-50 px-4 py-3 text-[13px] leading-relaxed text-ink-500">
            {defaultPreview}
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
        <InlineActionForm
          action={sendTestMtAction}
          submitLabel="내 번호로 테스트 발송"
          variant="secondary"
          fields={{ kind }}
          confirmMessage="계정에 등록된 휴대폰 번호로 지금 설정된 문구를 실제 발송합니다. 보낼까요?"
        />
        <span className="text-[11.5px] text-ink-400">실제 문자로 줄바꿈과 치환 결과를 확인할 수 있습니다.</span>
      </div>

      <div className="mt-4">{notice}</div>
    </Card>
  );
}
