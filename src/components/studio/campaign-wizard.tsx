'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, CheckCircle2, CircleAlert, FileText, KeyRound, MessageSquareHeart, QrCode, LayoutTemplate } from 'lucide-react';
import { Badge, Button, Card, Checkbox, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { AiDraftButton } from '@/components/studio/ai-draft-button';
import { campaignWizardAction, draftCampaignThanksAction, type WizardState } from '@/app/actions/campaign-setup';

const initial: WizardState = { ok: false };

/**
 * 캠페인 개설 마법사 (2026-11-12 4차 I1).
 * 한 화면에서 입력 → [미리보기] 로 만들어질 것(카드·키워드·QR·콘텐츠 일정·감사 문구·종료 후 방침·결과 보고 예정일)을 확인 → [저장].
 * 콘텐츠 일정·감사 문구·결과 보고 예정일은 체크로 뺄 수 있다. 키워드·QR 은 캠페인에 항상 붙는다.
 */
export function CampaignWizard({ setupKey, today, defaultEnd, ai, policies }: {
  setupKey: string;
  today: string;
  defaultEnd: string;
  ai: { available: boolean; message: string };
  policies: Array<{ value: string; label: string; description: string }>;
}) {
  const [state, action, pending] = React.useActionState(campaignWizardAction, initial);
  const [intent, setIntent] = React.useState<'preview' | 'commit'>('preview');
  const [content, setContent] = React.useState(true);
  const [thanks, setThanks] = React.useState(false);
  const [report, setReport] = React.useState(true);
  const [policy, setPolicy] = React.useState(policies[0]?.value ?? 'GENERAL');
  const router = useRouter();
  React.useEffect(() => {
    if (!state.ok || !state.redirectTo) return;
    const t = setTimeout(() => router.push(state.redirectTo!), 900);
    return () => clearTimeout(t);
  }, [state, router]);
  const p = state.preview;

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="setupKey" value={setupKey} />
      <Card className="space-y-4">
        <p className="text-[13px] font-bold text-ink-900">1. 캠페인 기본</p>
        <div className="grid gap-4 md:grid-cols-[1fr_180px]">
          <Field label="캠페인 제목" required>
            <Input name="title" required maxLength={100} placeholder="예: 겨울 김장 나눔" />
          </Field>
          <Field label="문자 키워드" required hint="한글·영문·숫자 2~10자">
            <Input name="code" required maxLength={10} placeholder="김장" className="font-mono" />
          </Field>
        </div>
        <Field label="한 줄 소개" hint="비우면 제목을 씁니다">
          <Input name="summary" maxLength={300} placeholder="어르신 300가구에 김장김치를 전합니다" />
        </Field>
        <Field label="후원금 용도" hint="어디에 쓰는지 한두 문장. 후원페이지에 보입니다.">
          <Textarea name="usagePlan" rows={3} maxLength={3000} />
        </Field>
        <ImageUploadField label="대표 사진" name="imageUrl" defaultValue="" hint="수혜자 실사진·실명은 쓰지 않습니다. 비우면 기관 후원페이지 배너를 씁니다." />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="목표 후원금 (원)" required>
            <Input type="number" name="goalAmount" min={10000} step={1000} required defaultValue={1000000} />
          </Field>
          <Field label="시작일" required>
            <Input type="date" name="startsOn" required defaultValue={today} />
          </Field>
          <Field label="종료일" required>
            <Input type="date" name="endsOn" required defaultValue={defaultEnd} />
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Checkbox name="startNow" label="저장하면서 바로 모금 시작" description="끄면 작성 중으로 저장하고, 캠페인 화면에서 모금을 시작합니다." />
          <Checkbox name="featured" label="후원페이지 맨 위에 강조" />
        </div>
      </Card>

      <Card className="space-y-4">
        <p className="text-[13px] font-bold text-ink-900">2. 함께 만들 것</p>
        <div className="rounded-2xl border border-ink-100 bg-ink-50 px-4 py-3 text-[12.5px] leading-relaxed text-ink-500">
          <p className="flex items-center gap-1.5 font-bold text-ink-900"><KeyRound size={16} strokeWidth={1.7} /> 문자 키워드 · <QrCode size={16} strokeWidth={1.7} /> 캠페인 QR · <LayoutTemplate size={16} strokeWidth={1.7} /> 후원페이지 카드</p>
          <p className="mt-1">캠페인에 항상 함께 생깁니다(빼려면 캠페인을 만들지 않으면 됩니다). 키워드 중복·예약어(정기·봉사 등)는 저장 전에 확인합니다.</p>
        </div>

        <div className="space-y-3 rounded-2xl border border-ink-100 p-4">
          <label className="flex items-center gap-2 text-[13px] font-bold text-ink-900">
            <input type="checkbox" name="includeContent" checked={content} onChange={(e) => setContent(e.target.checked)} className="h-4 w-4" />
            <CalendarDays size={16} strokeWidth={1.7} /> 콘텐츠 일정 초안
          </label>
          {content ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="주 몇 건" hint="1~7건, 요일은 고르게 나눕니다">
                <Input type="number" name="weeklyCount" min={1} max={7} defaultValue={2} />
              </Field>
              <Field label="게시 시각(시)" hint="0~23시, 한국 시간">
                <Input type="number" name="postHour" min={0} max={23} defaultValue={19} />
              </Field>
              <p className="text-[12px] leading-relaxed text-ink-500 sm:col-span-2">슬롯만 먼저 잡고, 콘텐츠는 슬롯 7일 전부터 만들어 <b>승인 대기</b>로 올립니다. 승인해야 게시됩니다.</p>
            </div>
          ) : null}
        </div>

        <div className="space-y-3 rounded-2xl border border-ink-100 p-4">
          <label className="flex items-center gap-2 text-[13px] font-bold text-ink-900">
            <input type="checkbox" name="includeThanks" checked={thanks} onChange={(e) => setThanks(e.target.checked)} className="h-4 w-4" />
            <MessageSquareHeart size={16} strokeWidth={1.7} /> 이 캠페인 감사 문자
          </label>
          {thanks ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12px] text-ink-500">비우면 기관 기본 감사 문구가 나갑니다. {'{후원자}'} 치환자를 꼭 넣어 주세요.</p>
                <AiDraftButton action={draftCampaignThanksAction} available={ai.available} unavailableMessage={ai.message} />
              </div>
              <Textarea name="thanksMessage" rows={3} maxLength={300} placeholder="{후원자}님, {금액} 후원 감사합니다." />
            </>
          ) : null}
        </div>

        <div className="space-y-3 rounded-2xl border border-ink-100 p-4">
          <label className="flex items-center gap-2 text-[13px] font-bold text-ink-900">
            <input type="checkbox" name="includeReport" checked={report} onChange={(e) => setReport(e.target.checked)} className="h-4 w-4" />
            <FileText size={16} strokeWidth={1.7} /> 결과 보고 예정일
          </label>
          {report ? (
            <Field label="예정일" hint="비우면 종료일 30일 뒤. 이 날이 되면 승인 대기함에 '결과 보고 작성' 이 올라옵니다.">
              <Input type="date" name="resultReportDueOn" />
            </Field>
          ) : null}
        </div>

        <Field label="종료 후 들어온 후원" hint="다른 캠페인으로 옮기는 선택지는 없습니다. 지정 목적을 바꾸려면 후원자가 직접 고릅니다.">
          <Select name="afterEndPolicy" value={policy} onChange={(e) => setPolicy(e.target.value)}>
            {policies.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Field>
        <p className="text-[12px] leading-relaxed text-ink-500">{policies.find((o) => o.value === policy)?.description}</p>
      </Card>

      {state.message ? <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice> : null}

      {p ? (
        <Card className="space-y-3">
          <p className="text-[13px] font-bold text-ink-900">3. 만들어질 것 확인</p>
          <PreviewRow ok={p.keyword.ok} title={`문자 키워드 '${p.keyword.code}'`} body={p.keyword.message} />
          <PreviewRow ok title="캠페인 QR" body={p.qrNote} />
          <PreviewRow ok title="후원페이지" body={p.page.join(' ')} />
          {p.content ? (
            <div className="rounded-xl border border-ink-100 p-3">
              <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink-900"><CalendarDays size={16} strokeWidth={1.7} /> 콘텐츠 일정 {p.content.willCreate}건{p.content.taken ? ` (이미 다른 콘텐츠가 있는 시각 ${p.content.taken}건 제외)` : ''}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {p.content.slots.slice(0, 24).map((s) => <Badge key={s.label} tone={s.taken ? 'neutral' : 'brand'}>{s.label}{s.taken ? ' · 겹침' : ''}</Badge>)}
                {p.content.slots.length > 24 ? <span className="text-[12px] text-ink-400">외 {p.content.slots.length - 24}건</span> : null}
              </div>
              {p.content.blockers.map((b) => <p key={b} className="mt-1.5 text-[12px] text-warning-500">{b}</p>)}
            </div>
          ) : null}
          {p.thanks ? <PreviewRow ok={p.thanks.ok} title="감사 문자" body={p.thanks.message} /> : null}
          <PreviewRow ok title="결과 보고 예정일" body={p.resultReportDueOn ?? '정하지 않음'} />
          <PreviewRow ok title={`종료 후: ${p.afterEnd.label}`} body={p.afterEnd.text} />
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" disabled={pending} onClick={() => setIntent('preview')}>{pending && intent === 'preview' ? '확인 중' : '미리보기'}</Button>
        <Button type="submit" disabled={pending || !p || !p.keyword.ok || p.problems.length > 0} onClick={() => setIntent('commit')}>{pending && intent === 'commit' ? '저장 중' : '저장'}</Button>
      </div>
      {!p ? <p className="text-[12px] text-ink-400">[미리보기] 로 만들어질 것을 확인한 뒤 저장할 수 있습니다. 입력을 바꾸면 다시 미리보기를 눌러 주세요.</p> : null}
    </form>
  );
}

function PreviewRow({ ok, title, body }: { ok: boolean; title: string; body: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-ink-100 p-3">
      {ok ? <CheckCircle2 size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-brand-600" /> : <CircleAlert size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-danger-500" />}
      <div className="min-w-0">
        <p className="text-[13px] font-bold text-ink-900">{title}</p>
        <p className="mt-0.5 break-words text-[12.5px] leading-relaxed text-ink-500">{body}</p>
      </div>
    </div>
  );
}
