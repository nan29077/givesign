import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Checkbox, EmptyState, Field, Input, Notice, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst } from '@/lib/datetime';
import {
  AUTO_ANSWER_CATEGORIES,
  INQUIRY_CATEGORY_LABEL,
  INQUIRY_MERGE_FIELDS,
  getInquiryAutoSetting,
  listMerchantInquiries,
  type InquiryCategory,
} from '@/server/services/inquiry-auto';
import { saveInquiryAutoSettingAction } from '@/app/actions/inquiry-auto';

export const dynamic = 'force-dynamic';

/** 현재 시각(렌더 밖 함수 — 기한 지남 표시) */
function nowMs() {
  return Date.now();
}

const STATUS_TEXT: Record<string, { text: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  OPEN: { text: '답변 필요', tone: 'warning' },
  ANSWERED: { text: '답변함', tone: 'success' },
  CLOSED: { text: '닫힘', tone: 'neutral' },
};

/**
 * 문의 응대 (2026-11-12 4차 K4). 후원자가 기관 번호로 "문의" 를 보내 남긴 문의만 여기로 온다.
 * 정해진 답이 있는 분류는 기관이 켠 경우에만 자동 답변(문의당 1회), 나머지는 담당자가 답한다.
 */
export default async function StudioInquiriesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { merchantId } = await requireMerchant();
  const { view } = await searchParams;
  const filter = view === 'all' ? 'all' : 'needs';
  const [rows, setting] = await Promise.all([listMerchantInquiries(merchantId, filter), getInquiryAutoSetting(merchantId)]);
  const now = nowMs();

  return (
    <>
      <PageHeader title="문의 응대" description='후원자가 기관 번호로 "문의" 를 보내 본인 확인 후 남긴 문의입니다. 답변은 후원자에게 문자로 전달됩니다.' />
      <div className="mb-4 flex gap-2 text-[13px]">
        <Link href="/studio/inquiries" className={`rounded-full px-3 py-1.5 font-semibold ${filter === 'needs' ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'}`}>답변 필요</Link>
        <Link href="/studio/inquiries?view=all" className={`rounded-full px-3 py-1.5 font-semibold ${filter === 'all' ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'}`}>전체</Link>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={filter === 'needs' ? '답변할 문의가 없습니다' : '문의가 없습니다'} description='후원자가 기관 번호로 "문의" 라고 보내면 본인 확인 후 문의를 남길 수 있습니다.' />
      ) : (
        <div className="mb-6 space-y-3">
          {rows.map((r) => {
            const st = STATUS_TEXT[r.status] ?? STATUS_TEXT.OPEN!;
            const autoDone = r.status === 'CLOSED' && r.autoAnsweredAt;
            const overdue = r.status === 'OPEN' && r.dueAt && r.dueAt.getTime() < now;
            const last = r.messages[0];
            return (
              <Link key={r.id} href={`/studio/inquiries/${r.id}`} className="block">
                <Card className="hover:border-ink-300">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <Badge tone={autoDone ? 'brand' : st.tone}>{autoDone ? '자동 답변됨' : st.text}</Badge>
                    {r.autoCategory ? <span className="text-[12.5px] font-semibold text-ink-700">{INQUIRY_CATEGORY_LABEL[r.autoCategory as InquiryCategory] ?? r.autoCategory}{r.autoCategoryBy === 'LLM' ? ' (AI 분류)' : ''}</span> : null}
                    <span className="text-[12px] text-ink-400">{r.contactMasked}</span>
                    {r.status === 'OPEN' && r.dueAt ? <span className={`ml-auto text-[12px] ${overdue ? 'font-bold text-danger-500' : 'text-ink-500'}`}>기한 {formatKst(r.dueAt, false)}{overdue ? ' 지남' : ''}</span> : null}
                  </div>
                  <p className="line-clamp-2 text-[13.5px] text-ink-700">{last ? `${last.sender === 'USER' ? '' : last.authorKind === 'AUTO' ? '[자동 답변] ' : '[답변] '}${last.body}` : ''}</p>
                  <p className="mt-1 text-[12px] text-ink-400">마지막 메시지 {formatKst(r.lastMessageAt, false)}</p>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      <Card>
        <h2 className="mb-1 text-[16px] font-black text-ink-900">자동 답변 설정</h2>
        <p className="mb-4 text-[13px] leading-relaxed text-ink-500">
          정해진 답이 있는 분류만 켤 수 있습니다(기본은 모두 꺼짐). 켜면 그 분류 문의에 아래 서식으로 <strong>한 번</strong> 답하고 &quot;자동 답변됨&quot; 으로 닫습니다.
          후원자가 다시 쓰면 담당자에게 옵니다. 불만·환불·법적·기타 문의는 항상 담당자가 답합니다. 쓸 수 있는 칸: {INQUIRY_MERGE_FIELDS.join(' ')}
        </p>
        <ActionForm action={saveInquiryAutoSettingAction} submitLabel="설정 저장">
          {AUTO_ANSWER_CATEGORIES.map((c) => (
            <div key={c} className="space-y-2 rounded-2xl border border-ink-100 p-3">
              <Checkbox name={`auto_${c}`} defaultChecked={setting.autoCategories.includes(c)} label={`${INQUIRY_CATEGORY_LABEL[c]} 문의에 자동 답변`} />
              <Field label={`${INQUIRY_CATEGORY_LABEL[c]} 답변 서식${setting.customized[c] ? '' : ' (기본 문안)'}`}>
                <Textarea name={`template_${c}`} rows={4} maxLength={1000} defaultValue={setting.templates[c]} />
              </Field>
            </div>
          ))}
          <Field label="담당자 처리 기한(영업일)" hint="주말·공휴일 제외. 기한을 넘기면 대표 담당자에게 알림이 갑니다.">
            <Input name="dueBusinessDays" type="number" min={1} max={10} defaultValue={setting.dueBusinessDays} />
          </Field>
        </ActionForm>
        <div className="mt-3"><Notice tone="neutral">자동 답변은 안내(정보성)만 보낼 수 있습니다. 후원 권유 문구와 직접 쓴 주소는 저장되지 않습니다 — 주소는 {'{링크}'} 로 넣어 주세요.</Notice></div>
      </Card>
    </>
  );
}
