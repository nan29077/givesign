import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { ActionButton } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, clampPage, canManageMoney } from '@/components/admin/constants';
import { reissueMerchantCode } from '@/app/actions/admin/accounts';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { merchantStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';

export const dynamic = 'force-dynamic';

export default async function AdminCodesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; state?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canManageMoney(me.adminPermission);

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? '').trim();
  const state = sp.state === 'ACTIVE' || sp.state === 'REVOKED' ? sp.state : '';

  const where: Prisma.MerchantCodeWhereInput = {
    ...(state === 'ACTIVE' ? { active: true } : {}),
    ...(state === 'REVOKED' ? { active: false } : {}),
    ...(q
      ? {
          OR: [
            { code: { contains: q.toUpperCase() } },
            { merchant: { displayName: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [total, codes, activeCount, revokedCount] = await Promise.all([
    prisma.merchantCode.count({ where }),
    prisma.merchantCode.findMany({
      where,
      orderBy: { issuedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, code: true, active: true, issuedAt: true, revokedAt: true,
        merchant: { select: { id: true, displayName: true, status: true, code: true } },
      },
    }),
    prisma.merchantCode.count({ where: { active: true } }),
    prisma.merchantCode.count({ where: { active: false } }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/codes', params: { q, state }, page, lastPage, total });

  return (
    <>
      <PageHeader
        title="사회복지기관 코드 관리"
        description="코드는 결제 안내 링크(/c/코드)의 식별자입니다. 재발급하면 기존 링크가 즉시 무효화됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="활성 코드" value={formatNumber(activeCount)} tone="success" />
        <StatTile label="폐기 코드" value={formatNumber(revokedCount)} />
        <StatTile label="현재 조건 결과" value={formatNumber(total)} />
        <StatTile label="코드 형식" value="GIV-XXXX" sub="혼동 문자 제외 32진 알파벳" />
      </div>

      <Notice tone="warning" title="재발급 시 주의">
        코드를 재발급하면 기존 코드가 즉시 폐기되고 새 코드가 활성화됩니다. 서비스 화면·안내문에 노출된 기존
        결제 링크는 더 이상 동작하지 않으므로, 사회복지기관에 사전 공지 후 진행해 주세요. 모든 재발급은 감사로그에
        기록됩니다.
      </Notice>

      <div className="mt-4">
        <FilterBar action="/admin/codes" resetHref="/admin/codes">
          <AdminField label="검색 (코드/사회복지기관)" className="w-56">
            <AdminInput name="q" defaultValue={q} placeholder="GIV-8K2M" />
          </AdminField>
          <AdminField label="상태" className="w-36">
            <AdminSelect name="state" defaultValue={state}>
              <option value="">전체</option>
              <option value="ACTIVE">활성</option>
              <option value="REVOKED">폐기</option>
            </AdminSelect>
          </AdminField>
        </FilterBar>

        {codes.length === 0 ? (
          <EmptyState title="조건에 맞는 코드가 없습니다" />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>코드</Th>
                  <Th>사회복지기관</Th>
                  <Th>심사 상태</Th>
                  <Th>코드 상태</Th>
                  <Th>발급</Th>
                  <Th>폐기</Th>
                  <Th>결제 링크</Th>
                  <Th>재발급</Th>
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => (
                  <tr key={c.id}>
                    <Td className="font-mono text-[13px] font-semibold">{c.code}</Td>
                    <Td>
                      <Link href={`/admin/merchants/${c.merchant.id}`} className="font-semibold text-brand-700">
                        {c.merchant.displayName}
                      </Link>
                      <span className="mt-0.5 block text-[11px] text-ink-400">현재 코드 {c.merchant.code}</span>
                    </Td>
                    <Td>
                      <Badge tone={merchantStatusLabel[c.merchant.status].tone}>
                        {merchantStatusLabel[c.merchant.status].text}
                      </Badge>
                    </Td>
                    <Td>{c.active ? <Badge tone="success">활성</Badge> : <Badge tone="neutral">폐기</Badge>}</Td>
                    <Td className="whitespace-nowrap">{formatKst(c.issuedAt, false)}</Td>
                    <Td className="whitespace-nowrap">{formatKst(c.revokedAt, false)}</Td>
                    <Td className="font-mono text-[12px]">{c.active ? `/c/${c.code}` : '-'}</Td>
                    <Td>
                      {c.active ? (
                        <ActionButton disabled={!canEdit}
                          action={reissueMerchantCode}
                          values={{ merchantId: c.merchant.id }}
                          label="재발급"
                          variant="danger"
                          confirm={`${c.merchant.displayName} 님의 코드를 재발급합니다. 기존 링크 /c/${c.code} 는 즉시 무효화됩니다.`}
                        />
                      ) : (
                        <span className="text-[12px] text-ink-300">-</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager basePath="/admin/codes" params={{ q, state }} page={page} lastPage={lastPage} total={total} />
          </>
        )}
      </div>
    </>
  );
}
