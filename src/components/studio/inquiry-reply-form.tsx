'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { Button, Field, Notice, Textarea } from '@/components/ui';
import { inquiryDraftAction, replyInquiryAsMerchantAction, type InquiryDraftState } from '@/app/actions/inquiry-auto';
import type { StudioActionState } from '@/app/actions/studio';

/**
 * 기관 문의 답변 입력(2026-11-12 4차 K4). AI 초안은 입력칸을 채우기만 한다 — 보내기는 담당자가 누른다.
 * AI 공급자가 mock 이면 버튼 대신 "AI 공급자 연결 후 사용" 안내.
 */
export function InquiryReplyForm({ inquiryId, ai }: { inquiryId: string; ai: { available: boolean; message: string } }) {
  const [body, setBody] = React.useState('');
  const [draft, draftAction, drafting] = React.useActionState<InquiryDraftState, FormData>(inquiryDraftAction, { ok: false });
  const [sent, sendAction, sending] = React.useActionState<StudioActionState, FormData>(replyInquiryAsMerchantAction, { ok: false });
  const router = useRouter();
  const [lastDraft, setLastDraft] = React.useState<string | undefined>(undefined);
  if (draft.reply && draft.reply !== lastDraft) {
    setLastDraft(draft.reply);
    setBody(draft.reply);
  }
  React.useEffect(() => {
    if (sent.ok) router.refresh();
  }, [sent, router]);

  return (
    <div className="space-y-3">
      {ai.available ? (
        <form action={draftAction}>
          <input type="hidden" name="inquiryId" value={inquiryId} />
          <Button type="submit" variant="secondary" size="sm" disabled={drafting}>
            <Sparkles size={16} strokeWidth={1.7} /> {drafting ? '초안 만드는 중' : 'AI 답변 초안'}
          </Button>
        </form>
      ) : (
        <p className="text-[12.5px] text-ink-400">{ai.message}</p>
      )}
      {draft.message ? <Notice tone={draft.ok ? 'success' : 'warning'}>{draft.message}</Notice> : null}
      <form action={sendAction} className="space-y-3">
        <input type="hidden" name="inquiryId" value={inquiryId} />
        <Field label="답변">
          <Textarea name="body" rows={6} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} required />
        </Field>
        {sent.message ? <Notice tone={sent.ok ? 'success' : 'danger'}>{sent.message}</Notice> : null}
        <Button type="submit" disabled={sending}>{sending ? '보내는 중' : '답변 보내기'}</Button>
      </form>
    </div>
  );
}
