import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { featureVolunteerEnabled } from '@/lib/env';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { addDays, formatKst, kstDateKey, kstStartOfDay } from '@/lib/datetime';
import { dateKeyOf } from '@/lib/volunteer-schedule';
import { listPostings, POSTING_STATUS_LABEL } from '@/server/services/volunteer-postings';
import { savePostingAction } from '@/app/actions/volunteer-postings';
import { PostingFields } from './_form';

export const dynamic = 'force-dynamic';

const STATUS_TONE = { DRAFT: 'neutral', OPEN: 'success', CLOSED: 'warning', ARCHIVED: 'neutral' } as const;

/**
 * 자원봉사 모집 공고 — 목록·등록. 회차·마감·보관·회차별 신청 현황은 공고 상세에서 다룬다.
 * 공개 후원페이지에는 '모집 중' 이면서 모집 기간 안인 공고만 보인다.
 */
export default async function StudioVolunteerPostingsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  if (!featureVolunteerEnabled()) notFound();
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const showArchived = sp.archived === '1';
  const rows = await listPostings(merchantId, { includeArchived: showArchived });
  const today = kstDateKey();
  const in2w = kstDateKey(addDays(kstStartOfDay(), 14));

  return (
    <>
      <PageHeader
        title="자원봉사 모집 공고"
        description="공고와 회차(날짜·시간·정원)를 만들면 후원페이지에 '자원봉사 모집' 으로 보이고, 신청은 회차별로 정원까지만 받습니다."
        action={<Link href="/studio/volunteers" className="text-[13px] font-bold text-brand-700">자원봉사 신청 관리로</Link>}
      />

      <div className="mb-4 flex gap-2">
        <Link href="/studio/volunteers/postings" className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold ${!showArchived ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600'}`}>진행 공고</Link>
        <Link href="/studio/volunteers/postings?archived=1" className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold ${showArchived ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600'}`}>보관 포함</Link>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="아직 모집 공고가 없습니다" description="아래에서 첫 공고를 만들어 보세요. 공고 없이도 일반 자원봉사 신청은 계속 받습니다." />
      ) : (
        <Table>
          <thead><tr><Th>공고</Th><Th>상태</Th><Th>모집 기간</Th><Th>회차</Th><Th>신청 / 정원</Th><Th>다음 회차</Th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <Td>
                  <Link href={`/studio/volunteers/postings/${p.id}`} className="font-semibold text-brand-700">{p.title}</Link>
                  <span className="ml-2 text-[12px] text-ink-400">{p.interest} · {p.place}</span>
                </Td>
                <Td><Badge tone={STATUS_TONE[p.status]}>{POSTING_STATUS_LABEL[p.status]}</Badge></Td>
                <Td className="whitespace-nowrap tabular-nums">{dateKeyOf(p.recruitFrom)} ~ {dateKeyOf(p.recruitTo)}</Td>
                <Td className="tabular-nums">{p.shiftCount}회</Td>
                <Td className="tabular-nums">{p.applied} / {p.capacity}명</Td>
                <Td className="whitespace-nowrap tabular-nums">{p.nextShiftAt ? formatKst(p.nextShiftAt, false) : '-'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Card className="mt-6">
        <h2 className="text-[16px] font-black text-ink-900">새 공고 만들기</h2>
        <p className="mt-1 text-[12.5px] text-ink-500">작성 중 상태로 만들어집니다. 회차를 추가한 뒤 공고 화면에서 모집을 시작하세요.</p>
        <div className="mt-4">
          <ActionForm action={savePostingAction} submitLabel="공고 만들기">
            <PostingFields defaults={{ recruitFrom: today, recruitTo: in2w }} />
          </ActionForm>
        </div>
      </Card>
    </>
  );
}
