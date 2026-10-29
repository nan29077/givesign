'use client';

import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { cx } from '@/components/ui';

/**
 * 실물 상품 옵션 편집기.
 *
 * 옵션 종류(사이즈·색상)마다 값 목록을 두고, 값마다 추가금과 품절 여부를 정한다.
 * 결과는 hidden input 하나에 JSON 으로 담아 보낸다(서버가 parseOptionsJson 으로 읽는다).
 *
 * 값별 수량 재고는 두지 않는다. 결제 승인 시점에 JSON 안의 숫자를 트랜잭션으로 깎아야 하는데
 * 그 경로가 이중결제 방어와 얽혀 있어 위험하다. 대신 값 하나만 막는 품절 스위치를 둔다.
 */

export interface EditorOptionValue {
  label: string;
  addPrice: string;
  soldOut: boolean;
}

export interface EditorOption {
  name: string;
  values: EditorOptionValue[];
}

const emptyValue = (): EditorOptionValue => ({ label: '', addPrice: '0', soldOut: false });

export function OptionEditor({
  name,
  defaultValue = [],
  maxGroups = 3,
  maxValues = 30,
}: {
  name: string;
  defaultValue?: EditorOption[];
  maxGroups?: number;
  maxValues?: number;
}) {
  const [groups, setGroups] = React.useState<EditorOption[]>(defaultValue);

  // 빈 값(이름 없는 옵션·라벨 없는 값)은 서버로 보내지 않는다.
  const payload = React.useMemo(() => {
    const clean = groups
      .map((g) => ({
        name: g.name.trim(),
        values: g.values
          .filter((v) => v.label.trim())
          .map((v) => ({
            label: v.label.trim(),
            addPrice: (v.addPrice || '0').replace(/[^\d]/g, '') || '0',
            soldOut: v.soldOut,
          })),
      }))
      .filter((g) => g.name && g.values.length > 0);
    return clean.length > 0 ? JSON.stringify(clean) : '';
  }, [groups]);

  const patch = (gi: number, fn: (g: EditorOption) => EditorOption) =>
    setGroups((prev) => prev.map((g, i) => (i === gi ? fn(g) : g)));

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[13px] font-bold text-ink-900">옵션</p>
        <button
          type="button"
          onClick={() => setGroups((prev) => (prev.length >= maxGroups ? prev : [...prev, { name: '', values: [emptyValue()] }]))}
          disabled={groups.length >= maxGroups}
          className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-[12px] font-bold text-ink-700 hover:bg-ink-50 disabled:opacity-50"
        >
          <Plus size={13} strokeWidth={1.6} /> 옵션 추가
        </button>
      </div>

      <p className="mb-2 text-[11.5px] leading-relaxed text-ink-400">
        옵션 종류는 최대 {maxGroups}개, 종류당 값은 최대 {maxValues}개까지 넣을 수 있습니다. 추가금은 상품 1개 가격에
        더해지고, 품절로 표시한 값은 후원자가 고를 수 없습니다.
      </p>

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ink-200 px-3.5 py-3 text-[12.5px] text-ink-400">
          옵션이 없습니다. 색상·사이즈처럼 고르게 할 항목이 있으면 [옵션 추가] 를 눌러 주세요.
        </p>
      ) : null}

      <div className="space-y-3">
        {groups.map((g, gi) => (
          <div key={gi} className="rounded-2xl border border-ink-100 p-3">
            <div className="flex items-center gap-2">
              <input
                value={g.name}
                onChange={(e) => patch(gi, (prev) => ({ ...prev, name: e.target.value.slice(0, 20) }))}
                placeholder="옵션 이름 (예: 사이즈)"
                className="h-10 flex-1 rounded-xl border border-ink-200 px-3 text-[13.5px] font-semibold outline-none focus:border-brand-400"
              />
              <button
                type="button"
                aria-label="옵션 종류 삭제"
                onClick={() => setGroups((prev) => prev.filter((_, i) => i !== gi))}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-ink-200 text-ink-400 hover:text-danger-500"
              >
                <X size={15} strokeWidth={1.8} />
              </button>
            </div>

            <ul className="mt-2 space-y-1.5">
              {g.values.map((v, vi) => (
                <li key={vi} className="flex flex-wrap items-center gap-1.5">
                  <input
                    value={v.label}
                    onChange={(e) =>
                      patch(gi, (prev) => ({
                        ...prev,
                        values: prev.values.map((x, i) => (i === vi ? { ...x, label: e.target.value.slice(0, 30) } : x)),
                      }))
                    }
                    placeholder="값 (예: L)"
                    className="h-10 min-w-0 flex-1 rounded-xl border border-ink-200 px-3 text-[13.5px] outline-none focus:border-brand-400"
                  />
                  <div className="flex h-10 items-center gap-1 rounded-xl border border-ink-200 px-2.5">
                    <span className="text-[11.5px] font-semibold text-ink-400">추가금</span>
                    <input
                      value={v.addPrice}
                      inputMode="numeric"
                      onChange={(e) =>
                        patch(gi, (prev) => ({
                          ...prev,
                          values: prev.values.map((x, i) =>
                            i === vi ? { ...x, addPrice: e.target.value.replace(/[^\d]/g, '') } : x,
                          ),
                        }))
                      }
                      className="w-16 bg-transparent text-right text-[13.5px] tabular-nums outline-none"
                    />
                    <span className="text-[11.5px] font-semibold text-ink-400">원</span>
                  </div>
                  <label
                    className={cx(
                      'flex h-10 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 text-[12px] font-bold',
                      v.soldOut ? 'border-danger-500/40 bg-danger-50 text-danger-500' : 'border-ink-200 text-ink-500',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={v.soldOut}
                      onChange={(e) =>
                        patch(gi, (prev) => ({
                          ...prev,
                          values: prev.values.map((x, i) => (i === vi ? { ...x, soldOut: e.target.checked } : x)),
                        }))
                      }
                      className="h-3.5 w-3.5"
                    />
                    품절
                  </label>
                  <button
                    type="button"
                    aria-label="옵션값 삭제"
                    onClick={() =>
                      patch(gi, (prev) => ({ ...prev, values: prev.values.filter((_, i) => i !== vi) }))
                    }
                    className="grid h-10 w-9 shrink-0 place-items-center rounded-xl text-ink-300 hover:text-danger-500"
                  >
                    <X size={14} strokeWidth={1.8} />
                  </button>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() =>
                patch(gi, (prev) => ({
                  ...prev,
                  values: prev.values.length >= maxValues ? prev.values : [...prev.values, emptyValue()],
                }))
              }
              disabled={g.values.length >= maxValues}
              className="mt-2 flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-bold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
            >
              <Plus size={13} strokeWidth={1.6} /> 값 추가
            </button>
          </div>
        ))}
      </div>

      <input type="hidden" name={name} value={payload} />
    </div>
  );
}
