'use client';

import * as React from 'react';
import { CircleCheck, FileDown, Loader2, Save, TriangleAlert, X } from 'lucide-react';
import { Button, cx } from '@/components/ui';
import { PdfFormEditor } from '@/components/studio/pdf-form-editor';
import { saveDocumentPdfLayoutAction } from '@/app/actions/studio-documents';
import { coverOnlyNotice, type PdfFontInfo, type PdfLayout } from '@/lib/pdf-form';

/**
 * 넓은 화면 원본 편집(/studio/documents/[id]/edit). 편집 내용만 따로 저장한다.
 * 서식 화면 안의 편집기와 같은 편집기를 쓰고, 저장 버튼과 결과 안내만 붙인다.
 */
export function PdfFormEditorPage({
  templateId,
  templateName,
  basePdfUrl,
  renderedPdfUrl,
  initialLayout,
  fonts,
  convertedFrom,
}: {
  templateId: string;
  templateName: string;
  basePdfUrl: string;
  renderedPdfUrl: string | null;
  initialLayout: PdfLayout;
  fonts: PdfFontInfo[];
  convertedFrom: string | null;
}) {
  const [layout, setLayout] = React.useState(initialLayout);
  const [savedJson, setSavedJson] = React.useState(() => JSON.stringify(initialLayout));
  const [resultUrl, setResultUrl] = React.useState(renderedPdfUrl);
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const dirty = JSON.stringify(layout) !== savedJson;
  // 저장 직전에 입력 중인 칸이 확정되면 기록이 바뀐다. 비동기 저장에서 최신 기록을 읽기 위한 참조.
  const layoutRef = React.useRef(layout);
  React.useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  React.useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = async () => {
    // 입력 중인 칸이 있으면 먼저 확정시킨다(포커스를 빼면 편집기가 확정한다).
    (document.activeElement as HTMLElement | null)?.blur();
    await new Promise((r) => setTimeout(r, 0));
    setSaving(true);
    setNotice(null);
    try {
      const res = await saveDocumentPdfLayoutAction(templateId, JSON.stringify(layoutRef.current));
      if (!res.ok) {
        setNotice({ tone: 'error', text: res.message });
        return;
      }
      setSavedJson(JSON.stringify(layoutRef.current));
      setResultUrl(res.renderedPdfUrl);
      const fallback = res.report.filter((r) => r.tier === 'FALLBACK').length;
      const coverOnly = coverOnlyNotice(res.coverOnlyPages);
      setNotice({
        tone: 'ok',
        text: res.unchanged
          ? '저장된 내용과 같아 결과 파일을 그대로 둡니다.'
          : res.edits === 0
            ? '원본 그대로 쓰도록 저장했습니다.'
            : `저장했습니다. 수정 ${res.edits}곳` +
              (res.stripped ? ` · 덮은 자리의 원래 글자 ${res.stripped}자를 지웠습니다` : '') +
              (fallback ? ` · ${fallback}곳은 원본 글꼴에 없는 글자가 있어 같은 계열 글꼴을 썼습니다.` : ' · 모두 원본 글꼴로 들어갔습니다.') +
              (coverOnly ? ` ${coverOnly}` : ''),
      });
    } catch {
      setNotice({ tone: 'error', text: '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {notice ? (
        <div
          className={cx(
            'mb-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12.5px] leading-relaxed',
            notice.tone === 'ok' ? 'bg-brand-50 text-brand-900' : 'bg-danger-50 text-danger-500',
          )}
        >
          {notice.tone === 'ok' ? <CircleCheck size={16} strokeWidth={1.7} className="mt-0.5 shrink-0" /> : <TriangleAlert size={16} strokeWidth={1.7} className="mt-0.5 shrink-0" />}
          <span className="flex-1">{notice.text}</span>
          {notice.tone === 'ok' && resultUrl ? (
            <a href={`${resultUrl}?name=${encodeURIComponent(`${templateName}.pdf`)}`} className="flex shrink-0 items-center gap-1 font-bold underline">
              <FileDown size={14} strokeWidth={1.7} /> 고친 서식
            </a>
          ) : null}
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 opacity-60 hover:opacity-100" aria-label="닫기">
            <X size={14} />
          </button>
        </div>
      ) : null}
      <PdfFormEditor
        source={{ templateId }}
        basePdfUrl={basePdfUrl}
        initialResultUrl={renderedPdfUrl}
        fonts={fonts}
        convertedFrom={convertedFrom}
        layout={layout}
        onLayoutChange={setLayout}
        downloadName={templateName}
        toolbarEnd={
          <>
            <span className="hidden sm:inline">{dirty ? '저장하지 않은 수정' : '저장됨'}</span>
            <Button type="button" size="sm" onClick={save} disabled={saving || !dirty}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} strokeWidth={1.7} />}
              <span className="ml-1">저장</span>
            </Button>
          </>
        }
      />
    </>
  );
}
