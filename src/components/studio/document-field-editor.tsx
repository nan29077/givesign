'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { cx } from '@/components/ui';

/**
 * 문서 서식 입력 항목 편집기.
 *
 * 후원자가 작성 화면에서 채우는 빈칸을 만든다. 결과는 hidden input 하나에 JSON 으로
 * 담아 보낸다(서버가 parseDocumentFieldsJson 으로 읽고 다시 검증한다).
 *
 * 항목 id 는 화면에서 만들지 않는다. 라벨을 고칠 때마다 id 가 바뀌면 이미 제출된
 * 문서의 값과 새 항목이 어긋나기 때문에, id 는 서버가 한 번 정해 그대로 쓴다
 * (기존 항목은 아래 hidden 으로 원래 id 를 그대로 다시 올려 보낸다).
 */

export interface EditorField {
  /** 기존 항목이면 저장된 id. 새로 만든 항목은 빈 값(서버가 라벨로 만든다). */
  id: string;
  label: string;
  type: string;
  required: boolean;
  hint: string;
}

const TYPE_OPTIONS = [
  { value: 'TEXT', label: '한 줄 텍스트' },
  { value: 'LONGTEXT', label: '여러 줄 텍스트' },
  { value: 'DATE', label: '날짜' },
  { value: 'NUMBER', label: '숫자' },
  { value: 'PHONE', label: '연락처' },
  { value: 'CHECKBOX', label: '동의 체크' },
] as const;

/** 자주 쓰는 항목. 하나씩 만드는 수고를 덜어 준다. */
const QUICK_FIELDS: EditorField[] = [
  { id: '', label: '성명', type: 'TEXT', required: true, hint: '' },
  { id: '', label: '연락처', type: 'PHONE', required: true, hint: '' },
  { id: '', label: '주소', type: 'TEXT', required: false, hint: '' },
  { id: '', label: '생년월일', type: 'DATE', required: false, hint: '' },
  { id: '', label: '요청 사항', type: 'LONGTEXT', required: false, hint: '' },
  { id: '', label: '개인정보 수집·이용에 동의합니다', type: 'CHECKBOX', required: true, hint: '' },
];

const emptyField = (): EditorField => ({ id: '', label: '', type: 'TEXT', required: true, hint: '' });

export function DocumentFieldEditor({
  name,
  defaultValue = [],
  max = 30,
}: {
  name: string;
  defaultValue?: EditorField[];
  max?: number;
}) {
  const [fields, setFields] = React.useState<EditorField[]>(defaultValue);

  // 라벨이 빈 항목은 서버로 보내지 않는다(저장해도 후원자 화면에 그릴 수 없다).
  const payload = React.useMemo(() => {
    const clean = fields
      .map((f) => ({
        id: f.id.trim(),
        label: f.label.trim(),
        type: f.type,
        required: f.required,
        hint: f.hint.trim() || null,
      }))
      .filter((f) => f.label.length > 0);
    return clean.length > 0 ? JSON.stringify(clean) : '';
  }, [fields]);

  const patch = (index: number, fn: (f: EditorField) => EditorField) =>
    setFields((prev) => prev.map((f, i) => (i === index ? fn(f) : f)));

  const move = (index: number, dir: -1 | 1) =>
    setFields((prev) => {
      const next = [...prev];
      const to = index + dir;
      if (to < 0 || to >= next.length) return prev;
      [next[index], next[to]] = [next[to]!, next[index]!];
      return next;
    });

  const add = (field: EditorField) =>
    setFields((prev) => (prev.length >= max ? prev : [...prev, field]));

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[13px] font-bold text-ink-900">입력 항목</p>
        <button
          type="button"
          onClick={() => add(emptyField())}
          disabled={fields.length >= max}
          className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-[12px] font-bold text-ink-700 hover:bg-ink-50 disabled:opacity-50"
        >
          <Plus size={13} strokeWidth={1.6} /> 항목 추가
        </button>
      </div>

      <p className="mb-2 text-[11.5px] leading-relaxed text-ink-400">
        후원자가 작성 화면에서 채우는 빈칸입니다. 최대 {max}개까지 만들 수 있고, 위/아래 버튼으로 순서를 바꿉니다.
        필수로 지정한 항목은 비워 두고 제출할 수 없습니다.
      </p>

      <div className="mb-2.5 flex flex-wrap gap-1.5">
        {QUICK_FIELDS.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => add({ ...q })}
            disabled={fields.length >= max || fields.some((f) => f.label.trim() === q.label)}
            className="rounded-lg border border-ink-200 px-2.5 py-1 text-[11.5px] font-bold text-ink-500 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-40"
          >
            + {q.label.length > 12 ? `${q.label.slice(0, 12)}…` : q.label}
          </button>
        ))}
      </div>

      {fields.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ink-200 px-3.5 py-3 text-[12.5px] text-ink-400">
          항목이 없습니다. 위의 빠른 추가 버튼이나 [항목 추가] 로 만들어 주세요.
        </p>
      ) : null}

      <ul className="space-y-2">
        {fields.map((f, i) => (
          <li key={i} className="rounded-2xl border border-ink-100 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                value={f.label}
                onChange={(e) => patch(i, (prev) => ({ ...prev, label: e.target.value.slice(0, 60) }))}
                placeholder="항목 이름 (예: 성명)"
                className="h-10 min-w-0 flex-1 rounded-xl border border-ink-200 px-3 text-[13.5px] font-semibold outline-none focus:border-brand-400"
              />
              <select
                value={f.type}
                onChange={(e) => patch(i, (prev) => ({ ...prev, type: e.target.value }))}
                className="h-10 rounded-xl border border-ink-200 bg-white px-2.5 text-[12.5px] font-semibold outline-none focus:border-brand-400"
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <label
                className={cx(
                  'flex h-10 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 text-[12px] font-bold',
                  f.required ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-ink-200 text-ink-400',
                )}
              >
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => patch(i, (prev) => ({ ...prev, required: e.target.checked }))}
                  className="h-3.5 w-3.5"
                />
                필수
              </label>
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  aria-label="위로"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  className="grid h-[18px] w-8 place-items-center rounded-md text-ink-300 hover:text-ink-700 disabled:opacity-30"
                >
                  <ArrowUp size={13} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  aria-label="아래로"
                  onClick={() => move(i, 1)}
                  disabled={i === fields.length - 1}
                  className="grid h-[18px] w-8 place-items-center rounded-md text-ink-300 hover:text-ink-700 disabled:opacity-30"
                >
                  <ArrowDown size={13} strokeWidth={1.8} />
                </button>
              </div>
              <button
                type="button"
                aria-label="항목 삭제"
                onClick={() => setFields((prev) => prev.filter((_, x) => x !== i))}
                className="grid h-10 w-9 shrink-0 place-items-center rounded-xl text-ink-300 hover:text-danger-500"
              >
                <X size={15} strokeWidth={1.8} />
              </button>
            </div>

            <input
              value={f.hint}
              onChange={(e) => patch(i, (prev) => ({ ...prev, hint: e.target.value.slice(0, 80) }))}
              placeholder="입력 도움말 (선택) — 예: 주민등록상 성명"
              className="mt-1.5 h-9 w-full rounded-xl border border-ink-200 px-3 text-[12.5px] outline-none focus:border-brand-400"
            />

            {f.id ? (
              <p className="mt-1 font-mono text-[10.5px] text-ink-300">항목 코드 {f.id}</p>
            ) : null}
          </li>
        ))}
      </ul>

      <input type="hidden" name={name} value={payload} />
    </div>
  );
}
