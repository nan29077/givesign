import Link from 'next/link';
import { ChevronRight, Circle, CircleCheck, CircleMinus, FlaskConical, ScanText, ShieldCheck } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm, InlineActionForm } from '@/components/studio/action-form';
import { Badge, Card, Field, Input, Notice, SectionTitle } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { liveTestHint, ocrAvailability, onboardingChecklist, readTestSteps, SKIPPABLE_STEPS } from '@/server/services/onboarding';
import { readinessWithChecks } from '@/server/services/readiness-checks';
import { dismissOnboardingAction, runOnboardingTestAction, scanOrgDocAction, setOnboardingSkipAction } from '@/app/actions/onboarding';

export const dynamic = 'force-dynamic';

/**
 * 기관 도입 체크리스트 (2026-11-12 4차 I2). 진행 상태는 원천에서 계산한다(체크를 따로 저장하지 않음).
 * 각 단계는 기존 화면으로 보낸다. 시험 후원·시험 문서는 샌드박스 시뮬레이션이라 실제 결제·문자·집계에 영향이 없다.
 */
export default async function StudioStartPage() {
  const { merchantId } = await requireMerchant();
  const [list, readiness] = await Promise.all([onboardingChecklist(merchantId), readinessWithChecks(merchantId)]);
  const ocr = ocrAvailability();
  const hint = liveTestHint();
  const lastSteps = list.lastTest ? readTestSteps(list.lastTest.steps) : [];

  return (
    <>
      <PageHeader title="도입 체크리스트" description={`${list.orgName} 기브싸인 시작하기 — ${list.doneCount}/${list.total} 단계 완료. 단계마다 해당 화면으로 이동합니다.`} />
      <div className="space-y-5">
        {list.finished ? <Notice tone="success" title="도입 준비를 모두 마쳤습니다">대시보드 안내는 더 보이지 않습니다. 아래 작동 점검은 언제든 다시 볼 수 있습니다.</Notice> : null}
        <Card>
          <ol className="divide-y divide-ink-100">
            {list.steps.map((s, i) => (
              <li key={s.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  {s.done ? <CircleCheck size={20} strokeWidth={1.7} className="mt-0.5 shrink-0 text-brand-700" /> : s.skipped ? <CircleMinus size={20} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-400" /> : <Circle size={20} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-300" />}
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold text-ink-900">{i + 1}. {s.label} {s.skipped ? <Badge tone="neutral">해당 없음</Badge> : null}</p>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{s.description}</p>
                    <p className="mt-0.5 text-[12px] text-ink-400">{s.status}</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 pl-8 sm:pl-0">
                  <Link href={s.href} className="inline-flex items-center gap-1 text-[13px] font-bold text-brand-700">{s.linkLabel}<ChevronRight size={16} strokeWidth={1.7} /></Link>
                  {(SKIPPABLE_STEPS as readonly string[]).includes(s.key) && !s.done ? (
                    <InlineActionForm action={setOnboardingSkipAction} submitLabel={s.skipped ? '되돌리기' : '해당 없음'} variant="ghost" fields={{ step: s.key, skip: s.skipped ? 'false' : 'true' }} />
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <section id="org-doc">
          <SectionTitle title="서류로 기관 정보 채우기" description="고유번호증·사업자등록증 사진이나 PDF 를 올리면 이름·번호·대표자·주소를 읽어 기관 정보 입력칸을 채웁니다. 저장은 직접 확인한 뒤에 합니다." />
          <Card>
            {ocr.usable ? (
              <ActionForm action={scanOrgDocAction} submitLabel="서류 읽기" pendingLabel="읽는 중">
                <Field label="서류 파일" hint="PNG·JPG·WEBP·PDF, 5MB 이하. 원본은 비공개로 보관하고, 주민등록번호 꼴은 가립니다.">
                  <Input type="file" name="file" accept="image/png,image/jpeg,image/webp,application/pdf" required className="pt-2.5" />
                </Field>
              </ActionForm>
            ) : (
              <p className="flex items-center gap-2 text-[13px] text-ink-500"><ScanText size={18} strokeWidth={1.7} /> 자동 읽기는 글자 읽기(OCR) 공급자 연결 후 사용할 수 있습니다. 지금은 <Link href="/studio/profile" className="font-bold text-brand-700 underline">기관 정보</Link>에 직접 입력해 주세요.</p>
            )}
          </Card>
        </section>

        <section id="test">
          <SectionTitle title="시험 후원 · 시험 문서" description="담당자 번호로 문자 수신 → 회신 → 결제 성공, 그리고 감사장 문서 만들기를 한 번에 시험합니다." />
          <Card className="space-y-3">
            <Notice tone="neutral" title="시험은 시뮬레이션입니다">
              통신망·결제사를 거치지 않고, 시험 거래는 별도 시험 표에만 남습니다. 후원 내역·대시보드·정산·기부금영수증 숫자에 들어가지 않고, 문서도 실제로 보내거나 이용요금을 차감하지 않습니다.
            </Notice>
            {hint ? <p className="text-[12.5px] leading-relaxed text-ink-500">{hint}</p> : null}
            <ActionForm action={runOnboardingTestAction} submitLabel="시험 실행" pendingLabel="시험 중">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="담당자 휴대폰" hint="마스킹해서만 남깁니다" required>
                  <Input name="phone" inputMode="tel" placeholder="010-0000-0000" required />
                </Field>
                <Field label="시험 문서에 넣을 이름" hint="비우면 '담당자'">
                  <Input name="staffName" maxLength={20} />
                </Field>
              </div>
            </ActionForm>
            {list.lastTest ? (
              <div className="rounded-2xl border border-ink-100 p-3">
                <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink-900"><FlaskConical size={16} strokeWidth={1.7} /> 마지막 시험 {formatKst(list.lastTest.createdAt)} · {list.lastTest.phoneMasked}</p>
                <ul className="mt-1.5 space-y-1 text-[12.5px] text-ink-500">
                  {lastSteps.map((s) => <li key={s.key}><Badge tone={s.ok ? 'success' : 'danger'}>{s.ok ? '성공' : '실패'}</Badge> {s.message}</li>)}
                </ul>
              </div>
            ) : null}
          </Card>
        </section>

        <section>
          <SectionTitle title="작동 점검" description="'설정됨' 은 필요한 정보가 있다는 뜻이고, '작동 확인됨' 은 실제로 돌아간 기록이 있다는 뜻입니다." />
          <Card>
            <ul className="divide-y divide-ink-100">
              {readiness.items.map((i) => (
                <li key={i.key} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-bold text-ink-900">{i.label}</span>
                    <Badge tone={i.ok ? 'brand' : i.required ? 'danger' : 'warning'}>{i.ok ? '설정됨' : i.required ? '필수 — 빠짐' : '권장 — 빠짐'}</Badge>
                    {i.verified ? <Badge tone="success"><span className="inline-flex items-center gap-1"><ShieldCheck size={14} strokeWidth={1.7} />작동 확인됨</span></Badge> : null}
                  </div>
                  {i.checks.map((c) => (
                    <p key={c.key} className="mt-0.5 text-[12px] text-ink-500">
                      {c.label}: {c.verifiedAt ? `${formatKst(c.verifiedAt)}${c.mock ? ' (mock)' : ''}` : '기록 없음'}{c.note ? ` — ${c.note}` : ''}
                    </p>
                  ))}
                  {!i.ok && i.impact ? <p className="mt-0.5 text-[12px] text-ink-400">{i.impact}</p> : null}
                </li>
              ))}
            </ul>
            {readiness.lastTest ? <p className="mt-3 text-[12px] text-ink-400">마지막 도입 시험(시뮬레이션): {formatKst(readiness.lastTest.at)} — 작동 확인으로 치지 않습니다.</p> : null}
          </Card>
        </section>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[12.5px] text-ink-500">{list.dismissed ? '대시보드 안내를 숨겨 두었습니다.' : '다 끝나지 않았어도 대시보드 안내를 숨길 수 있습니다.'}</p>
            <InlineActionForm action={dismissOnboardingAction} submitLabel={list.dismissed ? '대시보드에 다시 보이기' : '대시보드 안내 숨기기'} variant="secondary" fields={{ dismiss: list.dismissed ? 'false' : 'true' }} />
          </div>
        </Card>
      </div>
    </>
  );
}
