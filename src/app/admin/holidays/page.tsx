import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { createHolidayAction, updateHolidayAction, deleteHolidayAction } from '@/app/actions/admin/holidays';
import { canManageMoney } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatDateKeyKo, toDateKey } from '@/lib/business-day';
import { findYearsMissingHolidays } from '@/server/services/settlement-schedule';
import { holidayKindLabel } from '@/lib/labels';
import type { HolidayKind } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const KIND_OPTIONS: HolidayKind[] = ['STATUTORY', 'SUBSTITUTE', 'TEMPORARY', 'BANK_ONLY'];

const yearLinkClass =
  'inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-ink-700 hover:bg-ink-50';

export default async function AdminHolidaysPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canManageMoney(me.adminPermission);

  const sp = await searchParams;

  // 정산일 계산은 KST 기준이므로 "올해" 판단도 KST 기준으로 맞춘다.
  const currentYear = Number(toDateKey(new Date()).slice(0, 4));
  const parsedYear = Number(sp.year);
  const year =
    Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100 ? parsedYear : currentYear;

  const [holidays, missingYears] = await Promise.all([
    prisma.publicHoliday.findMany({
      where: { date: { gte: `${year}-01-01`, lte: `${year}-12-31` } },
      orderBy: { date: 'asc' },
    }),
    // 임시공휴일은 매년 갑자기 지정되므로, 올해·내년 공휴일이 비어있으면 정산일 계산이
    // 통째로(주말만 기준으로) 틀어질 수 있다는 걸 조기에 알려준다.
    findYearsMissingHolidays([currentYear, currentYear + 1]),
  ]);

  // 설날·추석은 음력이라 몇 달 전에야 확정 발표되므로, 등록이 빠지기 쉬운 항목이다.
  const hasLunarHoliday = holidays.some((h) => h.name.includes('설날') || h.name.includes('추석'));

  return (
    <>
      <PageHeader
        title="공휴일 관리"
        description="여기 등록한 날짜는 토·일과 함께 정산일(결제일 다음날부터 영업일 5일째) 계산에서 영업일이 아닌 날로 제외됩니다. 임시공휴일이 지정되면 배포 없이 바로 추가해 주세요."
      />

      {missingYears.length > 0 ? (
        <div className="mb-4">
          <Notice tone="danger" title="공휴일 미등록 경고">
            {missingYears.map((y) => `${y}년`).join(', ')} 공휴일이 하나도 등록되지 않아 그 해 정산일이 주말만
            기준으로 계산됩니다. 실제 공휴일이 정산일 계산에서 빠지지 않도록 서둘러 등록해 주세요.
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardTitle>공휴일 등록</CardTitle>
          <p className="mt-1 mb-3 text-[12px] leading-relaxed text-ink-400">
            법정공휴일뿐 아니라 대체공휴일·임시공휴일·은행 휴무일(근로자의 날 등)도 함께 등록해야 정산일이
            정확합니다.
          </p>
          <ActionForm disabled={!canEdit} action={createHolidayAction} submitLabel="공휴일 등록">
            <AdminField label="날짜">
              <AdminInput type="date" name="date" required />
            </AdminField>
            <AdminField label="명칭">
              <AdminInput name="name" placeholder="예: 설날" required />
            </AdminField>
            <AdminField label="종류">
              <AdminSelect name="kind" defaultValue="STATUTORY">
                {KIND_OPTIONS.map((k) => (
                  <option key={k} value={k}>
                    {holidayKindLabel[k].text}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
            <AdminField label="메모" hint="선택 입력">
              <AdminInput name="memo" placeholder="예: 2026년 임시공휴일 지정(국무회의 의결)" />
            </AdminField>
          </ActionForm>
        </Card>

        <div className="lg:col-span-2">
          <SectionTitle
            title={`${year}년 공휴일 목록`}
            description="토·일 외에 영업일 계산에서 제외할 날짜입니다."
            action={
              <div className="flex items-center gap-2">
                <Link href={`/admin/holidays?year=${year - 1}`} className={yearLinkClass}>
                  <ChevronLeft size={14} strokeWidth={1.7} aria-hidden /> {year - 1}년
                </Link>
                <Link href={`/admin/holidays?year=${currentYear}`} className={yearLinkClass}>
                  올해
                </Link>
                <Link href={`/admin/holidays?year=${year + 1}`} className={yearLinkClass}>
                  {year + 1}년 <ChevronRight size={14} strokeWidth={1.7} aria-hidden />
                </Link>
              </div>
            }
          />

          {!hasLunarHoliday ? (
            <div className="mb-3">
              <Notice tone="warning" title="음력 공휴일 확인 필요">
                {year}년 목록에 설날·추석이 등록되어 있지 않습니다. 음력 공휴일은 확정 발표 후 바로 추가해 주세요.
              </Notice>
            </div>
          ) : null}

          {holidays.length === 0 ? (
            <EmptyState
              title={`${year}년에 등록된 공휴일이 없습니다`}
              description="왼쪽 등록 폼으로 이 연도의 공휴일을 추가하세요."
            />
          ) : (
            <Table className="min-w-[1200px]">
              <thead>
                <tr>
                  <Th>날짜</Th>
                  <Th>명칭</Th>
                  <Th>종류</Th>
                  <Th>사용여부</Th>
                  <Th>메모</Th>
                  <Th>수정</Th>
                  <Th>삭제</Th>
                </tr>
              </thead>
              <tbody>
                {holidays.map((h) => (
                  <tr key={h.id}>
                    <Td className="whitespace-nowrap font-semibold">{formatDateKeyKo(h.date)}</Td>
                    <Td className="font-semibold text-ink-900">{h.name}</Td>
                    <Td>
                      <Badge tone={holidayKindLabel[h.kind].tone}>{holidayKindLabel[h.kind].text}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={h.active ? 'success' : 'neutral'}>{h.active ? '사용' : '중지'}</Badge>
                    </Td>
                    <Td className="max-w-[200px] break-words text-[12px] text-ink-400">{h.memo ?? '-'}</Td>
                    <Td>
                      <ActionForm disabled={!canEdit} action={updateHolidayAction} submitLabel="수정" variant="secondary" compact>
                        <input type="hidden" name="id" value={h.id} />
                        <div className="flex w-56 flex-col gap-1.5">
                          <AdminInput name="name" defaultValue={h.name} placeholder="명칭" required />
                          <AdminSelect name="kind" defaultValue={h.kind}>
                            {KIND_OPTIONS.map((k) => (
                              <option key={k} value={k}>
                                {holidayKindLabel[k].text}
                              </option>
                            ))}
                          </AdminSelect>
                          <AdminInput name="memo" defaultValue={h.memo ?? ''} placeholder="메모" />
                          <label className="flex items-center gap-1.5 text-[11.5px] text-ink-500">
                            <input
                              type="checkbox"
                              name="active"
                              defaultChecked={h.active}
                              className="h-3.5 w-3.5 rounded border-ink-300"
                            />
                            사용
                          </label>
                        </div>
                      </ActionForm>
                    </Td>
                    <Td>
                      <ActionButton disabled={!canEdit}
                        action={deleteHolidayAction}
                        values={{ id: h.id }}
                        label="삭제"
                        variant="danger"
                        confirm={`${formatDateKeyKo(h.date)} "${h.name}" 공휴일을 삭제합니다. 이 날짜가 다시 영업일로 계산에 포함됩니다.`}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </div>

      <div className="mt-5">
        <Notice tone="neutral" title="정산일 계산 규칙">
          정산일 = 결제일 다음날부터 영업일 5일째. 예) 2026-08-03(월) 결제 → 2026-08-10(월) 정산. 금·토·일 결제는
          다음 주 금요일로 모입니다. 영업일은 토·일과 이 표에 등록된(사용 상태인) 날짜를 뺀 날입니다.
        </Notice>
      </div>
    </>
  );
}
