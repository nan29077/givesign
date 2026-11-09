'use client';

import * as React from 'react';
import { Check, CheckCheck, Loader2, ScanSearch, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { Card, CardTitle, cx } from '@/components/ui';
import type { PdfLayout } from '@/lib/pdf-form';
import { detectFieldCandidates, type DetectPage, type DetectSkipped, type FieldCandidate } from '@/lib/pdf-form-detect';
import type { PreflightResult } from '@/lib/document-preflight';

/**
 * 서식 자동 인식 패널 (2026-11-12 4차 J1) — 편집기 오른쪽.
 *
 *  - [자동으로 자리 찾기]: 글자가 있는 PDF 는 편집기가 읽은 글자 묶음으로 바로, 스캔본은 서버 OCR(`/api/studio/pdf-form/detect`)로 후보를 만든다.
 *  - 후보는 쪽 위에 상자로 보인다(신뢰도 낮음 = 노란색). **자동으로 넣지 않는다** — 하나씩 또는 전부 수락해야 편집 기록에 들어간다.
 *  - 수락하면 1차 발송 전 점검(`/api/studio/pdf-form/check`)을 바로 돌려 결과를 보여 준다(저장·발송 없음).
 *  - 위치가 어긋나면 수락 뒤 기존 편집기에서 끌어서 옮긴다.
 */

export type DetectSource = { templateId: string } | { basePdfUrl: string; token: string };

export function PdfFormDetectPanel({
  source,
  pages,
  layout,
  candidates,
  setCandidates,
  focusId,
  onFocus,
  onAccept,
  purpose,
}: {
  source: DetectSource;
  pages: DetectPage[];
  layout: PdfLayout;
  candidates: FieldCandidate[];
  setCandidates: (c: FieldCandidate[]) => void;
  focusId: string | null;
  onFocus: (c: FieldCandidate) => void;
  /** 고른 후보를 편집 기록에 넣는다(편집기가 색을 읽어 넣는다). 넣은 뒤의 기록을 돌려준다. */
  onAccept: (list: FieldCandidate[]) => Promise<PdfLayout | null>;
  purpose?: string | null;
}) {
  const [busy, setBusy] = React.useState(false);
  const [skipped, setSkipped] = React.useState<DetectSkipped[]>([]);
  const [message, setMessage] = React.useState<string | null>(null);
  const [mock, setMock] = React.useState(false);
  const [ran, setRan] = React.useState(false);
  const [check, setCheck] = React.useState<{ normal: PreflightResult; stress: PreflightResult } | null>(null);
  const [checking, setChecking] = React.useState(false);

  const hasText = pages.some((p) => p.runs.length > 0);

  const run = async () => {
    setBusy(true);
    setMessage(null);
    setMock(false);
    setCheck(null);
    try {
      if (hasText) {
        const r = detectFieldCandidates(pages, { source: 'text', existing: layout });
        setCandidates(r.candidates);
        setSkipped(r.skipped);
        if (!r.candidates.length) setMessage('제안할 자리를 찾지 못했습니다. [새 글 넣기] 로 직접 넣어 주세요.');
      } else {
        const res = await fetch('/api/studio/pdf-form/detect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...source, layout }),
        });
        const data = (await res.json().catch(() => null)) as
          | { ok: true; mock: boolean; candidates: FieldCandidate[]; skipped: DetectSkipped[] }
          | { ok: false; message: string }
          | null;
        if (!data || !data.ok) {
          setMessage(data && !data.ok ? data.message : '자동 인식을 하지 못했습니다.');
          return;
        }
        setMock(data.mock);
        setCandidates(data.candidates);
        setSkipped(data.skipped);
        if (data.mock) setMessage('스캔본 글자 읽기(OCR)는 공급자 연결 후 사용할 수 있습니다. 지금은 mock 이라 읽지 않았습니다.');
        else if (!data.candidates.length) setMessage('제안할 자리를 찾지 못했습니다. [새 글 넣기] 로 직접 넣어 주세요.');
      }
      setRan(true);
    } catch {
      setMessage('자동 인식을 하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const runCheck = async (next: PdfLayout) => {
    setChecking(true);
    try {
      const res = await fetch('/api/studio/pdf-form/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...source, layout: next, purpose: purpose ?? null }),
      });
      const data = (await res.json().catch(() => null)) as ({ ok: true; normal: PreflightResult; stress: PreflightResult } | { ok: false; message: string }) | null;
      if (data && data.ok) setCheck({ normal: data.normal, stress: data.stress });
      else setMessage(data && !data.ok ? data.message : '발송 전 점검을 하지 못했습니다.');
    } catch {
      setMessage('발송 전 점검을 하지 못했습니다.');
    } finally {
      setChecking(false);
    }
  };

  const accept = async (list: FieldCandidate[]) => {
    if (!list.length) return;
    const next = await onAccept(list);
    if (!next) return;
    const ids = new Set(list.map((c) => c.id));
    setCandidates(candidates.filter((c) => !ids.has(c.id)));
    await runCheck(next);
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <CardTitle>자동으로 자리 찾기</CardTitle>
        {candidates.length ? (
          <button type="button" onClick={() => setCandidates([])} className="flex items-center gap-1 text-[11.5px] font-bold text-ink-500 hover:text-ink-900">
            <X size={13} strokeWidth={1.8} /> 후보 지우기
          </button>
        ) : null}
      </div>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-400">
        성명·금액·출금일·연락처·작성일·서명 자리를 찾아 넣을 글자를 제안합니다. 수락하기 전에는 아무것도 바뀌지 않습니다. 주소·생년월일은 제안하지 않습니다.
      </p>
      <button
        type="button"
        onClick={run}
        disabled={busy || pages.length === 0}
        className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-brand-700 px-3 text-[12.5px] font-bold text-white hover:bg-brand-800 disabled:opacity-50"
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={16} strokeWidth={1.7} />}
        {ran ? '다시 찾기' : '자동으로 자리 찾기'}
        {!hasText && pages.length ? ' (스캔본)' : ''}
      </button>

      {message ? (
        <p className={cx('mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed', mock ? 'text-warning-500' : 'text-ink-500')}>
          <TriangleAlert size={14} strokeWidth={1.7} className="mt-px shrink-0" /> {message}
        </p>
      ) : null}

      {candidates.length ? (
        <>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-[12px] font-bold text-ink-700">후보 {candidates.length}</p>
            <button type="button" onClick={() => void accept(candidates)} className="flex items-center gap-1 rounded-lg bg-ink-900 px-2 py-1 text-[11.5px] font-bold text-white hover:bg-ink-700">
              <CheckCheck size={14} strokeWidth={1.8} /> 모두 수락
            </button>
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {candidates.map((c) => (
              <li key={c.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onFocus(c)}
                  onKeyDown={(ev) => ev.key === 'Enter' && onFocus(c)}
                  className={cx(
                    'flex cursor-pointer items-start gap-2 rounded-xl border px-2.5 py-2 text-[12px]',
                    c.confidence === 'low' ? 'border-warning-500/40 bg-warning-50' : 'border-ink-100',
                    focusId === c.id ? 'ring-2 ring-brand-400' : '',
                  )}
                >
                  <span className="mt-0.5 shrink-0 rounded-md bg-white px-1.5 py-0.5 text-[10.5px] font-bold text-ink-500">{c.page}쪽</span>
                  <div className="min-w-0 flex-1 leading-snug">
                    <p className="truncate font-semibold text-ink-900">
                      「{c.labelText}」 → {c.fieldLabel}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-ink-500">
                      {c.kind === 'replace' ? `"${c.original}" 을(를) ${c.text} 로` : `${c.text} 넣기`} · {c.reason}
                    </p>
                    <p className={cx('mt-0.5 text-[11px] font-bold', c.confidence === 'low' ? 'text-warning-500' : 'text-brand-700')}>
                      신뢰도 {c.confidence === 'low' ? '낮음 — 위치를 꼭 확인하세요' : '높음'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void accept([c]);
                    }}
                    className="shrink-0 rounded-lg border border-ink-200 bg-white px-1.5 py-1 text-[11px] font-bold text-ink-700 hover:border-brand-400"
                    aria-label="이 후보 수락"
                  >
                    <Check size={13} strokeWidth={1.8} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {skipped.length ? (
        <details className="mt-2 text-[11.5px] text-ink-500">
          <summary className="cursor-pointer font-bold">제안하지 않은 항목 {skipped.length}</summary>
          <ul className="mt-1 space-y-0.5">
            {skipped.map((s, i) => (
              <li key={`${s.page}-${i}`}>
                {s.page}쪽 「{s.labelText}」 — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {checking ? (
        <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-ink-500">
          <Loader2 size={13} className="animate-spin" /> 발송 전 점검 중
        </p>
      ) : check ? (
        <div className="mt-3 rounded-xl border border-ink-100 p-2.5">
          <p className="flex items-center gap-1.5 text-[12px] font-bold text-ink-800">
            <ShieldCheck size={15} strokeWidth={1.7} /> 발송 전 점검(저장 전)
          </p>
          {(['normal', 'stress'] as const).map((k) => {
            const r = check[k];
            return (
              <div key={k} className="mt-1.5 text-[11.5px] leading-relaxed">
                <p className={cx('font-bold', r.level === 'block' ? 'text-danger-500' : r.level === 'warn' ? 'text-warning-500' : 'text-brand-700')}>
                  {k === 'normal' ? '보통 길이 값' : '가장 긴 값'}: {r.level === 'block' ? '보낼 수 없음' : r.level === 'warn' ? '확인 필요' : '통과'}
                </p>
                {r.issues.slice(0, 4).map((i, n) => (
                  <p key={n} className="text-ink-500">· {i.message}</p>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </Card>
  );
}
