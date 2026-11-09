'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Checkbox, Field, Input, Notice } from '@/components/ui';
import { campaignChangeAction, type ChangeState } from '@/app/actions/campaign-setup';

const initial: ChangeState = { ok: false };

/**
 * 기간·목표 바꾸기 / 모금 종료 — 반영 전에 영향(후원페이지 문구 · 예약 콘텐츠 N건(승인 대기 M) · 문자 키워드 · 결과 보고 예정일)을 보여 준다
 * (2026-11-12 4차 I1). 기간이 줄어 기간 밖이 된 슬롯의 미게시 콘텐츠는 보류(지우지 않음).
 */
export function CampaignChangePanel({ id, endsOn, goalAmount, canClose }: { id: string; endsOn: string; goalAmount: number; canClose: boolean }) {
  const [state, action, pending] = React.useActionState(campaignChangeAction, initial);
  const [intent, setIntent] = React.useState<'preview' | 'apply'>('preview');
  const router = useRouter();
  React.useEffect(() => {
    if (state.applied) router.refresh();
  }, [state, router]);
  const i = state.impact;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="version" value={i?.version ?? ''} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="종료일">
          <Input type="date" name="endsOn" defaultValue={endsOn} />
        </Field>
        <Field label="목표 후원금 (원)">
          <Input type="number" name="goalAmount" min={10000} step={1000} defaultValue={goalAmount} />
        </Field>
      </div>
      {canClose ? <Checkbox name="close" label="지금 모금 종료" description="종료 후 들어온 후원은 캠페인의 '종료 후 처리 방침' 대로 처리됩니다." /> : null}
      {state.message && !state.applied ? <Notice tone={state.ok ? 'neutral' : 'danger'}>{state.message}</Notice> : null}
      {state.applied ? <Notice tone="success">{state.message}</Notice> : null}
      {i && !state.applied ? (
        <div className="space-y-2 rounded-2xl border border-ink-100 p-4 text-[12.5px] leading-relaxed text-ink-700">
          <p className="font-bold text-ink-900">후원페이지 문구</p>
          <ul className="list-disc pl-5">{i.page.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="font-bold text-ink-900">예약된 콘텐츠</p>
          <p>
            앞으로 게시할 콘텐츠 {i.content.upcoming}건(승인 대기 {i.content.review}건)
            {i.content.hold ? ` · 기간 밖이 되어 보류 ${i.content.hold}건(승인 대기 ${i.content.holdReview}) — 지우지 않고 게시 예약만 취소` : ''}
            {i.content.restore ? ` · 보류 해제 ${i.content.restore}건` : ''}
            {i.content.add ? ` · 늘어난 기간에 일정 ${i.content.add}건 추가` : ''}
          </p>
          <p className="font-bold text-ink-900">문자 키워드</p>
          <ul className="list-disc pl-5">{i.keyword.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="font-bold text-ink-900">결과 보고</p>
          <p>{i.resultReport}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" disabled={pending} onClick={() => setIntent('preview')}>{pending && intent === 'preview' ? '계산 중' : '영향 미리보기'}</Button>
        <Button type="submit" disabled={pending || !i || !state.ok || Boolean(state.applied)} onClick={() => setIntent('apply')}>{pending && intent === 'apply' ? '반영 중' : '반영'}</Button>
      </div>
    </form>
  );
}
