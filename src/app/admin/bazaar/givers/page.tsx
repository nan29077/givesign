import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, LinkButton, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { prisma } from '@/server/db';
import { adminBazaarContext, ADMIN_BAZAAR_TABS } from '@/server/admin-bazaar-context';
import { giverStatusAction } from '@/app/actions/admin/bazaar';
import { donorTypeLabel, formatBizNo, type DonorType } from '@/lib/bazaar';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';
const PAGE = 30;

/** 기부자 대장: 기업·개인 현물 기부 회원과 기부·영수증 누계 */
export default async function AdminGivers({ searchParams }: { searchParams: Promise<{ type?: string; q?: string; page?: string }> }) {
  await adminBazaarContext();
  const sp = await searchParams;
  const type = sp.type === 'CORPORATE' || sp.type === 'INDIVIDUAL' ? sp.type : undefined;
  const q = (sp.q ?? '').trim().slice(0, 50);
  const page = Math.max(1, Number(sp.page) || 1);
  const where = {
    ...(type ? { donorType: type } : {}),
    ...(q ? { OR: [{ displayName: { contains: q, mode: 'insensitive' as const } }, { contactName: { contains: q, mode: 'insensitive' as const } }, { businessNo: { contains: q.replace(/\D/g, '') || q } }, { user: { email: { contains: q, mode: 'insensitive' as const } } }] } : {}),
  };
  const [total, rows, corp, indiv] = await Promise.all([
    prisma.inKindDonor.count({ where }),
    prisma.inKindDonor.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE,
      take: PAGE,
      include: {
        user: { select: { email: true, status: true } },
        donations: { select: { status: true } },
        receipts: { where: { status: 'ISSUED' }, select: { totalAmount: true } },
      },
    }),
    prisma.inKindDonor.count({ where: { donorType: 'CORPORATE' } }),
    prisma.inKindDonor.count({ where: { donorType: 'INDIVIDUAL' } }),
  ]);
  return (
    <>
      <PageHeader title="기부자 대장" description="현물 기부 회원(기업·개인) 전체와 기부 건수·영수증 발급 누계입니다. 연락처는 가린 값만 보입니다." action={<LinkButton href="/api/bazaar/export?kind=givers" variant="secondary">대장 내려받기(CSV)</LinkButton>} />
      <BazaarSubNav items={ADMIN_BAZAAR_TABS} current="/admin/bazaar/givers" />
      <div className="mb-4 grid grid-cols-3 gap-3">
        <StatTile label="전체" value={`${corp + indiv}명`} />
        <StatTile label="기업 회원" value={`${corp}곳`} />
        <StatTile label="개인 회원" value={`${indiv}명`} />
      </div>
      <FilterBar action="/admin/bazaar/givers" resetHref="/admin/bazaar/givers">
        <AdminSelect name="type" defaultValue={type ?? ''} aria-label="구분"><option value="">기업·개인 전체</option><option value="CORPORATE">기업</option><option value="INDIVIDUAL">개인</option></AdminSelect>
        <AdminInput name="q" defaultValue={q} placeholder="이름·상호·사업자번호·이메일" />
      </FilterBar>
      <Card>
        {rows.length === 0 ? <EmptyState title="기부 회원이 없습니다" /> : (
          <Table>
            <thead><tr><Th>구분</Th><Th>이름(상호)</Th><Th>사업자번호 / 영수증</Th><Th>담당자·연락처</Th><Th className="text-right">기부</Th><Th className="text-right">영수증 누계</Th><Th>가입일</Th><Th>상태</Th></tr></thead>
            <tbody>{rows.map((g) => {
              const active = g.donations.filter((x) => !['CANCELED', 'RETURNED', 'CLOSED'].includes(x.status)).length;
              return (
                <tr key={g.id}>
                  <Td>{donorTypeLabel[g.donorType as DonorType]}</Td>
                  <Td><Link href={`/admin/bazaar/donations?q=${encodeURIComponent(g.displayName)}`} className="font-bold text-brand-700 underline">{g.displayName}</Link><span className="block text-[11px] text-ink-400">{g.user.email}</span></Td>
                  <Td className="text-[12px]">{g.donorType === 'CORPORATE' ? formatBizNo(g.businessNo) : g.residentNoMasked ? '영수증 정보 등록' : '미등록'}</Td>
                  <Td className="text-[12px]">{g.contactName}<span className="block text-ink-400">{g.phoneMasked}</span></Td>
                  <Td className="text-right tabular-nums">{g.donations.length}건<span className="block text-[11px] text-ink-400">진행 {active}</span></Td>
                  <Td className="text-right tabular-nums">{formatWon(g.receipts.reduce((s, r) => s + r.totalAmount, 0n))}</Td>
                  <Td className="text-[12px]">{formatKst(g.createdAt, false)}</Td>
                  <Td>
                    {g.user.status === 'ACTIVE' ? <Badge tone="success">정상</Badge> : <Badge tone="danger">정지</Badge>}
                    <div className="mt-1"><ActionForm action={giverStatusAction} submitLabel={g.user.status === 'ACTIVE' ? '정지' : '해제'} variant="ghost" compact confirm={g.user.status === 'ACTIVE' ? '이 회원을 정지할까요? 로그인이 끊깁니다.' : '정지를 해제할까요?'}>
                      <input type="hidden" name="donorId" value={g.id} /><input type="hidden" name="status" value={g.user.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'} />
                    </ActionForm></div>
                  </Td>
                </tr>
              );
            })}</tbody>
          </Table>
        )}
        <Pager basePath="/admin/bazaar/givers" params={{ type, q }} page={page} lastPage={Math.max(1, Math.ceil(total / PAGE))} total={total} />
      </Card>
    </>
  );
}
