import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { featureVolunteerEnabled } from '@/lib/env';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Field, Input, Notice } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { kstDateKey } from '@/lib/datetime';
import { displayPayerName } from '@/lib/payer-name';
import { dateKeyOf, shiftWhenLabel } from '@/lib/volunteer-schedule';
import { getPostingDetail, POSTING_STATUS_LABEL } from '@/server/services/volunteer-postings';
import { VOLUNTEER_STATUS_LABEL } from '@/server/services/volunteers';
import {
  addShiftAction,
  archiveShiftAction,
  attendanceAction,
  savePostingAction,
  setPostingStatusAction,
  shiftCapacityAction,
} from '@/app/actions/volunteer-postings';
import { PostingFields } from '../_form';

export const dynamic = 'force-dynamic';

const APP_TONE = { RECEIVED: 'warning', APPROVED: 'success', COMPLETED: 'brand', NO_SHOW: 'danger', REJECTED: 'neutral', WITHDRAWN: 'neutral' } as const;

/**
 * 공고 상세 — 수정 · 모집 시작/마감/보관 · 회차 추가/정원/보관 · 회차별 신청 현황 · 출석/불참.
 * 신청 승인·반려는 자원봉사 신청 관리(/studio/volunteers)에서 한다(회차 일정이 배정 안내로 자동 채워진다).
 * 신청자는 표시 이름과 마스킹 번호만 보인다.
 */
