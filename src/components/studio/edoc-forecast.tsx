'use client';

import * as React from 'react';
import { Calculator, TriangleAlert } from 'lucide-react';
import { Textarea, cx } from '@/components/ui';
import { forecastEDocCost, forecastSentence, topupNeeded, type EDocForecast, type EDocWalletState } from '@/lib/edoc-forecast';

/**
 * 전자문서 발송 비용 예측 표시(2026-11-12 4차 J3).
 * "이번 발송에 N건 · 정액 제공량 M건 사용 · 충전 잔액 K원 차감 예상 · 부족 시 J건이 멈춥니다"
 * 계산은 `@/lib/edoc-forecast`(실제 차감과 같은 순서: 정액 → 시범 → 충전 잔액).
 */
export function EDocForecastBox({ forecast, className }: { forecast: EDocForecast; className?: string }) {
  const short = forecast.blocked > 0;
  return (
    <div className={cx('rounded-xl border px-3 py-2.5 text-[12.5px] leading-relaxed', short ? 'border-warning-500/40 bg-warning-50' : 'border-ink-100 bg-ink-50/60', className)}>
      <p className={cx('flex items-start gap-1.5 font-bold', short ? 'text-warning-500' : 'text-ink-800')}>
        {short ? <TriangleAlert size={16} strokeWidth={1.7} className="mt-0.5 shrink-0" /> : <Calculator size={16} strokeWidth={1.7} className="mt-0.5 shrink-0" />}
        <span>{forecastSentence(forecast)}</span>
      </p>
      {forecast.count > 0 ? (
        <p className="mt-1 pl-[22px] text-[11.5px] text-ink-500">
          1건 {forecast.perDocument.toLocaleString('ko-KR')}원 · 차감 순서: 정액 제공량 → 시범 제공 → 충전 잔액 · 발송 뒤 충전 잔액 {forecast.balanceAfter.toLocaleString('ko-KR')}원
          {short ? ` · 모두 보내려면 ${topupNeeded(forecast).toLocaleString('ko-KR')}원 이상 충전하세요. 멈춘 건은 충전이 승인되면 멈춘 곳부터 자동으로 이어서 보냅니다.` : ''}
        </p>
      ) : null}
    </div>
  );
}

/** 여러 명에게 보내기 화면: 받는 분 목록을 적는 동안 예상 비용을 바로 보여 준다. */
export function RecipientsForecastField({ wallet, unitsPerLine = 1, placeholder }: { wallet: EDocWalletState; unitsPerLine?: number; placeholder?: string }) {
  const [text, setText] = React.useState('');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(이름|성명|name)[,\t]/i.test(l)).length;
  const f = forecastEDocCost(wallet, Math.min(200, lines) * unitsPerLine);
  return (
    <div className="space-y-2">
      <Textarea name="recipients" rows={10} required placeholder={placeholder} className="font-mono text-[13px]" value={text} onChange={(e) => setText(e.target.value)} />
      {lines > 0 ? <EDocForecastBox forecast={f} /> : null}
    </div>
  );
}
