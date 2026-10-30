import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Input, Select, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { SupporterImportForm } from '@/components/studio/supporter-import-form';
import { formatKst } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { displayPayerName } from '@/lib/payer-name';
import { sourceLabel } from '@/lib/attribution';
import { listSupporters, pendingPledgeRequests, ROLE_LABEL, SEGMENT_LABEL, SEGMENTS, type Segment, type SupporterRole } from '@/server/services/supporters';
import { pledgeReminderAction } from '@/app/actions/automation';

export const dynamic = 'force-dynamic';

const ROLES = ['all', 'DONOR', 'VOLUNTEER', 'BOTH', 'CONTACT'] as const;

/**
 * 후원자·자원봉사자 통합 관리.
 *
 * 한 사람을 기준으로 후원(누적·횟수·최근)·정기 약정·자원봉사(상태·활동 시간)·기관 명단을 한 줄로 본다.
 * 세그먼트는 "다음에 할 일" 기준이다(정기 전환 대상, 휴면, 봉사만 등). 전화번호 원문은 어디에도 보이지 않는다.
 */
export default async function StudioSupportersPage({ searchParams }: { searchParams: Promise<{ q?: string; seg?: string; role?: string }> }) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const seg: Segment = SEGMENTS.includes(sp.seg as Segment) ? (sp.seg as Segment) : 'all';
  const role = ROLES.includes(sp.role as (typeof ROLES)[number]) ? (sp.role as (typeof ROLES)[number]) : 'all';
  const [all, pledgePending] = await Promise.all([listSupporters(merchantId), pendingPledgeRequests(merchantId)]);

  const count = (s: Segment) => all.filter((r) => r.segments.includes(s)).length;
  let rows = all.filter((r) => r.segments.includes(seg));
  if (role !== 'all') rows = rows.filter((r) => r.role === role);
  if (q) rows = rows.filter((r) => r.name.includes(q) || r.phoneMasked.includes(q) || r.tags.some((t) => t.includes(q)));
  rows.sort((a, b) => (b.lastDonatedAt?.getTime() ?? 0) - (a.lastDonatedAt?.getTime() ?? 0) || Number(b.totalAmount - a.totalAmount));

  const donors = all.filter((r) => r.role === 'DONOR' || r.role === 'BOTH').length;
  const volunteers = all.filter((r) => r.role === 'VOLUNTEER' || r.role === 'BOTH').length;
  const roleTone: Record<SupporterRole, 'brand' | 'success' | 'warning' | 'neutral'> = { DONOR: 'brand', VOLUNTEER: 'success', BOTH: 'warning', CONTACT: 'neutral' };

  return (
    <>
      <PageHeader
        title="후원자·봉사자"
        description="후원·정기 약정·자원봉사·기관 명단을 한 사람 기준으로 모아 봅니다. 세그먼트로 다음에 할 일을 고르세요. 전화번호 원문은 표시하지 않습니다."
        action={<Link href="/studio/donors" className="text-[13px] font-bold text-brand-700">후원자 상세 분석</Link>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="전체 구성원" value={`${formatNumber(all.length)}명`} tone="brand" />
        <StatTile label="후원자" value={`${formatNumber(donors)}명`} sub="후원·봉사 겸함 포함" />
        <StatTile label="자원봉사자" value={`${formatNumber(volunteers)}명`} sub="접수·승인·활동 기록 기준" />
        <StatTile label="정기 전환 대상" value={`${formatNumber(count('repeat_no_pledge'))}명`} sub="일시 2회 이상 · 약정 없음" tone={count('repeat_no_pledge') ? 'warning' : 'neutral'} />
        <StatTile label="6개월 휴면" value={`${formatNumber(count('dormant'))}명`} sub="정기 약정 없음" />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {SEGMENTS.map((s) => (
          <Link
            key={s}
            href={`/studio/supporters?seg=${s}${role !== 'all' ? `&role=${role}` : ''}`}
            className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold ${seg === s ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600'}`}
          >
            {SEGMENT_LABEL[s]} <span className="ml-1 tabular-nums opacity-70">{count(s)}</span>
          </Link>
        ))}
      </div>

      <Card className="mb-4">
        <form className="grid gap-3 sm:grid-cols-[1fr_180px_auto]" method="get">
          <input type="hidden" name="seg" value={seg} />
          <Input name="q" defaultValue={q} placeholder="이름 · 번호 끝자리 · 태그" />
          <Select name="role" defaultValue={role}>
            <option value="all">구분 전체</option>
            {(['DONOR', 'VOLUNTEER', 'BOTH', 'CONTACT'] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </Select>
          <button className="h-12 rounded-xl bg-ink-900 px-5 text-[14px] font-extrabold text-white">조회</button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title="조건에 맞는 구성원이 없습니다" description="문자 후원·정기 약정·자원봉사 신청이 들어오거나 기관 명단을 올리면 여기에 모입니다." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>이름</Th>
              <Th>구분</Th>
              <Th>누적 후원</Th>
              <Th>최근 후원</Th>
              <Th>정기</Th>
              <Th>봉사</Th>
              <Th>첫 유입</Th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 300).map((r) => (
              <tr key={r.key}>
                <Td>
                  <span className="font-semibold text-ink-900">{displayPayerName(r.name)}</span>
                  <span className="ml-2 font-mono text-[12px] text-ink-400">{r.phoneMasked}</span>
                  {r.tags.map((t) => <Badge key={t} className="ml-1.5">{t}</Badge>)}
                </Td>
                <Td><Badge tone={roleTone[r.role]}>{ROLE_LABEL[r.role]}</Badge></Td>
                <Td className="tabular-nums">{r.donationCount ? <><span className="font-semibold text-ink-900">{formatWon(r.totalAmount)}</span> <span className="text-ink-400">· {r.donationCount}회</span></> : <span className="text-ink-300">-</span>}</Td>
                <Td className="whitespace-nowrap tabular-nums">{r.lastDonatedAt ? formatKst(r.lastDonatedAt, false) : <span className="text-ink-300">-</span>}</Td>
                <Td>{r.recurring ? <Badge tone={r.recurring.status === 'ACTIVE' ? 'brand' : 'warning'}>매월 {r.recurring.dayOfMonth}일 {formatWon(r.recurring.amount)}</Badge> : <span className="text-ink-300">-</span>}</Td>
                <Td>{r.volunteer ? <span className="text-[12.5px]"><Badge tone={r.volunteer.status === 'APPROVED' ? 'success' : 'neutral'}>{r.volunteer.status === 'APPROVED' ? '활동 중' : r.volunteer.status === 'RECEIVED' ? '접수' : '기록'}</Badge> <span className="tabular-nums text-ink-500">{(r.volunteer.minutes / 60).toFixed(1)}시간</span></span> : <span className="text-ink-300">-</span>}</Td>
                <Td className="text-[12.5px] text-ink-500">{r.firstSource ? sourceLabel(r.firstSource) : '-'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {rows.length > 300 ? <p className="mt-2 text-[12px] text-ink-400">앞 300명만 표시합니다. 검색으로 좁혀 주세요.</p> : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">정기 약정 미완료 재안내</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
            최근 30일 안에 기관 번호로 <b>정기</b> 라고 보내 약정 링크를 받았지만 아직 약정하지 않은 분 <b className="tabular-nums">{pledgePending.length}명</b>.
            본인이 요청한 안내를 한 번 더 보내는 것이라 정보성 안내입니다. 요청한 적 없는 분께 보내는 광고성 발송은 제공하지 않습니다.
          </p>
          {pledgePending.length ? (
            <ul className="mt-3 space-y-1 text-[12.5px] text-ink-600">
              {pledgePending.slice(0, 5).map((p) => <li key={p.payerId}>{displayPayerName(p.name)} <span className="font-mono text-ink-400">{p.phoneMasked}</span> · {formatKst(p.requestedAt, false)}</li>)}
            </ul>
          ) : null}
          <div className="mt-4">
            <ActionForm action={pledgeReminderAction} submitLabel="약정 안내 다시 보내기" variant="secondary" confirmMessage={`${pledgePending.length}명에게 정기후원 약정 링크를 다시 보냅니다.`} />
          </div>
        </Card>
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">기관 명단 올리기</h2>
          <p className="mt-1.5 mb-4 text-[13px] leading-relaxed text-ink-500">
            후원의 밤·행사·봉사 모집 등으로 기관이 이미 가진 명단을 올려 구성원으로 함께 관리합니다. 가입한 후원자와 번호가 같으면 자동으로 묶입니다. 엑셀은 [CSV UTF-8] 로 저장해 올려 주세요.
          </p>
          <SupporterImportForm />
        </Card>
      </div>
    </>
  );
}
