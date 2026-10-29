'use client';

import * as React from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { revealDocumentSubmissionAction } from '@/app/actions/studio-documents';

export interface RevealFieldMeta {
  id: string;
  label: string;
  /** 체크 항목은 Y/N 으로 저장되므로 화면에서 말로 바꿔 준다. */
  isCheckbox: boolean;
}

/**
 * 제출 문서 원문 보기.
 *
 * 목록·상세를 열기만 해도 성명·연락처·입력값이 평문으로 뜨면 어깨너머 노출과 화면 캡처만으로
 * 개인정보가 새어 나간다. 배송지 열람(AddressReveal)과 같은 기준으로, 실제로 확인할 때만
 * 눌러서 열고 그 순간이 감사로그에 남는다.
 */
export function DocumentReveal({
  submissionId,
  fields,
  payerNameMasked,
  payerPhoneMasked,
}: {
  submissionId: string;
  fields: RevealFieldMeta[];
  payerNameMasked: string | null;
  payerPhoneMasked: string | null;
}) {
  const [full, setFull] = React.useState<{
    payerName: string | null;
    payerPhone: string | null;
    values: Record<string, string>;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await revealDocumentSubmissionAction(submissionId);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setFull({
        payerName: res.payerName,
        payerPhone: res.payerPhone,
        values: Object.fromEntries(res.values.map((v) => [v.id, v.value])),
      });
    } catch {
      setError('제출 내용을 여는 중 오류가 발생했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const shown = (field: RevealFieldMeta): string => {
    if (!full) return '••••••';
    const raw = full.values[field.id] ?? '';
    if (field.isCheckbox) return raw === 'Y' ? '동의함' : '동의하지 않음';
    return raw || '(비어 있음)';
  };

  const copy = async () => {
    if (!full) return;
    const lines = [
      `제출자\t${full.payerName ?? ''}`,
      `연락처\t${full.payerPhone ?? ''}`,
      ...fields.map((f) => `${f.label}\t${shown(f)}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('복사에 실패했습니다. 직접 선택해 복사해 주세요.');
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[13px] font-bold text-ink-900">제출 내용</p>
        {full ? (
          <button
            type="button"
            onClick={copy}
            className="rounded-lg border border-ink-200 px-2.5 py-1 text-[11.5px] font-bold text-ink-600 hover:bg-ink-50"
          >
            {copied ? '복사됨' : '전체 복사'}
          </button>
        ) : (
          <button
            type="button"
            onClick={reveal}
            disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1 text-[11.5px] font-bold text-ink-600 hover:bg-ink-50 disabled:opacity-60"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} strokeWidth={1.9} />}
            {busy ? '여는 중' : '내용 보기'}
          </button>
        )}
      </div>

      <div className="rounded-xl border border-ink-100">
        <Row label="제출자" value={full ? (full.payerName ?? '-') : (payerNameMasked ?? '-')} />
        <Row
          label="연락처"
          value={full ? (full.payerPhone ?? '-') : (payerPhoneMasked ?? '-')}
          mono
        />
        {fields.map((f) => (
          <Row key={f.id} label={f.label} value={shown(f)} />
        ))}
      </div>

      {!full ? (
        <p className="mt-1.5 text-[11px] text-ink-300">가려진 값입니다. 열람 기록이 남습니다.</p>
      ) : null}
      {error ? <p className="mt-1.5 text-[11.5px] text-danger-500">{error}</p> : null}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-ink-100 px-3.5 py-2.5 last:border-0">
      <span className="shrink-0 text-[12.5px] text-ink-400">{label}</span>
      <span
        className={
          mono
            ? 'whitespace-pre-wrap break-words text-right text-[12.5px] font-semibold tabular-nums text-ink-900'
            : 'whitespace-pre-wrap break-words text-right text-[12.5px] font-semibold text-ink-900'
        }
      >
        {value}
      </span>
    </div>
  );
}
