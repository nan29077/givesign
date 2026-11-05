import { AlertTriangle } from 'lucide-react';
import { Badge, Card, CardTitle, Notice } from '@/components/ui';
import { MERGE_FIELDS, exampleMergeValues, mergeKeysIn, renderMergeHtml } from '@/lib/merge-fields';

/**
 * 서식 머지 미리보기 — 저장된 본문(과 파일 서식의 새 글자)을 예시 값으로 채워 보여 준다.
 * 지원하지 않는 이름(오타)과, 발송 때 값이 비기 쉬운 필드를 경고한다.
 */
export function MergePreview({
  body,
  pdfTexts,
  purposeLabel,
}: {
  body: string | null;
  /** 파일 서식: 원본 위 새 글자들 */
  pdfTexts?: string[];
  purposeLabel?: string | null;
}) {
  const sample = exampleMergeValues();
  const rendered = renderMergeHtml(body, sample, { highlight: true });
  const pdfKeys = (pdfTexts ?? []).flatMap((t) => mergeKeysIn(t));
  const used = Array.from(new Set([...mergeKeysIn(body), ...pdfKeys]));
  const known = new Set(MERGE_FIELDS.map((f) => f.key));
  const unknown = used.filter((k) => !known.has(k));
  const usedKnown = used.filter((k) => known.has(k));

  return (
    <Card>
      <CardTitle>머지 필드 미리보기</CardTitle>
      <p className="mb-2 mt-0.5 text-[11.5px] leading-relaxed text-ink-400">
        예시 값으로 채운 모습입니다.{purposeLabel ? ` ${purposeLabel} 자동 발송에 쓰입니다.` : ' 자동 발송 용도가 없으면 기관이 보낼 때 채울 수 있는 값(기관명·대표자·발급일·서명자 이름)만 채워집니다.'}
      </p>
      {used.length === 0 ? (
        <p className="text-[12.5px] text-ink-400">이 서식에는 머지 필드가 없습니다.</p>
      ) : (
        <div className="mb-2 flex flex-wrap gap-1">
          {usedKnown.map((k) => <Badge key={k} tone="brand">{k}</Badge>)}
          {unknown.map((k) => <Badge key={k} tone="danger">{k} (지원 안 함)</Badge>)}
        </div>
      )}
      {unknown.length ? (
        <div className="mb-2">
          <Notice tone="danger" title="지원하지 않는 머지 필드가 있습니다">
            {unknown.map((k) => `{{${k}}}`).join(', ')} 은(는) 값으로 바뀌지 않고 그대로 보입니다. 이름을 확인해 주세요.
          </Notice>
        </div>
      ) : null}
      {usedKnown.length ? (
        <p className="mb-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-warning-500">
          <AlertTriangle size={14} strokeWidth={1.7} className="mt-0.5 shrink-0" />
          발송할 때 값이 없는 필드는 빈칸으로 나갑니다(예: 캠페인 없이 한 후원의 {'{{캠페인}}'}). 빈칸이어도 문장이 어색하지 않게 써 주세요.
        </p>
      ) : null}
      {body ? (
        <div
          className="merge-preview max-h-[420px] overflow-auto whitespace-normal break-keep rounded-xl border border-ink-100 bg-white p-3.5 text-[12.5px] leading-relaxed text-ink-800 [&_mark]:rounded [&_mark]:bg-brand-50 [&_mark]:px-0.5 [&_mark[data-merge=missing]]:bg-warning-50 [&_mark[data-merge=unknown]]:bg-danger-50"
          // renderMergeHtml 은 본문과 값을 모두 이스케이프한 뒤 표시용 태그만 넣는다.
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      ) : null}
      {pdfKeys.length ? (
        <p className="mt-2 text-[11.5px] text-ink-500">원본 위 새 글자에서 쓰는 필드: {Array.from(new Set(pdfKeys)).join(', ')} — 발송 때 값으로 채운 새 PDF 를 만듭니다(원본은 그대로).</p>
      ) : null}
    </Card>
  );
}
