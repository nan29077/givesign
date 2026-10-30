'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { ImageUploadField } from './image-upload-field';

export function PresetImagePicker({ name, label, value, presets, hint }: { name: string; label: string; value: string; presets: { label: string; url: string }[]; hint?: string }) {
  const presetMatch = presets.some(p => p.url === value);
  const [selection, setSelection] = useState(presetMatch ? value : 'custom');
  const fieldset = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    // React server actions reset form controls after submission. Keep the saved
    // controlled choice as the native radio reset target too.
    fieldset.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(input => { input.defaultChecked = input.checked; });
  }, [selection]);
  return <fieldset ref={fieldset} className="space-y-3"><legend className="text-[14px] font-extrabold text-ink-900">{label}</legend>
    <p className="text-[12.5px] leading-6 text-ink-500">{hint || '처음에는 5종 중 하나가 무작위로 배정됩니다. 선택하거나 직접 업로드하면 해당 이미지를 계속 사용합니다.'}</p>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">{presets.map((p, i) => <label key={p.url} className={`cursor-pointer overflow-hidden rounded-xl border-2 transition ${selection === p.url ? 'border-brand-700 bg-brand-50 ring-2 ring-brand-100' : 'border-ink-100 bg-white'}`}>
      <Image unoptimized src={p.url} width={300} height={180} alt={p.label} className="aspect-[5/3] w-full object-cover" />
      <span className="flex items-center gap-2 p-2 text-xs font-bold"><input type="radio" name={`${name}Choice`} checked={selection === p.url} onChange={() => setSelection(p.url)} value={p.url} />{i + 1}. {p.label}</span>
    </label>)}</div>
    <label className="flex items-center gap-2 text-sm font-bold"><input type="radio" name={`${name}Choice`} value="custom" checked={selection === 'custom'} onChange={() => setSelection('custom')} />기관 이미지 직접 적용</label>
    {selection === 'custom' ? <ImageUploadField key={`${name}-custom`} name={name} label="직접 업로드 또는 이미지 주소" defaultValue={presetMatch ? '' : value} /> : <input type="hidden" name={name} value={selection} />}
  </fieldset>;
}