export default async function StudioVolunteerPostingPage({ params }: { params: Promise<{ id: string }> }) {
  if (!featureVolunteerEnabled()) notFound();
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const p = await getPostingDetail(merchantId, id);
  if (!p) notFound();
  const today = kstDateKey();
  const archived = p.status === 'ARCHIVED';
  const activeShifts = p.shifts.filter((s) => !s.archivedAt);
  const archivedShifts = p.shifts.filter((s) => s.archivedAt);

  return (
    <>
      <PageHeader
        title={p.title}
        description={`${p.interest} · ${p.place} · 모집 ${dateKeyOf(p.recruitFrom)} ~ ${dateKeyOf(p.recruitTo)}`}
        action={<Link href="/studio/volunteers/postings" className="text-[13px] font-bold text-brand-700">공고 목록</Link>}
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[14px] font-bold text-ink-900">
            상태 <Badge tone={p.status === 'OPEN' ? 'success' : p.status === 'CLOSED' ? 'warning' : 'neutral'} className="ml-1">{POSTING_STATUS_LABEL[p.status]}</Badge>
            {p.status === 'OPEN' && dateKeyOf(p.recruitTo) < today ? <span className="ml-2 text-[12px] font-normal text-ink-500">모집 기간이 지나 후원페이지에서는 보이지 않습니다.</span> : null}
          </p>
          <div className="flex flex-wrap gap-2">
            {p.status === 'DRAFT' || p.status === 'CLOSED' ? (
              <ActionForm action={setPostingStatusAction} submitLabel="모집 시작" size="sm" confirmMessage="후원페이지에 이 공고를 보이고 신청을 받습니다.">
                <input type="hidden" name="id" value={p.id} /><input type="hidden" name="next" value="OPEN" />
              </ActionForm>
            ) : null}
            {p.status === 'OPEN' ? (
              <ActionForm action={setPostingStatusAction} submitLabel="모집 마감" size="sm" variant="secondary" confirmMessage="새 신청을 더 받지 않습니다. 이미 받은 신청과 회차는 그대로입니다.">
                <input type="hidden" name="id" value={p.id} /><input type="hidden" name="next" value="CLOSED" />
              </ActionForm>
            ) : null}
            {archived ? (
              <ActionForm action={setPostingStatusAction} submitLabel="보관 해제" size="sm" variant="secondary">
                <input type="hidden" name="id" value={p.id} /><input type="hidden" name="next" value="RESTORE" />
              </ActionForm>
            ) : (
              <ActionForm action={setPostingStatusAction} submitLabel="보관" size="sm" variant="ghost" confirmMessage="공고를 보관합니다. 후원페이지에서 내려가고, 보관 해제로 되돌릴 수 있습니다.">
                <input type="hidden" name="id" value={p.id} /><input type="hidden" name="next" value="ARCHIVED" />
              </ActionForm>
            )}
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-3">
          <h2 className="text-[16px] font-black text-ink-900">회차별 신청 현황</h2>
          {activeShifts.length === 0 ? (
            <EmptyState title="아직 회차가 없습니다" description="오른쪽에서 날짜·시간·정원을 넣어 회차를 추가하세요. 회차가 없는 공고는 일정 없이 신청을 받습니다." />
          ) : (
            activeShifts.map((s) => {
              const shiftDay = dateKeyOf(s.shiftDate);
              const canAttend = shiftDay <= today;
              const live = s.applications.filter((a) => a.status === 'RECEIVED' || a.status === 'APPROVED');
              return (
                <Card key={s.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[15px] font-black text-ink-900">{shiftWhenLabel(s)}</p>
                      <p className="mt-0.5 text-[12.5px] tabular-nums text-ink-500">신청 {s.appliedCount} / 정원 {s.capacity}명 · 남은 자리 {Math.max(0, s.capacity - s.appliedCount)}</p>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <ActionForm action={shiftCapacityAction} submitLabel="정원 변경" size="sm" variant="ghost">
                        <input type="hidden" name="shiftId" value={s.id} /><input type="hidden" name="postingId" value={p.id} />
                        <Input name="capacity" inputMode="numeric" defaultValue={String(s.capacity)} className="h-9 w-20" aria-label="정원" />
                      </ActionForm>
                      <ActionForm action={archiveShiftAction} submitLabel="회차 보관" size="sm" variant="ghost" confirmMessage="이 회차를 보관합니다. 진행 중 신청이 있으면 보관할 수 없습니다.">
                        <input type="hidden" name="shiftId" value={s.id} /><input type="hidden" name="postingId" value={p.id} /><input type="hidden" name="archived" value="1" />
                      </ActionForm>
                    </div>
                  </div>
                  {s.applications.length === 0 ? (
                    <p className="mt-3 text-[13px] text-ink-400">아직 신청이 없습니다.</p>
                  ) : (
                    <ul className="mt-3 divide-y divide-ink-100 border-t border-ink-100">
                      {s.applications.map((a) => (
                        <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                          <span>
                            <b>{displayPayerName(a.payer.displayName ?? '')}</b>
                            <span className="ml-1.5 font-mono text-[12px] text-ink-400">{a.payer.phoneMasked}</span>
                            <Badge tone={APP_TONE[a.status]} className="ml-2">{VOLUNTEER_STATUS_LABEL[a.status]}</Badge>
                            {a.payer.mergedIntoId ? <Badge tone="neutral" className="ml-1">병합됨</Badge> : null}
                          </span>
                          {a.status === 'APPROVED' && canAttend ? (
                            <span className="flex gap-2">
                              <ActionForm action={attendanceAction} submitLabel="출석" size="sm" confirmMessage="출석을 확인하면 회차 시간만큼 활동이 자동으로 기록됩니다.">
                                <input type="hidden" name="id" value={a.id} /><input type="hidden" name="postingId" value={p.id} /><input type="hidden" name="attended" value="1" />
                              </ActionForm>
                              <ActionForm action={attendanceAction} submitLabel="불참" size="sm" variant="ghost" confirmMessage="불참으로 처리합니다. 활동은 기록되지 않습니다.">
                                <input type="hidden" name="id" value={a.id} /><input type="hidden" name="postingId" value={p.id} /><input type="hidden" name="attended" value="0" />
                              </ActionForm>
                            </span>
                          ) : a.status === 'RECEIVED' ? (
                            <Link href="/studio/volunteers?tab=received" className="text-[12.5px] font-bold text-brand-700">승인하러 가기</Link>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  {live.length && !canAttend ? <p className="mt-2 text-[12px] text-ink-400">출석·불참은 회차 날짜부터 처리할 수 있습니다.</p> : null}
                </Card>
              );
            })
          )}
          {archivedShifts.length ? (
            <details className="rounded-2xl border border-ink-100 bg-white px-4 py-3">
              <summary className="cursor-pointer text-[13px] font-bold text-ink-500">보관한 회차 {archivedShifts.length}개</summary>
              <ul className="mt-2 divide-y divide-ink-100 text-[13px]">
                {archivedShifts.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                    <span>{shiftWhenLabel(s)} · 정원 {s.capacity}</span>
                    <ActionForm action={archiveShiftAction} submitLabel="보관 해제" size="sm" variant="ghost">
                      <input type="hidden" name="shiftId" value={s.id} /><input type="hidden" name="postingId" value={p.id} /><input type="hidden" name="archived" value="0" />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>

        <div className="space-y-4">
          {!archived ? (
            <Card>
              <h2 className="text-[15px] font-black text-ink-900">회차 추가</h2>
              <div className="mt-3">
                <ActionForm action={addShiftAction} submitLabel="회차 추가" size="sm">
                  <input type="hidden" name="postingId" value={p.id} />
                  <Field label="활동 날짜 (KST)"><Input type="date" name="date" min={today} defaultValue={today} /></Field>
                  <div className="grid grid-cols-3 gap-2">
                    <Field label="시작"><Input type="time" name="startTime" defaultValue="10:00" /></Field>
                    <Field label="끝"><Input type="time" name="endTime" defaultValue="12:00" /></Field>
                    <Field label="정원"><Input name="capacity" inputMode="numeric" defaultValue="5" /></Field>
                  </div>
                </ActionForm>
              </div>
            </Card>
          ) : null}
          <Card>
            <h2 className="text-[15px] font-black text-ink-900">공고 수정</h2>
            {archived ? (
              <p className="mt-2 text-[13px] text-ink-500">보관된 공고는 보관을 해제한 뒤 고칠 수 있습니다.</p>
            ) : (
              <div className="mt-3">
                <ActionForm action={savePostingAction} submitLabel="저장" size="sm" variant="secondary">
                  <input type="hidden" name="id" value={p.id} />
                  <PostingFields
                    defaults={{
                      title: p.title,
                      interest: p.interest,
                      description: p.description,
                      place: p.place,
                      recruitFrom: dateKeyOf(p.recruitFrom),
                      recruitTo: dateKeyOf(p.recruitTo),
                      requirements: p.requirements,
                    }}
                  />
                </ActionForm>
              </div>
            )}
          </Card>
          <Notice tone="neutral">출석을 확인하면 회차 시간만큼 활동이 기록되고 1365 등록 자료(CSV)에 들어갑니다.</Notice>
        </div>
      </div>
    </>
  );
}
