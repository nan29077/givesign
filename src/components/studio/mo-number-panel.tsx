'use client';

import * as React from 'react';
import { Phone, Copy, Check, Hash } from 'lucide-react';
import { Badge, Card, cx } from '@/components/ui';

export interface MoNumberView {
  id: string;
  phoneNumber: string;
  keyword: string | null;
  mode: 'DEDICATED' | 'SHARED_PREFIX';
  statusText: string;
  statusTone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger';
  assignedAt: string | null;
}

/**
 * 사회복지기관에 배정된 MO 수신번호 패널.
 *
 * 번호의 배정·변경·회수는 통합 관리자 권한이다(잘못 바꾸면 다른 사회복지기관의 결제가 섞인다).
 * 사회복지기관은 여기서 번호를 확인하고 후원자 안내 문구를 복사할 수 있다.
 */
export function MoNumberPanel({ numbers, guideText }: { numbers: MoNumberView[]; guideText: string | null }) {
  if (numbers.length === 0) {
    return (
      <Card>
        <div className="flex gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warning-50 text-warning-500">
            <Phone size={18} strokeWidth={1.7} />
          </span>
          <div>
            <p className="text-[14px] font-bold text-ink-900">배정된 수신번호가 없습니다</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
              번호가 배정되기 전에는 문자후원를 받을 수 없습니다. 통합 관리자에게 번호 배정을 요청해 주세요.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card padded={false}>
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
        <p className="text-[13px] font-bold text-ink-900">
          내 결제 문자번호
          <span className="ml-2 text-[11.5px] font-medium text-ink-400">후원자가 문자를 보내는 번호입니다</span>
        </p>
      </div>

      <ul>
        {numbers.map((n) => (
          <li key={n.id} className="border-b border-ink-100 px-4 py-3.5 last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-800">
                  <Phone size={18} strokeWidth={1.7} />
                </span>
                <div>
                  <p className="font-mono text-[19px] font-black tracking-tight text-ink-900">{n.phoneNumber}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-400">
                    <Badge tone={n.statusTone}>{n.statusText}</Badge>
                    <span>{n.mode === 'DEDICATED' ? '전용번호' : '대표번호 + 키워드'}</span>
                    {n.assignedAt ? <span>· 배정 {n.assignedAt}</span> : null}
                  </p>
                </div>
              </div>

              {n.keyword ? (
                <div className="rounded-xl bg-ink-50 px-3 py-2">
                  <p className="flex items-center gap-1 text-[11px] font-semibold text-ink-400">
                    <Hash size={12} strokeWidth={1.6} />
                    맨 앞에 붙여야 하는 키워드
                  </p>
                  <p className="mt-0.5 font-mono text-[15px] font-extrabold text-ink-900">{n.keyword}</p>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {guideText ? (
        <div className="border-t border-ink-100 bg-ink-50/60 px-4 py-3">
          <p className="text-[11.5px] font-semibold text-ink-400">서비스 화면에 띄울 안내 문구</p>
          <div className="mt-1.5 flex items-start gap-2">
            <p className="min-w-0 flex-1 whitespace-pre-line break-words rounded-lg bg-white px-3 py-2 text-[12.5px] leading-relaxed text-ink-700">
              {guideText}
            </p>
            <CopyButton text={guideText} />
          </div>
        </div>
      ) : null}

      <p className="border-t border-ink-100 px-4 py-2.5 text-[11.5px] leading-relaxed text-ink-400">
        번호 변경·추가·회수는 통합 관리자가 처리합니다. 번호가 바뀌면 이전 번호로 온 문자는 결제로 접수되지 않으니,
        변경이 필요하면 고객센터로 요청해 주세요.
      </p>
    </Card>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = React.useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        } catch {
          /* 클립보드 권한이 없으면 조용히 무시한다 */
        }
      }}
      className={cx(
        'flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-[12px] font-bold transition-colors',
        done ? 'border-success-500/40 bg-success-50 text-success-500' : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
      )}
    >
      {done ? <Check size={14} strokeWidth={1.6} /> : <Copy size={14} strokeWidth={1.8} />}
      {done ? '복사됨' : '복사'}
    </button>
  );
}
