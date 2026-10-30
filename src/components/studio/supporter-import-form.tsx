'use client';

import * as React from 'react';
import { Badge, Button, Checkbox, Field, Input, Notice } from '@/components/ui';
import { supporterImportAction, type ImportActionState } from '@/app/actions/automation';

const initial: ImportActionState = { ok: false };

/**
 * 기관 보유 명단(CSV) 업로드.
 * 1) 파일을 골라 [미리보기] — 새로 등록 / 중복 / 오류를 줄마다 보여 준다.
 * 2) 동의 확인 체크 + 근거를 적고 [등록] — 같은 파일을 다시 보낸다(서버에 파일을 임시 보관하지 않는다).
 */
export function SupporterImportForm() {
  const [state, action, pending] = React.useActionState(supporterImportAction, initial);
  const [intent, setIntent] = React.useState<'preview' | 'commit'>('preview');
  return (
    <form action={action} className="space-y-3.5">
      <input type="hidden" name="intent" value={intent} />
      <Field label="CSV 파일" hint="열 순서: 이름, 휴대폰, 구분(후원자·봉사자·기타), 태그(; 로 구분), 메모. 첫 줄 머리글은 있어도 없어도 됩니다. 최대 2,000행.">
        <Input type="file" name="file" accept=".csv,text/csv" required className="pt-2.5" />
      </Field>
      <Checkbox
        name="consentConfirmed"
        label="이 명단은 기관이 연락처 수집·이용 동의를 받은 분들입니다."
        description="동의 없이 모은 연락처를 올리면 개인정보 보호법 위반 책임은 기관에 있습니다. 올린 명단은 광고 문자 발송에 쓰지 않습니다."
      />
      <Field label="동의를 받은 근거" hint="예: 2025 후원의 밤 참가 신청서, 자원봉사 모집 신청서(2025.3)">
        <Input name="consentBasis" maxLength={200} placeholder="동의 근거" />
      </Field>

      {state.message ? <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice> : null}

      {state.preview ? (
        <div className="max-h-72 overflow-auto rounded-xl border border-ink-100">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-ink-50 text-left text-ink-500">
              <tr>
                <th className="px-3 py-2">줄</th>
                <th className="px-3 py-2">이름</th>
                <th className="px-3 py-2">휴대폰</th>
                <th className="px-3 py-2">구분</th>
                <th className="px-3 py-2">결과</th>
              </tr>
            </thead>
            <tbody>
              {state.preview.rows.slice(0, 200).map((r) => (
                <tr key={r.line} className="border-t border-ink-100">
                  <td className="px-3 py-1.5 tabular-nums text-ink-400">{r.line}</td>
                  <td className="px-3 py-1.5 font-semibold">{r.name || '-'}</td>
                  <td className="px-3 py-1.5 font-mono">{r.phoneMasked || '-'}</td>
                  <td className="px-3 py-1.5">{{ DONOR: '후원자', VOLUNTEER: '봉사자', OTHER: '기타' }[r.role] ?? r.role}</td>
                  <td className="px-3 py-1.5">
                    {r.status === 'NEW' ? <Badge tone="success">등록</Badge> : r.status === 'DUPLICATE' ? <Badge tone="neutral">중복</Badge> : <Badge tone="danger">{r.error}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.preview.truncated ? <p className="p-3 text-[12px] text-warning-500">2,000행을 넘는 부분은 읽지 않았습니다. 파일을 나눠 올려 주세요.</p> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" disabled={pending} onClick={() => setIntent('preview')}>
          {pending && intent === 'preview' ? '읽는 중' : '미리보기'}
        </Button>
        <Button type="submit" disabled={pending} onClick={() => setIntent('commit')}>
          {pending && intent === 'commit' ? '등록 중' : '명단 등록'}
        </Button>
      </div>
    </form>
  );
}
