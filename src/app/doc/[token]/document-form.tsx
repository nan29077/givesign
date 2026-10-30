'use client';

import * as React from 'react';
import { Download, Eraser, FileText } from 'lucide-react';
import { Button, Card, CardTitle, Notice, cx } from '@/components/ui';
import { submitDocumentAction, type DocumentSubmitState } from '@/app/actions/document-submit';

/**
 * 문서 작성 폼 (후원자 화면).
 *
 * - 서식에 정의된 항목만 그린다. 값 검증은 서버가 다시 한다(화면 규칙만 믿지 않는다).
 * - 서명은 캔버스에 그려 PNG data URL 로 보낸다. 형식·용량은 서버가 다시 판정한다.
 * - 제출은 한 번만 된다. 서버가 DRAFT 상태에서만 확정하므로 두 번 눌러도 한 건이다.
 */

export interface FormField {
  id: string;
  label: string;
  type: string;
  required: boolean;
  hint: string | null;
}

const initial: DocumentSubmitState = { ok: false };

export function DocumentForm({
  token,
  templateType,
  fileUrl,
  fileName,
  requireSignature,
  fields,
}: {
  token: string;
  templateType: string;
  fileUrl: string | null;
  fileName: string | null;
  requireSignature: boolean;
  fields: FormField[];
}) {
  const [state, formAction, pending] = React.useActionState(submitDocumentAction, initial);
  const [signature, setSignature] = React.useState('');

  // 제출이 끝나면 화면을 새로 읽어 "제출 완료" 상태를 보여 준다.
  React.useEffect(() => {
    if (!state.ok) return;
    const t = setTimeout(() => window.location.reload(), 1200);
    return () => clearTimeout(t);
  }, [state.ok]);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="token" value={token} />

      {templateType === 'FILE' && fileUrl ? (
        <Card>
          <CardTitle>서식 내려받기</CardTitle>
          <p className="mb-3 mt-0.5 text-[12.5px] leading-relaxed text-ink-500">
            아래 파일을 내려받아 작성해 주세요. 작성한 파일은 사회복지기관 안내에 따라 전달하시면 됩니다.
          </p>
          <a
            href={`${fileUrl}?name=${encodeURIComponent(fileName ?? '문서서식')}`}
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-ink-900 text-[13.5px] font-bold text-brand-400"
          >
            <Download size={16} strokeWidth={1.7} />
            {fileName ?? '서식 파일 내려받기'}
          </a>
          <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-400">
            <FileText size={13} strokeWidth={1.7} className="mt-0.5 shrink-0" />
            아래 정보를 입력해 제출하시면, 사회복지기관이 누가 서식을 받았는지 확인할 수 있습니다.
          </p>
        </Card>
      ) : null}

      {fields.length > 0 ? (
        <Card>
          <CardTitle>작성 항목</CardTitle>
          <p className="mb-3 mt-0.5 text-[12.5px] leading-relaxed text-ink-500">
            <span className="font-bold text-danger-500">*</span> 표시는 반드시 채워야 하는 항목입니다.
          </p>
          <div className="space-y-3">
            {fields.map((f) => (
              <FieldInput key={f.id} field={f} />
            ))}
          </div>
        </Card>
      ) : null}

      {requireSignature ? (
        <Card>
          <CardTitle>
            자필 서명 <span className="text-danger-500">*</span>
          </CardTitle>
          <p className="mb-2 mt-0.5 text-[12.5px] leading-relaxed text-ink-500">
            아래 칸에 손가락이나 마우스로 서명해 주세요.
          </p>
          <SignaturePad value={signature} onChange={setSignature} />
          <input type="hidden" name="signature" value={signature} />
        </Card>
      ) : null}

      {state.message ? (
        <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice>
      ) : null}

      <Button type="submit" variant="primary" size="lg" disabled={pending || state.ok}>
        {pending ? '제출 중' : state.ok ? '제출됨' : '작성 내용 제출하기'}
      </Button>
    </form>
  );
}

function FieldInput({ field }: { field: FormField }) {
  const name = `f_${field.id}`;
  const base =
    'h-12 w-full rounded-xl border border-ink-200 px-3.5 text-[14px] outline-none transition-colors focus:border-brand-400';

  if (field.type === 'CHECKBOX') {
    return (
      <label className="flex items-start gap-2 rounded-xl border border-ink-200 px-3.5 py-3">
        {/* 체크를 해제하면 값이 오지 않는다. 서버는 값 없음을 "동의 안 함" 으로 읽는다. */}
        <input type="checkbox" name={name} value="on" className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="text-[13px] font-semibold leading-relaxed text-ink-800">
          {field.label}
          {field.required ? <span className="ml-1 text-danger-500">*</span> : null}
          {field.hint ? <span className="block text-[11.5px] font-normal text-ink-400">{field.hint}</span> : null}
        </span>
      </label>
    );
  }

  return (
    <div>
      <p className="mb-1.5 text-[13px] font-bold text-ink-900">
        {field.label}
        {field.required ? <span className="ml-1 text-danger-500">*</span> : null}
      </p>
      {field.type === 'LONGTEXT' ? (
        <textarea
          name={name}
          rows={4}
          maxLength={2000}
          placeholder={field.hint ?? ''}
          className="w-full rounded-xl border border-ink-200 px-3.5 py-2.5 text-[14px] leading-relaxed outline-none transition-colors focus:border-brand-400"
        />
      ) : field.type === 'DATE' ? (
        <input type="date" name={name} className={base} />
      ) : field.type === 'NUMBER' ? (
        <input type="text" name={name} inputMode="numeric" placeholder={field.hint ?? ''} className={cx(base, 'tabular-nums')} />
      ) : field.type === 'PHONE' ? (
        <input
          type="tel"
          name={name}
          inputMode="tel"
          maxLength={20}
          placeholder={field.hint ?? '010-0000-0000'}
          className={cx(base, 'tabular-nums')}
        />
      ) : (
        <input type="text" name={name} maxLength={200} placeholder={field.hint ?? ''} className={base} />
      )}
    </div>
  );
}

/**
 * 서명 캔버스.
 *
 * 그림을 놓을 때마다 PNG data URL 을 만들어 부모에 올린다(hidden input 으로 함께 제출된다).
 * 화면 크기에 맞춰 늘어나므로 devicePixelRatio 를 반영해 흐려지지 않게 한다.
 */
export function SignaturePad({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const drawing = React.useRef(false);
  // 획이 빠르면 pointerup 이 다시 그리기 전에 와서 state 값이 아직 false 다. 판정은 ref 로 한다.
  const dirtyRef = React.useRef(false);
  const [, setDirtyState] = React.useState(false);
  const setDirty = (v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
  };

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#17161a';
    // 투명 배경으로 저장하면 어두운 배경에서 서명이 보이지 않는다. 흰 바탕을 깐다.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
  }, []);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    setDirty(true);
  };

  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    if (!canvas || !dirtyRef.current) return;
    onChange(canvas.toDataURL('image/png'));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    setDirty(false);
    onChange('');
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        className="h-36 w-full touch-none rounded-xl border border-ink-200 bg-white"
        aria-label="서명란"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-ink-400">
          {value ? '서명이 입력되었습니다.' : '아직 서명하지 않았습니다.'}
        </span>
        <button
          type="button"
          onClick={clear}
          className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1 text-[11.5px] font-bold text-ink-500 hover:bg-ink-50"
        >
          <Eraser size={12} strokeWidth={1.8} /> 다시 그리기
        </button>
      </div>
    </div>
  );
}
