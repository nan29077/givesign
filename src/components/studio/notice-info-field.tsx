'use client';

import * as React from 'react';
import { cx } from '@/components/ui';

/**
 * 전자상거래 상품정보 제공 고시 입력.
 *
 * 품목을 고르면 그 품목의 필수 항목이 자동으로 깔린다. 라벨/값을 쌍으로 보내고
 * 서버가 formData.getAll('noticeLabel') / getAll('noticeValue') 로 순서를 맞춰 읽는다.
 */
export function NoticeInfoField({
  categories,
  defaultCategory,
  defaultValues = {},
}: {
  categories: ReadonlyArray<{ key: string; label: string; items: readonly string[] }>;
  defaultCategory?: string;
  /** 라벨 -> 저장된 값 */
  defaultValues?: Record<string, string>;
}) {
  const [category, setCategory] = React.useState(defaultCategory ?? categories[0].key);
  const current = categories.find((c) => c.key === category) ?? categories[0];

  // 품목을 바꿔도 이미 적어 둔 값은 라벨이 같으면 그대로 살린다.
  const [values, setValues] = React.useState<Record<string, string>>(defaultValues);
  const filled = current.items.filter((label) => (values[label] ?? '').trim()).length;

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-bold text-ink-900">상품정보 제공 고시</p>
        <span
          className={cx(
            'text-[11.5px] font-bold',
            filled === current.items.length ? 'text-success-500' : 'text-warning-500',
          )}
        >
          {filled}/{current.items.length} 항목 작성
        </span>
      </div>
      <p className="mb-2 text-[11.5px] leading-relaxed text-ink-400">
        전자상거래법상 실물 상품에 표시해야 하는 정보입니다. 해당하는 품목이 없으면 &ldquo;기타 재화&rdquo;를 고르세요.
        비워 두면 저장은 되지만 결제 화면에 표시되지 않습니다.
      </p>

      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        className="h-11 w-full rounded-xl border border-ink-200 bg-white px-3 text-[14px] outline-none focus:border-brand-400"
        aria-label="고시 품목"
      >
        {categories.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      <input type="hidden" name="noticeCategory" value={category} />

      <ul className="mt-2 space-y-1.5">
        {current.items.map((label) => (
          <li key={label} className="flex flex-wrap items-center gap-1.5">
            <span className="w-full shrink-0 text-[12px] font-semibold text-ink-600 sm:w-44">{label}</span>
            <input type="hidden" name="noticeLabel" value={label} />
            <input
              name="noticeValue"
              value={values[label] ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [label]: e.target.value.slice(0, 200) }))}
              placeholder="상세 또는 상품 이미지 참조"
              className="h-10 min-w-0 flex-1 rounded-xl border border-ink-200 px-3 text-[13.5px] outline-none focus:border-brand-400"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
