'use client';

import * as React from 'react';
import { Plus, Trash2, UserRound } from 'lucide-react';
import { Field, Input, Select, Textarea } from '@/components/ui';

/**
 * 서명 요청 작성 폼의 입력부(서식 · 서명자 · 순서 · 기한).
 * 서버 액션 폼(ActionForm) 안에 넣어 쓴다. 서식을 바꾸면 그 서식의 기본 서명자 역할로 칸을 다시 채운다.
 */

export type RoleKey = 'DONOR' | 'GUARDIAN' | 'VOLUNTEER' | 'PARTICIPANT' | 'STAFF' | 'OTHER';

export interface ComposeTemplate {
  id: string;
  name: string;
  description: string | null;
  signers: Array<{ role: RoleKey; label: string }>;
  fieldCount: number;
}

const ROLE_OPTIONS: Array<{ value: RoleKey; label: string }> = [
  { value: 'DONOR', label: '후원자' },
  { value: 'VOLUNTEER', label: '자원봉사자' },
  { value: 'PARTICIPANT', label: '이용자' },
  { value: 'GUARDIAN', label: '보호자(법정대리인)' },
  { value: 'STAFF', label: '기관 담당자' },
  { value: 'OTHER', label: '기타' },
];

interface Row {
  key: number;
  role: RoleKey;
  label: string;
}

let seq = 0;
const rowsFor = (t: ComposeTemplate | undefined): Row[] =>
  (t?.signers.length ? t.signers : [{ role: 'DONOR' as RoleKey, label: '서명자' }]).map((s) => ({ key: ++seq, role: s.role, label: s.label }));

export function EDocComposeFields({ templates, defaultTemplateId, maxSigners }: { templates: ComposeTemplate[]; defaultTemplateId?: string; maxSigners: number }) {
  const [templateId, setTemplateId] = React.useState(defaultTemplateId && templates.some((t) => t.id === defaultTemplateId) ? defaultTemplateId : templates[0]?.id ?? '');
  const template = templates.find((t) => t.id === templateId);
  const [rows, setRows] = React.useState<Row[]>(() => rowsFor(template));
  const [order, setOrder] = React.useState<'PARALLEL' | 'SEQUENTIAL'>('PARALLEL');

  function pick(id: string) {
    setTemplateId(id);
    setRows(rowsFor(templates.find((t) => t.id === id)));
  }

  return (
    <div className="space-y-5">
      <Field label="서식" required hint={template?.description ?? undefined}>
        <Select name="templateId" value={templateId} onChange={(e) => pick(e.target.value)} required>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="문서 제목" hint="비워 두면 서식 이름을 씁니다. 문자에 함께 나갑니다.">
          <Input name="title" maxLength={60} placeholder={template?.name ?? ''} />
        </Field>
        <Field label="서명 기한">
          <Select name="expiresDays" defaultValue="14">
            <option value="3">3일</option>
            <option value="7">7일</option>
            <option value="14">14일</option>
            <option value="30">30일</option>
          </Select>
        </Field>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[13px] font-semibold text-ink-700">
            서명자 <span className="text-accent-500">*</span>
            <span className="ml-1.5 font-normal text-ink-400">첫 번째 서명자가 입력 항목을 작성하고, 나머지는 내용을 확인하고 서명합니다.</span>
          </p>
        </div>
        <ol className="space-y-2.5">
          {rows.map((r, i) => (
            <li key={r.key} className="rounded-2xl border border-ink-100 bg-ink-50/50 p-3">
              <div className="mb-2 flex items-center gap-2 text-[12.5px] font-bold text-ink-600">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-[11.5px] tabular-nums text-ink-700 ring-1 ring-ink-200">{i + 1}</span>
                <UserRound size={16} strokeWidth={1.7} className="text-ink-400" />
                {r.label}
                {i === 0 ? <span className="rounded-md bg-brand-100 px-1.5 py-0.5 text-[10.5px] text-brand-800">작성자</span> : null}
                {rows.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                    className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-ink-400 hover:bg-white hover:text-danger-500"
                    aria-label={`${i + 1}번째 서명자 빼기`}
                  >
                    <Trash2 size={16} strokeWidth={1.7} />
                  </button>
                ) : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-[176px_1fr_1fr]">
                <Select name={`signer_${i}_role`} value={r.role} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, role: e.target.value as RoleKey } : x)))} aria-label="역할">
                  {ROLE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <Input name={`signer_${i}_name`} placeholder="이름" maxLength={30} required aria-label="이름" />
                <Input name={`signer_${i}_phone`} type="tel" inputMode="tel" placeholder="010-1234-5678" required aria-label="휴대폰" />
              </div>
            </li>
          ))}
        </ol>
        {rows.length < maxSigners ? (
          <button
            type="button"
            onClick={() => setRows([...rows, { key: ++seq, role: 'OTHER', label: '서명자' }])}
            className="mt-2.5 inline-flex items-center gap-1.5 rounded-xl border border-dashed border-ink-200 px-3 py-2 text-[12.5px] font-bold text-ink-600 hover:bg-ink-50"
          >
            <Plus size={16} strokeWidth={1.7} /> 서명자 추가
          </button>
        ) : null}
      </div>

      {rows.length > 1 ? (
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-semibold text-ink-700">서명 순서</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { v: 'PARALLEL' as const, t: '동시 서명', d: '모두에게 바로 보냅니다. 첫 번째 서명자가 작성한 뒤 나머지가 서명합니다.' },
              { v: 'SEQUENTIAL' as const, t: '순서대로 서명', d: '앞사람이 서명하면 다음 사람에게 링크가 갑니다.' },
            ].map((o) => (
              <label key={o.v} className={`cursor-pointer rounded-2xl border p-3 ${order === o.v ? 'border-brand-400 bg-brand-50' : 'border-ink-100 bg-white'}`}>
                <input type="radio" name="signingOrder" value={o.v} checked={order === o.v} onChange={() => setOrder(o.v)} className="sr-only" />
                <span className="block text-[13.5px] font-bold text-ink-900">{o.t}</span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-500">{o.d}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <input type="hidden" name="signingOrder" value="PARALLEL" />
      )}

      <Field label="안내 문구" hint="서명 화면 위쪽에 보입니다. (문자에는 들어가지 않습니다)">
        <Textarea name="message" rows={2} maxLength={300} placeholder="예: 2027년 후원 약정 갱신을 위해 서명 부탁드립니다." />
      </Field>
    </div>
  );
}
